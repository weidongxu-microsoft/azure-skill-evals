import { loadJavaWorkspace } from "../../../languages/java/checks.mjs";
import { evaluateRule } from "./storage-java-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-storage-java.mjs <rule>");
  process.exit(2);
}
const workspace = loadJavaWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0 || !evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}
console.log(`Criterion passed: ${rule}`);
