const rules = {
  "prompt/azure-cosmos-package": ({ dependencies }) =>
    /\bazure-cosmos\b/i.test(dependencies),
  "prompt/cosmos-client": ({ python }) => /\bCosmosClient\s*\(/.test(python),
  "prompt/create-database": ({ python }) =>
    /\.create_database_if_not_exists\s*\(/.test(python),
  "prompt/create-container": ({ python }) =>
    /\.create_container_if_not_exists\s*\(/.test(python) &&
    /PartitionKey\s*\(\s*path\s*=/.test(python) &&
    /["']\/category["']/.test(python),
  "prompt/cross-partition-query": ({ python }) =>
    /\.query_items\s*\([\s\S]{0,1200}?enable_cross_partition_query\s*=\s*True/.test(
      python,
    ),
  "prompt/cosmos-exception": ({ python }) =>
    /\bCosmosHttpResponseError\b/.test(python) &&
    /\bexcept\b[\s\S]{0,120}?CosmosHttpResponseError/.test(python),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }
  return rule(workspace);
}

export function ruleNames() {
  return Object.keys(rules);
}
