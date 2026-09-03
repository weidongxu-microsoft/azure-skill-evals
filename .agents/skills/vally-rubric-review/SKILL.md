---
name: vally-rubric-review
description: Review or refine Vally evaluation rubrics, audit grader decisions, and compare environment variants against generated code and trajectories.
---

# Vally Rubric Review

Use this skill when creating or revising `eval.yaml` criteria, investigating
unexpected Vally scores, or deciding whether one experiment variant produced a
real quality improvement.

## Sources of truth

Review all relevant evidence:

1. The task prompt and criteria in `scenarios/<name>/eval.yaml`.
2. The generated workspace diff or reconstructed final files.
3. Criterion-level scores and evidence in `results.jsonl`.
4. The trajectory in `events.jsonl` or `trajectory.events`.
5. Program-grader output for installation, build, lint, and tests.

Do not infer implementation quality from aggregate scores, final assistant
messages, skill activation, or tool-call counts alone.

## Rubric design

- Grade application and code correctness, not MCP calls, skill calls, or tool
  selection.
- Keep prompt, model, trials, timeout, and graders identical across variants.
- Give every required binary criterion `weight: 1` and `pass_threshold: 1`.
- Keep one independently verifiable responsibility per criterion.
- State observable behavior and required evidence. Avoid subjective terms such
  as "proper," "robust," or "best practice" without defining them.
- Accept equivalent valid architectures. Put alternative implementation paths
  in one criterion because separate required criteria require every path.
- Treat listed SDK methods as examples of acceptable evidence unless the exact
  method is itself the requirement.
- Do not require golden-implementation details that the prompt does not require.
- Require failure handling explicitly when success-path code alone is
  insufficient.
- For test criteria, list the behavioral scenarios that tests must demonstrate.
  Do not substitute test count, file count, or code coverage for behavior.
- Keep language criteria literal. If a criterion requires `RestError`,
  `@azure/logger`, restricted production credentials, or paged iteration, do
  not pass an implementation that merely has generic error handling, application
  logging, `DefaultAzureCredential`, or one unrelated `for await` loop.

## Result audit

Build a criterion matrix with:

| Criterion | Reported result | Code evidence | Independent result |
|---|---|---|---|

For every difference between variants:

1. Locate the exact code or test responsible for the reported pass.
2. Check the complete criterion, including negative clauses and failure paths.
3. Mark the change as:
   - **Real improvement**: the stronger variant satisfies evidence the baseline
     lacks.
   - **False positive**: the grader passed code that violates the criterion.
   - **False negative**: the grader failed code that satisfies the criterion.
   - **Different tradeoff**: architecture changed without a clear quality gain.
4. Recalculate prompt, language, and program totals from the independent
   decisions.

Pay particular attention to:

- Calls such as Cosmos DB `fetchAll()` hidden beside valid paged iteration.
- Unrestricted `DefaultAzureCredential` presented as production authentication.
- Generic `Error` checks presented as typed Azure `RestError` handling.
- Application logging presented as Azure SDK diagnostic logging.
- Tests that mention a value such as retrieval context without asserting that
  it reaches the required downstream API.
- Failure tests for ingestion being presented as durable-write compensation
  tests.
- Feedback lookup that correctly scopes by authenticated employee but is failed
  only because no redundant conversation identifier is supplied.

## Trajectory audit

Inspect `tool_call` events directly and count `data.toolName`. Report MCP and
skill usage separately from code quality.

- An MCP server being configured does not prove it was called.
- A skill activation does not prove its guidance was followed.
- Documentation or package inspection may explain an improvement, but it is not
  itself graded evidence.
- Use trajectories diagnostically to explain behavior; never add a criterion
  requiring a particular tool or skill invocation.

## Refining a criterion

When a grader decision is wrong:

1. Confirm the code-based decision before editing the rubric.
2. Tighten only the ambiguous criterion.
3. Preserve the originating task requirement and valid architectural choices.
4. Prefer short lists of required observations over long prose.
5. Re-run the maintained golden oracle for the exact scenario.
6. Run the same scenario and trial settings across all supported variants.
7. Use repeated trials before making comparative quality claims.

Do not weaken a criterion merely to make one observed candidate pass. Change it
only when the candidate demonstrates behavior that is valid under the task.
