# Blob Storage authentication

Set `AZURE_STORAGE_BLOB_ENDPOINT` to the account endpoint, such as
`https://<account>.blob.core.windows.net`, then run:

```powershell
az login
dotnet run
```

`DefaultAzureCredential` uses Azure-hosted credentials, including managed
identity, in production and developer credentials, including Azure CLI, during
local development. Environment credentials can also participate when their
variables are configured.
