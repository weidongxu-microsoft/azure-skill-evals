package com.example;

import com.azure.storage.blob.BlobAsyncClient;
import com.azure.storage.blob.BlobServiceAsyncClient;
import com.azure.storage.blob.models.BlobStorageException;

import reactor.core.publisher.Mono;

import java.util.logging.Logger;

public final class AsyncBlobEventHandler {
    private static final Logger LOGGER = Logger.getLogger(AsyncBlobEventHandler.class.getName());
    private final BlobServiceAsyncClient serviceClient;

    public AsyncBlobEventHandler(BlobServiceAsyncClient serviceClient) {
        this.serviceClient = serviceClient;
    }

    public Mono<Void> handleCreatedAsync(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
        BlobAsyncClient blob = serviceClient
                .getBlobContainerAsyncClient(blobSubject.containerName())
                .getBlobAsyncClient(blobSubject.blobName());

        return blob.getProperties()
                .zipWith(blob.downloadContent())
                .doOnNext(result -> System.out.printf(
                        "blob=%s size=%d contentType=%s accessTier=%s%n",
                        blobSubject.blobName(),
                        result.getT1().getBlobSize(),
                        result.getT1().getContentType(),
                        result.getT1().getAccessTier()))
                .then()
                .onErrorResume(BlobStorageException.class, exception -> {
                    if (exception.getStatusCode() == 404) {
                        LOGGER.warning("Blob disappeared before it could be read: " + blobSubject.blobName());
                        return Mono.empty();
                    }
                    return Mono.error(exception);
                });
    }

    public Mono<Void> handleDeletedAsync(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
        return Mono.fromRunnable(() ->
                LOGGER.info("Blob deleted: " + blobSubject.containerName() + "/" + blobSubject.blobName()));
    }
}
