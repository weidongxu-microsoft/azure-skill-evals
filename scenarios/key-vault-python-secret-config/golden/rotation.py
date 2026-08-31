from __future__ import annotations

from datetime import datetime

from azure.keyvault.secrets import SecretClient
from azure.keyvault.secrets.aio import SecretClient as AsyncSecretClient


def rotate_secret(
    client: SecretClient,
    name: str,
    value: str,
    expires_on: datetime,
) -> None:
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)
    client.set_secret(name, value, expires_on=expires_on)


async def rotate_secret_async(
    client: AsyncSecretClient,
    name: str,
    value: str,
    expires_on: datetime,
) -> None:
    poller = await client.begin_delete_secret(name)
    await poller.wait()
    await client.purge_deleted_secret(name)
    await client.set_secret(name, value, expires_on=expires_on)
