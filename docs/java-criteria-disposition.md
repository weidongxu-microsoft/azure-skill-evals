# Java criterion disposition

Issue #37 re-audits the eleven formerly shared Java concerns across all 30
scenarios. This matrix now reflects the preservation-first implementation:
valid concerns are restored as standalone language criteria, and only proven
inapplicable concerns remain removed.

Here, **restored** means recovered from the superseded aggressive re-audit that
had removed or merged the concern. It does not mean absent from the `main`
baseline. Relative to `main`, `G` and `S` preserve an independent scoring point
with corrected wording; `R` is a removal that requires scenario-specific proof.

## Legend

- **G**: globally preserved standalone criterion with corrected wording.
- **S**: scenario-specific standalone criterion preserved with corrected wording.
- **R**: independently irrelevant; high-bar removal retained.

No concern is marked covered-by-prompt: broad prompt inclusion is not redundancy
proof when the concern can pass or fail independently.

## Matrix


| Scenario | Dep | BOM | Imports | Auth | Builder | API | Paging | Poll | Async | Errors | Cleanup |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `ai-agents-java-basic-agent-lifecycle` | G | G | G | S | S | G | S | S | R | R | S |
| `ai-agents-java-file-search` | G | G | G | S | S | G | S | S | R | R | S |
| `ai-agents-java-function-tool` | G | G | G | S | S | G | S | S | R | R | S |
| `ai-projects-java-dataset-lifecycle` | G | G | G | S | S | G | R | R | R | R | S |
| `ai-projects-java-evaluation-run` | G | G | G | S | S | G | S | S | R | R | S |
| `ai-projects-java-project-resource-inventory` | G | G | G | S | S | G | S | R | R | R | R |
| `app-configuration-java-config-values` | G | G | G | S | S | G | S | R | R | S | S |
| `app-configuration-java-feature-flags` | G | G | G | S | S | G | S | S | S | R | R |
| `cosmos-db-java-crud` | G | G | G | S | S | G | R | R | R | S | S |
| `cosmos-db-java-todo-repository` | G | G | G | S | S | G | S | R | S | S | R |
| `document-translation-java-batch-container` | G | G | G | S | S | G | S | S | R | R | R |
| `document-translation-java-single-document` | G | G | G | S | S | G | R | R | R | R | R |
| `event-hubs-java-send-receive-events` | G | G | G | S | S | G | R | R | R | S | S |
| `foundry-java-support-assistant` | G | G | G | S | S | G | S | S | R | S | S |
| `identity-java-credential-chain` | G | G | G | S | R | G | R | R | S | S | R |
| `identity-java-default-azure-credential` | G | G | G | S | S | G | R | R | R | S | R |
| `identity-java-managed-identity-auth` | G | G | G | S | S | G | R | R | R | S | R |
| `identity-java-service-principal-auth` | G | G | G | S | S | G | R | R | R | S | R |
| `key-vault-java-crud-secrets` | G | G | G | S | S | G | R | S | R | S | S |
| `key-vault-java-secret-config` | G | G | G | S | S | G | R | S | S | S | S |
| `resource-manager-java-resource-group-crud` | G | G | G | S | S | G | S | R | R | S | S |
| `service-bus-java-order-processor` | G | G | G | S | S | G | R | R | S | S | S |
| `service-bus-java-send-receive-messages` | G | G | G | S | S | G | R | R | R | S | S |
| `storage-java-account-mgmt` | G | G | G | S | S | G | S | R | R | S | S |
| `storage-java-blob-event-notifier` | G | G | G | S | S | G | R | R | S | S | R |
| `storage-java-blob-storage-manager` | G | G | G | S | S | G | S | R | S | S | S |
| `storage-java-crud-blobs` | G | G | G | S | S | G | S | R | R | S | S |
| `storage-java-encrypted-uploader` | G | G | G | S | S | G | R | R | S | S | R |
| `text-translation-java-multilingual-translation` | G | G | G | S | S | G | R | R | R | R | R |
| `text-translation-java-transliteration` | G | G | G | S | S | G | R | R | R | R | R |

## Retained high-bar removals

The only remaining removals are rows marked `R`. They are retained because the
lineage proves that the originating prompt and current public SDK surface do not
contain an accurate scoped concern. Prompt-silent authentication and exact-symbol
AI Projects/Document Translation cases are no longer deferred; they are restored
with inclusive standalone wording.

## Notes

- Dependency, BOM, import, public-API, authentication, construction, paging,
  polling, async, error, and cleanup concerns are standalone wherever applicable.
- Authentication criteria require runtime-supplied, non-hardcoded authentication
  supported by the chosen current client/service; they do not prescribe
  `DefaultAzureCredential` unless the prompt does.
- Builder criteria require supported current public endpoint/client construction;
  exact builder symbols are required only when prompt-contractual.
- Current-public API criteria accept public preview SDK surfaces when the prompt
  pins or requires a preview package, but still reject internal implementation
  packages.
- LRO and lifecycle criteria are scenario-specific: true LROs require terminal
  poller/result completion, direct status workflows use bounded retrieval, and
  cleanup names only the owned clients/processors or prompt-created resources at
  stake.
