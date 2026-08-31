package com.example;

import com.azure.core.models.CloudEvent;
import com.azure.messaging.eventgrid.EventGridEvent;

import java.util.logging.Logger;

public final class EventReceiver {
    private static final String BLOB_CREATED = "Microsoft.Storage.BlobCreated";
    private static final String BLOB_DELETED = "Microsoft.Storage.BlobDeleted";
    private static final Logger LOGGER = Logger.getLogger(EventReceiver.class.getName());
    private final BlobEventHandler handler;

    public EventReceiver(BlobEventHandler handler) {
        this.handler = handler;
    }

    public void receiveEventGrid(String payload) {
        for (EventGridEvent event : EventGridEvent.fromString(payload)) {
            route(event.getEventType(), event.getSubject());
        }
    }

    public void receiveCloudEvents(String payload) {
        for (CloudEvent event : CloudEvent.fromString(payload)) {
            route(event.getType(), event.getSubject());
        }
    }

    private void route(String eventType, String subject) {
        if (BLOB_CREATED.equals(eventType)) {
            handler.handleCreated(subject);
        } else if (BLOB_DELETED.equals(eventType)) {
            handler.handleDeleted(subject);
        } else {
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }
    }
}
