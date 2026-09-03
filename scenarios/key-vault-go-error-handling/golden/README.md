# Key Vault error diagnostics

Set `AZURE_KEY_VAULT_URL` and optionally `AZURE_KEY_VAULT_SECRET_NAME` and
`AZURE_KEY_VAULT_ACTION` (`get`, `set`, or `purge`). The `set` action also requires
`AZURE_KEY_VAULT_SECRET_VALUE`.

The shared `azcore` retry policy retries 429 responses and honors service retry headers
before returning the final `*azcore.ResponseError`. For deeper diagnostics, enable Azure
SDK for Go events with the `azcore/log` package and a listener in a controlled
environment. Do not log authorization headers, request or response bodies, secret
values, or full tokens; retain status, error code, retry headers, request IDs, and
timestamps instead.