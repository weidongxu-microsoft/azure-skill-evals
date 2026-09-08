# Java evaluation issues

Run date: 2026-09-08

GitHub Actions run:
[34184702983](https://github.com/weidongxu-microsoft/azure-skill-evals/actions/runs/34184702983)
from `main` at `8d46011f83b028e15c82d81b38e0cade785902b6`.

The workflow completed all 87 trials across the three Java variants without
shard integrity errors.

| Variant | Prompt | Language | Program |
|---|---:|---:|---:|
| Baseline | 180/222 (81.1%) | 226/319 (70.8%) | 26/29 (89.7%) |
| Azure skill + MCP | 215/222 (96.8%) | 262/319 (82.1%) | 29/29 (100.0%) |
| Azure skill + MCP + Java skills | 215/222 (96.8%) | 260/319 (81.5%) | 29/29 (100.0%) |

The list below includes only high-confidence evaluation issues. Genuine
implementation omissions and uncertain judgments are excluded.

## Prompt evaluation issues

| Scenario and criterion | Affected variants | Reason |
|---|---|---|
| `ai-agents-java-basic-agent-lifecycle`: `prompt/builds-persistentagentsclient-with-persistentagentsclien` | Java skills | The criterion requires `PersistentAgentsClientBuilder`, which the prompt does not name. The implementation instead uses a configured `PersistentAgentsAdministrationClientBuilder`, obtains all required subclients, completes the workflow, passes the other seven prompt criteria, and compiles. The failure is based on builder topology rather than behavior. |
| `app-configuration-java-feature-flags`: `prompt/retrieves-settings-with-a-specific-label-parameter-using` | Baseline | The implementation supplies the requested key and label directly to `getConfigurationSetting(key, label)`. Requiring `SettingSelector` rejects an equivalent SDK overload; the golden implementation also uses the direct overload. |
| `cosmos-db-java-todo-repository`: `prompt/configurable-page-size-via-queryrequestoptions-setmaxite` | Baseline, Azure | Both implementations configure page size with `iterableByPage(pageSize)` and `byPage(pageSize)`. The Java-skills trial passed with the same mechanism, and the golden uses it too. Requiring `QueryRequestOptions.setMaxItemCount` is unnecessarily specific and was judged inconsistently. |
| `cosmos-db-java-todo-repository`: `prompt/logs-continuation-token-and-item-count-per-page` | All three | The prompt asks to log progress as each page is retrieved, not to log continuation tokens. The implementations log page progress, item counts, and RU charge; requiring the token adds an unstated output requirement. |
| `cosmos-db-java-todo-repository`: `prompt/catches-cosmosexception-with-status-code-checks-404-409` | All three | The prompt specifically requires lost-update conflict handling. All implementations use ETags and handle HTTP 412, but the criterion additionally requires special 404 and 409 handling that the prompt never requests. |
| `identity-java-managed-identity-auth`: `prompt/chainedtokencredentialbuilder-for-local-fallback` | All three | The prompt requests local-development fallback strategies, not one exact builder. The implementations provide valid `AzureCliCredential` or `DefaultAzureCredential` fallback paths. Requiring `ChainedTokenCredentialBuilder` rejects equivalent behavior. |
| `storage-java-blob-event-notifier`: `prompt/catches-event-grid-specific-exceptions-for-publishing-er` | Azure, Java skills | The prompt requires publishers that send custom events but does not require publisher-specific exception handling. Both implementations send through the sync and async Event Grid clients; the criterion adds an unstated robustness requirement. The baseline is not included because it omitted the publisher. |

These account for 15 of the 56 reported prompt-criterion failures.

## Language evaluation issues

| Criterion and affected scenarios | Failures | Reason |
|---|---:|---|
| `language/correct-dependencies-com-azure-not-com-microsoft-azure`, `language/defaultazurecredential-authentication`, and `language/client-builder-pattern` in App Configuration CRUD, Cosmos DB CRUD, Event Hubs send/receive, and Service Bus send/receive | 36 | The scenario requirements call for a connection string or account key, while the language criteria require `azure-identity`, prohibit connection strings and keys, and require endpoint-plus-credential builders. All three variants followed the scenario-specific authentication requirement and were penalized by the contradictory language rules. |
| `language/azure-sdk-bom-for-version-management` in `ai-projects-java-evaluation-run` | 3 | The prompt requires `com.azure:azure-ai-projects` version `2.4.0`, while the language criterion requires omitting individual dependency versions in favor of the BOM. The golden POM also pins `2.4.0`, so the criterion conflicts with both the stimulus and positive oracle. |
| `language/pagination-pagediterable-pagedflux` in `ai-projects-java-evaluation-run` | 2 | The prompt-specific criterion requires the OpenAI client's native `autoPager`, and both failed implementations use it. The language criterion nevertheless requires Azure Core `PagedIterable` or `PagedFlux`. The golden also uses `autoPager`; this is a service-native pager that the generic criterion must accept. |
| `language/lro-pattern-syncpoller-pollerflux` in the three AI Agents scenarios and AI Projects evaluation run | 12 | These APIs expose retrieve/get operations for status polling rather than `begin*` methods returning Azure Core pollers. The prompts explicitly require repeated refresh/retrieve calls, and all four goldens use `Thread.sleep` plus the native status API. The generic LRO criterion rejects the required SDK workflow. |
| `language/lro-pattern-syncpoller-pollerflux` in Resource Group CRUD and Storage Account management | 3 | The generated applications use the management SDK's blocking fluent `create()` and delete methods. Those methods are valid synchronous convenience APIs, and both goldens use the same pattern. Requiring explicit `begin*` pollers rejects valid SDK behavior. |

These account for 56 reported language-criterion failures.

## Reviewed failures not listed

The DefaultAzureCredential chain-order and logging misses are genuine because
the prompt explicitly asks for both topics. The baseline dataset-lifecycle,
blob-event, and encrypted-uploader trials omitted substantial requested
functionality. Other BOM, pagination, exception-handling, and LRO failures were
not included when the implementation clearly violated the current criterion or
the evidence was insufficient to call the judgment wrong with high confidence.

## Evaluation changes indicated

1. Make shared language criteria conditional on scenario applicability and
   scenario-required authentication.
2. Accept service-native equivalents such as OpenAI `autoPager`, Cosmos page
   streams, management fluent blocking operations, and Agents status polling.
3. Remove implementation-specific prompt criteria when the stimulus permits
   equivalent SDK APIs, or add the exact requirement to the stimulus.
4. Resolve exact-version prompts before enforcing BOM-managed, versionless
   dependencies.

## Trajectory and artifact notes

| Variant | Skill activations | Tool calls | Azure MCP calls observed |
|---|---:|---:|---:|
| Baseline | 0 | 386 | 0 |
| Azure skill + MCP | 18 | 509 | 0 |
| Azure skill + MCP + Java skills | 35 | 429 | 0 |

The Azure-only arm activated general `azure-ai`, `microsoft-foundry`,
`azure-messaging`, and `azure-storage` skills. The Java-skills arm activated
service-specific Java skills across Agents, AI Projects, App Configuration,
Cosmos DB, Event Hubs, Identity, Key Vault, Event Grid, and Storage, plus some
general Azure skills. Skill activation and tool choice did not affect grading.

Downloaded reports, trajectories, patches, and generated workspaces are stored
outside the repository at
`C:\Users\xiaofeicao\.copilot\session-state\0d0cf794-e32d-4674-b2a6-af245adf5ba7\files\java-vally-34184702983`.
Program results establish Maven compilation only; no live Azure service runtime
was reconstructed or exercised during this review.
