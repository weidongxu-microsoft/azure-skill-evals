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

import java.util.concurrent.TimeUnit;

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

        EventHubProducerClient producer = new EventHubClientBuilder()
                .connectionString(eventHubsConnectionString, eventHubName)
                .buildProducerClient();

        EventDataBatch batch = producer.createBatch();
        for (int i = 0; i < 10; i++) {
            EventData event = new EventData("Event " + i);
            event.getProperties().put("eventId", i);
            if (!batch.tryAdd(event)) {
                throw new IllegalStateException("The ten events exceeded the batch size.");
            }
        }
        producer.send(batch);

        BlobContainerAsyncClient blobContainer =
                new BlobContainerClientBuilder()
                        .connectionString(storageConnectionString)
                        .containerName(checkpointContainerName)
                        .buildAsyncClient();
        blobContainer.createIfNotExists().block();
        BlobCheckpointStore checkpointStore =
                new BlobCheckpointStore(blobContainer);

        EventProcessorClient processor = new EventProcessorClientBuilder()
                .connectionString(eventHubsConnectionString, eventHubName)
                .consumerGroup(EventHubClientBuilder.DEFAULT_CONSUMER_GROUP_NAME)
                .checkpointStore(checkpointStore)
                .processEvent(EventHubs::processEvent)
                .processError(EventHubs::processError)
                .buildEventProcessorClient();

        try {
            processor.start();
            TimeUnit.SECONDS.sleep(30);
        } finally {
            processor.stop();
            producer.close();
        }
    }

    private static void processEvent(EventContext context) {
        System.out.println(context.getEventData().getBodyAsString());
        context.updateCheckpoint();
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
