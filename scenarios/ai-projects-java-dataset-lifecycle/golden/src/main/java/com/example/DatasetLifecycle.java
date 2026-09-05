package com.example;

import com.azure.ai.projects.AIProjectClientBuilder;
import com.azure.ai.projects.DatasetsClient;
import com.azure.ai.projects.models.BlobReference;
import com.azure.ai.projects.models.BlobReferenceSasCredential;
import com.azure.ai.projects.models.DatasetCredential;
import com.azure.ai.projects.models.DatasetVersion;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobClientBuilder;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

public final class DatasetLifecycle {
    private DatasetLifecycle() {
    }

    public static void main(String[] args)
        throws IOException {
        String endpoint = requireEnvironmentVariable("FOUNDRY_PROJECT_ENDPOINT");
        String datasetName = requireEnvironmentVariable("DATASET_NAME");
        String datasetVersion = requireEnvironmentVariable("DATASET_VERSION");
        Path inputPath = Path.of(requireEnvironmentVariable("DATA_FILE_PATH"));
        Path downloadPath = Path.of(requireEnvironmentVariable("DOWNLOAD_FILE_PATH"));
        byte[] expectedBytes = Files.readAllBytes(inputPath);

        DatasetsClient datasets = new AIProjectClientBuilder()
            .endpoint(endpoint)
            .credential(new DefaultAzureCredentialBuilder().build())
            .buildDatasetsClient();
        boolean uploaded = false;

        try {
            DatasetVersion uploadedDataset =
                datasets.createDatasetWithFile(datasetName, datasetVersion, inputPath);
            uploaded = true;
            System.out.printf(
                "Uploaded dataset: name=%s version=%s%n",
                uploadedDataset.getName(),
                uploadedDataset.getVersion());

            DatasetVersion returnedDatasetVersion =
                datasets.getDatasetVersion(datasetName, datasetVersion);
            if (!datasetName.equals(returnedDatasetVersion.getName())
                || !datasetVersion.equals(returnedDatasetVersion.getVersion())) {
                throw new IllegalStateException(
                    "The service returned a different dataset version.");
            }
            printSdkReturnedDatasetMetadata(returnedDatasetVersion);

            DatasetCredential datasetCredential =
                datasets.getCredentials(datasetName, datasetVersion);
            downloadWithReturnedBlobCredential(datasetCredential, downloadPath);

            byte[] downloadedBytes = Files.readAllBytes(downloadPath);
            if (!Arrays.equals(expectedBytes, downloadedBytes)) {
                throw new IllegalStateException(
                    "Downloaded bytes don't match the source file.");
            }
            System.out.println(
                "Downloaded bytes verified: " + downloadedBytes.length);
        } finally {
            if (uploaded) {
                datasets.deleteDatasetVersion(datasetName, datasetVersion);
            }
        }
    }

    private static void printSdkReturnedDatasetMetadata(
        DatasetVersion datasetVersion) {
        System.out.printf(
            "SDK-returned dataset: name=%s version=%s id=%s type=%s dataUrl=%s%n",
            datasetVersion.getName(),
            datasetVersion.getVersion(),
            datasetVersion.getId(),
            datasetVersion.getType(),
            datasetVersion.getDataUrl());
    }

    private static void downloadWithReturnedBlobCredential(
        DatasetCredential datasetCredential,
        Path downloadPath) throws IOException {
        BlobReference blobReference = datasetCredential.getBlobReference();
        if (blobReference == null || blobReference.getBlobUrl() == null) {
            throw new IllegalStateException(
                "The dataset credential did not contain a blob reference.");
        }

        BlobReferenceSasCredential sasCredential = blobReference.getCredential();
        if (sasCredential == null || sasCredential.getSasUrl() == null) {
            throw new IllegalStateException(
                "The dataset blob reference did not contain a SAS credential.");
        }

        String sasUrl = sasCredential.getSasUrl();
        if (!sasUrl.contains("?") || sasUrl.endsWith("?")) {
            throw new IllegalStateException(
                "The returned dataset SAS URL did not contain a SAS token.");
        }
        URI blobUri = URI.create(blobReference.getBlobUrl());
        URI sasUri = URI.create(sasUrl);
        if (!blobUri.getPath().equals(sasUri.getPath())) {
            throw new IllegalStateException(
                "The returned SAS credential targets a different blob.");
        }

        Path parent = downloadPath.toAbsolutePath().getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        BlobClient blobClient = new BlobClientBuilder()
            .endpoint(sasUrl)
            .buildClient();
        blobClient.downloadToFile(downloadPath.toString(), true);
    }

    private static String requireEnvironmentVariable(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required.");
        }
        return value;
    }
}
