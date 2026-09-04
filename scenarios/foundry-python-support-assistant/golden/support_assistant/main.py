from __future__ import annotations

import logging
import os

from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
from azure.storage.blob import BlobServiceClient

from .config import load_settings
from .foundry import FoundryRestGateway
from .server import ServerOptions, create_server
from .service import SupportAssistant
from .state import BlobStateStore


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    settings = load_settings()
    credential = (
        ManagedIdentityCredential()
        if os.environ.get("AZURE_TOKEN_CREDENTIALS") == "prod"
        else DefaultAzureCredential()
    )
    blob_service = BlobServiceClient(
        account_url=settings.storage_account_endpoint,
        credential=credential,
    )
    gateway = FoundryRestGateway(
        settings.project_endpoint,
        credential,
        settings.model_deployment_name,
        settings.evaluation_model_deployment_name,
        settings.token_scope,
    )
    server = None
    try:
        store = BlobStateStore(
            blob_service.get_container_client(settings.state_container),
            settings.state_blob,
        )
        store.initialize()
        assistant = SupportAssistant(gateway, store)
        server = create_server(
            assistant,
            ServerOptions(
                require_authentication=True,
                admin_principal_ids=settings.admin_principal_ids,
                materials=settings.materials,
                evaluation_dataset=settings.evaluation_dataset,
            ),
            host="0.0.0.0",
            port=settings.port,
        )
        logging.getLogger("contoso.support").info(
            "Support API listening on port %d", settings.port
        )
        server.serve_forever()
    except KeyboardInterrupt:
        logging.getLogger("contoso.support").info("Shutdown requested")
    finally:
        if server is not None:
            server.server_close()
        gateway.close()
        blob_service.close()
        credential.close()


if __name__ == "__main__":
    main()
