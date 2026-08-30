from __future__ import annotations

from datetime import datetime, timedelta, timezone

from provider import AsyncSecretProvider, ConfigSecret, SecretProvider


class SecretCache:
    def __init__(self, provider: SecretProvider, warning_window: timedelta) -> None:
        self._provider = provider
        self._warning_window = warning_window
        self._values: dict[str, ConfigSecret] = {}

    def bulk_load(self, names: list[str]) -> None:
        for name in names:
            self.refresh(name)

    def get(self, name: str, default: str = "") -> str:
        if name not in self._values:
            self.refresh(name, default)
        return self._values[name].value

    def refresh(self, name: str, default: str = "") -> ConfigSecret:
        self._values[name] = self._provider.get(name, default)
        return self._values[name]

    def refresh_expiring(self) -> list[str]:
        deadline = datetime.now(timezone.utc) + self._warning_window
        expiring = [
            name
            for name, secret in self._values.items()
            if secret.expires_on is not None and secret.expires_on <= deadline
        ]
        for name in expiring:
            print(f"Warning: {name} expires soon")
            self.refresh(name)
        return expiring


class AsyncSecretCache:
    def __init__(
        self,
        provider: AsyncSecretProvider,
        warning_window: timedelta,
    ) -> None:
        self._provider = provider
        self._warning_window = warning_window
        self._values: dict[str, ConfigSecret] = {}

    async def bulk_load(self, names: list[str]) -> None:
        for name in names:
            await self.refresh(name)

    async def get(self, name: str, default: str = "") -> str:
        if name not in self._values:
            await self.refresh(name, default)
        return self._values[name].value

    async def refresh(self, name: str, default: str = "") -> ConfigSecret:
        self._values[name] = await self._provider.get(name, default)
        return self._values[name]

    async def refresh_expiring(self) -> list[str]:
        deadline = datetime.now(timezone.utc) + self._warning_window
        expiring = [
            name
            for name, secret in self._values.items()
            if secret.expires_on is not None and secret.expires_on <= deadline
        ]
        for name in expiring:
            print(f"Warning: {name} expires soon")
            await self.refresh(name)
        return expiring
