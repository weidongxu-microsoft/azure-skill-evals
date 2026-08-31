from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from azure.core.exceptions import AzureError
from azure.eventgrid import EventGridEvent, EventGridPublisherClient
from azure.eventgrid.aio import EventGridPublisherClient as AsyncEventGridPublisherClient
from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CustomEvent:
    event_type: str
    data: Any
    subject: str
    data_version: str = "1.0"

    def to_event_grid_event(self) -> EventGridEvent:
        if not self.subject.startswith("/"):
            raise ValueError(
                "Event subjects must start with '/' to form a filterable hierarchy"
            )
        return EventGridEvent(
            subject=self.subject,
            event_type=self.event_type,
            data=self.data,
            data_version=self.data_version,
        )


def publish_events(
    topic_endpoint: str,
    events: list[CustomEvent],
    *,
    client: EventGridPublisherClient | None = None,
) -> None:
    if not events:
        return

    credential = None
    publisher = client
    if publisher is None:
        credential = DefaultAzureCredential()
        publisher = EventGridPublisherClient(topic_endpoint, credential)

    try:
        publisher.send([event.to_event_grid_event() for event in events])
    except AzureError as error:
        logger.error("Failed to publish %d Event Grid event(s): %s", len(events), error)
        raise
    finally:
        if client is None:
            publisher.close()
            assert credential is not None
            credential.close()


async def publish_events_async(
    topic_endpoint: str,
    events: list[CustomEvent],
    *,
    client: AsyncEventGridPublisherClient | None = None,
) -> None:
    if not events:
        return

    credential = None
    publisher = client
    if publisher is None:
        credential = AsyncDefaultAzureCredential()
        publisher = AsyncEventGridPublisherClient(topic_endpoint, credential)

    try:
        await publisher.send([event.to_event_grid_event() for event in events])
    except AzureError as error:
        logger.error("Failed to publish %d Event Grid event(s): %s", len(events), error)
        raise
    finally:
        if client is None:
            await publisher.close()
            assert credential is not None
            await credential.close()
