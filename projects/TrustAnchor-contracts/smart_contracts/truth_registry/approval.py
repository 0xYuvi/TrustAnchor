from algopy import (
    ARC4Contract,
    Application,
    BoxMap,
    Txn,
    UInt64,
    arc4,
    subroutine,
)

from ..identity_registry.approval import IdentityRegistry


class ZKProofStatus(arc4.Struct):
    proof_id: arc4.DynamicBytes
    threshold: arc4.UInt64
    proof_hash: arc4.StaticArray[arc4.UInt8, arc4.Literal[32]]
    is_verified: arc4.Bool
    submitted_at_round: arc4.UInt64


class TruthRegistry(ARC4Contract):
    def __init__(self) -> None:
        self.identity_registry_app_id = UInt64(0)
        self.anchor_count = UInt64(0)
        self.anchors = BoxMap(arc4.DynamicBytes, arc4.DynamicBytes, key_prefix="anchor_")
        self.verifier_app_id = UInt64(0)
        self.proofs = BoxMap(arc4.DynamicBytes, ZKProofStatus, key_prefix="proof_")

    @arc4.abimethod(create="require")
    def create(self, identity_registry_app_id: arc4.UInt64) -> None:
        self.identity_registry_app_id = identity_registry_app_id.native
        self.anchor_count = UInt64(0)

    @arc4.abimethod
    def set_verifier(self, verifier_app_id: arc4.UInt64) -> None:
        assert Txn.sender == self.creator, "Only creator can set verifier"
        self.verifier_app_id = verifier_app_id.native

    @subroutine
    def _is_registered_institution(self, addr: arc4.Address) -> bool:
        is_registered, _txn = arc4.abi_call(
            IdentityRegistry.is_registered,
            addr,
            app_id=Application(self.identity_registry_app_id),
        )
        return bool(is_registered)

    @arc4.abimethod
    def register_anchor(
        self,
        trait_id: arc4.DynamicBytes,
        commitment: arc4.DynamicBytes,
    ) -> None:
        assert self._is_registered_institution(arc4.Address(Txn.sender.bytes)), (
            "Caller must be a registered institution"
        )

        assert trait_id.native not in self.anchors, "Trait ID already registered"

        self.anchors[trait_id.copy()] = commitment.copy()
        self.anchor_count += UInt64(1)

    @arc4.abimethod
    def verify_zk_claim(
        self,
        proof_id: arc4.DynamicBytes,
        threshold: arc4.UInt64,
        proof_hash: arc4.DynamicBytes,
    ) -> arc4.Bool:
        sender = Txn.sender

        assert self._is_registered_institution(arc4.Address(sender.bytes)), "Caller must be a registered institution"

        from algopy import op

        hash_result = op.sha256(proof_id.native + threshold.bytes)
        hash_arr = arc4.StaticArray[arc4.UInt8, arc4.Literal[32]]()
        for i in range(32):
            hash_arr[i] = arc4.UInt8(hash_result[i])

        status = ZKProofStatus(
            proof_id=proof_id.copy(),
            threshold=threshold,
            proof_hash=hash_arr,
            is_verified=arc4.Bool(True),
            submitted_at_round=arc4.UInt64(self.anchor_count),
        )
        self.proofs[proof_id.copy()] = status.copy()

        return arc4.Bool(True)

    @arc4.abimethod(readonly=True)
    def get_proof_status(self, proof_id: arc4.DynamicBytes) -> ZKProofStatus:
        assert proof_id.native in self.proofs, "Proof not found"
        return self.proofs[proof_id.copy()]

    @arc4.abimethod(readonly=True)
    def is_proof_verified(self, proof_id: arc4.DynamicBytes) -> arc4.Bool:
        if proof_id.native not in self.proofs:
            return arc4.Bool(False)
        return self.proofs[proof_id.copy()].is_verified

    @arc4.abimethod(readonly=True)
    def get_commitment(self, trait_id: arc4.DynamicBytes) -> arc4.DynamicBytes:
        assert trait_id.native in self.anchors, "Trait ID not registered"
        return self.anchors[trait_id.copy()]

    @arc4.abimethod(readonly=True)
    def is_trait_registered(self, trait_id: arc4.DynamicBytes) -> arc4.Bool:
        return arc4.Bool(trait_id.native in self.anchors)

    @arc4.abimethod(readonly=True)
    def get_anchor_count(self) -> arc4.UInt64:
        return arc4.UInt64(self.anchor_count)
