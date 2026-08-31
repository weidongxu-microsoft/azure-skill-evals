import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
  pythonCheckNames,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  loadWorkspace,
  ruleNames,
} from "./tools/order-processor-python-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadWorkspace(goldenPath);

function change(from, to) {
  return {
    ...golden,
    documents: golden.documents.map((document) => ({
      ...document,
      source: document.source.replaceAll("\r\n", "\n").replaceAll(from, to),
    })),
  };
}

test("the pinned golden passes every scenario and shared Python check", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  const shared = loadPythonWorkspace(goldenPath);
  for (const rule of pythonCheckNames()) {
    assert.equal(evaluatePythonCheck(rule, shared), true, rule);
  }
});

test("both exact active Python pins are required", () => {
  for (const [from, to] of [
    ["azure-identity==1.25.3", "azure-identity>=1.25.3"],
    ["azure-servicebus==7.14.3", "azure-servicebus==0.0.1"],
  ]) {
    const candidate = {
      ...golden,
      dependencyManifests: golden.dependencyManifests.map((manifest) => ({
        ...manifest,
        content: manifest.content.replace(from, to),
      })),
    };
    assert.equal(evaluateRule("prompt/sdk-dependencies", candidate), false);
  }
});

test("comments, strings, unreachable code, and disconnected helpers cannot fake behavior", () => {
  const fake = {
    documents: [{
      path: "main.py",
      source: `
sample = """
ServiceBusMessage(order.to_json(), correlation_id=order.order_id,
                  session_id=order.customer_name)
"""
def unused():
    if False:
        sender.send_messages(batch)
        receiver.complete_message(message)
        receiver.dead_letter_message(message, reason="bad")
def main():
    print("skip")
main()
`,
    }],
    dependencyManifests: golden.dependencyManifests,
    topLevelPythonFiles: ["main.py"],
  };
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
});

test("connected batch and settlement evidence must use the same objects", () => {
  assert.equal(
    evaluateRule(
      "prompt/sync-sender",
      change(
        "batch = sender.create_message_batch()\n                    batch.add_message(message)",
        "batch = sender.create_message_batch()\n                    other_batch.add_message(message)",
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/async-processing-settlement",
      change(
        "await receiver.complete_message(message)",
        "await receiver.complete_message(other_message)",
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/dead-letter-reprocessing",
      change(
        "await sender.send_order(order)\n                    await receiver.complete_message(message)",
        "await sender.send_order(other_order)\n                    await receiver.complete_message(message)",
      ),
    ),
    false,
  );
});

test("focused mutations remove every remaining required behavior", () => {
  const cases = [
    ["prompt/order-model", "    total_price: float\n", ""],
    [
      "prompt/async-sender",
      "batch = await sender.create_message_batch()\n                    batch.add_message(message)",
      "batch = await sender.create_message_batch()\n                    other_batch.add_message(message)",
    ],
    [
      "prompt/sync-processing-settlement",
      "receiver.complete_message(message)",
      "receiver.complete_message(other_message)",
    ],
    ["prompt/error-classification", "error.is_transient", "error.retryable"],
    [
      "prompt/connected-demo",
      "    asyncio.run(run_async(fully_qualified_namespace, queue_name, orders))",
      "    print(\"async cycle skipped\")",
    ],
  ];
  for (const [rule, from, to] of cases) {
    assert.equal(evaluateRule(rule, change(from, to)), false, rule);
  }
});

test("equivalent class, method, and helper names are accepted", () => {
  const renamed = {
    ...golden,
    documents: golden.documents.map((document) => ({
      ...document,
      source: document.source
        .replaceAll("SyncOrderSender", "BlockingPublisher")
        .replaceAll("AsyncOrderSender", "ReactivePublisher")
        .replaceAll("SyncOrderProcessor", "BlockingConsumer")
        .replaceAll("AsyncOrderProcessor", "ReactiveConsumer")
        .replaceAll("send_order", "publish")
        .replaceAll("send_orders", "publish_batch")
        .replaceAll("process_orders", "consume")
        .replaceAll("reprocess_dead_letters", "retry_dead_letters")
        .replaceAll("message_for", "build_envelope"),
    })),
  };
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, renamed), true, rule);
  }
});
