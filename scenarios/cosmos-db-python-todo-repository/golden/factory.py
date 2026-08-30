from __future__ import annotations

import os
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from typing import Any

from azure.cosmos import CosmosClient, PartitionKey
from azure.cosmos.aio import CosmosClient as AsyncCosmosClient
from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential


DATABASE_NAME = "TodoDatabase"
CONTAINER_NAME = "Todos"
DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60
INDEXING_POLICY = {
    "indexingMode": "consistent",
    "automatic": True,
    "includedPaths": [{"path": "/*"}],
    "excludedPaths": [{"path": "/description/?"}],
}


@contextmanager
def sync_container() -> Iterator[Any]:
    endpoint = os.environ["AZURE_COSMOS_ENDPOINT"]
    with DefaultAzureCredential() as credential:
        with CosmosClient(endpoint, credential=credential) as client:
            database = client.create_database_if_not_exists(id=DATABASE_NAME)
            container = database.create_container_if_not_exists(
                id=CONTAINER_NAME,
                partition_key=PartitionKey(path="/category"),
                default_ttl=DEFAULT_TTL_SECONDS,
                indexing_policy=INDEXING_POLICY,
            )
            yield container


@asynccontextmanager
async def async_container() -> AsyncIterator[Any]:
    endpoint = os.environ["AZURE_COSMOS_ENDPOINT"]
    async with AsyncDefaultAzureCredential() as credential:
        async with AsyncCosmosClient(endpoint, credential=credential) as client:
            database = await client.create_database_if_not_exists(
                id=DATABASE_NAME,
            )
            container = await database.create_container_if_not_exists(
                id=CONTAINER_NAME,
                partition_key=PartitionKey(path="/category"),
                default_ttl=DEFAULT_TTL_SECONDS,
                indexing_policy=INDEXING_POLICY,
            )
            yield container
