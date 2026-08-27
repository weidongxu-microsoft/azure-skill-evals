# Repository guidance

## Purpose

This repository uses Vally to compare the same Azure coding task across three
environments:

1. Baseline without Azure MCP or skills.
2. Azure MCP plus general Azure skills.
3. Azure MCP plus general Azure skills and the complete language-specific SDK
   skill suite.

Keep the prompt, model, trial count, timeout, and graders identical across the
three variants. Experiments may vary only the declared skill and MCP
environment paths.

The third arm must expose every skill from the applicable `microsoft/skills`
language plugin. Do not grade or require invocation of a particular skill.

Migrated scenarios cover Python, .NET, Java, and TypeScript. Each evaluation
has scenario-specific and reusable language correctness checks; the number of
checks can vary by scenario.

## Scenario layout

Keep all files owned by one evaluation case together:

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

Add root-level tooling only when multiple scenarios reuse it. Vally 0.12 does
not support external grader-list includes, so each eval declares its
`language/*` graders while invoking the shared language checker.

## Sources of truth

- `scenarios/<name>/eval.yaml` defines stimuli, grader composition, weights,
  and artifacts.
- `scenarios/<name>/tools/` implements scenario-specific deterministic code
  criteria.
- `experiments/<language>/experiment.yaml` defines controlled environment
  variants shared by all scenarios for that language.
- `scenarios/<name>/golden/` contains the runnable, lint-clean reference
  application.
- `scenarios/<name>/*.test.mjs` validates scenario-specific graders.
- `languages/<language>/` implements and tests reusable language checks.
- `dependencies.lock.json` records pinned external repositories and package
  versions.
- `docs/pilot-results/` contains concise, reviewed findings from completed
  experiments.

Code synthesized inside a negative test exercises one grader behavior. Tests
must load their positive workspace from the corresponding real application in
the scenario's `golden/` directory.

A golden application establishes that at least one complete, executable
implementation passes syntax checks, linting, and every deterministic grader.
It is a positive oracle, not the only canonical answer. Graders must accept
equivalent valid implementations and must include negative and alternate-form
fixtures to prevent overfitting to the reference application's exact structure.

## Dependency locking

Run:

```powershell
pnpm bootstrap
```

The bootstrap script reads `dependencies.lock.json`, fetches each repository at
its exact commit, checks it out in detached-HEAD mode under
`.work/dependencies/`, and verifies the resulting SHA. It refuses to overwrite
a dependency checkout with local changes.

The `packages` object is currently a central version record only:

- Pin Vally independently in `package.json`.
- Pin Azure MCP independently in each experiment's MCP declaration.
- Keep those declarations synchronized with `dependencies.lock.json`.

Do not use mutable branch references or `@latest` in evaluations. The approved
npm registry is configured in `.npmrc`; do not use the public npm registry.

## Grading rules

Every criterion has weight 1. Preserve these result groups:

- `prompt/*`: scenario-specific requirements.
- `language/*`: reusable language and SDK conventions.

Grade only application and code correctness. Do not score MCP calls, tool
calls, or skill activation. Use Vally trajectories to diagnose whether
configured tools and skills loaded or were invoked. Language and prompt checker
entrypoints must reject workspaces with no top-level source file; do not require
a filename unless the stimulus explicitly specifies one.

Skills are staged into the Vally workspace. Generated-code graders must inspect
only the expected generated files and must not pass because a skill contains
matching source code.

## Validation

Run these commands before committing evaluation changes:

```powershell
node --test
python -m compileall -q scenarios
python -m ruff check scenarios
pnpm test:golden
vally lint --eval-spec scenarios --strict --verbose
vally experiment run experiments/python/experiment.yaml --output-dir reports --dry-run
vally experiment run experiments/dotnet/experiment.yaml --output-dir reports --dry-run
vally experiment run experiments/java/experiment.yaml --output-dir reports --dry-run
vally experiment run experiments/typescript/experiment.yaml --output-dir reports --dry-run
```

Use one trial per arm only for harness development. Use repeated trials before
drawing comparative quality conclusions.
