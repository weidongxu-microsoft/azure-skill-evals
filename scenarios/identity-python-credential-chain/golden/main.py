from __future__ import annotations

import asyncio
import os

from connectivity_tester import test_async, test_sync
from credential_factory import (
    build_async_credential,
    build_sync_credential,
    strategy_for,
)
from environment_detector import detect_environment


async def run() -> int:
    environment = detect_environment()
    print(f"Detected environment: {environment}")
    print(f"Selected strategy: {strategy_for(environment)}")

    sync_credential = build_sync_credential(environment)
    async_credential = build_async_credential(environment)
    with sync_credential:
        async with async_credential:
            if os.getenv("CREDENTIAL_CHAIN_DRY_RUN") == "1":
                return 0
            sync_succeeded = test_sync(sync_credential)
            async_succeeded = await test_async(async_credential)
            return 0 if sync_succeeded and async_succeeded else 1


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
