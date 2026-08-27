import {
  loadTypeScriptWorkspace,
} from "../../../languages/typescript/checks.mjs";
import { evaluateRule } from "./key-vault-typescript-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-key-vault-typescript.mjs <rule>");
  process.exit(2);
}

const workspace = loadTypeScriptWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0) {
  console.error("No top-level or src/ TypeScript/JavaScript files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
