import { loadDotnetWorkspace } from "../../../languages/dotnet/checks.mjs";
import { evaluateRule } from "./identity-dotnet-service-principal-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error(
    "Usage: node check-identity-dotnet-service-principal.mjs <rule>",
  );
  process.exit(2);
}

const workspace = loadDotnetWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0) {
  console.error("No C# files were generated.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Criterion passed: ${rule}`);
