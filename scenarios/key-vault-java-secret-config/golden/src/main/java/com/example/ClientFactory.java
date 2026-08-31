package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretAsyncClient;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;

public final class ClientFactory {
    private ClientFactory() {
    }

    public static Clients loadConfiguration() {
        String vaultUrl = requireEnvironment("AZURE_KEY_VAULT_URL");
        TokenCredential credential =
                new DefaultAzureCredentialBuilder().build();
        SecretClientBuilder builder = new SecretClientBuilder()
                .vaultUrl(vaultUrl)
                .credential(credential);
        return new Clients(
                builder.buildClient(),
                builder.buildAsyncClient());
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }

    public record Clients(
            SecretClient syncClient,
            SecretAsyncClient asyncClient) {
    }
}
