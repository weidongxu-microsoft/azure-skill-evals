const rules = {
  "prompt/cosmos-package": ({ build }) =>
    /<groupId>com\.azure<\/groupId>[\s\S]{0,120}?<artifactId>azure-cosmos<\/artifactId>/.test(
      build,
    ),
  "prompt/cosmos-client": ({ source }) =>
    /\bCosmosClientBuilder\s*\(\s*\)/.test(source) &&
    /\.endpoint\s*\(/.test(source) &&
    /\.key\s*\(/.test(source) &&
    /\.buildClient\s*\(\s*\)/.test(source),
  "prompt/database-container": ({ source }) =>
    /\.createDatabaseIfNotExists\s*\(\s*["']TestDB["']/.test(source) &&
    /\.createContainerIfNotExists\s*\(\s*["']Items["']\s*,\s*["']\/category["']/.test(
      source,
    ),
  "prompt/item-crud": ({ source }) =>
    ["createItem", "readItem", "replaceItem", "deleteItem"].every((method) =>
      new RegExp(`\\.${method}\\s*\\(`).test(source),
    ) &&
    ["id", "category", "name", "quantity"].every((field) =>
      new RegExp(`\\b${field}\\b`, "i").test(source),
    ) &&
    /\.setQuantity\s*\(/.test(source),
  "prompt/query-iteration": ({ source }) =>
    /\bCosmosQueryRequestOptions\b/.test(source) &&
    /\bCosmosPagedIterable\b/.test(source) &&
    /\.queryItems\s*\(/.test(source),
  "prompt/parameterized-query": ({ source }) =>
    /\bSqlQuerySpec\s*\(/.test(source) &&
    /WHERE\s+c\.category\s*=\s*@category/i.test(source) &&
    /\bSqlParameter\s*\(\s*["']@category["']\s*,\s*["']electronics["']/.test(
      source,
    ),
  "prompt/cosmos-exception": ({ source }) =>
    /\bcatch\s*\(\s*CosmosException\b/.test(source) &&
    /\.getStatusCode\s*\(\s*\)/.test(source),
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
