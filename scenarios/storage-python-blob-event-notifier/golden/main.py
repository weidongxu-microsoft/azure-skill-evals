from __future__ import annotations

import asyncio
import logging

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

from config import (
    create_async_blob_service_client,
    create_sync_blob_service_client,
    load_settings,
)
from event_publisher import (
    create_document_processed_event,
    publish_custom_events,
    publish_custom_events_async,
)
from event_receiver import (
    receive_cloud_events,
    receive_cloud_events_async,
    receive_event_grid_events,
    receive_event_grid_events_async,
)

EVENT_GRID_PAYLOADS = (
    '{"id":"eg-created","eventType":"Microsoft.Storage.BlobCreated",'
    '"subject":"/blobServices/default/containers/invoices/blobs/2026/august/one.pdf",'
    '"eventTime":"2026-08-29T00:00:00Z","data":{"url":"https://example.invalid/one.pdf"},'
    '"dataVersion":"1","metadataVersion":"1","topic":"/subscriptions/example"}',
    '{"id":"eg-deleted","eventType":"Microsoft.Storage.BlobDeleted",'
    '"subject":"/blobServices/default/containers/invoices/blobs/2026/august/old.pdf",'
    '"eventTime":"2026-08-29T00:01:00Z","data":{"url":"https://example.invalid/old.pdf"},'
    '"dataVersion":"1","metadataVersion":"1","topic":"/subscriptions/example"}',
)

CLOUD_EVENT_PAYLOADS = (
    '{"specversion":"1.0","id":"ce-created","source":"/subscriptions/example",'
    '"type":"Microsoft.Storage.BlobCreated",'
    '"subject":"/blobServices/default/containers/invoices/blobs/2026/august/two.pdf",'
    '"time":"2026-08-29T00:02:00Z","data":{"url":"https://example.invalid/two.pdf"}}',
    '{"specversion":"1.0","id":"ce-deleted","source":"/subscriptions/example",'
    '"type":"Microsoft.Storage.BlobDeleted",'
    '"subject":"/blobServices/default/containers/invoices/blobs/2026/august/archived.pdf",'
    '"time":"2026-08-29T00:03:00Z","data":{"url":"https://example.invalid/archived.pdf"}}',
)


def run_sync_demo(settings) -> None:
    with DefaultAzureCredential() as credential:
        blob_service_client = create_sync_blob_service_client(settings, credential)
        try:
            receive_event_grid_events(EVENT_GRID_PAYLOADS, blob_service_client)
            receive_cloud_events(CLOUD_EVENT_PAYLOADS, blob_service_client)
            downstream_event = create_document_processed_event(
                {"document": "2026/august/one.pdf", "status": "processed"},
                subject="/documents/invoices/processed",
            )
            publish_custom_events(
                settings.event_grid_topic_endpoint,
                credential,
                [downstream_event],
            )
        finally:
            blob_service_client.close()


async def run_async_demo(settings) -> None:
    async with AsyncDefaultAzureCredential() as credential:
        blob_service_client = create_async_blob_service_client(settings, credential)
        try:
            await receive_event_grid_events_async(
                EVENT_GRID_PAYLOADS,
                blob_service_client,
            )
            await receive_cloud_events_async(
                CLOUD_EVENT_PAYLOADS,
                blob_service_client,
            )
            downstream_event = create_document_processed_event(
                {"document": "2026/august/two.pdf", "status": "processed"},
                subject="/documents/invoices/processed",
            )
            await publish_custom_events_async(
                settings.event_grid_topic_endpoint,
                credential,
                [downstream_event],
            )
        finally:
            await blob_service_client.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = load_settings()
    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))


if __name__ == "__main__":
    main()
