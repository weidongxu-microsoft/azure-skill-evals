from __future__ import annotations

import os
import sys

from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient


SECRET_NAME = "my-secret"
INITIAL_VALUE = "my-secret-value"
UPDATED_VALUE = "updated-value"


def run() -> None:
    vault_url = os.environ["AZURE_KEY_VAULT_URL"]
    with DefaultAzureCredential() as credential:
        with SecretClient(vault_url=vault_url, credential=credential) as client:
            try:
                client.set_secret(SECRET_NAME, INITIAL_VALUE)
                retrieved = client.get_secret(SECRET_NAME)
                print(retrieved.value)
                client.set_secret(SECRET_NAME, UPDATED_VALUE)
                deletion = client.begin_delete_secret(SECRET_NAME)
                deletion.wait()
                client.purge_deleted_secret(SECRET_NAME)
            except ResourceNotFoundError as error:
                print(f"Key Vault secret operation failed: {error}", file=sys.stderr)
                raise


if __name__ == "__main__":
    run()
