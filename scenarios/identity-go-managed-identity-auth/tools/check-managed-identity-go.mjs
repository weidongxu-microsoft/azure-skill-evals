import {
  evaluateRule,
  loadGoWorkspace,
} from "./managed-identity-go-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-managed-identity-go.mjs <rule>");
  process.exit(2);
}
const workspace = loadGoWorkspace(process.cwd());
if (!workspace.sourceFiles.length) {
  console.error("No top-level Go source files were generated.");
  process.exit(1);
}
if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}
console.log(`Criterion passed: ${rule}`);
