# Project Context

- **Owner:** Weidong Xu
- **Project:** Azure skill evaluation repository focused on four-language Event Hubs data-plane send/receive coverage, following existing App Configuration and Cosmos conventions.
- **Stack:** Prompt/eval YAML, deterministic graders, Python, .NET, Java, and TypeScript golden applications.
- **Created:** 2026-08-27T14:15:06.412+08:00

## Learnings

- Initial assignment: Azure skill evaluation coverage for Event Hubs data-plane send/receive across Python, .NET, Java, and TypeScript.
- Event Hubs .NET source graders should associate `EventDataBatch` creation and sending with the captured producer, and require custom-property assignment plus handled `TryAdd` inside the exact ten-event loop.
- `EventProcessorClient` supports connection strings with embedded entity paths and explicit event hub names; named and inline process handlers are both valid.
- Shared .NET lifecycle checks must bind cleanup to each `EventHubProducerClient` and `EventProcessorClient`, rather than accepting unrelated `DisposeAsync` or `StopProcessingAsync` calls.

- 2026-08-27T06:43:40Z: Leela implemented .NET scenario; lifecycle checker/tests and build passed.
