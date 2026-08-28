import {
  evaluateRule,
  loadWorkspace,
} from "./storage-dotnet-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-storage-dotnet.mjs <rule>");
  process.exit(2);
}

const workspace = loadWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0 || workspace.source.trim() === "") {
  console.error("Criterion failed: generated C# source is required");
  process.exit(1);
}
if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
