# Cosmos DB Python pilot

The first Vally pilot ran one Cosmos DB Python CRUD trial per experimental arm
on August 27, 2026.

| Variant | Correctness score |
|---|---:|
| Baseline | 12/12 |
| Azure | 11/12 |
| Azure with SDK skill | 11/12 |

The baseline generated `enable_cross_partition_query=True`; both enhanced arms
omitted it. Both enhanced arms used Azure MCP. Only the SDK arm activated a
skill, `azure-cosmos-py`; none of the 28 general Azure skills was activated.

The original 13-point suite also awarded one point for an Azure MCP call. That
behavior check has been removed because scores now measure only application and
code correctness. The initial raw Vally scores were 12/13, 11/13, and 11/13.
The two enhanced arms also received a false failure for
`PartitionKey(path=PARTITION_KEY_PATH)` even though the constant equals
`"/category"`. The grader now accepts the constant form and excludes Python
files staged by skills from generated-code checks.

This single trial validates environment isolation and diagnostic trajectory
reporting. It does not establish a quality difference between the arms.
