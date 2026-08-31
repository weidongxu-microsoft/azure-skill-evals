from __future__ import annotations

import os
from dataclasses import dataclass

from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.keyvault.keys.crypto import CryptographyClient
from azure.keyvault.keys.crypto.aio import CryptographyClient as AsyncCryptographyClient
from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient


@dataclass(frozen=True)
class Settings:
    account_url: str
    container_name: str
    blob_name: str
    key_id: str


def load_settings() -> Settings:
    return Settings(
        account_url=os.environ["AZURE_STORAGE_ACCOUNT_URL"],
        container_name=os.environ.get("AZURE_STORAGE_CONTAINER_NAME", "encrypted"),
        blob_name=os.environ.get("AZURE_STORAGE_BLOB_NAME", "message.bin"),
        key_id=os.environ["AZURE_KEY_VAULT_KEY_ID"],
    )


def create_sync_clients(
    settings: Settings, credential: object
) -> tuple[BlobServiceClient, CryptographyClient]:
    return (
        BlobServiceClient(account_url=settings.account_url, credential=credential),
        CryptographyClient(key_id=settings.key_id, credential=credential),
    )


def create_async_clients(
    settings: Settings, credential: AsyncDefaultAzureCredential
) -> tuple[AsyncBlobServiceClient, AsyncCryptographyClient]:
    return (
        AsyncBlobServiceClient(
            account_url=settings.account_url,
            credential=credential,
        ),
        AsyncCryptographyClient(key_id=settings.key_id, credential=credential),
    )
