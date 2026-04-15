import logging
import algokit_utils
from algosdk.v2client.algod import AlgodClient
from algosdk.v2client.indexer import IndexerClient

logger = logging.getLogger(__name__)

def deploy() -> None:
    from smart_contracts.artifacts.identity_registry.identity_registry_client import (
        IdentityRegistryFactory, IdentityRegistryMethodCallCreateParams, CreateArgs
    )

    algorand = algokit_utils.AlgorandClient.from_environment()
    deployer = algorand.account.from_environment("DEPLOYER")

    factory = algorand.client.get_typed_app_factory(
        IdentityRegistryFactory, default_sender=deployer.address
    )

    app_client, result = factory.deploy(
        on_update=algokit_utils.OnUpdate.AppendApp,
        on_schema_break=algokit_utils.OnSchemaBreak.AppendApp,
        create_params=IdentityRegistryMethodCallCreateParams(
            args=CreateArgs(admin=deployer.address)
        )
    )
    
    # If using factory.deploy, creation args are passed in deploy() if it's a new create
    if result.operation_performed == algokit_utils.OperationPerformed.Create:
        # Re-verify if we need to call create manually or if factory handles it
        # Typed factories handle creation args in the deploy call
        pass

    logger.info(
        f"Deployed IdentityRegistry to {app_client.app_id}"
    )
