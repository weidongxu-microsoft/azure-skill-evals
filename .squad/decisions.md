# Decisions

> Append-only shared decision ledger. Scribe merges inbox entries here.

## Merged inbox entries (UTC 2026-08-27T06:43:40Z)

### 2026-08-27: Keep Java Event Hubs grading semantic
**By:** Amy
**What:** The Java scenario accepts both Event Hubs connection-string overloads, event and batch processor callbacks, method-reference/handler-variable/inline handlers, and explicit or try-with-resources producer cleanup. Callback rules resolve the handler registered on the processor before checking body output and checkpoint updates.
**Why:** These are valid current SDK forms, and associating behavior with the configured client avoids rewarding comments, string literals, or disconnected API names.

### 2026-08-27: Use only the two pinned Java Event Hubs dependencies
**By:** Amy
**What:** The Java golden Maven app directly pins `azure-messaging-eventhubs` 5.21.6 and `azure-messaging-eventhubs-checkpointstore-blob` 1.21.8 without a separate direct Storage Blob dependency.
**Why:** Maven package validation confirms the checkpoint-store dependency supplies the Storage Blob API needed by `BlobContainerClientBuilder`, keeping the manifest minimal and reproducible.

### 2026-08-27: Associate TypeScript Event Hubs rules with SDK objects
**By:** Bender
**What:** The TypeScript scenario resolves producer, batch, checkpoint store, consumer, subscription, and handler bindings before grading their operations. It accepts embedded or separate Event Hub connection forms, named or inline handlers, partition-specific subscriptions, and sequential or grouped explicit cleanup.
**Why:** Binding operations to the objects and handlers that perform them rejects disconnected keywords while allowing valid current-SDK organization choices.

### 2026-08-27: Keep the TypeScript golden receiver alive until shutdown
**By:** Bender
**What:** The reference application sends a ten-event batch, subscribes with blob checkpointing, waits for SIGINT or SIGTERM, and closes the subscription, consumer, and producer in `finally`.
**Why:** A signal-driven lifetime demonstrates actual receiving and deterministic cleanup without imposing an arbitrary receive duration.

### 2026-08-27: Normalize the Event Hubs evaluation shape
**By:** Farnsworth
**What:** Add four scenario roots named `scenarios/event-hubs-{python,dotnet,java,typescript}-send-receive-events`. Use the same eight prompt criteria in each eval: packages, producer client, ten-event batch with custom properties, batch send, checkpointed consumer/processor, receive and error handlers that print bodies, checkpoint update, and start/wait/cleanup lifecycle. Restore the Python prompt's visibly truncated producer/batch steps so all four stimuli cover the same behavior.
**Why:** The Python source starts at step 3, while its own criteria require batching and all three sibling prompts explicitly require ten events with properties. A normalized semantic shape supports meaningful coverage while preserving language-specific SDK idioms.

### 2026-08-27: Grade valid SDK behavior rather than one golden form
**By:** Farnsworth
**What:** Deterministic rules must accept current valid constructor overloads, connection strings with or without an embedded entity path, named or inline handlers, supported receive variants, and explicit-close or structured-disposal forms. Rules must associate calls with the relevant clients/handlers and reject missing core behavior; docs, skill files, or isolated tokens must not satisfy them. For .NET, require `EventProcessorClient` with blob checkpointing, not a separately constructed `EventHubConsumerClient`; using its default-consumer-group constant is sufficient.
**Why:** The upstream .NET criteria conflict with the actual processor workflow, and exact golden matching would create false negatives without improving correctness.

### 2026-08-27: Limit shared-check changes to .NET lifecycle coverage
**By:** Farnsworth
**What:** Reuse the existing applicable language graders unchanged for Python, Java, and TypeScript. Extend only `.NET`'s `language/client-lifecycle` and its tests so Event Hubs producer disposal and processor stop are not automatic passes. Keep multi-client and subscription cleanup in each scenario's prompt lifecycle rule.
**Why:** The current .NET lifecycle predicate only recognizes `CosmosClient`; it would be vacuous for Event Hubs. The other shared checks already cover the intended language-level concerns, while service-specific cleanup is clearer in prompt rules.

### 2026-08-27: Pin current direct Event Hubs dependencies
**By:** Farnsworth
**What:** Golden manifests use exact direct versions: Python `azure-eventhub==5.15.1` and `azure-eventhub-checkpointstoreblob-aio==1.2.0`; .NET `Azure.Messaging.EventHubs` and `.Processor` `5.12.2`, plus `Azure.Storage.Blobs` `12.28.0`; Java `azure-messaging-eventhubs` `5.21.6` and checkpointstore blob `1.21.8`; TypeScript `@azure/event-hubs` `6.0.4`, checkpointstore blob `2.0.1`, `@azure/storage-blob` `12.33.0`, and the existing TypeScript/pnpm tool versions. Commit the TypeScript `pnpm-lock.yaml`; use the repository `.npmrc`.
**Why:** These are current stable package versions at review time. Exact direct pins and the approved Azure SDK npm feed make golden restoration deterministic.

### 2026-08-27: Centralize integration after language scenarios
**By:** Farnsworth
**What:** Zoidberg alone owns `.vally.yaml`, all four `experiments/*/experiment.yaml` eval-list additions, and `scripts/validate-golden-apps.ps1`. Add suite `event-hubs-send-receive-events`, append one matching eval to each language experiment without changing variants, and generalize golden discovery to validate every `scenarios/*/golden` directory, including Python compile and Ruff checks.
**Why:** A single integration owner avoids merge conflicts and ensures future golden directories cannot silently escape validation.

### 2026-08-27: Associate .NET Event Hubs rules with SDK objects
**By:** Leela
**What:** Capture producer, batch, checkpoint store, processor, and handler variables in the .NET rules. Accept current constructor overloads and named or inline handlers, while requiring the ten-event property/TryAdd behavior, batch send, checkpoint update, and matching cleanup calls.
**Why:** Object association accepts valid SDK forms without allowing isolated method names or unrelated lifecycle calls to satisfy core behavior.

### 2026-08-27: Make shared .NET lifecycle checks type-aware
**By:** Leela
**What:** Require every constructed EventHubProducerClient to use structured or explicit disposal and every EventProcessorClient to be stopped. Preserve the CosmosClient behavior with the same type-aware binding.
**Why:** Generic disposal tokens previously made the language lifecycle check vacuous for Event Hubs and could also hide cleanup of the wrong object.

### 2026-08-27: Discover and validate every golden application
**By:** Zoidberg
**What:** Enumerate every existing `scenarios/*/golden` root and run its real language validation: Python compile and Ruff, .NET build, Maven compile, or frozen pnpm install and build. Fail when a discovered golden root has no supported application marker.
**Why:** Root-based discovery automatically covers new scenarios and prevents an unrecognized golden application from silently escaping validation.

### 2026-08-27: Integrate Event Hubs without changing experiment arms
**By:** Zoidberg
**What:** Add the four-language `event-hubs-send-receive-events` suite and append the corresponding eval to each shared language experiment while preserving all three existing variants.
**Why:** Three evals across three unchanged variants deterministically resolve to nine trials per language experiment and keep comparison arms stable.


### 2026-08-27: Approve Event Hubs shared integration with an external feed blocker
**By:** Farnsworth
**What:** Approve the four-language suite, the four experiment additions, and generalized discovery across all 12 golden roots. No integration code fix is required. Full golden validation remains blocked at the Event Hubs TypeScript restore because the configured approved Azure SDK npm feed returns HTTP 401 for `@azure/eventhubs-checkpointstore-blob@2.0.1`; do not fall back to the public registry.
**Why:** Vally lint passed, all four experiment dry runs produced nine plans, 62 focused grader tests passed, and the validator built or linted the new Python, .NET, and Java apps before failing actionably on the approved feed.

### 2026-08-27: Approve Event Hubs scenarios after quality fixes
**By:** Zoidberg
**What:** Approve the Python, .NET, Java, and TypeScript Event Hubs scenarios and shared .NET lifecycle checker after tightening behavior association, exact batch counts, callback checks, source sanitization, and lifecycle tests.
**Why:** Focused grader tests, eval linting, Python lint/compile, .NET build, and Java compile pass. TypeScript pins and lockfile are correct; full restore is blocked only by a 401 from the configured approved feed, while frozen lock verification and pinned-compiler syntax validation pass without public npm.
