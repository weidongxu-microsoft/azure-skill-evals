# Java main baseline

Run date: 2026-09-08

This is the true pre-change Java baseline from the repository's unchanged
default `main` branch at
`8d46011f83b028e15c82d81b38e0cade785902b6`. The child worktree matched
`origin/main` exactly before the run; no evaluation, experiment, prompt,
grader, model, timeout, trial, skill, MCP, package-pin, or program-checker
configuration was changed.

One trial per arm is useful for harness and rubric analysis, but it is not a
stable quality ranking.

## Configuration and provenance

- Experiment: `experiments/java/experiment.yaml` using Vally `0.15.0`.
- Model and judge: `gpt-5.6-sol`; one trial; 30-minute timeout.
- Raw results: `reports/java-main-baseline/20260908T005600Z/`.
- Deterministic replay evidence:
  `reports/java-main-baseline/20260908T005600Z/program-replay/`.
- Generated workspaces: baseline under ignored `reports/w/b/`; augmented
  workspaces under uncommitted short-path roots `C:\v\jmb\a` and
  `C:\v\jmb\f` to avoid Windows path-length failures while staging skills.
  These workspace roots were retained through spot-checking, never committed,
  and removed after the reports were completed.
- Experiment hash: `73b1747db86211bb`; all 30 evaluation hashes
  matched across all three variants.

The nine final disjoint shard commands were:

```powershell
pnpm exec vally experiment run experiments\java\experiment.yaml --variant baseline --shard 1/3 --output-dir reports\java-main-baseline\20260908T005600Z\baseline --workspace reports\w\b --workers 1 --run-id d0b60a1f-866a-4f97-b95a-3b9784375ebc
pnpm exec vally experiment run experiments\java\experiment.yaml --variant baseline --shard 2/3 --output-dir reports\java-main-baseline\20260908T005600Z\baseline --workspace reports\w\b --workers 1 --run-id d0b60a1f-866a-4f97-b95a-3b9784375ebc
pnpm exec vally experiment run experiments\java\experiment.yaml --variant baseline --shard 3/3 --output-dir reports\java-main-baseline\20260908T005600Z\baseline --workspace reports\w\b --workers 1 --run-id d0b60a1f-866a-4f97-b95a-3b9784375ebc
pnpm exec vally experiment run experiments\java\experiment.yaml --variant azure-skill-mcp --shard 1/3 --output-dir reports\java-main-baseline\20260908T005600Z\azure-skill-mcp --workspace C:\v\jmb\a --workers 1 --run-id 787722d8-a3de-4c50-91dd-b3330a3fd6ad
pnpm exec vally experiment run experiments\java\experiment.yaml --variant azure-skill-mcp --shard 2/3 --output-dir reports\java-main-baseline\20260908T005600Z\azure-skill-mcp --workspace C:\v\jmb\a --workers 1 --run-id 787722d8-a3de-4c50-91dd-b3330a3fd6ad
pnpm exec vally experiment run experiments\java\experiment.yaml --variant azure-skill-mcp --shard 3/3 --output-dir reports\java-main-baseline\20260908T005600Z\azure-skill-mcp --workspace C:\v\jmb\a --workers 1 --run-id 787722d8-a3de-4c50-91dd-b3330a3fd6ad
pnpm exec vally experiment run experiments\java\experiment.yaml --variant azure-skill-mcp-microsoft-skill --shard 1/3 --output-dir reports\java-main-baseline\20260908T005600Z\full-sdk --workspace C:\v\jmb\f --workers 1 --run-id 59baf6e5-4a2f-4eef-8362-86512ef660d8
pnpm exec vally experiment run experiments\java\experiment.yaml --variant azure-skill-mcp-microsoft-skill --shard 2/3 --output-dir reports\java-main-baseline\20260908T005600Z\full-sdk --workspace C:\v\jmb\f --workers 1 --run-id 59baf6e5-4a2f-4eef-8362-86512ef660d8
pnpm exec vally experiment run experiments\java\experiment.yaml --variant azure-skill-mcp-microsoft-skill --shard 3/3 --output-dir reports\java-main-baseline\20260908T005600Z\full-sdk --workspace C:\v\jmb\f --workers 1 --run-id 59baf6e5-4a2f-4eef-8362-86512ef660d8
```

These produced nine disjoint 10-evaluation shards. The final run IDs are:

| Variant | Run ID | Artifact path |
|---|---|---|
| Baseline | `d0b60a1f-866a-4f97-b95a-3b9784375ebc` | `reports/java-main-baseline/20260908T005600Z/baseline/d0b60a1f-866a-4f97-b95a-3b9784375ebc/` |
| Azure skills + MCP | `787722d8-a3de-4c50-91dd-b3330a3fd6ad` | `reports/java-main-baseline/20260908T005600Z/azure-skill-mcp/787722d8-a3de-4c50-91dd-b3330a3fd6ad/` |
| Full Java SDK skills | `59baf6e5-4a2f-4eef-8362-86512ef660d8` | `reports/java-main-baseline/20260908T005600Z/full-sdk/59baf6e5-4a2f-4eef-8362-86512ef660d8/` |

Three predecessor launch sets produced no final `results.jsonl` and are
excluded from reconciliation: commands without `--shard` were rejected by
Vally; the first `1/1` workspace roots and first augmented `3/3` workspace
roots were stopped after Windows path-length failures. Their run IDs were
`3f623034-6416-4a66-8b5f-9df65091c4dc`,
`7398f42b-6717-4982-9fc4-beb4b2409764`,
`57cecf15-b3bd-4ff9-b454-7efe0ea95c95`,
`0db9e231-355b-4e5e-9a64-62fe9fd0db47`,
`ad9467ce-f1bd-4f89-b7b2-41cc612bf29e`,
`f8e2a549-0b10-46bc-a0ec-4dd8bb88e76b`,
`be63aad9-339a-473d-adb1-b2fb4ea472c7`, and
`685ef82c-1fe7-4082-ab46-ced6ca6fb6c9`.

## Criterion composition

The unchanged 30 evaluations contain 236 `prompt/*` and 330 `language/*`
criterion occurrences (566 model-judged occurrences), plus one
`program/java-project-compiles` check per evaluation (30 program occurrences).
Each variant therefore evaluated the same 596 total occurrences.

## Deterministic program replay

The original Vally JSONL is retained unchanged. Its program grader reported
0/30 in every variant: 89 checks failed before compilation with
`spawnSync mvn ENOENT`, and the remaining baseline feature-flags trial had no
Java build manifest. Because ENOENT is a harness observation rather than an
application result, the authoritative program rates below come from replaying
the unchanged main checker against reconstructed generated workspaces.

All 90 retained `workspace.patch` files were text-identical to their trajectory
diffs and contained only newly generated files. Each was applied outside the
repository under `C:\v\jmr` on top of `.gitignore`, `AGENTS.md`, and
`.vally/program-checks/java.mjs` read directly from main
`8d46011f83b028e15c82d81b38e0cade785902b6`. The checker SHA-256 was
`6fc76b5c93a3bcbb59b0ccb21e1b990c7feebb42b5efcb70b8ffac3028ad1b38`.
The following replay command reconstructed all workspaces and invoked
`node .vally/program-checks/java.mjs` with the original three-minute timeout:

```powershell
node reports\java-main-baseline\20260908T005600Z\program-replay\replay-java-program-checks.mjs
```

The replay used
`JAVA_HOME=C:\Users\xiaofeicao\AppData\Local\Programs\Microsoft\jdk-17.0.10.7-hotspot`
and prepended
`C:\Users\xiaofeicao\.copilot\session-state\b26c4fd0-55dc-4560-a3cd-c7f5933bdd36\files\tools\apache-maven-3.9.16\bin`
to `PATH`. Recorded version output confirms Microsoft OpenJDK 17.0.10 and
Apache Maven 3.9.16.

Node 24 on Windows could not directly spawn the Maven distribution's batch
launcher: unchanged `spawnSync("mvn")` returned ENOENT and an explicit
`mvn.cmd` probe returned EINVAL. To leave both the checker and generated
projects byte-for-byte unchanged, the replay built a small `mvn.exe` launcher
that delegates its arguments and exit code to the pinned `mvn.cmd`. The Maven
bin remained first on `PATH`; the shim directory followed it. Its source,
binary, version probes, and build command are retained in the replay evidence:

```powershell
go build -o reports\java-main-baseline\20260908T005600Z\program-replay\bin\mvn.exe reports\java-main-baseline\20260908T005600Z\program-replay\mvn-shim.go
```

The shim SHA-256 was
`e98246f593e4db449219ed12b29e284c95cf2fb9965b501ceaa0879294f86e45`;
its source SHA-256 was
`fdc7f9405cd95bbe14a5abd7564e777fe7b40dd38ca2680f06f9c61ed3de9510`.
Shim setup and launch probes are infrastructure evidence and are not counted
as application compile results.

| Replay evidence | Path |
|---|---|
| Per-trial patch sources, hashes, staging hashes, and workspace paths | `program-replay/reconstruction-manifest.jsonl` |
| All 90 replay outcomes | `program-replay/program-replay-results.jsonl` |
| Complete per-trial checker output | `program-replay/logs/` |
| Java, Maven, shim build command, and checksums | `program-replay/tool-versions.json` |
| Bare-name ENOENT, explicit-batch EINVAL, and successful shim probes | `program-replay/maven-launch-probes.json` |
| Cross-check of patches, logs, outcomes, inventory, and report totals | `program-replay/replay-integrity.json` |

These paths are relative to the ignored raw-results root. The reconstructed
`C:\v\jmr` workspaces were retained through replay and spot-checking, never
committed, and removed after validation; the evidence above remains.

## Results

An effective whole-trial pass requires both the unchanged model panel and the
authoritative replayed program check to pass.

| Variant | Environment | Effective trial passes | Prompt | Language | Replayed program |
|---|---|---:|---:|---:|---:|
| Baseline | No skills; no Azure MCP | 4/30 (13.3%) | 209/236 (88.6%) | 265/330 (80.3%) | 29/30 (96.7%) |
| Azure skills + MCP | General Azure skills; Azure MCP | 1/30 (3.3%) | 223/236 (94.5%) | 263/330 (79.7%) | 30/30 (100.0%) |
| Full Java SDK skills | General Azure skills; all Java SDK skills; Azure MCP | 1/30 (3.3%) | 228/236 (96.6%) | 268/330 (81.2%) | 30/30 (100.0%) |

The replay compiled all 89 generated Maven projects successfully with the
exact `mvn -q -DskipTests compile` selected by the main checker. The one actual
program failure is baseline `app-configuration-java-feature-flags`: its empty
patch reconstructs no build manifest. The model panel passed every applicable
criterion in 4/30 baseline, 1/30 Azure skills + MCP, and 1/30 full Java SDK
skills trials; all six also passed replay, yielding the effective trial counts.

## Trajectory metrics

Durations are sums across 30 trials, not concurrent wall-clock elapsed time.
Token totals include cache reads as represented by Vally's `totalTokens`.
Skill activations count `skill` tool calls, Azure MCP calls count `azure-*`
tools, and web calls count `web_fetch` calls in the trajectories.

| Variant | End-to-end duration | Agent wall time | Tokens | Turns | Tool calls | Skill activations | Azure MCP calls | Web calls | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 71.4 min | 59.8 min | 8,646,428 | 328 | 537 | 0 | 0 | 90 | 0 |
| Azure skills + MCP | 125.1 min | 106.9 min | 27,077,004 | 534 | 1,009 | 21 | 173 | 139 | 0 |
| Full Java SDK skills | 109.8 min | 90.1 min | 24,380,704 | 494 | 826 | 36 | 143 | 116 | 0 |

Skill activation counts are trajectory diagnostics only and did not affect
grading. Activated-skill frequencies were:

| Variant | Activated skills |
|---|---|
| Baseline | None |
| Azure skills + MCP | `microsoft-foundry` (7), `azure-ai` (5), `azure-storage` (5), `azure-messaging` (3), `entra-agent-id` (1) |
| Full Java SDK skills | `azure-identity-java` (7), `azure-storage-blob-java` (5), `azure-ai` (4), `azure-ai-projects-java` (4), `azure-ai-agents-persistent-java` (3), `azure-appconfiguration-java` (2), `azure-cosmos-java` (2), `azure-messaging` (2), `azure-security-keyvault-secrets-java` (2), `azure-eventgrid-java` (1), `azure-eventhub-java` (1), `azure-security-keyvault-keys-java` (1), `azure-storage` (1), `microsoft-foundry` (1) |

## Integrity and reconciliation

- Nine final shard directories are present: `1/3`, `2/3`, and `3/3` for
  each variant; every shard has exactly 10 successful-status rows.
- The reconciled set contains 90 rows, 90 unique variant/evaluation logical
  keys, 90 unique item IDs, and 90 unique shard keys: 30 per variant.
- Every row has exactly one panel result, one Java program-check result, and
  the expected 236 prompt + 330 language composition per variant.
- All 30 per-evaluation hashes are consistent across variants, and every
  run summary reports experiment hash `73b1747db86211bb`.
- Trajectory error total across all variants is 0.
- Zero-output predecessor attempts are not included in any total.
- The reconstruction manifest contains 90 unique variant/evaluation keys, 30
  per variant. Every retained patch matched its trajectory diff before
  application; 89 patches added generated projects and one patch was empty.
- The replay contains 90 unique records and 90 complete logs: 89 passes and one
  no-manifest failure. No original result JSONL was modified.

## Spot checks and grader interpretation

- **Program checker:** authoritative replay demonstrates that all 89 generated
  Maven projects compile. The only application program failure is the baseline
  feature-flags trial, independently supported by its empty patch,
  zero-tool trajectory, and reproduced no-manifest result. There are no
  compiler failures requiring further source diagnosis.
- **Azure SDK BOM (81 failures):** representative failed `pom.xml` files used
  individually versioned Azure artifacts without importing `azure-sdk-bom`.
  One inspected project imported the BOM but then overrode individual Azure
  artifact versions. Those sampled judge failures match the criterion; this
  review did not independently inspect all 81 occurrences.
- **LRO poller pattern (18 failures):** all nine failures in the three
  persistent-agent scenarios are an obvious rubric applicability error. Those
  implementations poll runs with `Thread.sleep(...)` and `getRun(...)`, which
  is the pattern documented by the pinned
  `azure-ai-agents-persistent-java` skill; the relevant API does not expose the
  generic `SyncPoller`/`PollerFlux` shape demanded by this criterion. This
  finding is not extended to the other nine LRO failures.
- **Pagination type pattern (14 failures):** all three Cosmos ToDo repository
  implementations preserve response pages and continuation tokens through
  custom `Iterable<ToDoPage>`/`Flux<ToDoPage>` wrappers rather than literal
  `PagedIterable`/`PagedFlux` types. Whether the generic type-name criterion
  should reject this behavior-preserving design is ambiguous; the other 11
  pagination failures were not classified from this spot check.
- **Service-specific exceptions (37 failures):** a representative persistent
  agent implementation allowed SDK exceptions to propagate without
  scenario-level handling, supporting that sampled failure. No claim is made
  that all 37 judge rationales were independently reproduced.

The exhaustive failed-occurrence table and judge-recorded reasons are in
[java-main-baseline-failed-criteria.md](java-main-baseline-failed-criteria.md).
Judge reasoning is reported as rationale, not as an independently reproduced
root cause unless explicitly identified by a spot check.

## Descriptive comparison with preservation-first

The preservation-first reference run
`f3d83c05-de08-465a-a93c-51e24ca8db94` is compared directly below:

| Separate run | Prompt criteria | Language criteria | Baseline trials | Azure skills + MCP trials | Full Java SDK skills trials |
|---|---:|---:|---:|---:|---:|
| Unchanged `main` baseline (`8d46011f`, effective replay verdict) | 236 | 330 | 4/30 | 1/30 | 1/30 |
| Preservation-first reference | 262 | 246 | 0/30 | 0/30 | 1/30 |

These are separate generations with different rubric compositions. The counts
are descriptive provenance only; they do not support a causal quality
conclusion about the preservation changes or any environment variant.

## Limitations

- One generation per arm cannot separate environment effects from model
  variance and must not be interpreted as a stable ranking.
- Reconstructed workspaces use the retained full patches plus exact main-base
  staged files rather than the deleted original workspace directories. Patch
  equality and new-file-only checks make application reconstruction reliable,
  but ephemeral build output from the original directories is unavailable.
- The program checker compiles with tests skipped; a replay pass does not prove
  runtime Azure behavior or test success.
- Model-judge reasons were not all independently reproduced; spot checks
  cover only the highest-frequency and most suspicious categories.
- Augmented generated workspaces required short external paths on Windows;
  raw result artifacts, trajectories, diffs, and captured application files
  remain under the ignored report root.
