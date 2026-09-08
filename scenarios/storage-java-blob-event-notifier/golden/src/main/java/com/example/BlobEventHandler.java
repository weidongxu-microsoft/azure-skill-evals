package com.example;

import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.models.BlobErrorCode;
import com.azure.storage.blob.models.BlobProperties;
import com.azure.storage.blob.models.BlobStorageException;

import java.util.logging.Logger;

public final class BlobEventHandler {
    private static final Logger LOGGER = Logger.getLogger(BlobEventHandler.class.getName());
    private final BlobServiceClient serviceClient;

    public BlobEventHandler(BlobServiceClient serviceClient) {
        this.serviceClient = serviceClient;
    }

    public void handleCreated(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
        BlobClient blob = serviceClient
                .getBlobContainerClient(blobSubject.containerName())
                .getBlobClient(blobSubject.blobName());
        try {
            BlobProperties properties = blob.getProperties();
            blob.downloadContent();
            System.out.printf(
                    "blob=%s size=%d contentType=%s accessTier=%s%n",
                    blobSubject.blobName(),
                    properties.getBlobSize(),
                    properties.getContentType(),
                    properties.getAccessTier());
        } catch (BlobStorageException exception) {
            if (isDeletedRace(exception)) {
                LOGGER.warning(
                        "Blob changed before it could be read: "
                                + blobSubject.blobName()
                                + ", status="
                                + exception.getStatusCode()
                                + ", code="
                                + exception.getErrorCode());
                return;
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
            throw exception;
        }
    }

    public void handleDeleted(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
        LOGGER.info("Blob deleted: " + blobSubject.containerName() + "/" + blobSubject.blobName());
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
