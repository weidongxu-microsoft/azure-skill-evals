# Project Context

- **Owner:** Weidong Xu
- **Project:** Azure skill evaluation repository focused on four-language Event Hubs data-plane send/receive coverage, following existing App Configuration and Cosmos conventions.
- **Stack:** Prompt/eval YAML, deterministic graders, Python, .NET, Java, and TypeScript golden applications.
- **Created:** 2026-08-27T14:15:06.412+08:00

## Learnings

- Initial assignment: Azure skill evaluation coverage for Event Hubs data-plane send/receive across Python, .NET, Java, and TypeScript.
- Shared experiments use three variants; adding one Event Hubs eval to the existing two evals yields the required nine dry-run trials without changing variant definitions.
- Golden applications are consistently rooted at `scenarios/*/golden`; validation can discover those roots once, then select Python, .NET, Java, or TypeScript checks from source and manifest markers.
- The established golden checks are Python `compileall` and Ruff, `dotnet build`, Maven `compile`, and frozen pnpm install plus the package `build` script.
- Quality review tightened all four Event Hubs graders to associate core behavior with the relevant SDK objects and callbacks, reject comment/string decoys, and test exact ten-event semantics and lifecycle cleanup.
- Python receive must be explicitly bounded; `max_wait_time` controls callback cadence rather than ending `receive`.
- The TypeScript manifest and lockfile are consistent and pinned, but the approved Azure SDK feed returns 401 for the checkpoint-store 2.0.1 tarball. Offline frozen lock verification and TypeScript 5.9.2 syntax validation still succeed.

- 2026-08-27T06:43:40Z: Zoidberg ran integration experiments and generalized golden validator; focused validation passed.
- 2026-08-27T07:08:00Z: Final validation passed 130 repository tests, Python compile/Ruff, 12 strict Vally evals, four 9-plan dry runs, and 11 of 12 golden apps. Event Hubs TypeScript remains blocked only by approved-feed HTTP 401; frozen lockfile-only and TypeScript 5.9.2 syntax checks pass.
- 2026-08-27T07:05:13Z: Zoidberg independently reviewed Fry, Leela, Amy, and Bender scenarios and Leela's .NET checker; approved all with a TypeScript environment caveat; fixed semantic false positives/negatives; 130 focused tests passed.
