package com.example;

import com.azure.storage.blob.BlobAsyncClient;
import com.azure.storage.blob.BlobServiceAsyncClient;
import com.azure.storage.blob.models.BlobErrorCode;
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
                    if (isDeletedRace(exception)) {
                        LOGGER.warning(
                                "Blob changed before it could be read: "
                                        + blobSubject.blobName()
                                        + ", status="
                                        + exception.getStatusCode()
                                        + ", code="
                                        + exception.getErrorCode());
                        return Mono.empty();
                    }
                    if (isTemporarilyUnavailable(exception)) {
                        LOGGER.warning(
                                "Blob is temporarily unavailable; propagate the event for retry: "
                                        + blobSubject.blobName()
                                        + ", status="
                                        + exception.getStatusCode()
                                        + ", code="
                                        + exception.getErrorCode());
                    }
                    return Mono.error(exception);
                });
    }

    public Mono<Void> handleDeletedAsync(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
        return Mono.fromRunnable(() ->
                LOGGER.info("Blob deleted: " + blobSubject.containerName() + "/" + blobSubject.blobName()));
    }

    private static boolean isDeletedRace(BlobStorageException exception) {
        int status = exception.getStatusCode();
        return status == 404 || status == 412;
    }

    private static boolean isTemporarilyUnavailable(
            BlobStorageException exception) {
        int status = exception.getStatusCode();
        BlobErrorCode errorCode = exception.getErrorCode();
        return status == 408
                || status == 429
                || status >= 500
                || errorCode == BlobErrorCode.BLOB_ARCHIVED
                || errorCode == BlobErrorCode.BLOB_BEING_REHYDRATED;
    }
}
