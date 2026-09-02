# Repository guidance

## Purpose

This repository uses Vally to compare the same Azure coding task across up to
three environments:

1. Baseline without Azure MCP or skills.
2. Azure MCP plus general Azure skills.
3. Azure MCP plus general Azure skills and the complete language-specific SDK
   skill suite.

Keep the prompt, model, trial count, timeout, and graders identical across all
supported variants. Experiments may vary only the declared skill and MCP
environment paths.

The third arm must expose every skill from the applicable `microsoft/skills`
language plugin. Do not grade or require invocation of a particular skill. Go
has only the first two arms because no Go Azure SDK plugin exists.

Migrated scenarios cover Python, .NET, Java, TypeScript, and Go. Each evaluation
uses the exact originating Hyoka prompt, its scenario criteria, and all
model-based Hyoka language criteria. The number of criteria can vary.

## Scenario layout

Keep all files owned by one evaluation case together:

```text
scenarios/<name>/
├── eval.yaml
└── golden/
    ├── application source
    └── dependency manifest

experiments/<language>/
└── experiment.yaml
```

Add root-level tooling only when multiple scenarios reuse it. Vally 0.12 does
not support external grader-list includes, so each eval contains its complete
single-model panel configuration.

## Sources of truth

- `scenarios/<name>/eval.yaml` defines stimuli, grader composition, weights,
  and artifacts.
- `experiments/<language>/experiment.yaml` defines controlled environment
  variants shared by all scenarios for that language.
- `scenarios/<name>/golden/` contains the runnable, lint-clean reference
  application.
- `model-graders.test.mjs` validates the active panel structure across all
  evaluations.
- `eval-workspace.gitignore` is staged as `.gitignore` in every evaluation
  workspace so dependency installs, lockfiles, and build output stay out of
  judge diffs.
- `eval-workspace-AGENTS.md` is staged as `AGENTS.md` in every evaluation
  workspace so code requests produce complete runnable projects with manifests
  at the workspace root.
- `dependencies.lock.json` records pinned external repositories and package
  versions.
- `docs/pilot-results/` contains concise, reviewed findings from completed
  experiments.

A reference application under `golden/` establishes that at least one complete,
executable implementation passes syntax checks and linting. It is a positive
oracle, not the only canonical answer. Run the same live model criteria against
reference applications in separate oracle validation rather than ordinary unit
tests.

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
- Pin Copilot CLI independently in `package.json`.
- Keep those declarations synchronized with `dependencies.lock.json`.

Keep `@github/copilot` pinned to `1.0.71` until
github/copilot-cli#4202 is resolved and a controlled GitHub Actions run
confirms that built-in file tools work. Copilot CLI `1.0.72` and later can
report `Path does not exist` or `Session filesystem path escapes root` for
existing Vally workspace files on hosted Linux runners while shell access
still succeeds. Update both `package.json` and `dependencies.lock.json` when
testing a newer version.

Do not use mutable branch references or `@latest` in evaluations. For local
npm or pnpm installs, pass the approved Azure SDK registry explicitly. GitHub
Actions uses the public npm registry.

## Grading rules

Every criterion has weight 1. Preserve these result groups:

- `prompt/*`: scenario-specific requirements.
- `language/*`: reusable language and SDK conventions.

Grade only application and code correctness. Do not score MCP calls, tool
calls, or skill activation. Use Vally trajectories to diagnose whether
configured tools and skills loaded or were invoked.

Each eval must use one `panel` grader with one judge model. Restore prompt and
criterion wording exactly from the corresponding Hyoka prompt and language
criteria files. All criteria are required, binary, equally weighted, and
evaluated from the generated diff. Accept equivalent valid implementations.

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
vally experiment run experiments/go/experiment.yaml --output-dir reports --dry-run
```

Use one trial per arm only for harness development. Use repeated trials before
drawing comparative quality conclusions.
