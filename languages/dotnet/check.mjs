import { evaluateDotnetCheck, loadDotnetWorkspace } from "./checks.mjs";

const check = process.argv[2];
if (!check) {
  console.error("Usage: node check.mjs <language-check>");
  process.exit(2);
}

const workspace = loadDotnetWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0) {
  console.error("No top-level C# files were generated.");
  process.exit(1);
}

if (!evaluateDotnetCheck(check, workspace)) {
  console.error(`Language check failed: ${check}`);
  process.exit(1);
}

console.log(`Language check passed: ${check}`);
