# Blob Storage retry configuration

Set the target resource values, sign in, and run the application:

```powershell
$env:AZURE_STORAGE_BLOB_ENDPOINT = "https://<account>.blob.core.windows.net"
$env:AZURE_STORAGE_CONTAINER = "<container>"
$env:AZURE_STORAGE_BLOB = "<blob>"
az login
dotnet run
```

The app uploads a small generated payload with bounded SDK retries, an
independent operation timeout, and a transient-failure circuit breaker.
