# Blob Storage error handling

Set the target resource values, sign in, and run the application:

```powershell
$env:AZURE_STORAGE_BLOB_ENDPOINT = "https://<account>.blob.core.windows.net"
$env:AZURE_STORAGE_CONTAINER = "<container>"
$env:AZURE_STORAGE_BLOB = "<blob>"
$env:AZURE_STORAGE_LEASE_ID = "<optional-active-lease-id>"
az login
dotnet run
```

The app reads the blob's current ETag and performs a conditional metadata
update. It reports Azure request identifiers and common service failures.
