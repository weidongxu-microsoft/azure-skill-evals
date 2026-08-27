# Project Context

- **Owner:** Weidong Xu
- **Project:** Azure skill evaluation repository focused on four-language Event Hubs data-plane send/receive coverage, following existing App Configuration and Cosmos conventions.
- **Stack:** Prompt/eval YAML, deterministic graders, Python, .NET, Java, and TypeScript golden applications.
- **Created:** 2026-08-27T14:15:06.412+08:00

## Learnings

- Initial assignment: Azure skill evaluation coverage for Event Hubs data-plane send/receive across Python, .NET, Java, and TypeScript.
- Event Hubs Java 5.21.6 uses `EventHubClientBuilder.buildProducerClient`; `EventProcessorClientBuilder` accepts either connection-string overload and Blob checkpointing through `BlobCheckpointStore`.
- The pinned Event Hubs 5.21.6 and Blob checkpoint-store 1.21.8 dependencies compile the golden app without an additional direct Storage Blob dependency.
- Java Event Hubs graders should resolve registered method references, handler variables, and inline event or batch handlers so checkpointing and body/error output remain associated with the processor callbacks.

- 2026-08-27T06:43:40Z: Amy implemented Java scenario; Maven build/tests passed.
