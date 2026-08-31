# Azure Blob Storage authentication

This .NET 8 console application uses `DefaultAzureCredential` and does not
store credentials. Set the Blob service endpoint and run it:

```sh
export AZURE_STORAGE_BLOB_ENDPOINT="https://<account-name>.blob.core.windows.net/"
az login
dotnet run
```

For local development, `DefaultAzureCredential` can use developer credentials
such as the signed-in Azure CLI identity. In Azure, enable a managed identity
on the hosting resource and grant it an appropriate Blob Storage data role.
`DefaultAzureCredential` then obtains tokens from that managed identity without
an application secret. The authenticated request reads and prints the storage
account kind and SKU.
