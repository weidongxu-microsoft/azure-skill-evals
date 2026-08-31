import {
  evaluateRule,
  loadWorkspace,
} from "./order-processor-python-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-order-processor-python.mjs <rule>");
  process.exit(2);
}

const workspace = loadWorkspace(process.cwd());
if (workspace.documents.length === 0 || workspace.topLevelPythonFiles.length === 0) {
  console.error("No top-level generated Python application source was found.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Service Bus Python order processor criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Service Bus Python order processor criterion passed: ${rule}`);
