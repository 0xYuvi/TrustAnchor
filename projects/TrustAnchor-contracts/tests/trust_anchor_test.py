from collections.abc import Iterator

import pytest
from algopy_testing import AlgopyTestContext, algopy_testing_context
from algopy.arc4 import DynamicBytes, Bool
from algopy import UInt64, Bytes

from smart_contracts.trust_anchor.contract import TrustAnchor


@pytest.fixture()
def context() -> Iterator[AlgopyTestContext]:
    with algopy_testing_context() as ctx:
        yield ctx


def test_register_and_get_commitment(context: AlgopyTestContext) -> None:
    # Arrange
    contract = TrustAnchor()
    trait_id = DynamicBytes(b"user_trait_1")
    commitment = DynamicBytes(b"commitment_data_123")

    # Act
    register_result = contract.register_anchor(trait_id, commitment)
    retrieved_commitment = contract.get_commitment(trait_id)

    # Assert
    assert register_result == Bool(True)
    assert retrieved_commitment == commitment


def test_verify(context: AlgopyTestContext) -> None:
    # Arrange
    contract = TrustAnchor()
    threshold = UInt64(50000)
    proof_data = Bytes(b"dummy_proof")

    # Act
    verify_result = contract.verify(threshold, proof_data)

    # Assert
    assert verify_result == Bool(True)

