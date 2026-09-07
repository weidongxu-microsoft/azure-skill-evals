# Java criterion disposition

Issue #37 re-audits the eleven formerly shared Java concerns across all 30
scenarios. This matrix supersedes the broad-removal decision: valid concerns
are restored with corrected wording, retained in focused prompt criteria, or
removed only when independently irrelevant.

## Legend

- **G**: restore globally with corrected wording.
- **S**: restore only for this scenario.
- **C**: already covered by a focused prompt criterion.
- **R**: independently irrelevant; do not restore.
- **H**: defer; retain the carried-forward remediation behavior pending human
  review.

`G` does not imply that related concerns must be combined into one point.
Dependency, BOM, import, and public-API concerns retain their original
independent scoring boundaries where they are not already covered.

## Matrix

| Scenario | Dep | BOM | Imports | Auth | Builder | API | Paging | Poll | Async | Errors | Cleanup |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `ai-agents-java-basic-agent-lifecycle` | G | G | G | C | C | C | C | C | R | R | C |
| `ai-agents-java-file-search` | G | G | G | H | C | C | C | C | R | R | C |
| `ai-agents-java-function-tool` | G | G | G | H | C | C | C | C | R | R | C |
| `ai-projects-java-dataset-lifecycle` | C | G | G | H | C | C | R | R | R | R | C |
| `ai-projects-java-evaluation-run` | C | G | G | H | H | C | C | C | R | R | C |
| `ai-projects-java-project-resource-inventory` | G | G | G | H | H | C | C | R | R | R | R |
| `app-configuration-java-config-values` | C | G | G | C | C | C | C | R | R | C | C |
| `app-configuration-java-feature-flags` | G | G | G | C | C | C | C | C | C | R | R |
| `cosmos-db-java-crud` | C | G | G | C | C | C | R | R | R | C | C |
| `cosmos-db-java-todo-repository` | G | G | G | C | C | C | C | R | C | C | R |
| `document-translation-java-batch-container` | C | G | G | C | C | C | C | H | R | R | R |
| `document-translation-java-single-document` | C | G | G | C | C | C | R | R | R | R | R |
| `event-hubs-java-send-receive-events` | C | G | G | C | C | G | R | R | R | C | C |
| `foundry-java-support-assistant` | C | G | G | C | C | C | C | C | R | C | C |
| `identity-java-credential-chain` | G | G | G | C | R | C | R | R | C | C | R |
| `identity-java-default-azure-credential` | C | G | G | C | C | C | R | R | R | C | R |
| `identity-java-managed-identity-auth` | C | G | G | C | C | C | R | R | R | C | R |
| `identity-java-service-principal-auth` | C | G | G | C | C | C | R | R | R | C | R |
| `key-vault-java-crud-secrets` | C | G | G | C | C | G | R | C | R | C | C |
| `key-vault-java-secret-config` | C | G | G | C | C | G | R | C | C | C | C |
| `resource-manager-java-resource-group-crud` | C | G | G | C | C | C | C | R | R | C | C |
| `service-bus-java-order-processor` | C | G | G | C | C | G | R | R | C | C | C |
| `service-bus-java-send-receive-messages` | C | G | G | C | C | C | R | R | R | C | C |
| `storage-java-account-mgmt` | C | G | G | C | C | G | C | R | R | C | C |
| `storage-java-blob-event-notifier` | C | G | G | C | C | G | R | R | C | C | R |
| `storage-java-blob-storage-manager` | C | G | G | C | C | G | C | R | C | C | C |
| `storage-java-crud-blobs` | C | G | G | C | C | G | C | R | R | C | C |
| `storage-java-encrypted-uploader` | C | G | G | C | C | G | R | R | C | C | R |
| `text-translation-java-multilingual-translation` | C | G | G | C | C | C | R | R | R | R | R |
| `text-translation-java-transliteration` | C | G | G | C | C | C | R | R | R | R | R |

Dependencies are restored only where a focused prompt criterion does not
already score the manifest. Current-public-API coverage follows the same rule.
BOM and Azure import hygiene are globally applicable and independently
observable. Authentication and construction stay prompt-specific. Existing
focused criteria retain applicable paging, polling, async, error, and cleanup
coverage.

For the five prompt-silent authentication rows marked `H`, retaining the
carried-forward behavior means the defective universal
`DefaultAzureCredential` requirement remains removed and no replacement
authentication method is prescribed. This differs from `main` and is deferred
for the explicit human decision below.

## BOM disposition

Every Java golden imports `com.azure:azure-sdk-bom:1.3.8`. Compatible managed
versions compile across all 30 goldens. Explicit Azure versions remain only
for:

- preview and BOM-uncovered `azure-ai-agents-persistent:1.0.0-beta.2`;
- prompt-pinned `azure-ai-projects:2.4.0` in dataset lifecycle and evaluation
  run, plus dataset-lifecycle `azure-storage-blob:12.35.1`;
- prompt-pinned `azure-ai-translation-document:2.0.1`;
- prompt-pinned `azure-ai-translation-text:2.0.2`; and

Previously explicit Foundry Agents 2.4.0, Identity 1.18.5, non-pinned Storage
12.35.1, Key Vault 4.11.2, App Configuration 1.10.1, Cosmos 4.82.0, Event Hubs
5.21.6, Service Bus 7.17.20, Event Grid 4.31.8, and Storage Resource Manager
2.57.2 versions are compatible with the BOM-managed versions used by the
goldens.

## Protected human decisions

These cases retain the prior remediation's behavior during this conservative
pass.

1. **Aggregate scenario weight:** all Java `eval.yaml` files,
   `model-graders.test.mjs`, and `docs/pilot-results/java-issue-37.md`.
   Decide whether panels with different criterion counts should have equal
   aggregate opportunity.
2. **Project-hygiene point count:** all Java `eval.yaml` files and
   `model-graders.test.mjs`. The re-audit preserves independent original
   boundaries; decide whether dependencies, BOM, imports, and public APIs
   should instead be combined.
3. **Combined focused criteria:** `cosmos-db-java-crud`,
   `service-bus-java-send-receive-messages`, and
   `document-translation-java-batch-container`. Decide whether combined
   dependency/authentication, error/cleanup, and paging/output behavior should
   be split.
4. **Prompt-silent authentication:** Agents file search, Agents function tool,
   and all three AI Projects scenarios. Decide whether to prescribe a default
   authentication method.
5. **Exact SDK symbols:** AI Projects evaluation run, AI Projects inventory,
   and batch Document Translation. Decide whether named builders and poller
   types are contractual or examples of valid evidence.
6. **Service Bus failed batch addition:**
   `service-bus-java-send-receive-messages`. Decide whether checking a rejected
   add exceeds the prompt's exact five-message batch.
7. **Separate paging points:** Agents, AI Projects, App Configuration, Cosmos,
   batch Document Translation, Foundry, Resource Manager, and Storage list
   scenarios. Decide whether complete enumeration deserves a point separate
   from the required output.
8. **Hyoka fidelity:** `AGENTS.md`, this policy, `model-graders.test.mjs`, and
   all Java evaluations. Decide whether exact restoration outranks correction
   of criteria that conflict with prompts or current public SDK behavior.
