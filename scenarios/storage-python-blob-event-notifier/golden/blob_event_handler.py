from __future__ import annotations

import logging
from urllib.parse import unquote

from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient

logger = logging.getLogger(__name__)


def parse_blob_subject(subject: str) -> tuple[str, str]:
    _, separator, container_and_blob = subject.partition("/containers/")
    if not separator:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    container, separator, blob_name = container_and_blob.partition("/blobs/")
    if not separator or not container or not blob_name:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    return unquote(container), unquote(blob_name)


def handle_blob_created(
    subject: str,
    blob_service_client: BlobServiceClient,
) -> None:
    try:
        container, blob_name = parse_blob_subject(subject)
        blob_client = blob_service_client.get_blob_client(container, blob_name)
        properties = blob_client.get_blob_properties()
        downloader = blob_client.download_blob()
        downloader.readall()
        print(
            "Created blob "
            f"name={blob_name} size={properties.size} "
            f"content_type={properties.content_settings.content_type} "
            f"access_tier={properties.blob_tier}"
        )
    except ResourceNotFoundError:
        logger.warning("Blob disappeared before the create event was processed: %s", subject)
    except HttpResponseError as error:
        logger.warning("Blob could not be read after its tier or state changed: %s", error)


def handle_blob_deleted(subject: str) -> None:
    container, blob_name = parse_blob_subject(subject)
    logger.info("Deleted blob %s from container %s", blob_name, container)


async def handle_blob_created_async(
    subject: str,
    blob_service_client: AsyncBlobServiceClient,
) -> None:
    try:
        container, blob_name = parse_blob_subject(subject)
        blob_client = blob_service_client.get_blob_client(container, blob_name)
        properties = await blob_client.get_blob_properties()
        downloader = await blob_client.download_blob()
        await downloader.readall()
        print(
            "Created blob "
            f"name={blob_name} size={properties.size} "
            f"content_type={properties.content_settings.content_type} "
            f"access_tier={properties.blob_tier}"
        )
    except ResourceNotFoundError:
        logger.warning("Blob disappeared before the create event was processed: %s", subject)
    except HttpResponseError as error:
        logger.warning("Blob could not be read after its tier or state changed: %s", error)


async def handle_blob_deleted_async(subject: str) -> None:
    handle_blob_deleted(subject)
