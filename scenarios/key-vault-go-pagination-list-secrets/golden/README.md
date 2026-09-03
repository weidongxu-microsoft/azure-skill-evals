# Key Vault secret pagination

Set `AZURE_KEY_VAULT_URL` and authenticate with a credential supported by
`DefaultAzureCredential`.

`NewListSecretPropertiesPager` returns Go's generic `runtime.Pager`; `More` and
`NextPage(ctx)` provide explicit page-level control. Go exposes one context-based API,
not separate synchronous and asynchronous pageable types. Listing returns metadata
only, so the program never requests or prints secret values.