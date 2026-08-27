# Project Context

- **Owner:** Weidong Xu
- **Project:** Azure skill evaluation repository focused on four-language Event Hubs data-plane send/receive coverage, following existing App Configuration and Cosmos conventions.
- **Stack:** Prompt/eval YAML, deterministic graders, Python, .NET, Java, and TypeScript golden applications.
- **Created:** 2026-08-27T14:15:06.412+08:00

## Learnings

- Initial assignment: Azure skill evaluation coverage for Event Hubs data-plane send/receive across Python, .NET, Java, and TypeScript.
- Event Hubs TypeScript graders can stay dependency-free while preserving behavior association by resolving client, batch, subscription, handler-object, and named-handler bindings before checking operations.
- `@azure/event-hubs` 6.0.4 supports connection strings with embedded entity paths or separate Event Hub names, checkpoint stores in both forms, all-partition and partition-specific `subscribe` overloads, and explicit `Subscription.close()`.
- The approved Azure SDK npm feed resolves `@azure/eventhubs-checkpointstore-blob` 2.0.1 metadata but returned HTTP 401 for that release's tarball on 2026-08-27; `pnpm install --lockfile-only` still produced the pinned lockfile.

- 2026-08-27T06:43:40Z: Bender implemented TypeScript scenario; typecheck passed; pnpm fresh install hit approved-feed HTTP 401 (needs triage).
