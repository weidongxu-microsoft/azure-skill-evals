# Java issue 37 remediation run

Run date: 2026-09-05

This run validates the corrected Java evaluations from issue 37 at commits
`29de072` and `d983dac`. It used one trial for each of 30 scenarios in all
three environments, for 90 trials total.

## Integrity

- All six shard processes exited successfully.
- Every shard completed all 15 selected keys with the same plan digest
  (`e84597c2b56849ab`) and experiment hash (`dd250760b4881f4d`).
- The merge produced 90 unique item IDs and shard keys: 30 per variant.
- All 90 trial records have `status: success`, both configured graders, and a
  grade result. There are no missing, duplicated, timed-out, or malformed
  results and no trajectory-level error events.
- Model, judge, trial count, timeout, prompt hashes, and evaluation hashes are
  consistent across variants. Only the declared skill and MCP environments
  differ.

The five baseline program-check failures are ordinary evaluation failures, not
execution failures. In each case the generated workspace omitted a Maven or
Gradle manifest; the checker ran to completion and reported that defect. Every
augmented-arm workspace reached and passed the Java program checker.

## Outcomes

All criteria are required and binary. A trial passes only when its complete
panel and program check pass.

| Variant | Environment | Trials passed | Criteria passed | Program checks passed |
|---|---|---:|---:|---:|
| `baseline` | No skills or Azure MCP | 15/30 | 167/225 | 25/30 |
| `azure-skill-mcp` | 28 general Azure skills and Azure MCP | 20/30 | 207/225 | 30/30 |
| `azure-skill-mcp-microsoft-skill` | The same environment plus all 26 Java SDK skills | 17/30 | 201/225 | 30/30 |

The five missing-manifest failures occurred in baseline outputs for AI Projects
evaluation run, AI Projects resource inventory, Event Hubs send/receive,
Foundry support assistant, and Service Bus send/receive.

## Trajectory evidence

| Variant | Average duration | Tokens | Turns | Tool calls | Skill activations | Azure MCP calls | Web calls |
|---|---:|---:|---:|---:|---:|---:|---:|
| `baseline` | 1.64 min | 5,203,309 | 223 | 361 | 0 | 0 | 99 |
| `azure-skill-mcp` | 3.48 min | 20,754,073 | 447 | 793 | 18 | 185 | 101 |
| `azure-skill-mcp-microsoft-skill` | 2.99 min | 20,266,920 | 416 | 708 | 37 | 125 | 91 |

The Azure-only arm activated four general skills. The Java-suite arm activated
relevant Java SDK skills for Agents, AI Projects, App Configuration, Cosmos DB,
Event Grid, Event Hubs, Identity, Key Vault, and Storage, while also activating
some general Azure skills. Two additional calls failed to activate the
translation-specific Java skills: `azure-ai-translation-document-java` and
`azure-ai-translation-text-java`. One affected trajectory used the general
`azure-ai` skill instead; the other had no successful skill activation. Azure
MCP use was primarily documentation lookup and best-practice retrieval. Skill
activation and MCP calls were diagnostic evidence only and did not affect
scoring.

Web research primarily used Microsoft Learn, Maven Central, Azure SDK
documentation, and Azure SDK GitHub source. Some agents fetched mutable
`main`-branch GitHub URLs, while others used package-version tags. The run did
not establish that those source choices caused score differences.

## Interpretation

This single trial per arm proves that the corrected 90-run matrix can execute
and report completely. It does not establish a stable quality ranking between
environments. Panel misses remain observational model-judge results; criterion
pass or failure is not an integrity defect.

The corrected criteria accept equivalent implementations and no longer enforce
the obsolete universal Java checklist. All 30 committed golden applications
compile, and every criterion has passed a targeted golden-oracle run. Repeated
oracle checks also showed occasional judge variance, so comparative quality
claims require multiple trials per arm.

Raw merged artifacts are under
`reports/java-shards/issue37-final-v2-merged/`; source shard artifacts are under
`reports/java-shards/issue37-final-v2/`. These local reports contain generated
workspaces, diffs, trajectories, grader evidence, and program-check output and
are intentionally excluded from version control.
