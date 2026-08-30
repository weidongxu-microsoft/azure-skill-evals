package com.example;

import com.azure.core.exception.HttpResponseException;
import com.azure.core.util.BinaryData;
import com.azure.messaging.eventgrid.EventGridEvent;
import com.azure.messaging.eventgrid.EventGridPublisherClient;

import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;

public final class EventPublisher {
    private static final Logger LOGGER = Logger.getLogger(EventPublisher.class.getName());
    private final EventGridPublisherClient<EventGridEvent> client;

    public EventPublisher(EventGridPublisherClient<EventGridEvent> client) {
        this.client = client;
    }

    public void publish(String subject, List<DownstreamNotification> notifications) {
        List<EventGridEvent> events = notifications.stream()
                .map(notification -> new EventGridEvent(
                        subject,
                        "Contoso.Documents.Processed",
                        BinaryData.fromObject(notification),
                        "1.0"))
                .toList();
        try {
            client.sendEvents(events);
        } catch (HttpResponseException exception) {
            LOGGER.log(Level.SEVERE, "Event Grid publishing failed", exception);
            throw exception;
        }
    }
}
