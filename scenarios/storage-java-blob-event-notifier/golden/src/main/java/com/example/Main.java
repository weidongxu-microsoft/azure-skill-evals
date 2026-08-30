package com.example;

import reactor.core.publisher.Mono;

import java.util.List;

public final class Main {
    private static final String EVENT_GRID_PAYLOAD = """
            [
              {
                "id": "created-1",
                "eventType": "Microsoft.Storage.BlobCreated",
                "subject": "/blobServices/default/containers/invoices/blobs/2026/august/invoice-42.pdf",
                "eventTime": "2026-08-29T01:00:00Z",
                "data": {
                  "api": "PutBlob",
                  "contentType": "application/pdf",
                  "url": "https://example.blob.core.windows.net/invoices/2026/august/invoice-42.pdf"
                },
                "dataVersion": "",
                "metadataVersion": "1",
                "topic": "/subscriptions/demo/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/example"
              },
              {
                "id": "deleted-1",
                "eventType": "Microsoft.Storage.BlobDeleted",
                "subject": "/blobServices/default/containers/invoices/blobs/2026/july/invoice-41.pdf",
                "eventTime": "2026-08-29T01:01:00Z",
                "data": {
                  "api": "DeleteBlob",
                  "url": "https://example.blob.core.windows.net/invoices/2026/july/invoice-41.pdf"
                },
                "dataVersion": "",
                "metadataVersion": "1",
                "topic": "/subscriptions/demo/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/example"
              }
            ]
            """;

    private static final String CLOUD_EVENT_PAYLOAD = """
            [
              {
                "specversion": "1.0",
                "type": "Microsoft.Storage.BlobCreated",
                "source": "/subscriptions/demo/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/example",
                "subject": "/blobServices/default/containers/invoices/blobs/2026/september/invoice-43.pdf",
                "id": "cloud-created-1",
                "time": "2026-08-29T01:02:00Z",
                "datacontenttype": "application/json",
                "data": {
                  "api": "PutBlob",
                  "contentType": "application/pdf",
                  "url": "https://example.blob.core.windows.net/invoices/2026/september/invoice-43.pdf"
                }
              },
              {
                "specversion": "1.0",
                "type": "Microsoft.Storage.BlobDeleted",
                "source": "/subscriptions/demo/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/example",
                "subject": "/blobServices/default/containers/invoices/blobs/2026/june/invoice-40.pdf",
                "id": "cloud-deleted-1",
                "time": "2026-08-29T01:03:00Z",
                "datacontenttype": "application/json",
                "data": {
                  "api": "DeleteBlob",
                  "url": "https://example.blob.core.windows.net/invoices/2026/june/invoice-40.pdf"
                }
              }
            ]
            """;

    private Main() {
    }

    public static void main(String[] args) {
        AzureClients clients = AzureClients.fromEnvironment();
        List<DownstreamNotification> notifications =
                List.of(new DownstreamNotification("invoice-42", "processed"));
        String notificationSubject = "/documents/invoices/processed";

        BlobEventHandler handler = new BlobEventHandler(clients.blobClient());
        EventReceiver receiver = new EventReceiver(handler);
        EventPublisher publisher = new EventPublisher(clients.eventPublisher());

        System.out.println("Running synchronous Event Grid demo...");
        receiver.receiveEventGrid(EVENT_GRID_PAYLOAD);
        receiver.receiveCloudEvents(CLOUD_EVENT_PAYLOAD);
        publisher.publish(notificationSubject, notifications);

        AsyncBlobEventHandler asyncHandler = new AsyncBlobEventHandler(clients.blobAsyncClient());
        AsyncEventReceiver asyncReceiver = new AsyncEventReceiver(asyncHandler);
        AsyncEventPublisher asyncPublisher = new AsyncEventPublisher(clients.eventAsyncPublisher());

        System.out.println("Running asynchronous Event Grid demo...");
        Mono.when(
                        asyncReceiver.receiveEventGridAsync(EVENT_GRID_PAYLOAD),
                        asyncReceiver.receiveCloudEventsAsync(CLOUD_EVENT_PAYLOAD))
                .then(asyncPublisher.publishAsync(notificationSubject, notifications))
                .block();
    }
}
