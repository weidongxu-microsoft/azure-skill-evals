from __future__ import annotations

import logging
import os

from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient


class StorageSettings:
    def __init__(
        self,
        *,
        account_url: str,
        container_name: str,
        blob_name: str,
        source_path: str,
        sync_download_path: str,
        async_download_path: str,
        retry_total: int,
        retry_delay: int,
        http_log_level: int,
    ) -> None:
        self.account_url = account_url
        self.container_name = container_name
        self.blob_name = blob_name
        self.source_path = source_path
        self.sync_download_path = sync_download_path
        self.async_download_path = async_download_path
        self.retry_total = retry_total
        self.retry_delay = retry_delay
        self.http_log_level = http_log_level


def load_settings() -> StorageSettings:
    log_level_name = os.environ.get("AZURE_HTTP_LOG_LEVEL", "INFO").upper()
    return StorageSettings(
        account_url=os.environ["AZURE_STORAGE_ACCOUNT_URL"],
        container_name=os.environ.get("AZURE_STORAGE_CONTAINER_NAME", "samples"),
        blob_name=os.environ.get("AZURE_STORAGE_BLOB_NAME", "demo/sample.txt"),
        source_path="sample-upload.txt",
        sync_download_path="sample-download-sync.txt",
        async_download_path="sample-download-async.txt",
        retry_total=int(os.environ.get("AZURE_STORAGE_RETRY_TOTAL", "5")),
        retry_delay=int(os.environ.get("AZURE_STORAGE_RETRY_DELAY", "3")),
        http_log_level=getattr(logging, log_level_name, logging.INFO),
    )


def configure_http_logging(settings: StorageSettings) -> None:
    logging.basicConfig(level=settings.http_log_level)
    logging.getLogger(
        "azure.core.pipeline.policies.http_logging_policy"
    ).setLevel(settings.http_log_level)


def create_sync_blob_service_client(
    settings: StorageSettings,
    credential,
) -> BlobServiceClient:
    configure_http_logging(settings)
    return BlobServiceClient(
        account_url=settings.account_url,
        credential=credential,
        retry_total=settings.retry_total,
        retry_mode="exponential",
        retry_backoff_factor=settings.retry_delay,
        logging_enable=True,
    )


def create_async_blob_service_client(
    settings: StorageSettings,
    credential: AsyncDefaultAzureCredential,
) -> AsyncBlobServiceClient:
    configure_http_logging(settings)
    return AsyncBlobServiceClient(
        account_url=settings.account_url,
        credential=credential,
        retry_total=settings.retry_total,
        retry_mode="exponential",
        retry_backoff_factor=settings.retry_delay,
        logging_enable=True,
    )
