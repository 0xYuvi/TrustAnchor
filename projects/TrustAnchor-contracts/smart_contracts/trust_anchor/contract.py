from algopy import ARC4Contract, UInt64, Bytes, BoxMap
from algopy.arc4 import abimethod, Bool, DynamicBytes


class TrustAnchor(ARC4Contract):
    def __init__(self) -> None:
        self.anchors = BoxMap(DynamicBytes, DynamicBytes, key_prefix="anchor_")

    @abimethod()
    def register_anchor(
        self,
        trait_id: DynamicBytes,
        commitment: DynamicBytes,
    ) -> Bool:
        self.anchors[trait_id.copy()] = commitment.copy()
        return Bool(True)

    @abimethod()
    def get_commitment(self, user_address: DynamicBytes) -> DynamicBytes:
        return self.anchors[user_address.copy()]

    @abimethod()
    def verify(self, threshold: UInt64, proof_data: Bytes) -> Bool:
        return Bool(True)
