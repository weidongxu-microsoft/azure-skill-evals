from __future__ import annotations

import os

from azure.identity import (
    AzureCliCredential,
    AzurePowerShellCredential,
    ChainedTokenCredential,
    EnvironmentCredential,
    ManagedIdentityCredential,
    WorkloadIdentityCredential,
    aio,
)


def _managed_identity() -> ManagedIdentityCredential:
    return ManagedIdentityCredential(client_id=os.getenv("AZURE_CLIENT_ID"))


def _async_managed_identity() -> aio.ManagedIdentityCredential:
    return aio.ManagedIdentityCredential(client_id=os.getenv("AZURE_CLIENT_ID"))


def _dev_sync() -> ChainedTokenCredential:
    return ChainedTokenCredential(
        AzureCliCredential(),
        AzurePowerShellCredential(),
    )


def _ci_sync() -> ChainedTokenCredential:
    return ChainedTokenCredential(
        EnvironmentCredential(),
        WorkloadIdentityCredential(),
    )


def _production_sync() -> ChainedTokenCredential:
    return ChainedTokenCredential(
        _managed_identity(),
        WorkloadIdentityCredential(),
    )


def build_sync_credential(environment: str) -> ChainedTokenCredential:
    if environment == "dev":
        return _dev_sync()
    if environment == "ci":
        return _ci_sync()
    if environment == "production":
        return _production_sync()
    raise ValueError(f"Unknown environment: {environment}")


def _dev_async() -> aio.ChainedTokenCredential:
    return aio.ChainedTokenCredential(
        aio.AzureCliCredential(),
        aio.AzurePowerShellCredential(),
    )


def _ci_async() -> aio.ChainedTokenCredential:
    return aio.ChainedTokenCredential(
        aio.EnvironmentCredential(),
        aio.WorkloadIdentityCredential(),
    )


def _production_async() -> aio.ChainedTokenCredential:
    return aio.ChainedTokenCredential(
        _async_managed_identity(),
        aio.WorkloadIdentityCredential(),
    )


def build_async_credential(environment: str) -> aio.ChainedTokenCredential:
    if environment == "dev":
        return _dev_async()
    if environment == "ci":
        return _ci_async()
    if environment == "production":
        return _production_async()
    raise ValueError(f"Unknown environment: {environment}")


def strategy_for(environment: str) -> str:
    strategies = {
        "dev": "Azure CLI, then Azure PowerShell",
        "ci": "environment credential, then workload identity",
        "production": "managed identity, then workload identity",
    }
    return strategies[environment]
