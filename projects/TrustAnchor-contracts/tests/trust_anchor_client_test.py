import algokit_utils
import pytest
from algokit_utils import (
    AlgoAmount,
    AlgorandClient,
    SigningAccount,
)

from smart_contracts.artifacts.trust_anchor.trust_anchor_client import (
    TrustAnchorClient,
    TrustAnchorFactory,
)


@pytest.fixture()
def deployer(algorand_client: AlgorandClient) -> SigningAccount:
    account = algorand_client.account.from_environment("DEPLOYER")
    algorand_client.account.ensure_funded_from_environment(
        account_to_fund=account.address, min_spending_balance=AlgoAmount.from_algo(10)
    )
    return account


@pytest.fixture()
def trust_anchor_client(
    algorand_client: AlgorandClient, deployer: SigningAccount
) -> TrustAnchorClient:
    factory = algorand_client.client.get_typed_app_factory(
        TrustAnchorFactory, default_sender=deployer.address
    )

    client, _ = factory.deploy(
        on_schema_break=algokit_utils.OnSchemaBreak.AppendApp,
        on_update=algokit_utils.OnUpdate.AppendApp,
    )
    return client


def test_register_and_get_commitment(trust_anchor_client: TrustAnchorClient) -> None:
    trait_id = b"user_trait_1"
    commitment = b"commitment_data_123"

    register_result = trust_anchor_client.send.register_anchor(
        args=(trait_id, commitment)
    )
    assert register_result.abi_return is True

    get_result = trust_anchor_client.send.get_commitment(
        args=(trait_id,)
    )
    assert get_result.abi_return == commitment


def test_verify(trust_anchor_client: TrustAnchorClient) -> None:
    threshold = 50000
    proof_data = b"dummy_proof"

    verify_result = trust_anchor_client.send.verify(
        args=(threshold, proof_data)
    )
    assert verify_result.abi_return is True

