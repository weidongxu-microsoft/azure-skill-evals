import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function collectTopLevelFiles(root, predicate) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(root, entry.name));
}

export function loadPythonWorkspace(root) {
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

const checks = {
  "language/correct-imports": ({ python }) =>
    /(?:from|import)\s+azure(?:\.|\s)/.test(python),
  "language/default-azure-credential": ({ python }) =>
    /from\s+azure\.identity\s+import\s+[^\n]*DefaultAzureCredential/.test(
      python,
    ) && /\bDefaultAzureCredential\s*\(/.test(python),
  "language/client-lifecycle": ({ python }) =>
    /(?:with|async\s+with)\s+(?:\w+\.)*\w*Client\s*\(/.test(python) ||
    /\b\w+\.close\s*\(\s*\)/.test(python),
  "language/async-client": ({ python }) => {
    const usesAsyncAzureClient =
      /(?:from|import)\s+azure\.[^\n]*\.aio(?:\s|\.|$)/.test(python);
    return (
      !usesAsyncAzureClient ||
      (/\bawait\b/.test(python) && /\basync\s+with\b/.test(python))
    );
  },
  "language/exception-handling": ({ python }) =>
    /from\s+azure\.[^\n]*exceptions\s+import\s+[^\n]*\w+Error/.test(
      python,
    ) && /\bexcept\s+(?:\w+\.)*\w+Error\b/.test(python),
};

export function evaluatePythonCheck(name, workspace) {
  const check = checks[name];
  if (!check) {
    throw new Error(`Unknown Python check: ${name}`);
  }
  return check(workspace);
}

export function pythonCheckNames() {
  return Object.keys(checks);
}
