# Contoso Foundry support assistant

.NET 10 backend API using the Microsoft Foundry project-scoped OpenAI v1
Responses, Files, Vector Stores, Conversations, and Evals APIs. Azure Blob
Storage holds one ETag-guarded state document containing employee-scoped
conversation mappings, responses, unresolved questions, feedback, and resource
ownership.

Azure resources must already exist. This application contains no provisioning
or deployment automation.

## Configure and run

Set the values shown in `appsettings.example.json` as environment variables.
The identity needs Foundry data-plane access and Storage Blob Data Contributor
access. The state container must already exist. Production uses
`ManagedIdentityCredential` when `AZURE_TOKEN_CREDENTIALS=prod`; local
development uses `DefaultAzureCredential`. `FOUNDRY_TOKEN_SCOPE` defaults to
`https://ai.azure.com/.default`.

```powershell
dotnet restore
dotnet build --no-restore
dotnet test --no-build
dotnet run --project src\Contoso.SupportAssistant
```

Routes are `/health`, `/admin/ingest`,
`/conversations/{id}/messages`, `/conversations/{id}/feedback`,
`/admin/unresolved`, `/admin/evaluations`,
`/admin/operations/{id}`, and `/admin/resources`. The hosting platform must
authenticate requests and set `X-MS-CLIENT-PRINCIPAL-ID`.

Call `DELETE /admin/resources` as an administrator to remove application-owned
Foundry conversations, vector stores, and files in dependency order. Ownership
remains in Blob Storage when remote cleanup fails so the operation can be
retried.
