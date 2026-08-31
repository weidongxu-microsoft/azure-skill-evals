package com.example;

import com.azure.core.exception.ClientAuthenticationException;
import com.azure.identity.ClientSecretCredential;
import com.azure.identity.ClientSecretCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;

public final class KeyVaultSecretReader {
    private KeyVaultSecretReader() {
    }

    public static void main(String[] args) {
        String tenantId = requireEnvironmentVariable("AZURE_TENANT_ID");
        String clientId = requireEnvironmentVariable("AZURE_CLIENT_ID");
        String clientSecret = requireEnvironmentVariable("AZURE_CLIENT_SECRET");
        String vaultUrl = requireEnvironmentVariable("AZURE_KEY_VAULT_URL");
        String secretName = requireEnvironmentVariable("AZURE_KEY_VAULT_SECRET_NAME");

        ClientSecretCredential credential = new ClientSecretCredentialBuilder()
                .tenantId(tenantId)
                .clientId(clientId)
                .clientSecret(clientSecret)
                .build();

        SecretClient secretClient = new SecretClientBuilder()
                .vaultUrl(vaultUrl)
                .credential(credential)
                .buildClient();

        try {
            KeyVaultSecret secret = secretClient.getSecret(secretName);
            System.out.println(secret.getValue());
        } catch (ClientAuthenticationException exception) {
            System.err.println(
                    "Azure Key Vault authentication failed. Verify the configured service principal credentials.");
            System.exit(1);
        }
    }

    private static String requireEnvironmentVariable(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Required environment variable is missing or blank: " + name);
        }
        return value;
    }
}
