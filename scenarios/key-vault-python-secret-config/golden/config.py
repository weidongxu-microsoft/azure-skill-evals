from __future__ import annotations

import os

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from azure.keyvault.secrets.aio import SecretClient as AsyncSecretClient


def create_sync_client() -> tuple[DefaultAzureCredential, SecretClient]:
    credential = DefaultAzureCredential()
    client = SecretClient(
        vault_url=os.environ["AZURE_KEY_VAULT_URL"],
        credential=credential,
    )
    return credential, client


def create_async_client() -> tuple[AsyncDefaultAzureCredential, AsyncSecretClient]:
    credential = AsyncDefaultAzureCredential()
    client = AsyncSecretClient(
        vault_url=os.environ["AZURE_KEY_VAULT_URL"],
        credential=credential,
    )
    return credential, client
