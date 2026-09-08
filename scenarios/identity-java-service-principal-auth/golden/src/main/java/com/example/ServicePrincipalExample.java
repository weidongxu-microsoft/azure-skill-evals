package com.example;

import com.azure.core.exception.ClientAuthenticationException;
import com.azure.identity.ClientSecretCredential;
import com.azure.identity.ClientSecretCredentialBuilder;
import com.azure.identity.CredentialUnavailableException;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;

public final class ServicePrincipalExample {
    private ServicePrincipalExample() {
    }

    public static void main(String[] args) {
        String tenantId = System.getenv("AZURE_TENANT_ID");
        String clientId = System.getenv("AZURE_CLIENT_ID");
        String clientSecret = System.getenv("AZURE_CLIENT_SECRET");
        String vaultUrl = System.getenv("AZURE_KEY_VAULT_URL");
        String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
        requireValue(tenantId, "AZURE_TENANT_ID");
        requireValue(clientId, "AZURE_CLIENT_ID");
        requireValue(clientSecret, "AZURE_CLIENT_SECRET");
        requireValue(vaultUrl, "AZURE_KEY_VAULT_URL");
        requireValue(secretName, "AZURE_KEY_VAULT_SECRET_NAME");
        printSecretManagementGuidance();

        ClientSecretCredential credential =
                new ClientSecretCredentialBuilder()
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
            System.out.println("Retrieved secret " + secret.getName());
        } catch (CredentialUnavailableException exception) {
            throw authenticationFailure(
                    "Service principal configuration is unavailable. Inject tenant ID, "
                            + "client ID, and client secret at runtime.",
                    exception);
        } catch (ClientAuthenticationException exception) {
            throw authenticationFailure(
                    "Azure rejected the service principal. Verify the tenant and client IDs, "
                            + "secret validity, and assigned Key Vault role.",
                    exception);
        }
    }

    private static void printSecretManagementGuidance() {
        System.out.println(
                "Inject AZURE_CLIENT_SECRET at runtime or retrieve it from a managed "
                        + "secret store; never commit or print it.");
        System.out.println(
                "Rotate the client secret regularly and grant the service principal "
                        + "only the least-privilege roles it needs.");
    }

    private static IllegalStateException authenticationFailure(
            String guidance, RuntimeException exception) {
        System.err.println(
                exception.getClass().getSimpleName() + ": " + exception.getMessage());
        return new IllegalStateException(guidance, exception);
    }

    private static void requireValue(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
    }
}
