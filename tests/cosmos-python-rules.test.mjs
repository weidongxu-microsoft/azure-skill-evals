import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRule, ruleNames } from "../tools/cosmos-python-rules.mjs";

const completeWorkspace = {
  pythonFiles: ["cosmos_crud.py"],
  dependencies: "azure-cosmos>=4.7\nazure-identity>=1.17\n",
  python: `
from azure.cosmos import CosmosClient, PartitionKey
from azure.cosmos.exceptions import CosmosHttpResponseError
from azure.identity import DefaultAzureCredential

try:
    credential = DefaultAzureCredential()
    with CosmosClient(endpoint, credential=credential) as client:
        database = client.create_database_if_not_exists(id="TestDB")
        container = database.create_container_if_not_exists(
            id="Items",
            partition_key=PartitionKey(path="/category"),
        )
        container.query_items(
            query=query,
            enable_cross_partition_query=True,
        )
except CosmosHttpResponseError:
    raise
`,
};

test("complete Cosmos sample passes every static rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("missing cross-partition option fails only its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    python: completeWorkspace.python.replace(
      "enable_cross_partition_query=True,",
      "",
    ),
  };

  assert.equal(
    evaluateRule("prompt/cross-partition-query", workspace),
    false,
  );
  assert.equal(evaluateRule("prompt/cosmos-client", workspace), true);
});

test("key authentication does not satisfy the credential rule", () => {
  const workspace = {
    ...completeWorkspace,
    python: completeWorkspace.python
      .replace(
        "from azure.identity import DefaultAzureCredential",
        "",
      )
      .replace(
        "credential = DefaultAzureCredential()",
        'credential = os.environ["COSMOS_KEY"]',
      ),
  };

  assert.equal(
    evaluateRule("language/default-azure-credential", workspace),
    false,
  );
});

