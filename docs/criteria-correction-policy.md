# Criteria correction policy

Originating Hyoka prompts are immutable task inputs. Hyoka criteria retain
provenance but are not immutable when their wording would misgrade application
correctness.

A criterion may be corrected when repository evidence or current public SDK
documentation shows that it:

- conflicts with the originating prompt or another required criterion;
- requires an invalid, obsolete, or unrelated SDK API;
- rejects an equivalent valid implementation;
- combines independently scorable capabilities or duplicates inseparable
  evidence; or
- omits observable value flow, output, lifecycle, or failure behavior required
  by the prompt.

Corrections must remain binary, weight 1, prompt-relevant, diff-observable, and
independent of MCP calls or skill activation. Exact symbols are required only
when the prompt makes them part of the contract. Reference applications are
positive oracles, not exclusive implementation templates.

Candidate overlaps remain separate unless a per-scenario review proves that
identical evidence necessarily earns multiple points for a capability that
cannot be scored independently.

## Java issue 37 remediation manifest

| Scenario | Corrected evidence boundaries |
|---|---|
| AI Agents: basic lifecycle | endpoint/deployment flow, named agent, valid manual terminal polling, messages, cleanup |
| AI Agents: function tool | named configured agent, `get_weather` contract, tool round trip, terminal polling |
| AI Agents: file search | endpoint/deployment flow, vector-store readiness, named agent, successful terminal run, citations |
| AI Projects: inventory | project endpoint/client flow, complete pageable resource inventory, actionable failures |
| AI Projects: evaluation run | schema and evaluator mapping split, exact JSONL run, supported retrieve polling, complete output paging, cleanup |
| AI Projects: dataset lifecycle | supplied-value flow, direct or staged upload, SAS-authorized Blob access, verification, cleanup |
| App Configuration: values | connection-string client, both value/label writes, prefix results, separate deletion and service errors |
| App Configuration: flags | managed-identity endpoint, enabled state, conditional cache retention, sync/async lookups and maps |
| Event Hubs | connection-string client, exactly ten enriched events, connected send/receive flow, body output, processor lifecycle |
| Identity: default credential | exact DAC, ordered local/hosted behavior, real Secret client, actionable diagnostics |
| Identity: managed identity | system/user assigned selectors, real SDK client, usable local fallback, preserved diagnostics |
| Identity: service principal | injected tenant/client/secret flow, real SDK client, secret non-disclosure, concrete identity failures |
| Identity: credential chains | ordered dev/CI/production strategies, conditional Pipelines inputs, CAE request/output, sync/async tests |
| Cosmos DB: CRUD | endpoint/key auth, exact database/container/partition values, POJO CRUD flow, bound query value, service errors |
| Cosmos DB: todo repository | model and both repositories, create-if-absent, ETag conflict, supported page sizing, per-page diagnostics, ordered demo |
| Document Translation: single | exact arguments, endpoint credential flow, equivalent translation overloads, unchanged output bytes |
| Document Translation: batch | exact arguments, endpoint credential flow, true SyncPoller completion, printed overall status, all document pages/errors |
| Text Translation: multilingual | exact arguments, endpoint/key flow, supplied text and languages, returned detection/translations |
| Text Translation: transliteration | exact arguments/order, endpoint/key flow, supported overloads, returned script/text |
| Service Bus: send/receive | supported auth, exactly five messages and failed batch add, receive/settle flow, processor start/stop, topic/subscription flow |
| Service Bus: order processor | order fields/statuses, configured priority, batching/scheduling/correlation, session ordering, settlement/dead-letter, full lifecycle |
| Key Vault: CRUD | exact DAC/vault URL, secret names/values and printed read, completed delete before purge, actionable failures |
| Key Vault: secret config | managed-identity vault flow, both providers/caches, refresh replacement, completed deletion and same-name recreation, ordered demo |
| Storage account management | documented manager authentication, exact `eastus`/`Standard_LRS`, list/get, Blob versioning update, deletion |
| Blob CRUD | exact DAC endpoint, names/files/output, idempotent container creation, listing, cleanup, status-aware failures |
| Blob event notifier | equivalent schema-conformant decoding, sync/async receive-publish-handle flow, metadata summary, race and publishing failures |
| Encrypted uploader | local authenticated encryption, Key Vault KEK wrap/unwrap, decrypt metadata, shared credential, sync/async round trips and required output |
| Blob storage manager | bounded-memory transfer, tags, lease, retry and per-request timeout, logging, complete sync/async CRUD and output |
| Resource group CRUD | exact DAC manager authentication, `eastus` create, list/get/tag/delete, actionable management errors |
| Foundry support assistant | current coherent SDKs, Entra auth, bounded service lifecycle, retrieval/citations/state/feedback/evaluation/cleanup |

The copied universal Java BOM, import, token-authentication, builder, legacy
class, paging, LRO, async, exception, and cleanup checks are intentionally not
retained. Those concerns are scored only where the scenario requires them.
