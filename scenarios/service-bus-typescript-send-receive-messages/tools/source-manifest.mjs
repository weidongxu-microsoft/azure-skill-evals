import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".vally",
  "dist",
  "node_modules",
]);

function collect(directory, root, documents) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        collect(join(directory, entry.name), root, documents);
      }
      continue;
    }
    if (
      !entry.isFile() ||
      !/\.(?:c|m)?(?:js|ts)$/.test(entry.name) ||
      entry.name.endsWith(".d.ts")
    ) {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    documents.push({
      path: relative(root, absolutePath).replaceAll("\\", "/"),
      source: readFileSync(absolutePath, "utf8"),
    });
  }
}

export function loadSourceManifest(root) {
  const documents = [];
  collect(root, root, documents);
  documents.sort((left, right) => left.path.localeCompare(right.path));
  const packagePath = join(root, "package.json");
  const tsconfigPath = join(root, "tsconfig.json");
  return {
    documents,
    hasTsconfig: existsSync(tsconfigPath),
    packageJson: existsSync(packagePath)
      ? readFileSync(packagePath, "utf8")
      : "",
    source: documents.map(({ source }) => source).join("\n"),
    sourceFiles: documents.map(({ path }) => path),
  };
}

export function sourceDocuments(workspace) {
  if (Array.isArray(workspace.documents)) {
    return workspace.documents
      .filter(
        (document) =>
          document &&
          typeof document.path === "string" &&
          typeof document.source === "string",
      )
      .toSorted((left, right) => left.path.localeCompare(right.path));
  }
  return typeof workspace.source === "string" && workspace.source.trim()
    ? [{ path: "<workspace>", source: workspace.source }]
    : [];
}

export function activeDependencies(packageJson) {
  try {
    const dependencies = JSON.parse(packageJson).dependencies;
    return dependencies &&
      typeof dependencies === "object" &&
      !Array.isArray(dependencies)
      ? dependencies
      : {};
  } catch {
    return {};
  }
}
