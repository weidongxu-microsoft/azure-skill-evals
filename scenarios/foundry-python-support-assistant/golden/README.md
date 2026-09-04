# Contoso Foundry support assistant

Python 3.12 backend API using the Microsoft Foundry project-scoped OpenAI v1
Responses, Files, Vector Stores, Conversations, and Evals APIs. Azure Blob
Storage holds one ETag-guarded state document containing employee-scoped
conversation mappings, responses, unresolved questions, feedback, and resource
ownership.

Azure resources must already exist. This application contains no provisioning
or deployment automation.

## Configure and run

Copy `.env.example` values into the process environment. The identity needs
Foundry data-plane access and Storage Blob Data Contributor access. The state
container must already exist. Production uses `ManagedIdentityCredential` when
`AZURE_TOKEN_CREDENTIALS=prod`; local development uses
`DefaultAzureCredential`. `FOUNDRY_TOKEN_SCOPE` defaults to
`https://ai.azure.com/.default`.

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m support_assistant
```

Routes are `/health`, `/admin/ingest`,
`/conversations/{id}/messages`, `/conversations/{id}/feedback`,
`/admin/unresolved`, `/admin/evaluations`,
`/admin/operations/{id}`, and `/admin/resources`. The hosting platform must
authenticate requests and set `X-MS-CLIENT-PRINCIPAL-ID`.

## Validate

```powershell
python -m compileall -q support_assistant tests
python -m ruff check .
python -m unittest discover -s tests
```

Call `DELETE /admin/resources` as an administrator to remove application-owned
Foundry conversations, vector stores, and files in dependency order. Ownership
remains in Blob Storage when remote cleanup fails so the operation can be
retried.
