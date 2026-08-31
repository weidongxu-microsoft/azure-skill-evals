# Blob batch operations

Set the account endpoint and container, sign in, and run the application:

```powershell
$env:AZURE_STORAGE_BLOB_ENDPOINT = "https://<account>.blob.core.windows.net"
$env:AZURE_STORAGE_CONTAINER = "<container>"
az login
dotnet run
```

The app deletes 500 named blobs in chunks of at most 256 and sets 200 other
blobs to the Cool tier. Blob batches are non-atomic, are limited to 256
subrequests and a 4 MiB body, and can target only one storage account.

`BlobServiceClient` requests the `https://storage.azure.com/.default` scope for
`DefaultAzureCredential`. The credential can use managed identity in Azure and
developer credentials such as Azure CLI locally; the app does not handle
access tokens directly.
