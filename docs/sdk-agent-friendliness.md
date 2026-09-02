# Evaluating SDK agent-friendliness

The current evaluations primarily measure instruction following and API
assembly. Many prompts name the package, client, methods, and operation order,
leaving few SDK decisions for the agent.

To evaluate whether Azure SDKs are agent-friendly, add cases that require the
agent to discover the appropriate package and API patterns while preserving the
same prompt, model, graders, and trial count across environment variants.

## Prompt ladder

Use multiple guidance levels for representative tasks:

| Level | Prompt information | Primary signal |
|---|---|---|
| Guided | Package, client, and major methods | Basic API assembly |
| Intent-only | Required behavior and Azure service, without SDK symbols | Package and API discoverability |
| Problem-only | Business requirement; agent selects service, plane, SDK, and design | End-to-end solution discovery |
| Repair | Incomplete, outdated, or incorrect Azure code | Diagnostics and migration ergonomics |

Guided cases remain useful controls, but intent-only and repair cases provide
stronger evidence of SDK usability.

For example, an intent-only Cosmos DB prompt could say:

> Create a runnable TypeScript console application that maintains inventory
> items in Azure Cosmos DB for NoSQL. Partition inventory by category.
> Demonstrate creating, retrieving, querying, updating, and deleting an item.
> Configuration must come from the environment, setup should be idempotent,
> queries must not load an unbounded result set into memory, and failures should
> produce actionable diagnostics.

This requires the agent to discover `@azure/cosmos`, distinguish the data plane
from ARM, supply partition keys, use `QueryIterator` correctly, and understand
the SDK's error model.

## End-to-end scenario levels

Two higher levels can test broader service and architecture discovery.

### Capability-based solution discovery

> Build a complete, runnable end-to-end application for the scenario below.
> The application may require capabilities such as persistent storage,
> asynchronous communication, identity, monitoring, or AI. Select the
> appropriate Azure services, SDKs, and application architecture. Do not assume
> that every listed capability requires a separate service. Document the key
> design choices and implement the application using current, supported SDKs.

This level identifies only general service categories. It allows the agent to
decide which Azure services are needed, assign responsibilities, distinguish
data-plane and management-plane SDKs, and avoid unnecessary services.

### Production cloud-native solution

> Build a complete, production-oriented, cloud-native application for the
> defined use case. Select the appropriate Azure services, SDKs, deployment
> model, and architecture. Include application source, dependency manifests,
> infrastructure definitions, automated validation, a deployment workflow, and
> concise operational documentation.
>
> The solution must address:
>
> - CI/CD readiness.
> - Fault tolerance and recovery from transient failures.
> - Elastic horizontal scaling.
> - User authentication and authorization with Microsoft Entra ID.
> - Workload authentication without embedded credentials.
> - Secure configuration and secret management.
> - Observability, health reporting, and actionable diagnostics.
> - Idempotency and safe retry behavior where applicable.
> - Graceful startup, shutdown, and resource cleanup.
> - Other security and operational practices relevant to the design.

Avoid using `production-ready` without concrete outcomes. The term is
unbounded; requiring observable properties and artifacts makes grading more
reproducible.

Production cases measure more than SDK usability. Keep their result groups
separate:

| Group | Responsibility |
|---|---|
| `application/*` | End-to-end business behavior |
| `sdk/*` | Packages, clients, authentication, paging, LROs, and errors |
| `architecture/*` | Service selection, boundaries, and data flows |
| `operations/*` | Scaling, resiliency, health, telemetry, and shutdown |
| `security/*` | Entra ID, workload identity, authorization, and secrets |
| `delivery/*` | Infrastructure, CI validation, and deployment |
| `program/*` | Build, lint, type-check, tests, and IaC validation |

Capability-based cases provide a cleaner SDK agent-friendliness signal.
Production cases measure whether the broader Azure developer platform is
agent-friendly.

## Evaluation dimensions

Grade distinct properties rather than treating SDK correctness as one broad
result:

1. **SDK selection:** Chooses the current service and plane-specific package.
2. **API discovery:** Finds the correct client, operation group, and methods
   without those symbols being supplied.
3. **Authentication:** Selects a credential appropriate to the application
   context.
4. **Lifecycle correctness:** Handles pagination, long-running operations,
   partition keys, terminal states, and resource cleanup.
5. **Dependency compatibility:** Uses compatible, non-retired package versions.
6. **Error semantics:** Correctly handles exceptions, unexpected responses,
   callbacks, or status-based failures according to the SDK.
7. **First-build success:** Produces code that compiles without correction.
8. **Repair efficiency:** Requires few additional turns or edits after errors.
9. **Hallucination rate:** Avoids invented packages, methods, options, enums,
   and result properties.
10. **Operational safety:** Avoids hardcoded secrets, destructive defaults,
    unbounded reads, tight polling, and leaked resources.

Prompt criteria should evaluate required behavior and accept equivalent SDK
patterns. Language criteria should be conditional where practices depend on the
application boundary or service API. Program checks should continue validating
installation, compilation, linting, and type safety.

## Repair cases

Repair tasks test whether SDK types, diagnostics, naming, documentation, and
migration guidance lead an agent toward a correct solution:

- Replace a retired Azure package with its current successor.
- Correct a plausible but nonexistent method or option.
- Replace an incorrect management-plane or data-plane package.
- Fix a missing partition key in a Cosmos DB point operation.
- Replace manual polling with the SDK's supported polling pattern.
- Resolve incompatible package versions.
- Update code written for an older SDK generation.
- Diagnose and fix a real compiler error without naming the expected API.

## Interpreting assistance uplift

The existing three environment arms help identify where SDK usability problems
originate:

| Result | Likely interpretation |
|---|---|
| Baseline strong with little uplift | The SDK is intrinsically agent-friendly |
| Baseline weak and assisted variants strong | Discoverability or training knowledge is weak |
| All variants weak | The API, documentation, tooling, or evaluation criteria need attention |
| Baseline strong and assisted variants weaker | Skill or MCP guidance is stale or conflicting |

Trajectory metrics such as tool usage, compilation attempts, corrective turns,
latency, and token consumption should remain diagnostic evidence rather than
correctness scores.

## Initial expansion

Start with a small representative set per language:

- One CRUD workflow.
- One pageable query.
- One long-running operation.
- One event-driven or callback-based client.
- One preview or rapidly evolving SDK.

Create guided and intent-only versions of the same underlying task where
possible. This isolates the cost of SDK discovery while keeping behavioral
requirements comparable.

The complete progression is:

1. Guided API assembly.
2. Service named, SDK symbols omitted.
3. Capability-based service and SDK selection.
4. Production cloud-native solution.
5. Repair, migration, or incident diagnosis.
