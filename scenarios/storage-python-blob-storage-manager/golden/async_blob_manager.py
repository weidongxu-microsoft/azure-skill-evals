from __future__ import annotations

from azure.core.exceptions import HttpResponseError, ResourceExistsError, ResourceModifiedError, ResourceNotFoundError
from azure.storage.blob.aio import BlobLeaseClient, BlobServiceClient

from blob_manager import LeaseConflictError, _raise_storage_error


class AsyncBlobStorageManager:
    def __init__(
        self,
        service_client: BlobServiceClient,
        container_name: str,
        blob_name: str,
    ) -> None:
        self._container_client = service_client.get_container_client(container_name)
        self._blob_client = self._container_client.get_blob_client(blob_name)

    async def ensure_container(self, *, timeout: int | None = None) -> None:
        try:
            await self._container_client.create_container(timeout=timeout)
        except ResourceExistsError:
            return
        except HttpResponseError as error:
            _raise_storage_error("Unable to create the container", error)

    async def upload(
        self,
        source_path: str,
        *,
        metadata: dict[str, str] | None = None,
        tags: dict[str, str] | None = None,
        timeout: int | None = None,
    ) -> None:
        try:
            with open(source_path, "rb") as stream:
                await self._blob_client.upload_blob(
                    stream,
                    overwrite=True,
                    metadata=metadata,
                    tags=tags,
                    max_concurrency=4,
                    timeout=timeout,
                )
        except ResourceNotFoundError as error:
            _raise_storage_error("The source blob target could not be found", error)
        except HttpResponseError as error:
            _raise_storage_error("The upload request failed", error)

    async def list_blobs(self, *, timeout: int | None = None) -> list[str]:
        try:
            names: list[str] = []
            async for blob in self._container_client.list_blobs(timeout=timeout):
                names.append(blob.name)
            return names
        except HttpResponseError as error:
            _raise_storage_error("Listing blobs failed", error)

    async def download(
        self,
        destination_path: str,
        *,
        timeout: int | None = None,
    ) -> None:
        try:
            stream = await self._blob_client.download_blob(timeout=timeout)
            with open(destination_path, "wb") as destination:
                await stream.readinto(destination)
        except ResourceNotFoundError as error:
            _raise_storage_error("The blob to download was not found", error)
        except HttpResponseError as error:
            _raise_storage_error("Downloading the blob failed", error)

    async def overwrite_with_lease(
        self,
        source_path: str,
        *,
        timeout: int | None = None,
    ) -> None:
        lease = BlobLeaseClient(self._blob_client)
        try:
            await lease.acquire(lease_duration=30, timeout=timeout)
            with open(source_path, "rb") as stream:
                await self._blob_client.upload_blob(
                    stream,
                    overwrite=True,
                    lease=lease,
                    max_concurrency=4,
                    timeout=timeout,
                )
        except (ResourceExistsError, ResourceModifiedError) as error:
            raise LeaseConflictError(
                "Another client already holds the blob lease."
            ) from error
        except HttpResponseError as error:
            _raise_storage_error("Lease-protected overwrite failed", error)
        finally:
            try:
                await lease.release()
            except HttpResponseError:
                pass

    async def delete(self, *, timeout: int | None = None) -> None:
        try:
            await self._blob_client.delete_blob(timeout=timeout)
        except ResourceNotFoundError as error:
            _raise_storage_error("The blob to delete was not found", error)
        except HttpResponseError as error:
            _raise_storage_error("Deleting the blob failed", error)
