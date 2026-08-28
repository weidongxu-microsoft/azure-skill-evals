import {
  evaluateRule,
  loadStorageBlobsWorkspace,
} from "./storage-blobs-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-storage-blobs-python.mjs <rule>");
  process.exit(2);
}

const workspace = loadStorageBlobsWorkspace(process.cwd());
if (workspace.topLevelPythonFiles.length === 0) {
  console.error("No top-level generated application Python files were found.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
