from algopy import ARC4Contract, UInt64, String, Bytes
from algopy.arc4 import abimethod, Bool


class TrustAnchor(ARC4Contract):
    @abimethod()
    def hello(self, name: String) -> String:
        return "Hello, " + name

    @abimethod()
    def verify(self, threshold: UInt64, proof_data: Bytes) -> Bool:
        return Bool(True)
