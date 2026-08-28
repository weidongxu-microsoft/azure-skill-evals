# Cosmos DB four-language pilot

Run date: 2026-08-27

This pilot ran the Cosmos DB CRUD scenario once in Python, .NET, Java, and
TypeScript across three environments:

- `baseline`: no skills or Azure MCP.
- `azure-skill-mcp`: general Azure skills and Azure MCP.
- `azure-skill-mcp-microsoft-skill`: the same environment plus the complete
  language skill suite.

The raw data is under `reports/cosmos-full-suite-20260827/`. One trial per arm
is suitable for harness debugging, not a comparative quality conclusion.

## Raw scores

Each language had 11 equally weighted deterministic checks.

| Language | Baseline | Azure skill + MCP | Azure skill + MCP + language suite |
|---|---:|---:|---:|
| Python | 9/11 | 9/11 | 10/11 |
| .NET | 7/11 | 8/11 | 8/11 |
| Java | 7/11 | 11/11 | 8/11 |
| TypeScript | 11/11 | 9/11 | 9/11 |
| **Total** | **34/44** | **37/44** | **35/44** |

The aggregate ranking should not be treated as application quality. Manual
review found several static-grader false negatives, and five trials inspected
or executed staged grader files while generating their answer.

## Missed checks

| Language | Variant | Misses |
|---|---|---|
| Python | Baseline | `language/default-azure-credential`, `language/client-lifecycle` |
| Python | Azure skill + MCP | `prompt/cross-partition-query`, `language/client-lifecycle` |
| Python | Language suite | `prompt/cross-partition-query` |
| .NET | Baseline | `prompt/database-container`, `prompt/item-crud`, `prompt/parameterized-query`, `prompt/partition-key` |
| .NET | Azure skill + MCP | `prompt/database-container`, `prompt/parameterized-query`, `prompt/partition-key` |
| .NET | Language suite | `prompt/database-container`, `prompt/parameterized-query`, `prompt/partition-key` |
| Java | Baseline | `prompt/database-container`, `prompt/query-iteration`, `prompt/parameterized-query`, `language/client-lifecycle` |
| Java | Azure skill + MCP | None |
| Java | Language suite | `prompt/database-container`, `prompt/query-iteration`, `prompt/parameterized-query` |
| TypeScript | Baseline | None |
| TypeScript | Azure skill + MCP | `prompt/parameterized-query`, `prompt/replace-delete` |
| TypeScript | Language suite | `prompt/parameterized-query`, `prompt/replace-delete` |

## Reviewed application quality

### Python

All three outputs implemented the requested CRUD sequence and passed Python
syntax compilation. The baseline used endpoint/key authentication and enabled
cross-partition querying, but did not close its client. The Azure-only arm used
`DefaultAzureCredential` but also left its client open. The language-suite arm
used `DefaultAzureCredential` and managed the client lifecycle.

The two `prompt/cross-partition-query` misses are real relative to the current
criterion: neither improved arm explicitly enabled cross-partition querying.
The prompt itself only asks for a category query, so future revisions should
either state the cross-partition requirement or remove that check.
`language/default-azure-credential` is a preference rather than a Cosmos CRUD
correctness requirement because key authentication is supported.

### .NET

All three outputs produced complete applications using
`Microsoft.Azure.Cosmos`, parameterized `QueryDefinition` queries, partition
keys, quantity updates, and status-aware `CosmosException` handling. Each
application ultimately built successfully. The baseline and language-suite
arms initially omitted the explicit `Newtonsoft.Json` dependency required by
the selected Cosmos package, then added it after the build exposed the error.

Most .NET misses are grader-shape mismatches. The applications use constants,
target-typed `new`, or valid update forms where the rules require literal
`"TestDB"`, `"Items"`, `"electronics"`, `PartitionKey(...)`, or a direct
property assignment. They should not be counted as application defects.

### Java

All three outputs compiled with Maven and implemented the CRUD lifecycle. The
Azure-only arm received 11/11 after changing valid constants to literals to
match the exposed graders. The baseline and language-suite outputs use valid
container overloads or constants that the rules reject. Their query results
are iterable even when the source does not explicitly name
`CosmosPagedIterable`, and their SQL parameters use a constant whose value is
`"electronics"`.

Those prompt misses are false negatives. The baseline's unclosed
`CosmosClient` is a genuine resource-management issue. The run used the older
generic `language/client-lifecycle` check; the repository now uses the common
Java builder check because most Azure Java clients are not closeable. Cosmos
lifecycle enforcement should become scenario- or type-specific.

### TypeScript

The Azure-only output installed dependencies and passed `tsc`. The baseline
and language-suite outputs passed syntax checks, but their dependency restores
were blocked by registry/cache state, so their final type-check was not proven
in the run.

Manual review found complete CRUD flows in all three outputs. The improved
arms construct parameter arrays separately and use object shorthand rather
than the inline shape required by `prompt/parameterized-query`. They also
reuse an item reference for replace and delete rather than repeating
`.item(...).replace()` and `.item(...).delete()` in the exact pattern expected
by the rule. These four misses are false negatives.

## Diagnostics

| Variant | Tokens | Turns | Tool calls | Wall time | Azure MCP calls | Errors |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 966,679 | 49 | 62 | 425.0 s | 0 | 0 |
| Azure skill + MCP | 1,703,288 | 44 | 55 | 552.3 s | 11 | 0 |
| Language suite | 1,871,325 | 51 | 68 | 733.0 s | 12 | 0 |

The language-suite arm activated one relevant skill in every language:

| Language | Activated skill |
|---|---|
| Python | `azure-cosmos-py` |
| .NET | `azure-resource-manager-cosmosdb-dotnet` |
| Java | `azure-cosmos-java` |
| TypeScript | `azure-cosmos-ts` |

The .NET skill is management-plane guidance, but it explicitly redirected the
task to `Microsoft.Azure.Cosmos`, and the generated application used the
correct data-plane package. No skill activation or MCP call affected scoring.

## Validity limitations

Five of the 12 agents inspected or executed files under `.vally` while
generating code: .NET baseline, Java Azure-only, Python Azure-only, TypeScript
baseline, and TypeScript language-suite. Java Azure-only changed constants to
literal values specifically to satisfy the deterministic rules. This leaks the
oracle and can reward grader matching rather than independent implementation.
Future runs must keep executable graders available to Vally without exposing
their source to the generating agent.

Other limitations:

- One trial per arm cannot separate environment effects from model variance.
- Static regex checks reject some equivalent SDK usage.
- Build evidence was produced by the generating agent, not by an isolated
  post-generation build stage.
- TypeScript registry state prevented two complete dependency restores.
- Token totals include cache reads and are useful for relative run diagnostics,
  not direct billing comparisons.

## Conclusion

The pilot proves that the shared four-language experiment executes all three
environments and preserves useful trajectory diagnostics. It does not show a
reliable quality win for either augmented environment. After manual review,
most score differences come from grader rigidity, client-lifecycle policy, or
grader leakage rather than missing CRUD behavior.

Before repeating the matrix, isolate graders from the generator, run builds in
a separate post-generation stage, broaden deterministic rules with equivalent
valid fixtures, and use at least three trials per arm.
