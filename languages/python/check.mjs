import {
  evaluatePythonCheck,
  loadPythonWorkspace,
} from "./checks.mjs";

const check = process.argv[2];
if (!check) {
  console.error("Usage: node check.mjs <language-check>");
  process.exit(2);
}

const workspace = loadPythonWorkspace(process.cwd());
if (workspace.pythonFiles.length === 0) {
  console.error("No top-level Python files were generated.");
  process.exit(1);
}

if (!evaluatePythonCheck(check, workspace)) {
  console.error(`Language check failed: ${check}`);
  process.exit(1);
}

console.log(`Language check passed: ${check}`);

