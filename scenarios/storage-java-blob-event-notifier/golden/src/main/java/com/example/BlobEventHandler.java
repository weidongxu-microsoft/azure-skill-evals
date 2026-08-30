package com.example;

import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobServiceClient;
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
            if (exception.getStatusCode() == 404) {
                LOGGER.warning("Blob disappeared before it could be read: " + blobSubject.blobName());
                return;
            }
            throw exception;
        }
    }

    public void handleDeleted(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
        LOGGER.info("Blob deleted: " + blobSubject.containerName() + "/" + blobSubject.blobName());
    }
}
