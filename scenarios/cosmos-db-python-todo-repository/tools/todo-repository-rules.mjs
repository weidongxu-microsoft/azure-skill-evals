import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const analyzerPath = fileURLToPath(
  new URL("./todo_repository_analyzer.py", import.meta.url),
);
const cache = new WeakMap();
const excludedDirectories = new Set([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".vally",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "docs",
  "examples",
  "fixtures",
  "node_modules",
  "samples",
  "skills",
  "tests",
  "vendor",
  "venv",
]);

function collectPythonFiles(root) {
  const files = [];
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
        files.push(path);
      }
    }
  };
  visit(root);
  return files.sort();
}

export function loadTodoRepositoryWorkspace(root) {
  const pythonFiles = collectPythonFiles(root);
  const topLevelPythonFiles = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".py") &&
        !/^(?:test|tests)(?:[_.-]|$)|(?:[_.-]test)\.py$/i.test(entry.name),
    )
    .map((entry) => join(root, entry.name))
    .sort();
  const dependencyFiles = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(?:requirements[^\\/]*\.txt|pyproject\.toml|setup\.py)$/i.test(
          entry.name,
        ),
    )
    .map((entry) => join(root, entry.name))
    .sort();
  return {
    dependencies: dependencyFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
    dependencyManifests: dependencyFiles.map((path) => ({
      content: readFileSync(path, "utf8"),
      filename: basename(path),
    })),
    documents: pythonFiles.map((path) => ({
      path: relative(root, path).split(sep).join("/"),
      source: readFileSync(path, "utf8"),
    })),
    pythonFiles,
    topLevelPythonFiles,
  };
}

function evaluateRules(workspace) {
  if (cache.has(workspace)) return cache.get(workspace);
  const documents =
    workspace.documents ??
    (workspace.sources ?? (workspace.python ? [workspace.python] : []))
      .map((source, index) => ({ path: `source-${index}.py`, source }));
  const result = spawnSync("python", [analyzerPath], {
    encoding: "utf8",
    input: JSON.stringify({
      dependencyManifests:
        workspace.dependencyManifests ??
        [{ content: workspace.dependencies ?? "", filename: "requirements.txt" }],
      documents,
      applicationRoots:
        workspace.applicationRoots ??
        documents
          .map(({ path }) => String(path ?? "").replaceAll("\\", "/"))
          .filter((path) => path && !path.includes("/")),
    }),
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `ToDo repository analyzer failed: ${result.stderr || result.stdout}`,
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
    "prompt/sdk-pins",
    "prompt/todo-model",
    "prompt/secure-container-factory",
    "prompt/sync-crud-request-charges",
    "prompt/async-crud-request-charges",
    "prompt/etag-conflict-handling",
    "prompt/sync-parameterized-pagination",
    "prompt/async-parameterized-pagination",
    "prompt/connected-sync-then-async-demo",
  ];
}
