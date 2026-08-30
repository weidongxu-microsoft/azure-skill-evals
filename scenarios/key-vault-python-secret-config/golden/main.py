from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from cache import AsyncSecretCache, SecretCache
from config import create_async_client, create_sync_client
from provider import AsyncSecretProvider, SecretProvider
from rotation import rotate_secret, rotate_secret_async


CONFIG_KEYS = ["database-url", "api-key", "feature-toggle"]


def run_sync_demo() -> None:
    credential, client = create_sync_client()
    try:
        cache = SecretCache(SecretProvider(client), timedelta(days=7))
        cache.bulk_load(CONFIG_KEYS)
        print(cache.get("database-url", "missing"))
        cache.refresh("api-key")
        cache.refresh_expiring()
        rotate_secret(
            client,
            "api-key",
            "rotated-value",
            datetime.now(timezone.utc) + timedelta(days=90),
        )
    finally:
        client.close()
        credential.close()


async def run_async_demo() -> None:
    credential, client = create_async_client()
    async with credential, client:
        cache = AsyncSecretCache(AsyncSecretProvider(client), timedelta(days=7))
        await cache.bulk_load(CONFIG_KEYS)
        print(await cache.get("database-url", "missing"))
        await cache.refresh("api-key")
        await cache.refresh_expiring()
        await rotate_secret_async(
            client,
            "api-key",
            "rotated-value",
            datetime.now(timezone.utc) + timedelta(days=90),
        )


def main() -> None:
    run_sync_demo()
    asyncio.run(run_async_demo())


if __name__ == "__main__":
    main()
