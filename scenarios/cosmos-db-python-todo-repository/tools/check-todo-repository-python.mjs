import { loadTodoRepositoryWorkspace, evaluateRule } from "./todo-repository-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-todo-repository-python.mjs <rule>");
  process.exit(2);
}

const workspace = loadTodoRepositoryWorkspace(process.cwd());
if (workspace.topLevelPythonFiles.length === 0) {
  console.error("No top-level Python files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
