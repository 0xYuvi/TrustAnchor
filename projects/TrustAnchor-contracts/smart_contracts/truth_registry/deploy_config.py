import logging
import algokit_utils
from algosdk.v2client.algod import AlgodClient

logger = logging.getLogger(__name__)

def deploy() -> None:
    from smart_contracts.artifacts.identity_registry.identity_registry_client import (
        IdentityRegistryFactory,
    )
    from smart_contracts.artifacts.truth_registry.truth_registry_client import (
        TruthRegistryFactory, TruthRegistryMethodCallCreateParams, CreateArgs
    )

    algorand = algokit_utils.AlgorandClient.from_environment()
    deployer = algorand.account.from_environment("DEPLOYER")

    # 1. Resolve IdentityRegistry App ID
    identity_factory = algorand.client.get_typed_app_factory(
        IdentityRegistryFactory, default_sender=deployer.address
    )
    # This assumes it was deployed with the default name or we can find it
    id_app = identity_factory.get_app_client_by_creator_and_name(deployer.address, "IdentityRegistry")
    id_app_id = id_app.app_id

    # 2. Deploy TruthRegistry
    factory = algorand.client.get_typed_app_factory(
        TruthRegistryFactory, default_sender=deployer.address
    )

    app_client, result = factory.deploy(
        on_update=algokit_utils.OnUpdate.AppendApp,
        on_schema_break=algokit_utils.OnSchemaBreak.AppendApp,
        create_params=TruthRegistryMethodCallCreateParams(
            args=CreateArgs(identity_registry_app_id=id_app_id)
        )
    )

    logger.info(
        f"Deployed TruthRegistry ({app_client.app_id}) linked to IdentityRegistry ({id_app_id})"
    )
