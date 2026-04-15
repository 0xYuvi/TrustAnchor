"""
KYC Agent for TrustAnchor Protocol.

This module acts as the Trusted Issuer (e.g., Plaid, Government ID Provider).
It retrieves "true" data, hashes it with a cryptographic salt, and simulates
anchoring those commitments exactly as they would fall onto an Algorand smart contract.
"""

import hashlib
import logging
from typing import Optional
from pydantic import BaseModel

logger = logging.getLogger(__name__)

class KYCRecord(BaseModel):
    user_id: str
    verified_income: int
    commitment_hash: str
    anchored_txid: Optional[str] = "simulated_on_chain_anchor"

class KYCAgent:
    """
    Simulates a secure Identity Provider that anchors data mathematically 
    before the ZKP circuit is ever run.
    """
    def __init__(self):
        # In-memory "Smart Contract" simulated registry mapping user_id -> commitment
        self.truth_registry: dict[str, KYCRecord] = {}
        # Fixed Salt acting as the Issuer's cryptographic private key modifier
        self._issuer_salt = "trustanchor_secure_issuer_salt_v1"

    def _generate_commitment(self, user_id: str, verified_income: int) -> str:
        """Generate a Poseidon-like hash commitment for the ZK circuit."""
        raw_data = f"{user_id}:{verified_income}:{self._issuer_salt}".encode()
        return hashlib.sha256(raw_data).hexdigest()

    async def extract_and_anchor(self, user_id: str, declared_income: int) -> KYCRecord:
        """
        Simulate the Plaid/Gov extraction. We trust what the UI sends for the demo,
        but mathematically lock it so the ZKP can only be generated against THIS exact value.
        """
        logger.info(f"[KYC Agent] Extracting financial data for user {user_id}")
        
        # 1. Simulate data extraction (we use the declared income as the 'true' income)
        true_income = declared_income
        
        # 2. Hash it
        commitment = self._generate_commitment(user_id, true_income)
        logger.info(f"[KYC Agent] Generated Cryptographic Commitment: {commitment}")
        
        # 3. Simulate Smart Contract Anchor (Writing to Algorand State)
        record = KYCRecord(
            user_id=user_id,
            verified_income=true_income,
            commitment_hash=commitment,
        )
        self.truth_registry[user_id] = record
        logger.info(f"[KYC Agent] Successfully anchored Identity to TruthRegistry.")
        
        return record

    async def get_anchored_commitment(self, user_id: str) -> Optional[str]:
        """Fetch the confirmed on-chain commitment for verification."""
        record = self.truth_registry.get(user_id)
        if record:
            return record.commitment_hash
        return None

# Singleton Instance
kyc_issuer_agent = KYCAgent()
