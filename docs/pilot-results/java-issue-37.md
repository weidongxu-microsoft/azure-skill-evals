# Java issue 37 conservative re-audit run

Run date: 2026-09-07

This run validates the conservative Java criteria re-audit for issue 37. It
used one trial for each of 30 scenarios in all three unchanged environments,
for 90 logical trials total.

## Integrity

- Main run `5a74da22-d385-4217-8a17-eaa61c22f0a5` produced 90 unique result
  keys: 30 per variant. Shards 2 and 5 were rerun cleanly after their first
  processes terminated before writing results.
- Event Hubs criterion wording was corrected after the main shards started.
  Its three stale rows were replaced by run
  `7d153bd3-7cb3-46d9-8210-748eba776570`.
- A prompt-silent inventory failure criterion was removed during final review.
  Its three stale rows were replaced by run
  `cd1a30ea-b0c2-4c3a-9c10-7e1968859cac`.
- The reconciled set has 90 unique item IDs and `variant/evalName` keys. Every
  record has `status: success`, complete panel and program-check output, and no
  trajectory errors.
- Each evaluation has one consistent evaluation hash across its three
  variants. Model, judge, trial count, timeout, prompts, and grader composition
  remained controlled; only the declared skill and MCP environment paths
  differ.
- All 90 generated projects passed the Java program checker. Panel failures are
  ordinary evaluation outcomes, not execution failures.

## Outcomes

All criteria are required and binary. A trial passes only when every panel
criterion and the program check pass.

| Variant | Environment | Trials passed | Prompt criteria | Language criteria | Program checks |
|---|---|---:|---:|---:|---:|
| `baseline` | No skills or Azure MCP | 1/30 | 202/225 | 49/76 | 30/30 |
| `azure-skill-mcp` | 28 general Azure skills and Azure MCP | 1/30 | 200/225 | 47/76 | 30/30 |
| `azure-skill-mcp-microsoft-skill` | Same environment plus all Java SDK skills | 0/30 | 206/225 | 44/76 | 30/30 |

The restored BOM-first rule is deliberately strict. In the replacement Event
Hubs run, all three generated projects compiled but failed only the BOM
criterion because they used direct dependency versions.

## Trajectory evidence

| Variant | Average duration | Tokens | Turns | Tool calls | Skill activations | Azure MCP calls | Web calls |
|---|---:|---:|---:|---:|---:|---:|---:|
| `baseline` | 3.65 min | 16,259,799 | 356 | 804 | 0 | 0 | 450 |
| `azure-skill-mcp` | 3.28 min | 23,960,318 | 473 | 880 | 21 | 180 | 155 |
| `azure-skill-mcp-microsoft-skill` | 4.31 min | 19,638,852 | 436 | 755 | 36 | 154 | 97 |

Skill activation, Azure MCP use, and web calls are diagnostic evidence only;
they do not affect scoring.

## Interpretation

This single trial per arm proves that the corrected 90-trial matrix executes
completely. It does not establish a stable quality ranking. The restored
language checks materially increase the all-or-nothing standard, and individual
panel misses remain observational model-judge results.

Authentication and client construction are prompt-specific. Connection-string
or key authentication remains valid where the prompt requests it; Azure
Identity is required only for token-credential flows. BOM management and scoped
Azure import hygiene are global, while dependency and current-public-API checks
are restored only where focused prompt criteria do not already cover them.

All 30 reference applications use the compatible BOM-first policy and compile.
Changed criteria and goldens are validated separately as positive oracles.
Policy-sensitive questions remain listed in
`docs/java-criteria-disposition.md` for human review.

Raw main artifacts are under
`reports/java-shards/issue37-conservative/`; Event Hubs replacement artifacts
are under `reports/java-shards/issue37-event-hubs-final/`; inventory replacement
artifacts are under `reports/java-shards/issue37-inventory-final/`. They
contain generated workspaces, diffs, trajectories, grader evidence, and
program-check output and are intentionally excluded from version control.
