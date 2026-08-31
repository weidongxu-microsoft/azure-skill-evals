package com.example;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

public record BlobSubject(String containerName, String blobName) {
    private static final String CONTAINER_MARKER = "/containers/";
    private static final String BLOB_MARKER = "/blobs/";

    public static BlobSubject parse(String subject) {
        int containerStart = subject.indexOf(CONTAINER_MARKER);
        int blobMarker = subject.indexOf(BLOB_MARKER, containerStart + CONTAINER_MARKER.length());
        if (containerStart < 0 || blobMarker < 0) {
            throw new IllegalArgumentException("Invalid Blob Storage event subject: " + subject);
        }

        String container = subject.substring(
                containerStart + CONTAINER_MARKER.length(),
                blobMarker);
        String blob = subject.substring(blobMarker + BLOB_MARKER.length());
        if (container.isBlank() || blob.isBlank()) {
            throw new IllegalArgumentException("Missing container or blob name in subject: " + subject);
        }

        return new BlobSubject(
                URLDecoder.decode(container, StandardCharsets.UTF_8),
                URLDecoder.decode(blob, StandardCharsets.UTF_8));
    }
}
