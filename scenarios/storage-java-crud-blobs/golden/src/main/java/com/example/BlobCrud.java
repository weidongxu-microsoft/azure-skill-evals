package com.example;

import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobContainerClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.BlobServiceClientBuilder;
import com.azure.storage.blob.models.BlobItem;
import com.azure.storage.blob.models.BlobStorageException;

public final class BlobCrud {
    private static final String CONTAINER_NAME = "my-container";
    private static final String BLOB_NAME = "uploads/data.txt";

    private BlobCrud() {
    }

    public static void main(String[] args) {
        String accountUrl = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
        BlobServiceClient serviceClient = new BlobServiceClientBuilder()
                .endpoint(accountUrl)
                .credential(new DefaultAzureCredentialBuilder().build())
                .buildClient();
        BlobContainerClient containerClient =
                serviceClient.getBlobContainerClient(CONTAINER_NAME);
        BlobClient blobClient = containerClient.getBlobClient(BLOB_NAME);

        try {
            if (!containerClient.exists()) {
                containerClient.create();
            }

            blobClient.uploadFromFile("data.txt", true);

            for (BlobItem blob : containerClient.listBlobs()) {
                System.out.printf(
                        "Blob: %s, size: %d bytes%n",
                        blob.getName(),
                        blob.getProperties().getContentLength());
            }

            blobClient.downloadToFile("data-downloaded.txt", true);
            blobClient.delete();
            containerClient.delete();
        } catch (BlobStorageException exception) {
            System.err.printf(
                    "Blob Storage request failed with status %d: %s%n",
                    exception.getStatusCode(),
                    exception.getMessage());
            throw exception;
        }
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(
                    "Set " + name + " before running.");
        }
        return value;
    }
}
