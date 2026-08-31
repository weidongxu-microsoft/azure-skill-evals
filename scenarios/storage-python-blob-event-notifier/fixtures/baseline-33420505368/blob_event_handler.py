from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from urllib.parse import unquote

from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient

logger = logging.getLogger(__name__)

_BLOB_SUBJECT_PATTERN = re.compile(
    r"^/blobServices/default/containers/(?P<container>[^/]+)/blobs/(?P<blob>.+)$"
)


@dataclass(frozen=True)
class BlobLocation:
    container: str
    name: str


def parse_blob_subject(subject: str) -> BlobLocation:
    match = _BLOB_SUBJECT_PATTERN.match(subject)
    if not match:
        raise ValueError(f"Invalid Azure Storage blob event subject: {subject!r}")
    return BlobLocation(
        container=unquote(match.group("container")),
        name=unquote(match.group("blob")),
    )


def handle_blob_created(
    subject: str,
    blob_service_client: BlobServiceClient,
) -> None:
    location = parse_blob_subject(subject)
    blob_client = blob_service_client.get_blob_client(
        container=location.container,
        blob=location.name,
    )

    try:
        properties = blob_client.get_blob_properties()
        content = blob_client.download_blob().readall()
    except ResourceNotFoundError:
        logger.warning(
            "Blob %s/%s no longer exists; skipping created event",
            location.container,
            location.name,
        )
        return
    except HttpResponseError as error:
        logger.warning(
            "Blob %s/%s cannot currently be downloaded (error code: %s): %s",
            location.container,
            location.name,
            error.error_code or "unknown",
            error,
        )
        return

    size = properties.size if properties.size is not None else len(content)
    content_type = properties.content_settings.content_type or "unknown"
    access_tier = properties.blob_tier or "unknown"
    print(
        f"Blob created: name={location.name}, size={size}, "
        f"content_type={content_type}, access_tier={access_tier}"
    )


async def handle_blob_created_async(
    subject: str,
    blob_service_client: AsyncBlobServiceClient,
) -> None:
    location = parse_blob_subject(subject)
    blob_client = blob_service_client.get_blob_client(
        container=location.container,
        blob=location.name,
    )

    try:
        properties = await blob_client.get_blob_properties()
        downloader = await blob_client.download_blob()
        content = await downloader.readall()
    except ResourceNotFoundError:
        logger.warning(
            "Blob %s/%s no longer exists; skipping created event",
            location.container,
            location.name,
        )
        return
    except HttpResponseError as error:
        logger.warning(
            "Blob %s/%s cannot currently be downloaded (error code: %s): %s",
            location.container,
            location.name,
            error.error_code or "unknown",
            error,
        )
        return

    size = properties.size if properties.size is not None else len(content)
    content_type = properties.content_settings.content_type or "unknown"
    access_tier = properties.blob_tier or "unknown"
    print(
        f"Blob created: name={location.name}, size={size}, "
        f"content_type={content_type}, access_tier={access_tier}"
    )


def handle_blob_deleted(subject: str) -> None:
    location = parse_blob_subject(subject)
    logger.info("Blob deleted: %s/%s", location.container, location.name)


async def handle_blob_deleted_async(subject: str) -> None:
    handle_blob_deleted(subject)
