from algopy import (
    ARC4Contract,
    Account,
    BoxMap,
    Txn,
    UInt64,
    arc4,
)


class InstitutionMetadata(arc4.Struct):
    name: arc4.String
    did: arc4.String
    public_key: arc4.DynamicBytes
    is_active: arc4.Bool


class IdentityRegistry(ARC4Contract):
    def __init__(self) -> None:
        self.admin = Account()
        self.institution_count = UInt64(0)
        self.institutions = BoxMap(Account, InstitutionMetadata, key_prefix="inst_")

    @arc4.abimethod(create="require")
    def create(self, admin: Account) -> None:
        self.admin = admin
        self.institution_count = UInt64(0)

    @arc4.abimethod
    def register_institution(
        self,
        addr: Account,
        name: arc4.String,
        did: arc4.String,
        public_key: arc4.DynamicBytes,
    ) -> None:
        assert Txn.sender == self.admin, "Only admin can register institutions"

        metadata = InstitutionMetadata(
            name=name,
            did=did,
            public_key=public_key.copy(),
            is_active=arc4.Bool(True),
        )
        self.institutions[addr] = metadata.copy()
        self.institution_count += UInt64(1)

    @arc4.abimethod
    def deactivate_institution(self, addr: Account) -> None:
        assert Txn.sender == self.admin, "Only admin can deactivate institutions"
        assert addr in self.institutions, "Institution not registered"

        metadata = self.institutions[addr]
        self.institutions[addr] = InstitutionMetadata(
            name=metadata.name,
            did=metadata.did,
            public_key=metadata.public_key.copy(),
            is_active=arc4.Bool(False),
        ).copy()

    @arc4.abimethod(readonly=True)
    def is_registered(self, addr: Account) -> arc4.Bool:
        if addr not in self.institutions:
            return arc4.Bool(False)
        return self.institutions[addr].is_active

    @arc4.abimethod(readonly=True)
    def get_institution(self, addr: Account) -> InstitutionMetadata:
        assert addr in self.institutions, "Institution not registered"
        return self.institutions[addr]

    @arc4.abimethod(readonly=True)
    def get_institution_count(self) -> arc4.UInt64:
        return arc4.UInt64(self.institution_count)
