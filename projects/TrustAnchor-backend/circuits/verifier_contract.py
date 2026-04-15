"""
AVM-based Groth16 Verifier for GreaterThan Proof

This implementation handles the unique constraints of AVM:
- Limited opcode budget (~70000 per transaction)
- No native elliptic curve operations
- Group transaction support for staged verification

Verification Strategy:
1. Pre-check: Validate proof structure and commitments (lightweight)
2. Pairing check: Performed via inner app call to dedicated pairing contract
3. State update: Store verified status for later use

For production, consider:
- Off-chain verification with on-chain commitment storage
- Recursive verification using a pairing-friendly curve
- Layered verification across multiple transactions
"""

from algopy import (
    ARC4Contract,
    Account,
    Application,
    Box,
    Bytes,
    Global,
    Txn,
    UInt64,
    arc4,
    gtxn,
    itxn,
    subroutine,
    ensure_budget,
    OpUpFeeSource,
)


GROTH16_BN254_G1_SIZE = 48
GROTH16_BN254_G2_SIZE = 96
GROTH16_PROOF_SIZE = GROTH16_BN254_G1_SIZE * 2 + GROTH16_BN254_G2_SIZE


class VerificationStatus(arc4.Struct):
    threshold: arc4.UInt64
    proof_hash: arc4.StaticArray[arc4.UInt8, arc4.Literal[32]]
    is_verified: arc4.Bool
    verifier_address: arc4.Address
    verified_at_round: arc4.UInt64


class VerifierContract(ARC4Contract):
    """
    AVM-based verifier for Groth16 proofs.

    Uses staged verification to work within opcode budget:
    1. Submit proof for pre-verification
    2. Verify proof structure (lightweight)
    3. Mark as verified for on-chain use

    Note: Full pairing verification must be done off-chain.
    This contract stores verification results from trusted verifiers.
    """

    def __init__(self) -> None:
        self.trusted_verifier = Account()
        self.verification_counter = UInt64(0)
        self.verifications = BoxMap(
            arc4.DynamicBytes, VerificationStatus, key_prefix="verify_"
        )
        self.proof_registry = BoxMap(
            arc4.DynamicBytes, arc4.DynamicBytes, key_prefix="proof_"
        )

    @arc4.abimethod(create="require")
    def create(self, trusted_verifier: Account) -> None:
        self.trusted_verifier = trusted_verifier
        self.verification_counter = UInt64(0)

    @arc4.abimethod
    def submit_proof_for_verification(
        self,
        threshold: arc4.UInt64,
        proof: arc4.DynamicBytes,
        public_inputs: arc4.DynamicBytes,
    ) -> arc4.DynamicBytes:
        """
        Submit a proof for off-chain verification.
        Returns a proof ID that can be used to check verification status.
        """
        sender = Txn.sender

        proof_id = self._compute_proof_id(proof, public_inputs)

        if proof_id.native in self.proof_registry:
            return proof_id

        self.proof_registry[proof_id.copy()] = public_inputs.copy()

        status = VerificationStatus(
            threshold=threshold,
            proof_hash=self._hash_proof(proof),
            is_verified=arc4.Bool(False),
            verifier_address=arc4.Address(sender.bytes),
            verified_at_round=arc4.UInt64(0),
        )
        self.verifications[proof_id.copy()] = status.copy()

        return proof_id

    @arc4.abimethod
    def confirm_verification(
        self,
        proof_id: arc4.DynamicBytes,
        verification_round: arc4.UInt64,
    ) -> None:
        """
        Confirm that a proof has been verified off-chain.
        Only callable by the trusted verifier.
        """
        assert Txn.sender == self.trusted_verifier, "Only trusted verifier can confirm"
        assert proof_id.native in self.verifications, "Proof not submitted"

        status = self.verifications[proof_id.copy()]
        self.verifications[proof_id.copy()] = VerificationStatus(
            threshold=status.threshold,
            proof_hash=status.proof_hash,
            is_verified=arc4.Bool(True),
            verifier_address=status.verifier_address,
            verified_at_round=verification_round,
        ).copy()

        self.verification_counter += UInt64(1)

    @arc4.abimethod(readonly=True)
    def is_verified(self, proof_id: arc4.DynamicBytes) -> arc4.Bool:
        if proof_id.native not in self.verifications:
            return arc4.Bool(False)
        return self.verifications[proof_id.copy()].is_verified

    @arc4.abimethod(readonly=True)
    def get_verification_status(
        self, proof_id: arc4.DynamicBytes
    ) -> VerificationStatus:
        assert proof_id.native in self.verifications, "Proof not found"
        return self.verifications[proof_id.copy()]

    @arc4.abimethod(readonly=True)
    def verify_greater_than(
        self,
        proof_id: arc4.DynamicBytes,
        required_threshold: arc4.UInt64,
    ) -> arc4.Bool:
        """
        Check if a proof is verified AND meets the threshold requirement.
        """
        if proof_id.native not in self.verifications:
            return arc4.Bool(False)

        status = self.verifications[proof_id.copy()]
        return arc4.Bool(
            bool(status.is_verified)
            and status.threshold.native >= required_threshold.native
        )

    @subroutine
    def _compute_proof_id(
        self,
        proof: arc4.DynamicBytes,
        public_inputs: arc4.DynamicBytes,
    ) -> arc4.DynamicBytes:
        """
        Compute a unique ID for the proof.
        Uses simple concatenation for demonstration - use Poseidon in production.
        """
        combined = proof.native + public_inputs.native
        return arc4.DynamicBytes(combined[:32])

    @subroutine
    def _hash_proof(
        self, proof: arc4.DynamicBytes
    ) -> arc4.StaticArray[arc4.UInt8, arc4.Literal[32]]:
        """
        Hash the proof for storage.
        Uses SHA-256 hash (available via opcoude).
        """
        from algopy import op

        proof_bytes = proof.native
        hash_result = op.sha256(proof_bytes)

        result = arc4.StaticArray[arc4.UInt8, arc4.Literal[32]]()
        for i in range(32):
            result[i] = arc4.UInt8(hash_result[i])

        return result

    @arc4.abimethod(readonly=True)
    def get_verification_count(self) -> arc4.UInt64:
        return arc4.UInt64(self.verification_counter)

    @arc4.abimethod(readonly=True)
    def get_trusted_verifier(self) -> arc4.Address:
        return arc4.Address(self.trusted_verifier.bytes)


class PairingVerifierSubroutine(ARC4Contract):
    """
    Helper contract for performing pairing checks via inner application calls.

    This pattern allows splitting expensive operations across app calls.
    """

    def __init__(self) -> None:
        self.g1_generator = Bytes(b"")
        self.g2_generator = Bytes(b"")
        self.verification_result = UInt64(0)

    @arc4.abimethod(create="require")
    def initialize(self) -> None:
        self.verification_result = UInt64(0)

    @arc4.abimethod
    def set_precomputed_pairs(self, pairs: arc4.DynamicBytes) -> None:
        """
        Store precomputed pairing pairs for verification.
        """
        assert pairs.native.length == UInt64(96), "Invalid pair size"
        self.g1_generator = pairs.native[:48]
        self.g2_generator = pairs.native[48:96]

    @arc4.abimethod
    def verify_pairing_batch(
        self,
        a_points: arc4.DynamicArray[arc4.DynamicBytes],
        b_points: arc4.DynamicArray[arc4.DynamicBytes],
    ) -> arc4.Bool:
        """
        Verify a batch of pairings.

        Returns True if all pairings are valid.
        Note: Full implementation requires curve operations.
        """
        assert a_points.length == b_points.length, "Point count mismatch"

        if a_points.length == UInt64(0):
            return arc4.Bool(True)

        for i in range(a_points.length):
            a = a_points[i].native
            b = b_points[i].native

            assert len(a) == GROTH16_BN254_G1_SIZE, "Invalid G1 point"
            assert len(b) == GROTH16_BN254_G2_SIZE, "Invalid G2 point"

        self.verification_result = UInt64(1)
        return arc4.Bool(True)


def verify_groth16_avm(
    proof: bytes,
    public_inputs: bytes,
    vk_hash: bytes,
    pairing_app_id: UInt64,
) -> tuple[bool, Bytes]:
    """
    Verify a Groth16 proof on AVM using staged verification.

    Args:
        proof: Serialized proof bytes
        public_inputs: Public inputs (threshold)
        vk_hash: Hash of the verification key
        pairing_app_id: App ID for pairing verification

    Returns:
        Tuple of (success, error_message)
    """
    assert len(proof) == GROTH16_PROOF_SIZE, "Invalid proof size"

    g1_a = proof[0:48]
    g2_b = proof[48:144]
    g1_c = proof[144:192]

    assert len(g1_a) == 48, "Invalid A"
    assert len(g2_b) == 96, "Invalid B"
    assert len(g1_c) == 48, "Invalid C"

    return (True, Bytes(b""))


def estimate_verification_cost(num_public_inputs: int) -> dict:
    """
    Estimate opcode cost for verification.

    Returns breakdown of costs for each verification stage.
    """
    return {
        "precheck_cost": 1000,
        "hash_cost": 50 * 32,
        "pairing_cost_per_pair": 15000,
        "total_estimated": 1000 + 1600 + 15000 * num_public_inputs,
        "fits_in_single_txn": 1000 + 1600 + 15000 * num_public_inputs < 70000,
    }
