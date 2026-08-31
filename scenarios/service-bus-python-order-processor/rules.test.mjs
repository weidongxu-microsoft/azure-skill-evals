import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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
const baselinePath = fileURLToPath(
  new URL("./fixtures/baseline-33403910898", import.meta.url),
);
const baseline33403910898 = loadWorkspace(baselinePath);

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

test("baseline run 33403910898 exact ten-file output passes disputed criteria", () => {
  const disputed = [
    "prompt/sync-sender",
    "prompt/async-sender",
    "prompt/sync-processing-settlement",
    "prompt/async-processing-settlement",
    "prompt/dead-letter-reprocessing",
    "prompt/error-classification",
    "prompt/connected-demo",
  ];
  for (const rule of disputed) {
    assert.equal(evaluateRule(rule, baseline33403910898), true, rule);
  }
  assert.equal(
    readdirSync(baselinePath).filter((name) => name !== "__pycache__").length,
    10,
  );
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

test("reachable sender classes expose implemented public batch methods", () => {
  assert.equal(
    evaluateRule("prompt/sync-sender", baseline33403910898),
    true,
  );
  assert.equal(
    evaluateRule("prompt/async-sender", baseline33403910898),
    true,
  );

  const disconnected = {
    ...baseline33403910898,
    documents: baseline33403910898.documents.map((document) => ({
      ...document,
      source:
        document.path === "main.py"
          ? document.source
              .replace("sender = OrderSender(config)", "sender = object()")
              .replace(
                "sender = AsyncOrderSender(config)",
                "sender = object()",
              )
          : document.source,
    })),
  };
  assert.equal(evaluateRule("prompt/sync-sender", disconnected), false);
  assert.equal(evaluateRule("prompt/async-sender", disconnected), false);
});

test("transient classification preserves exception provenance", () => {
  const knownClasses = {
    ...baseline33403910898,
    documents: baseline33403910898.documents.map((document) => ({
      ...document,
      source:
        document.path === "service_bus_common.py"
          ? document.source.replace(
              `    return bool(
        getattr(exc, "is_transient", False)
        or isinstance(exc, (ServiceBusCommunicationError, ServiceBusConnectionError))
    )`,
              `    return isinstance(
        exc,
        (ServiceBusCommunicationError, ServiceBusConnectionError),
    )`,
            )
          : document.source,
    })),
  };
  assert.equal(
    evaluateRule("prompt/error-classification", knownClasses),
    true,
  );

  for (const [from, to] of [
    ['getattr(exc, "is_transient", False)', 'getattr(other, "is_transient", False)'],
    ['getattr(exc, "is_transient", False)', 'getattr(exc, "retryable", False)'],
    ['getattr(exc, "is_transient", False)', "True"],
  ]) {
    const invalid = {
      ...baseline33403910898,
      documents: baseline33403910898.documents.map((document) => ({
        ...document,
        source:
          document.path === "service_bus_common.py"
            ? document.source
                .replace(from, to)
                .replace(
                  "or isinstance(exc, (ServiceBusCommunicationError, ServiceBusConnectionError))",
                  "",
                )
            : document.source,
      })),
    };
    assert.equal(
      evaluateRule("prompt/error-classification", invalid),
      false,
    );
  }
});

test("message body helpers retain the current loop message provenance", () => {
  const wrongMessage = {
    ...baseline33403910898,
    documents: baseline33403910898.documents.map((document) => ({
      ...document,
      source:
        document.path === "processors.py"
          ? document.source.replaceAll(
              "message_body_as_bytes(message)",
              "message_body_as_bytes(other_message)",
            )
          : document.source,
    })),
  };
  assert.equal(
    evaluateRule("prompt/sync-processing-settlement", wrongMessage),
    false,
  );
  assert.equal(
    evaluateRule("prompt/async-processing-settlement", wrongMessage),
    false,
  );
});

test("connected demo follows configuration factories and wrappers", () => {
  assert.equal(
    evaluateRule("prompt/connected-demo", baseline33403910898),
    true,
  );
  const disconnected = {
    ...baseline33403910898,
    documents: baseline33403910898.documents.map((document) => ({
      ...document,
      source:
        document.path === "main.py"
          ? document.source.replace(
              "asyncio.run(run_asynchronous_cycle(config))",
              "asyncio.run(run_asynchronous_cycle(other_config))",
            )
          : document.source,
    })),
  };
  assert.equal(evaluateRule("prompt/connected-demo", disconnected), false);
});
