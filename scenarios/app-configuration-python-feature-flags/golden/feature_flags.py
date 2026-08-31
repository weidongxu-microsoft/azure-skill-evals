from __future__ import annotations

import hashlib
import json
from typing import Any

from azure.appconfiguration import AzureAppConfigurationClient
from azure.appconfiguration.aio import (
    AzureAppConfigurationClient as AsyncAzureAppConfigurationClient,
)

FEATURE_FLAG_PREFIX = ".appconfig.featureflag/"


def deterministic_percentage(
    flag_id: str,
    user_id: str,
    percentage: float,
) -> bool:
    digest = hashlib.sha256(f"{flag_id}:{user_id}".encode()).digest()
    bucket = int.from_bytes(digest[:8], "big") % 100
    return bucket < percentage


def percentage_from_payload(payload: dict[str, Any]) -> float | None:
    conditions = payload.get("conditions", {})
    for client_filter in conditions.get("client_filters", []):
        if client_filter.get("name") == "Microsoft.Percentage":
            return float(client_filter.get("parameters", {}).get("Value", 0))
    return None


class SyncFeatureFlagEvaluator:
    def __init__(self, client: AzureAppConfigurationClient) -> None:
        self._client = client

    def is_enabled(self, flag_id: str, user_id: str) -> bool:
        setting = self._client.get_configuration_setting(
            key=f"{FEATURE_FLAG_PREFIX}{flag_id}"
        )
        payload = json.loads(setting.value)
        if not payload.get("enabled", False):
            return False
        percentage = percentage_from_payload(payload)
        return (
            True
            if percentage is None
            else deterministic_percentage(flag_id, user_id, percentage)
        )


class AsyncFeatureFlagEvaluator:
    def __init__(self, client: AsyncAzureAppConfigurationClient) -> None:
        self._client = client

    async def is_enabled(self, flag_id: str, user_id: str) -> bool:
        setting = await self._client.get_configuration_setting(
            key=f"{FEATURE_FLAG_PREFIX}{flag_id}"
        )
        payload = json.loads(setting.value)
        if not payload.get("enabled", False):
            return False
        percentage = percentage_from_payload(payload)
        return (
            True
            if percentage is None
            else deterministic_percentage(flag_id, user_id, percentage)
        )
