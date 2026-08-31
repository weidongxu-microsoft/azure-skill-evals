package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.messaging.eventgrid.EventGridEvent;
import com.azure.messaging.eventgrid.EventGridPublisherAsyncClient;
import com.azure.messaging.eventgrid.EventGridPublisherClient;
import com.azure.messaging.eventgrid.EventGridPublisherClientBuilder;
import com.azure.storage.blob.BlobServiceAsyncClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.BlobServiceClientBuilder;

public record AzureClients(
        BlobServiceClient blobClient,
        BlobServiceAsyncClient blobAsyncClient,
        EventGridPublisherClient<EventGridEvent> eventPublisher,
        EventGridPublisherAsyncClient<EventGridEvent> eventAsyncPublisher) {

    public static AzureClients fromEnvironment() {
        String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
        String eventGridEndpoint = requireEnvironment("AZURE_EVENT_GRID_TOPIC_ENDPOINT");
        TokenCredential credential = new DefaultAzureCredentialBuilder().build();

        BlobServiceClient blobClient = new BlobServiceClientBuilder()
                .endpoint(storageEndpoint)
                .credential(credential)
                .buildClient();
        BlobServiceAsyncClient blobAsyncClient = new BlobServiceClientBuilder()
                .endpoint(storageEndpoint)
                .credential(credential)
                .buildAsyncClient();
        EventGridPublisherClient<EventGridEvent> publisher = new EventGridPublisherClientBuilder()
                .endpoint(eventGridEndpoint)
                .credential(credential)
                .buildEventGridEventPublisherClient();
        EventGridPublisherAsyncClient<EventGridEvent> asyncPublisher = new EventGridPublisherClientBuilder()
                .endpoint(eventGridEndpoint)
                .credential(credential)
                .buildEventGridEventPublisherAsyncClient();

        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
