package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.identity.ManagedIdentityCredentialBuilder;
import com.azure.security.keyvault.keys.cryptography.CryptographyAsyncClient;
import com.azure.security.keyvault.keys.cryptography.CryptographyClient;
import com.azure.security.keyvault.keys.cryptography.CryptographyClientBuilder;
import com.azure.security.keyvault.keys.KeyAsyncClient;
import com.azure.security.keyvault.keys.KeyClient;
import com.azure.security.keyvault.keys.KeyClientBuilder;
import com.azure.storage.blob.BlobServiceAsyncClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.BlobServiceClientBuilder;

public final class AzureClients {
    private final TokenCredential managedIdentityCredential;
    private final String storageEndpoint;
    private final String vaultEndpoint;

    public AzureClients(String storageEndpoint, String vaultEndpoint) {
        this.storageEndpoint = storageEndpoint;
        this.vaultEndpoint = vaultEndpoint;
        this.managedIdentityCredential =
                new ManagedIdentityCredentialBuilder().build();
    }

    public static AzureClients fromEnvironment() {
        return new AzureClients(
                requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
                requireEnvironment("AZURE_KEY_VAULT_URL"));
    }

    public BlobServiceClient blobServiceClient() {
        return new BlobServiceClientBuilder()
                .endpoint(storageEndpoint)
                .credential(managedIdentityCredential)
                .buildClient();
    }

    public BlobServiceAsyncClient blobServiceAsyncClient() {
        return new BlobServiceClientBuilder()
                .endpoint(storageEndpoint)
                .credential(managedIdentityCredential)
                .buildAsyncClient();
    }

    public KeyClient keyClient() {
        return new KeyClientBuilder()
                .vaultUrl(vaultEndpoint)
                .credential(managedIdentityCredential)
                .buildClient();
    }

    public KeyAsyncClient keyAsyncClient() {
        return new KeyClientBuilder()
                .vaultUrl(vaultEndpoint)
                .credential(managedIdentityCredential)
                .buildAsyncClient();
    }

    public CryptographyClient cryptographyClient(String keyId) {
        return new CryptographyClientBuilder()
                .keyIdentifier(keyId)
                .credential(managedIdentityCredential)
                .buildClient();
    }

    public CryptographyAsyncClient cryptographyAsyncClient(String keyId) {
        return new CryptographyClientBuilder()
                .keyIdentifier(keyId)
                .credential(managedIdentityCredential)
                .buildAsyncClient();
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
