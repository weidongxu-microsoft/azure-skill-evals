"""Feature flag evaluation for Azure App Configuration JSON flags."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from configuration_service import AsyncConfigurationService, ConfigurationService

FEATURE_FLAG_PREFIX = ".appconfig.featureflag/"


@dataclass(frozen=True)
class _FeatureFlag:
    name: str
    enabled: bool
    rollout_percentage: float | None


def _parse_flag(name: str, payload: str | None) -> _FeatureFlag:
    if payload is None:
        raise ValueError(f"Feature flag {name!r} has no JSON value")

    try:
        document = json.loads(payload)
    except json.JSONDecodeError as error:
        raise ValueError(f"Feature flag {name!r} contains invalid JSON") from error
    if not isinstance(document, dict):
        raise ValueError(f"Feature flag {name!r} must be a JSON object")

    enabled = document.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError(f"Feature flag {name!r} has a non-boolean enabled value")

    percentage: float | None = None
    conditions = document.get("conditions", {})
    filters = conditions.get("client_filters", []) if isinstance(conditions, dict) else []
    if not isinstance(filters, list):
        raise ValueError(f"Feature flag {name!r} has invalid client_filters")

    for client_filter in filters:
        if not isinstance(client_filter, dict):
            continue
        filter_name = str(client_filter.get("name", ""))
        if filter_name.rsplit(".", 1)[-1].lower() != "percentage":
            continue
        parameters = client_filter.get("parameters", {})
        if not isinstance(parameters, dict):
            raise ValueError(f"Feature flag {name!r} has invalid percentage parameters")
        raw_percentage: Any = parameters.get("Value", parameters.get("value"))
        try:
            percentage = float(raw_percentage)
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"Feature flag {name!r} has an invalid rollout percentage"
            ) from error
        if not 0 <= percentage <= 100:
            raise ValueError(
                f"Feature flag {name!r} rollout percentage must be from 0 to 100"
            )
        break

    return _FeatureFlag(name, enabled, percentage)


def _user_is_in_rollout(flag_name: str, user_id: str, percentage: float) -> bool:
    digest = hashlib.sha256(f"{flag_name}:{user_id}".encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:8], byteorder="big") % 10_000
    return bucket < round(percentage * 100)


class FeatureFlagEvaluator:
    def __init__(self, configuration: ConfigurationService) -> None:
        self._configuration = configuration

    def is_enabled(
        self, flag_name: str, user_id: str | None = None, label: str | None = None
    ) -> bool:
        payload = self._configuration.get_setting(
            f"{FEATURE_FLAG_PREFIX}{flag_name}", label
        )
        flag = _parse_flag(flag_name, payload)
        if not flag.enabled:
            return False
        if flag.rollout_percentage is None:
            return True
        return user_id is not None and _user_is_in_rollout(
            flag.name, user_id, flag.rollout_percentage
        )


class AsyncFeatureFlagEvaluator:
    def __init__(self, configuration: AsyncConfigurationService) -> None:
        self._configuration = configuration

    async def is_enabled(
        self, flag_name: str, user_id: str | None = None, label: str | None = None
    ) -> bool:
        payload = await self._configuration.get_setting(
            f"{FEATURE_FLAG_PREFIX}{flag_name}", label
        )
        flag = _parse_flag(flag_name, payload)
        if not flag.enabled:
            return False
        if flag.rollout_percentage is None:
            return True
        return user_id is not None and _user_is_in_rollout(
            flag.name, user_id, flag.rollout_percentage
        )
