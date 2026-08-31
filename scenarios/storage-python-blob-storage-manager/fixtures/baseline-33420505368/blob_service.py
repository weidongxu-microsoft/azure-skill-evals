"""Reusable synchronous and asynchronous Azure Blob Storage operations."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Generic, TypeVar

from azure.core.exceptions import (
    AzureError,
    ClientAuthenticationError,
    HttpResponseError,
    ResourceExistsError,
    ResourceNotFoundError,
    ServiceRequestError,
    ServiceResponseError,
)
from azure.storage.blob import BlobLeaseClient, BlobServiceClient
from azure.storage.blob.aio import BlobLeaseClient as AsyncBlobLeaseClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient

LOGGER = logging.getLogger(__name__)
T = TypeVar("T")


@dataclass(frozen=True)
class OperationResult(Generic[T]):
    """A storage operation outcome that callers can handle without exceptions."""

    success: bool
    message: str
    value: T | None = None


def _error_message(operation: str, error: AzureError) -> str:
    if isinstance(error, ResourceNotFoundError):
        reason = "the container or blob was not found"
    elif isinstance(error, ResourceExistsError):
        reason = "the blob already exists or is being created by another writer"
    elif isinstance(error, ClientAuthenticationError):
        reason = "authentication failed; check the managed identity configuration"
    elif isinstance(error, (ServiceRequestError, ServiceResponseError)):
        reason = "Azure Storage could not be reached or the request timed out"
    elif isinstance(error, HttpResponseError):
        error_code = str(getattr(error, "error_code", "") or "")
        if error.status_code in (401, 403):
            reason = "permission was denied by Azure Storage"
        elif "Lease" in error_code:
            reason = (
                f"the blob lease prevented the operation ({error_code}); "
                "another client may hold the lease"
            )
        else:
            reason = error.message or f"Azure returned HTTP {error.status_code}"
    else:
        reason = str(error)
    return f"{operation} failed: {reason}"


def _failed(operation: str, error: AzureError) -> OperationResult:
    message = _error_message(operation, error)
    LOGGER.error(message)
    return OperationResult(False, message)


def _timeout_kwargs(timeout: int | None) -> dict[str, int]:
    if timeout is not None and timeout <= 0:
        raise ValueError("timeout must be greater than zero")
    return {} if timeout is None else {"timeout": timeout}


class BlobStorageService:
    """Memory-efficient, lease-aware synchronous blob operations."""

    def __init__(
        self, client: BlobServiceClient, *, upload_concurrency: int = 4
    ) -> None:
        if upload_concurrency < 1:
            raise ValueError("upload_concurrency must be at least 1")
        self._client = client
        self._upload_concurrency = upload_concurrency

    def ensure_container(
        self, container: str, timeout: int | None = None
    ) -> OperationResult[None]:
        client = self._client.get_container_client(container)
        try:
            client.create_container(**_timeout_kwargs(timeout))
            return OperationResult(True, f"Created container '{container}'.")
        except ResourceExistsError:
            return OperationResult(True, f"Container '{container}' already exists.")
        except AzureError as error:
            return _failed(f"Create container '{container}'", error)

    def upload_file(
        self,
        container: str,
        blob: str,
        source: str | Path,
        *,
        metadata: dict[str, str] | None = None,
        tags: dict[str, str] | None = None,
        lease_id: str | None = None,
        timeout: int | None = None,
    ) -> OperationResult[None]:
        """Stream a file and atomically create or lease-protect an update."""

        source_path = Path(source)
        try:
            size = source_path.stat().st_size
        except OSError as error:
            message = f"Upload '{blob}' failed: cannot read '{source_path}': {error}"
            LOGGER.error(message)
            return OperationResult(False, message)

        blob_client = self._client.get_blob_client(container, blob)
        lease: BlobLeaseClient | None = None
        release_lease = False
        kwargs = _timeout_kwargs(timeout)
        try:
            try:
                blob_client.get_blob_properties(**kwargs)
                exists = True
            except ResourceNotFoundError:
                exists = False

            if exists:
                if lease_id:
                    lease = BlobLeaseClient(blob_client, lease_id=lease_id)
                else:
                    lease = blob_client.acquire_lease(
                        lease_duration=-1, **kwargs
                    )
                    release_lease = True

            with source_path.open("rb") as data:
                blob_client.upload_blob(
                    data,
                    length=size,
                    overwrite=exists,
                    metadata=metadata,
                    tags=tags,
                    lease=lease,
                    max_concurrency=self._upload_concurrency,
                    **kwargs,
                )
            return OperationResult(
                True,
                f"Uploaded '{source_path}' to '{container}/{blob}' "
                f"({size} bytes).",
            )
        except AzureError as error:
            return _failed(f"Upload '{container}/{blob}'", error)
        except OSError as error:
            message = f"Upload '{blob}' failed while reading '{source_path}': {error}"
            LOGGER.error(message)
            return OperationResult(False, message)
        finally:
            if release_lease and lease is not None:
                try:
                    lease.release(**kwargs)
                except AzureError as error:
                    LOGGER.error(_error_message(f"Release lease for '{blob}'", error))

    def download_file(
        self,
        container: str,
        blob: str,
        destination: str | Path,
        *,
        timeout: int | None = None,
    ) -> OperationResult[None]:
        """Download incrementally instead of buffering the whole blob."""

        destination_path = Path(destination)
        try:
            stream = self._client.get_blob_client(
                container, blob
            ).download_blob(**_timeout_kwargs(timeout))
            with destination_path.open("wb") as output:
                for chunk in stream.chunks():
                    output.write(chunk)
            return OperationResult(
                True, f"Downloaded '{container}/{blob}' to '{destination_path}'."
            )
        except AzureError as error:
            return _failed(f"Download '{container}/{blob}'", error)
        except OSError as error:
            message = (
                f"Download '{container}/{blob}' failed: cannot write "
                f"'{destination_path}': {error}"
            )
            LOGGER.error(message)
            return OperationResult(False, message)

    def list_blobs(
        self, container: str, timeout: int | None = None
    ) -> OperationResult[list[str]]:
        try:
            names = [
                item.name
                for item in self._client.get_container_client(
                    container
                ).list_blobs(**_timeout_kwargs(timeout))
            ]
            return OperationResult(
                True, f"Found {len(names)} blob(s) in '{container}'.", names
            )
        except AzureError as error:
            return _failed(f"List blobs in '{container}'", error)

    def delete_blob(
        self,
        container: str,
        blob: str,
        *,
        lease_id: str | None = None,
        timeout: int | None = None,
    ) -> OperationResult[None]:
        try:
            self._client.get_blob_client(container, blob).delete_blob(
                lease=lease_id, **_timeout_kwargs(timeout)
            )
            return OperationResult(True, f"Deleted '{container}/{blob}'.")
        except AzureError as error:
            return _failed(f"Delete '{container}/{blob}'", error)

    def acquire_lease(
        self,
        container: str,
        blob: str,
        *,
        duration: int = 60,
        timeout: int | None = None,
    ) -> OperationResult[BlobLeaseClient]:
        try:
            lease = self._client.get_blob_client(
                container, blob
            ).acquire_lease(
                lease_duration=duration, **_timeout_kwargs(timeout)
            )
            return OperationResult(
                True, f"Acquired lease for '{container}/{blob}'.", lease
            )
        except AzureError as error:
            return _failed(f"Acquire lease for '{container}/{blob}'", error)


class AsyncBlobStorageService:
    """Memory-efficient, lease-aware asynchronous blob operations."""

    def __init__(
        self, client: AsyncBlobServiceClient, *, upload_concurrency: int = 4
    ) -> None:
        if upload_concurrency < 1:
            raise ValueError("upload_concurrency must be at least 1")
        self._client = client
        self._upload_concurrency = upload_concurrency

    async def ensure_container(
        self, container: str, timeout: int | None = None
    ) -> OperationResult[None]:
        client = self._client.get_container_client(container)
        try:
            await client.create_container(**_timeout_kwargs(timeout))
            return OperationResult(True, f"Created container '{container}'.")
        except ResourceExistsError:
            return OperationResult(True, f"Container '{container}' already exists.")
        except AzureError as error:
            return _failed(f"Create container '{container}'", error)

    async def upload_file(
        self,
        container: str,
        blob: str,
        source: str | Path,
        *,
        metadata: dict[str, str] | None = None,
        tags: dict[str, str] | None = None,
        lease_id: str | None = None,
        timeout: int | None = None,
    ) -> OperationResult[None]:
        """Stream a file and atomically create or lease-protect an update."""

        source_path = Path(source)
        try:
            size = source_path.stat().st_size
        except OSError as error:
            message = f"Upload '{blob}' failed: cannot read '{source_path}': {error}"
            LOGGER.error(message)
            return OperationResult(False, message)

        blob_client = self._client.get_blob_client(container, blob)
        lease: AsyncBlobLeaseClient | None = None
        release_lease = False
        kwargs = _timeout_kwargs(timeout)
        try:
            try:
                await blob_client.get_blob_properties(**kwargs)
                exists = True
            except ResourceNotFoundError:
                exists = False

            if exists:
                if lease_id:
                    lease = AsyncBlobLeaseClient(blob_client, lease_id=lease_id)
                else:
                    lease = await blob_client.acquire_lease(
                        lease_duration=-1, **kwargs
                    )
                    release_lease = True

            with source_path.open("rb") as data:
                await blob_client.upload_blob(
                    data,
                    length=size,
                    overwrite=exists,
                    metadata=metadata,
                    tags=tags,
                    lease=lease,
                    max_concurrency=self._upload_concurrency,
                    **kwargs,
                )
            return OperationResult(
                True,
                f"Uploaded '{source_path}' to '{container}/{blob}' "
                f"({size} bytes).",
            )
        except AzureError as error:
            return _failed(f"Upload '{container}/{blob}'", error)
        except OSError as error:
            message = f"Upload '{blob}' failed while reading '{source_path}': {error}"
            LOGGER.error(message)
            return OperationResult(False, message)
        finally:
            if release_lease and lease is not None:
                try:
                    await lease.release(**kwargs)
                except AzureError as error:
                    LOGGER.error(_error_message(f"Release lease for '{blob}'", error))

    async def download_file(
        self,
        container: str,
        blob: str,
        destination: str | Path,
        *,
        timeout: int | None = None,
    ) -> OperationResult[None]:
        """Download incrementally instead of buffering the whole blob."""

        destination_path = Path(destination)
        try:
            stream = await self._client.get_blob_client(
                container, blob
            ).download_blob(**_timeout_kwargs(timeout))
            with destination_path.open("wb") as output:
                async for chunk in stream.chunks():
                    output.write(chunk)
            return OperationResult(
                True, f"Downloaded '{container}/{blob}' to '{destination_path}'."
            )
        except AzureError as error:
            return _failed(f"Download '{container}/{blob}'", error)
        except OSError as error:
            message = (
                f"Download '{container}/{blob}' failed: cannot write "
                f"'{destination_path}': {error}"
            )
            LOGGER.error(message)
            return OperationResult(False, message)

    async def list_blobs(
        self, container: str, timeout: int | None = None
    ) -> OperationResult[list[str]]:
        try:
            names = [
                item.name
                async for item in self._client.get_container_client(
                    container
                ).list_blobs(**_timeout_kwargs(timeout))
            ]
            return OperationResult(
                True, f"Found {len(names)} blob(s) in '{container}'.", names
            )
        except AzureError as error:
            return _failed(f"List blobs in '{container}'", error)

    async def delete_blob(
        self,
        container: str,
        blob: str,
        *,
        lease_id: str | None = None,
        timeout: int | None = None,
    ) -> OperationResult[None]:
        try:
            await self._client.get_blob_client(container, blob).delete_blob(
                lease=lease_id, **_timeout_kwargs(timeout)
            )
            return OperationResult(True, f"Deleted '{container}/{blob}'.")
        except AzureError as error:
            return _failed(f"Delete '{container}/{blob}'", error)

    async def acquire_lease(
        self,
        container: str,
        blob: str,
        *,
        duration: int = 60,
        timeout: int | None = None,
    ) -> OperationResult[AsyncBlobLeaseClient]:
        try:
            lease = await self._client.get_blob_client(
                container, blob
            ).acquire_lease(
                lease_duration=duration, **_timeout_kwargs(timeout)
            )
            return OperationResult(
                True, f"Acquired lease for '{container}/{blob}'.", lease
            )
        except AzureError as error:
            return _failed(f"Acquire lease for '{container}/{blob}'", error)
