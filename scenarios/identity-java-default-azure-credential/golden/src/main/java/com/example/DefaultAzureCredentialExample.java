package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.core.exception.ClientAuthenticationException;
import com.azure.identity.CredentialUnavailableException;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;

public final class DefaultAzureCredentialExample {
    private DefaultAzureCredentialExample() {
    }

    public static void main(String[] args) {
        System.setProperty(
                "org.slf4j.simpleLogger.log.com.azure.identity",
                "debug");

        String vaultUrl = requireEnvironment("KEY_VAULT_URL");
        String secretName = requireEnvironment("KEY_VAULT_SECRET_NAME");

        TokenCredential credential =
                new DefaultAzureCredentialBuilder().build();
        SecretClient secretClient = new SecretClientBuilder()
                .vaultUrl(vaultUrl)
                .credential(credential)
                .buildClient();

        try {
            KeyVaultSecret secret = secretClient.getSecret(secretName);
            System.out.println(secret.getValue());
        } catch (CredentialUnavailableException exception) {
            System.err.println(
                    "No credential source was available: " + exception.getMessage());
        } catch (ClientAuthenticationException exception) {
            System.err.println(
                    "Azure authentication failed: " + exception.getMessage());
        }
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
