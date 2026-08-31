from __future__ import annotations

import os
from dataclasses import dataclass

from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient


@dataclass(frozen=True)
class Settings:
    storage_account_url: str
    event_grid_topic_endpoint: str


def load_settings() -> Settings:
    return Settings(
        storage_account_url=os.environ["AZURE_STORAGE_ACCOUNT_URL"],
        event_grid_topic_endpoint=os.environ["AZURE_EVENT_GRID_TOPIC_ENDPOINT"],
    )


def create_sync_blob_service_client(
    settings: Settings,
    credential: object,
) -> BlobServiceClient:
    return BlobServiceClient(
        account_url=settings.storage_account_url,
        credential=credential,
    )


def create_async_blob_service_client(
    settings: Settings,
    credential: object,
) -> AsyncBlobServiceClient:
    return AsyncBlobServiceClient(
        account_url=settings.storage_account_url,
        credential=credential,
    )
