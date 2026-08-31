"""Feature flag evaluation for Azure App Configuration payloads."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from azure.appconfiguration import AzureAppConfigurationClient, ConfigurationSetting
from azure.appconfiguration.aio import AzureAppConfigurationClient as AsyncAzureAppConfigurationClient
from azure.core import MatchConditions
from azure.core.exceptions import HttpResponseError


FEATURE_FLAG_PREFIX = ".appconfig.featureflag/"
PERCENTAGE_FILTER = "Microsoft.Percentage"


def _rollout_percentage(payload: dict[str, Any]) -> float | None:
    conditions = payload.get("conditions") or {}
    for feature_filter in conditions.get("client_filters") or []:
        if feature_filter.get("name") != PERCENTAGE_FILTER:
            continue
        parameters = feature_filter.get("parameters") or {}
        value = next(
            (
                parameters[name]
                for name in ("Value", "value", "Percentage", "percentage")
                if name in parameters
            ),
            None,
        )
        if value is None:
            return None
        percentage = float(value)
        if not 0 <= percentage <= 100:
            raise ValueError("Feature flag rollout percentage must be between 0 and 100")
        return percentage
    return None


class FeatureFlagEvaluator:
    """Retrieve and evaluate feature flags synchronously."""

    def __init__(self, client: AzureAppConfigurationClient) -> None:
        self._client = client
        self._cache: dict[tuple[str, str | None], ConfigurationSetting] = {}

    def is_enabled(
        self, flag_name: str, user_id: str | None = None, label: str | None = None
    ) -> bool:
        key = f"{FEATURE_FLAG_PREFIX}{flag_name}"
        cache_key = (key, label)
        cached = self._cache.get(cache_key)
        if cached is None:
            setting = self._client.get_configuration_setting(key=key, label=label)
            if setting is None:
                raise RuntimeError(
                    "App Configuration returned no feature flag for an unconditional read"
                )
        else:
            try:
                setting = self._client.get_configuration_setting(
                    key=key,
                    label=label,
                    etag=cached.etag,
                    match_condition=MatchConditions.IfModified,
                )
            except HttpResponseError as error:
                if error.status_code == 304:
                    setting = cached
                else:
                    raise
            if setting is None:
                setting = cached
        self._cache[cache_key] = setting

        if setting.value is None:
            raise ValueError("Feature flag value cannot be null")
        payload = json.loads(setting.value)
        if not isinstance(payload, dict):
            raise ValueError("Feature flag payload must be a JSON object")
        if not payload["enabled"]:
            return False
        if "percentage" in payload:
            percentage = float(payload["percentage"])
            if not 0 <= percentage <= 100:
                raise ValueError(
                    "Feature flag rollout percentage must be between 0 and 100"
                )
        else:
            percentage = _rollout_percentage(payload)
        if percentage is None:
            return True
        if user_id is None:
            return False
        digest = hashlib.sha256(f"{flag_name}:{user_id}".encode("utf-8")).digest()
        bucket = int.from_bytes(digest[:8], byteorder="big") % 100
        return bucket < percentage


class AsyncFeatureFlagEvaluator:
    """Retrieve and evaluate feature flags asynchronously."""

    def __init__(self, client: AsyncAzureAppConfigurationClient) -> None:
        self._client = client
        self._cache: dict[tuple[str, str | None], ConfigurationSetting] = {}

    async def is_enabled(
        self, flag_name: str, user_id: str | None = None, label: str | None = None
    ) -> bool:
        key = f"{FEATURE_FLAG_PREFIX}{flag_name}"
        cache_key = (key, label)
        cached = self._cache.get(cache_key)
        if cached is None:
            setting = await self._client.get_configuration_setting(
                key=key, label=label
            )
            if setting is None:
                raise RuntimeError(
                    "App Configuration returned no feature flag for an unconditional read"
                )
        else:
            try:
                setting = await self._client.get_configuration_setting(
                    key=key,
                    label=label,
                    etag=cached.etag,
                    match_condition=MatchConditions.IfModified,
                )
            except HttpResponseError as error:
                if error.status_code == 304:
                    setting = cached
                else:
                    raise
            if setting is None:
                setting = cached
        self._cache[cache_key] = setting

        if setting.value is None:
            raise ValueError("Feature flag value cannot be null")
        payload = json.loads(setting.value)
        if not isinstance(payload, dict):
            raise ValueError("Feature flag payload must be a JSON object")
        if not payload["enabled"]:
            return False
        if "percentage" in payload:
            percentage = float(payload["percentage"])
            if not 0 <= percentage <= 100:
                raise ValueError(
                    "Feature flag rollout percentage must be between 0 and 100"
                )
        else:
            percentage = _rollout_percentage(payload)
        if percentage is None:
            return True
        if user_id is None:
            return False
        digest = hashlib.sha256(f"{flag_name}:{user_id}".encode("utf-8")).digest()
        bucket = int.from_bytes(digest[:8], byteorder="big") % 100
        return bucket < percentage
