import {
  evaluateRule,
  loadServiceBusWorkspace,
} from "./service-bus-python-rules.mjs";

const rule = process.argv[2];
if (!rule) {
  console.error("Usage: node check-service-bus-python.mjs <rule>");
  process.exit(2);
}

const workspace = loadServiceBusWorkspace(process.cwd());
if (workspace.sources.length === 0) {
  console.error("No generated Python application source was found.");
  process.exit(1);
}

if (!evaluateRule(rule, workspace)) {
  console.error(`Service Bus Python rule failed: ${rule}`);
  process.exit(1);
}

console.log(`Service Bus Python rule passed: ${rule}`);
