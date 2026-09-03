# Azure Blob Storage error handling for Go

Set `AZURE_STORAGE_BLOB_ENDPOINT`, `AZURE_STORAGE_CONTAINER`, and `AZURE_STORAGE_BLOB_NAME`, authenticate with `az login` or a managed identity, and run `go run .`.

Azure data-plane failures are returned as `*azcore.ResponseError`. The example uses `errors.As` to inspect `StatusCode` and `ErrorCode`, distinguishing not found (404), authorization (403), conflict or lease failures (409), and throttling (429). It also deliberately sends a stale ETag and an invalid lease ID to demonstrate conditional request failures.

The client uses bounded exponential retry for transient failures. `azcore/log` emits request, response, and retry events; SDK diagnostics can contain URLs and headers, so enable them deliberately and protect logs as operational data.
