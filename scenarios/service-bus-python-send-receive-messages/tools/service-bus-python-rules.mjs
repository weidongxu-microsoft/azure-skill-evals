import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const analyzerPath = fileURLToPath(
  new URL("./service_bus_analyzer.py", import.meta.url),
);
const cache = new WeakMap();

export function loadServiceBusWorkspace(root) {
  const excludedDirectories = new Set([
    ".cache",
    ".mypy_cache",
    ".nox",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dependencies",
    "deps",
    "dist",
    "generated",
    "node_modules",
    "site-packages",
    "test",
    "tests",
    "third_party",
    "vendor",
    "vendors",
    "venv",
  ]);
  const pythonFiles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) visit(path);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".py") &&
        !/^(?:test|tests)(?:[_.-]|$)|(?:[_.-]test)\.py$/i.test(entry.name)
      ) {
        pythonFiles.push(path);
      }
    }
  };
  visit(root);
  pythonFiles.sort();

  const dependencyFiles = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(?:requirements[^\\/]*\.txt|pyproject\.toml|setup\.py)$/i.test(
          entry.name,
        ),
    )
    .map((entry) => join(root, entry.name));

  return {
    dependencies: dependencyFiles
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
    dependencyManifests: dependencyFiles.map((path) => ({
      content: readFileSync(path, "utf8"),
      filename: basename(path),
    })),
    pythonFiles,
    sources: pythonFiles.map((path) => readFileSync(path, "utf8")),
  };
}

function evaluateRules(workspace) {
  if (cache.has(workspace)) return cache.get(workspace);
  const payload = {
    dependencyManifests:
      workspace.dependencyManifests ??
      [{ content: workspace.dependencies ?? "", filename: "requirements.txt" }],
    sources:
      workspace.sources ??
      (typeof workspace.python === "string" ? [workspace.python] : []),
  };
  const result = spawnSync("python", [analyzerPath], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `Service Bus analyzer failed: ${result.stderr || result.stdout}`,
    );
  }
  const rules = JSON.parse(result.stdout);
  cache.set(workspace, rules);
  return rules;
}

export function evaluateRule(name, workspace) {
  const rules = evaluateRules(workspace);
  if (!(name in rules)) throw new Error(`Unknown rule: ${name}`);
  return rules[name];
}

export function ruleNames() {
  return [
    "prompt/service-bus-package",
    "prompt/client-configuration",
    "prompt/queue-single-send",
    "prompt/queue-batch-send",
    "prompt/queue-receive",
    "prompt/message-settlement",
    "prompt/async-client",
    "prompt/topic-subscription",
    "prompt/resource-lifecycle",
  ];
}
