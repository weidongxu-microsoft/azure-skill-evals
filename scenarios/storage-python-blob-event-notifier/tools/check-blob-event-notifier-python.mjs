import {
  evaluateRule,
  loadBlobEventNotifierWorkspace,
} from "./blob-event-notifier-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-blob-event-notifier-python.mjs <rule>");
  process.exit(2);
}

const workspace = loadBlobEventNotifierWorkspace(process.cwd());
if (workspace.topLevelPythonFiles.length === 0) {
  console.error("No top-level generated application Python files were found.");
  process.exit(1);
}
if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}
console.log(`Criterion passed: ${rule}`);
