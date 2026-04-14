"""
ZKP verification service for TrustAnchor Issuer Agent.

Handles:
- Calling the gnark binary for proof generation
- Proof verification
- Public input/output handling
"""

import asyncio
import base64
import json
import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


@dataclass
class ZKProof:
    """Result of ZKP generation."""

    proof: str
    public_inputs: dict
    verification_key_hash: Optional[str] = None


@dataclass
class ZKProofResult:
    """Result of ZKP verification."""

    valid: bool
    error: Optional[str] = None
    proof: Optional[ZKProof] = None


class ZKPService:
    """
    Service for generating and verifying ZK proofs.

    Uses an external gnark binary for proof generation.
    """

    def __init__(
        self,
        prove_binary_path: Optional[str] = None,
        keys_dir: Optional[str] = None,
        http_prover_url: Optional[str] = None,
    ):
        base_dir = Path(__file__).parent.parent.parent / "circuits"
        self.prove_binary_path = prove_binary_path or os.getenv(
            "ZKP_PROVE_BINARY", str(base_dir / "prover")
        )
        self.keys_dir = keys_dir or os.getenv("ZKP_KEYS_DIR", str(base_dir / "keys"))
        self.http_prover_url = http_prover_url or os.getenv("ZKP_HTTP_PROVER_URL")
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

    async def generate_proof(
        self,
        secret_value: int,
        threshold: int,
        user_id: str,
    ) -> ZKProofResult:
        """
        Generate a ZK proof that secret_value > threshold.

        Args:
            secret_value: The secret value to prove (private)
            threshold: The threshold to compare against (public)
            user_id: User identifier for logging

        Returns:
            ZKProofResult with generated proof or error
        """
        if self.http_prover_url:
            return await self._generate_proof_http(secret_value, threshold, user_id)
        return await self._generate_proof_binary(secret_value, threshold, user_id)

    async def _generate_proof_http(
        self,
        secret_value: int,
        threshold: int,
        user_id: str,
    ) -> ZKProofResult:
        """Generate proof via HTTP prover service."""
        try:
            async with self.client as client:
                response = await client.post(
                    f"{self.http_prover_url}/prove",
                    json={
                        "secret": str(secret_value),
                        "threshold": str(threshold),
                        "user_id": user_id,
                    },
                    headers={"Content-Type": "application/json"},
                )

            if response.status_code != 200:
                return ZKProofResult(
                    valid=False,
                    error=f"Prover returned status {response.status_code}: {response.text}",
                )

            data = response.json()
            return ZKProofResult(
                valid=True,
                proof=ZKProof(
                    proof=data["proof"],
                    public_inputs=data.get("public_inputs", {"threshold": threshold}),
                    verification_key_hash=data.get("vk_hash"),
                ),
            )

        except httpx.RequestError as e:
            logger.error(f"HTTP prover request failed: {e}")
            return ZKProofResult(valid=False, error=f"Prover request failed: {str(e)}")
        except Exception as e:
            logger.error(f"Proof generation error: {e}")
            return ZKProofResult(valid=False, error=str(e))

    async def _generate_proof_binary(
        self,
        secret_value: int,
        threshold: int,
        user_id: str,
    ) -> ZKProofResult:
        """Generate proof using local gnark binary."""
        binary_path = Path(self.prove_binary_path)

        if not binary_path.exists():
            return ZKProofResult(
                valid=False,
                error=f"Prove binary not found at {self.prove_binary_path}",
            )

        keys_path = Path(self.keys_dir)
        pk_path = keys_path / "pk.groth16.key"
        vk_path = keys_path / "vk.groth16.key"

        if not pk_path.exists():
            return ZKProofResult(
                valid=False,
                error=f"Proving key not found at {pk_path}",
            )

        try:
            cmd = [
                str(binary_path),
                "prove",
                "--secret",
                str(secret_value),
                "--threshold",
                str(threshold),
                "--pk",
                str(pk_path),
            ]

            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await result.communicate()

            if result.returncode != 0:
                logger.error(f"Prove binary failed: {stderr.decode()}")
                logger.error(f"Stdout: {stdout.decode()[:500]}")
                return ZKProofResult(
                    valid=False,
                    error=f"Proof generation failed: {stderr.decode()}",
                )

            import re

            output = stdout.decode()
            output = re.sub(r"\x1b\[[0-9;]*m", "", output)
            proof_data = json.loads(output)

            return ZKProofResult(
                valid=True,
                proof=ZKProof(
                    proof=proof_data["proof"],
                    public_inputs=proof_data.get(
                        "public_inputs", {"threshold": threshold}
                    ),
                    verification_key_hash=proof_data.get("vk_hash"),
                ),
            )

        except asyncio.TimeoutError:
            return ZKProofResult(valid=False, error="Proof generation timed out")
        except json.JSONDecodeError as e:
            return ZKProofResult(valid=False, error=f"Invalid proof output: {str(e)}")
        except Exception as e:
            logger.error(f"Proof generation error: {e}")
            return ZKProofResult(valid=False, error=str(e))

    async def verify_proof(
        self,
        proof: str,
        public_inputs: dict,
        threshold: int,
    ) -> ZKProofResult:
        """
        Verify a ZK proof.

        Args:
            proof: The proof to verify (base64 encoded)
            public_inputs: Public inputs including threshold
            threshold: Expected threshold value

        Returns:
            ZKProofResult with verification status
        """
        if public_inputs.get("threshold") != threshold:
            return ZKProofResult(
                valid=False,
                error=f"Threshold mismatch: {public_inputs.get('threshold')} != {threshold}",
            )

        if self.http_prover_url:
            return await self._verify_proof_http(proof, public_inputs)
        return await self._verify_proof_binary(proof, public_inputs)

    async def _verify_proof_http(
        self,
        proof: str,
        public_inputs: dict,
    ) -> ZKProofResult:
        """Verify proof via HTTP verifier service."""
        try:
            async with self.client as client:
                response = await client.post(
                    f"{self.http_prover_url}/verify",
                    json={
                        "proof": proof,
                        "public_inputs": public_inputs,
                    },
                    headers={"Content-Type": "application/json"},
                )

            if response.status_code != 200:
                data = response.json()
                return ZKProofResult(
                    valid=False, error=data.get("error", "Verification failed")
                )

            data = response.json()
            return ZKProofResult(
                valid=data.get("valid", False),
                proof=ZKProof(
                    proof=proof,
                    public_inputs=public_inputs,
                ),
            )

        except Exception as e:
            logger.error(f"Proof verification error: {e}")
            return ZKProofResult(valid=False, error=str(e))

    async def _verify_proof_binary(
        self,
        proof: str,
        public_inputs: dict,
    ) -> ZKProofResult:
        """Verify proof using local gnark binary."""
        binary_path = Path(self.prove_binary_path)

        if not binary_path.exists():
            return ZKProofResult(
                valid=False,
                error=f"Verify binary not found at {self.prove_binary_path}",
            )

        try:
            proof_bytes = base64.b64decode(proof)
            proof_b64 = base64.b64encode(proof_bytes).decode()

            cmd = [
                str(binary_path),
                "--verify",
                "--proof",
                proof_b64,
                "--public",
                json.dumps(public_inputs),
            ]

            result = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            stdout, stderr = await result.communicate()

            if result.returncode != 0:
                return ZKProofResult(
                    valid=False,
                    error=f"Verification failed: {stderr.decode()}",
                )

            return ZKProofResult(
                valid=True,
                proof=ZKProof(proof=proof, public_inputs=public_inputs),
            )

        except Exception as e:
            logger.error(f"Proof verification error: {e}")
            return ZKProofResult(valid=False, error=str(e))


def create_zkp_service() -> ZKPService:
    """Factory function to create ZKP service from environment."""
    return ZKPService(
        prove_binary_path=os.getenv("ZKP_PROVE_BINARY"),
        keys_dir=os.getenv("ZKP_KEYS_DIR"),
        http_prover_url=os.getenv("ZKP_HTTP_PROVER_URL"),
    )
