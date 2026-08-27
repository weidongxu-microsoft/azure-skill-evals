# Project Context

- **Owner:** Weidong Xu
- **Project:** Azure skill evaluation repository focused on four-language Event Hubs data-plane send/receive coverage, following existing App Configuration and Cosmos conventions.
- **Stack:** Prompt/eval YAML, deterministic graders, Python, .NET, Java, and TypeScript golden applications.
- **Created:** 2026-08-27T14:15:06.412+08:00

## Learnings

- Initial assignment: Azure skill evaluation coverage for Event Hubs data-plane send/receive across Python, .NET, Java, and TypeScript.
- Event Hubs Python graders should mask comments and string literals, resolve client/batch/handler relationships, and accept both `receive` and `receive_batch` callback forms rather than matching isolated SDK tokens.
- The shared Python lifecycle grader recognizes inline client context managers or explicit `close()` calls; the Event Hubs golden app uses inline async context managers for both producer and consumer.
- The Python Event Hubs golden app uses `azure-eventhub==5.15.1` with `azure-eventhub-checkpointstoreblob-aio==1.2.0`, ten property-bearing events, Blob checkpointing, and bounded async receive.

- 2026-08-27T06:43:40Z: Fry implemented Python scenario; focused tests/compile and Ruff passed.
