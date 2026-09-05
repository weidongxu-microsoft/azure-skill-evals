package com.example;

public record DownstreamNotification(
        String eventType,
        String documentId,
        String status) {
}
