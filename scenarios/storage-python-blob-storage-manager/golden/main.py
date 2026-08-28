from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

from async_blob_manager import AsyncBlobStorageManager
from blob_manager import BlobOperationError, LeaseConflictError, SyncBlobStorageManager
from config import (
    create_async_blob_service_client,
    create_sync_blob_service_client,
    load_settings,
)


def write_sample_file(path: str) -> None:
    Path(path).write_text("id,value\n1,hello from Azure Blob Storage\n", encoding="utf-8")


def run_sync_demo(settings) -> None:
    tags = {"category": "sample", "mode": "sync"}
    metadata = {"uploaded-by": "sync-manager"}
    try:
        with DefaultAzureCredential() as credential:
            service_client = create_sync_blob_service_client(settings, credential)
            try:
                manager = SyncBlobStorageManager(
                    service_client,
                    settings.container_name,
                    settings.blob_name,
                )
                manager.ensure_container(timeout=30)
                print("Sync: uploading the sample blob")
                manager.upload(
                    settings.source_path,
                    metadata=metadata,
                    tags=tags,
                    timeout=30,
                )
                print("Sync: listing blobs")
                for blob_name in manager.list_blobs(timeout=30):
                    print(f"Sync blob: {blob_name}")
                print("Sync: downloading the blob")
                manager.download(settings.sync_download_path, timeout=30)
                print("Sync: acquiring a lease and overwriting the blob")
                manager.overwrite_with_lease(settings.source_path, timeout=30)
                print("Sync: deleting the blob")
                manager.delete(timeout=30)
            finally:
                service_client.close()
    except LeaseConflictError as error:
        print(f"Sync lease conflict: {error}", file=sys.stderr)
    except BlobOperationError as error:
        print(f"Sync blob operation failed: {error}", file=sys.stderr)


async def run_async_demo(settings) -> None:
    tags = {"category": "sample", "mode": "async"}
    metadata = {"uploaded-by": "async-manager"}
    try:
        async with AsyncDefaultAzureCredential() as credential:
            service_client = create_async_blob_service_client(
                settings,
                credential,
            )
            try:
                manager = AsyncBlobStorageManager(
                    service_client,
                    settings.container_name,
                    settings.blob_name,
                )
                await manager.ensure_container(timeout=30)
                print("Async: uploading the sample blob")
                await manager.upload(
                    settings.source_path,
                    metadata=metadata,
                    tags=tags,
                    timeout=30,
                )
                print("Async: listing blobs")
                for blob_name in await manager.list_blobs(timeout=30):
                    print(f"Async blob: {blob_name}")
                print("Async: downloading the blob")
                await manager.download(settings.async_download_path, timeout=30)
                print("Async: acquiring a lease and overwriting the blob")
                await manager.overwrite_with_lease(
                    settings.source_path,
                    timeout=30,
                )
                print("Async: deleting the blob")
                await manager.delete(timeout=30)
            finally:
                await service_client.close()
    except LeaseConflictError as error:
        print(f"Async lease conflict: {error}", file=sys.stderr)
    except BlobOperationError as error:
        print(f"Async blob operation failed: {error}", file=sys.stderr)


def main() -> None:
    settings = load_settings()
    write_sample_file(settings.source_path)
    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))


if __name__ == "__main__":
    main()
