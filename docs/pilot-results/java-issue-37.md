# Java issue 37 preservation-first run

Run date: 2026-09-07

This run validates the preservation-first Java criteria follow-up for issue 37.
It used one trial for each of 30 scenarios in all three unchanged environments,
for 90 trials total.

## Criterion composition

- Original `main`: 236 prompt + 330 language = 566 criterion occurrences.
- Superseded re-audit: 225 prompt + 76 language = 301 occurrences.
- Preservation-first follow-up: 262 prompt + 246 language = 508 occurrences.
- All 162 language concerns previously merged into prompt criteria and all 8
  deferred concerns are restored as standalone points.
- The remaining 84 language removals have per-scenario prompt and SDK
  inapplicability proof in `docs/java-criterion-lineage.md`.
- All original prompt capabilities have standalone successors except six
  documented strict duplicates or inaccurate requirements.

## Integrity

- Run `f3d83c05-de08-465a-a93c-51e24ca8db94` produced 90 unique item IDs and
  `variant/evalName` keys: 30 per variant.
- Every record has `status: success`, complete panel and program-check output,
  and zero trajectory errors.
- Each evaluation has one consistent evaluation hash across its three variants.
- Model, judge, trial count, timeout, prompts, and grader composition remained
  controlled; only declared skill and MCP environment paths differ.
- Generated program checks passed 89/90 times. The baseline AI Agents function
  tool project did not compile; this is an ordinary trial outcome rather than
  an execution or harness failure.

## Outcomes

All criteria are binary and weight 1. A trial passes only when every panel
criterion and the program check pass.

| Variant | Environment | Trials passed | Prompt criteria | Language criteria | Program checks |
|---|---|---:|---:|---:|---:|
| `baseline` | No skills or Azure MCP | 0/30 | 234/262 | 197/246 | 29/30 |
| `azure-skill-mcp` | General Azure skills and Azure MCP | 0/30 | 243/262 | 206/246 | 30/30 |
| `azure-skill-mcp-microsoft-skill` | Same environment plus all Java SDK skills | 1/30 | 242/262 | 202/246 | 30/30 |

## Comparison with unchanged `main`

The baseline is the unchanged `main` composition at `8d46011`: 236 prompt and
330 language criteria. Its raw Vally program results were blocked by a Windows
Node/Maven launch incompatibility, so the table uses the authoritative replay
of the unchanged checker against all 90 reconstructed generated workspaces.

| Run | Variant | Trials passed | Prompt criteria | Language criteria | Program checks |
|---|---|---:|---:|---:|---:|
| Unchanged `main` | `baseline` | 4/30 | 209/236 | 265/330 | 29/30 |
| Unchanged `main` | `azure-skill-mcp` | 1/30 | 223/236 | 263/330 | 30/30 |
| Unchanged `main` | `azure-skill-mcp-microsoft-skill` | 1/30 | 228/236 | 268/330 | 30/30 |
| Preservation-first | `baseline` | 0/30 | 234/262 | 197/246 | 29/30 |
| Preservation-first | `azure-skill-mcp` | 0/30 | 243/262 | 206/246 | 30/30 |
| Preservation-first | `azure-skill-mcp-microsoft-skill` | 1/30 | 242/262 | 202/246 | 30/30 |

### Pass-rate change

| Variant | Unchanged `main` trials | Preservation-first trials | Difference |
|---|---:|---:|---:|
| `baseline` | 4/30 (13.33%) | 0/30 (0%) | -13.33 pp |
| `azure-skill-mcp` | 1/30 (3.33%) | 0/30 (0%) | -3.33 pp |
| `azure-skill-mcp-microsoft-skill` | 1/30 (3.33%) | 1/30 (3.33%) | 0 pp |
| **Overall** | **6/90 (6.67%)** | **1/90 (1.11%)** | **-5.56 pp** |

| Variant | Criterion group | Unchanged `main` | Preservation-first | Difference |
|---|---|---:|---:|---:|
| `baseline` | Prompt | 209/236 (88.56%) | 234/262 (89.31%) | +0.75 pp |
| `baseline` | Language | 265/330 (80.30%) | 197/246 (80.08%) | -0.22 pp |
| `baseline` | Program | 29/30 (96.67%) | 29/30 (96.67%) | 0 pp |
| `azure-skill-mcp` | Prompt | 223/236 (94.49%) | 243/262 (92.75%) | -1.74 pp |
| `azure-skill-mcp` | Language | 263/330 (79.70%) | 206/246 (83.74%) | +4.04 pp |
| `azure-skill-mcp` | Program | 30/30 (100%) | 30/30 (100%) | 0 pp |
| `azure-skill-mcp-microsoft-skill` | Prompt | 228/236 (96.61%) | 242/262 (92.37%) | -4.24 pp |
| `azure-skill-mcp-microsoft-skill` | Language | 268/330 (81.21%) | 202/246 (82.11%) | +0.90 pp |
| `azure-skill-mcp-microsoft-skill` | Program | 30/30 (100%) | 30/30 (100%) | 0 pp |

The complete unchanged-main provenance, replay evidence, and failed-criterion
inventory are in `java-main-baseline.md` and
`java-main-baseline-failed-criteria.md`.

These are separate single-trial generations with different rubric
compositions, not paired re-grades. The differences do not establish a causal
quality effect from the preservation changes or any environment variant.

The single trial per arm validates harness execution and captures one controlled
comparison. It is not enough to establish a stable quality ranking.

## Trajectory evidence

| Variant | Average duration | Tokens | Turns | Tool calls | Skill activations | Azure MCP calls | Web calls |
|---|---:|---:|---:|---:|---:|---:|---:|
| `baseline` | 1.74 min | 8,427,286 | 292 | 543 | 0 | 0 | 235 |
| `azure-skill-mcp` | 2.91 min | 18,886,623 | 434 | 728 | 19 | 184 | 105 |
| `azure-skill-mcp-microsoft-skill` | 2.68 min | 18,111,978 | 413 | 652 | 39 | 144 | 40 |

Skill activation, Azure MCP use, and web calls are diagnostic evidence only;
they do not affect grading.

## Oracle validation

- All 30 Java reference applications compile.
- All prompt, language, and program checks pass across the reconciled final
  golden-oracle validation.
- Targeted retries were used only to distinguish variable model-judge misses
  from deterministic defects.
- Oracle remediation added complete Agents terminal handling, actionable Event
  Hubs diagnostics, and metadata-driven Key Vault unwrap selection.

## Interpretation

Restoring independent points materially raises the all-or-nothing standard
relative to the superseded 301-occurrence composition. General Azure skills
plus MCP achieved the highest aggregate prompt and language criterion counts in
this single run; the complete Java SDK skill arm produced the only fully passing
trial. Repeated trials are required before drawing comparative quality
conclusions.

Authentication, client construction, paging, polling, async composition,
service errors, and cleanup are now scored separately wherever they can pass or
fail independently. Removed concerns are limited to operations for which the
originating prompt and selected current SDK surface provide no accurate scoped
capability.

Raw artifacts are under
`reports/java-preservation-final/2026-09-07T10-24-56-520Z/`. They include
generated workspaces, diffs, trajectories, grader evidence, and program-check
output and are intentionally excluded from version control. The complete
failed-criterion inventory and judge-reported potential reasons are in
`docs/pilot-results/java-issue-37-failed-criteria.md`.
