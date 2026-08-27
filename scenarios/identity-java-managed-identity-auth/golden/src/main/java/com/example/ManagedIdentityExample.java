package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.identity.AzureCliCredentialBuilder;
import com.azure.identity.ChainedTokenCredentialBuilder;
import com.azure.identity.CredentialUnavailableException;
import com.azure.identity.DefaultAzureCredential;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.identity.ManagedIdentityCredential;
import com.azure.identity.ManagedIdentityCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;

public final class ManagedIdentityExample {
    private ManagedIdentityExample() {
    }

    public static void main(String[] args) {
        String vaultUrl = System.getenv("AZURE_KEY_VAULT_URL");
        String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
        String clientId = System.getenv("AZURE_CLIENT_ID");
        requireValue(vaultUrl, "AZURE_KEY_VAULT_URL");
        requireValue(secretName, "AZURE_KEY_VAULT_SECRET_NAME");
        requireValue(clientId, "AZURE_CLIENT_ID");

        ManagedIdentityCredential systemAssignedCredential =
                new ManagedIdentityCredentialBuilder().build();
        ManagedIdentityCredential userAssignedCredential =
                new ManagedIdentityCredentialBuilder()
                        .clientId(clientId)
                        .build();

        DefaultAzureCredential defaultCredential =
                new DefaultAzureCredentialBuilder()
                        .managedIdentityClientId(clientId)
                        .build();

        TokenCredential localFallbackCredential =
                new ChainedTokenCredentialBuilder()
                        .addFirst(userAssignedCredential)
                        .addLast(new AzureCliCredentialBuilder().build())
                        .build();

        SecretClient secretClient = new SecretClientBuilder()
                .vaultUrl(vaultUrl)
                .credential(localFallbackCredential)
                .buildClient();

        try {
            KeyVaultSecret secret = secretClient.getSecret(secretName);
            System.out.println(secret.getValue());
        } catch (CredentialUnavailableException exception) {
            throw new IllegalStateException(
                    "Managed identity and local Azure CLI authentication were unavailable.",
                    exception);
        }

        // Keep all three standalone credential examples explicit for comparison.
        if (systemAssignedCredential == null || defaultCredential == null) {
            throw new IllegalStateException("Credential construction failed.");
        }
    }

    private static void requireValue(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
    }
}
