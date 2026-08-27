import {
  loadTypeScriptWorkspace,
} from "../../../languages/typescript/checks.mjs";
import { evaluateRule } from "./managed-identity-typescript-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-managed-identity-typescript.mjs <rule>");
  process.exit(2);
}

const workspace = loadTypeScriptWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0 || !workspace.source.trim()) {
  console.error("No TypeScript or JavaScript files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
