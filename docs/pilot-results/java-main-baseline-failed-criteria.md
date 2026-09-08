# Java main baseline failed criteria

Run date: 2026-09-08

This report lists every application failure occurrence after replaying the
deterministic Java checker for the reconciled unchanged-main run at
`8d46011f83b028e15c82d81b38e0cade785902b6`. The “potential reason”
text for model criteria is the judge's recorded per-criterion reasoning. It is
not an independently reproduced root cause unless the spot-check section says
so. Program reasons come from the deterministic replay and link to the
retained full logs.

## Application failure counts

| Variant | Group | Failed occurrences |
|---|---|---:|
| Baseline | prompt | 27 |
| Baseline | language | 65 |
| Baseline | program (replayed) | 1 |
| Azure skills + MCP | prompt | 13 |
| Azure skills + MCP | language | 67 |
| Azure skills + MCP | program (replayed) | 0 |
| Full Java SDK skills | prompt | 8 |
| Full Java SDK skills | language | 62 |
| Full Java SDK skills | program (replayed) | 0 |

The application inventory contains 243 failures: 242
model-panel failures and 1
deterministic replay failure. Raw infrastructure-blocked outcomes are
separated below and are not counted as application failures.

## Raw program-check infrastructure observations

The original Vally JSONL remains unchanged. Its program grader recorded:

| Raw outcome | Baseline | Azure skills + MCP | Full Java SDK skills | Total |
|---|---:|---:|---:|---:|
| `spawnSync mvn ENOENT` | 29 | 30 | 30 | 89 |
| No supported Java build manifest | 1 | 0 | 0 | 1 |

The 89 ENOENT rows are harness-environment failures and are excluded from
the application inventory. The no-manifest outcome is included only if the
authoritative replay independently reproduced it.

## Frequency by criterion

| Group | Criterion | Total | Baseline | Azure skills + MCP | Full Java SDK skills |
|---|---|---:|---:|---:|---:|
| language | `language/azure-sdk-bom-for-version-management` | 81 | 25 | 27 | 29 |
| language | `language/service-specific-exception-handling` | 37 | 10 | 14 | 13 |
| language | `language/lro-pattern-syncpoller-pollerflux` | 18 | 7 | 6 | 5 |
| language | `language/pagination-pagediterable-pagedflux` | 14 | 4 | 7 | 3 |
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | 13 | 5 | 4 | 4 |
| language | `language/defaultazurecredential-authentication` | 12 | 5 | 3 | 4 |
| language | `language/client-builder-pattern` | 11 | 5 | 3 | 3 |
| language | `language/correct-imports-no-legacy-no-internal-packages` | 3 | 1 | 1 | 1 |
| prompt | `prompt/catches-cosmosexception-with-status-code-checks-404-409` | 3 | 1 | 1 | 1 |
| prompt | `prompt/catches-event-grid-specific-exceptions-for-publishing-er` | 3 | 1 | 1 | 1 |
| prompt | `prompt/configurable-page-size-via-queryrequestoptions-setmaxite` | 3 | 1 | 1 | 1 |
| prompt | `prompt/logs-continuation-token-and-item-count-per-page` | 3 | 1 | 1 | 1 |
| language | `language/async-uses-project-reactor-mono-flux` | 2 | 1 | 1 | 0 |
| language | `language/try-with-resources-for-clients` | 2 | 1 | 1 | 0 |
| prompt | `prompt/implements-conditional-reads-with-matchconditions-setifn` | 2 | 1 | 0 | 1 |
| prompt | `prompt/retrieves-settings-with-a-specific-label-parameter-using` | 2 | 1 | 1 | 0 |
| prompt | `prompt/servicebusclientbuilder-with-connection-string` | 2 | 0 | 1 | 1 |
| language | `language/no-deprecated-legacy-classes` | 1 | 1 | 0 | 0 |
| program | `program/java-project-compiles` | 1 | 1 | 0 | 0 |
| prompt | `prompt/builds-persistentagentsclient-with-persistentagentsclien` | 1 | 0 | 0 | 1 |
| prompt | `prompt/calls-getcredentials-for-that-exact-version-combines-dat` | 1 | 0 | 1 | 0 |
| prompt | `prompt/chainedtokencredentialbuilder-for-local-fallback` | 1 | 0 | 0 | 1 |
| prompt | `prompt/cleans-up-created-cloud-resources-safely` | 1 | 1 | 0 | 0 |
| prompt | `prompt/credentialunavailableexception-when-not-in-azure` | 1 | 0 | 1 | 0 |
| prompt | `prompt/detects-sentinel-value-change-via-etag-or-value-comparis` | 1 | 1 | 0 | 0 |
| prompt | `prompt/does-not-manually-parse-json-without-the-sdks-deserializ` | 1 | 1 | 0 | 0 |
| prompt | `prompt/handles-304-not-modified-setting-unchanged-since-last-re` | 1 | 1 | 0 | 0 |
| prompt | `prompt/handles-cloudevents-1-0-schema-via-cloudevent-fromstring` | 1 | 1 | 0 | 0 |
| prompt | `prompt/handles-event-grid-native-schema-via-eventgridevent-from` | 1 | 1 | 0 | 0 |
| prompt | `prompt/handles-lifecycle-errors-and-bounded-waits` | 1 | 1 | 0 | 0 |
| prompt | `prompt/implements-deterministic-percentage-rollout-consistent-h` | 1 | 1 | 0 | 0 |
| prompt | `prompt/implements-sentinel-key-watching-with-configurable-polli` | 1 | 1 | 0 | 0 |
| prompt | `prompt/includes-meaningful-offline-automated-tests` | 1 | 1 | 0 | 0 |
| prompt | `prompt/ingests-product-documentation-and-waits-for-retrieval-readiness` | 1 | 1 | 0 | 0 |
| prompt | `prompt/lists-settings-filtered-by-key-prefix-using-setkeyfilter` | 1 | 1 | 0 | 0 |
| prompt | `prompt/parses-the-json-payload-in-feature-flag-setting-values` | 1 | 1 | 0 | 0 |
| prompt | `prompt/passes-the-four-supplied-values-to-texttranslationclient` | 1 | 0 | 1 | 0 |
| prompt | `prompt/polls-through-runs-retrieve-until-an-explicit-terminal-s` | 1 | 0 | 1 | 0 |
| prompt | `prompt/preserves-isolated-multi-turn-conversations` | 1 | 1 | 0 | 0 |
| prompt | `prompt/prints-both-transliteratedtext-gettext-and-transliterate` | 1 | 0 | 1 | 0 |
| prompt | `prompt/reads-a-returned-transliteratedtext-rather-than-a-transl` | 1 | 0 | 1 | 0 |
| prompt | `prompt/records-unsupported-questions-for-follow-up` | 1 | 1 | 0 | 0 |
| prompt | `prompt/records-validated-response-specific-feedback` | 1 | 1 | 0 | 0 |
| prompt | `prompt/returns-grounded-answers-with-service-citations` | 1 | 1 | 0 | 0 |
| prompt | `prompt/runs-extensible-groundedness-and-relevance-evaluation` | 1 | 1 | 0 | 0 |
| prompt | `prompt/selects-coherent-current-foundry-and-azure-sdks` | 1 | 1 | 0 | 0 |
| prompt | `prompt/uses-a-foundry-managed-prompt-agent` | 1 | 1 | 0 | 0 |
| prompt | `prompt/uses-appconfig-featureflag-prefix-for-feature-flag-keys` | 1 | 1 | 0 | 0 |
| prompt | `prompt/writes-the-returned-binarydata-tobytes-directly-to-the-o` | 1 | 0 | 1 | 0 |

## Spot-check interpretation

- **Deterministic replay:** the unchanged main checker produced 89 successful
  Maven compiles and one no-manifest failure. There were no compiler errors to
  diagnose. Each of the 90 outcomes has a complete log under
  `reports/java-main-baseline/20260908T005600Z/program-replay/logs/`.
- **No-manifest failure:** baseline
  `app-configuration-java-feature-flags` had the sole empty retained patch,
  zero generated files in the reconstruction manifest, and no `pom.xml` or
  Gradle manifest. The replay independently reproduced the checker's exact
  no-manifest message; its log is
  `program-replay/logs/b/app-configuration-java-feature-flags.log`.
- **Infrastructure isolation:** the 89 raw ENOENT results and the Node 24
  Maven-launch probes are kept only in the infrastructure section. The
  recorded `mvn.exe` shim delegates unchanged arguments and exit status to
  pinned Maven 3.9.16; it does not modify the checker or generated projects.

- **Azure SDK BOM:** representative projects among the 81 failures either
  omitted `azure-sdk-bom` while pinning individual Azure dependencies or
  imported the BOM and then overrode Azure artifact versions. Those sampled
  failures match the criterion.
- **LRO poller pattern:** the nine failed occurrences across the three
  persistent-agent scenarios are an obvious rubric applicability error. The
  generated code's `Thread.sleep(...)` plus `getRun(...)` polling follows the
  pinned `azure-ai-agents-persistent-java` skill, whereas the generic
  criterion requires `SyncPoller`/`PollerFlux`, a shape not exposed by that
  API. This finding is not extended to the other nine LRO failures.
- **Pagination type pattern:** all three Cosmos ToDo variants preserve pages
  and continuation tokens through custom
  `Iterable<ToDoPage>`/`Flux<ToDoPage>` wrappers. Rejecting those
  behavior-preserving wrappers solely for not using literal
  `PagedIterable`/`PagedFlux` types is ambiguous. The other 11 pagination
  failures were not classified by this spot check.
- **Service-specific exceptions:** an inspected persistent-agent diff allowed
  SDK exceptions to propagate without scenario-level handling, supporting
  that sampled judge decision.

The detailed model reasons below are judge-recorded potential rationales, not
independently reproduced root causes. Program rows are independently replayed
outcomes. The spot checks are limited to representative high-frequency
categories.

## Every failed occurrence

## Baseline

### ai-agents-java-basic-agent-lifecycle

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom does not import azure-sdk-bom and instead hardcodes versions on both Azure dependencies. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Run completion is implemented with an explicit Thread.sleep polling loop rather than SyncPoller/PollerFlux and a begin-style operation. |
| language | `language/service-specific-exception-handling` | There is no service-specific exception handling or HTTP status inspection. |

### ai-agents-java-file-search

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement import and hardcodes versions on both Azure dependencies. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Both vector-store and run polling are implemented as manual Thread.sleep loops rather than SyncPoller/PollerFlux begin-operation patterns. |
| language | `language/service-specific-exception-handling` | Remote cleanup failures are caught only as generic RuntimeException, with no HttpResponseException or other service-specific handling and no HTTP status inspection. |

### ai-agents-java-function-tool

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement section and hardcodes versions for both Azure artifacts. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Run progress is polled with an explicit Thread.sleep loop rather than a SyncPoller/begin-style LRO pattern, directly violating this criterion's no-sleep requirement. |
| language | `language/service-specific-exception-handling` | Azure service failures are not caught or inspected as HttpResponseException or another service-specific exception; main merely propagates generic Exception. |

### ai-projects-java-dataset-lifecycle

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | Although azure-sdk-bom is imported and dependency declarations omit versions, the project separately hardcodes azure-ai-projects and azure-storage-blob versions as individual dependencyManagement entries, rather than having the BOM manage those versions. |

### ai-projects-java-evaluation-run

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom has no azure-sdk-bom dependencyManagement section and hardcodes versions on both Azure dependencies. |
| language | `language/pagination-pagediterable-pagedflux` | Pagination uses the OpenAI client's autoPager rather than an Azure PagedIterable or PagedFlux as explicitly required by this criterion, even though it does avoid collecting pages in memory. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Run completion is implemented as a manual Thread.sleep polling loop rather than SyncPoller/PollerFlux with a begin-style operation. |
| language | `language/service-specific-exception-handling` | There is no service-specific exception handling or HTTP status inspection; service failures are simply allowed to propagate. |

### ai-projects-java-project-resource-inventory

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM does not import azure-sdk-bom under dependencyManagement; it hardcodes separate azure-ai-projects and azure-identity versions via properties. |

### app-configuration-java-config-values

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The project hardcodes the azure-data-appconfiguration version and has no azure-sdk-bom dependencyManagement entry. |
| language | `language/defaultazurecredential-authentication` | The client authenticates with a connection string rather than DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | A client builder is used, but it uses connectionString() rather than the endpoint() and credential() pattern explicitly required by this criterion. |

### app-configuration-java-feature-flags

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/retrieves-settings-with-a-specific-label-parameter-using` | No judge rationale recorded. |
| prompt | `prompt/lists-settings-filtered-by-key-prefix-using-setkeyfilter` | No judge rationale recorded. |
| prompt | `prompt/implements-conditional-reads-with-matchconditions-setifn` | No judge rationale recorded. |
| prompt | `prompt/handles-304-not-modified-setting-unchanged-since-last-re` | No judge rationale recorded. |
| prompt | `prompt/uses-appconfig-featureflag-prefix-for-feature-flag-keys` | No judge rationale recorded. |
| prompt | `prompt/parses-the-json-payload-in-feature-flag-setting-values` | No judge rationale recorded. |
| prompt | `prompt/implements-deterministic-percentage-rollout-consistent-h` | No judge rationale recorded. |
| prompt | `prompt/implements-sentinel-key-watching-with-configurable-polli` | No judge rationale recorded. |
| prompt | `prompt/detects-sentinel-value-change-via-etag-or-value-comparis` | No judge rationale recorded. |
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | No pom.xml or Azure SDK BOM configuration exists. |
| language | `language/correct-imports-no-legacy-no-internal-packages` | No judge rationale recorded. |
| language | `language/defaultazurecredential-authentication` | No authentication implementation using DefaultAzureCredential or another Azure Identity credential exists. |
| language | `language/client-builder-pattern` | No Azure SDK client construction is present. |
| language | `language/no-deprecated-legacy-classes` | No implementation was submitted, so the required modern SDK-based project is not demonstrated. |
| language | `language/pagination-pagediterable-pagedflux` | No sync or async list/query implementation using PagedIterable or PagedFlux exists. |
| language | `language/lro-pattern-syncpoller-pollerflux` | No project or operations were implemented, so compliant operation handling cannot be credited. |
| language | `language/async-uses-project-reactor-mono-flux` | No asynchronous service implementation using Mono or Flux was provided. |
| language | `language/service-specific-exception-handling` | No service-specific exception handling or status-code inspection is present. |
| language | `language/try-with-resources-for-clients` | No Azure clients or resource lifecycle management code was submitted. |
| program | `program/java-project-compiles` | No supported Java build manifest found; expected pom.xml, build.gradle, or build.gradle.kts Full output: `reports/java-main-baseline/20260908T005600Z/program-replay/logs/b/app-configuration-java-feature-flags.log`. |

### cosmos-db-java-crud-items

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The implementation hardcodes azure-cosmos version 4.72.0 and provides no azure-sdk-bom dependencyManagement entry. |
| language | `language/defaultazurecredential-authentication` | Authentication uses an account key from COSMOS_KEY instead of DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | The client does use CosmosClientBuilder and endpoint(), but this criterion specifically requires credential()-based construction; the code uses key() instead. |

### cosmos-db-java-todo-repository

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/configurable-page-size-via-queryrequestoptions-setmaxite` | No judge rationale recorded. |
| prompt | `prompt/logs-continuation-token-and-item-count-per-page` | No judge rationale recorded. |
| prompt | `prompt/catches-cosmosexception-with-status-code-checks-404-409` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | Azure Cosmos and Identity versions are individually hardcoded through properties; no `azure-sdk-bom` dependency management is present. |
| language | `language/pagination-pagediterable-pagedflux` | Although pagination is preserved behaviorally, the public query methods return custom `Iterable<ToDoPage>` and `Flux<ToDoPage>` types rather than the SDK `CosmosPagedIterable`/`CosmosPagedFlux` types required by this criterion. |

### document-translation-java-batch-container

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement import and hardcodes versions for both Azure artifacts. |
| language | `language/service-specific-exception-handling` | The application provides no service-specific exception handling or HTTP status-code inspection. |

### document-translation-java-single-document

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement import and instead hardcodes versions on both Azure artifacts. |

### event-hubs-java-send-receive-events

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | No azure-sdk-bom dependencyManagement import is present; Azure artifact versions are hardcoded individually. |
| language | `language/defaultazurecredential-authentication` | Authentication uses connection strings from environment variables rather than DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | Although builders are used, clients are configured through connectionString() rather than the criterion's required endpoint/credential builder pattern. |
| language | `language/service-specific-exception-handling` | The implementation has no service-specific Azure exception handling or status-code inspection for producer, processor, or Blob failures. |

### foundry-java-support-assistant

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/selects-coherent-current-foundry-and-azure-sdks` | No judge rationale recorded. |
| prompt | `prompt/uses-a-foundry-managed-prompt-agent` | The visible evidence contains a gateway interface and README assertions, but not the concrete agent-creation and agent-invocation REST operations. Those declarations alone do not prove creation of a managed prompt agent after readiness, binding of retrieval, or use of the returned agent identity for answers and evaluations. |
| prompt | `prompt/ingests-product-documentation-and-waits-for-retrieval-readiness` | No judge rationale recorded. |
| prompt | `prompt/returns-grounded-answers-with-service-citations` | No judge rationale recorded. |
| prompt | `prompt/preserves-isolated-multi-turn-conversations` | Controller parameters and a createConversation gateway method are visible, but the durable employeeId+conversationId mapping, persistence, and reuse implementation is not shown. Thus restart-safe isolation cannot be verified from the evidence. |
| prompt | `prompt/records-unsupported-questions-for-follow-up` | An unresolved admin route exists, but the supplied visible code does not show unsupported-answer detection or an atomic/durable unresolved record containing the required question, response ID, timestamp, and employee-scoped conversation key. |
| prompt | `prompt/records-validated-response-specific-feedback` | No judge rationale recorded. |
| prompt | `prompt/runs-extensible-groundedness-and-relevance-evaluation` | No judge rationale recorded. |
| prompt | `prompt/handles-lifecycle-errors-and-bounded-waits` | FoundryException carries only a message/cause and no structured HTTP status or service code. The visible evidence does not establish delayed bounded polling across failed, canceled, and timeout states or status-aware service diagnostics. |
| prompt | `prompt/cleans-up-created-cloud-resources-safely` | FoundryGateway exposes deletion for agents, vector stores, and files but no deletion for the application-created conversations/threads. The visible code also does not demonstrate dependency-safe ordering or retaining ownership records after partial remote deletion failures. |
| prompt | `prompt/includes-meaningful-offline-automated-tests` | The manifest includes the test dependency, but no executable test code is visible demonstrating the four required behaviors: conversation isolation/follow-up, feedback mismatch rejection, retrieved evaluator context, and atomicity or compensation. |
| language | `language/azure-sdk-bom-for-version-management` | The pom hardcodes separate azure-identity and azure-cosmos versions and has no azure-sdk-bom dependencyManagement import. |
| language | `language/pagination-pagediterable-pagedflux` | The admin API exposes unresolved results as a raw List and the visible evidence does not demonstrate preserving Cosmos query pagination through PagedIterable/PagedFlux rather than materializing all records. |
| language | `language/lro-pattern-syncpoller-pollerflux` | The design uses a custom REST gateway rather than an Azure SDK begin* operation with SyncPoller or PollerFlux, and no compliant LRO implementation is evidenced. |
| language | `language/service-specific-exception-handling` | The visible exception handling uses a generic custom FoundryException and does not show CosmosException, HttpResponseException, or another service-specific exception being caught with status/error-code inspection. |

### identity-java-credential-chain

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom hardcodes separate azure-identity and azure-identity-broker versions and has no azure-sdk-bom dependencyManagement section. |

### identity-java-managed-identity-auth

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes versions for azure-identity and azure-storage-blob and does not import azure-sdk-bom in dependencyManagement. |

### identity-java-service-principal-auth

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The project hardcodes separate azure-identity and Key Vault artifact versions and does not use azure-sdk-bom in dependencyManagement. |

### key-vault-java-crud-secrets

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes versions on both Azure dependencies and has no azure-sdk-bom dependencyManagement entry. |

### key-vault-java-secret-config

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate versions for `azure-identity` and `azure-security-keyvault-secrets` and has no Azure SDK BOM in `dependencyManagement`. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Although deletion uses Azure pollers, the sync purge-confirmation path uses a manual sleep-based polling loop, violating the criterion's explicit prohibition on `Thread.sleep()` polling loops. |

### resource-manager-java-resource-group-crud

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure-identity and azure-resourcemanager versions and has no azure-sdk-bom dependencyManagement import. |

### service-bus-java-order-processor

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure.identity.version and azure.servicebus.version values and has no azure-sdk-bom dependencyManagement section. |
| language | `language/service-specific-exception-handling` | The code does not catch or inspect ServiceBusException or HttpResponseException status/error details; its explicit error handling is for deserialization/recovery rather than Azure service failures. |

### service-bus-java-send-receive-messages

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The implementation hardcodes azure-messaging-servicebus version 7.17.15 and provides no azure-sdk-bom dependencyManagement entry. |
| language | `language/defaultazurecredential-authentication` | Authentication uses a connection string rather than DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | Although ServiceBusClientBuilder is used, it is configured with connectionString rather than the criterion's required endpoint/credential builder authentication pattern. |
| language | `language/service-specific-exception-handling` | No ServiceBusException or HttpResponseException is caught and inspected; the processor error callback only prints the exception message. |

### storage-java-blob-event-notifier

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/handles-event-grid-native-schema-via-eventgridevent-from` | No judge rationale recorded. |
| prompt | `prompt/handles-cloudevents-1-0-schema-via-cloudevent-fromstring` | No judge rationale recorded. |
| prompt | `prompt/does-not-manually-parse-json-without-the-sdks-deserializ` | No judge rationale recorded. |
| prompt | `prompt/catches-event-grid-specific-exceptions-for-publishing-er` | No judge rationale recorded. |

### storage-java-crud-blobs

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | No azure-sdk-bom dependencyManagement entry is present; versions are hardcoded separately on both Azure dependencies. |

### text-translation-java-multilingual-translation

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom has no azure-sdk-bom dependencyManagement import and hardcodes versions on both Azure dependencies. |

### text-translation-java-transliteration

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement import and instead hardcodes versions on both Azure dependencies. |

## Azure skills + MCP

### ai-agents-java-basic-agent-lifecycle

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure-ai-agents-persistent and azure-identity versions and has no azure-sdk-bom dependencyManagement import. |
| language | `language/lro-pattern-syncpoller-pollerflux` | The implementation performs manual polling with Thread.sleep() rather than using a SyncPoller/begin* long-running-operation pattern. |
| language | `language/service-specific-exception-handling` | The application does not catch or inspect HttpResponseException or another service-specific Azure exception. |

### ai-agents-java-file-search

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom has no azure-sdk-bom dependencyManagement section and hardcodes versions on both Azure SDK dependencies. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Vector-store and run polling are implemented as custom loops calling Thread.sleep(), explicitly violating the criterion's prohibition on sleep-based polling rather than using an SDK poller pattern. |
| language | `language/service-specific-exception-handling` | Cleanup catches only generic Exception and performs no service-specific exception handling or HTTP status-code inspection. |

### ai-agents-java-function-tool

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM does not import azure-sdk-bom and instead hardcodes versions on both Azure SDK dependencies. |
| language | `language/pagination-pagediterable-pagedflux` | Although listMessages is iterated as a pageable result, every page is flattened into an in-memory ArrayList before sorting. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Run progress is implemented with an explicit Thread.sleep polling loop rather than a SyncPoller/begin-style LRO pattern. |
| language | `language/service-specific-exception-handling` | Azure service operations have no service-specific HttpResponseException handling or status-code inspection. |

### ai-projects-java-dataset-lifecycle

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/calls-getcredentials-for-that-exact-version-combines-dat` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement and hardcodes versions on every Azure dependency. |
| language | `language/service-specific-exception-handling` | The application does not catch or inspect any Azure service-specific exception despite making project and blob service calls. |

### ai-projects-java-evaluation-run

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/polls-through-runs-retrieve-until-an-explicit-terminal-s` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | There is no azure-sdk-bom dependencyManagement import; both Azure artifact versions are hardcoded individually. |
| language | `language/pagination-pagediterable-pagedflux` | The list operation uses the OpenAI SDK's OutputItemListPage/autoPager rather than the criterion's required Azure PagedIterable or PagedFlux type. |
| language | `language/lro-pattern-syncpoller-pollerflux` | The run is polled with an explicit Thread.sleep loop, directly violating this criterion's prohibition on such polling and not using SyncPoller or PollerFlux. |
| language | `language/service-specific-exception-handling` | The application contains no service-specific exception handling or HTTP status-code inspection. |

### ai-projects-java-project-resource-inventory

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement import and instead hardcodes versions on azure-ai-projects and azure-identity. |

### app-configuration-java-config-values

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The code hardcodes azure-data-appconfiguration version 1.10.0 and does not import azure-sdk-bom in dependencyManagement. |
| language | `language/defaultazurecredential-authentication` | Authentication uses a connection string rather than DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | A modern builder is used, but it is configured with connectionString rather than the criterion's required endpoint and credential pattern. |

### app-configuration-java-feature-flags

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/retrieves-settings-with-a-specific-label-parameter-using` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | No azure-sdk-bom dependencyManagement section is present; Azure artifact versions are hardcoded through individual properties. |
| language | `language/pagination-pagediterable-pagedflux` | The service list APIs return Map/Mono<Map> and consume all pages into an in-memory map rather than exposing PagedIterable or PagedFlux. |
| language | `language/service-specific-exception-handling` | Polling catches RuntimeException or generic reactive exceptions and merely logs them; it does not catch HttpResponseException or inspect service status codes. |

### cosmos-db-java-crud-items

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The project hardcodes the azure-cosmos version and has no azure-sdk-bom dependencyManagement entry. |
| language | `language/defaultazurecredential-authentication` | Authentication uses an account key from COSMOS_KEY rather than DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | CosmosClientBuilder and endpoint() are used, but authentication is configured with key() rather than the criterion-required credential(). |

### cosmos-db-java-todo-repository

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/configurable-page-size-via-queryrequestoptions-setmaxite` | No judge rationale recorded. |
| prompt | `prompt/logs-continuation-token-and-item-count-per-page` | No judge rationale recorded. |
| prompt | `prompt/catches-cosmosexception-with-status-code-checks-404-409` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate `azure-cosmos` and `azure-identity` versions and has no `azure-sdk-bom` dependency management. |
| language | `language/pagination-pagediterable-pagedflux` | Although processing is page-wise, the repository APIs expose a callback/ordinary `Flux<CosmosQueryPage<...>>`, not `PagedIterable` for sync and `PagedFlux`/`CosmosPagedFlux` for async as this criterion explicitly requires. |

### document-translation-java-batch-container

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement import and instead hardcodes versions on both Azure dependencies. |
| language | `language/service-specific-exception-handling` | The application has no service-specific exception handling or HTTP status-code inspection. |

### document-translation-java-single-document

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/writes-the-returned-binarydata-tobytes-directly-to-the-o` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes versions for azure-ai-translation-document and azure-identity and has no azure-sdk-bom dependencyManagement import. |

### event-hubs-java-send-receive-events

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | No azure-sdk-bom dependencyManagement section is present; Azure artifact versions are hardcoded individually. |
| language | `language/defaultazurecredential-authentication` | Authentication uses Event Hubs and Storage connection strings rather than DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | Builders are used, but the rubric specifically requires endpoint/vaultUrl plus credential configuration; this code instead configures connection strings. |
| language | `language/async-uses-project-reactor-mono-flux` | The code constructs a BlobContainerAsyncClient but immediately calls .block() on createIfNotExists(), contrary to the rubric's async non-blocking requirement. |
| language | `language/service-specific-exception-handling` | No service-specific Azure exception handling or status-code inspection is implemented. |

### foundry-java-support-assistant

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM does not import azure-sdk-bom and instead hardcodes separate versions for azure-identity, azure-ai-agents, and azure-cosmos. |
| language | `language/pagination-pagediterable-pagedflux` | Repository/list and REST result paths materialize records/output pages into Java List values for service/controller responses rather than exposing SDK PagedIterable or PagedFlux throughout. |
| language | `language/lro-pattern-syncpoller-pollerflux` | The Foundry file-ingestion and evaluation long-running operations are handled by application polling rather than an SDK begin* operation returning SyncPoller or PollerFlux; the criterion specifically requires the Azure LRO pattern. |
| language | `language/try-with-resources-for-clients` | The AutoCloseable CosmosClient is a singleton bean closed via Spring's destroy method, not used in try-with-resources or explicitly closed in a finally block as this criterion requires. |

### identity-java-credential-chain

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom hardcodes azure-identity.version and has no azure-sdk-bom dependencyManagement import. |

### identity-java-default-azure-credential

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The implementation hardcodes versions on both Azure artifacts and only suggests the BOM in prose; it does not import azure-sdk-bom in dependencyManagement. |

### identity-java-managed-identity-auth

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/credentialunavailableexception-when-not-in-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure-identity and azure-storage-blob versions and has no azure-sdk-bom dependencyManagement section. |

### identity-java-service-principal-auth

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/correct-imports-no-legacy-no-internal-packages` | No judge rationale recorded. |
| language | `language/pagination-pagediterable-pagedflux` | Although listBlobContainers returns a paged iterable, every container name is accumulated into an ArrayList before output, flattening all pages into an in-memory raw list. |

### key-vault-java-crud-secrets

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The project does not import azure-sdk-bom in dependencyManagement and instead hardcodes separate versions on both Azure dependencies. |

### resource-manager-java-resource-group-crud

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure-resourcemanager and azure-identity version properties and does not import azure-sdk-bom in dependencyManagement. |
| language | `language/service-specific-exception-handling` | Although it catches management-specific ManagementException and ClientAuthenticationException, it does not inspect an HTTP/status code as explicitly required by this criterion. |

### service-bus-java-order-processor

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM does not import azure-sdk-bom and instead hardcodes separate azure.identity.version and azure.servicebus.version properties on the dependencies. |
| language | `language/service-specific-exception-handling` | The implementation does not catch ServiceBusException or HttpResponseException and inspect service error/status details; its explicit catch is only generic Exception for deserialization. |

### service-bus-java-send-receive-messages

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/servicebusclientbuilder-with-connection-string` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | There is no azure-sdk-bom dependencyManagement import; Azure artifact versions are hardcoded individually. |
| language | `language/service-specific-exception-handling` | The program does not catch or inspect ServiceBusException or HttpResponseException, so it provides no service-specific exception handling. |

### storage-java-account-mgmt

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | No azure-sdk-bom dependencyManagement is present; both Azure artifacts have individually hardcoded versions. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Creation and deletion are long-running management operations, but the code uses blocking create() and deleteByResourceGroup() rather than begin* APIs with SyncPoller or PollerFlux. |
| language | `language/service-specific-exception-handling` | Although it catches ManagementException and authentication exceptions, it never inspects an HTTP/status code as this criterion requires. |

### storage-java-blob-event-notifier

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/catches-event-grid-specific-exceptions-for-publishing-er` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The pom hardcodes separate versions for azure-identity, azure-messaging-eventgrid, and azure-storage-blob and has no azure-sdk-bom dependencyManagement section. |

### storage-java-blob-storage-manager

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure-storage-blob and azure-identity versions and has no azure-sdk-bom dependencyManagement import. |
| language | `language/pagination-pagediterable-pagedflux` | The async list API is declared as Flux<BlobItem> rather than PagedFlux<BlobItem>; the sync service also imports List, indicating pagination is flattened rather than exposed as PagedIterable. |
| language | `language/service-specific-exception-handling` | The shown implementation does not catch BlobStorageException or inspect Azure service status/error codes; errors are merely propagated. |

### storage-java-crud-blobs

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate versions on both Azure artifacts and does not use azure-sdk-bom in dependencyManagement. |

### storage-java-encrypted-uploader

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/service-specific-exception-handling` | Although it maps BlobStorageException and HttpResponseException specifically, the shown handlers do not inspect HTTP/status error codes as this criterion explicitly requires. |

### text-translation-java-multilingual-translation

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom has no azure-sdk-bom dependencyManagement import and hardcodes versions on both Azure dependencies. |

### text-translation-java-transliteration

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/passes-the-four-supplied-values-to-texttranslationclient` | No judge rationale recorded. |
| prompt | `prompt/reads-a-returned-transliteratedtext-rather-than-a-transl` | No judge rationale recorded. |
| prompt | `prompt/prints-both-transliteratedtext-gettext-and-transliterate` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The POM does not import azure-sdk-bom and instead hardcodes versions on both Azure dependencies. |

## Full Java SDK skills

### ai-agents-java-basic-agent-lifecycle

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/builds-persistentagentsclient-with-persistentagentsclien` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | There is no azure-sdk-bom dependencyManagement import; Azure dependency versions are hardcoded individually. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Run progress is implemented with an explicit Thread.sleep polling loop rather than SyncPoller/PollerFlux and a begin* operation. |
| language | `language/service-specific-exception-handling` | Cleanup catches only RuntimeException and performs no HttpResponseException or service-specific status-code inspection. |

### ai-agents-java-file-search

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes versions for azure-ai-agents-persistent and azure-identity and has no azure-sdk-bom dependencyManagement section. |
| language | `language/correct-imports-no-legacy-no-internal-packages` | No judge rationale recorded. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Both vector-store and run polling are implemented as explicit Thread.sleep loops rather than SyncPoller/PollerFlux begin-operation patterns. |
| language | `language/service-specific-exception-handling` | Cleanup catches only generic RuntimeException and performs no Azure service-specific exception handling or HTTP status-code inspection. |

### ai-agents-java-function-tool

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The manifest has no azure-sdk-bom dependencyManagement section and hardcodes versions on individual Azure dependencies. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Run completion is implemented with a manual Thread.sleep polling loop rather than a SyncPoller/begin* long-running-operation pattern, directly violating the criterion. |
| language | `language/service-specific-exception-handling` | Azure service calls have no HttpResponseException or other service-specific catch with status-code inspection; only JSON processing exceptions are handled. |

### ai-projects-java-dataset-lifecycle

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement section and hardcodes versions on every Azure artifact. |
| language | `language/service-specific-exception-handling` | Service operations are handled only through a broad RuntimeException catch, with no BlobStorageException or HttpResponseException handling and no status-code inspection. |

### ai-projects-java-evaluation-run

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement import and hardcodes versions on both Azure dependencies. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Run completion is implemented with an explicit Thread.sleep() polling loop rather than a SyncPoller/begin-style LRO pattern, which this criterion expressly prohibits. |
| language | `language/service-specific-exception-handling` | The application does not catch or inspect any service-specific HTTP/Azure exception, so it does not provide the required service-specific exception handling. |

### ai-projects-java-project-resource-inventory

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM has no azure-sdk-bom dependencyManagement import and hardcodes versions separately on azure-ai-projects and azure-identity. |

### app-configuration-java-config-values

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The Azure dependency version is hardcoded and no azure-sdk-bom dependencyManagement section is present. |
| language | `language/defaultazurecredential-authentication` | The implementation uses connection-string authentication rather than DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | A builder is used, but authentication is configured through connectionString() rather than the criterion's required endpoint() and credential() pattern. |

### app-configuration-java-feature-flags

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/implements-conditional-reads-with-matchconditions-setifn` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The POM does not import azure-sdk-bom and instead hardcodes separate versions for Azure artifacts. |

### cosmos-db-java-crud-items

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The azure-cosmos version is hardcoded directly and no azure-sdk-bom dependencyManagement section is present. |
| language | `language/defaultazurecredential-authentication` | Authentication uses an account key from COSMOS_KEY rather than DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | It uses CosmosClientBuilder and endpoint(), but authenticates with key() rather than the criterion-required credential() pattern. |

### cosmos-db-java-todo-repository

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/configurable-page-size-via-queryrequestoptions-setmaxite` | No judge rationale recorded. |
| prompt | `prompt/logs-continuation-token-and-item-count-per-page` | No judge rationale recorded. |
| prompt | `prompt/catches-cosmosexception-with-status-code-checks-404-409` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | Azure Cosmos and Identity versions are individually hardcoded; no `azure-sdk-bom` dependency management is present. |
| language | `language/pagination-pagediterable-pagedflux` | Although processing is paged, the public query APIs return a callback-driven result and `Flux<QueryPage<...>>`, not `CosmosPagedIterable`/`CosmosPagedFlux` as this criterion explicitly requires. |

### document-translation-java-batch-container

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM does not import azure-sdk-bom in dependencyManagement and instead hardcodes versions for azure-ai-translation-document and azure-identity. |
| language | `language/service-specific-exception-handling` | The application provides no service-specific exception handling or HTTP status inspection for Azure service failures; its only catch handles URI parsing. |

### document-translation-java-single-document

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM does not import azure-sdk-bom in dependencyManagement and instead hardcodes versions on both Azure dependencies. |
| language | `language/service-specific-exception-handling` | The service call is not surrounded by handling for HttpResponseException or another Azure service exception with status-code inspection; only local IllegalArgumentException and IOException are caught. |

### event-hubs-java-send-receive-events

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes versions on individual Azure dependencies and has no azure-sdk-bom dependencyManagement entry. |
| language | `language/defaultazurecredential-authentication` | Authentication uses Event Hubs and Storage connection strings from environment variables rather than DefaultAzureCredential or another com.azure.identity credential. |
| language | `language/client-builder-pattern` | Although builder classes are used and no legacy constructors appear, the clients are configured with connectionString() rather than the criterion's required endpoint/vaultUrl plus credential pattern. |
| language | `language/service-specific-exception-handling` | No service-specific Azure exceptions are caught or inspected; failures simply propagate. |

### foundry-java-support-assistant

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM does not import azure-sdk-bom and instead hardcodes separate Azure artifact versions through project properties and dependency version tags. |
| language | `language/pagination-pagediterable-pagedflux` | The custom REST evaluation/output traversal and repository query paths materialize paged results into application Lists rather than preserving PagedIterable/PagedFlux pagination. |
| language | `language/lro-pattern-syncpoller-pollerflux` | Long-running ingestion/evaluation readiness is implemented with explicit status polling and delay loops rather than Azure SDK begin* operations with SyncPoller or PollerFlux. |
| language | `language/service-specific-exception-handling` | The visible gateway imports do not include or catch HttpResponseException or another listed Azure service-specific exception with status inspection; custom REST/general error handling does not satisfy this Azure SDK-specific criterion. |

### identity-java-credential-chain

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom hardcodes azure-identity.version directly and has no azure-sdk-bom dependencyManagement section. |

### identity-java-default-azure-credential

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom hardcodes versions on individual Azure dependencies and does not declare azure-sdk-bom in dependencyManagement. |

### identity-java-managed-identity-auth

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/chainedtokencredentialbuilder-for-local-fallback` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure-identity and azure-storage-blob versions and has no azure-sdk-bom dependencyManagement import. |

### key-vault-java-crud-secrets

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate versions for the Azure artifacts and has no azure-sdk-bom dependencyManagement import. |

### key-vault-java-secret-config

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure-identity and azure-security-keyvault-secrets versions and has no azure-sdk-bom dependencyManagement import. |

### resource-manager-java-resource-group-crud

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure-resourcemanager and azure-identity versions and has no azure-sdk-bom dependencyManagement import. |
| language | `language/service-specific-exception-handling` | Although HttpResponseException is caught, the handler only logs a generic request-failed message and does not inspect the HTTP status code as required. |

### service-bus-java-order-processor

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure.identity.version and azure.servicebus.version values and has no azure-sdk-bom dependencyManagement section. |
| language | `language/service-specific-exception-handling` | The code handles message-processing failures via RuntimeException and callback error contexts, but does not catch ServiceBusException or HttpResponseException and inspect service error/status details as required by this criterion. |

### service-bus-java-send-receive-messages

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/servicebusclientbuilder-with-connection-string` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | There is no azure-sdk-bom dependencyManagement section; both Azure artifact versions are hardcoded. |
| language | `language/service-specific-exception-handling` | No service-specific exception is caught or inspected; the processor error callback only logs the supplied exception. |

### storage-java-account-mgmt

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate versions for azure-resourcemanager-storage and azure-identity and has no azure-sdk-bom dependencyManagement import. |
| language | `language/service-specific-exception-handling` | Although ManagementException and authentication exceptions are caught, the ManagementException handler does not inspect an HTTP/status code as required by this criterion. |

### storage-java-blob-event-notifier

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| prompt | `prompt/catches-event-grid-specific-exceptions-for-publishing-er` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate versions for azure-identity, azure-messaging-eventgrid, and azure-storage-blob and has no azure-sdk-bom dependencyManagement section. |

### storage-java-blob-storage-manager

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The POM hardcodes separate azure-storage-blob and azure-identity versions and has no azure-sdk-bom dependencyManagement import. |
| language | `language/pagination-pagediterable-pagedflux` | The sync list method returns PagedIterable, but the async API declares Flux<BlobItem> rather than preserving and returning the SDK PagedFlux type required by the criterion. |

### storage-java-crud-blobs

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | No azure-sdk-bom dependencyManagement entry is present; both Azure dependency versions are hardcoded individually. |

### storage-java-encrypted-uploader

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom hardcodes separate versions for azure-identity, azure-security-keyvault-keys, and azure-storage-blob and does not use azure-sdk-bom dependencyManagement. |

### text-translation-java-multilingual-translation

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/azure-sdk-bom-for-version-management` | The pom has no azure-sdk-bom dependencyManagement import and instead hardcodes versions on both Azure artifacts. |

### text-translation-java-transliteration

| Group | Full criterion name | Judge-recorded potential reason or replay result |
|---|---|---|
| language | `language/correct-dependencies-com-azure-not-com-microsoft-azure` | No judge rationale recorded. |
| language | `language/azure-sdk-bom-for-version-management` | There is no azure-sdk-bom dependencyManagement section; azure-ai-translation-text has a directly hardcoded version. |
| language | `language/defaultazurecredential-authentication` | Authentication uses AzureKeyCredential with an API key from the environment rather than DefaultAzureCredential or another com.azure.identity credential. |
