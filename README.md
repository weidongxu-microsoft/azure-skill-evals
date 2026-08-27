# Azure skill evaluations

This repository measures Azure coding-agent behavior with
[Vally](https://microsoft.github.io/vally/). It compares the same prompt and
graders across three environments:

1. No Azure MCP server or skills.
2. Azure MCP plus general Azure skills.
3. Azure MCP plus general Azure skills and a language-specific SDK skill.

## Run the Cosmos DB evaluations

```powershell
pnpm install
python -m pip install -r requirements-dev.txt
pnpm bootstrap
pnpm lint:evals
pnpm test
pnpm experiment:cosmos:python
pnpm experiment:cosmos:dotnet
pnpm experiment:cosmos:java
pnpm experiment:cosmos:typescript
```

Each experiment runs one trial per arm. Vally writes timestamped output under
`reports/`. The repository currently covers Python, .NET, Java, and TypeScript
Cosmos DB CRUD applications. Each language has 11 correctness checks split
between scenario-specific and reusable language requirements.

## Scenario layout

Keep everything owned by one evaluation case together:

```text
scenarios/<name>/
├── eval.yaml
├── experiment.yaml
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
```

Scenario evals stage the applicable shared language checker and declare each
check separately so Vally reports independent one-point results.

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

The pinned `microsoft/skills` revision has data-plane Cosmos skills for Python,
Java, and TypeScript. It has no Cosmos data-plane .NET skill, so the .NET
third arm loads `azure-resource-manager-cosmosdb-dotnet`, the only Cosmos .NET
skill. That skill explicitly distinguishes management-plane operations from
the requested `Microsoft.Azure.Cosmos` data-plane work.

See [Architecture](docs/architecture.md) for repository boundaries and the
migration plan. See the
[Cosmos DB Python pilot](docs/pilot-results/cosmos-db-python.md) for the first
three-way trial.
