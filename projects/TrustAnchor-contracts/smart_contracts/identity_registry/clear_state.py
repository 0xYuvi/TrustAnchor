from algopy import ARC4Contract, UInt64


class IdentityRegistry(ARC4Contract):
    def clear_state_program(self) -> UInt64:
        return UInt64(1)
