from __future__ import annotations

import asyncio
import time

from configuration import AsyncConfigurationService, SyncConfigurationService


class SyncConfigurationWatcher:
    def __init__(self, service: SyncConfigurationService) -> None:
        self._service = service

    def watch(
        self,
        sentinels: list[str],
        interval: float,
        iterations: int = 1,
    ) -> None:
        for _ in range(iterations):
            for sentinel in sentinels:
                before = self._service.cached(sentinel)
                after = self._service.conditional_get(sentinel)
                if before is not None and (
                    after.etag != before.etag or after.value != before.value
                ):
                    self._service.refresh_all()
            time.sleep(interval)


class AsyncConfigurationWatcher:
    def __init__(self, service: AsyncConfigurationService) -> None:
        self._service = service

    async def watch(
        self,
        sentinels: list[str],
        interval: float,
        iterations: int = 1,
    ) -> None:
        for _ in range(iterations):
            for sentinel in sentinels:
                before = self._service.cached(sentinel)
                after = await self._service.conditional_get(sentinel)
                if before is not None and (
                    after.etag != before.etag or after.value != before.value
                ):
                    await self._service.refresh_all()
            await asyncio.sleep(interval)
