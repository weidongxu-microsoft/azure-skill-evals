# Java preservation run: failed criteria

Run: `f3d83c05-de08-465a-a93c-51e24ca8db94`

This report lists every failed criterion occurrence from the final 90-trial preservation-first run: 200 model-panel failures and one deterministic program-check failure. Reasons are the judge-specific explanations recorded by Vally and are potential diagnoses, not independently reproduced root causes. Separate single-trial generations do not support causal claims about environment effects.

## Failure counts

| Variant | Prompt | Language | Program | Total |
|---|---:|---:|---:|---:|
| `baseline` | 28 | 49 | 1 | 78 |
| `azure-skill-mcp` | 19 | 40 | 0 | 59 |
| `azure-skill-mcp-microsoft-skill` | 20 | 44 | 0 | 64 |

## Most frequent failed criteria

| Criterion | Failed occurrences |
|---|---:|
| `language/azure-sdk-bom-first-version-management` | 80 |
| `language/service-specific-error-diagnostics` | 20 |
| `language/supported-terminal-state-polling` | 12 |
| `language/current-public-azure-sdk-apis` | 7 |
| `language/owned-resource-lifecycle-cleanup` | 6 |
| `prompt/configures-the-synchronous-agents-client` | 4 |
| `language/current-public-client-construction` | 3 |
| `prompt/actionable-authentication-troubleshooting` | 3 |
| `prompt/blob-manager-demo` | 3 |
| `prompt/blob-manager-failures` | 3 |
| `prompt/catches-cosmosexception-with-status-code-checks-404-409` | 3 |
| `prompt/credential-chain-order-in-java-sdk` | 3 |
| `prompt/polls-and-prints-the-assistant-response` | 3 |
| `prompt/polls-and-prints-the-grounded-answer` | 3 |
| `prompt/polls-the-evaluation-run-to-success` | 3 |
| `prompt/prepares-the-vector-store` | 3 |
| `prompt/publishing-failure-handling` | 3 |
| `prompt/service-bus-failure-handling` | 3 |
| `prompt/service-principal-authentication-errors` | 3 |
| `language/current-public-azure-sdk-imports` | 2 |
| `prompt/async-encrypted-round-trip` | 2 |
| `prompt/creates-tooloutput-values-with-each-originating-tool-cal` | 2 |
| `prompt/polls-the-agent-run-to-success` | 2 |
| `language/complete-pageable-traversal` | 1 |
| `language/current-public-azure-sdk-dependencies` | 1 |
| `language/supported-runtime-authentication` | 1 |
| `program/java-project-compiles` | 1 |
| `prompt/batch-sending-creates-servicebusmessagebatch-checks-trya` | 1 |
| `prompt/cleans-up-created-cloud-resources-safely` | 1 |
| `prompt/client-secret-management` | 1 |
| `prompt/creates-the-named-tool-enabled-agent` | 1 |
| `prompt/creates-the-run-with-createrunoptions-containing-the-cre` | 1 |
| `prompt/creates-the-weather-thread-and-run` | 1 |
| `prompt/dead-letter-reprocessing` | 1 |
| `prompt/defines-the-weather-function-tool` | 1 |
| `prompt/deletes-created-agent-resources` | 1 |
| `prompt/detects-runstatus-requires-action-and-submittooloutputsa` | 1 |
| `prompt/downloads-with-the-returned-blob-credential` | 1 |
| `prompt/handles-the-case-where-a-message-doesnt-fit-in-the-curre` | 1 |
| `prompt/includes-meaningful-offline-automated-tests` | 1 |
| `prompt/order-processing-and-settlement` | 1 |
| `prompt/ordered-main-demo` | 1 |
| `prompt/processes-every-requiredfunctiontoolcall-checks-the-func` | 1 |
| `prompt/produces-deterministic-json-by-invoking-local-code-rathe` | 1 |
| `prompt/retrieves-and-prints-dataset-metadata` | 1 |
| `prompt/runs-extensible-groundedness-and-relevance-evaluation` | 1 |
| `prompt/storage-management-failures` | 1 |
| `prompt/uses-a-foundry-managed-prompt-agent` | 1 |

## baseline

### ai-agents-java-basic-agent-lifecycle

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM imports no azure-sdk-bom and explicitly versions the BOM-covered GA azure-identity artifact. |
| language | `language/current-public-azure-sdk-apis` | The run creation call is not consistent with the public beta API shape, which supplies threadId to createRun and agentId in CreateRunOptions; this prevents the supplied application from being reliably buildable against the declared package. |
| language | `language/supported-terminal-state-polling` | Polling has a delay but no deadline, and REQUIRES_ACTION (and any other unlisted non-success status) is repeatedly retrieved forever instead of producing a clear failure. |
| prompt | `prompt/creates-the-run-with-createrunoptions-containing-the-cre` | The shown beta SDK usage appears to use the wrong CreateRunOptions/createRun signature: the public API takes the thread ID as a createRun argument and constructs CreateRunOptions with the agent ID, rather than createRun(new CreateRunOptions(threadId, agentId)). Thus the run creation is not demonstrated as a valid runnable public overload. |
| prompt | `prompt/polls-the-agent-run-to-success` | REQUIRES_ACTION is not treated as failure or terminal, so such a run is polled forever. There is also no timeout; the method can therefore fail to return or report a clear failure as required. |

### ai-agents-java-file-search

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and explicitly versions the GA azure-identity artifact instead of managing it through the BOM. |
| language | `language/supported-terminal-state-polling` | Both polling routines lack a timeout or maximum-attempt bound, so a service operation stuck in a nonterminal state does not produce the required clear timeout failure. |
| prompt | `prompt/polls-and-prints-the-grounded-answer` | The code refreshes the run, checks for COMPLETED, traverses messages ascending, and prints agent message text, but the manual polling is unbounded and can wait forever in a nonterminal state. |
| prompt | `prompt/prepares-the-vector-store` | It creates the vector store from the uploaded file and validates completion counts, but its retrieve-and-delay polling loop has no timeout or other bound, so indexing can hang indefinitely rather than fail on timeout. |

### ai-agents-java-function-tool

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | No Maven or Gradle manifest imports the Azure SDK BOM. |
| language | `language/complete-pageable-traversal` | No message listing or pageable traversal is implemented. |
| language | `language/current-public-azure-sdk-apis` | No implementation uses the required public Azure SDK APIs. |
| language | `language/current-public-azure-sdk-dependencies` | No project manifest or Azure SDK dependencies were added. |
| language | `language/current-public-azure-sdk-imports` | There is no Java source containing current public Azure SDK imports. |
| language | `language/current-public-client-construction` | No Azure client is constructed through any public builder or factory. |
| language | `language/owned-resource-lifecycle-cleanup` | No lifecycle cleanup using returned resource IDs is present. |
| language | `language/supported-runtime-authentication` | No runtime authentication implementation is provided. |
| language | `language/supported-terminal-state-polling` | No polling loop, terminal-state handling, or timeout behavior exists. |
| program | `program/java-project-compiles` | Command 'node .vally/program-checks/java.mjs' failed: Expected exit code 0, got 1 No supported Java build manifest found; expected pom.xml, build.gradle, or build.gradle.kts |
| prompt | `prompt/configures-the-synchronous-agents-client` | No PROJECT_ENDPOINT handling or synchronous Agents client construction exists. |
| prompt | `prompt/creates-the-named-tool-enabled-agent` | There is no code reading the deployment name or creating and configuring the required agent. |
| prompt | `prompt/creates-the-weather-thread-and-run` | There is no implementation creating the specified thread or run. |
| prompt | `prompt/creates-tooloutput-values-with-each-originating-tool-cal` | No correlated tool outputs are constructed or submitted. |
| prompt | `prompt/defines-the-weather-function-tool` | No workspace files or implementation were created, so no get_weather tool is defined. |
| prompt | `prompt/deletes-created-agent-resources` | No thread or agent cleanup is implemented. |
| prompt | `prompt/detects-runstatus-requires-action-and-submittooloutputsa` | No run polling or required-action handling exists. |
| prompt | `prompt/polls-and-prints-the-assistant-response` | No bounded polling, success validation, message traversal, or assistant-text printing is present. |
| prompt | `prompt/processes-every-requiredfunctiontoolcall-checks-the-func` | No function-call iteration, name validation, or JSON argument decoding is implemented. |
| prompt | `prompt/produces-deterministic-json-by-invoking-local-code-rathe` | No deterministic local weather function or required JSON result exists. |

### ai-projects-java-dataset-lifecycle

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and explicitly versions every GA Azure dependency, including azure-identity, rather than using BOM-first management. |
| language | `language/current-public-azure-sdk-apis` | The implementation calls URL-named accessors on DatasetVersion and the blob credential/reference that do not match the SDK's public URI-named model accessors, preventing compilation against the pinned API. |
| prompt | `prompt/downloads-with-the-returned-blob-credential` | The intended flow and secrecy are correct, but the BlobReference/SAS model uses URI accessors (for example getBlobUri/getSasUri), not the getBlobUrl/getSasUrl calls shown. Consequently the BlobClient cannot be built and the referenced blob cannot be downloaded by this code. |
| prompt | `prompt/retrieves-and-prints-dataset-metadata` | Although it retrieves the exact version and prints the intended fields, DatasetVersion in this SDK exposes the data location as a URI (getDataUri), not the used getDataUrl call, so this implementation is not runnable as written. |

### ai-projects-java-evaluation-run

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | No com.azure:azure-sdk-bom is imported, and the GA azure-identity artifact is explicitly versioned rather than BOM-managed. |
| language | `language/supported-terminal-state-polling` | Although the loop retrieves by the returned run ID and intends to handle completed/failed, its String.equalsIgnoreCase calls are incompatible with the SDK's typed run status and prevent this polling code from compiling. |
| prompt | `prompt/polls-the-evaluation-run-to-success` | The intended loop and delay are present, but RunRetrieveResponse.status() is a typed status model in the OpenAI Java API; passing it directly to String.equalsIgnoreCase does not compile, so terminal-state polling is not runnable. |

### ai-projects-java-project-resource-inventory

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions on both Azure dependencies. |

### app-configuration-java-config-values

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead explicitly versions the GA Azure artifact. |

### app-configuration-java-feature-flags

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead assigns explicit versions independently to both GA Azure dependencies. |

### cosmos-db-java-crud-items

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The manifest does not import com.azure:azure-sdk-bom and instead puts an explicit version on the BOM-covered GA azure-cosmos dependency. |

### cosmos-db-java-todo-repository

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import `com.azure:azure-sdk-bom` and instead pins explicit versions on both GA Azure dependencies. |
| prompt | `prompt/catches-cosmosexception-with-status-code-checks-404-409` | The repositories only specially inspect status 412 during update. There is no explicit handling or status inspection for 404 not-found or 409 create conflict. |

### document-translation-java-batch-container

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom imports no com.azure:azure-sdk-bom and instead gives azure-identity an explicit version, contrary to the required BOM-first version management. |

### document-translation-java-single-document

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead assigns an explicit version to the BOM-covered azure-identity GA dependency. |

### event-hubs-java-send-receive-events

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions on the GA Azure artifacts. |
| language | `language/service-specific-error-diagnostics` | Although processor errors report partition and throwable information and batch rejection is detected, producer batch/send service exceptions are not caught or diagnosed, and no SDK reason/transience information is preserved. |

### foundry-java-support-assistant

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins versions directly for all Azure artifacts, including GA identity and Cosmos packages. |
| language | `language/service-specific-error-diagnostics` | The shown Foundry SDK operations are generally wrapped only in RuntimeException and concatenate exception messages; they do not explicitly extract Azure service exception status codes or structured SDK error details. |

### identity-java-credential-chain

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead assigns an explicit version directly to the GA azure-identity artifact. |

### identity-java-default-azure-credential

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/service-specific-error-diagnostics` | The service call has no handling for Key Vault service exceptions or identity exceptions and therefore reports no status code, service details, or actionable failure context. |
| prompt | `prompt/actionable-authentication-troubleshooting` | There is no Azure Identity diagnostic logging guidance or authentication exception handling that reports and preserves useful failure causes. |
| prompt | `prompt/credential-chain-order-in-java-sdk` | The implementation provides no documentation of the credential chain, its order, hosted versus developer credentials, or continuation/stop behavior. |

### identity-java-managed-identity-auth

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead pins explicit versions on both GA Azure SDK dependencies. |

### identity-java-service-principal-auth

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The project does not import com.azure:azure-sdk-bom and instead pins explicit versions on both BOM-covered GA Azure dependencies. |
| language | `language/service-specific-error-diagnostics` | BlobStorageException is handled, but the 401/403 branch suppresses the available HTTP status and service error code and incorrectly states authentication succeeded for HTTP 401. Thus service diagnostics are not consistently preserved. |
| prompt | `prompt/service-principal-authentication-errors` | Although ClientAuthenticationException is caught with actionable guidance, missing inputs are converted to IllegalStateException rather than allowing or handling CredentialUnavailableException. Caught authentication exceptions are reduced to messages and return codes, so causes are not preserved, and safeMessage is not actual redaction. |

### key-vault-java-crud-secrets

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead assigns explicit versions to both BOM-covered GA Azure dependencies. |

### key-vault-java-secret-config

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead assigns explicit versions to both GA Azure dependencies. |

### resource-manager-java-resource-group-crud

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead assigns explicit versions to both GA Azure artifacts. |

### service-bus-java-order-processor

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | pom.xml does not import com.azure:azure-sdk-bom and instead pins explicit versions on both GA Azure dependencies. |
| language | `language/service-specific-error-diagnostics` | No Azure service or identity exception type is handled around client operations, and propagated Service Bus failures are not augmented with service failure reason, status, or other actionable SDK diagnostics. |
| prompt | `prompt/order-processing-and-settlement` | The processor deserializes, logs, completes successes, and dead-letters failures, but the shown processing method never transitions the order status (for example, PENDING to PROCESSING or COMPLETED). |

### service-bus-java-send-receive-messages

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The project does not import com.azure:azure-sdk-bom and instead pins an explicit version directly on the GA Service Bus artifact. |
| language | `language/service-specific-error-diagnostics` | Service operations are not wrapped with ServiceBusException diagnostics, and the processor error handler only prints the source and exception message without preserving/reporting Service Bus reason or transient status. |
| prompt | `prompt/service-bus-failure-handling` | There is no ServiceBusException handling that reports the Service Bus failure reason and transient status. Some clients are also constructed before their enclosing try block, so a later client-construction failure can leak an already-created client. |

### storage-java-account-mgmt

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | No com.azure:azure-sdk-bom is imported, and explicit versions are placed directly on both GA Azure dependencies. |
| language | `language/service-specific-error-diagnostics` | Catching broad AzureException/RuntimeException and printing only their messages does not explicitly preserve available HTTP status, management error code, or structured service error details. |
| prompt | `prompt/storage-management-failures` | Although failures are caught and cleanup is attempted, diagnostics are limited to getMessage(); HTTP status and structured management service error code/details are not extracted when available. |

### storage-java-blob-event-notifier

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/service-specific-error-diagnostics` | Blob failures receive useful BlobStorageException diagnostics, but Event Grid publishing has no corresponding HttpResponseException/transport diagnostic handling, particularly in AsyncEventPublisher. |
| prompt | `prompt/publishing-failure-handling` | AsyncEventPublisher merely returns sendEvents with no error interception or actionable diagnostics. Although Reactor propagates the error, the implementation does not itself report status/service details as required. |

### storage-java-blob-storage-manager

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/owned-resource-lifecycle-cleanup` | Leases and temporary blobs are cleaned up, but the demo container is never deleted after either flow. |
| language | `language/service-specific-error-diagnostics` | There is no demonstrated handling of BlobStorageException or identity/service exceptions that reports status codes, error codes, or service response details. |
| prompt | `prompt/blob-manager-demo` | The demos perform the blob operations, but Main never deletes the demo container, despite this criterion explicitly requiring container deletion in both ordered flows. |
| prompt | `prompt/blob-manager-failures` | The shown implementation largely propagates unchecked SDK failures and does not provide structured, actionable status/service details for sync and async Blob Storage errors. |

### storage-java-crud-blobs

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead assigns explicit versions to both BOM-covered GA Azure artifacts. |

### storage-java-encrypted-uploader

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| prompt | `prompt/async-encrypted-round-trip` | Although async SDK calls are composed with Mono, SecureRandom and the complete in-memory AES encrypt/decrypt operations run directly in map callbacks on the reactive service chain, with no bounded-elastic/parallel scheduler isolation as this criterion explicitly requires. |

### text-translation-java-multilingual-translation

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and explicitly versions azure-identity rather than managing the compatible GA dependency through the BOM. |

### text-translation-java-transliteration

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead explicitly versions the GA azure-identity dependency; only the prompt-pinned translation artifact has justification for an explicit version. |

## azure-skill-mcp

### ai-agents-java-basic-agent-lifecycle

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and explicitly versions the GA azure-identity artifact rather than managing it through the BOM. |
| language | `language/supported-terminal-state-polling` | Polling has a delay and uses the returned IDs, but it has no deadline and treats REQUIRES_ACTION as indefinitely nonterminal instead of producing a clear failure. |
| prompt | `prompt/polls-the-agent-run-to-success` | Although normal active statuses are refreshed and failed terminal statuses are rejected by the caller, REQUIRES_ACTION is neither handled as a clear failure nor otherwise resolved, so the loop can continue forever; there is also no timeout. |

### ai-agents-java-file-search

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and pins the BOM-covered GA azure-identity dependency directly. |
| language | `language/supported-terminal-state-polling` | Both resources are checked for unsuccessful terminal outcomes before output, but neither polling loop has a timeout, so a permanently nonterminal service state causes an indefinite hang rather than the required clear timeout failure. |
| prompt | `prompt/polls-and-prints-the-grounded-answer` | The code retrieves the run with delays and requires COMPLETED before printing chronologically listed agent text, but its manual polling is unbounded and can hang indefinitely. |
| prompt | `prompt/prepares-the-vector-store` | It creates the vector store from the uploaded file ID and checks successful indexing, but the polling loop has no retry bound or timeout, contrary to the explicit bounded-loop requirement. |

### ai-agents-java-function-tool

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and explicitly versions the BOM-covered GA azure-identity dependency. |
| language | `language/current-public-azure-sdk-apis` | The ToolOutput no-argument constructor and setToolCallId/setOutput pattern does not match the public beta.2 API, which requires the tool call ID and output in its constructor. |
| language | `language/supported-terminal-state-polling` | The loop handles active, tool-action, and terminal statuses and reports unsuccessful terminals, but it has no timeout, so a permanently active run can poll forever instead of producing a clear timeout failure. |
| prompt | `prompt/configures-the-synchronous-agents-client` | The endpoint and synchronous builder setup are correct, but the complete workflow does not use a valid public ToolOutput construction API and therefore is not runnable as written. |
| prompt | `prompt/creates-tooloutput-values-with-each-originating-tool-cal` | Although the collection and call-ID correlation logic is conceptually correct, beta.2's public ToolOutput model is constructed with ToolOutput(toolCallId, output); the shown no-argument construction and setters are not supported, so this required submission path is not runnable. |
| prompt | `prompt/polls-and-prints-the-assistant-response` | It checks completion and prints chronologically sorted assistant text, but polling is unbounded and has no timeout or bounded retrieval limit as required by this criterion. |

### ai-projects-java-dataset-lifecycle

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead explicitly versions every Azure dependency, including azure-identity, which is not prompt-pinned. |

### ai-projects-java-evaluation-run

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | No com.azure:azure-sdk-bom dependency management is present, and the BOM-covered azure-identity artifact is assigned an explicit version. |
| language | `language/current-public-azure-sdk-apis` | The implementation compares RunRetrieveResponse.status() with String.equalsIgnoreCase; the generated OpenAI eval response exposes an enum-like status model rather than a String, so this is not a valid use of the current API and prevents a successful build. |
| language | `language/supported-terminal-state-polling` | There is no timeout or other bound that produces a clear failure if the service never reaches a terminal state, and the status comparison is incompatible with the generated status model. |
| prompt | `prompt/polls-the-evaluation-run-to-success` | Although there is a delayed retrieval loop and terminal-state success check, polling is unbounded with no timeout. In addition, the code treats the SDK status model as a String via equalsIgnoreCase, which is not valid for the generated enum-like status type. |

### ai-projects-java-project-resource-inventory

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead assigns explicit versions to both Azure GA artifacts. |

### app-configuration-java-config-values

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins the GA Azure artifact version directly. |

### app-configuration-java-feature-flags

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead assigns explicit versions to both GA Azure artifacts. |

### cosmos-db-java-crud-items

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead assigns an explicit version to the BOM-covered GA azure-cosmos dependency without a stated exception. |
| language | `language/owned-resource-lifecycle-cleanup` | Although closure is placed in finally, both catch blocks call System.exit before they can complete, so on a service failure the finally block is not reliably reached and client.close() is not executed. |

### cosmos-db-java-todo-repository

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import `com.azure:azure-sdk-bom`; it assigns explicit versions directly to both GA Azure dependencies. |
| prompt | `prompt/catches-cosmosexception-with-status-code-checks-404-409` | The implementation specially checks only status 412 during update. It does not separately inspect or handle 404 and 409 for read/create or other service operations as this criterion requires. |

### document-translation-java-batch-container

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead assigns an explicit version to the BOM-covered GA azure-identity dependency. |

### document-translation-java-single-document

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and explicitly versions the BOM-covered azure-identity artifact, contrary to this criterion. |

### event-hubs-java-send-receive-events

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead specifies explicit versions for the GA Azure dependencies. |
| language | `language/service-specific-error-diagnostics` | Although tryAdd rejection is detected and processor errors include partition and throwable details, producer batch/send service exceptions are not caught or diagnosed, and EventHubsException reason/transience information is not explicitly preserved or reported. |

### foundry-java-support-assistant

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead pins explicit versions for the GA azure-identity and azure-cosmos dependencies. |

### identity-java-credential-chain

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead pins azure-identity directly, contrary to the BOM-first requirement. |
| language | `language/service-specific-error-diagnostics` | The testers only catch RuntimeException and classify message text; they do not explicitly handle identity SDK exception types such as CredentialUnavailableException or ClientAuthenticationException or structurally preserve their authentication metadata. |

### identity-java-default-azure-credential

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions on the GA Azure artifacts. |
| language | `language/service-specific-error-diagnostics` | The service operation has no handling for Azure identity or Key Vault service exceptions and does not explicitly preserve or report HTTP status, service error details, or an actionable failure reason. |
| prompt | `prompt/actionable-authentication-troubleshooting` | No Azure Identity diagnostic logging guidance or authentication-specific error handling is included. Although an uncaught exception may retain its cause, the implementation does not deliberately report actionable authentication failure details. |
| prompt | `prompt/credential-chain-order-in-java-sdk` | The implementation provides no documentation of the Java credential chain, its order, hosted versus developer credentials, or continuation/stop behavior. |

### identity-java-managed-identity-auth

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead pins explicit versions for both GA Azure artifacts. |

### identity-java-service-principal-auth

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| prompt | `prompt/client-secret-management` | The implementation keeps the secret out of source and output, but it does not document retrieval from a managed secret store or recommend secret rotation and least-privilege access to the secret. |
| prompt | `prompt/service-principal-authentication-errors` | It catches ClientAuthenticationException and emits actionable redacted guidance, but it neither handles/allows CredentialUnavailableException as an explicit credential-unavailability path nor preserves the exception cause beyond printing its message. |

### key-vault-java-crud-secrets

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions for BOM-covered GA Azure artifacts. |

### key-vault-java-secret-config

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead pins explicit versions on both GA Azure artifacts. |

### resource-manager-java-resource-group-crud

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead assigns explicit versions directly to both GA Azure artifacts. |

### service-bus-java-order-processor

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/service-specific-error-diagnostics` | There is no explicit handling of ServiceBusException or Azure identity/service exception details around client operations; service-operation failures generally propagate without logging failure reason, status, or other actionable SDK diagnostics. |
| prompt | `prompt/batch-sending-creates-servicebusmessagebatch-checks-trya` | Although batches and tryAddMessage are used, AsyncOrderSender sends the current batch unconditionally after a failed tryAddMessage; when that batch is empty, it attempts to send an empty batch, violating the populated-batches-only requirement. |
| prompt | `prompt/handles-the-case-where-a-message-doesnt-fit-in-the-curre` | The async overflow path does not distinguish an empty current batch before calling sendMessages(batch). An oversized first message can therefore trigger an invalid empty-batch send instead of the explicit oversized-message check after creating/retrying a new batch. |

### service-bus-java-send-receive-messages

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The project does not import com.azure:azure-sdk-bom and instead places explicit versions directly on both GA Azure dependencies. |
| language | `language/service-specific-error-diagnostics` | There is no ServiceBusException catch around sender or receiver operations and no extraction of ServiceBusFailureReason or isTransient information. The generic processor error logging alone does not meet the required service-specific diagnostics. |
| prompt | `prompt/service-bus-failure-handling` | Although clients are generally closed with finally blocks and the processor error callback logs its exception, synchronous Service Bus operations have no ServiceBusException handling and do not report the failure reason or transient status. Also, a failure while constructing the processor demo's sender can leave the already-created processor unclosed. |

### storage-java-account-mgmt

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions for both GA Azure dependencies. |

### storage-java-blob-event-notifier

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions on all GA Azure dependencies. |
| prompt | `prompt/publishing-failure-handling` | The shown publishers directly return or invoke sendEvents without handling HttpResponseException or adding actionable status/service diagnostics; propagation alone does not satisfy the full criterion. |

### storage-java-blob-storage-manager

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/owned-resource-lifecycle-cleanup` | Leases and blobs are cleaned up, but the demo containers are never deleted in either the synchronous or asynchronous flow. |
| language | `language/service-specific-error-diagnostics` | There is no handling of BlobStorageException or identity/service-specific exceptions that reports HTTP status, error code, or other actionable Azure service details. |
| prompt | `prompt/blob-manager-demo` | Although both demos perform and report the blob operations in order and await async completion, neither demo deletes the container, which this criterion explicitly requires. |
| prompt | `prompt/blob-manager-failures` | Service failures are largely allowed to escape without operation-specific handling or actionable status/service-detail reporting; configuring retries alone does not satisfy the diagnostics requirement. |

### storage-java-crud-blobs

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead pins explicit versions on both GA Azure dependencies. |

### storage-java-encrypted-uploader

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| prompt | `prompt/async-encrypted-round-trip` | Although async Azure clients and Reactor compose the full flow, local AES encryption/decryption executes directly in flatMap/map on the reactive service thread; it is not isolated on an appropriate scheduler as this criterion requires. |

### text-translation-java-multilingual-translation

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and explicitly versions the GA azure-identity artifact rather than managing it through the BOM. |

### text-translation-java-transliteration

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom has no com.azure:azure-sdk-bom dependencyManagement import and explicitly versions the BOM-covered azure-identity artifact. |

## azure-skill-mcp-microsoft-skill

### ai-agents-java-basic-agent-lifecycle

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | No com.azure:azure-sdk-bom is imported, and the BOM-covered GA azure-identity dependency is assigned an explicit version. |
| language | `language/current-public-azure-sdk-apis` | The workflow relies on the incorrect administration-builder type and unsupported subclient build methods, so it does not consistently use the package's current public API and is unlikely to compile. |
| language | `language/current-public-azure-sdk-imports` | PersistentAgentsAdministrationClientBuilder is not the public shared builder for constructing the administration, thread, message, and run clients; the package's public shared entry point is PersistentAgentsClientBuilder. |
| language | `language/current-public-client-construction` | The implementation attempts to construct all subclients from PersistentAgentsAdministrationClientBuilder rather than the public PersistentAgentsClientBuilder/buildAdministrationClient entry point, preventing valid client construction. |
| language | `language/supported-terminal-state-polling` | Although retrieval is delayed and uses the returned IDs, polling has no deadline or timeout, so a perpetually nonterminal run can loop forever. |
| prompt | `prompt/configures-the-synchronous-agents-client` | The code reads the endpoint and uses DefaultAzureCredential, but constructs from PersistentAgentsAdministrationClientBuilder and calls buildThreadsClient/buildMessagesClient/buildRunsClient on it. The public package uses PersistentAgentsClientBuilder as the shared builder, so this implementation is not runnable as written. |

### ai-agents-java-file-search

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | No azure-sdk-bom is imported, and the BOM-covered GA azure-identity dependency is assigned an explicit version. |
| language | `language/supported-terminal-state-polling` | Both resources are checked for successful terminal outcomes, but neither polling loop has a timeout; the criterion expressly requires timeout handling, so persistent nonterminal states can hang rather than fail clearly. |
| prompt | `prompt/polls-and-prints-the-grounded-answer` | The run is refreshed with delays, completion is required, and agent text is printed from messages in ascending order, but the manual poll is unbounded and can hang indefinitely. |
| prompt | `prompt/prepares-the-vector-store` | It creates the vector store from the uploaded file ID and validates successful indexing, but the polling loop has no timeout or attempt bound, so it can wait forever and does not satisfy bounded polling. |

### ai-agents-java-function-tool

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | No com.azure:azure-sdk-bom is imported, and the BOM-covered GA azure-identity dependency is explicitly versioned. |
| language | `language/current-public-azure-sdk-apis` | The implementation depends on a nonmatching administration builder API, so the supplied source cannot compile against the declared public package as written; ToolOutput is also normally constructed with its required call ID and output rather than the shown no-argument construction. |
| language | `language/current-public-client-construction` | The selected PersistentAgentsAdministrationClientBuilder/buildClient construction does not match the public aggregate PersistentAgentsClientBuilder/buildAdministrationClient entry point used to construct these service clients. |
| language | `language/supported-terminal-state-polling` | Polling occurs before and after tool submission and unsuccessful statuses are rejected, but there is no timeout or other bound, so a permanently queued/in-progress run can loop forever rather than produce a clear timeout failure. |
| prompt | `prompt/configures-the-synchronous-agents-client` | Although PROJECT_ENDPOINT is read and only synchronous client types are intended, the code uses PersistentAgentsAdministrationClientBuilder with buildClient/buildThreadsClient/buildMessagesClient/buildRunsClient; the public SDK uses PersistentAgentsClientBuilder and buildAdministrationClient for this client family, so the workflow is not runnable as written. |
| prompt | `prompt/polls-and-prints-the-assistant-response` | It rejects unsuccessful terminal states and prints chronologically sorted assistant text, but polling is unbounded and has no timeout despite the criterion requiring bounded retrieval and timeout failure. |

### ai-projects-java-dataset-lifecycle

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom has no azure-sdk-bom dependency management and explicitly versions azure-identity even though that GA artifact is BOM-covered and not prompt-pinned. |

### ai-projects-java-evaluation-run

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The project does not import com.azure:azure-sdk-bom and instead explicitly versions the GA azure-identity dependency. |
| language | `language/supported-terminal-state-polling` | Although it repeatedly retrieves by the returned run ID and turns a failed status into an exception, it provides no timeout, so nonterminal runs can hang indefinitely instead of producing a clear timeout failure. |
| prompt | `prompt/polls-the-evaluation-run-to-success` | The loop delays between retrievals and handles completed/failed, but it has no attempt or time bound, so a run stuck in another state can poll forever rather than fail clearly. |

### ai-projects-java-project-resource-inventory

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and explicitly versions the BOM-covered GA azure-identity dependency. |

### app-configuration-java-config-values

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead places an explicit version on a BOM-covered GA Azure artifact. |

### app-configuration-java-feature-flags

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | pom.xml does not import com.azure:azure-sdk-bom and instead pins explicit versions independently for both GA Azure dependencies. |

### cosmos-db-java-crud-items

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import `com.azure:azure-sdk-bom` and instead pins the GA `azure-cosmos` dependency version directly. |

### cosmos-db-java-todo-repository

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | There is no `com.azure:azure-sdk-bom` dependency management import; both GA Azure artifacts are assigned explicit versions. |
| prompt | `prompt/catches-cosmosexception-with-status-code-checks-404-409` | The implementation checks 412 for updates, but does not separately inspect and handle 404 for reads/deletes or 409 for creates as this criterion requires. |

### document-translation-java-batch-container

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead explicitly versions both Azure dependencies, including the BOM-covered GA azure-identity artifact. |

### document-translation-java-single-document

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead explicitly versions the BOM-covered GA azure-identity dependency. |

### event-hubs-java-send-receive-events

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions on both BOM-covered GA Azure dependencies. |
| language | `language/service-specific-error-diagnostics` | Although tryAdd rejection is handled and the processor callback reports partition and throwable details, producer batch/send service exceptions are not caught or diagnosed, and Event Hubs reason/transience details are not surfaced. |

### foundry-java-support-assistant

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | pom.xml does not import com.azure:azure-sdk-bom and instead pins explicit versions for the BOM-covered GA azure-identity and azure-cosmos artifacts. |
| language | `language/owned-resource-lifecycle-cleanup` | Cleanup cannot enumerate the application-owned service conversations from the CloudResources record, and failed initialization can create remote resources before any ownership record is saved. Consequently dependency-safe cleanup and retryable ownership preservation are incomplete. |
| prompt | `prompt/cleans-up-created-cloud-resources-safely` | Application-created answer and evaluation conversations are not included in CloudResources passed to cleanup, with evaluation conversations not persisted anywhere. Also, resources are saved only after initialize completes, so a failure after remote creation loses ownership needed to clean up or retry. |
| prompt | `prompt/includes-meaningful-offline-automated-tests` | Even if the included mock/fake tests cover handlers and ordinary orchestration, the implementation has no atomic multi-record Cosmos transaction or compensating recovery path to test, and evaluation uses static dataset context rather than retrieval-derived context. The full required failure-path test set is therefore not satisfied. |
| prompt | `prompt/runs-extensible-groundedness-and-relevance-evaluation` | AdministrationService constructs evaluator rows with testCase.context() from the static dataset. It does not obtain evaluator context from retrieval-service results returned for each generated answer, as the criterion expressly requires. |
| prompt | `prompt/uses-a-foundry-managed-prompt-agent` | Although initialization persists the returned agent name/version and answer/evaluation calls use it, cleanup is given only CloudResources and not the persisted/evaluation conversation IDs. Evaluation-created conversations are not persisted at all, so the required conversation-before-agent lifecycle cannot be completed. |

### identity-java-credential-chain

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom pins azure-identity directly and does not import com.azure:azure-sdk-bom through dependencyManagement. |

### identity-java-default-azure-credential

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM pins Azure artifact versions directly and does not import com.azure:azure-sdk-bom as required by this criterion. |
| language | `language/service-specific-error-diagnostics` | The service operation has no handling for Key Vault service exceptions or identity exceptions and does not report status codes, service error details, or tailored actionable diagnostics. |
| prompt | `prompt/actionable-authentication-troubleshooting` | There is no Azure Identity logging guidance or authentication exception handling that reports an actionable failure reason. Merely allowing exceptions to escape does not satisfy the requested troubleshooting explanation. |
| prompt | `prompt/credential-chain-order-in-java-sdk` | The implementation provides no documentation of chain order, hosted versus developer credentials, or continuation/stopping behavior. |

### identity-java-service-principal-auth

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| prompt | `prompt/service-principal-authentication-errors` | Rejected credentials are caught as ClientAuthenticationException and messages are secret-safe and actionable, but the implementation does not explicitly preserve or surface nested causes (it prints only getMessage and exits). CredentialUnavailableException is also not distinctly handled; unavailable environment inputs are converted to IllegalStateException before credential construction. |

### key-vault-java-crud-secrets

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead assigns explicit versions to both BOM-covered GA Azure artifacts. |

### key-vault-java-secret-config

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead pins explicit versions independently for both GA Azure artifacts. |

### resource-manager-java-resource-group-crud

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions on both GA Azure artifacts. |

### service-bus-java-order-processor

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead assigns explicit versions to the BOM-covered GA Azure artifacts. |
| language | `language/service-specific-error-diagnostics` | There is no handling of ServiceBusException or Azure identity/service exceptions around SDK operations, nor preservation/reporting of Service Bus failure reason or other service diagnostics; the catch shown is only for message processing. |
| prompt | `prompt/dead-letter-reprocessing` | The main queue must be session-enabled for the order receivers, but the dead-letter clients are ordinary non-session receivers. A DLQ associated with a session-enabled entity must also be accessed using a session receiver, so receive/reprocessing will fail at runtime. |
| prompt | `prompt/ordered-main-demo` | Main structurally runs sync before async, but neither advertised full dead-letter/reprocessing cycle can complete against the required session-enabled queue because its DLQ receiver is non-session-aware. |

### service-bus-java-send-receive-messages

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead places explicit versions directly on both GA Azure dependencies. |
| language | `language/service-specific-error-diagnostics` | Although the processor error callback prints basic context, service operations are not wrapped with ServiceBusException handling and available diagnostics such as failure reason and transient status are not preserved or reported. |
| prompt | `prompt/service-bus-failure-handling` | There is no ServiceBusException-specific handling for synchronous send/receive/settlement failures, and diagnostics do not report the ServiceBus failure reason or transient flag. Also, clients are all constructed before entering the try/finally, so a later construction failure can leave earlier clients unclosed. |

### storage-java-account-mgmt

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions for all Azure GA artifacts. |

### storage-java-blob-event-notifier

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The pom does not import com.azure:azure-sdk-bom and instead pins explicit versions for all three GA Azure SDK dependencies. |
| prompt | `prompt/publishing-failure-handling` | The shown async publisher directly returns sendEvents and the implementation provides no demonstrated error logging or mapping that reports actionable HTTP status or Event Grid service details. Mere propagation does not satisfy the diagnostics requirement. |

### storage-java-blob-storage-manager

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | No azure-sdk-bom dependencyManagement import is present; GA Azure artifacts are explicitly versioned. |
| language | `language/owned-resource-lifecycle-cleanup` | Leases and blobs are cleaned up, but the demo containers are never deleted in either flow. |
| language | `language/service-specific-error-diagnostics` | There is no handling of BlobStorageException or identity exceptions and no explicit reporting of status codes, service error codes, or failure reasons. |
| prompt | `prompt/blob-manager-demo` | Although both demos perform and report the blob operations in order, neither deletes the demo container, which this criterion explicitly requires. |
| prompt | `prompt/blob-manager-failures` | Service and demo flows do not catch or enrich Blob Storage failures or report actionable status/service details; errors largely propagate as raw terminal exceptions. |

### storage-java-crud-blobs

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions on both BOM-covered GA Azure dependencies. |

### storage-java-encrypted-uploader

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead pins explicit versions on all GA Azure dependencies. |

### text-translation-java-multilingual-translation

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The POM does not import com.azure:azure-sdk-bom and instead explicitly versions azure-identity, a BOM-covered GA artifact. |

### text-translation-java-transliteration

| Group | Failed criterion | Judge-reported potential reason |
|---|---|---|
| language | `language/azure-sdk-bom-first-version-management` | The Maven project does not import com.azure:azure-sdk-bom and explicitly versions the BOM-covered azure-identity dependency. |

## Source and caveat

Rows were extracted from each variant's `results.jsonl` under `reports/java-preservation-final/2026-09-07T10-24-56-520Z/`. The generated workspaces and trajectories remain the stronger evidence for confirming any individual diagnosis. A failed model criterion can reflect a real implementation defect, ambiguous evidence in the diff, or judge error.
