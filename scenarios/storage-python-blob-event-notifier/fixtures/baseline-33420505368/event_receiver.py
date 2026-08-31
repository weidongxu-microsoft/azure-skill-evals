from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from typing import Any, TypeAlias

from azure.core.messaging import CloudEvent
from azure.eventgrid import EventGridEvent, SystemEventNames
from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient

from blob_event_handler import (
    handle_blob_created,
    handle_blob_created_async,
    handle_blob_deleted,
    handle_blob_deleted_async,
)

logger = logging.getLogger(__name__)

Event: TypeAlias = EventGridEvent | CloudEvent
JsonDocument: TypeAlias = str | bytes
JsonObject: TypeAlias = Mapping[str, Any]
JsonEvent: TypeAlias = JsonDocument | JsonObject
JsonPayload: TypeAlias = JsonEvent | Iterable[JsonEvent]


def deserialize_event(payload: JsonEvent) -> Event:
    """Deserialize one event using the models supplied by the Azure SDK."""
    try:
        cloud_event = (
            CloudEvent.from_dict(dict(payload))
            if isinstance(payload, Mapping)
            else CloudEvent.from_json(payload)
        )
        if cloud_event.specversion == "1.0" and cloud_event.type:
            return cloud_event
    except (KeyError, TypeError, ValueError):
        pass

    try:
        event_grid_event = (
            EventGridEvent.from_dict(dict(payload))
            if isinstance(payload, Mapping)
            else EventGridEvent.from_json(payload)
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(
            "Payload is neither a CloudEvents 1.0 event nor an Event Grid event"
        ) from error

    if not event_grid_event.event_type:
        raise ValueError("Event Grid event is missing eventType")
    return event_grid_event


def deserialize_events(payload: JsonPayload) -> list[Event]:
    documents = (
        [payload]
        if isinstance(payload, (str, bytes, Mapping))
        else list(payload)
    )
    return [deserialize_event(document) for document in documents]


def _event_type(event: Event) -> str:
    return event.type if isinstance(event, CloudEvent) else event.event_type


def receive_events(
    payload: JsonPayload,
    blob_service_client: BlobServiceClient,
) -> list[Event]:
    events = deserialize_events(payload)
    for event in events:
        event_type = _event_type(event)
        if event_type == SystemEventNames.StorageBlobCreated:
            handle_blob_created(event.subject or "", blob_service_client)
        elif event_type == SystemEventNames.StorageBlobDeleted:
            handle_blob_deleted(event.subject or "")
        else:
            logger.warning("Unrecognized Event Grid event type: %s", event_type)
    return events


async def receive_events_async(
    payload: JsonPayload,
    blob_service_client: AsyncBlobServiceClient,
) -> list[Event]:
    events = deserialize_events(payload)
    for event in events:
        event_type = _event_type(event)
        if event_type == SystemEventNames.StorageBlobCreated:
            await handle_blob_created_async(event.subject or "", blob_service_client)
        elif event_type == SystemEventNames.StorageBlobDeleted:
            await handle_blob_deleted_async(event.subject or "")
        else:
            logger.warning("Unrecognized Event Grid event type: %s", event_type)
    return events
