import {
  evaluateRule,
  loadKeyVaultWorkspace,
} from "./key-vault-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-key-vault-python.mjs <rule>");
  process.exit(2);
}

const workspace = loadKeyVaultWorkspace(process.cwd());
if (workspace.pythonFiles.length === 0) {
  console.error("No generated application Python files were found.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
