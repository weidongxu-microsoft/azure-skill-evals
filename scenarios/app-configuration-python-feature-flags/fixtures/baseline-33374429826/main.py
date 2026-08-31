"""Run synchronous and asynchronous Azure App Configuration demos."""

from __future__ import annotations

import asyncio
import logging
import os

from azure.appconfiguration import AzureAppConfigurationClient
from azure.appconfiguration.aio import AzureAppConfigurationClient as AsyncAzureAppConfigurationClient
from azure.core.exceptions import AzureError
from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

from configuration_service import AsyncConfigurationService, ConfigurationService
from configuration_watcher import (
    AsyncConfigurationWatcher,
    ConfigurationWatcher,
)
from feature_flags import AsyncFeatureFlagEvaluator, FeatureFlagEvaluator


POLLING_INTERVAL_SECONDS = 5.0
SAMPLE_USERS = ("alice", "bob", "carol")


def run_sync_demo(endpoint: str) -> None:
    print("Running synchronous demo")
    credential = DefaultAzureCredential()
    try:
        with AzureAppConfigurationClient(
            base_url=endpoint, credential=credential
        ) as client:
            configuration = ConfigurationService(client)
            flags = FeatureFlagEvaluator(client)

            print("Application:Name =", configuration.get_setting("Application:Name"))
            print(
                "production Application:Region =",
                configuration.get_setting("Application:Region", label="production"),
            )
            print("Application settings =", configuration.list_settings("Application:"))
            for user_id in SAMPLE_USERS:
                enabled = flags.is_enabled(
                    "BetaCheckout", user_id=user_id, label="production"
                )
                print(f"BetaCheckout for {user_id}: {enabled}")

            watcher = ConfigurationWatcher(
                client,
                configuration,
                sentinel_keys=["Sentinel"],
                polling_interval=POLLING_INTERVAL_SECONDS,
                on_refresh=lambda: print("Sync configuration cache refreshed"),
            )
            print("Sync watcher started for two polls")
            watcher.run(
                client=client,
                configuration=configuration,
                sentinel_keys=["Sentinel"],
                polling_interval=POLLING_INTERVAL_SECONDS,
                max_polls=2,
            )
    finally:
        credential.close()


async def run_async_demo(endpoint: str) -> None:
    print("Running asynchronous demo")
    async with AsyncDefaultAzureCredential() as credential:
        async with AsyncAzureAppConfigurationClient(
            base_url=endpoint, credential=credential
        ) as client:
            configuration = AsyncConfigurationService(client)
            flags = AsyncFeatureFlagEvaluator(client)

            print(
                "Application:Name =",
                await configuration.get_setting("Application:Name"),
            )
            print(
                "staging Application:Region =",
                await configuration.get_setting(
                    "Application:Region", label="staging"
                ),
            )
            print(
                "Application settings =",
                await configuration.list_settings("Application:"),
            )
            for user_id in SAMPLE_USERS:
                enabled = await flags.is_enabled(
                    "BetaCheckout", user_id=user_id, label="staging"
                )
                print(f"BetaCheckout for {user_id}: {enabled}")

            watcher = AsyncConfigurationWatcher(
                client,
                configuration,
                sentinel_keys=["Sentinel"],
                polling_interval=POLLING_INTERVAL_SECONDS,
                on_refresh=lambda: print("Async configuration cache refreshed"),
            )
            print("Async watcher started for two polls")
            await watcher.run(
                client=client,
                configuration=configuration,
                sentinel_keys=["Sentinel"],
                polling_interval=POLLING_INTERVAL_SECONDS,
                max_polls=2,
            )


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    try:
        endpoint = os.environ["AZURE_APPCONFIG_ENDPOINT"]
    except KeyError as error:
        raise RuntimeError(
            "Set AZURE_APPCONFIG_ENDPOINT to your store endpoint"
        ) from error

    try:
        run_sync_demo(endpoint)
        asyncio.run(run_async_demo(endpoint))
    except AzureError:
        logging.exception("Azure App Configuration demo failed")
        raise


if __name__ == "__main__":
    main()
