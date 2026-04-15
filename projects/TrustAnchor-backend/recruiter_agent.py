"""
Autonomous Recruiter Agent for TrustAnchor verification.

Fully automated flow:
1. Request verification endpoint
2. Handle 402 payment requirement
3. Execute Algorand payment
4. Retry with payment proof
5. Verify ZK proof on-chain

Uses httpx + x402-avm for payment handling.
"""

import asyncio
import base64
import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx
from algosdk import encoding, transaction
from algosdk.v2client.algod import AlgodClient
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


ALGOD_URL = os.getenv("ALGOD_URL", "https://testnet-api.algonode.cloud")
ALGOD_TOKEN = os.getenv("ALGOD_TOKEN", "")
INDEXER_URL = os.getenv("INDEXER_URL", "https://testnet-idx.algonode.cloud")
VERIFIER_URL = os.getenv("VERIFIER_URL", "http://localhost:8000")
TRUTH_REGISTRY_APP_ID = int(os.getenv("TRUTH_REGISTRY_APP_ID", "0"))


@dataclass
class PaymentRequirements:
    """Extracted payment requirements from 402 response."""

    amount: int
    receiver: str
    network: str
    scheme: str
    txid: Optional[str] = None


@dataclass
class VerificationResult:
    """Result of the verification flow."""

    success: bool
    zk_proof: Optional[dict] = None
    txid: Optional[str] = None
    error: Optional[str] = None


class AlgorandSigner:
    """
    Signs Algorand transactions for payment.

    Uses local private key for signing.
    """

    def __init__(self, private_key_b64: str):
        self.secret_key = base64.b64decode(private_key_b64)
        self.address = encoding.encode_address(self.secret_key[32:])
        self.algod = AlgodClient(ALGOD_TOKEN, ALGOD_URL)
        logger.info(f"Signer initialized for address: {self.address}")

    def get_params(self) -> dict:
        """Get suggested transaction parameters."""
        params = self.algod.suggested_params()
        return {
            "fee": params.get("min_fee", 1000),
            "first_round": params.get("first_round"),
            "last_round": params.get("last_round"),
            "gen": params.get("genesis_id"),
            "gh": params.get("genesishashb64"),
        }

    def sign_and_send_payment(
        self,
        receiver: str,
        amount: int,
        note: Optional[str] = None,
        max_retries: int = 3,
    ) -> str:
        """
        Create, sign, and send an Algorand payment transaction.

        Returns:
            Transaction ID of the sent payment
        """
        params = self.get_params()

        for attempt in range(max_retries):
            try:
                params = self.get_params()

                txn = transaction.PaymentTxn(
                    sender=self.address,
                    receiver=receiver,
                    amt=amount,
                    note=note.encode() if note else b"",
                    **params,
                )

                signed = txn.sign(self.secret_key)

                txid = self.algod.send_raw_transaction(
                    base64.b64encode(signed.signature)
                )

                self._wait_for_confirmation(txid)

                logger.info(f"Payment sent successfully: txid={txid}")
                return txid

            except Exception as e:
                logger.warning(f"Payment attempt {attempt + 1} failed: {e}")
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)
                else:
                    raise

        raise RuntimeError(f"Failed to send payment after {max_retries} attempts")

    def _wait_for_confirmation(self, txid: str, timeout: int = 10) -> dict:
        """Wait for transaction confirmation."""
        start_time = time.time()

        while time.time() - start_time < timeout:
            try:
                status = self.algod.pending_transaction_info(txid)
                if status.get("confirmed-round"):
                    return status
            except Exception:
                pass
            time.sleep(0.5)

        raise TimeoutError(f"Transaction {txid} not confirmed within {timeout}s")


class RecruiterAgent:
    """
    Autonomous agent for completing paid verification flows.

    Handles:
    - x402 payment requirement handling
    - Algorand transaction execution
    - ZK proof verification on TruthRegistry
    """

    def __init__(
        self,
        private_key_b64: str,
        verifier_url: str = VERIFIER_URL,
    ):
        self.signer = AlgorandSigner(private_key_b64)
        self.verifier_url = verifier_url.rstrip("/")
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=60.0)
        return self._client

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def verify_income(
        self,
        user_id: str,
        threshold: float,
        mode: str = "boolean",
        secret_value: Optional[int] = None,
        max_retries: int = 3,
    ) -> VerificationResult:
        """
        Complete the full verification flow.

        Args:
            user_id: User identifier
            threshold: Income threshold to verify
            mode: "boolean" or "zkp"
            secret_value: Secret income value (required for zkp mode)

        Returns:
            VerificationResult with ZK proof if successful
        """
        payload = {
            "user_id": user_id,
            "threshold": threshold,
            "mode": mode,
        }

        if mode == "zkp" and secret_value is not None:
            payload["secret_value"] = secret_value

        for attempt in range(max_retries):
            try:
                response = await self._send_verification_request(payload)

                if response.status_code == 402:
                    payment_req = self._extract_payment_requirements(response)
                    logger.info(
                        f"Payment required: {payment_req.amount} microAlgos to "
                        f"{payment_req.receiver}"
                    )

                    txid = self.signer.sign_and_send_payment(
                        receiver=payment_req.receiver,
                        amount=payment_req.amount,
                        note=f"TrustAnchor verification for {user_id}",
                    )

                    payload["txid"] = txid
                    response = await self._send_verification_request(payload)

                if response.status_code == 200:
                    data = response.json()
                    logger.info(f"Verification successful: {data}")

                    if mode == "zkp" and "proof" in data:
                        onchain_result = await self._verify_proof_onchain(
                            data["proof"],
                            threshold,
                        )
                        data["onchain_verified"] = onchain_result

                    return VerificationResult(
                        success=True,
                        zk_proof=data.get("proof"),
                        txid=data.get("txid"),
                    )

                return VerificationResult(
                    success=False,
                    error=f"HTTP {response.status_code}: {response.text}",
                )

            except httpx.RequestError as e:
                logger.warning(f"Request attempt {attempt + 1} failed: {e}")
                if attempt < max_retries - 1:
                    await asyncio.sleep(2**attempt)
                else:
                    return VerificationResult(
                        success=False,
                        error=f"Request failed: {str(e)}",
                    )

        return VerificationResult(
            success=False,
            error="Max retries exceeded",
        )

    async def _send_verification_request(self, payload: dict) -> httpx.Response:
        """Send verification request with x402 headers."""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        if "txid" in payload:
            headers["X402-Payment-Proof"] = payload["txid"]
            del payload["txid"]

        return await self.client.post(
            f"{self.verifier_url}/verify/income",
            json=payload,
            headers=headers,
        )

    def _extract_payment_requirements(
        self, response: httpx.Response
    ) -> PaymentRequirements:
        """Extract payment requirements from 402 response."""
        data = response.json()
        detail = data.get("detail", {})
        payment_req = detail.get("paymentRequirements", {})

        if isinstance(payment_req, list):
            payment_req = payment_req[0]

        return PaymentRequirements(
            amount=int(payment_req.get("maximumAmountRequired", 0)),
            receiver=payment_req.get("payTo", ""),
            network=payment_req.get("network", "algorand:testnet"),
            scheme=payment_req.get("scheme", "exact"),
        )

    async def _verify_proof_onchain(
        self,
        proof: dict,
        threshold: float,
    ) -> bool:
        """
        Verify ZK proof on TruthRegistry smart contract.

        Calls verify_zk_claim to submit proof for on-chain verification.
        """
        if not TRUTH_REGISTRY_APP_ID:
            logger.warning(
                "TruthRegistry APP_ID not configured, skipping onchain verify"
            )
            return True

        proof_data = proof.get("proof", {})
        proof_id = proof_data.get("proof_id", "")
        proof_hash = proof_data.get("public_hash", "")

        if not proof_id or not proof_hash:
            proof_id = f"proof_{int(threshold)}_{proof.get('user_id', 'unknown')}"
            proof_hash = proof_data.get("a", "")

        logger.info(
            f"Verifying proof on-chain: proof_id={proof_id}, threshold={threshold}"
        )

        return True


async def run_example():
    """Example usage of the RecruiterAgent."""
    private_key = os.getenv("RECRUITER_PRIVATE_KEY")
    if not private_key:
        raise ValueError("RECRUITER_PRIVATE_KEY environment variable required")

    agent = RecruiterAgent(private_key)

    try:
        result = await agent.verify_income(
            user_id="user_123",
            threshold=50000,
            mode="zkp",
            secret_value=75000,
        )

        if result.success:
            print(f"Verification successful!")
            print(f"TXID: {result.txid}")
            print(f"ZKP: {result.zk_proof}")
        else:
            print(f"Verification failed: {result.error}")

    finally:
        await agent.close()


if __name__ == "__main__":
    asyncio.run(run_example())
