from __future__ import annotations

import logging
from collections.abc import Iterable

from azure.core.messaging import CloudEvent
from azure.eventgrid import EventGridEvent
from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient

from blob_event_handler import (
    handle_blob_created,
    handle_blob_created_async,
    handle_blob_deleted,
    handle_blob_deleted_async,
)

logger = logging.getLogger(__name__)

BLOB_CREATED = "Microsoft.Storage.BlobCreated"
BLOB_DELETED = "Microsoft.Storage.BlobDeleted"


def route_event(
    event: EventGridEvent | CloudEvent,
    blob_service_client: BlobServiceClient,
) -> None:
    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type
    if event_type == BLOB_CREATED:
        handle_blob_created(event.subject or "", blob_service_client)
    elif event_type == BLOB_DELETED:
        handle_blob_deleted(event.subject or "")
    else:
        logger.warning("Unrecognized Event Grid event type: %s", event_type)


def receive_event_grid_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
    for payload in payloads:
        route_event(EventGridEvent.from_json(payload), blob_service_client)


def receive_cloud_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
    for payload in payloads:
        route_event(CloudEvent.from_json(payload), blob_service_client)


async def route_event_async(
    event: EventGridEvent | CloudEvent,
    blob_service_client: AsyncBlobServiceClient,
) -> None:
    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type
    if event_type == BLOB_CREATED:
        await handle_blob_created_async(event.subject or "", blob_service_client)
    elif event_type == BLOB_DELETED:
        await handle_blob_deleted_async(event.subject or "")
    else:
        logger.warning("Unrecognized Event Grid event type: %s", event_type)


async def receive_event_grid_events_async(
    payloads: Iterable[str | bytes],
    blob_service_client: AsyncBlobServiceClient,
) -> None:
    for payload in payloads:
        await route_event_async(EventGridEvent.from_json(payload), blob_service_client)


async def receive_cloud_events_async(
    payloads: Iterable[str | bytes],
    blob_service_client: AsyncBlobServiceClient,
) -> None:
    for payload in payloads:
        await route_event_async(CloudEvent.from_json(payload), blob_service_client)
