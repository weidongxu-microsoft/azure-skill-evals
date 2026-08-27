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
    if (!entry.isFile() || !/\.(?:c|m)?(?:js|ts)$/.test(entry.name) ||
        entry.name.endsWith(".d.ts")) {
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
  documents.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
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
      .filter((document) =>
        document && typeof document.source === "string" &&
        typeof document.path === "string"
      )
      .toSorted((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      );
  }
  return typeof workspace.source === "string" && workspace.source.trim()
    ? [{ path: "<workspace>", source: workspace.source }]
    : [];
}

export function activeDependencies(packageJson) {
  try {
    const manifest = JSON.parse(packageJson);
    return manifest.dependencies &&
        typeof manifest.dependencies === "object" &&
        !Array.isArray(manifest.dependencies)
      ? manifest.dependencies
      : {};
  } catch {
    return {};
  }
}
