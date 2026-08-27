# Project Context

- **Owner:** Weidong Xu
- **Project:** Azure skill evaluation repository focused on four-language Event Hubs data-plane send/receive coverage, following existing App Configuration and Cosmos conventions.
- **Stack:** Prompt/eval YAML, deterministic graders, Python, .NET, Java, and TypeScript golden applications.
- **Created:** 2026-08-27T14:15:06.412+08:00

## Learnings

- Initial assignment: Azure skill evaluation coverage for Event Hubs data-plane send/receive across Python, .NET, Java, and TypeScript.
- At commit `756f2eb`, migrated scenarios live under `scenarios/<service>-<language>-<slug>`, not under `prompts/`; source prompt Markdown remains in the Hyoka repository.
- Scenario checkers should reuse the shared workspace loaders in `languages/<language>/checks.mjs`, reject missing generated source, and stage only checker/rule and shared language files into `.vally`.
- Event Hubs has eight common correctness concerns: dependencies, producer creation, ten-event property-bearing batch, send, checkpoint-backed receiver, handlers/body output, checkpoint update, and lifecycle.
- The source Python Event Hubs prompt is truncated before step 3; its sibling prompts and criteria establish the missing producer and batch behavior.
- The shared .NET lifecycle check is Cosmos-specific and needs Event Hubs coverage; Python, Java, and TypeScript can keep their shared checks unchanged and use scenario rules for service-specific cleanup.
- Current stable direct pins reviewed on 2026-08-27 are Python 5.15.1/1.2.0, .NET Event Hubs 5.12.2 and Storage Blobs 12.28.0, Java 5.21.6/1.21.8, and TypeScript 6.0.4/2.0.1/12.33.0.
- Integration review confirmed the Event Hubs suite resolves all four evals and every language experiment preserves three variants while dry-running exactly nine plans.
- Golden validation discovers all 12 `scenarios/*/golden` roots and validated the new Python, .NET, and Java apps; the TypeScript restore is externally blocked because the approved Azure SDK feed returns HTTP 401 for `@azure/eventhubs-checkpointstore-blob@2.0.1`.

- 2026-08-27T06:43:40Z: Farnsworth initialized roster and approved eight-rule Event Hubs contract (design approved).
- 2026-08-27T07:05:13Z: Farnsworth approved Zoidberg's suite, experiments, and the generalized validator; confirmed 9-trial dry runs.
