# Azure Blob Storage authentication sample

This .NET 8 console application uses `DefaultAzureCredential` without storing
credentials in source code. Set the Blob service account endpoint and run it:

```bash
export AZURE_STORAGE_BLOB_ENDPOINT="https://<account>.blob.core.windows.net/"
az login
dotnet restore
dotnet run
```

For local development, `DefaultAzureCredential` can use a signed-in developer
identity such as Azure CLI. In Azure, enable a system-assigned or user-assigned
managed identity for the host and grant it an appropriate Blob data-plane role,
such as **Storage Blob Data Reader**. The same code then uses managed identity
automatically. For a user-assigned identity, set `AZURE_CLIENT_ID` to its client
ID. Role assignments can take several minutes to become effective.
