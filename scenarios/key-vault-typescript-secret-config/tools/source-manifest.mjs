import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export function loadSourceManifest(root) {
  const documents = [];
  const roots = [root, join(root, "src")].filter(existsSync);
  for (const sourceRoot of roots) {
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!["dist", "node_modules", "test", "tests"].includes(entry.name)) visit(path);
        } else if (/\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
          const relativePath = relative(root, path).replaceAll("\\", "/");
          if (!documents.some((document) => document.path === relativePath)) {
            documents.push({ path: relativePath, source: readFileSync(path, "utf8") });
          }
        }
      }
    };
    visit(sourceRoot);
  }
  documents.sort((left, right) => left.path.localeCompare(right.path));
  const packagePath = join(root, "package.json");
  return {
    documents,
    sourceFiles: documents.map((document) => document.path),
    source: documents.map((document) => document.source).join("\n"),
    packageJson: existsSync(packagePath) ? readFileSync(packagePath, "utf8") : "",
    hasTsconfig: existsSync(join(root, "tsconfig.json")),
  };
}
