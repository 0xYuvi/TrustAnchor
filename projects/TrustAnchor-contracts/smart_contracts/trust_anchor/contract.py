from algopy import ARC4Contract, UInt64, Bytes, BoxMap, Global, Txn
from algopy.arc4 import abimethod, Bool, DynamicBytes, String, UInt8


class VerificationRequest(arc4.Struct):
    institution_id: DynamicBytes
    user_address: DynamicBytes
    mode: UInt8  # 0 = boolean, 1 = zkp
    threshold: UInt64
    status: UInt8  # 0 = pending, 1 = fulfilled, 2 = rejected
    fulfilled_at_round: UInt64


class TrustAnchor(ARC4Contract):
    def __init__(self) -> None:
        self.anchors = BoxMap(DynamicBytes, DynamicBytes, key_prefix="anchor_")
        self.requests = BoxMap(DynamicBytes, VerificationRequest, key_prefix="req_")

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

    @abimethod()
    def request_verification(
        self,
        request_id: DynamicBytes,
        institution_id: DynamicBytes,
        user_address: DynamicBytes,
        mode: UInt8,
        threshold: UInt64,
    ) -> Bool:
        req = VerificationRequest(
            institution_id=institution_id.copy(),
            user_address=user_address.copy(),
            mode=mode,
            threshold=threshold,
            status=UInt8(0),
            fulfilled_at_round=UInt64(0),
        )
        self.requests[request_id.copy()] = req.copy()
        return Bool(True)

    @abimethod()
    def fulfill_request(
        self,
        request_id: DynamicBytes,
        result: UInt8,
    ) -> Bool:
        req = self.requests[request_id.copy()]
        req.status = result
        req.fulfilled_at_round = UInt64(Global.round)
        self.requests[request_id.copy()] = req.copy()
        return Bool(True)

    @abimethod()
    def get_request(self, request_id: DynamicBytes) -> VerificationRequest:
        return self.requests[request_id.copy()]
