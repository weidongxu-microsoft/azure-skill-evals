from __future__ import annotations

import asyncio
import time
from datetime import datetime

from azure.core.exceptions import ResourceNotFoundError
from azure.keyvault.secrets import SecretClient
from azure.keyvault.secrets.aio import SecretClient as AsyncSecretClient


def _wait_until_purged(
    client: SecretClient,
    name: str,
    *,
    timeout: float = 120,
    poll_interval: float = 1,
) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            client.get_deleted_secret(name)
        except ResourceNotFoundError:
            return
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Timed out waiting for secret {name!r} to be purged")
        time.sleep(poll_interval)


def rotate_secret(
    client: SecretClient,
    name: str,
    value: str,
    expires_on: datetime,
) -> None:
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)
    _wait_until_purged(client, name)
    client.set_secret(name, value, expires_on=expires_on)


async def _wait_until_purged_async(
    client: AsyncSecretClient,
    name: str,
    *,
    timeout: float = 120,
    poll_interval: float = 1,
) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        try:
            await client.get_deleted_secret(name)
        except ResourceNotFoundError:
            return
        if loop.time() >= deadline:
            raise TimeoutError(f"Timed out waiting for secret {name!r} to be purged")
        await asyncio.sleep(poll_interval)


async def rotate_secret_async(
    client: AsyncSecretClient,
    name: str,
    value: str,
    expires_on: datetime,
) -> None:
    await client.delete_secret(name)
    await client.purge_deleted_secret(name)
    await _wait_until_purged_async(client, name)
    await client.set_secret(name, value, expires_on=expires_on)
