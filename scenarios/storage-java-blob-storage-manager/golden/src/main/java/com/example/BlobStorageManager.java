package com.example;

import com.azure.core.util.Context;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobContainerClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.models.BlobItem;
import com.azure.storage.blob.models.BlobRequestConditions;
import com.azure.storage.blob.models.ParallelTransferOptions;
import com.azure.storage.blob.options.BlobUploadFromFileOptions;
import com.azure.storage.blob.specialized.BlobLeaseClient;
import com.azure.storage.blob.specialized.BlobLeaseClientBuilder;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

public final class BlobStorageManager {
    private final BlobServiceClient syncServiceClient;
    private final ParallelTransferOptions syncTransferOptions;
    private final Duration syncOperationTimeout;

    public BlobStorageManager(
            BlobServiceClient serviceClient,
            ParallelTransferOptions transferOptions,
            Duration operationTimeout) {
        this.syncServiceClient = serviceClient;
        this.syncTransferOptions = transferOptions;
        this.syncOperationTimeout = operationTimeout;
    }

    public void ensureContainer(String containerName) {
        BlobContainerClient containerClient = syncContainerClient(containerName);
        containerClient.createIfNotExists();
        System.out.printf("Ensured container %s%n", containerName);
    }

    public void uploadBlob(
            String containerName,
            String blobName,
            Path filePath,
            Map<String, String> metadata,
            Map<String, String> indexTags) {
        BlobClient blobClient = syncBlobClient(containerName, blobName);
        blobClient.uploadFromFileWithResponse(
                syncUploadOptions(filePath, metadata, indexTags),
                syncOperationTimeout,
                Context.NONE);
        System.out.printf("Uploaded %s to %s%n", filePath, blobName);
    }

    public void listBlobs(String containerName) {
        Iterable<BlobItem> blobs = syncContainerClient(containerName).listBlobs();
        for (BlobItem item : blobs) {
            System.out.printf(
                    "Blob %s has size %d bytes%n",
                    item.getName(),
                    item.getProperties().getContentLength());
        }
    }

    public void downloadBlob(String containerName, String blobName, Path destination) {
        syncBlobClient(containerName, blobName).downloadToFile(destination.toString(), true);
        System.out.printf("Downloaded %s to %s%n", blobName, destination);
    }

    public void overwriteWithLease(
            String containerName,
            String blobName,
            Path filePath,
            Map<String, String> metadata,
            Map<String, String> indexTags,
            String leaseId) {
        BlobClient blobClient = syncBlobClient(containerName, blobName);
        BlobLeaseClient leaseClient = new BlobLeaseClientBuilder()
                .blobClient(blobClient)
                .leaseId(leaseId)
                .buildClient();
        String acquiredLeaseId = leaseClient.acquireLease(30);
        try {
            BlobUploadFromFileOptions overwriteOptions = new BlobUploadFromFileOptions(filePath.toString())
                    .setMetadata(metadata)
                    .setTags(indexTags)
                    .setParallelTransferOptions(syncTransferOptions)
                    .setRequestConditions(new BlobRequestConditions().setLeaseId(leaseId));
            blobClient.uploadFromFileWithResponse(overwriteOptions, syncOperationTimeout, Context.NONE);
            System.out.printf("Overwrote %s while holding a lease%n", blobName);
        } finally {
            leaseClient.releaseLease();
        }
    }

    public void deleteBlob(String containerName, String blobName) {
        syncBlobClient(containerName, blobName).deleteIfExists();
        System.out.printf("Deleted blob %s%n", blobName);
    }

    public void deleteContainer(String containerName) {
        syncContainerClient(containerName).deleteIfExists();
        System.out.printf("Deleted container %s%n", containerName);
    }

    private BlobUploadFromFileOptions syncUploadOptions(
            Path filePath,
            Map<String, String> metadata,
            Map<String, String> indexTags) {
        return new BlobUploadFromFileOptions(filePath.toString())
                .setMetadata(metadata)
                .setTags(indexTags)
                .setParallelTransferOptions(syncTransferOptions);
    }

    private BlobContainerClient syncContainerClient(String containerName) {
        return syncServiceClient.getBlobContainerClient(containerName);
    }

    private BlobClient syncBlobClient(String containerName, String blobName) {
        return syncContainerClient(containerName).getBlobClient(blobName);
    }
}
