import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { loadJavaWorkspace } from "../../../languages/java/checks.mjs";
import { evaluateRule } from "./storage-java-rules.mjs";

const excludedDirectories = new Set([
  ".git",
  ".gradle",
  ".vally",
  "build",
  "generated",
  "node_modules",
  "target",
  "test",
  "tests",
]);

function collectJsonResources(root) {
  const resources = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        resources.push({
          path: relative(root, path).split(sep).join("/"),
          content: readFileSync(path, "utf8"),
        });
      }
    }
  };
  visit(root);
  return resources;
}

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-storage-java.mjs <rule>");
  process.exit(2);
}

const workspace = loadJavaWorkspace(process.cwd());
workspace.sourceDocuments = workspace.sourceFiles.map((path) => ({
  path: relative(process.cwd(), path).split(sep).join("/"),
  source: readFileSync(path, "utf8"),
}));
workspace.resources = collectJsonResources(process.cwd());
if (workspace.sourceFiles.length === 0) {
  console.error("No Java files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
