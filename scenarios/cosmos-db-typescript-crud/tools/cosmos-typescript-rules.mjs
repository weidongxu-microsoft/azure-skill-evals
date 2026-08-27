const rules = {
  "prompt/cosmos-package": ({ packageJson }) =>
    /"@azure\/cosmos"\s*:/.test(packageJson),
  "prompt/cosmos-client": ({ source }) =>
    /\bnew\s+CosmosClient\s*\(\s*\{[\s\S]{0,400}?\bendpoint\s*:[\s\S]{0,200}?\bkey\s*:/.test(
      source,
    ),
  "prompt/database-container": ({ source }) =>
    /\.databases\.createIfNotExists\s*\(\s*\{[\s\S]{0,160}?\bid\s*:\s*["']TestDB["']/.test(
      source,
    ) &&
    /\.containers\.createIfNotExists\s*\(\s*\{[\s\S]{0,240}?\bid\s*:\s*["']Items["'][\s\S]{0,240}?["']\/category["']/.test(
      source,
    ),
  "prompt/create-read": ({ source }) =>
    /\.items\.create(?:<[^>]+>)?\s*\(/.test(source) &&
    ["id", "category", "name", "quantity"].every((field) =>
      new RegExp(`\\b${field}\\b`).test(source),
    ) &&
    /\.item\s*\([^)]*,[^)]*\)[\s\S]{0,120}?\.read(?:<[^>]+>)?\s*\(/.test(
      source,
    ),
  "prompt/parameterized-query": ({ source }) =>
    /\bSqlQuerySpec\b/.test(source) &&
    /WHERE\s+c\.category\s*=\s*@category/i.test(source) &&
    /\bparameters\s*:\s*\[[\s\S]{0,200}?\bname\s*:\s*["']@category["'][\s\S]{0,120}?\bvalue\s*:\s*["']electronics["']/.test(
      source,
    ) &&
    /\.items\.query(?:<[^>]+>)?\s*\(/.test(source),
  "prompt/replace-delete": ({ source }) =>
    /\b\w+\.quantity\s*(?:=|\+=|-=|\+\+|--)/.test(source) &&
    /\.item\s*\([^)]*,[^)]*\)[\s\S]{0,120}?\.replace(?:<[^>]+>)?\s*\(/.test(
      source,
    ) &&
    /\.item\s*\([^)]*,[^)]*\)[\s\S]{0,120}?\.delete\s*\(/.test(source),
  "prompt/status-error": ({ source }) =>
    /\bcatch\s*\(/.test(source) &&
    /\.(?:code|statusCode)\b/.test(source),
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
