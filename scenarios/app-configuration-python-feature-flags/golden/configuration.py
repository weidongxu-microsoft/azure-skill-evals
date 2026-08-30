from __future__ import annotations

from azure.appconfiguration import AzureAppConfigurationClient, ConfigurationSetting
from azure.appconfiguration.aio import (
    AzureAppConfigurationClient as AsyncAzureAppConfigurationClient,
)
from azure.core import MatchConditions
from azure.core.exceptions import HttpResponseError


class SyncConfigurationService:
    def __init__(self, client: AzureAppConfigurationClient) -> None:
        self._client = client
        self._cache: dict[tuple[str, str | None], ConfigurationSetting] = {}

    def get(self, key: str) -> ConfigurationSetting:
        setting = self._client.get_configuration_setting(key=key)
        self._cache[(key, None)] = setting
        return setting

    def get_labeled(self, key: str, label: str) -> ConfigurationSetting:
        setting = self._client.get_configuration_setting(key=key, label=label)
        self._cache[(key, label)] = setting
        return setting

    def list_prefix(self, prefix: str) -> dict[str, str | None]:
        return {
            setting.key: setting.value
            for setting in self._client.list_configuration_settings(
                key_filter=f"{prefix}*"
            )
        }

    def cached(self, key: str, label: str | None = None) -> ConfigurationSetting | None:
        return self._cache.get((key, label))

    def conditional_get(
        self,
        key: str,
        label: str | None = None,
    ) -> ConfigurationSetting:
        cached = self.cached(key, label)
        if cached is None:
            return self.get_labeled(key, label) if label else self.get(key)
        try:
            updated = self._client.get_configuration_setting(
                key=key,
                label=label,
                etag=cached.etag,
                match_condition=MatchConditions.IfModified,
            )
        except HttpResponseError as error:
            if error.status_code == 304:
                return cached
            raise
        self._cache[(key, label)] = updated
        return updated

    def refresh_all(self, prefix: str = "") -> dict[str, str | None]:
        settings = list(
            self._client.list_configuration_settings(key_filter=f"{prefix}*")
        )
        self._cache = {
            (setting.key, setting.label): setting for setting in settings
        }
        return {setting.key: setting.value for setting in settings}


class AsyncConfigurationService:
    def __init__(self, client: AsyncAzureAppConfigurationClient) -> None:
        self._client = client
        self._cache: dict[tuple[str, str | None], ConfigurationSetting] = {}

    async def get(self, key: str) -> ConfigurationSetting:
        setting = await self._client.get_configuration_setting(key=key)
        self._cache[(key, None)] = setting
        return setting

    async def get_labeled(self, key: str, label: str) -> ConfigurationSetting:
        setting = await self._client.get_configuration_setting(key=key, label=label)
        self._cache[(key, label)] = setting
        return setting

    async def list_prefix(self, prefix: str) -> dict[str, str | None]:
        settings = self._client.list_configuration_settings(
            key_filter=f"{prefix}*"
        )
        return {setting.key: setting.value async for setting in settings}

    def cached(self, key: str, label: str | None = None) -> ConfigurationSetting | None:
        return self._cache.get((key, label))

    async def conditional_get(
        self,
        key: str,
        label: str | None = None,
    ) -> ConfigurationSetting:
        cached = self.cached(key, label)
        if cached is None:
            return await self.get_labeled(key, label) if label else await self.get(key)
        try:
            updated = await self._client.get_configuration_setting(
                key=key,
                label=label,
                etag=cached.etag,
                match_condition=MatchConditions.IfModified,
            )
        except HttpResponseError as error:
            if error.status_code == 304:
                return cached
            raise
        self._cache[(key, label)] = updated
        return updated

    async def refresh_all(self, prefix: str = "") -> dict[str, str | None]:
        results = self._client.list_configuration_settings(
            key_filter=f"{prefix}*"
        )
        settings = [setting async for setting in results]
        self._cache = {
            (setting.key, setting.label): setting for setting in settings
        }
        return {setting.key: setting.value for setting in settings}
