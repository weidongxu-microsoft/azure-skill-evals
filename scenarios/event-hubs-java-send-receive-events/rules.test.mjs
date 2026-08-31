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

const baseline33374429826 = {
  sourceFiles: ["src/main/java/com/example/EventHubsSendReceive.java"],
  buildFiles: ["pom.xml"],
  source: [
  [
    "package com.example;",
    "",
    "import com.azure.messaging.eventhubs.EventData;",
    "import com.azure.messaging.eventhubs.EventDataBatch;",
    "import com.azure.messaging.eventhubs.EventHubClientBuilder;",
    "import com.azure.messaging.eventhubs.EventHubProducerClient;",
    "import com.azure.messaging.eventhubs.EventProcessorClient;",
    "import com.azure.messaging.eventhubs.EventProcessorClientBuilder;",
    "import com.azure.messaging.eventhubs.checkpointstore.blob.BlobCheckpointStore;",
    "import com.azure.messaging.eventhubs.models.ErrorContext;",
    "import com.azure.messaging.eventhubs.models.EventContext;",
    "import com.azure.storage.blob.BlobContainerAsyncClient;",
    "import com.azure.storage.blob.BlobContainerClientBuilder;",
    "",
    "import java.time.Duration;",
    "",
    "public final class EventHubsSendReceive {",
    "    private static final int EVENT_COUNT = 10;",
    "    private static final Duration PROCESSING_TIME = Duration.ofSeconds(30);",
    "",
    "    private EventHubsSendReceive() {",
    "    }",
    "",
    "    public static void main(String[] args) throws InterruptedException {",
    "        String eventHubsConnectionString = requiredEnvironmentVariable(\"EVENT_HUBS_CONNECTION_STRING\");",
    "        String eventHubName = requiredEnvironmentVariable(\"EVENT_HUB_NAME\");",
    "        String storageConnectionString = requiredEnvironmentVariable(\"STORAGE_CONNECTION_STRING\");",
    "        String checkpointContainerName = requiredEnvironmentVariable(\"CHECKPOINT_CONTAINER_NAME\");",
    "",
    "        EventHubProducerClient producer = new EventHubClientBuilder()",
    "            .connectionString(eventHubsConnectionString, eventHubName)",
    "            .buildProducerClient();",
    "",
    "        EventProcessorClient processor = null;",
    "        try {",
    "            EventDataBatch batch = producer.createBatch();",
    "            for (int i = 1; i <= EVENT_COUNT; i++) {",
    "                EventData event = new EventData(\"Event \" + i);",
    "                event.getProperties().put(\"eventNumber\", i);",
    "                if (!batch.tryAdd(event)) {",
    "                    throw new IllegalStateException(\"Event \" + i + \" does not fit in the EventDataBatch\");",
    "                }",
    "            }",
    "            producer.send(batch);",
    "",
    "            BlobContainerAsyncClient blobContainerClient = new BlobContainerClientBuilder()",
    "                .connectionString(storageConnectionString)",
    "                .containerName(checkpointContainerName)",
    "                .buildAsyncClient();",
    "            blobContainerClient.createIfNotExists().block();",
    "",
    "            BlobCheckpointStore checkpointStore = new BlobCheckpointStore(blobContainerClient);",
    "            processor = new EventProcessorClientBuilder()",
    "                .connectionString(eventHubsConnectionString, eventHubName)",
    "                .consumerGroup(EventHubClientBuilder.DEFAULT_CONSUMER_GROUP_NAME)",
    "                .checkpointStore(checkpointStore)",
    "                .processEvent(EventHubsSendReceive::processEvent)",
    "                .processError(EventHubsSendReceive::processError)",
    "                .buildEventProcessorClient();",
    "",
    "            processor.start();",
    "            Thread.sleep(PROCESSING_TIME.toMillis());",
    "        } finally {",
    "            if (processor != null) {",
    "                processor.stop();",
    "            }",
    "            producer.close();",
    "        }",
    "    }",
    "",
    "    private static void processEvent(EventContext context) {",
    "        System.out.printf(",
    "            \"Received event from partition %s: %s%n\",",
    "            context.getPartitionContext().getPartitionId(),",
    "            context.getEventData().getBodyAsString());",
    "        context.updateCheckpoint();",
    "    }",
    "",
    "    private static void processError(ErrorContext context) {",
    "        System.err.printf(",
    "            \"Error while processing partition %s: %s%n\",",
    "            context.getPartitionContext().getPartitionId(),",
    "            context.getThrowable());",
    "    }",
    "",
    "    private static String requiredEnvironmentVariable(String name) {",
    "        String value = System.getenv(name);",
    "        if (value == null || value.isBlank()) {",
    "            throw new IllegalStateException(\"Required environment variable is not set: \" + name);",
    "        }",
    "        return value;",
    "    }",
    "}",
    ""
].join("\n")
].join("\n"),
  build: [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<project xmlns=\"http://maven.apache.org/POM/4.0.0\"",
    "         xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"",
    "         xsi:schemaLocation=\"http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd\">",
    "    <modelVersion>4.0.0</modelVersion>",
    "",
    "    <groupId>com.example</groupId>",
    "    <artifactId>event-hubs-send-receive</artifactId>",
    "    <version>1.0.0</version>",
    "",
    "    <properties>",
    "        <maven.compiler.release>17</maven.compiler.release>",
    "        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>",
    "    </properties>",
    "",
    "    <dependencies>",
    "        <dependency>",
    "            <groupId>com.azure</groupId>",
    "            <artifactId>azure-messaging-eventhubs</artifactId>",
    "            <version>5.21.6</version>",
    "        </dependency>",
    "        <dependency>",
    "            <groupId>com.azure</groupId>",
    "            <artifactId>azure-messaging-eventhubs-checkpointstore-blob</artifactId>",
    "            <version>1.21.8</version>",
    "        </dependency>",
    "    </dependencies>",
    "",
    "    <build>",
    "        <plugins>",
    "            <plugin>",
    "                <groupId>org.apache.maven.plugins</groupId>",
    "                <artifactId>maven-compiler-plugin</artifactId>",
    "                <version>3.14.1</version>",
    "            </plugin>",
    "        </plugins>",
    "    </build>",
    "</project>",
    ""
].join("\n"),
};

test("Java Event Hubs reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("Java Event Hubs reference passes every language check", () => {
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test("both Event Hubs packages are required", () => {
  const workspace = {
    ...completeWorkspace,
    build: completeWorkspace.build.replace(
      /<dependency>\s*<groupId>com\.azure<\/groupId>\s*<artifactId>azure-messaging-eventhubs-checkpointstore-blob<\/artifactId>[\s\S]*?<\/dependency>/,
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/event-hubs-packages", workspace), false);
});

test("a consumer build cannot stand in for the producer", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      ".buildProducerClient()",
      ".buildConsumerClient()",
    ),
  };

  assert.equal(evaluateRule("prompt/producer-client", workspace), false);
});

test("a nine-event loop fails the batch rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("i < 10", "i < 9"),
  };

  assert.equal(evaluateRule("prompt/event-batch", workspace), false);
});

test("the batch loop must execute exactly ten times with event bodies", () => {
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

test("creating a batch without sending it fails the send rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("producer.send(batch);", ""),
  };

  assert.equal(evaluateRule("prompt/send-batch", workspace), false);
});

test("an unregistered checkpoint store fails the consumer rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      ".checkpointStore(checkpointStore)",
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/checkpointed-consumer", workspace), false);
});

test("the processor must use the default consumer group", () => {
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

test("an event handler that omits the body fails receive handling", () => {
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

test("checkpointing must occur in the registered event handler", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "context.updateCheckpoint();",
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/update-checkpoint", workspace), false);
});

test("starting without stopping fails lifecycle management", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("processor.stop();", ""),
  };

  assert.equal(evaluateRule("prompt/client-lifecycle", workspace), false);
});

test("connection strings with embedded entity paths are accepted", () => {
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

test("event handlers may assign the body before printing it", () => {
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

test("inline batch handlers and structured producer cleanup are accepted", () => {
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

test("handler variables are resolved and unrelated text is ignored", () => {
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

test("baseline run 33374429826 exact Event Hubs output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, baseline33374429826), true, check);
  }
});
