"""Azure Blob Storage client configuration."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from azure.core.pipeline.policies import RetryPolicy
from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient


def _positive_int(name: str, default: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value < 0:
        raise ValueError(f"{name} must be zero or greater")
    return value


def _positive_float(name: str, default: float) -> float:
    value = float(os.getenv(name, str(default)))
    if value < 0:
        raise ValueError(f"{name} must be zero or greater")
    return value


@dataclass(frozen=True)
class StorageSettings:
    """Configuration loaded from environment variables."""

    account_endpoint: str
    max_retries: int = 5
    retry_delay: float = 1.0
    retry_max_delay: float = 30.0
    http_log_level: str = "WARNING"

    @classmethod
    def from_environment(cls) -> "StorageSettings":
        endpoint = os.getenv("AZURE_STORAGE_ACCOUNT_ENDPOINT", "").strip()
        if not endpoint:
            raise ValueError(
                "AZURE_STORAGE_ACCOUNT_ENDPOINT is required "
                "(for example, https://myaccount.blob.core.windows.net)"
            )

        return cls(
            account_endpoint=endpoint.rstrip("/"),
            max_retries=_positive_int("AZURE_STORAGE_MAX_RETRIES", 5),
            retry_delay=_positive_float("AZURE_STORAGE_RETRY_DELAY", 1.0),
            retry_max_delay=_positive_float(
                "AZURE_STORAGE_RETRY_MAX_DELAY", 30.0
            ),
            http_log_level=os.getenv(
                "AZURE_STORAGE_HTTP_LOG_LEVEL", "WARNING"
            ).upper(),
        )


def _configure_http_logging(level_name: str) -> bool:
    if level_name == "OFF":
        logging.getLogger(
            "azure.core.pipeline.policies.http_logging_policy"
        ).disabled = True
        return False

    level = getattr(logging, level_name, None)
    if not isinstance(level, int):
        raise ValueError(
            "AZURE_STORAGE_HTTP_LOG_LEVEL must be OFF, DEBUG, INFO, "
            "WARNING, ERROR, or CRITICAL"
        )

    logger = logging.getLogger("azure.core.pipeline.policies.http_logging_policy")
    logger.disabled = False
    logger.setLevel(level)
    return True


def _retry_policy(settings: StorageSettings) -> RetryPolicy:
    return RetryPolicy(
        retry_total=settings.max_retries,
        retry_connect=settings.max_retries,
        retry_read=settings.max_retries,
        retry_status=settings.max_retries,
        retry_backoff_factor=settings.retry_delay,
        retry_backoff_max=settings.retry_max_delay,
    )


def create_blob_service_client(
    settings: StorageSettings | None = None,
) -> tuple[BlobServiceClient, DefaultAzureCredential]:
    """Create a synchronous client authenticated without shared secrets."""

    settings = settings or StorageSettings.from_environment()
    logging_enabled = _configure_http_logging(settings.http_log_level)
    credential = DefaultAzureCredential()
    client = BlobServiceClient(
        account_url=settings.account_endpoint,
        credential=credential,
        retry_policy=_retry_policy(settings),
        logging_enable=logging_enabled,
    )
    return client, credential


def create_async_blob_service_client(
    settings: StorageSettings | None = None,
) -> tuple[AsyncBlobServiceClient, AsyncDefaultAzureCredential]:
    """Create an asynchronous client authenticated without shared secrets."""

    settings = settings or StorageSettings.from_environment()
    logging_enabled = _configure_http_logging(settings.http_log_level)
    credential = AsyncDefaultAzureCredential()
    client = AsyncBlobServiceClient(
        account_url=settings.account_endpoint,
        credential=credential,
        retry_policy=_retry_policy(settings),
        logging_enable=logging_enabled,
    )
    return client, credential
