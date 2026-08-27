import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function collectTopLevelFiles(root, predicate) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(root, entry.name));
}

export function loadWorkspace(root) {
  const pythonFiles = collectTopLevelFiles(root, (path) => path.endsWith(".py"));
  const dependencyFiles = collectTopLevelFiles(
    root,
    (path) =>
      /(?:requirements[^\\/]*\.txt|pyproject\.toml|setup\.py)$/i.test(path),
  );

  return {
    pythonFiles,
    python: pythonFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
    dependencies: dependencyFiles
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  };
}

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
  "language/correct-imports": ({ python }) =>
    /from\s+azure\.cosmos\s+import\s+/.test(python),
  "language/default-azure-credential": ({ python }) =>
    /from\s+azure\.identity\s+import\s+[^\n]*DefaultAzureCredential/.test(
      python,
    ) && /\bDefaultAzureCredential\s*\(/.test(python),
  "language/client-lifecycle": ({ python }) =>
    /with\s+CosmosClient\s*\(/.test(python) ||
    /\bclient\.close\s*\(\s*\)/.test(python),
  "language/async-client": () => true,
  "language/exception-handling": ({ python }) =>
    /\bexcept\b[\s\S]{0,120}?(?:CosmosHttpResponseError|AzureError)/.test(
      python,
    ),
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
