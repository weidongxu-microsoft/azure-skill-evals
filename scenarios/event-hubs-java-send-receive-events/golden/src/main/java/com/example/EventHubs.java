package com.example;

import com.azure.messaging.eventhubs.EventData;
import com.azure.messaging.eventhubs.EventDataBatch;
import com.azure.messaging.eventhubs.EventHubClientBuilder;
import com.azure.messaging.eventhubs.EventHubProducerClient;
import com.azure.messaging.eventhubs.EventProcessorClient;
import com.azure.messaging.eventhubs.EventProcessorClientBuilder;
import com.azure.messaging.eventhubs.checkpointstore.blob.BlobCheckpointStore;
import com.azure.messaging.eventhubs.models.ErrorContext;
import com.azure.messaging.eventhubs.models.EventContext;
import com.azure.storage.blob.BlobContainerAsyncClient;
import com.azure.storage.blob.BlobContainerClientBuilder;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.UUID;

public final class EventHubs {
    private EventHubs() {
    }

    public static void main(String[] args) throws InterruptedException {
        String eventHubsConnectionString =
                requireEnvironment("EVENT_HUBS_CONNECTION_STRING");
        String eventHubName = requireEnvironment("EVENT_HUB_NAME");
        String storageConnectionString =
                requireEnvironment("STORAGE_CONNECTION_STRING");
        String checkpointContainerName =
                requireEnvironment("CHECKPOINT_CONTAINER_NAME");

        try (EventHubProducerClient producer = new EventHubClientBuilder()
                .connectionString(eventHubsConnectionString, eventHubName)
                .buildProducerClient()) {
            BlobContainerAsyncClient blobContainer =
                    new BlobContainerClientBuilder()
                            .connectionString(storageConnectionString)
                            .containerName(checkpointContainerName)
                            .buildAsyncClient();
            blobContainer.createIfNotExists().block();
            BlobCheckpointStore checkpointStore =
                    new BlobCheckpointStore(blobContainer);
            CountDownLatch receivedEvents = new CountDownLatch(10);
            CountDownLatch initializedPartition = new CountDownLatch(1);
            String batchId = UUID.randomUUID().toString();

            EventProcessorClient processor = new EventProcessorClientBuilder()
                    .connectionString(eventHubsConnectionString, eventHubName)
                    .consumerGroup(EventHubClientBuilder.DEFAULT_CONSUMER_GROUP_NAME)
                    .checkpointStore(checkpointStore)
                    .processPartitionInitialization(context ->
                            initializedPartition.countDown())
                    .processEvent(context ->
                            processEvent(context, receivedEvents, batchId))
                    .processError(EventHubs::processError)
                    .buildEventProcessorClient();

            try {
                processor.start();
                if (!initializedPartition.await(30, TimeUnit.SECONDS)) {
                    throw new IllegalStateException(
                            "Timed out waiting for a partition receiver to initialize.");
                }
                EventDataBatch batch = producer.createBatch();
                for (int i = 0; i < 10; i++) {
                    EventData event = new EventData("Event " + i);
                    event.getProperties().put("eventId", i);
                    event.getProperties().put("batchId", batchId);
                    if (!batch.tryAdd(event)) {
                        throw new IllegalStateException(
                                "The ten events exceeded the batch size.");
                    }
                }
                producer.send(batch);
                if (!receivedEvents.await(30, TimeUnit.SECONDS)) {
                    throw new IllegalStateException(
                            "Timed out waiting for all ten events; received "
                                    + (10 - receivedEvents.getCount()) + ".");
                }
            } finally {
                processor.stop();
            }
        }
    }

    private static void processEvent(
            EventContext context,
            CountDownLatch receivedEvents,
            String expectedBatchId) {
        System.out.println(context.getEventData().getBodyAsString());
        context.updateCheckpoint();
        if (expectedBatchId.equals(
                context.getEventData().getProperties().get("batchId"))) {
            receivedEvents.countDown();
        }
    }

    private static void processError(ErrorContext context) {
        System.err.println(context.getThrowable());
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
