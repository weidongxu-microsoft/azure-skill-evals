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
pnpm bootstrap
pnpm lint:evals
pnpm test
pnpm experiment:cosmos
```

The experiment runs one trial per arm. Vally writes timestamped output under
`reports/`.

## Scoring

Every criterion has weight 1. Grader names identify the source of each check:

- `prompt/*`: requirements specific to the customer scenario.
- `language/*`: reusable language and SDK conventions.
- `workspace/*`: required generated artifacts.
- `trajectory/*`: required agent behavior, including Azure MCP use.

See [Architecture](docs/architecture.md) for repository boundaries and the
migration plan.

