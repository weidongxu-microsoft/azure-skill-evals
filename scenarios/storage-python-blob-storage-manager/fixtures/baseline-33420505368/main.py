"""Demonstrate synchronous and asynchronous blob management."""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from azure.core.exceptions import AzureError

from blob_service import AsyncBlobStorageService, BlobStorageService, OperationResult
from config import (
    StorageSettings,
    create_async_blob_service_client,
    create_blob_service_client,
)

CONTAINER = os.getenv("AZURE_STORAGE_CONTAINER", "blob-manager-demo")
BLOB_NAME = "sample.txt"
SAMPLE_PATH = Path("sample.txt")
SYNC_DOWNLOAD = Path("downloaded-sync.txt")
ASYNC_DOWNLOAD = Path("downloaded-async.txt")
TIMEOUT = int(os.getenv("AZURE_STORAGE_OPERATION_TIMEOUT", "60"))


def show(step: str, result: OperationResult) -> bool:
    marker = "OK" if result.success else "ERROR"
    print(f"[{marker}] {step}: {result.message}")
    if result.success and isinstance(result.value, list):
        for name in result.value:
            print(f"       - {name}")
    return result.success


def run_sync(settings: StorageSettings) -> None:
    print("\n=== Synchronous operations ===")
    client, credential = create_blob_service_client(settings)
    service = BlobStorageService(client)
    try:
        if not show("container", service.ensure_container(CONTAINER, TIMEOUT)):
            return
        show(
            "upload",
            service.upload_file(
                CONTAINER,
                BLOB_NAME,
                SAMPLE_PATH,
                metadata={"demo": "sync"},
                tags={"environment": "demo", "implementation": "sync"},
                timeout=TIMEOUT,
            ),
        )
        show("list", service.list_blobs(CONTAINER, TIMEOUT))
        show(
            "download",
            service.download_file(
                CONTAINER, BLOB_NAME, SYNC_DOWNLOAD, timeout=TIMEOUT
            ),
        )

        lease_result = service.acquire_lease(
            CONTAINER, BLOB_NAME, duration=60, timeout=TIMEOUT
        )
        if show("acquire lease", lease_result) and lease_result.value is not None:
            lease = lease_result.value
            try:
                SAMPLE_PATH.write_text(
                    "Updated by the synchronous lease holder.\n",
                    encoding="utf-8",
                )
                show(
                    "leased overwrite",
                    service.upload_file(
                        CONTAINER,
                        BLOB_NAME,
                        SAMPLE_PATH,
                        metadata={"demo": "sync-update"},
                        tags={"environment": "demo", "implementation": "sync"},
                        lease_id=lease.id,
                        timeout=TIMEOUT,
                    ),
                )
            finally:
                try:
                    lease.release(timeout=TIMEOUT)
                    print("[OK] release lease")
                except AzureError as error:
                    print(f"[ERROR] release lease: {error}")
        show(
            "delete",
            service.delete_blob(CONTAINER, BLOB_NAME, timeout=TIMEOUT),
        )
    finally:
        client.close()
        credential.close()


async def run_async(settings: StorageSettings) -> None:
    print("\n=== Asynchronous operations ===")
    client, credential = create_async_blob_service_client(settings)
    service = AsyncBlobStorageService(client)
    try:
        if not show(
            "container", await service.ensure_container(CONTAINER, TIMEOUT)
        ):
            return
        SAMPLE_PATH.write_text(
            "Azure Blob Storage asynchronous demo.\n", encoding="utf-8"
        )
        show(
            "upload",
            await service.upload_file(
                CONTAINER,
                BLOB_NAME,
                SAMPLE_PATH,
                metadata={"demo": "async"},
                tags={"environment": "demo", "implementation": "async"},
                timeout=TIMEOUT,
            ),
        )
        show("list", await service.list_blobs(CONTAINER, TIMEOUT))
        show(
            "download",
            await service.download_file(
                CONTAINER, BLOB_NAME, ASYNC_DOWNLOAD, timeout=TIMEOUT
            ),
        )

        lease_result = await service.acquire_lease(
            CONTAINER, BLOB_NAME, duration=60, timeout=TIMEOUT
        )
        if show("acquire lease", lease_result) and lease_result.value is not None:
            lease = lease_result.value
            try:
                SAMPLE_PATH.write_text(
                    "Updated by the asynchronous lease holder.\n",
                    encoding="utf-8",
                )
                show(
                    "leased overwrite",
                    await service.upload_file(
                        CONTAINER,
                        BLOB_NAME,
                        SAMPLE_PATH,
                        metadata={"demo": "async-update"},
                        tags={"environment": "demo", "implementation": "async"},
                        lease_id=lease.id,
                        timeout=TIMEOUT,
                    ),
                )
            finally:
                try:
                    await lease.release(timeout=TIMEOUT)
                    print("[OK] release lease")
                except AzureError as error:
                    print(f"[ERROR] release lease: {error}")
        show(
            "delete",
            await service.delete_blob(CONTAINER, BLOB_NAME, timeout=TIMEOUT),
        )
    finally:
        await client.close()
        await credential.close()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    try:
        settings = StorageSettings.from_environment()
    except (TypeError, ValueError) as error:
        print(f"[ERROR] Configuration: {error}")
        return

    SAMPLE_PATH.write_text("Azure Blob Storage synchronous demo.\n", encoding="utf-8")
    run_sync(settings)
    asyncio.run(run_async(settings))


if __name__ == "__main__":
    main()
