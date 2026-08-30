package com.example;

import com.azure.core.models.CloudEvent;
import com.azure.messaging.eventgrid.EventGridEvent;

import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.util.logging.Logger;

public final class AsyncEventReceiver {
    private static final String BLOB_CREATED = "Microsoft.Storage.BlobCreated";
    private static final String BLOB_DELETED = "Microsoft.Storage.BlobDeleted";
    private static final Logger LOGGER = Logger.getLogger(AsyncEventReceiver.class.getName());
    private final AsyncBlobEventHandler handler;

    public AsyncEventReceiver(AsyncBlobEventHandler handler) {
        this.handler = handler;
    }

    public Mono<Void> receiveEventGridAsync(String payload) {
        return Flux.fromIterable(EventGridEvent.fromString(payload))
                .concatMap(event -> routeAsync(event.getEventType(), event.getSubject()))
                .then();
    }

    public Mono<Void> receiveCloudEventsAsync(String payload) {
        return Flux.fromIterable(CloudEvent.fromString(payload))
                .concatMap(event -> routeAsync(event.getType(), event.getSubject()))
                .then();
    }

    private Mono<Void> routeAsync(String eventType, String subject) {
        if (BLOB_CREATED.equals(eventType)) {
            return handler.handleCreatedAsync(subject);
        }
        if (BLOB_DELETED.equals(eventType)) {
            return handler.handleDeletedAsync(subject);
        }
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        return Mono.empty();
    }
}
