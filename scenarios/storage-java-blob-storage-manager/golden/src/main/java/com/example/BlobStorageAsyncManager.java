package com.example;

import com.azure.storage.blob.BlobAsyncClient;
import com.azure.storage.blob.BlobContainerAsyncClient;
import com.azure.storage.blob.BlobServiceAsyncClient;
import com.azure.storage.blob.models.BlobRequestConditions;
import com.azure.storage.blob.models.ParallelTransferOptions;
import com.azure.storage.blob.options.BlobDownloadToFileOptions;
import com.azure.storage.blob.options.BlobUploadFromFileOptions;
import com.azure.storage.blob.specialized.BlobLeaseAsyncClient;
import com.azure.storage.blob.specialized.BlobLeaseClientBuilder;

import reactor.core.publisher.Mono;

import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

public final class BlobStorageAsyncManager {
    private final BlobServiceAsyncClient asyncServiceClient;
    private final ParallelTransferOptions asyncTransferOptions;
    private final Duration asyncOperationTimeout;

    public BlobStorageAsyncManager(
            BlobServiceAsyncClient serviceClient,
            ParallelTransferOptions transferOptions,
            Duration operationTimeout) {
        this.asyncServiceClient = serviceClient;
        this.asyncTransferOptions = transferOptions;
        this.asyncOperationTimeout = operationTimeout;
    }

    public Mono<Void> ensureContainerAsync(String containerName) {
        System.out.printf("Ensuring container %s asynchronously%n", containerName);
        return asyncContainerClient(containerName).createIfNotExists().then();
    }

    public Mono<Void> uploadBlobAsync(
            String containerName,
            String blobName,
            Path filePath,
            Map<String, String> metadata,
            Map<String, String> indexTags) {
        System.out.printf("Uploading %s asynchronously%n", blobName);
        return asyncBlobClient(containerName, blobName)
                .uploadFromFileWithResponse(asyncUploadOptions(filePath, metadata, indexTags))
                .timeout(asyncOperationTimeout)
                .then();
    }

    public Mono<Void> listBlobsAsync(String containerName) {
        System.out.printf("Listing blobs in %s asynchronously%n", containerName);
        return asyncContainerClient(containerName)
                .listBlobs()
                .doOnNext(item -> System.out.printf(
                        "Blob %s has size %d bytes%n",
                        item.getName(),
                        item.getProperties().getContentLength()))
                .then();
    }

    public Mono<Void> downloadBlobAsync(String containerName, String blobName, Path destination) {
        System.out.printf("Downloading %s asynchronously%n", blobName);
        BlobDownloadToFileOptions options = new BlobDownloadToFileOptions(destination.toString());
        return asyncBlobClient(containerName, blobName)
                .downloadToFileWithResponse(options)
                .timeout(asyncOperationTimeout)
                .then();
    }

    public Mono<Void> overwriteWithLeaseAsync(
            String containerName,
            String blobName,
            Path filePath,
            Map<String, String> metadata,
            Map<String, String> indexTags,
            String leaseId) {
        System.out.printf("Overwriting %s with a lease asynchronously%n", blobName);
        BlobAsyncClient blobClient = asyncBlobClient(containerName, blobName);
        BlobLeaseAsyncClient leaseClient = new BlobLeaseClientBuilder()
                .blobAsyncClient(blobClient)
                .leaseId(leaseId)
                .buildAsyncClient();
        BlobUploadFromFileOptions overwriteOptions = new BlobUploadFromFileOptions(filePath.toString())
                .setMetadata(metadata)
                .setTags(indexTags)
                .setParallelTransferOptions(asyncTransferOptions)
                .setRequestConditions(new BlobRequestConditions().setLeaseId(leaseId));
        Mono<String> acquireStep = leaseClient.acquireLease(30);
        Mono<Void> overwriteStep = blobClient
                .uploadFromFileWithResponse(overwriteOptions)
                .timeout(asyncOperationTimeout)
                .then();
        return acquireStep
                .then(overwriteStep)
                .then(leaseClient.releaseLease());
    }

    public Mono<Void> deleteBlobAsync(String containerName, String blobName) {
        System.out.printf("Deleting %s asynchronously%n", blobName);
        return asyncBlobClient(containerName, blobName).deleteIfExists().then();
    }

    public Mono<Void> deleteContainerAsync(String containerName) {
        System.out.printf("Deleting container %s asynchronously%n", containerName);
        return asyncContainerClient(containerName).deleteIfExists().then();
    }

    private BlobUploadFromFileOptions asyncUploadOptions(
            Path filePath,
            Map<String, String> metadata,
            Map<String, String> indexTags) {
        return new BlobUploadFromFileOptions(filePath.toString())
                .setMetadata(metadata)
                .setTags(indexTags)
                .setParallelTransferOptions(asyncTransferOptions);
    }

    private BlobContainerAsyncClient asyncContainerClient(String containerName) {
        return asyncServiceClient.getBlobContainerAsyncClient(containerName);
    }

    private BlobAsyncClient asyncBlobClient(String containerName, String blobName) {
        return asyncContainerClient(containerName).getBlobAsyncClient(blobName);
    }
}
