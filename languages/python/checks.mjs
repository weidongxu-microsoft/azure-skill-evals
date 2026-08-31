import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const astCache = new WeakMap();

const pythonAstAnalysis = String.raw`
import ast
import json
import sys

source = sys.stdin.read()
result = {
    "azure_import": False,
    "default_azure_credential": False,
    "azure_exception_handler": False,
}

try:
    tree = ast.parse(source)
except SyntaxError:
    print(json.dumps(result))
    raise SystemExit()

credential_names = set()
identity_modules = set()
exception_names = set()
exception_modules = set()

def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        if parent:
            return f"{parent}.{node.attr}"
    return None

for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name == "azure" or alias.name.startswith("azure."):
                result["azure_import"] = True
            binding = alias.asname or alias.name.split(".", 1)[0]
            if alias.name == "azure.identity":
                identity_modules.add(alias.asname or "azure.identity")
            if alias.name.startswith("azure.") and alias.name.endswith(".exceptions"):
                exception_modules.add(alias.asname or alias.name)
    elif isinstance(node, ast.ImportFrom):
        module = node.module or ""
        if node.level == 0 and (module == "azure" or module.startswith("azure.")):
            result["azure_import"] = True
        if node.level != 0:
            continue
        for alias in node.names:
            binding = alias.asname or alias.name
            if module == "azure.identity" and alias.name == "DefaultAzureCredential":
                credential_names.add(binding)
            if module == "azure" and alias.name == "identity":
                identity_modules.add(binding)
            if module.startswith("azure.") and module.endswith(".exceptions"):
                if alias.name.endswith("Error"):
                    exception_names.add(binding)
            if module.startswith("azure") and alias.name == "exceptions":
                exception_modules.add(binding)

for node in ast.walk(tree):
    if isinstance(node, ast.Call):
        target = dotted(node.func)
        if target in credential_names or any(
            target == f"{module}.DefaultAzureCredential"
            for module in identity_modules
        ) or target == "azure.identity.DefaultAzureCredential":
            result["default_azure_credential"] = True
    elif isinstance(node, ast.ExceptHandler):
        caught = node.type.elts if isinstance(node.type, ast.Tuple) else [node.type]
        for caught_type in caught:
            target = dotted(caught_type)
            if not target:
                continue
            if target in exception_names or any(
                target.startswith(f"{module}.") and target.rsplit(".", 1)[-1].endswith("Error")
                for module in exception_modules
            ) or (
                target.startswith("azure.")
                and ".exceptions." in target
                and target.rsplit(".", 1)[-1].endswith("Error")
            ):
                result["azure_exception_handler"] = True

print(json.dumps(result))
`;

function analyzePython(workspace) {
  if (astCache.has(workspace)) return astCache.get(workspace);
  const result = spawnSync("python", ["-c", pythonAstAnalysis], {
    encoding: "utf8",
    input: workspace.python ?? "",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Python language analysis failed: ${result.stderr}`);
  }
  const analysis = JSON.parse(result.stdout);
  astCache.set(workspace, analysis);
  return analysis;
}

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
  "language/correct-imports": (workspace) =>
    analyzePython(workspace).azure_import,
  "language/default-azure-credential": (workspace) =>
    analyzePython(workspace).default_azure_credential,
  "language/client-lifecycle": ({ python }) =>
    /(?:with|async\s+with)\s+(?:\w+\.)*\w*Client(?:\.from_connection_string)?\s*\(/.test(
      python,
    ) ||
    /\b\w+\.close\s*\(\s*\)/.test(python),
  "language/async-client": ({ python }) => {
    const usesAsyncAzureClient =
      /(?:from|import)\s+azure\.[^\n]*\.aio(?:\s|\.|$)/.test(python);
    const closesAsyncClient =
      /\bawait\s+(?:[A-Za-z_]\w*\.)+close\s*\(\s*\)/.test(python);
    return (
      !usesAsyncAzureClient ||
      (/\bawait\b/.test(python) &&
        (/\basync\s+with\b/.test(python) || closesAsyncClient))
    );
  },
  "language/exception-handling": (workspace) =>
    analyzePython(workspace).azure_exception_handler,
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
