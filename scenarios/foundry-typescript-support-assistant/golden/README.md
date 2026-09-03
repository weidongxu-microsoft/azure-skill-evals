# Contoso Foundry support assistant

This hosted TypeScript service ingests product manuals into Microsoft Foundry
file search, maintains isolated multi-turn conversations, returns source
citations, records unsupported questions and employee feedback, and runs
groundedness and relevance evaluations.

Azure resources must already exist; this project does not provision or deploy
infrastructure.

## Configure

Authenticate with Azure CLI or another credential supported by
`DefaultAzureCredential`, then set:

```powershell
$env:FOUNDRY_PROJECT_ENDPOINT = "https://<resource>.services.ai.azure.com/api/projects/<project>"
$env:MODEL_DEPLOYMENT_NAME = "<model-deployment>"
$env:EVALUATION_MODEL_DEPLOYMENT_NAME = "<judge-model-deployment>"
$env:STORAGE_ACCOUNT_ENDPOINT = "https://<account>.blob.core.windows.net"
$env:SUPPORT_ADMIN_PRINCIPAL_IDS = "<entra-object-id>[,<entra-object-id>]"
$env:AZURE_TOKEN_CREDENTIALS = "dev"
```

The identity needs data-plane access to the Foundry project and Storage Blob
Data Contributor access to the storage account. `SUPPORT_STATE_CONTAINER` and
`SUPPORT_STATE_BLOB` optionally change the state location.
`AZURE_LOG_LEVEL` may be `verbose`, `info`, `warning`, or `error`.
Set `AZURE_TOKEN_CREDENTIALS=prod` in the hosted environment so the production
entry point uses `ManagedIdentityCredential`.

For a deployed service, enable the hosting platform's Microsoft Entra
authentication and require authentication for every request. The service uses
the platform-provided `X-MS-CLIENT-PRINCIPAL-ID` header to isolate employee
conversations and restrict administrative routes to
`SUPPORT_ADMIN_PRINCIPAL_IDS`.

Deploy this Level 3 reference application with one service instance. Horizontal
scale-out and durable distributed operation processing belong to the separate
production-oriented level.

## Build and validate

Use Node.js 24:

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm test
```

## Run

```powershell
npm start
```

The service exposes `/health`, `/admin/ingest`,
`/conversations/{id}/messages`,
`/conversations/{id}/feedback`, `/admin/unresolved`,
`/admin/evaluations`, `/admin/operations/{id}`, and `/admin/resources`.
Evaluation requests return `202 Accepted`; poll the returned operation ID
instead of holding an Azure HTTP request open while the evaluation runs.

Call `DELETE /admin/resources` with an authenticated administrator identity
when finished. Conversations, the agent version, vector store, and uploaded
files are deleted in dependency order. The state blob remains as the durable
audit record.
