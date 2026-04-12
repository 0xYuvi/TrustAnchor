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


class TruthRegistry(ARC4Contract):
    def __init__(self) -> None:
        self.identity_registry_app_id = UInt64(0)
        self.anchor_count = UInt64(0)
        self.anchors = BoxMap(arc4.DynamicBytes, arc4.DynamicBytes, key_prefix="anchor_")

    @arc4.abimethod(create="require")
    def create(self, identity_registry_app_id: arc4.UInt64) -> None:
        self.identity_registry_app_id = identity_registry_app_id.native
        self.anchor_count = UInt64(0)

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
