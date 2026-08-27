import {
  EventHubConsumerClient,
  EventHubProducerClient,
  type Subscription,
} from "@azure/event-hubs";
import { BlobCheckpointStore } from "@azure/eventhubs-checkpointstore-blob";
import { BlobServiceClient } from "@azure/storage-blob";

declare const process: {
  env: Record<string, string | undefined>;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): void;
};

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before running the application.`);
  }
  return value;
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function main(): Promise<void> {
  const connectionString = requireEnvironment("EVENT_HUB_CONNECTION_STRING");
  const eventHubName = requireEnvironment("EVENT_HUB_NAME");
  const producer = new EventHubProducerClient(connectionString, eventHubName);

  const blobServiceClient = BlobServiceClient.fromConnectionString(
    requireEnvironment("CHECKPOINT_STORAGE_CONNECTION_STRING"),
  );
  const containerClient = blobServiceClient.getContainerClient(
    requireEnvironment("CHECKPOINT_CONTAINER_NAME"),
  );
  await containerClient.createIfNotExists();
  const checkpointStore = new BlobCheckpointStore(containerClient);
  const consumer = new EventHubConsumerClient(
    EventHubConsumerClient.defaultConsumerGroupName,
    connectionString,
    eventHubName,
    checkpointStore,
  );

  let subscription: Subscription | undefined;
  try {
    const batch = await producer.createBatch();
    for (let index = 0; index < 10; index += 1) {
      const event = {
        body: `event-${index}`,
        properties: { sequence: index, source: "typescript-reference" },
      };
      if (!batch.tryAdd(event)) {
        throw new Error(`Event ${index} did not fit in the batch.`);
      }
    }
    await producer.sendBatch(batch);

    subscription = consumer.subscribe({
      processEvents: async (events, context) => {
        for (const event of events) {
          console.log(event.body);
        }
        if (events.length > 0) {
          await context.updateCheckpoint(events[events.length - 1]);
        }
      },
      processError: async (error, context) => {
        console.error("Partition failure", context.partitionId, error);
      },
    });

    await waitForShutdown();
  } finally {
    await subscription?.close();
    await consumer.close();
    await producer.close();
  }
}

await main();
