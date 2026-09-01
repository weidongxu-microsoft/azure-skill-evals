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
} from "./tools/event-hubs-java-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadJavaWorkspace(goldenWorkspacePath);

test.skip("Java Event Hubs reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip("Java Event Hubs reference passes every language check", () => {
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test.skip("both Event Hubs packages are required", () => {
  const workspace = {
    ...completeWorkspace,
    build: completeWorkspace.build.replace(
      /<dependency>\s*<groupId>com\.azure<\/groupId>\s*<artifactId>azure-messaging-eventhubs-checkpointstore-blob<\/artifactId>[\s\S]*?<\/dependency>/,
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/event-hubs-packages", workspace), false);
});

test.skip("a consumer build cannot stand in for the producer", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      ".buildProducerClient()",
      ".buildConsumerClient()",
    ),
  };

  assert.equal(evaluateRule("prompt/producer-client", workspace), false);
});

test.skip("a nine-event loop fails the batch rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("i < 10", "i < 9"),
  };

  assert.equal(evaluateRule("prompt/event-batch", workspace), false);
});

test.skip("the batch loop must execute exactly ten times with event bodies", () => {
  const invalidSources = [
    completeWorkspace.source.replace("i++", "i += 2"),
    completeWorkspace.source.replace(
      'new EventData("Event " + i)',
      "new EventData()",
    ),
  ];

  for (const source of invalidSources) {
    assert.equal(
      evaluateRule("prompt/event-batch", {
        ...completeWorkspace,
        source,
      }),
      false,
    );
  }
});

test.skip("creating a batch without sending it fails the send rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("producer.send(batch);", ""),
  };

  assert.equal(evaluateRule("prompt/send-batch", workspace), false);
});

test.skip("an unregistered checkpoint store fails the consumer rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      ".checkpointStore(checkpointStore)",
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/checkpointed-consumer", workspace), false);
});

test.skip("the processor must use the default consumer group", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "EventHubClientBuilder.DEFAULT_CONSUMER_GROUP_NAME",
      '"custom-consumer-group"',
    ),
  };

  assert.equal(evaluateRule("prompt/checkpointed-consumer", workspace), false);

  const literalDefault = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "EventHubClientBuilder.DEFAULT_CONSUMER_GROUP_NAME",
      '"$Default"',
    ),
  };
  assert.equal(
    evaluateRule("prompt/checkpointed-consumer", literalDefault),
    true,
  );
});

test.skip("an event handler that omits the body fails receive handling", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "System.out.println(context.getEventData().getBodyAsString());",
      'System.out.println("Event received");',
    ),
  };

  assert.equal(evaluateRule("prompt/receive-handlers", workspace), false);
  assert.equal(evaluateRule("prompt/update-checkpoint", workspace), true);
});

test.skip("checkpointing must occur in the registered event handler", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "context.updateCheckpoint();",
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/update-checkpoint", workspace), false);
});

test.skip("starting without stopping fails lifecycle management", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("processor.stop();", ""),
  };

  assert.equal(evaluateRule("prompt/client-lifecycle", workspace), false);
});

test.skip("connection strings with embedded entity paths are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replaceAll(
      ".connectionString(eventHubsConnectionString, eventHubName)",
      ".connectionString(eventHubsConnectionString)",
    ),
  };

  assert.equal(evaluateRule("prompt/producer-client", workspace), true);
  assert.equal(evaluateRule("prompt/checkpointed-consumer", workspace), true);
});

test.skip("event handlers may assign the body before printing it", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "System.out.println(context.getEventData().getBodyAsString());",
      `String body = context.getEventData().getBodyAsString();
        System.out.println(body);`,
    ),
  };

  assert.equal(evaluateRule("prompt/receive-handlers", workspace), true);
});

test.skip("inline batch handlers and structured producer cleanup are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
import com.azure.messaging.eventhubs.*;
import com.azure.messaging.eventhubs.checkpointstore.blob.BlobCheckpointStore;
import com.azure.storage.blob.*;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;

class Alternate {
    void run(String eventHubsConnection, String storageConnection)
            throws InterruptedException {
        EventProcessorClient processor = new EventProcessorClientBuilder()
            .connectionString(eventHubsConnection)
            .consumerGroup(EventHubClientBuilder.DEFAULT_CONSUMER_GROUP_NAME)
            .checkpointStore(new BlobCheckpointStore(
                new BlobContainerClientBuilder()
                    .connectionString(storageConnection)
                    .containerName("checkpoints")
                    .buildAsyncClient()))
            .processEventBatch(batchContext -> {
                batchContext.getEvents().forEach(event ->
                    System.out.println(event.getBodyAsString()));
                batchContext.updateCheckpoint();
            }, 100, Duration.ofSeconds(5))
            .processError(errorContext ->
                errorContext.getThrowable().printStackTrace())
            .buildEventProcessorClient();

        try (EventHubProducerClient producer = new EventHubClientBuilder()
                .connectionString(eventHubsConnection)
                .buildProducerClient()) {
            processor.start();
            new CountDownLatch(1).await();
            processor.stop();
        }
    }
}
`,
  };

  for (const rule of [
    "prompt/producer-client",
    "prompt/checkpointed-consumer",
    "prompt/receive-handlers",
    "prompt/update-checkpoint",
    "prompt/client-lifecycle",
  ]) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test.skip("handler variables are resolved and unrelated text is ignored", () => {
  const handlerWorkspace = {
    ...completeWorkspace,
    source: `
Consumer<EventContext> eventHandler = eventContext -> {
    System.out.println(eventContext.getEventData().getBodyAsString());
    eventContext.updateCheckpoint();
};
Consumer<ErrorContext> errorHandler =
    errorContext -> System.err.println(errorContext.getThrowable());
EventProcessorClient processor = new EventProcessorClientBuilder()
    .connectionString(connection)
    .consumerGroup("$Default")
    .checkpointStore(new BlobCheckpointStore(
        new BlobContainerClientBuilder()
            .connectionString(storage)
            .containerName("checkpoints")
            .buildAsyncClient()))
    .processEvent(eventHandler)
    .processError(errorHandler)
    .buildEventProcessorClient();
`,
  };
  const isolatedText = {
    ...completeWorkspace,
    source: `
class Notes {
    // EventHubProducerClient producer = new EventHubClientBuilder()
    //     .connectionString(connection).buildProducerClient();
    String example = "producer.send(batch); processor.start(); processor.stop();";
}
`,
  };

  assert.equal(evaluateRule("prompt/receive-handlers", handlerWorkspace), true);
  assert.equal(evaluateRule("prompt/update-checkpoint", handlerWorkspace), true);
  assert.equal(evaluateRule("prompt/producer-client", isolatedText), false);
  assert.equal(evaluateRule("prompt/client-lifecycle", isolatedText), false);
});
