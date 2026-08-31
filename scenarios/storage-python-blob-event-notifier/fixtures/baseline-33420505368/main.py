from __future__ import annotations

import asyncio
import logging

from configuration import (
    AzureSettings,
    create_async_clients,
    create_sync_clients,
)
from event_publisher import CustomEvent, publish_events, publish_events_async
from event_receiver import receive_events, receive_events_async

EVENT_GRID_PAYLOADS = [
    """
    {
      "id": "8b9f6f40-a17e-4a54-83d7-90f74e523101",
      "topic": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/demostorage",
      "subject": "/blobServices/default/containers/documents/blobs/invoices/2026-08.pdf",
      "eventType": "Microsoft.Storage.BlobCreated",
      "eventTime": "2026-08-31T18:00:00Z",
      "data": {
        "api": "PutBlob",
        "clientRequestId": "3f4cf024-3f1e-4ac0-a59a-dd38287b4244",
        "requestId": "f690cb5f-501e-0022-5aff-1f2ebc000000",
        "eTag": "0x8DE000000000001",
        "contentType": "application/pdf",
        "contentLength": 48219,
        "blobType": "BlockBlob",
        "url": "https://demostorage.blob.core.windows.net/documents/invoices/2026-08.pdf",
        "sequencer": "0000000000000000000000000001",
        "storageDiagnostics": {"batchId": "4e246481-434c-4cb0-9dc7-3d393ed44152"}
      },
      "dataVersion": "",
      "metadataVersion": "1"
    }
    """,
    """
    {
      "id": "8b9f6f40-a17e-4a54-83d7-90f74e523102",
      "topic": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/demostorage",
      "subject": "/blobServices/default/containers/documents/blobs/archive/old-invoice.pdf",
      "eventType": "Microsoft.Storage.BlobDeleted",
      "eventTime": "2026-08-31T18:01:00Z",
      "data": {
        "api": "DeleteBlob",
        "clientRequestId": "f4db4ed6-7e4d-47a4-95b8-226c812705a0",
        "requestId": "d8f6a910-901e-0010-33ff-1f37e8000000",
        "contentType": "application/pdf",
        "blobType": "BlockBlob",
        "url": "https://demostorage.blob.core.windows.net/documents/archive/old-invoice.pdf",
        "sequencer": "0000000000000000000000000002"
      },
      "dataVersion": "",
      "metadataVersion": "1"
    }
    """,
]

CLOUD_EVENT_PAYLOADS = [
    """
    {
      "specversion": "1.0",
      "type": "Microsoft.Storage.BlobCreated",
      "source": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/demostorage",
      "subject": "/blobServices/default/containers/documents/blobs/reports/monthly.csv",
      "id": "0ea6f89a-b626-4d3f-814f-5807c103cb98",
      "time": "2026-08-31T18:02:00Z",
      "datacontenttype": "application/json",
      "data": {
        "api": "PutBlob",
        "contentType": "text/csv",
        "contentLength": 1708,
        "blobType": "BlockBlob",
        "url": "https://demostorage.blob.core.windows.net/documents/reports/monthly.csv",
        "sequencer": "0000000000000000000000000003"
      }
    }
    """,
    """
    {
      "specversion": "1.0",
      "type": "Microsoft.Storage.BlobDeleted",
      "source": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/demostorage",
      "subject": "/blobServices/default/containers/documents/blobs/reports/obsolete.csv",
      "id": "c65ff077-1ee4-44aa-a0ca-8a4a1645aa61",
      "time": "2026-08-31T18:03:00Z",
      "datacontenttype": "application/json",
      "data": {
        "api": "DeleteBlob",
        "contentType": "text/csv",
        "blobType": "BlockBlob",
        "url": "https://demostorage.blob.core.windows.net/documents/reports/obsolete.csv",
        "sequencer": "0000000000000000000000000004"
      }
    }
    """,
]

DOWNSTREAM_EVENTS = [
    CustomEvent(
        event_type="Contoso.Documents.DocumentProcessed",
        subject="/documents/invoices/processed",
        data={"document": "invoices/2026-08.pdf", "status": "processed"},
    )
]


def run_sync_demo(settings: AzureSettings) -> None:
    clients = create_sync_clients(settings)
    try:
        receive_events(EVENT_GRID_PAYLOADS, clients.blob_service)
        receive_events(CLOUD_EVENT_PAYLOADS, clients.blob_service)
        publish_events(
            settings.event_grid_topic_endpoint,
            DOWNSTREAM_EVENTS,
            client=clients.event_grid_publisher,
        )
    finally:
        clients.close()


async def run_async_demo(settings: AzureSettings) -> None:
    clients = create_async_clients(settings)
    try:
        await receive_events_async(EVENT_GRID_PAYLOADS, clients.blob_service)
        await receive_events_async(CLOUD_EVENT_PAYLOADS, clients.blob_service)
        await publish_events_async(
            settings.event_grid_topic_endpoint,
            DOWNSTREAM_EVENTS,
            client=clients.event_grid_publisher,
        )
    finally:
        await clients.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = AzureSettings.from_environment()
    print("Running synchronous demo")
    run_sync_demo(settings)
    print("Running asynchronous demo")
    asyncio.run(run_async_demo(settings))


if __name__ == "__main__":
    main()
