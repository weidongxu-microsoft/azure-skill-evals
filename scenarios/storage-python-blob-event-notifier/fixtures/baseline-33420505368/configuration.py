from __future__ import annotations

import os
from dataclasses import dataclass

from azure.eventgrid import EventGridPublisherClient
from azure.eventgrid.aio import EventGridPublisherClient as AsyncEventGridPublisherClient
from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient


@dataclass(frozen=True)
class AzureSettings:
    storage_account_url: str
    event_grid_topic_endpoint: str

    @classmethod
    def from_environment(cls) -> AzureSettings:
        return cls(
            storage_account_url=_required_environment_variable(
                "AZURE_STORAGE_ACCOUNT_URL"
            ),
            event_grid_topic_endpoint=_required_environment_variable(
                "EVENTGRID_TOPIC_ENDPOINT"
            ),
        )


def _required_environment_variable(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return value


@dataclass
class SyncAzureClients:
    credential: DefaultAzureCredential
    blob_service: BlobServiceClient
    event_grid_publisher: EventGridPublisherClient

    def close(self) -> None:
        self.blob_service.close()
        self.event_grid_publisher.close()
        self.credential.close()


@dataclass
class AsyncAzureClients:
    credential: AsyncDefaultAzureCredential
    blob_service: AsyncBlobServiceClient
    event_grid_publisher: AsyncEventGridPublisherClient

    async def close(self) -> None:
        await self.blob_service.close()
        await self.event_grid_publisher.close()
        await self.credential.close()


def create_sync_clients(settings: AzureSettings) -> SyncAzureClients:
    credential = DefaultAzureCredential()
    return SyncAzureClients(
        credential=credential,
        blob_service=BlobServiceClient(
            account_url=settings.storage_account_url,
            credential=credential,
        ),
        event_grid_publisher=EventGridPublisherClient(
            endpoint=settings.event_grid_topic_endpoint,
            credential=credential,
        ),
    )


def create_async_clients(settings: AzureSettings) -> AsyncAzureClients:
    credential = AsyncDefaultAzureCredential()
    return AsyncAzureClients(
        credential=credential,
        blob_service=AsyncBlobServiceClient(
            account_url=settings.storage_account_url,
            credential=credential,
        ),
        event_grid_publisher=AsyncEventGridPublisherClient(
            endpoint=settings.event_grid_topic_endpoint,
            credential=credential,
        ),
    )
