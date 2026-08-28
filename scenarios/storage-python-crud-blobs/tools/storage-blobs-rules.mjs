import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const analyzerPath = fileURLToPath(
  new URL("./storage_blobs_analyzer.py", import.meta.url),
);
const cache = new WeakMap();

export function loadStorageBlobsWorkspace(root) {
  const excludedDirectories = new Set([
    ".cache",
    ".mypy_cache",
    ".nox",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".vally",
    ".venv",
    "__pycache__",
    "build",
    "cache",
    "caches",
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
    .map((entry) => join(root, entry.name));

  return {
    dependencies: dependencyFiles
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
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
    (
      workspace.sources ??
      (typeof workspace.python === "string" ? [workspace.python] : [])
    ).map((source, index) => ({
      path: `source-${index}.py`,
      source,
    }));
  const payload = {
    dependencyManifests:
      workspace.dependencyManifests ?? [
        {
          content: workspace.dependencies ?? "",
          filename: "requirements.txt",
        },
      ],
    documents,
  };
  const result = spawnSync("python", [analyzerPath], {
    encoding: "utf8",
    input: JSON.stringify(payload),
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `Storage blobs analyzer failed: ${result.stderr || result.stdout}`,
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
    "prompt/sdk-packages",
    "prompt/authenticated-blob-service-client",
    "prompt/create-container",
    "prompt/upload-blob",
    "prompt/list-blobs",
    "prompt/download-blob",
    "prompt/delete-blob-and-container",
    "prompt/sdk-error-handling",
  ];
}
