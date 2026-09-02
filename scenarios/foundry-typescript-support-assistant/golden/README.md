# Contoso Foundry support assistant

This TypeScript CLI ingests product manuals into Microsoft Foundry file search,
maintains isolated multi-turn conversations, returns source citations, records
unsupported questions and employee feedback, and runs groundedness and
relevance evaluations.

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

For a deployed service, enable App Service authentication with Microsoft Entra
ID and require authentication for every request. The service uses the
platform-provided `X-MS-CLIENT-PRINCIPAL-ID` header to isolate employee
conversations and restrict administrative routes to
`SUPPORT_ADMIN_PRINCIPAL_IDS`.

Deploy this Level 3 reference application with one service instance. Horizontal
scale-out and durable distributed operation processing belong to the separate
production-oriented level.

## Build and validate

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm test
```

## Run

```powershell
npm run admin -- ingest
npm run admin -- ask employee-1 "How do I reset the Aero 300?"
npm run admin -- ask employee-1 "How long should the status light flash?"
npm run admin -- feedback employee-1 <response-id> positive "Clear answer"
npm run admin -- evaluate
npm run admin -- cleanup
```

Run `npm start` to host the HTTP service. It exposes `/health`,
`/admin/ingest`, `/conversations/{id}/messages`,
`/conversations/{id}/feedback`, `/admin/unresolved`,
`/admin/evaluations`, `/admin/operations/{id}`, and `/admin/resources`.
Evaluation requests return `202 Accepted`; poll the returned operation ID
instead of holding an Azure HTTP request open while the evaluation runs.

Run `cleanup` when finished so conversations, the agent version, vector store,
and uploaded files are deleted in dependency order. The state blob remains as
the durable audit record.
