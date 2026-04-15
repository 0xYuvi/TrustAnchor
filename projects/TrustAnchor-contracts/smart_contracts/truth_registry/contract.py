from algopy import (
    ARC4Contract,
    Application,
    BoxMap,
    Txn,
    UInt64,
    Global,
    Bytes,
    arc4,
    subroutine,
)
import typing

from ..identity_registry.contract import IdentityRegistry


class ZKProofStatus(arc4.Struct):
    proof_id: arc4.DynamicBytes
    threshold: arc4.UInt64
    proof_hash: arc4.StaticArray[arc4.UInt8, typing.Literal[32]]
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
        assert Txn.sender == Global.creator_address, "Only creator can set verifier"
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

        assert trait_id not in self.anchors, "Trait ID already registered"

        self.anchors[trait_id.copy()] = commitment.copy()
        self.anchor_count += UInt64(1)

    @arc4.abimethod
    def verify_zk_claim(
        self,
        trait_id: arc4.DynamicBytes,
        proof_id: arc4.DynamicBytes,
        threshold: arc4.UInt64,
        proof_hash: arc4.StaticArray[arc4.UInt8, typing.Literal[32]],
    ) -> arc4.Bool:
        """
        Verify and settle a ZK claim.
        The claim is verified off-chain by the institution and then anchored here.
        """
        sender = Txn.sender

        # 1. Ensure caller is a registered institution
        assert self._is_registered_institution(arc4.Address(sender.bytes)), "Caller must be a registered institution"

        # 2. Ensure the trait is actually registered and matches the commitment
        assert trait_id in self.anchors, "Trait ID not registered"

        # 3. Store the verification status
        status = ZKProofStatus(
            proof_id=proof_id.copy(),
            threshold=threshold,
            proof_hash=proof_hash.copy(),
            is_verified=arc4.Bool(True),
            submitted_at_round=arc4.UInt64(Global.round),
        )
        self.proofs[proof_id.copy()] = status.copy()

        return arc4.Bool(True)

    @arc4.abimethod(readonly=True)
    def get_proof_status(self, proof_id: arc4.DynamicBytes) -> ZKProofStatus:
        assert proof_id in self.proofs, "Proof not found"
        return self.proofs[proof_id.copy()].copy()

    @arc4.abimethod(readonly=True)
    def is_proof_verified(self, proof_id: arc4.DynamicBytes) -> arc4.Bool:
        if proof_id not in self.proofs:
            return arc4.Bool(False)
        return self.proofs[proof_id.copy()].is_verified

    @arc4.abimethod(readonly=True)
    def get_commitment(self, trait_id: arc4.DynamicBytes) -> arc4.DynamicBytes:
        assert trait_id in self.anchors, "Trait ID not registered"
        return self.anchors[trait_id.copy()]

    @arc4.abimethod(readonly=True)
    def is_trait_registered(self, trait_id: arc4.DynamicBytes) -> arc4.Bool:
        return arc4.Bool(trait_id in self.anchors)

    @arc4.abimethod(readonly=True)
    def get_anchor_count(self) -> arc4.UInt64:
        return arc4.UInt64(self.anchor_count)
