"""Sentinel-based configuration watchers."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from threading import Event, Thread

from configuration_service import AsyncConfigurationService, ConfigurationService

LOGGER = logging.getLogger(__name__)


class ConfigurationWatcher:
    def __init__(
        self,
        configuration: ConfigurationService,
        sentinel_keys: Sequence[str],
        polling_interval: float,
        *,
        label: str | None = None,
        on_refresh: Callable[[], None] | None = None,
    ) -> None:
        if polling_interval <= 0:
            raise ValueError("polling_interval must be greater than zero")
        if not sentinel_keys:
            raise ValueError("at least one sentinel key is required")
        self._configuration = configuration
        self._sentinel_keys = tuple(sentinel_keys)
        self._polling_interval = polling_interval
        self._label = label
        self._on_refresh = on_refresh
        self._values: dict[str, str | None] = {}
        self._stop = Event()
        self._thread: Thread | None = None

    def poll_once(self) -> bool:
        current = {
            key: self._configuration.get_setting(key, self._label)
            for key in self._sentinel_keys
        }
        changed = bool(self._values) and current != self._values
        self._values = current
        if changed:
            self._configuration.refresh_all()
            if self._on_refresh is not None:
                self._on_refresh()
        return changed

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = Thread(target=self._run, name="app-config-watcher", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.poll_once()
            except Exception:
                LOGGER.exception("Configuration sentinel polling failed")
            self._stop.wait(self._polling_interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None


class AsyncConfigurationWatcher:
    def __init__(
        self,
        configuration: AsyncConfigurationService,
        sentinel_keys: Sequence[str],
        polling_interval: float,
        *,
        label: str | None = None,
        on_refresh: Callable[[], None] | None = None,
    ) -> None:
        if polling_interval <= 0:
            raise ValueError("polling_interval must be greater than zero")
        if not sentinel_keys:
            raise ValueError("at least one sentinel key is required")
        self._configuration = configuration
        self._sentinel_keys = tuple(sentinel_keys)
        self._polling_interval = polling_interval
        self._label = label
        self._on_refresh = on_refresh
        self._values: dict[str, str | None] = {}
        self._task: asyncio.Task[None] | None = None

    async def poll_once(self) -> bool:
        current = {
            key: await self._configuration.get_setting(key, self._label)
            for key in self._sentinel_keys
        }
        changed = bool(self._values) and current != self._values
        self._values = current
        if changed:
            await self._configuration.refresh_all()
            if self._on_refresh is not None:
                self._on_refresh()
        return changed

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._run(), name="app-config-watcher")

    async def _run(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOGGER.exception("Configuration sentinel polling failed")
            await asyncio.sleep(self._polling_interval)

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
