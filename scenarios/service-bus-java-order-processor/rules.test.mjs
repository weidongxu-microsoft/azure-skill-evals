import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateJavaCheck,
  javaCheckNames,
  loadJavaWorkspace,
} from "../../languages/java/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/order-processor-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);

function change(from, to) {
  return {
    ...golden,
    source: golden.source.replaceAll("\r\n", "\n").replaceAll(from, to),
  };
}

test("the pinned golden passes every scenario and shared Java check", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const rule of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(rule, golden), true, rule);
  }
});

test("all three exact active Maven pins are required", () => {
  for (const version of ["7.17.20", "1.18.5", "2.20.0"]) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", {
        ...golden,
        build: golden.build.replace(
          `<version>${version}</version>`,
          "<version>0.0.1</version>",
        ),
      }),
      false,
    );
  }
});

test("fake, unreachable, and disconnected evidence is rejected", () => {
  const fake = {
    sourceFiles: ["Main.java"],
    build: golden.build,
    source: `
import com.azure.identity.ManagedIdentityCredentialBuilder;
import com.azure.messaging.servicebus.ServiceBusClientBuilder;
import com.azure.messaging.servicebus.ServiceBusMessage;
import com.azure.messaging.servicebus.ServiceBusMessageBatch;
import com.azure.messaging.servicebus.ServiceBusReceivedMessage;
import com.azure.messaging.servicebus.models.SubQueue;
class Main {
  static void unused() {
    if (false) {
      batch.tryAddMessage(message);
      sender.sendMessages(batch);
      receiver.complete(message);
      receiver.deadLetter(message);
    }
  }
  public static void main(String[] args) { System.out.println("skip"); }
}
`,
  };
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
});

test("same-object and path-compatible evidence is mandatory", () => {
  assert.equal(
    evaluateRule(
      "prompt/sync-sender",
      change(
        "batch = sender.createMessageBatch();\n                    if (!batch.tryAddMessage(message))",
        "batch = sender.createMessageBatch();\n                    if (!otherBatch.tryAddMessage(message))",
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/async-processing-settlement",
      change("return receiver.complete(message);", "return receiver.complete(otherMessage);"),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/dead-letter-reprocessing",
      change(
        "receiver.complete(message)",
        "receiver.complete(otherMessage)",
      ),
    ),
    false,
  );
});

test("focused mutations remove every remaining required behavior", () => {
  const cases = [
    ["prompt/order-model", "        public double totalPrice;\n", ""],
    [
      "prompt/async-sender",
      "if (!nextBatch.tryAddMessage(message))",
      "if (!otherBatch.tryAddMessage(message))",
    ],
    ["prompt/sync-processing-settlement", "context.complete();", "otherContext.complete();"],
    ["prompt/error-classification", "context.getErrorSource()", "context.toString()"],
    ["prompt/connected-demo", ".block()", ""],
  ];
  for (const [rule, from, to] of cases) {
    assert.equal(evaluateRule(rule, change(from, to)), false, rule);
  }
});

test("equivalent class and helper names are accepted", () => {
  const renamed = {
    ...golden,
    source: golden.source
      .replaceAll("SyncOrderSender", "BlockingPublisher")
      .replaceAll("AsyncOrderSender", "ReactivePublisher")
      .replaceAll("SyncOrderProcessor", "BlockingConsumer")
      .replaceAll("AsyncOrderProcessor", "ReactiveConsumer")
      .replaceAll("sendOrder", "publishOrder")
      .replaceAll("sendOrders", "publishBatch")
      .replaceAll("processOrders", "consumeOrders")
      .replaceAll("reprocessDeadLetters", "retryDeadLetters")
      .replaceAll("messageFor", "buildEnvelope")
      .replaceAll("fillBatch", "appendOrFlush"),
  };
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, renamed), true, rule);
  }
});
