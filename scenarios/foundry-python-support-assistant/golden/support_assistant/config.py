from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Settings:
    project_endpoint: str
    model_deployment_name: str
    evaluation_model_deployment_name: str
    storage_account_endpoint: str
    state_container: str
    state_blob: str
    token_scope: str
    admin_principal_ids: frozenset[str]
    port: int
    materials: tuple[Path, ...]
    evaluation_dataset: Path


def load_settings(environment: Mapping[str, str] = os.environ) -> Settings:
    port = int(environment.get("PORT", "3000"))
    if not 1 <= port <= 65535:
        raise ValueError("PORT must be between 1 and 65535.")
    administrators = frozenset(
        item.strip()
        for item in _required(environment, "SUPPORT_ADMIN_PRINCIPAL_IDS").split(",")
        if item.strip()
    )
    if not administrators:
        raise ValueError("SUPPORT_ADMIN_PRINCIPAL_IDS must contain an object ID.")
    return Settings(
        project_endpoint=_required(environment, "FOUNDRY_PROJECT_ENDPOINT"),
        model_deployment_name=_required(environment, "MODEL_DEPLOYMENT_NAME"),
        evaluation_model_deployment_name=_required(
            environment, "EVALUATION_MODEL_DEPLOYMENT_NAME"
        ),
        storage_account_endpoint=_required(
            environment, "STORAGE_ACCOUNT_ENDPOINT"
        ),
        state_container=environment.get(
            "SUPPORT_STATE_CONTAINER", "support-assistant"
        ),
        state_blob=environment.get(
            "SUPPORT_STATE_BLOB", "state/application.json"
        ),
        token_scope=environment.get(
            "FOUNDRY_TOKEN_SCOPE",
            "https://ai.azure.com/.default",
        ),
        admin_principal_ids=administrators,
        port=port,
        materials=(
            Path("materials/contoso-aero-300.md"),
            Path("materials/contoso-aero-300-warranty.md"),
        ),
        evaluation_dataset=Path("evaluation/support-cases.jsonl"),
    )


def _required(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required.")
    return value
