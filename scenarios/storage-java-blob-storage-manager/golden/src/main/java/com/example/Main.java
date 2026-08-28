package com.example;

import com.azure.core.http.policy.HttpLogDetailLevel;
import com.azure.storage.blob.models.ParallelTransferOptions;

import reactor.core.publisher.Mono;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) throws Exception {
        String accountUrl = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
        BlobStorageConfiguration configuration = new BlobStorageConfiguration(
                accountUrl,
                5,
                Duration.ofSeconds(30),
                Duration.ofSeconds(2),
                Duration.ofSeconds(12),
                HttpLogDetailLevel.BODY_AND_HEADERS);
        ParallelTransferOptions transferOptions = new ParallelTransferOptions()
                .setBlockSizeLong(4L * 1024 * 1024)
                .setMaxConcurrency(4)
                .setMaxSingleUploadSizeLong(8L * 1024 * 1024);
        Duration operationTimeout = Duration.ofMinutes(2);

        BlobStorageManager syncManager = new BlobStorageManager(
                configuration.createSyncClient(),
                transferOptions,
                operationTimeout);
        BlobStorageAsyncManager asyncManager = new BlobStorageAsyncManager(
                configuration.createAsyncClient(),
                transferOptions,
                operationTimeout);

        String containerName = "blob-manager-demo";
        String blobName = "uploads/blob-manager-demo.txt";
        Path uploadPath = Path.of("sample-upload.txt");
        Path syncDownloadPath = Path.of("sample-download-sync.txt");
        Path asyncDownloadPath = Path.of("sample-download-async.txt");
        Files.writeString(uploadPath, "Azure Blob Storage manager demo");

        Map<String, String> metadata = Map.of(
                "source", "azure-skill-evals",
                "mode", "demo");
        Map<String, String> indexTags = Map.of(
                "project", "azure-skill-evals",
                "scenario", "blob-manager");
        Map<String, String> overwriteMetadata = Map.of(
                "source", "azure-skill-evals",
                "mode", "overwrite");
        Map<String, String> overwriteTags = Map.of(
                "project", "azure-skill-evals",
                "operation", "overwrite");

        System.out.println("Running synchronous blob operations...");
        syncManager.ensureContainer(containerName);
        syncManager.uploadBlob(containerName, blobName, uploadPath, metadata, indexTags);
        syncManager.listBlobs(containerName);
        syncManager.downloadBlob(containerName, blobName, syncDownloadPath);
        syncManager.overwriteWithLease(
                containerName,
                blobName,
                uploadPath,
                overwriteMetadata,
                overwriteTags,
                "sync-demo-lease");
        syncManager.deleteBlob(containerName, blobName);
        syncManager.deleteContainer(containerName);

        System.out.println("Running asynchronous blob operations...");
        Mono<Void> createStep = asyncManager.ensureContainerAsync(containerName);
        Mono<Void> uploadStep = asyncManager.uploadBlobAsync(
                containerName,
                blobName,
                uploadPath,
                metadata,
                indexTags);
        Mono<Void> listStep = asyncManager.listBlobsAsync(containerName);
        Mono<Void> downloadStep = asyncManager.downloadBlobAsync(containerName, blobName, asyncDownloadPath);
        Mono<Void> overwriteStep = asyncManager.overwriteWithLeaseAsync(
                containerName,
                blobName,
                uploadPath,
                overwriteMetadata,
                overwriteTags,
                "async-demo-lease");
        Mono<Void> deleteBlobStep = asyncManager.deleteBlobAsync(containerName, blobName);
        Mono<Void> deleteContainerStep = asyncManager.deleteContainerAsync(containerName);

        createStep
                .then(uploadStep)
                .then(listStep)
                .then(downloadStep)
                .then(overwriteStep)
                .then(deleteBlobStep)
                .then(deleteContainerStep)
                .block();
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
