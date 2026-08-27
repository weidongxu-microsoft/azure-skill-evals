import {
  evaluateTypeScriptCheck,
  loadTypeScriptWorkspace,
} from "./checks.mjs";

const check = process.argv[2];
if (!check) {
  console.error("Usage: node check.mjs <language-check>");
  process.exit(2);
}

const workspace = loadTypeScriptWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0) {
  console.error("No top-level or src/ TypeScript/JavaScript files were generated.");
  process.exit(1);
}

if (!evaluateTypeScriptCheck(check, workspace)) {
  console.error(`Language check failed: ${check}`);
  process.exit(1);
}

console.log(`Language check passed: ${check}`);
