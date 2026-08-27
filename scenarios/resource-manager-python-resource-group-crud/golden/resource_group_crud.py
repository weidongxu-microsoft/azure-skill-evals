from __future__ import annotations

import os
import sys

from azure.core.exceptions import HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.mgmt.resource import ResourceManagementClient
from azure.mgmt.resource.resources.models import ResourceGroup


def run() -> None:
    subscription_id = os.environ["AZURE_SUBSCRIPTION_ID"]
    resource_group_name = os.environ["AZURE_RESOURCE_GROUP_NAME"]
    location = os.environ.get("AZURE_LOCATION", "eastus")

    credential = DefaultAzureCredential()
    client = ResourceManagementClient(credential, subscription_id)

    try:
        parameters = ResourceGroup(location=location)
        created = client.resource_groups.create_or_update(
            resource_group_name,
            parameters,
        )
        print(f"Created: {created.name} in {created.location}")

        for resource_group in client.resource_groups.list():
            print(f"Resource group: {resource_group.name}")

        retrieved = client.resource_groups.get(resource_group_name)
        print(f"Retrieved: {retrieved.name} in {retrieved.location}")

        updated = client.resource_groups.update(
            resource_group_name,
            {"tags": {"environment": "development"}},
        )
        print(f"Updated tags: {updated.tags}")

        deletion = client.resource_groups.begin_delete(resource_group_name)
        deletion.result()
        print(f"Deleted resource group: {resource_group_name}")
    except HttpResponseError as error:
        print(f"Resource group operation failed: {error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    run()
