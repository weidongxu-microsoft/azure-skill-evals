"""Cached sync and async access to Azure App Configuration."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from threading import RLock
from typing import Any

from azure.appconfiguration import AzureAppConfigurationClient
from azure.appconfiguration.aio import AzureAppConfigurationClient as AsyncAzureAppConfigurationClient
from azure.core import MatchConditions
from azure.core.exceptions import ResourceNotFoundError, ResourceNotModifiedError
from azure.core.credentials import TokenCredential
from azure.core.credentials_async import AsyncTokenCredential


@dataclass(frozen=True)
class _CachedSetting:
    value: str | None
    etag: Any


class ConfigurationService:
    """Synchronous configuration service with conditional-request caching."""

    def __init__(self, endpoint: str, credential: TokenCredential) -> None:
        self._client = AzureAppConfigurationClient(endpoint, credential)
        self._settings: dict[tuple[str, str | None], _CachedSetting] = {}
        self._prefixes: dict[tuple[str, str | None], dict[str, str | None]] = {}
        self._lock = RLock()

    def get_setting(
        self, key: str, label: str | None = None, *, force: bool = False
    ) -> str | None:
        cache_key = (key, label)
        with self._lock:
            cached = self._settings.get(cache_key)

        request: dict[str, Any] = {"key": key, "label": label}
        if cached is not None and not force and cached.etag is not None:
            request.update(
                etag=cached.etag,
                match_condition=MatchConditions.IfModified,
            )

        try:
            setting = self._client.get_configuration_setting(**request)
        except ResourceNotModifiedError:
            if cached is None:
                raise
            return cached.value
        except ResourceNotFoundError:
            with self._lock:
                self._settings.pop(cache_key, None)
            raise

        if setting is None:
            if cached is None:
                raise RuntimeError("App Configuration returned no setting without a cache entry")
            return cached.value
        entry = _CachedSetting(setting.value, setting.etag)
        with self._lock:
            self._settings[cache_key] = entry
        return entry.value

    def get_setting_with_label(self, key: str, label: str) -> str | None:
        return self.get_setting(key, label)

    def list_settings(
        self, key_prefix: str, label: str | None = None, *, force: bool = False
    ) -> dict[str, str | None]:
        cache_key = (key_prefix, label)
        with self._lock:
            if not force and cache_key in self._prefixes:
                return dict(self._prefixes[cache_key])

        settings = {
            setting.key: setting.value
            for setting in self._client.list_configuration_settings(
                key_filter=f"{key_prefix}*",
                label_filter=label,
            )
        }
        with self._lock:
            self._prefixes[cache_key] = settings
        return dict(settings)

    def refresh_all(self) -> None:
        """Re-fetch every setting and prefix query currently held in the cache."""
        with self._lock:
            setting_keys = tuple(self._settings)
            prefix_keys = tuple(self._prefixes)

        for key, label in setting_keys:
            try:
                self.get_setting(key, label, force=True)
            except ResourceNotFoundError:
                pass
        for prefix, label in prefix_keys:
            self.list_settings(prefix, label, force=True)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> ConfigurationService:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class AsyncConfigurationService:
    """Asynchronous configuration service with conditional-request caching."""

    def __init__(self, endpoint: str, credential: AsyncTokenCredential) -> None:
        self._client = AsyncAzureAppConfigurationClient(endpoint, credential)
        self._settings: dict[tuple[str, str | None], _CachedSetting] = {}
        self._prefixes: dict[tuple[str, str | None], dict[str, str | None]] = {}
        self._lock = asyncio.Lock()

    async def get_setting(
        self, key: str, label: str | None = None, *, force: bool = False
    ) -> str | None:
        cache_key = (key, label)
        async with self._lock:
            cached = self._settings.get(cache_key)

        request: dict[str, Any] = {"key": key, "label": label}
        if cached is not None and not force and cached.etag is not None:
            request.update(
                etag=cached.etag,
                match_condition=MatchConditions.IfModified,
            )

        try:
            setting = await self._client.get_configuration_setting(**request)
        except ResourceNotModifiedError:
            if cached is None:
                raise
            return cached.value
        except ResourceNotFoundError:
            async with self._lock:
                self._settings.pop(cache_key, None)
            raise

        if setting is None:
            if cached is None:
                raise RuntimeError("App Configuration returned no setting without a cache entry")
            return cached.value
        entry = _CachedSetting(setting.value, setting.etag)
        async with self._lock:
            self._settings[cache_key] = entry
        return entry.value

    async def get_setting_with_label(self, key: str, label: str) -> str | None:
        return await self.get_setting(key, label)

    async def list_settings(
        self, key_prefix: str, label: str | None = None, *, force: bool = False
    ) -> dict[str, str | None]:
        cache_key = (key_prefix, label)
        async with self._lock:
            cached = self._prefixes.get(cache_key)
            if not force and cached is not None:
                return dict(cached)

        settings: dict[str, str | None] = {}
        pager = self._client.list_configuration_settings(
            key_filter=f"{key_prefix}*",
            label_filter=label,
        )
        async for setting in pager:
            settings[setting.key] = setting.value

        async with self._lock:
            self._prefixes[cache_key] = settings
        return dict(settings)

    async def refresh_all(self) -> None:
        """Re-fetch every setting and prefix query currently held in the cache."""
        async with self._lock:
            setting_keys = tuple(self._settings)
            prefix_keys = tuple(self._prefixes)

        for key, label in setting_keys:
            try:
                await self.get_setting(key, label, force=True)
            except ResourceNotFoundError:
                pass
        for prefix, label in prefix_keys:
            await self.list_settings(prefix, label, force=True)

    async def close(self) -> None:
        await self._client.close()

    async def __aenter__(self) -> AsyncConfigurationService:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()
