from __future__ import annotations

import os
import sys
from typing import Any

from azure.cosmos import CosmosClient, PartitionKey
from azure.cosmos.exceptions import CosmosHttpResponseError
from azure.identity import DefaultAzureCredential


DATABASE_NAME = "TestDB"
CONTAINER_NAME = "Items"
PARTITION_KEY_PATH = "/category"
CATEGORY = "electronics"
ITEM_ID = "item-001"


def create_item() -> dict[str, Any]:
    return {
        "id": ITEM_ID,
        "category": CATEGORY,
        "name": "Mechanical keyboard",
        "quantity": 10,
    }


def run() -> None:
    endpoint = os.environ["COSMOS_ENDPOINT"]

    with DefaultAzureCredential() as credential:
        with CosmosClient(url=endpoint, credential=credential) as client:
            database = client.create_database_if_not_exists(id=DATABASE_NAME)
            container = database.create_container_if_not_exists(
                id=CONTAINER_NAME,
                partition_key=PartitionKey(path=PARTITION_KEY_PATH),
            )

            item = create_item()
            container.upsert_item(body=item)

            stored_item = container.read_item(
                item=ITEM_ID,
                partition_key=CATEGORY,
            )
            print(f"Read item: {stored_item}")

            query = "SELECT * FROM c WHERE c.category = @category"
            matches = list(
                container.query_items(
                    query=query,
                    parameters=[
                        {"name": "@category", "value": CATEGORY},
                    ],
                    enable_cross_partition_query=True,
                )
            )
            print(f"Query returned {len(matches)} item(s)")

            stored_item["quantity"] = 25
            container.replace_item(item=ITEM_ID, body=stored_item)
            container.delete_item(
                item=ITEM_ID,
                partition_key=CATEGORY,
            )


def main() -> int:
    try:
        run()
    except KeyError as error:
        print(
            f"Missing required environment variable: {error.args[0]}",
            file=sys.stderr,
        )
        return 2
    except CosmosHttpResponseError as error:
        print(f"Cosmos DB request failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

