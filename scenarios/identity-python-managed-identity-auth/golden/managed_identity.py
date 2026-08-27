from __future__ import annotations

import os
import sys

from azure.core.exceptions import HttpResponseError
from azure.identity import AzureCliCredential
from azure.identity import ChainedTokenCredential
from azure.identity import CredentialUnavailableError
from azure.identity import DefaultAzureCredential
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient


def system_assigned_credential() -> ManagedIdentityCredential:
    return ManagedIdentityCredential()


def default_user_assigned_credential() -> DefaultAzureCredential:
    client_id = os.environ["AZURE_CLIENT_ID"]
    return DefaultAzureCredential(managed_identity_client_id=client_id)


def local_fallback_credential() -> ChainedTokenCredential:
    client_id = os.environ["AZURE_CLIENT_ID"]
    return ChainedTokenCredential(
        ManagedIdentityCredential(client_id=client_id),
        AzureCliCredential(),
    )


def run() -> int:
    vault_url = os.environ["AZURE_KEY_VAULT_URL"]
    secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
    client_id = os.environ["AZURE_CLIENT_ID"]
    credential = ManagedIdentityCredential(client_id=client_id)

    try:
        with credential:
            with SecretClient(
                vault_url=vault_url,
                credential=credential,
            ) as client:
                secret = client.get_secret(secret_name)
                print(secret.value)
    except CredentialUnavailableError as error:
        print(
            f"Managed identity is unavailable; use Azure CLI locally: {error}",
            file=sys.stderr,
        )
        return 1
    except HttpResponseError as error:
        print(f"Key Vault request failed: {error}", file=sys.stderr)
        raise
    return 0


def main() -> int:
    try:
        return run()
    except KeyError as error:
        print(
            f"Missing required environment variable: {error.args[0]}",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
