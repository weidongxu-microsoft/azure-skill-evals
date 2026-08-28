from __future__ import annotations

import os
import sys

from azure.core.exceptions import ClientAuthenticationError, HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.mgmt.storage import StorageManagementClient
from azure.mgmt.storage.models import (
    BlobServiceProperties,
    Kind,
    Sku,
    SkuName,
    StorageAccountCreateParameters,
)


def run() -> None:
    subscription_id = os.environ["AZURE_SUBSCRIPTION_ID"]
    resource_group_name = os.environ["AZURE_RESOURCE_GROUP_NAME"]
    account_name = os.environ["AZURE_STORAGE_ACCOUNT_NAME"]
    location = os.environ.get("AZURE_LOCATION", "eastus")

    credential = DefaultAzureCredential()
    client = StorageManagementClient(credential, subscription_id)

    try:
        parameters = StorageAccountCreateParameters(
            sku=Sku(name=SkuName.STANDARD_LRS),
            kind=Kind.STORAGE_V2,
            location=location,
        )
        creation = client.storage_accounts.begin_create(
            resource_group_name,
            account_name,
            parameters,
        )
        creation.result()

        for account in client.storage_accounts.list_by_resource_group(
            resource_group_name,
        ):
            print(f"Storage account: {account.name}")

        properties = client.storage_accounts.get_properties(
            resource_group_name,
            account_name,
        )
        print(f"Storage account location: {properties.location}")

        blob_properties = client.blob_services.set_service_properties(
            resource_group_name,
            account_name,
            "default",
            BlobServiceProperties(is_versioning_enabled=True),
        )
        print(f"Blob versioning enabled: {blob_properties.is_versioning_enabled}")

        deletion = client.storage_accounts.begin_delete(
            resource_group_name,
            account_name,
        )
        deletion.result()
        print(f"Deleted storage account: {account_name}")
    except ClientAuthenticationError as error:
        print(f"Azure authentication failed: {error}", file=sys.stderr)
        raise
    except HttpResponseError as error:
        print(f"Storage management request failed: {error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    run()
