from __future__ import annotations

import asyncio
import sys

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

from async_encrypted_blob_manager import AsyncEncryptedBlobManager
from async_key_manager import AsyncKeyManager
from config import create_async_clients, create_sync_clients, load_settings
from encrypted_blob_manager import BlobEncryptionError, EncryptedBlobManager
from key_manager import KeyManager, KeyVaultOperationError


def print_result(label: str, metadata, plaintext: bytes) -> None:
    print(f"{label} vault key ID: {metadata.key_id}")
    print(f"{label} wrapped DEK: {metadata.wrapped_dek}")
    print(f"{label} decrypted output: {plaintext.decode('utf-8')}")


def run_sync_demo(settings) -> None:
    try:
        with DefaultAzureCredential() as credential:
            blob_client, crypto_client = create_sync_clients(settings, credential)
            try:
                manager = EncryptedBlobManager(
                    blob_client,
                    KeyManager(crypto_client),
                    settings.container_name,
                    settings.blob_name,
                )
                metadata = manager.upload(b"Hello from encrypted Blob Storage")
                print_result("Sync", metadata, manager.download())
            finally:
                blob_client.close()
                crypto_client.close()
    except (BlobEncryptionError, KeyVaultOperationError) as error:
        print(f"Sync encryption workflow failed: {error}", file=sys.stderr)


async def run_async_demo(settings) -> None:
    try:
        async with AsyncDefaultAzureCredential() as credential:
            blob_client, crypto_client = create_async_clients(settings, credential)
            try:
                manager = AsyncEncryptedBlobManager(
                    blob_client,
                    AsyncKeyManager(crypto_client),
                    settings.container_name,
                    settings.blob_name,
                )
                metadata = await manager.upload(b"Hello from encrypted Blob Storage")
                print_result("Async", metadata, await manager.download())
            finally:
                await blob_client.close()
                await crypto_client.close()
    except (BlobEncryptionError, KeyVaultOperationError) as error:
        print(f"Async encryption workflow failed: {error}", file=sys.stderr)


def main() -> None:
    settings = load_settings()
    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))


if __name__ == "__main__":
    main()
