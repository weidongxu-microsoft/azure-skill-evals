package com.example;

import com.azure.core.exception.HttpResponseException;
import com.azure.core.util.polling.SyncPoller;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.DeletedSecret;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;

public final class KeyVaultSecretCrud {
    private static final String SECRET_NAME = "my-secret";

    private KeyVaultSecretCrud() {
    }

    public static void main(String[] args) {
        String vaultUrl = requireEnvironment("KEY_VAULT_URL");
        SecretClient secretClient = new SecretClientBuilder()
                .vaultUrl(vaultUrl)
                .credential(new DefaultAzureCredentialBuilder().build())
                .buildClient();

        try {
            secretClient.setSecret(SECRET_NAME, "my-secret-value");

            KeyVaultSecret retrievedSecret = secretClient.getSecret(SECRET_NAME);
            System.out.println(retrievedSecret.getValue());

            secretClient.setSecret(
                    new KeyVaultSecret(SECRET_NAME, "updated-value"));

            SyncPoller<DeletedSecret, Void> deletePoller =
                    secretClient.beginDeleteSecret(SECRET_NAME);
            deletePoller.waitForCompletion();
            secretClient.purgeDeletedSecret(SECRET_NAME);
        } catch (HttpResponseException exception) {
            System.err.println(
                    "Key Vault request failed: " + exception.getMessage());
            throw exception;
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
