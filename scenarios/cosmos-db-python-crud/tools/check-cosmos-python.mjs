import { evaluateRule, loadWorkspace } from "./cosmos-python-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-cosmos-python.mjs <rule>");
  process.exit(2);
}

const workspace = loadWorkspace(process.cwd());
if (workspace.pythonFiles.length === 0) {
  console.error("No Python files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);

