# Evaluation architecture

## Problem statement

The existing Hyoka reports proved that Azure tooling can improve generated
code, but the evaluation harness has two correctness gaps. Workspace checks can
fail when the expected file exists, and Azure MCP checks can fail when the
trajectory contains successful Azure MCP child-tool calls. Hyoka also does not
provide reusable Vally test suites or native multi-variant experiments.

The Cosmos DB Python reference run scored 8/13, 9/13, and 10/13 across the three
arms. All arms missed `enable_cross_partition_query`, and the improved arms
used different mechanisms: the second arm used Azure MCP while the third
explicitly activated `azure-cosmos-py`.

## Proposed architecture

Vally owns execution, trajectories, grading, and experiment isolation. Each
scenario directory owns its eval, experiment, golden application, grader, and
grader tests. One `eval.yaml` defines the stimulus and the 13 equally weighted
graders. One experiment file changes only `/environment/skills` and
`/environment/mcpServers`, so prompts, models, limits, and graders cannot drift
between arms.

External skill repositories and npm packages are pinned in
`dependencies.lock.json`. `scripts/bootstrap-dependencies.ps1` materializes the
repositories under `.work/dependencies/`; generated dependencies and reports
stay outside Git.

Grader names preserve four independent result groups:

| Prefix | Responsibility |
|---|---|
| `prompt/` | Scenario-specific completion requirements |
| `language/` | Reusable Python and Azure SDK conventions |
| `workspace/` | Generated file presence |
| `trajectory/` | Tool and skill behavior |

Static Node.js checks grade code structure. Vally's built-in file and trajectory
graders validate artifacts and tool calls. The colocated golden application
must compile, pass Ruff, and pass every deterministic rule. Raw Vally
trajectories remain the source of truth for skill activation, MCP calls,
timing, errors, and token usage.

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
different facts. A score increase alone does not prove that a skill or MCP
server affected the result.

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

Version 1 includes the Cosmos DB Python CRUD stimulus, 13 existing criteria,
three experiment arms, dependency bootstrap, configuration linting, grader unit
tests, and one trial per arm.

Version 1 does not migrate all Hyoka prompts, add PR quality gates, or claim
statistical significance. Those follow after the pilot reproduces correct
workspace, MCP, and skill evidence.

## Success criteria

- Vally plans and runs exactly three variants with no configuration drift.
- Each variant produces Python code and 13 independently visible checks.
- Workspace grading recognizes generated Python files.
- The Azure arm records at least one Azure MCP call.
- The SDK arm records activation of `azure-cosmos-py`.
- Results distinguish prompt, language, workspace, and trajectory checks.
