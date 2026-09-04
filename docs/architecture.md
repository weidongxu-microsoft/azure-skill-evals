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

Vally owns execution, trajectories, model grading, and experiment isolation.
Each scenario directory owns its eval and reference application under
`golden/`. Each language owns one shared experiment under `experiments/`. Every
`eval.yaml` restores its originating Hyoka prompt and defines one single-model
panel containing the exact Hyoka scenario and language criteria. The experiment
changes only
`/environment/skills` and
`/environment/mcpServers`, so prompts, models, limits, and graders cannot drift
between arms.

External skill repositories and npm packages are pinned in
`dependencies.lock.json`. `scripts/bootstrap-dependencies.ps1` materializes the
repositories under `.work/dependencies/`; generated dependencies and reports
stay outside Git. Every task stages the cross-language
`eval-workspace.gitignore`, which allowlists source, manifests, configuration,
fixtures, and project documentation while excluding dependencies, build
output, caches, and runtime data.

Judges receive the generated diff by default. Large solution evaluations use
workspace-delivered diff evidence so judges can retrieve relevant parts of the
complete patch without including staged skills, dependencies, or build output.
The Foundry solution panels allow 128,000 retrieved evidence characters per
judge while retaining Vally's 64,000-character default for smaller evaluations.

Every evaluation workspace also receives a shared `AGENTS.md` instruction that
requires code requests to produce complete runnable projects with root-level
dependency or project manifests. This preserves the originating Hyoka task
prompt while making generated workspaces suitable for deterministic compile and
lint graders.

Grader names preserve three independent result groups:

| Prefix | Responsibility |
|---|---|
| `prompt/` | Scenario-specific completion requirements |
| `language/` | Reusable language and Azure SDK conventions |
| `program/` | Deterministic compile, build, dependency, and type checks |

Each panel criterion is binary and equally weighted. Panel and overall
thresholds are zero so every criterion vote is retained as observational data
without gating data collection. Program graders remain independent from the
panel, and fan-in reports each result group without calculating an overall
weighted score. Quality failures do not fail evaluation shards; missing,
malformed, or incomplete result artifacts remain integrity failures. Raw Vally
trajectories remain the source of truth for skill activation, MCP calls,
timing, errors, and token usage, but these diagnostics do not affect
correctness results.

## What changes

- Prompt Markdown frontmatter becomes Vally stimulus metadata and tags.
- Hyoka prompt and language criteria become named items in one model review.
- Explicit Vally variants replace Hyoka configuration combinations.
- `results.jsonl` replaces Hyoka report JSON as the machine-readable result.
- GitHub Actions runs one shard per selected language and variant, then
  aggregates shard artifacts without assuming only two arms.

## What stays the same

- The same model runs the same prompt in every arm.
- Each criterion contributes one point.
- Prompt, language, and program results remain separate.
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

### Model-grading variance

- **Likelihood:** High
- **Impact:** Medium
- **Mitigation:** Use binary criteria, repeated trials for conclusions, and
  separate live golden-oracle calibration.

### Incomplete judge evidence

- **Likelihood:** Medium
- **Impact:** High
- **Mitigation:** Every evaluation uses generated-diff evidence with a shared
  source-and-project allowlist. Trajectories remain diagnostic artifacts rather
  than correctness evidence, and staged skills or generated build output do not
  consume the judge's application evidence.

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

Version 1 includes migrated Azure SDK stimuli for Python, .NET, Java,
TypeScript, and Go. Every evaluation has correctness criteria, deterministic
program checks, a buildable reference application, configuration linting,
model-grader structure tests, and one trial per arm. Go has two experiment arms
because `microsoft/skills` has no Go Azure SDK plugin; the other languages have
three.

Version 1 does not migrate all Hyoka prompts, add PR quality gates, or claim
statistical significance. Those follow after the pilot reproduces correct
workspace, MCP, and skill evidence.

## Success criteria

- Vally plans every supported variant with no configuration drift.
- Each variant produces application code and independently visible checks.
- Results distinguish prompt, language, and program checks.
- Trajectories preserve MCP and skill diagnostics without changing scores.
