import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function collectJavaFiles(root) {
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
    .map((entry) => join(root, entry.name));
  const sourceRoot = join(root, "src", "main", "java");
  if (!existsSync(sourceRoot)) {
    return files;
  }

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.name.endsWith(".java")) {
        files.push(path);
      }
    }
  };
  visit(sourceRoot);
  return files;
}

export function loadJavaWorkspace(root) {
  const sourceFiles = collectJavaFiles(root);
  const buildFiles = ["pom.xml", "build.gradle", "build.gradle.kts"]
    .map((name) => join(root, name))
    .filter(existsSync);

  return {
    sourceFiles,
    buildFiles,
    source: sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
    build: buildFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
  };
}

const checks = {
  "language/build-manifest": ({ buildFiles }) => buildFiles.length > 0,
  "language/current-azure-dependencies": ({ build }) =>
    /<groupId>com\.azure<\/groupId>|["']com\.azure:/.test(build) &&
    !/com\.microsoft\.azure/.test(build),
  "language/current-imports": ({ source }) =>
    /\bimport\s+com\.azure\./.test(source) &&
    !/\bimport\s+(?:com\.microsoft\.azure|com\.azure\.[^;]*\.implementation\.)/.test(
      source,
    ),
  "language/client-lifecycle": ({ source }) =>
    /\btry\s*\([^)]*\b\w*Client\b[^)]*=/.test(source) ||
    /\b\w+\.close\s*\(\s*\)/.test(source),
};

export function evaluateJavaCheck(name, workspace) {
  const check = checks[name];
  if (!check) {
    throw new Error(`Unknown Java check: ${name}`);
  }
  return check(workspace);
}

export function javaCheckNames() {
  return Object.keys(checks);
}
