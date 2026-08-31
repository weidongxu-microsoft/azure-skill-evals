from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from azure.core.exceptions import ResourceNotFoundError
from azure.keyvault.secrets import SecretClient
from azure.keyvault.secrets.aio import SecretClient as AsyncSecretClient


@dataclass(frozen=True)
class ConfigSecret:
    value: str
    expires_on: datetime | None


class SecretProvider:
    def __init__(self, client: SecretClient) -> None:
        self._client = client

    def get(
        self,
        name: str,
        default: str = "",
        version: str | None = None,
    ) -> ConfigSecret:
        try:
            secret = self._client.get_secret(name, version=version)
            return ConfigSecret(secret.value, secret.properties.expires_on)
        except ResourceNotFoundError:
            return ConfigSecret(default, None)


class AsyncSecretProvider:
    def __init__(self, client: AsyncSecretClient) -> None:
        self._client = client

    async def get(
        self,
        name: str,
        default: str = "",
        version: str | None = None,
    ) -> ConfigSecret:
        try:
            secret = await self._client.get_secret(name, version=version)
            return ConfigSecret(secret.value, secret.properties.expires_on)
        except ResourceNotFoundError:
            return ConfigSecret(default, None)
