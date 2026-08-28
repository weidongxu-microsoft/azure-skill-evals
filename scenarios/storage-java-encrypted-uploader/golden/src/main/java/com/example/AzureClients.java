package com.example;

import com.azure.identity.DefaultAzureCredential;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.security.keyvault.keys.cryptography.CryptographyAsyncClient;
import com.azure.security.keyvault.keys.cryptography.CryptographyClient;
import com.azure.security.keyvault.keys.cryptography.CryptographyClientBuilder;
import com.azure.security.keyvault.keys.KeyClient;
import com.azure.security.keyvault.keys.KeyClientBuilder;
import com.azure.storage.blob.BlobServiceAsyncClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.BlobServiceClientBuilder;

public final class AzureClients {
    private final DefaultAzureCredential credential;
    private final String storageEndpoint;
    private final String vaultEndpoint;

    public AzureClients(String storageEndpoint, String vaultEndpoint) {
        this.storageEndpoint = storageEndpoint;
        this.vaultEndpoint = vaultEndpoint;
        this.credential = new DefaultAzureCredentialBuilder().build();
    }

    public BlobServiceClient blobServiceClient() {
        return new BlobServiceClientBuilder().endpoint(storageEndpoint).credential(credential).buildClient();
    }

    public BlobServiceAsyncClient blobServiceAsyncClient() {
        return new BlobServiceClientBuilder().endpoint(storageEndpoint).credential(credential).buildAsyncClient();
    }

    public KeyClient keyClient() {
        return new KeyClientBuilder().vaultUrl(vaultEndpoint).credential(credential).buildClient();
    }

    public CryptographyClient cryptographyClient(String keyId) {
        return new CryptographyClientBuilder().keyIdentifier(keyId).credential(credential).buildClient();
    }

    public CryptographyAsyncClient cryptographyAsyncClient(String keyId) {
        return new CryptographyClientBuilder().keyIdentifier(keyId).credential(credential).buildAsyncClient();
    }
}
