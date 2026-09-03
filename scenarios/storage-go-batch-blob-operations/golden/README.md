# Azure Blob batch operations in Go

This example submits batch delete and access-tier operations with
`azblob/service`. Blob Batch supports at most 256 subrequests and a 4 MiB
request body, so the 500 deletes are split into batches of 256 and 244. The
200 tier changes fit in one batch.

The Go SDK batch builder supports Shared Key credentials or an account SAS,
not token credentials. This example uses Shared Key values supplied through
the environment; no secrets are stored in source.

Set these variables before running `go run .`:

- `AZURE_STORAGE_ACCOUNT_NAME`
- `AZURE_STORAGE_ACCOUNT_KEY`
- `AZURE_STORAGE_ACCOUNT_URL`, such as `https://account.blob.core.windows.net`
- `AZURE_STORAGE_CONTAINER_NAME`

The named blobs must already exist. Each submitted batch contains only one
operation type, as required by the service. The program checks every parsed
subresponse for partial failures and also reports typed Azure errors when the
overall request fails.