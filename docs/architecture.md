# Evaluation architecture

## Problem statement

The existing Hyoka reports proved that Azure tooling can improve generated
code, but behavior checks can obscure whether the generated application is
actually better. Hyoka also does not provide reusable Vally test suites or
native multi-variant experiments.

The Cosmos DB Python reference run scored 8/13, 9/13, and 10/13 across the three
arms. All arms missed `enable_cross_partition_query`, and the improved arms
used different mechanisms: the second arm used Azure MCP while the third
explicitly activated `azure-cosmos-py`.

## Proposed architecture

Vally owns execution, trajectories, grading, and experiment isolation. Each
scenario directory owns its eval, golden application, grader, and grader tests.
Shared language checks live under `languages/`. Each language owns one shared
experiment under `experiments/`, whose eval list grows as scenarios migrate.
Each `eval.yaml` defines its stimulus and equally weighted correctness graders.
The number of checks can vary by scenario and language. The experiment changes
only `/environment/skills` and
`/environment/mcpServers`, so prompts, models, limits, and graders cannot drift
between arms.

External skill repositories and npm packages are pinned in
`dependencies.lock.json`. `scripts/bootstrap-dependencies.ps1` materializes the
repositories under `.work/dependencies/`; generated dependencies and reports
stay outside Git.

Grader names preserve two independent result groups:

| Prefix | Responsibility |
|---|---|
| `prompt/` | Scenario-specific completion requirements |
| `language/` | Reusable Python and Azure SDK conventions |

Static Node.js checks grade code structure and reject workspaces without a
top-level Python file. They do not require a specific filename unless the
stimulus does. The colocated golden application must compile, pass Ruff, and
pass every deterministic rule. Raw Vally
trajectories remain the source of truth for skill activation, MCP calls,
timing, errors, and token usage, but these diagnostics do not affect scores.

## What changes

- Prompt Markdown frontmatter becomes Vally stimulus metadata and tags.
- Prompt criteria become individually named graders.
- Generic language criteria become reusable rules rather than copied prose.
- Explicit Vally variants replace Hyoka configuration combinations.
- `results.jsonl` replaces Hyoka report JSON as the machine-readable result.
- A comparison script will aggregate variants without assuming only two arms.

## What stays the same

- The same model runs the same prompt in every arm.
- Each criterion contributes one point.
- Prompt and language results remain separate.
- The baseline has no Azure MCP server and no injected Azure skills.
- Existing Hyoka reports remain historical migration references.

## Key decisions

### Repository boundary

**Decision:** Keep Vally evaluations in this dedicated repository. Do not add a
second evaluation runtime to Hyoka.

### Dependency acquisition

**Decision:** Pin external repositories and packages. Bootstrap immutable
commits into `.work/dependencies/` instead of evaluating mutable default
branches.

### Behavioral evidence

**Decision:** Report configured, loaded, activated, and invoked tools as
different diagnostic facts. Do not award points for tool calls or skill
activation. A score increase alone does not prove that a skill or MCP server
affected the result.

### Trial count

**Decision:** Use one trial per arm for migration debugging. Increase to at
least three trials per arm before drawing comparative quality conclusions.

## Risks and mitigations

### Model variance

- **Likelihood:** High
- **Impact:** Medium
- **Mitigation:** Keep one trial only for harness validation, then use repeated
  trials and report distributions.

### Upstream dependency drift

- **Likelihood:** Medium
- **Impact:** High
- **Mitigation:** Pin Git commits and npm versions, record them with every run,
  and update them through reviewed pull requests.

### False-positive static grading

- **Likelihood:** Medium
- **Impact:** Medium
- **Mitigation:** Unit-test every rule with passing and failing fixtures. Use
  prompt graders only when deterministic inspection cannot express a criterion.

### Skill loading differs from plugin loading

- **Likelihood:** Medium
- **Impact:** High
- **Mitigation:** Enumerate every general Azure skill directory and verify the
  Vally trajectory's loaded and activated skill metrics during the pilot.

### Registry or MCP startup failure

- **Likelihood:** Medium
- **Impact:** High
- **Mitigation:** Pin Azure MCP, set the approved npm registry on the MCP child
  process, and surface startup errors as failed trials.

## Scope

Version 1 includes migrated Azure SDK stimuli for Python, .NET, Java, and
TypeScript. Every evaluation has correctness criteria, three experiment arms,
a buildable golden application, configuration linting, grader unit tests, and
one trial per arm.

Version 1 does not migrate all Hyoka prompts, add PR quality gates, or claim
statistical significance. Those follow after the pilot reproduces correct
workspace, MCP, and skill evidence.

## Success criteria

- Vally plans and runs exactly three variants with no configuration drift.
- Each variant produces application code and independently visible checks.
- Results distinguish prompt and language checks.
- Trajectories preserve MCP and skill diagnostics without changing scores.
