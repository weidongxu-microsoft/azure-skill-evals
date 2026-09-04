package com.contoso.support;

import com.azure.core.credential.TokenCredential;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.identity.ManagedIdentityCredentialBuilder;
import com.azure.storage.blob.BlobContainerClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.BlobServiceClientBuilder;
import com.contoso.support.StateStore.BlobStateStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.InetSocketAddress;
import java.util.concurrent.CountDownLatch;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) throws Exception {
        SupportConfig config = SupportConfig.load();
        TokenCredential credential =
            "prod".equals(System.getenv("AZURE_TOKEN_CREDENTIALS"))
                ? new ManagedIdentityCredentialBuilder().build()
                : new DefaultAzureCredentialBuilder().build();
        BlobServiceClient blobService = new BlobServiceClientBuilder()
            .endpoint(config.storageAccountEndpoint().toString())
            .credential(credential)
            .buildClient();
        BlobContainerClient container = blobService.getBlobContainerClient(
            config.stateContainer());
        ObjectMapper mapper = new ObjectMapper();
        BlobStateStore stateStore = new BlobStateStore(
            container, config.stateBlob(), mapper);
        stateStore.initialize();

        try (FoundryRestGateway gateway = new FoundryRestGateway(
                config.projectEndpoint(),
                credential,
                config.modelDeploymentName(),
                config.evaluationModelDeploymentName(),
                config.tokenScope(),
                mapper);
             SupportHttpServer server = new SupportHttpServer(
                new InetSocketAddress("0.0.0.0", config.port()),
                new SupportAssistantService(gateway, stateStore, mapper),
                new SupportHttpServer.Options(
                    true,
                    config.adminPrincipalIds(),
                    config.materials(),
                    config.evaluationDataset()),
                mapper)) {
            server.start();
            System.out.println(
                "Contoso support API listening on port " + config.port());
            new CountDownLatch(1).await();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }
}
