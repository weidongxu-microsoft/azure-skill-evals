from __future__ import annotations

import os
import sys

from azure.core.exceptions import HttpResponseError, ResourceExistsError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient


CONTAINER_NAME = "my-container"
BLOB_NAME = "reports/report.csv"
SOURCE_PATH = "report.csv"
DOWNLOAD_PATH = "report-downloaded.csv"


def run() -> None:
    account_url = os.environ["AZURE_STORAGE_ACCOUNT_URL"]

    with DefaultAzureCredential() as credential:
        with BlobServiceClient(
            account_url=account_url,
            credential=credential,
        ) as service_client:
            container_client = service_client.get_container_client(CONTAINER_NAME)
            try:
                try:
                    container_client.create_container()
                except ResourceExistsError:
                    pass

                blob_client = container_client.get_blob_client(BLOB_NAME)
                with open(SOURCE_PATH, "rb") as source:
                    blob_client.upload_blob(source, overwrite=True)

                for blob in container_client.list_blobs():
                    print(f"{blob.name}: {blob.size}")

                with open(DOWNLOAD_PATH, "wb") as destination:
                    blob_client.download_blob().readinto(destination)

                blob_client.delete_blob()
                container_client.delete_container()
            except HttpResponseError as error:
                print(f"Blob Storage request failed: {error}", file=sys.stderr)
                raise


if __name__ == "__main__":
    run()
