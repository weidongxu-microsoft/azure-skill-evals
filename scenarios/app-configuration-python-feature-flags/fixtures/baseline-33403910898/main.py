"""Demonstrate synchronous and asynchronous Azure App Configuration access."""

from __future__ import annotations

import asyncio
import logging
import os
import time

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential

from config_watcher import AsyncConfigurationWatcher, ConfigurationWatcher
from configuration_service import AsyncConfigurationService, ConfigurationService
from feature_flags import AsyncFeatureFlagEvaluator, FeatureFlagEvaluator

USERS = ("alice", "bob", "charlie")


def _required_environment() -> tuple[str, str, str, float]:
    endpoint = os.environ.get("AZURE_APPCONFIG_ENDPOINT")
    if not endpoint:
        raise RuntimeError("Set AZURE_APPCONFIG_ENDPOINT before running the demo")
    label = os.environ.get("APP_ENVIRONMENT", "production")
    flag_name = os.environ.get("FEATURE_FLAG_NAME", "Beta")
    interval = float(os.environ.get("CONFIG_POLL_INTERVAL", "5"))
    return endpoint, label, flag_name, interval


def run_sync_demo(endpoint: str, label: str, flag_name: str, interval: float) -> None:
    print("\nSynchronous demo")
    credential = DefaultAzureCredential()
    try:
        with ConfigurationService(endpoint, credential) as configuration:
            print("Application name:", configuration.get_setting("app:name"))
            print(
                f"Message ({label}):",
                configuration.get_setting_with_label("app:message", label),
            )
            print("Application settings:", configuration.list_settings("app:", label))

            evaluator = FeatureFlagEvaluator(configuration)
            for user_id in USERS:
                enabled = evaluator.is_enabled(flag_name, user_id, label)
                print(f"{flag_name} for {user_id}: {enabled}")

            watcher = ConfigurationWatcher(
                configuration,
                [os.environ.get("CONFIG_SENTINEL_KEY", "app:sentinel")],
                interval,
                label=label,
                on_refresh=lambda: print("Sync configuration cache refreshed"),
            )
            print(f"Watching configuration for {interval:g} seconds...")
            watcher.start()
            time.sleep(interval)
            watcher.stop()
    finally:
        credential.close()


async def run_async_demo(
    endpoint: str, label: str, flag_name: str, interval: float
) -> None:
    print("\nAsynchronous demo")
    credential = AsyncDefaultAzureCredential()
    try:
        async with AsyncConfigurationService(endpoint, credential) as configuration:
            print("Application name:", await configuration.get_setting("app:name"))
            print(
                f"Message ({label}):",
                await configuration.get_setting_with_label("app:message", label),
            )
            print(
                "Application settings:",
                await configuration.list_settings("app:", label),
            )

            evaluator = AsyncFeatureFlagEvaluator(configuration)
            for user_id in USERS:
                enabled = await evaluator.is_enabled(flag_name, user_id, label)
                print(f"{flag_name} for {user_id}: {enabled}")

            watcher = AsyncConfigurationWatcher(
                configuration,
                [os.environ.get("CONFIG_SENTINEL_KEY", "app:sentinel")],
                interval,
                label=label,
                on_refresh=lambda: print("Async configuration cache refreshed"),
            )
            print(f"Watching configuration for {interval:g} seconds...")
            watcher.start()
            await asyncio.sleep(interval)
            await watcher.stop()
    finally:
        await credential.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    endpoint, label, flag_name, interval = _required_environment()
    run_sync_demo(endpoint, label, flag_name, interval)
    asyncio.run(run_async_demo(endpoint, label, flag_name, interval))


if __name__ == "__main__":
    main()
