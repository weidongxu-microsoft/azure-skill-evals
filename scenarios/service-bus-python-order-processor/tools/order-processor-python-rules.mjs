import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const analyzer = fileURLToPath(new URL("./order_processor_analyzer.py", import.meta.url));
const cache = new WeakMap();
const excluded = new Set([
  ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".vally", ".venv",
  "__pycache__", "build", "dist", "node_modules", "site-packages", "target",
  "test", "tests", "vendor", "venv",
]);

export function loadWorkspace(root) {
  const documents = [];
  const topLevelPythonFiles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name.toLowerCase())) visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".py") &&
          !/^(?:test|tests)(?:[_.-]|$)|(?:[_.-]test)\.py$/i.test(entry.name)) {
        documents.push({
          path: relative(root, path).replaceAll("\\", "/"),
          source: readFileSync(path, "utf8"),
        });
        if (directory === root) topLevelPythonFiles.push(path);
      }
    }
  };
  visit(root);
  documents.sort((left, right) => left.path.localeCompare(right.path));

  const dependencyManifests = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() &&
      /^(?:requirements[^\\/]*\.txt|pyproject\.toml|setup\.py)$/i.test(entry.name))
    .map((entry) => ({
      filename: basename(entry.name),
      content: readFileSync(join(root, entry.name), "utf8"),
    }));

  return { documents, dependencyManifests, topLevelPythonFiles };
}

function analyze(workspace) {
  if (cache.has(workspace)) return cache.get(workspace);
  const result = spawnSync("python", [analyzer], {
    encoding: "utf8",
    input: JSON.stringify({
      documents: workspace.documents ?? [],
      dependencyManifests: workspace.dependencyManifests ?? [],
    }),
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Order processor analyzer failed: ${result.stderr || result.stdout}`);
  }
  const value = JSON.parse(result.stdout);
  cache.set(workspace, value);
  return value;
}

export function evaluateRule(name, workspace) {
  if (!(workspace.documents?.length > 0)) return false;
  const rules = analyze(workspace);
  if (!(name in rules)) throw new Error(`Unknown rule: ${name}`);
  return rules[name];
}

export function ruleNames() {
  return [
    "prompt/sdk-dependencies",
    "prompt/order-model",
    "prompt/sync-sender",
    "prompt/async-sender",
    "prompt/sync-processing-settlement",
    "prompt/async-processing-settlement",
    "prompt/dead-letter-reprocessing",
    "prompt/error-classification",
    "prompt/connected-demo",
  ];
}
