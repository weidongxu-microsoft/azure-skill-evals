package com.example;

import com.azure.storage.blob.BlobAsyncClient;
import com.azure.storage.blob.BlobContainerAsyncClient;
import com.azure.storage.blob.BlobServiceAsyncClient;
import com.azure.storage.blob.models.BlobRequestConditions;
import com.azure.storage.blob.models.BlobStorageException;
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
        return reportFailures(
                "create container",
                Mono.defer(() -> {
                    System.out.printf("Ensuring container %s asynchronously%n", containerName);
                    return asyncContainerClient(containerName).createIfNotExists().then();
                }));
    }

    public Mono<Void> uploadBlobAsync(
            String containerName,
            String blobName,
            Path filePath,
            Map<String, String> metadata,
            Map<String, String> indexTags) {
        return reportFailures(
                "upload blob",
                Mono.defer(() -> {
                    System.out.printf("Uploading %s asynchronously%n", blobName);
                    return asyncBlobClient(containerName, blobName)
                            .uploadFromFileWithResponse(
                                    asyncUploadOptions(filePath, metadata, indexTags))
                            .timeout(asyncOperationTimeout)
                            .then();
                }));
    }

    public Mono<Void> listBlobsAsync(String containerName) {
        return reportFailures(
                "list blobs",
                Mono.defer(() -> {
                    System.out.printf("Listing blobs in %s asynchronously%n", containerName);
                    return asyncContainerClient(containerName)
                            .listBlobs()
                            .doOnNext(item -> System.out.printf(
                                    "Blob %s has size %d bytes%n",
                                    item.getName(),
                                    item.getProperties().getContentLength()))
                            .then();
                }));
    }

    public Mono<Void> downloadBlobAsync(String containerName, String blobName, Path destination) {
        BlobDownloadToFileOptions options = new BlobDownloadToFileOptions(destination.toString());
        return reportFailures(
                "download blob",
                Mono.defer(() -> {
                    System.out.printf("Downloading %s asynchronously%n", blobName);
                    return asyncBlobClient(containerName, blobName)
                            .downloadToFileWithResponse(options)
                            .timeout(asyncOperationTimeout)
                            .then();
                }));
    }

    public Mono<Void> overwriteWithLeaseAsync(
            String containerName,
            String blobName,
            Path filePath,
            Map<String, String> metadata,
            Map<String, String> indexTags,
            String leaseId) {
        BlobAsyncClient blobClient = asyncBlobClient(containerName, blobName);
        BlobLeaseAsyncClient leaseClient = new BlobLeaseClientBuilder()
                .blobAsyncClient(blobClient)
                .leaseId(leaseId)
                .buildAsyncClient();
        return reportFailures(
                "lease-protected overwrite",
                Mono.defer(() -> {
                    System.out.printf(
                            "Overwriting %s with a lease asynchronously%n",
                            blobName);
                    return Mono.usingWhen(
                            leaseClient.acquireLease(-1),
                            acquiredLeaseId -> {
                                BlobUploadFromFileOptions overwriteOptions =
                                        new BlobUploadFromFileOptions(filePath.toString())
                                                .setMetadata(metadata)
                                                .setTags(indexTags)
                                                .setParallelTransferOptions(asyncTransferOptions)
                                                .setRequestConditions(
                                                        new BlobRequestConditions()
                                                                .setLeaseId(acquiredLeaseId));
                                return blobClient
                                        .uploadFromFileWithResponse(overwriteOptions)
                                        .timeout(asyncOperationTimeout)
                                        .then();
                            },
                            ignored -> leaseClient.releaseLease(),
                            (ignored, error) -> leaseClient.releaseLease(),
                            ignored -> leaseClient.releaseLease());
                }));
    }

    public Mono<Void> deleteBlobAsync(String containerName, String blobName) {
        return reportFailures(
                "delete blob",
                Mono.defer(() -> {
                    System.out.printf("Deleting %s asynchronously%n", blobName);
                    return asyncBlobClient(containerName, blobName)
                            .deleteIfExists()
                            .flatMap(deleted -> deleted
                                    ? Mono.<Void>empty()
                                    : Mono.<Void>error(new IllegalStateException(
                                            "Blob did not exist: " + blobName)));
                }));
    }

    public Mono<Void> deleteContainerAsync(String containerName) {
        return reportFailures(
                "delete container",
                Mono.defer(() -> {
                    System.out.printf("Deleting container %s asynchronously%n", containerName);
                    return asyncContainerClient(containerName)
                            .deleteIfExists()
                            .flatMap(deleted -> deleted
                                    ? Mono.<Void>empty()
                                    : Mono.<Void>error(new IllegalStateException(
                                            "Container did not exist: " + containerName)));
                }));
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

    private static Mono<Void> reportFailures(String operation, Mono<Void> action) {
        return action.doOnError(BlobStorageException.class, exception ->
                System.err.printf(
                        "Blob Storage %s failed: status=%d, code=%s, message=%s%n",
                        operation,
                        exception.getStatusCode(),
                        exception.getErrorCode(),
                        exception.getMessage()));
    }
}
