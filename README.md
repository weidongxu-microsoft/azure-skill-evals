# Azure skill evaluations

This repository measures Azure coding-agent behavior with
[Vally](https://microsoft.github.io/vally/). It compares the same prompt and
graders across three environments:

1. No Azure MCP server or skills.
2. Azure MCP plus general Azure skills.
3. Azure MCP plus general Azure skills and the complete language-specific SDK
   skill suite.

## Run the evaluations

```powershell
pnpm install
python -m pip install -r requirements-dev.txt
pnpm bootstrap
pnpm lint:evals
pnpm test
pnpm experiment:python
pnpm experiment:dotnet
pnpm experiment:java
pnpm experiment:typescript
```

Each language experiment runs every migrated scenario once per arm. Vally
writes timestamped output under `reports/`. The repository covers Python,
.NET, Java, and TypeScript. Each evaluation has scenario-specific and reusable
language correctness checks; the number of checks can vary by scenario.

## Run evaluations in GitHub Actions

The `Vally evaluations` workflow supports manual runs of all evaluations,
evaluations matching tags, or one suite from `.vally.yaml`. Tag clauses are
separated with semicolons, and comma-separated values within one clause are
alternatives:

```text
service=identity;language=python,typescript
```

Choose one environment variant or `all`. Dry-run is enabled by default so the
resolved plans can be reviewed before running agents. Configure the
`AZURE_ARTIFACTS_TOKEN` repository secret with a raw Azure DevOps token that
has read access to the approved npm feed. Copilot requests use the workflow's
built-in `GITHUB_TOKEN`.

The same selector can be checked locally without running Vally:

```powershell
node scripts/run-evaluations.mjs --mode suite --suite cosmos-crud --select-only
node scripts/run-evaluations.mjs --mode tags --tags "service=identity;language=python" --select-only
```

## Scenario layout

Keep everything owned by one evaluation case together:

```text
scenarios/<name>/
├── eval.yaml
├── rules.test.mjs
├── golden/
│   ├── application source
│   └── dependency manifest
└── tools/
    ├── grader entrypoint
    └── deterministic rules

languages/<language>/
├── check entrypoint
├── reusable deterministic checks
└── grader tests

experiments/<language>/
└── experiment.yaml
```

Scenario evals stage the applicable shared language checker and declare each
check separately so Vally reports independent one-point results. Language
experiments own the three environment variants and can run multiple evals.

## Scoring

Every criterion has weight 1. Grader names identify the source of each check:

- `prompt/*`: requirements specific to the customer scenario.
- `language/*`: reusable language and SDK conventions.

Scores measure only the generated application and code. MCP calls and skill
activation remain available in Vally trajectories as diagnostic evidence, but
they do not affect correctness scores. Checker entrypoints require at least one
top-level Python file without imposing a specific filename.

The golden application proves that the deterministic grader suite has at least
one valid solution without requiring generated code to match one exact
implementation.

The third arm exposes every skill from the applicable `microsoft/skills`
language plugin. Scores measure whether adding that complete suite improves
the generated application; no particular skill must be invoked.

See [Architecture](docs/architecture.md) for repository boundaries and the
migration plan. See the
[Cosmos DB Python pilot](docs/pilot-results/cosmos-db-python.md) for the first
three-way trial.
