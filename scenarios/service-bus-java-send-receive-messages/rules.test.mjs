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
} from "./tools/service-bus-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadJavaWorkspace(goldenPath);

function withSource(source) {
  return { ...completeWorkspace, source };
}

test.skip("Service Bus Java reference passes every prompt rule", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip("Service Bus Java reference passes every language check", () => {
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test.skip("the active Java 17 manifest must pin Service Bus 7.17.20", () => {
  const wrongVersion = {
    ...completeWorkspace,
    build: completeWorkspace.build.replace("7.17.20", "7.17.19"),
  };
  const inactiveProfile = {
    ...completeWorkspace,
    build: completeWorkspace.build
      .replace(
        "<dependencies>",
        "<profiles><profile><id>decoy</id><dependencies>",
      )
      .replace("</dependencies>", "</dependencies></profile></profiles>"),
  };
  const dependencyManagement = {
    ...completeWorkspace,
    build: completeWorkspace.build
      .replace("<dependencies>", "<dependencyManagement><dependencies>")
      .replace(
        "</dependencies>",
        "</dependencies></dependencyManagement>",
      ),
  };

  for (const workspace of [
    wrongVersion,
    inactiveProfile,
    dependencyManagement,
  ]) {
    assert.equal(evaluateRule("prompt/sdk-package", workspace), false);
  }
});

test.skip("an active-by-default Maven profile is an active manifest source", () => {
  const build = completeWorkspace.build
    .replace(
      "<dependencies>",
      `<profiles>
    <profile>
      <id>java-17</id>
      <activation><activeByDefault>true</activeByDefault></activation>
      <dependencies>`,
    )
    .replace(
      "</dependencies>",
      "</dependencies></profile></profiles>",
    );

  assert.equal(
    evaluateRule("prompt/sdk-package", {
      ...completeWorkspace,
      build,
    }),
    true,
  );
});

test.skip("configuration must come from all four named environment variables", () => {
  const literalQueue = withSource(
    completeWorkspace.source.replace(
      'requireEnvironment("SERVICE_BUS_QUEUE_NAME")',
      '"orders"',
    ),
  );
  const wrongConnection = withSource(
    completeWorkspace.source.replace(
      '"SERVICE_BUS_CONNECTION_STRING"',
      '"CONNECTION_STRING"',
    ),
  );

  assert.equal(
    evaluateRule("prompt/environment-configuration", literalQueue),
    false,
  );
  assert.equal(
    evaluateRule("prompt/environment-configuration", wrongConnection),
    false,
  );
});

test.skip("lookalike local SDK types and comments cannot satisfy source rules", () => {
  const fakeSource = `
package com.example;
class ServiceBusClientBuilder {}
class ServiceBusSenderClient {}
class ServiceBusReceiverClient {}
class ServiceBusProcessorClient {}
class ServiceBusMessage {}
class ServiceBusMessageBatch {}
class ServiceBusReceivedMessage {}
class ServiceBusReceiveMode {}
class Fake {
  public static void main(String[] args) {
    // queueSender.sendMessage(message);
    String decoy = "processor.start(); processor.stop();";
  }
}
`;
  const workspace = withSource(fakeSource);

  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-package")) {
    assert.equal(evaluateRule(rule, workspace), false, rule);
  }
});

test.skip("the single queue send tracks the sender and message object", () => {
  const wrongSender = withSource(
    completeWorkspace.source.replace(
      "queueSender.sendMessage(singleMessage);",
      "topicSender.sendMessage(singleMessage);",
    ),
  );
  const wrongMessage = withSource(
    completeWorkspace.source.replace(
      "queueSender.sendMessage(singleMessage);",
      "queueSender.sendMessage(new Object());",
    ),
  );

  assert.equal(evaluateRule("prompt/single-message-send", wrongSender), false);
  assert.equal(evaluateRule("prompt/single-message-send", wrongMessage), false);
});

test.skip("single sends may be delegated through a helper", () => {
  const source = completeWorkspace.source
    .replace(
      "queueSender.sendMessage(singleMessage);",
      "sendSingle(queueSender, singleMessage);",
    )
    .replace(
      "    private static void processError",
      `    private static void sendSingle(
            ServiceBusSenderClient sender, ServiceBusMessage message) {
        sender.sendMessage(message);
    }

    private static void processError`,
    );

  assert.equal(
    evaluateRule("prompt/single-message-send", withSource(source)),
    true,
  );
});

test.skip("the batch loop has exactly five iterations", () => {
  for (const source of [
    completeWorkspace.source.replace("index < 5", "index < 4"),
    completeWorkspace.source.replace("index < 5", "index <= 5"),
    completeWorkspace.source.replace("index++", "index += 2"),
  ]) {
    assert.equal(
      evaluateRule("prompt/five-message-batch", withSource(source)),
      false,
    );
  }
});

test.skip("batch addition failure and batch identity are enforced", () => {
  const ignoredFailure = withSource(
    completeWorkspace.source.replace(
      "if (!batch.tryAddMessage(batchMessage)) {",
      "if (batch.tryAddMessage(batchMessage)) {",
    ),
  );
  const wrongAddedMessage = withSource(
    completeWorkspace.source.replace(
      "batch.tryAddMessage(batchMessage)",
      "batch.tryAddMessage(singleMessage)",
    ),
  );
  const wrongSentBatch = withSource(
    completeWorkspace.source.replace(
      "queueSender.sendMessages(batch);",
      "queueSender.sendMessages(queueSender.createMessageBatch());",
    ),
  );
  const reusedMessage = withSource(
    completeWorkspace.source
      .replace(
        "for (int index = 0; index < 5; index++) {",
        `ServiceBusMessage batchMessage =
                    new ServiceBusMessage("reused");
            for (int index = 0; index < 5; index++) {`,
      )
      .replace(
        /                ServiceBusMessage batchMessage =\r?\n                        new ServiceBusMessage\("Batch message " \+ index\);/,
        "",
      ),
  );
  const loggedOnly = withSource(
    completeWorkspace.source.replace(
      /throw new IllegalStateException\(\r?\n                            "The five messages exceeded the batch size\."\);/,
      'System.err.println("The batch is underfilled.");',
    ),
  );

  for (const workspace of [
    ignoredFailure,
    wrongAddedMessage,
    wrongSentBatch,
    reusedMessage,
    loggedOnly,
  ]) {
    assert.equal(evaluateRule("prompt/five-message-batch", workspace), false);
  }
});

test.skip("pull receive requires a finite count and bounded timeout", () => {
  const unbounded = completeWorkspace.source.replace(
    "queueReceiver.receiveMessages(1, Duration.ofSeconds(10))",
    "queueReceiver.receiveMessages(1)",
  );
  assert.equal(
    evaluateRule("prompt/receive-body", withSource(unbounded)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/same-message-settlement", withSource(unbounded)),
    false,
  );
});

test.skip("batch aliases preserve object identity", () => {
  const source = completeWorkspace.source
    .replace(
      "for (int index = 0; index < 5; index++) {",
      `ServiceBusMessageBatch batchAlias = batch;
            for (int index = 0; index < 5; index++) {`,
    )
    .replace("!batch.tryAddMessage", "!batchAlias.tryAddMessage")
    .replace("queueSender.sendMessages(batch);", "queueSender.sendMessages(batchAlias);");

  assert.equal(
    evaluateRule("prompt/five-message-batch", withSource(source)),
    true,
  );
});

test.skip("batch aliases retain allocation identity across reassignment", () => {
  const populatedOldAlias = completeWorkspace.source
    .replace(
      "for (int index = 0; index < 5; index++) {",
      `ServiceBusMessageBatch oldBatch = batch;
            batch = queueSender.createMessageBatch();
            for (int index = 0; index < 5; index++) {`,
    )
    .replace("!batch.tryAddMessage", "!oldBatch.tryAddMessage")
    .replace(
      "queueSender.sendMessages(batch);",
      "queueSender.sendMessages(oldBatch);",
    );
  assert.equal(
    evaluateRule("prompt/five-message-batch", withSource(populatedOldAlias)),
    true,
  );

  const emptyCurrentBatch = populatedOldAlias.replace(
    "queueSender.sendMessages(oldBatch);",
    "queueSender.sendMessages(batch);",
  );
  assert.equal(
    evaluateRule("prompt/five-message-batch", withSource(emptyCurrentBatch)),
    false,
  );
});

test.skip("batch state resets on rebuild and cannot merge a conditional population", () => {
  const rebuilt = completeWorkspace.source.replace(
    "ServiceBusMessageBatch batch = queueSender.createMessageBatch();",
    `ServiceBusMessageBatch discarded = queueSender.createMessageBatch();
            ServiceBusMessageBatch batch = queueSender.createMessageBatch();`,
  );
  assert.equal(
    evaluateRule("prompt/five-message-batch", withSource(rebuilt)),
    true,
  );

  const conditional = completeWorkspace.source
    .replace(
      "for (int index = 0; index < 5; index++) {",
      "if (shouldAdd) {\n            for (int index = 0; index < 5; index++) {",
    )
    .replace(
      "            queueSender.sendMessages(batch);",
      "            }\n            queueSender.sendMessages(batch);",
    );
  assert.equal(
    evaluateRule("prompt/five-message-batch", withSource(conditional)),
    false,
  );
});

test.skip("batch send order, reassignment, and false-path dominance are exact", () => {
  const sendBeforeAdd = completeWorkspace.source.replace(
    "for (int index = 0; index < 5; index++) {",
    `queueSender.sendMessages(batch);
            for (int index = 0; index < 5; index++) {`,
  );
  const resetBeforeSend = completeWorkspace.source.replace(
    "queueSender.sendMessages(batch);",
    `batch = queueSender.createMessageBatch();
            queueSender.sendMessages(batch);`,
  );
  const partialAbort = completeWorkspace.source.replace(
    /throw new IllegalStateException\(\r?\n                            "The five messages exceeded the batch size\."\);/,
    `if (shouldAbort) {
                        throw new IllegalStateException("too large");
                    }`,
  );
  for (const source of [sendBeforeAdd, resetBeforeSend, partialAbort]) {
    assert.equal(
      evaluateRule("prompt/five-message-batch", withSource(source)),
      false,
    );
  }

  const completeAbort = completeWorkspace.source.replace(
    /throw new IllegalStateException\(\r?\n                            "The five messages exceeded the batch size\."\);/,
    `if (shouldThrow) {
                        throw new IllegalStateException("too large");
                    } else {
                        return;
                    }`,
  );
  assert.equal(
    evaluateRule("prompt/five-message-batch", withSource(completeAbort)),
    true,
  );
});

test.skip("queue receive must print the received body", () => {
  const source = completeWorkspace.source.replace(
    "System.out.println(receivedMessage.getBody().toString());",
    'System.out.println("received");',
  );

  assert.equal(
    evaluateRule("prompt/receive-body", withSource(source)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/same-message-settlement", withSource(source)),
    false,
  );
});

test.skip("collection loops cover every possible received message", () => {
  const breakAfterFirst = completeWorkspace.source.replace(
    "queueReceiver.complete(receivedMessage);",
    `queueReceiver.complete(receivedMessage);
                break;`,
  );
  assert.equal(
    evaluateRule("prompt/same-message-settlement", withSource(breakAfterFirst)),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/same-message-settlement",
      withSource(
        breakAfterFirst.replace(
          "queueReceiver.receiveMessages(1, Duration.ofSeconds(10))",
          "queueReceiver.receiveMessages(2, Duration.ofSeconds(10))",
        ),
      ),
    ),
    false,
  );
});

test.skip("settlement tracks receiver, message, and order", () => {
  const wrongMessage = completeWorkspace.source.replace(
    "queueReceiver.complete(receivedMessage);",
    "queueReceiver.complete(subscriptionMessage);",
  );
  const wrongReceiver = completeWorkspace.source.replace(
    "queueReceiver.complete(receivedMessage);",
    "subscriptionReceiver.complete(receivedMessage);",
  );
  const beforeBody = completeWorkspace.source.replace(
    /System\.out\.println\(receivedMessage\.getBody\(\)\.toString\(\)\);\s*queueReceiver\.complete\(receivedMessage\);/,
    `queueReceiver.complete(receivedMessage);
                System.out.println(receivedMessage.getBody().toString());`,
  );

  for (const source of [wrongMessage, wrongReceiver, beforeBody]) {
    assert.equal(
      evaluateRule("prompt/same-message-settlement", withSource(source)),
      false,
    );
  }
});

test.skip("completion must be dominated by normal-flow body output", () => {
  const conditionalOutput = completeWorkspace.source.replace(
    "System.out.println(receivedMessage.getBody().toString());",
    `if (shouldPrint) {
                    System.out.println(receivedMessage.getBody().toString());
                }`,
  );
  const finallyCompletion = completeWorkspace.source.replace(
    "queueReceiver.complete(receivedMessage);",
    `try {
                } finally {
                    queueReceiver.complete(receivedMessage);
                }`,
  );
  const catchCompletion = completeWorkspace.source.replace(
    "queueReceiver.complete(receivedMessage);",
    `try {
                    throw new IllegalStateException();
                } catch (IllegalStateException exception) {
                    queueReceiver.complete(receivedMessage);
                }`,
  );
  for (const source of [
    conditionalOutput,
    finallyCompletion,
    catchCompletion,
  ]) {
    assert.equal(
      evaluateRule("prompt/same-message-settlement", withSource(source)),
      false,
    );
  }
});

test.skip("received-message aliases are accepted", () => {
  const source = completeWorkspace.source.replace(
    `System.out.println(receivedMessage.getBody().toString());
                queueReceiver.complete(receivedMessage);`,
    `ServiceBusReceivedMessage alias = receivedMessage;
                System.out.println(alias.getBody().toString());
                queueReceiver.complete(alias);`,
  );

  assert.equal(evaluateRule("prompt/receive-body", withSource(source)), true);
  assert.equal(
    evaluateRule("prompt/same-message-settlement", withSource(source)),
    true,
  );
});

test.skip("exclusive settlement outcomes pass and a second settlement fails", () => {
  const exclusive = completeWorkspace.source.replace(
    `System.out.println(receivedMessage.getBody().toString());
                queueReceiver.complete(receivedMessage);`,
    `if (shouldRetry) {
                    queueReceiver.abandon(receivedMessage);
                } else {
                    System.out.println(receivedMessage.getBody().toString());
                    queueReceiver.complete(receivedMessage);
                }`,
  );
  assert.equal(
    evaluateRule("prompt/same-message-settlement", withSource(exclusive)),
    true,
  );

  const twice = completeWorkspace.source.replace(
    "queueReceiver.complete(receivedMessage);",
    `queueReceiver.complete(receivedMessage);
                queueReceiver.deadLetter(receivedMessage);`,
  );
  assert.equal(
    evaluateRule("prompt/same-message-settlement", withSource(twice)),
    false,
  );
});

test.skip("both live processor handlers are required", () => {
  const missingMessageHandler = withSource(
    completeWorkspace.source.replace(".processMessage(", ".ignoredMessage("),
  );
  const deadErrorHandler = withSource(
    completeWorkspace.source.replace(
      "System.err.println(context.getException());",
      'System.err.println("processor failed");',
    ),
  );

  assert.equal(
    evaluateRule("prompt/processor-handlers", missingMessageHandler),
    false,
  );
  assert.equal(
    evaluateRule("prompt/processor-handlers", deadErrorHandler),
    false,
  );
});

test.skip("explicit processor settlement requires auto-complete disabled", () => {
  const source = completeWorkspace.source.replace(
    ".disableAutoComplete()",
    "",
  );
  assert.equal(
    evaluateRule("prompt/processor-handlers", withSource(source)),
    false,
  );
});

test.skip("processor handlers accept message and context aliases", () => {
  const source = completeWorkspace.source.replace(
    /System\.out\.println\(\s*context\.getMessage\(\)\.getBody\(\)\.toString\(\)\);\s*context\.complete\(\);/,
    `ServiceBusReceivedMessage handledMessage = context.getMessage();
                        var contextAlias = context;
                        System.out.println(handledMessage.getBody().toString());
                        contextAlias.complete();`,
  );

  assert.equal(
    evaluateRule("prompt/processor-handlers", withSource(source)),
    true,
  );
});

test.skip("processor completion must follow its body output", () => {
  const source = completeWorkspace.source.replace(
    /System\.out\.println\(\s*context\.getMessage\(\)\.getBody\(\)\.toString\(\)\);\s*context\.complete\(\);/,
    `context.complete();
                        System.out.println(
                                context.getMessage().getBody().toString());`,
  );

  assert.equal(
    evaluateRule("prompt/processor-handlers", withSource(source)),
    false,
  );
});

test.skip("a valid processor hidden in unreachable code is rejected", () => {
  const source = completeWorkspace.source
    .replace(".processMessage(", ".ignoredMessage(")
    .replace(
      "ServiceBusProcessorClient processor =",
      `if (false) {
                ServiceBusProcessorClient decoyProcessor = clientBuilder.processor()
                        .queueName(queueName)
                        .receiveMode(ServiceBusReceiveMode.PEEK_LOCK)
                        .processMessage(context -> {
                            System.out.println(context.getMessage().getBody());
                            context.complete();
                            processorSignal.countDown();
                        })
                        .processError(ServiceBusMessages::processError)
                        .buildProcessorClient();
            }
            ServiceBusProcessorClient processor =`,
    );

  assert.equal(
    evaluateRule("prompt/processor-handlers", withSource(source)),
    false,
  );
});

test.skip("registered handler code after an unconditional return is dead", () => {
  const source = completeWorkspace.source
    .replace(
      /context -> \{\s*System\.out\.println\(\s*context\.getMessage\(\)\.getBody\(\)\.toString\(\)\);\s*context\.complete\(\);\s*processorSignal\.countDown\(\);\s*\}/,
      "ServiceBusMessages::deadMessageHandler",
    )
    .replace(
      "    private static void processError",
      `    private static void deadMessageHandler(
            com.azure.messaging.servicebus.ServiceBusReceivedMessageContext context) {
        return;
        // The following decoy is unreachable.
        System.out.println(context.getMessage().getBody().toString());
        context.complete();
    }

    private static void processError`,
    );

  assert.equal(
    evaluateRule("prompt/processor-handlers", withSource(source)),
    false,
  );
});

test.skip("topic and subscription entities cannot be replaced by queue entities", () => {
  const wrongTopic = withSource(
    completeWorkspace.source.replace(
      ".topicName(topicName)",
      ".topicName(queueName)",
    ),
  );
  const wrongSubscription = withSource(
    completeWorkspace.source.replace(
      ".subscriptionName(subscriptionName)",
      ".subscriptionName(queueName)",
    ),
  );

  assert.equal(evaluateRule("prompt/topic-subscription", wrongTopic), false);
  assert.equal(
    evaluateRule("prompt/topic-subscription", wrongSubscription),
    false,
  );
});

test.skip("topic receive requires body output and same-message completion", () => {
  const noBody = withSource(
    completeWorkspace.source.replace(
      "System.out.println(subscriptionMessage.getBody().toString());",
      'System.out.println("topic message");',
    ),
  );
  const wrongMessage = withSource(
    completeWorkspace.source.replace(
      "subscriptionReceiver.complete(subscriptionMessage);",
      "subscriptionReceiver.complete(receivedMessage);",
    ),
  );

  assert.equal(evaluateRule("prompt/topic-subscription", noBody), false);
  assert.equal(evaluateRule("prompt/topic-subscription", wrongMessage), false);
});

test.skip("the topic send uses a message distinct from the queue message", () => {
  const source = completeWorkspace.source.replace(
    'new ServiceBusMessage("Topic subscription message")',
    "singleMessage",
  );

  assert.equal(
    evaluateRule("prompt/topic-subscription", withSource(source)),
    false,
  );
});

test.skip("processor lifecycle needs a bounded matching signal wait", () => {
  const noWait = withSource(
    completeWorkspace.source.replace(
      /if \(!processorSignal\.await\(30, TimeUnit\.SECONDS\)\) \{\s*System\.err\.println\("No processor message arrived in time\."\);\s*\}/,
      "",
    ),
  );
  const wrongSignal = withSource(
    completeWorkspace.source
      .replace(
        "CountDownLatch processorSignal = new CountDownLatch(1);",
        `CountDownLatch processorSignal = new CountDownLatch(1);
            CountDownLatch otherSignal = new CountDownLatch(1);`,
      )
      .replace("processorSignal.countDown();", "otherSignal.countDown();"),
  );
  const immediateStop = withSource(
    completeWorkspace.source.replace(
      "processor.start();",
      `processor.start();
                processor.stop();`,
    ),
  );

  for (const workspace of [noWait, wrongSignal, immediateStop]) {
    assert.equal(evaluateRule("prompt/client-lifecycle", workspace), false);
  }
});

test.skip("processor stop and close are both required", () => {
  const noStop = withSource(
    completeWorkspace.source.replace("processor.stop();", ""),
  );
  const noClose = withSource(
    completeWorkspace.source.replace("processor.close();", ""),
  );

  assert.equal(evaluateRule("prompt/client-lifecycle", noStop), false);
  assert.equal(evaluateRule("prompt/client-lifecycle", noClose), false);
});

test.skip("processor close remains guaranteed when stop throws", () => {
  const sequential = completeWorkspace.source.replace(
    /try \{\s*processor\.stop\(\);\s*\} finally \{\s*processor\.close\(\);\s*\}/,
    `processor.stop();
                processor.close();`,
  );
  assert.equal(
    evaluateRule("prompt/client-lifecycle", withSource(sequential)),
    false,
  );
});

test.skip("every sender and receiver must have structured cleanup", () => {
  const source = completeWorkspace.source.replace(
    "try (ServiceBusSenderClient queueSender =",
    "if (true) { ServiceBusSenderClient queueSender =",
  );

  assert.equal(
    evaluateRule("prompt/client-lifecycle", withSource(source)),
    false,
  );
});

test.skip("closing a different client does not clean up an escaped sender", () => {
  const source = completeWorkspace.source
    .replace(
      "try (ServiceBusSenderClient queueSender =",
      "if (true) { ServiceBusSenderClient queueSender =",
    )
    .replace(
      "            ServiceBusMessage singleMessage =",
      `            topicSender.close();
            ServiceBusMessage singleMessage =`,
    );

  assert.equal(
    evaluateRule("prompt/client-lifecycle", withSource(source)),
    false,
  );
});

test.skip("unknown rules and empty source fail safely", () => {
  assert.throws(
    () => evaluateRule("prompt/not-a-rule", completeWorkspace),
    /Unknown rule/,
  );
  assert.equal(
    evaluateRule("prompt/single-message-send", {
      ...completeWorkspace,
      source: "",
      sourceFiles: [],
    }),
    false,
  );
});
