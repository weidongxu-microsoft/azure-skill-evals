# Repository guidance

## Purpose

This repository uses Vally to compare the same Azure coding task across three
environments:

1. Baseline without Azure MCP or skills.
2. Azure MCP plus general Azure skills.
3. Azure MCP plus general Azure skills and a language-specific SDK skill.

Keep the prompt, model, trial count, timeout, and graders identical across the
three variants. Experiments may vary only the declared skill and MCP
environment paths.

## Sources of truth

- `scenarios/<name>/eval.yaml` defines stimuli, grader composition, weights,
  and artifacts.
- `scenarios/<name>/tools/` implements scenario-specific deterministic code
  criteria.
- `scenarios/<name>/experiment.yaml` defines controlled environment variants.
- `scenarios/<name>/golden/` contains the runnable, lint-clean reference
  application.
- `scenarios/<name>/*.test.mjs` validates scenario-specific graders.
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
- `workspace/*`: required generated artifacts.
- `trajectory/*`: required tool or skill behavior.

Report content checks separately from behavior checks. A baseline intentionally
cannot pass a criterion requiring Azure MCP, so do not present only the combined
score when comparing code quality.

Skills are staged into the Vally workspace. Generated-code graders must inspect
only the expected generated files and must not pass because a skill contains
matching source code.

## Validation

Run these commands before committing evaluation changes:

```powershell
node --test
python -m compileall -q scenarios
python -m ruff check scenarios
vally lint --eval-spec scenarios --strict --verbose
vally experiment run scenarios/cosmos-db-python-crud/experiment.yaml --output-dir reports --dry-run
```

Use one trial per arm only for harness development. Use repeated trials before
drawing comparative quality conclusions.
