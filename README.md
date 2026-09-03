# Azure skill evaluations

This repository measures Azure coding-agent behavior with
[Vally](https://microsoft.github.io/vally/). It compares the same prompt and
graders across up to three environments:

1. No Azure MCP server or skills.
2. Azure MCP plus general Azure skills.
3. Azure MCP plus general Azure skills and the complete language-specific SDK
   skill suite.

Go uses only the first two environments because `microsoft/skills` does not
provide a Go Azure SDK plugin.

## Run the evaluations

```powershell
pnpm install --registry=https://pkgs.dev.azure.com/azure-sdk/public/_packaging/azure-sdk-for-js/npm/registry/
python -m pip install -r requirements-dev.txt
pnpm bootstrap
pnpm lint:evals
pnpm test
pnpm experiment:python
pnpm experiment:dotnet
pnpm experiment:go
pnpm experiment:java
pnpm experiment:typescript
```

Each language experiment runs every migrated scenario once per arm. Vally
writes timestamped output under `reports/`. The repository covers Python,
.NET, Java, TypeScript, and Go. Go has two arms because `microsoft/skills`
does not provide a Go Azure SDK plugin; the other languages have three. Each
evaluation has scenario-specific and reusable language correctness checks; the
number of checks can vary by scenario.

## Run evaluations in GitHub Actions

Pull requests targeting `main` run harness and model-grader configuration
tests, strict evaluation linting, and dry-runs of all five language
experiments. Agent and judge evaluations remain manual.

The `Vally evaluations` workflow provides optional suite, language, service,
plane, and scope filters plus a free-form tag field. Empty inputs do not
restrict the selection. Every active filter is combined with AND. Free-form
tag clauses are separated with semicolons, and comma-separated values within
one clause are alternatives:

```text
service=identity;language=python,typescript
```

Choose one environment variant or `all`. Dry-run is enabled by default so the
resolved plans can be reviewed before running agents. GitHub Actions installs
packages from public npm. Copilot requests use the workflow's built-in
`GITHUB_TOKEN`.

The workflow expands the selection into a language-by-variant matrix with at
most six concurrent shards. Each shard uploads its machine-readable Vally
results. An always-running fan-in job verifies shard completeness, detects
duplicate or unsuccessful trials, and publishes independent prompt, language,
and program-check totals by variant and shard. Workflow copies of the experiment files
point MCP package installation at public npm; local experiment files retain the
corporate Azure SDK feed.

The same selector can be checked locally without running Vally:

```powershell
node scripts/run-evaluations.mjs --mode suite --suite cosmos-crud --select-only
node scripts/run-evaluations.mjs --mode tags --tags "service=identity;language=python" --select-only
node scripts/run-evaluations.mjs --mode all --suite end-to-end-solutions --scope end-to-end-solution --select-only
node scripts/run-evaluations.mjs --mode all --variant all --matrix
```

## Scenario layout

Keep everything owned by one evaluation case together:

```text
scenarios/<name>/
├── eval.yaml
└── golden/
    ├── application source
    └── dependency manifest

experiments/<language>/
└── experiment.yaml
```

Each scenario uses one single-model Vally panel. The panel contains the exact
Hyoka scenario criteria and every Hyoka model-based language criterion, with
one reported point per criterion. Panel thresholds are zero so every criterion
vote is retained as observational data without gating the evaluation.
Independent program graders compile, build, or type-check the generated
project. Language experiments own the three
environment variants and can run multiple evals. Each workspace starts with a
shared `.gitignore` and `AGENTS.md`. The instructions require complete runnable
projects with root-level manifests, while the ignore rules keep installed
dependencies and build outputs out of generated workspaces. Judges receive both
the response trajectory and a bounded snapshot of the complete workspace.

## Scoring

Every criterion has weight 1. Grader names identify the source of each check:

- `prompt/*`: requirements specific to the customer scenario.
- `language/*`: reusable language and SDK conventions.
- `program/*`: deterministic compile, build, dependency, or type checks.

Fan-in aggregates these groups independently and does not calculate a combined
weighted score. Quality and program-check failures remain report data rather
than failing an evaluation shard; fan-in still fails on missing, malformed, or
incomplete results. MCP calls and skill activation remain available in Vally
trajectories as diagnostic evidence, but they do not affect correctness
results. Checker entrypoints require at least one top-level source file without
imposing a specific filename.

Reference applications remain runnable positive oracles. Live model-grader
oracle coverage verifies them separately from ordinary unit tests.

Run the live oracle validator explicitly when changing prompts, criteria, or
reference applications:

```powershell
pnpm test:oracle -- --scenario <scenario-name>
pnpm test:oracle:foundry
```

The manually dispatched **Reference application oracle validation** GitHub
Actions workflow provides the same `foundry`, single-scenario, and all-scenario
selections. Its job summary and artifact retain the per-scenario Prompt,
Language, and Program counts. It fans out by language and always collects every
scenario result; check failures remain report data, while fan-in fails only for
missing, duplicate, or malformed artifacts.

The validator converts each reference application under `golden/` into Vally's
temporary `golden_patch`, applies it through the oracle pipeline, and requires
every Prompt Check and Program Check to pass. Language Checks are reported but
do not gate the oracle because they are reusable cross-scenario guidance.
Oracle validation invokes the configured judge model, requires its normal
credentials, and is therefore intentionally separate from the ordinary
unit-test suite.

The third arm exposes every skill from the applicable `microsoft/skills`
language plugin. Scores measure whether adding that complete suite improves
the generated application; no particular skill must be invoked.

See [Architecture](docs/architecture.md) for repository boundaries and the
migration plan. See the
[Cosmos DB Python pilot](docs/pilot-results/cosmos-db-python.md) for the first
three-way trial.
