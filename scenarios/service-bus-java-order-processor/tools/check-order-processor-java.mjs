import { loadJavaWorkspace } from "../../../languages/java/checks.mjs";
import { evaluateRule } from "./order-processor-java-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-order-processor-java.mjs <rule>");
  process.exit(2);
}

const workspace = loadJavaWorkspace(process.cwd());
if (workspace.sourceFiles.length === 0) {
  console.error("No generated Java application source was found.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Service Bus Java order processor criterion failed: ${rule}`);
  process.exit(1);
}

console.log(`Service Bus Java order processor criterion passed: ${rule}`);
