const rules = {
  "prompt/cosmos-package": ({ project }) =>
    /<PackageReference\s+Include="Microsoft\.Azure\.Cosmos"/.test(project),
  "prompt/cosmos-client": ({ source }) =>
    /\bCosmosClient\b[\s\S]{0,160}?\bnew\b/.test(source),
  "prompt/database-container": ({ source }) =>
    /\.CreateDatabaseIfNotExistsAsync\s*\(\s*["']TestDB["']/.test(source) &&
    /\.CreateContainerIfNotExistsAsync\s*\(\s*["']Items["'][\s\S]{0,160}?["']\/category["']/.test(
      source,
    ),
  "prompt/item-crud": ({ source }) =>
    [
      "CreateItemAsync",
      "ReadItemAsync",
      "ReplaceItemAsync",
      "DeleteItemAsync",
    ].every((method) =>
      new RegExp(`\\.${method}(?:<[^>]+>)?\\s*\\(`).test(source),
    ) &&
    ["id", "category", "name", "quantity"].every((field) =>
      new RegExp(`\\b${field}\\b`, "i").test(source),
    ) &&
    /\b\w+\.quantity\s*(?:=|\+=|-=|\+\+|--)/i.test(source),
  "prompt/parameterized-query": ({ source }) =>
    /\bQueryDefinition\s*\(/.test(source) &&
    /WHERE\s+c\.category\s*=\s*@category/i.test(source) &&
    /\.WithParameter\s*\(\s*["']@category["']\s*,\s*["']electronics["']/.test(
      source,
    ) &&
    /\.GetItemQueryIterator(?:<[^>]+>)?\s*\(/.test(source),
  "prompt/partition-key": ({ source }) =>
    /\bPartitionKey\s*\(\s*[^)]*category/.test(source),
  "prompt/cosmos-exception": ({ source }) =>
    /\bcatch\s*\(\s*CosmosException\b/.test(source) &&
    /\.StatusCode\b/.test(source),
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
