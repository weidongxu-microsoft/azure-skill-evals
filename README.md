# Azure skill evaluations

This repository measures Azure coding-agent behavior with
[Vally](https://microsoft.github.io/vally/). It compares the same prompt and
graders across three environments:

1. No Azure MCP server or skills.
2. Azure MCP plus general Azure skills.
3. Azure MCP plus general Azure skills and a language-specific SDK skill.

## Run the Cosmos DB Python pilot

```powershell
pnpm install
python -m pip install -r requirements-dev.txt
pnpm bootstrap
pnpm lint:evals
pnpm test
pnpm experiment:cosmos
```

The experiment runs one trial per arm. Vally writes timestamped output under
`reports/`.

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
```

Put only genuinely reusable runners and infrastructure in root-level
directories.

## Scoring

Every criterion has weight 1. Grader names identify the source of each check:

- `prompt/*`: requirements specific to the customer scenario.
- `language/*`: reusable language and SDK conventions.
- `workspace/*`: required generated artifacts.
- `trajectory/*`: required agent behavior, including Azure MCP use.

The golden application proves that the deterministic grader suite has at least
one valid solution without requiring generated code to match one exact
implementation.

See [Architecture](docs/architecture.md) for repository boundaries and the
migration plan. See the
[Cosmos DB Python pilot](docs/pilot-results/cosmos-db-python.md) for the first
three-way trial.
