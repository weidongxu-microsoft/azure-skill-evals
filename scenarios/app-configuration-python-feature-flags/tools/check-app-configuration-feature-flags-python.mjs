import { loadFeatureFlagsWorkspace, evaluateRule } from "./feature-flags-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-app-configuration-feature-flags-python.mjs <rule>");
  process.exit(2);
}

const workspace = loadFeatureFlagsWorkspace(process.cwd());
if (workspace.topLevelPythonFiles.length === 0) {
  console.error("No top-level Python files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
