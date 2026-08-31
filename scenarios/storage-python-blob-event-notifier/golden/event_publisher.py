from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any

from azure.core.exceptions import AzureError
from azure.eventgrid import EventGridEvent, EventGridPublisherClient
from azure.eventgrid.aio import EventGridPublisherClient as AsyncEventGridPublisherClient

logger = logging.getLogger(__name__)


def create_document_processed_event(
    data: dict[str, Any],
    *,
    subject: str = "/documents/invoices/processed",
) -> EventGridEvent:
    return EventGridEvent(
        subject=subject,
        event_type="Contoso.Documents.Processed",
        data=data,
        data_version="1.0",
    )


def publish_custom_events(
    topic_endpoint: str,
    credential: object,
    events: Iterable[EventGridEvent],
) -> None:
    client = EventGridPublisherClient(topic_endpoint, credential)
    try:
        client.send(list(events))
    except AzureError as error:
        logger.error("Custom Event Grid publishing failed: %s", error)
    finally:
        client.close()


async def publish_custom_events_async(
    topic_endpoint: str,
    credential: object,
    events: Iterable[EventGridEvent],
) -> None:
    client = AsyncEventGridPublisherClient(topic_endpoint, credential)
    try:
        await client.send(list(events))
    except AzureError as error:
        logger.error("Async custom Event Grid publishing failed: %s", error)
    finally:
        await client.close()
