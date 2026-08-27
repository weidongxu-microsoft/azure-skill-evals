import { DefaultAzureCredential } from "@azure/identity";
import {
  ServiceBusClient,
  type ProcessErrorArgs,
  type ServiceBusMessage,
  type ServiceBusReceivedMessage,
} from "@azure/service-bus";

declare const process: {
  env: Record<string, string | undefined>;
};

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before running the application.`);
  }
  return value;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
  const namespace = requireEnvironment(
    "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE",
  );
  const queueName = requireEnvironment("SERVICE_BUS_QUEUE_NAME");
  const topicName = requireEnvironment("SERVICE_BUS_TOPIC_NAME");
  const subscriptionName = requireEnvironment(
    "SERVICE_BUS_SUBSCRIPTION_NAME",
  );
  const client = new ServiceBusClient(
    namespace,
    new DefaultAzureCredential(),
  );
  let queueSender:
    | ReturnType<ServiceBusClient["createSender"]>
    | undefined;
  let queueReceiver:
    | ReturnType<ServiceBusClient["createReceiver"]>
    | undefined;
  let processorReceiver:
    | ReturnType<ServiceBusClient["createReceiver"]>
    | undefined;
  let topicSender:
    | ReturnType<ServiceBusClient["createSender"]>
    | undefined;
  let subscriptionReceiver:
    | ReturnType<ServiceBusClient["createReceiver"]>
    | undefined;
  let processorSubscription:
    | { close(): Promise<void> }
    | undefined;

  try {
    queueSender = client.createSender(queueName);
    queueReceiver = client.createReceiver(queueName);
    processorReceiver = client.createReceiver(queueName);
    topicSender = client.createSender(topicName);
    subscriptionReceiver = client.createReceiver(
      topicName,
      subscriptionName,
    );
    await queueSender.sendMessages({
      body: "single queue message",
    });

    const batch = await queueSender.createMessageBatch();
    for (let index = 0; index < 5; index += 1) {
      const message: ServiceBusMessage = {
        body: `queue batch message ${index}`,
      };
      if (!batch.tryAddMessage(message)) {
        throw new Error(`Queue batch message ${index} did not fit.`);
      }
    }
    await queueSender.sendMessages(batch);

    const queueMessages = await queueReceiver.receiveMessages(5, {
      maxWaitTimeInMs: 5_000,
    });
    for (const message of queueMessages) {
      console.log(message.body);
      await queueReceiver.completeMessage(message);
    }

    const processMessage = async (
      message: ServiceBusReceivedMessage,
    ): Promise<void> => {
      if (!processorReceiver) {
        throw new Error("The processor receiver is not initialized.");
      }
      console.log(message.body);
      await processorReceiver.completeMessage(message);
    };
    const processError = async (args: ProcessErrorArgs): Promise<void> => {
      console.error(args.error);
    };
    const processorOptions = {
      autoCompleteMessages: false,
    } as const;
    processorSubscription = processorReceiver.subscribe({
      processMessage,
      processError,
    }, processorOptions);
    await wait(5_000);

    const topicMessage: ServiceBusMessage = {
      body: "topic message",
    };
    await topicSender.sendMessages(topicMessage);
    const subscriptionMessages =
      await subscriptionReceiver.receiveMessages(1, {
        maxWaitTimeInMs: 5_000,
      });
    for (const message of subscriptionMessages) {
      console.log(message.body);
      await subscriptionReceiver.completeMessage(message);
    }
  } finally {
    await Promise.allSettled([
      processorSubscription?.close(),
    ]);
    await Promise.allSettled([
      queueSender?.close(),
      queueReceiver?.close(),
      processorReceiver?.close(),
      topicSender?.close(),
      subscriptionReceiver?.close(),
    ]);
    await client.close();
  }
}

await main();
