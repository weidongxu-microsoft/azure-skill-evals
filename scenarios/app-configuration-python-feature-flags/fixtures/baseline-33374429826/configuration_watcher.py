"""Sentinel-based configuration watchers."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Sequence
from threading import Event, Thread

from azure.appconfiguration import AzureAppConfigurationClient, ConfigurationSetting
from azure.appconfiguration.aio import AzureAppConfigurationClient as AsyncAzureAppConfigurationClient
from azure.core import MatchConditions
from azure.core.exceptions import AzureError
from azure.core.exceptions import HttpResponseError

from configuration_service import AsyncConfigurationService, ConfigurationService


logger = logging.getLogger(__name__)


class ConfigurationWatcher:
    """Poll sentinel keys and refresh all cached configuration after a change."""

    def __init__(
        self,
        client: AzureAppConfigurationClient,
        configuration: ConfigurationService,
        sentinel_keys: Sequence[str],
        polling_interval: float,
        on_refresh: Callable[[], None] | None = None,
    ) -> None:
        if not sentinel_keys:
            raise ValueError("At least one sentinel key is required")
        if polling_interval <= 0:
            raise ValueError("Polling interval must be greater than zero")
        self._client = client
        self._configuration = configuration
        self._sentinel_keys = tuple(sentinel_keys)
        self._polling_interval = polling_interval
        self._on_refresh = on_refresh
        self._sentinel_settings: dict[str, ConfigurationSetting] = {}
        self._stop = Event()
        self._thread: Thread | None = None

    def run(
        self,
        client: AzureAppConfigurationClient,
        configuration: ConfigurationService,
        sentinel_keys: Sequence[str],
        polling_interval: float,
        max_polls: int | None = None,
    ) -> None:
        polls = 0
        while sentinel_keys and not self._stop.is_set():
            try:
                refreshed = False
                for key in sentinel_keys:
                    cached = self._sentinel_settings.get(key)
                    if cached is None:
                        setting = client.get_configuration_setting(key=key)
                        if setting is None:
                            raise RuntimeError(
                                "App Configuration returned no sentinel for an "
                                "unconditional read"
                            )
                    else:
                        try:
                            setting = client.get_configuration_setting(
                                key=key,
                                etag=cached.etag,
                                match_condition=MatchConditions.IfModified,
                            )
                        except HttpResponseError as error:
                            if error.status_code == 304:
                                continue
                            raise
                        if setting is None:
                            continue
                    if (
                        not refreshed
                        and cached is not None
                        and cached.value != setting.value
                    ):
                        configuration.refresh_all()
                        refreshed = True
                        if self._on_refresh is not None:
                            self._on_refresh()
                    self._sentinel_settings[key] = setting
            except AzureError:
                logger.exception("Failed to poll App Configuration sentinels")
            polls += 1
            if max_polls is not None and polls >= max_polls:
                break
            if not self._stop.is_set():
                time.sleep(polling_interval)

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            raise RuntimeError("Configuration watcher is already running")
        self._stop.clear()
        self._thread = Thread(
            target=self.run,
            args=(
                self._client,
                self._configuration,
                self._sentinel_keys,
                self._polling_interval,
            ),
            name="app-configuration-watcher",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None


class AsyncConfigurationWatcher:
    """Async sentinel watcher with the same refresh behavior."""

    def __init__(
        self,
        client: AsyncAzureAppConfigurationClient,
        configuration: AsyncConfigurationService,
        sentinel_keys: Sequence[str],
        polling_interval: float,
        on_refresh: Callable[[], None] | None = None,
    ) -> None:
        if not sentinel_keys:
            raise ValueError("At least one sentinel key is required")
        if polling_interval <= 0:
            raise ValueError("Polling interval must be greater than zero")
        self._client = client
        self._configuration = configuration
        self._sentinel_keys = tuple(sentinel_keys)
        self._polling_interval = polling_interval
        self._on_refresh = on_refresh
        self._sentinel_settings: dict[str, ConfigurationSetting] = {}
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def run(
        self,
        client: AsyncAzureAppConfigurationClient,
        configuration: AsyncConfigurationService,
        sentinel_keys: Sequence[str],
        polling_interval: float,
        max_polls: int | None = None,
    ) -> None:
        polls = 0
        while sentinel_keys and not self._stop.is_set():
            try:
                refreshed = False
                for key in sentinel_keys:
                    cached = self._sentinel_settings.get(key)
                    if cached is None:
                        setting = await client.get_configuration_setting(key=key)
                        if setting is None:
                            raise RuntimeError(
                                "App Configuration returned no sentinel for an "
                                "unconditional read"
                            )
                    else:
                        try:
                            setting = await client.get_configuration_setting(
                                key=key,
                                etag=cached.etag,
                                match_condition=MatchConditions.IfModified,
                            )
                        except HttpResponseError as error:
                            if error.status_code == 304:
                                continue
                            raise
                        if setting is None:
                            continue
                    if (
                        not refreshed
                        and cached is not None
                        and cached.value != setting.value
                    ):
                        await configuration.refresh_all()
                        refreshed = True
                        if self._on_refresh is not None:
                            self._on_refresh()
                    self._sentinel_settings[key] = setting
            except AzureError:
                logger.exception("Failed to poll App Configuration sentinels")
            polls += 1
            if max_polls is not None and polls >= max_polls:
                break
            await asyncio.sleep(polling_interval)

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            raise RuntimeError("Configuration watcher is already running")
        self._stop.clear()
        self._task = asyncio.create_task(
            self.run(
                self._client,
                self._configuration,
                self._sentinel_keys,
                self._polling_interval,
            )
        )

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await self._task
            self._task = None
