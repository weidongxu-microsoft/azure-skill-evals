import {
  evaluateRule,
  loadEncryptedUploaderWorkspace,
} from "./encrypted-uploader-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-encrypted-uploader-python.mjs <rule>");
  process.exit(2);
}

const workspace = loadEncryptedUploaderWorkspace(process.cwd());
if (workspace.topLevelPythonFiles.length === 0) {
  console.error("No top-level generated application Python files were found.");
  process.exit(1);
}
if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}
console.log(`Criterion passed: ${rule}`);
