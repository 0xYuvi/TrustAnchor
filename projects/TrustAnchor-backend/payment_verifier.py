"""
Payment verification service for TrustAnchor Issuer Agent.

Handles:
- Transaction verification via Algorand Indexer
- Replay attack prevention using request binding
- Secure key management
"""

import hashlib
import logging
import os
from datetime import datetime, timedelta
from typing import Optional

import httpx
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class PaymentDetails(BaseModel):
    """Details of a verified payment."""

    txid: str
    sender: str
    amount: int
    receiver: str
    note: Optional[str] = None
    round: int
    timestamp: datetime


class PaymentVerificationResult(BaseModel):
    """Result of payment verification."""

    valid: bool
    payment: Optional[PaymentDetails] = None
    error: Optional[str] = None


class ReplayPreventionStore:
    """In-memory store for replay attack prevention."""

    def __init__(self, ttl_seconds: int = 3600):
        self._used_txids: set[str] = set()
        self._txid_timestamps: dict[str, datetime] = {}
        self._ttl = timedelta(seconds=ttl_seconds)

    def is_used(self, txid: str) -> bool:
        """Check if a transaction has been used."""
        if txid in self._used_txids:
            return True
        if txid in self._txid_timestamps:
            if datetime.now() - self._txid_timestamps[txid] > self._ttl:
                self._used_txids.discard(txid)
                del self._txid_timestamps[txid]
                return False
            return True
        return False

    def mark_used(self, txid: str) -> None:
        """Mark a transaction as used."""
        self._used_txids.add(txid)
        self._txid_timestamps[txid] = datetime.now()

    def cleanup_expired(self) -> int:
        """Remove expired entries. Returns count removed."""
        now = datetime.now()
        expired = [
            txid for txid, ts in self._txid_timestamps.items() if now - ts > self._ttl
        ]
        for txid in expired:
            self._used_txids.discard(txid)
            del self._txid_timestamps[txid]
        return len(expired)


class PaymentVerifier:
    """
    Verifies Algorand payments for x402 transactions.

    Uses Algorand Indexer to confirm transactions and prevents replay attacks.
    """

    def __init__(
        self,
        indexer_url: str,
        receiver_address: str,
        replay_store: Optional[ReplayPreventionStore] = None,
    ):
        self.indexer_url = indexer_url.rstrip("/")
        self.receiver_address = receiver_address
        self._replay_store = replay_store or ReplayPreventionStore()
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30.0)
        return self._client

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def verify_payment(
        self,
        txid: str,
        expected_amount: int,
        note: Optional[str] = None,
        sender: Optional[str] = None,
    ) -> PaymentVerificationResult:
        if self._replay_store.is_used(txid):
            return PaymentVerificationResult(
                valid=False,
                error=f"Transaction {txid} has already been used (replay attack prevention)",
            )

        retries = 10
        for attempt in range(retries):
            try:
                response = await self.client.get(
                    f"{self.indexer_url}/v2/transactions/{txid}",
                    headers={"Accept": "application/json"},
                )

                if response.status_code == 404:
                    if attempt < retries - 1:
                        logger.info(f"[PAYMENT] Tx {txid} not found yet. Retrying {attempt+1}/{retries}...")
                        await asyncio.sleep(2)
                        continue
                    return PaymentVerificationResult(valid=False, error="Transaction not found after retries")

                if response.status_code != 200:
                    return PaymentVerificationResult(valid=False, error=f"Indexer error: {response.status_code}")

                data = response.json()
                txn = data.get("transaction", {})
                payment_txn = txn.get("payment-transaction", {})

                receiver = payment_txn.get("receiver")
                amount = int(payment_txn.get("amount", 0))
                actual_sender = txn.get("sender")
                txn_note = txn.get("note", "")

                if receiver != self.receiver_address:
                    logger.error(f"[PAYMENT] Receiver mismatch: Expected {self.receiver_address}, Got {receiver}")
                    return PaymentVerificationResult(valid=False, error="Wrong receiver")

                if amount < expected_amount:
                    return PaymentVerificationResult(valid=False, error=f"Insufficient payment: {amount}")

                if sender and actual_sender != sender:
                    return PaymentVerificationResult(valid=False, error="Wrong sender")

                if note:
                    try:
                        note_bytes = bytes.fromhex(txn_note)
                        if note_bytes.decode("utf-8") != note:
                            return PaymentVerificationResult(valid=False, error="Note mismatch")
                    except Exception:
                        return PaymentVerificationResult(valid=False, error="Invalid note")

                payment = PaymentDetails(
                    txid=txid,
                    sender=actual_sender,
                    amount=amount,
                    receiver=receiver,
                    note=txn_note,
                    round=data.get("confirmed-round", 0),
                    timestamp=datetime.fromtimestamp(data.get("round-time", 0)) if data.get("round-time") else datetime.now(),
                )

                self._replay_store.mark_used(txid)
                return PaymentVerificationResult(valid=True, payment=payment)

            except Exception as e:
                logger.error(f"Verification error: {e}")
                if attempt < retries - 1:
                    await asyncio.sleep(2)
                    continue
                return PaymentVerificationResult(valid=False, error=str(e))

    async def verify_and_bind(
        self,
        txid: str,
        request_hash: str,
        expected_amount: int,
    ) -> PaymentVerificationResult:
        """
        Verify payment and bind to a specific request.

        The note field should contain a hash of the request for binding.
        """
        note = request_hash[:32] if len(request_hash) > 32 else request_hash
        return await self.verify_payment(txid, expected_amount, note=note)

    def compute_request_hash(self, user_id: str, mode: str, threshold: float) -> str:
        """Compute a hash for binding request to transaction."""
        data = f"{user_id}:{mode}:{threshold}".encode()
        return hashlib.sha256(data).hexdigest()


def create_payment_verifier() -> PaymentVerifier:
    """Factory function to create payment verifier from environment."""
    indexer_url = os.getenv(
        "ALGORAND_INDEXER_URL",
        "https://testnet-idx.algonode.cloud",
    )
    receiver_address = os.getenv("TRUST_ANCHOR_ADDRESS")
    if not receiver_address:
        raise ValueError("TRUST_ANCHOR_ADDRESS environment variable is required")

    return PaymentVerifier(
        indexer_url=indexer_url,
        receiver_address=receiver_address,
    )
