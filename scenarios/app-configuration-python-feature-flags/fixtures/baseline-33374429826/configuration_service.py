"""Cached sync and async access to Azure App Configuration."""

from __future__ import annotations

import asyncio
from threading import RLock
from azure.appconfiguration import AzureAppConfigurationClient, ConfigurationSetting
from azure.appconfiguration.aio import AzureAppConfigurationClient as AsyncAzureAppConfigurationClient
from azure.core import MatchConditions
from azure.core.exceptions import HttpResponseError


CacheKey = tuple[str, str | None]
PrefixQuery = tuple[str, str | None]


class ConfigurationService:
    """Retrieve and cache settings with conditional ETag requests."""

    def __init__(self, client: AzureAppConfigurationClient) -> None:
        self._client = client
        self._settings: dict[CacheKey, ConfigurationSetting] = {}
        self._prefixes: dict[PrefixQuery, dict[str, str | None]] = {}
        self._all_values: dict[str, str | None] = {}
        self._lock = RLock()

    def get_setting(self, key: str, label: str | None = None) -> str | None:
        """Return one value, downloading it only if its ETag has changed."""
        return self._get_configuration_setting(key, label).value

    def _get_configuration_setting(
        self, key: str, label: str | None = None
    ) -> ConfigurationSetting:
        cache_key = (key, label)
        with self._lock:
            cached = self._settings.get(cache_key)
            if cached is None:
                setting = self._client.get_configuration_setting(key=key, label=label)
                if setting is None:
                    raise RuntimeError(
                        "App Configuration returned no setting for an unconditional read"
                    )
            else:
                try:
                    setting = self._client.get_configuration_setting(
                        key=key,
                        label=label,
                        etag=cached.etag,
                        match_condition=MatchConditions.IfModified,
                    )
                except HttpResponseError as error:
                    if error.status_code == 304:
                        return cached
                    raise
                if setting is None:
                    return cached

            self._settings[cache_key] = setting
            return setting

    def list_settings(
        self, prefix: str, label: str | None = None
    ) -> dict[str, str | None]:
        """Return settings whose keys begin with ``prefix`` as a dictionary."""
        query = (prefix, label)
        with self._lock:
            cached = self._prefixes.get(query)
            if cached is not None:
                return dict(cached)

            settings = self._client.list_configuration_settings(
                key_filter=f"{prefix}*", label_filter=label
            )
            result = {setting.key: setting.value for setting in settings}
            self._prefixes[query] = result
            return dict(result)

    def refresh_all(self) -> dict[str, str | None]:
        """Reload the complete store and atomically rebuild all local caches."""
        with self._lock:
            settings = list(
                self._client.list_configuration_settings(key_filter="*")
            )
            queries = tuple(self._prefixes)
            self._settings.clear()
            self._prefixes.clear()

            self._all_values = {
                setting.key: setting.value for setting in settings
            }
            for setting in settings:
                self._settings[(setting.key, setting.label)] = setting

            for prefix, label in queries:
                self._prefixes[(prefix, label)] = {
                    setting.key: setting.value
                    for setting in settings
                    if setting.key.startswith(prefix)
                    and (label is None or setting.label == label)
                }
            return dict(self._all_values)


class AsyncConfigurationService:
    """Async equivalent of :class:`ConfigurationService`."""

    def __init__(self, client: AsyncAzureAppConfigurationClient) -> None:
        self._client = client
        self._settings: dict[CacheKey, ConfigurationSetting] = {}
        self._prefixes: dict[PrefixQuery, dict[str, str | None]] = {}
        self._all_values: dict[str, str | None] = {}
        self._lock = asyncio.Lock()

    async def get_setting(
        self, key: str, label: str | None = None
    ) -> str | None:
        """Return one value, downloading it only if its ETag has changed."""
        setting = await self._get_configuration_setting(key, label)
        return setting.value

    async def _get_configuration_setting(
        self, key: str, label: str | None = None
    ) -> ConfigurationSetting:
        cache_key = (key, label)
        async with self._lock:
            cached = self._settings.get(cache_key)
            if cached is None:
                setting = await self._client.get_configuration_setting(
                    key=key, label=label
                )
                if setting is None:
                    raise RuntimeError(
                        "App Configuration returned no setting for an unconditional read"
                    )
            else:
                try:
                    setting = await self._client.get_configuration_setting(
                        key=key,
                        label=label,
                        etag=cached.etag,
                        match_condition=MatchConditions.IfModified,
                    )
                except HttpResponseError as error:
                    if error.status_code == 304:
                        return cached
                    raise
                if setting is None:
                    return cached

            self._settings[cache_key] = setting
            return setting

    async def list_settings(
        self, prefix: str, label: str | None = None
    ) -> dict[str, str | None]:
        """Return settings whose keys begin with ``prefix`` as a dictionary."""
        query = (prefix, label)
        async with self._lock:
            cached = self._prefixes.get(query)
            if cached is not None:
                return dict(cached)

            result: dict[str, str | None] = {}
            settings = self._client.list_configuration_settings(
                key_filter=f"{prefix}*", label_filter=label
            )
            result = {
                setting.key: setting.value async for setting in settings
            }
            self._prefixes[query] = result
            return dict(result)

    async def refresh_all(self) -> dict[str, str | None]:
        """Reload the complete store and atomically rebuild all local caches."""
        async with self._lock:
            settings = [
                setting
                async for setting in self._client.list_configuration_settings(
                    key_filter="*"
                )
            ]
            queries = tuple(self._prefixes)
            self._settings.clear()
            self._prefixes.clear()

            self._all_values = {
                setting.key: setting.value for setting in settings
            }
            for setting in settings:
                self._settings[(setting.key, setting.label)] = setting

            for prefix, label in queries:
                self._prefixes[(prefix, label)] = {
                    setting.key: setting.value
                    for setting in settings
                    if setting.key.startswith(prefix)
                    and (label is None or setting.label == label)
                }
            return dict(self._all_values)
