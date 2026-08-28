import { loadSourceManifest } from "./source-manifest.mjs";
import { evaluateRule } from "./encrypted-uploader-typescript-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-encrypted-uploader-typescript.mjs <rule>");
  process.exit(2);
}

const workspace = loadSourceManifest(process.cwd());
if (workspace.documents.length === 0) {
  console.error("No top-level or src/ TypeScript/JavaScript files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
