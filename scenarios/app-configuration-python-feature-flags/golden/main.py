from __future__ import annotations

import asyncio
import os

from azure.appconfiguration import AzureAppConfigurationClient
from azure.appconfiguration.aio import (
    AzureAppConfigurationClient as AsyncAzureAppConfigurationClient,
)
from azure.core.exceptions import HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

from configuration import AsyncConfigurationService, SyncConfigurationService
from feature_flags import AsyncFeatureFlagEvaluator, SyncFeatureFlagEvaluator
from watcher import AsyncConfigurationWatcher, SyncConfigurationWatcher


def run_sync_demo(endpoint: str) -> None:
    credential = DefaultAzureCredential()
    try:
        with AzureAppConfigurationClient(
            base_url=endpoint,
            credential=credential,
        ) as client:
            service = SyncConfigurationService(client)
            print(service.get("app:message").value)
            print(service.get_labeled("app:message", "Production").value)
            print(service.list_prefix("app:"))

            evaluator = SyncFeatureFlagEvaluator(client)
            for user_id in ("alice", "bob", "carol"):
                print(user_id, evaluator.is_enabled("BetaCheckout", user_id))

            service.get("app:sentinel")
            watcher = SyncConfigurationWatcher(service)
            watcher.watch(["app:sentinel"], interval=1.0)
    except HttpResponseError:
        raise
    finally:
        credential.close()


async def run_async_demo(endpoint: str) -> None:
    credential = AsyncDefaultAzureCredential()
    try:
        async with credential:
            async with AsyncAzureAppConfigurationClient(
                base_url=endpoint,
                credential=credential,
            ) as client:
                service = AsyncConfigurationService(client)
                print((await service.get("app:message")).value)
                print(
                    (
                        await service.get_labeled("app:message", "Production")
                    ).value
                )
                print(await service.list_prefix("app:"))

                evaluator = AsyncFeatureFlagEvaluator(client)
                for user_id in ("alice", "bob", "carol"):
                    enabled = await evaluator.is_enabled(
                        "BetaCheckout",
                        user_id,
                    )
                    print(user_id, enabled)

                await service.get("app:sentinel")
                watcher = AsyncConfigurationWatcher(service)
                await watcher.watch(["app:sentinel"], interval=1.0)
    except HttpResponseError:
        raise


def main() -> None:
    endpoint = os.environ["AZURE_APPCONFIGURATION_ENDPOINT"]
    run_sync_demo(endpoint)
    asyncio.run(run_async_demo(endpoint))


if __name__ == "__main__":
    main()
