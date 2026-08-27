# Cosmos DB Python pilot

The first Vally pilot ran one Cosmos DB Python CRUD trial per experimental arm
on August 27, 2026.

| Variant | Content checks | Behavior check | Corrected total |
|---|---:|---:|---:|
| Baseline | 12/12 | 0/1 | 12/13 |
| Azure | 11/12 | 1/1 | 12/13 |
| Azure with SDK skill | 11/12 | 1/1 | 12/13 |

The baseline generated `enable_cross_partition_query=True`; both enhanced arms
omitted it. Both enhanced arms used Azure MCP. Only the SDK arm activated a
skill, `azure-cosmos-py`; none of the 28 general Azure skills was activated.

The initial raw Vally scores were 12/13, 11/13, and 11/13. The two enhanced
arms received a false failure for `PartitionKey(path=PARTITION_KEY_PATH)` even
though the constant equals `"/category"`. The grader now accepts the constant
form and excludes Python files staged by skills from generated-code checks.

This single trial validates environment isolation, MCP trajectory checks, and
skill activation reporting. It does not establish a quality difference between
the arms.

