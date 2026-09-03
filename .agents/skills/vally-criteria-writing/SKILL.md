---
name: vally-criteria-writing
description: Write concise, structured, specific Vally criteria that are focused without excluding equivalent valid implementations.
---

# Vally Criteria Writing

Use this skill when writing or refining criteria in a Vally `eval.yaml`.

## Required qualities

Every criterion must be:

1. **Concise**: a short checklist, not prose.
2. **Structured**: show the required flow or related observations.
3. **Specific**: identify concrete evidence that can be found in code.
4. **Focused**: evaluate one capability, not a broad collection of concerns.
5. **Inclusive**: allow equivalent valid implementations.

## Preferred shape

Use two to five short bullets:

```yaml
- name: prompt/descriptive-kebab-case-name
  description: |-
    - Required input or precondition.
    - Operation or service interaction -> observable result.
    - Required returned or persisted values.
    - Rejected input, unsuccessful state, or cleanup behavior.
  weight: 1
  pass_threshold: 1
```

Use `input -> operation -> result` when it makes the flow clearer. Do not force
that syntax when an ordinary short bullet is clearer.

## Be concise

- Include only requirements needed to judge the capability.
- Prefer operations, values, and observable states over full sentences.
- Express requirements, alternatives, and conditions as separate bullets.

```yaml
description: |-
  - Ingest every supplied document without rewriting it.
  - Verify retrieval readiness before accepting questions.
  - Failed or timed-out ingestion -> actionable service diagnostics.
```

## Be structured and specific

- Name the boundary being checked: HTTP route, durable store, Foundry project,
  retrieval service, evaluator, or SDK client.
- Name values that must cross boundaries, such as `responseId`, authenticated
  employee identity, retrieved context, citation source, or terminal status.
- State what must be returned, persisted, rejected, retried, or deleted.
- Include failure behavior when success-path code is insufficient evidence.
- For tests, list behavioral scenarios rather than a test count.

```yaml
description: |-
  - Load the persisted response identified by `responseId`.
  - Match it to the authenticated employee.
  - Reject missing or employee-mismatched responses.
  - Persist the rating linked to `responseId`.
```

## Keep one capability per criterion

Split requirements that can pass or fail independently. Authentication,
pagination, logging, and error handling should not share one criterion.

Keep inseparable steps together. Ingestion, readiness polling, and unsuccessful
terminal handling may remain one criterion when the capability is retrieval
readiness.

## Allow valid implementations

- Describe required behavior before naming SDK methods.
- Treat listed methods as valid evidence unless the prompt requires that exact
  API.
- Accept equivalent schemas, internal names, and service choices that preserve
  the required behavior.
- Derive requirements from the task rather than golden-implementation helpers,
  structure, or bookkeeping.
- Put mutually exclusive implementation alternatives in one criterion.
  Separate required criteria would require every alternative.

```yaml
description: |-
  - Ingest supplied documents through a retrieval service.
  - Valid paths: direct Search upload, Blob-backed Search indexing, or Foundry
    file-search ingestion.
  - Wait for the selected service's successful readiness state.
```

Use exact symbols when the symbol is the requirement:

```yaml
description: |-
  - Catch Azure `RestError`.
  - Inspect `statusCode` for error-specific handling.
  - Generic `Error` handling alone does not pass.
```

## Final check

Before saving a criterion:

1. Can it be read quickly as a checklist?
2. Does every bullet identify observable evidence?
3. Does it cover only one independently verifiable capability?
4. Could a different valid architecture satisfy the task? If yes, describe the
   behavior or include the alternative.
5. Could superficial code pass? If yes, add the missing value flow, output,
   state transition, identity check, or failure condition.
6. Does it grade application correctness rather than MCP calls, skill
   activation, or tool choice?
