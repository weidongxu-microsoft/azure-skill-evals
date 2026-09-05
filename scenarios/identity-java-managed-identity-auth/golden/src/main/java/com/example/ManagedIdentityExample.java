package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.core.exception.ClientAuthenticationException;
import com.azure.identity.AzureCliCredentialBuilder;
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

        ManagedIdentityCredential systemAssignedCredential =
                new ManagedIdentityCredentialBuilder().build();
        ManagedIdentityCredential userAssignedCredential = clientId == null
                || clientId.isBlank()
                ? null
                : new ManagedIdentityCredentialBuilder().clientId(clientId).build();

        DefaultAzureCredentialBuilder defaultCredentialBuilder =
                new DefaultAzureCredentialBuilder();
        if (userAssignedCredential != null) {
            defaultCredentialBuilder.managedIdentityClientId(clientId);
        }
        DefaultAzureCredential defaultCredential = defaultCredentialBuilder.build();

        boolean localDevelopment =
                Boolean.parseBoolean(System.getenv("AZURE_LOCAL_DEVELOPMENT"));
        TokenCredential selectedCredential;
        if (localDevelopment) {
            selectedCredential = new AzureCliCredentialBuilder().build();
            System.out.println(
                    "Local development selected Azure CLI authentication because managed "
                            + "identity is available only on an Azure host.");
        } else if (userAssignedCredential != null) {
            selectedCredential = userAssignedCredential;
            System.out.println("Azure host selected user-assigned managed identity.");
        } else {
            selectedCredential = systemAssignedCredential;
            System.out.println("Azure host selected system-assigned managed identity.");
        }

        SecretClient secretClient = new SecretClientBuilder()
                .vaultUrl(vaultUrl)
                .credential(selectedCredential)
                .buildClient();

        try {
            KeyVaultSecret secret = secretClient.getSecret(secretName);
            System.out.println("Retrieved secret " + secret.getName());
        } catch (CredentialUnavailableException exception) {
            reportAuthenticationFailure(
                    "The selected credential is unavailable. On Azure, enable and authorize "
                            + "managed identity; locally, run 'az login'.",
                    exception);
        } catch (ClientAuthenticationException exception) {
            reportAuthenticationFailure(
                    "Azure rejected the selected identity. Verify its tenant, identifier, "
                            + "role assignment, and Key Vault access.",
                    exception);
        }

        // DefaultAzureCredential is another practical single-code-path fallback:
        // developer credentials locally and managed identity when hosted in Azure.
        if (systemAssignedCredential == null || defaultCredential == null) {
            throw new IllegalStateException("Credential construction failed.");
        }
    }

    private static void requireValue(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
    }

    private static void reportAuthenticationFailure(
            String guidance, RuntimeException exception) {
        System.err.println(guidance);
        System.err.println(
                exception.getClass().getSimpleName() + ": " + exception.getMessage());
        if (exception.getCause() != null) {
            System.err.println(
                    "Cause: " + exception.getCause().getClass().getSimpleName()
                            + ": " + exception.getCause().getMessage());
        }
    }
}
