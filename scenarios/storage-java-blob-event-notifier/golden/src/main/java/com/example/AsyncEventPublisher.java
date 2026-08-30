package com.example;

import com.azure.core.exception.HttpResponseException;
import com.azure.core.util.BinaryData;
import com.azure.messaging.eventgrid.EventGridEvent;
import com.azure.messaging.eventgrid.EventGridPublisherAsyncClient;

import reactor.core.publisher.Mono;

import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;

public final class AsyncEventPublisher {
    private static final Logger LOGGER = Logger.getLogger(AsyncEventPublisher.class.getName());
    private final EventGridPublisherAsyncClient<EventGridEvent> client;

    public AsyncEventPublisher(EventGridPublisherAsyncClient<EventGridEvent> client) {
        this.client = client;
    }

    public Mono<Void> publishAsync(String subject, List<DownstreamNotification> notifications) {
        List<EventGridEvent> events = notifications.stream()
                .map(notification -> new EventGridEvent(
                        subject,
                        "Contoso.Documents.Processed",
                        BinaryData.fromObject(notification),
                        "1.0"))
                .toList();
        return client.sendEvents(events)
                .onErrorResume(HttpResponseException.class, exception -> {
                    LOGGER.log(Level.SEVERE, "Event Grid publishing failed", exception);
                    return Mono.error(exception);
                });
    }
}
