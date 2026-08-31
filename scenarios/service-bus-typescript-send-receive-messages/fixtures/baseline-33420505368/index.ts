import { DefaultAzureCredential } from "@azure/identity";
import {
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceiver,
  ServiceBusSender,
  ServiceBusMessageBatch,
} from "@azure/service-bus";

const REQUIRED_ENVIRONMENT_VARIABLES = [
  "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE",
  "SERVICE_BUS_QUEUE_NAME",
  "SERVICE_BUS_TOPIC_NAME",
  "SERVICE_BUS_SUBSCRIPTION_NAME",
] as const;

type RequiredEnvironmentVariable =
  (typeof REQUIRED_ENVIRONMENT_VARIABLES)[number];

function requireEnvironmentVariable(name: RequiredEnvironmentVariable): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  const fullyQualifiedNamespace = requireEnvironmentVariable(
    "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE",
  );
  const queueName = requireEnvironmentVariable("SERVICE_BUS_QUEUE_NAME");
  const topicName = requireEnvironmentVariable("SERVICE_BUS_TOPIC_NAME");
  const subscriptionName = requireEnvironmentVariable(
    "SERVICE_BUS_SUBSCRIPTION_NAME",
  );

  const credential = new DefaultAzureCredential();
  const client = new ServiceBusClient(fullyQualifiedNamespace, credential);

  let queueSender: ServiceBusSender | undefined;
  let queueReceiver: ServiceBusReceiver | undefined;
  let queueProcessingReceiver: ServiceBusReceiver | undefined;
  let queueSubscription:
    | ReturnType<ServiceBusReceiver["subscribe"]>
    | undefined;
  let topicSender: ServiceBusSender | undefined;
  let subscriptionReceiver: ServiceBusReceiver | undefined;

  try {
    queueSender = client.createSender(queueName);
    queueReceiver = client.createReceiver(queueName);

    await queueSender.sendMessages({
      body: "Single queue message",
      contentType: "text/plain",
    });

    const batch: ServiceBusMessageBatch = await queueSender.createMessageBatch();
    for (let index = 1; index <= 5; index += 1) {
      const message: ServiceBusMessage = {
        body: `Queue batch message ${index}`,
        contentType: "text/plain",
      };

      if (!batch.tryAddMessage(message)) {
        throw new Error(`Queue batch message ${index} does not fit in the batch`);
      }
    }
    await queueSender.sendMessages(batch);

    const queueMessages = await queueReceiver.receiveMessages(6, {
      maxWaitTimeInMs: 5_000,
    });
    for (const message of queueMessages) {
      console.log(message.body);
      await queueReceiver.completeMessage(message);
    }

    queueProcessingReceiver = client.createReceiver(queueName);
    const activeQueueProcessingReceiver = queueProcessingReceiver;
    queueSubscription = activeQueueProcessingReceiver.subscribe({
      processMessage: async (message) => {
        console.log(message.body);
        await activeQueueProcessingReceiver.completeMessage(message);
      },
      processError: async (args) => {
        console.error("Queue processing error:", args.error);
      },
    });

    await delay(5_000);
    await queueSubscription.close();
    queueSubscription = undefined;
    await activeQueueProcessingReceiver.close();
    queueProcessingReceiver = undefined;

    topicSender = client.createSender(topicName);
    subscriptionReceiver = client.createReceiver(topicName, subscriptionName);

    await topicSender.sendMessages({
      body: "Topic message",
      contentType: "text/plain",
    });

    const topicMessages = await subscriptionReceiver.receiveMessages(1, {
      maxWaitTimeInMs: 5_000,
    });
    for (const message of topicMessages) {
      console.log(message.body);
      await subscriptionReceiver.completeMessage(message);
    }
  } finally {
    const cleanupErrors: unknown[] = [];

    if (queueSubscription) {
      try {
        await queueSubscription.close();
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
    }

    const closeResults = await Promise.allSettled(
      [
        queueSender?.close(),
        queueReceiver?.close(),
        queueProcessingReceiver?.close(),
        topicSender?.close(),
        subscriptionReceiver?.close(),
      ].filter((close): close is Promise<void> => close !== undefined),
    );
    for (const result of closeResults) {
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
      }
    }

    try {
      await client.close();
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Failed to close Service Bus resources");
    }
  }
}

main().catch((error: unknown) => {
  console.error("Service Bus operation failed:", error);
  process.exitCode = 1;
});
