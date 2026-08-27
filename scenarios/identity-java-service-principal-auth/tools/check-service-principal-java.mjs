import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { evaluateRule } from "./service-principal-java-rules.mjs";

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

function loadWorkspace(root) {
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

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-service-principal-java.mjs <rule>");
  process.exit(2);
}

const workspace = loadWorkspace(process.cwd());
if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
