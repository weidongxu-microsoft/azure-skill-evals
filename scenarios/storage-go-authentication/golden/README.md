# Azure Blob Storage authentication for Go

This example uses `github.com/Azure/azure-sdk-for-go/sdk/azidentity` and `github.com/Azure/azure-sdk-for-go/sdk/storage/azblob`. Set the service endpoint, then run the project:

```powershell
$env:AZURE_STORAGE_BLOB_ENDPOINT = "https://<account>.blob.core.windows.net/"
az login
go run .
```

`DefaultAzureCredential` selects an available credential from its documented chain. In Azure, enable a managed identity on the workload. During local development, `az login` supplies the Azure CLI credential. Environment credentials are also supported when their variables are configured; no account key or connection string is required.

Grant the workload or developer identity a data-plane role such as **Storage Blob Data Reader** on the storage account (or a narrower scope). A writer application instead needs **Storage Blob Data Contributor**. Management-plane roles such as Contributor do not by themselves grant blob data access.

The program reports unavailable credentials, authentication failures, and Blob service response errors separately. Run `go mod download` if dependencies are not already present.
