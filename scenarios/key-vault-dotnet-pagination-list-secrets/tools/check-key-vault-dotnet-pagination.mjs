import {
  evaluateRule,
  loadWorkspace,
} from "./key-vault-dotnet-pagination-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-key-vault-dotnet-pagination.mjs <rule>");
  process.exit(2);
}

const workspace = loadWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0) {
  console.error("No top-level C# files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
