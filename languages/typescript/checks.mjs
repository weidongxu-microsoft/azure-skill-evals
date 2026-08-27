import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function collectSourceFiles(root) {
  const files = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(?:ts|js)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => join(root, entry.name));
  const sourceRoot = join(root, "src");
  if (!existsSync(sourceRoot)) {
    return files;
  }

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        /\.(?:ts|js)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(path);
      }
    }
  };
  visit(sourceRoot);
  return files;
}

function parsePackageJson(packageJson) {
  try {
    return JSON.parse(packageJson);
  } catch {
    return null;
  }
}

export function loadTypeScriptWorkspace(root) {
  const sourceFiles = collectSourceFiles(root);
  const packagePath = join(root, "package.json");
  const tsconfigPath = join(root, "tsconfig.json");

  return {
    sourceFiles,
    source: sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
    packageJson: existsSync(packagePath)
      ? readFileSync(packagePath, "utf8")
      : "",
    hasTsconfig: existsSync(tsconfigPath),
  };
}

const checks = {
  "language/package-manifest": ({ packageJson }) =>
    parsePackageJson(packageJson) !== null,
  "language/current-azure-packages": ({ packageJson }) => {
    const manifest = parsePackageJson(packageJson);
    if (!manifest) {
      return false;
    }
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    const names = Object.keys(dependencies);
    return (
      names.some((name) => name.startsWith("@azure/")) &&
      !names.some(
        (name) =>
          name === "azure-storage" ||
          name === "ms-rest-azure" ||
          name.startsWith("azure-arm-") ||
          name.startsWith("@azure/ms-rest-"),
      )
    );
  },
  "language/async-await": ({ source }) =>
    /\basync\b/.test(source) && /\bawait\b/.test(source),
  "language/typescript-config": ({ sourceFiles, hasTsconfig }) =>
    !sourceFiles.some((path) => path.endsWith(".ts")) || hasTsconfig,
};

export function evaluateTypeScriptCheck(name, workspace) {
  const check = checks[name];
  if (!check) {
    throw new Error(`Unknown TypeScript check: ${name}`);
  }
  return check(workspace);
}

export function typeScriptCheckNames() {
  return Object.keys(checks);
}
