import { loadJavaWorkspace } from "../../../languages/java/checks.mjs";
import { evaluateRule } from "./app-configuration-java-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-app-configuration-java.mjs <rule>");
  process.exit(2);
}

const workspace = loadJavaWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0) {
  console.error("No Java files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
