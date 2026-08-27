import {
  loadSourceManifest,
} from "./source-manifest.mjs";
import { evaluateRule } from "./service-bus-typescript-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-service-bus-typescript.mjs <rule>");
  process.exit(2);
}

const workspace = loadSourceManifest(process.cwd());
if (workspace.sourceFiles.length === 0) {
  console.error("No TypeScript or JavaScript files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
