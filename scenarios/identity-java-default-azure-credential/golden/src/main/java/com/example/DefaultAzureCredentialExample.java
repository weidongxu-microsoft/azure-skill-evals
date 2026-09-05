package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.core.exception.ClientAuthenticationException;
import com.azure.identity.CredentialUnavailableException;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;
import java.util.List;

public final class DefaultAzureCredentialExample {
    private static final List<CredentialStage> DEFAULT_CREDENTIAL_CHAIN = List.of(
            new CredentialStage("EnvironmentCredential", CredentialKind.DEPLOYED),
            new CredentialStage("WorkloadIdentityCredential", CredentialKind.DEPLOYED),
            new CredentialStage("ManagedIdentityCredential", CredentialKind.DEPLOYED),
            new CredentialStage("IntelliJCredential", CredentialKind.DEVELOPER),
            new CredentialStage("VisualStudioCodeCredential", CredentialKind.DEVELOPER),
            new CredentialStage("AzureCliCredential", CredentialKind.DEVELOPER),
            new CredentialStage("AzurePowerShellCredential", CredentialKind.DEVELOPER),
            new CredentialStage("AzureDeveloperCliCredential", CredentialKind.DEVELOPER),
            new CredentialStage(
                    "broker-enabled InteractiveBrowserCredential (when enabled)",
                    CredentialKind.DEVELOPER));

    private DefaultAzureCredentialExample() {
    }

    public static void main(String[] args) {
        configureIdentityDiagnostics();

        String vaultUrl = requireEnvironment("KEY_VAULT_URL");
        String secretName = requireEnvironment("KEY_VAULT_SECRET_NAME");

        explainCredentialSelection();
        TokenCredential credential =
                new DefaultAzureCredentialBuilder().build();
        SecretClient secretClient = new SecretClientBuilder()
                .vaultUrl(vaultUrl)
                .credential(credential)
                .buildClient();

        try {
            KeyVaultSecret secret = secretClient.getSecret(secretName);
            System.out.println("Retrieved secret " + secret.getName());
        } catch (CredentialUnavailableException exception) {
            throw reportAuthenticationFailure(
                    "No credential source was available. Sign in with a supported "
                            + "developer tool locally, or configure workload or managed "
                            + "identity on the Azure host.",
                    exception);
        } catch (ClientAuthenticationException exception) {
            throw reportAuthenticationFailure(
                    "Azure rejected the credential. Check the selected identity's tenant, "
                            + "role assignment, token audience, and credential validity.",
                    exception);
        }
    }

    private static void configureIdentityDiagnostics() {
        System.setProperty(
                "org.slf4j.simpleLogger.log.com.azure.identity",
                "debug");
        System.setProperty("org.slf4j.simpleLogger.showDateTime", "true");
        System.err.println(
                "Azure Identity DEBUG logging is enabled. Unsafe support logging and "
                        + "HTTP body logging remain disabled to protect tokens and secrets.");
    }

    private static void explainCredentialSelection() {
        System.out.println(
                "DefaultAzureCredential 1.18.5 uses this ordered chain:");
        for (int index = 0; index < DEFAULT_CREDENTIAL_CHAIN.size(); index++) {
            CredentialStage stage = DEFAULT_CREDENTIAL_CHAIN.get(index);
            System.out.printf(
                    "%d. %s: success -> %s; unavailable -> %s; authentication failure -> %s%n",
                    index + 1,
                    stage.name(),
                    stage.actionFor(AttemptOutcome.TOKEN_ACQUIRED),
                    stage.actionFor(AttemptOutcome.CREDENTIAL_UNAVAILABLE),
                    stage.actionFor(AttemptOutcome.AUTHENTICATION_FAILED));
        }
        System.out.println(
                "Local development normally reaches an authenticated IDE, Azure CLI, "
                        + "Azure PowerShell, Azure Developer CLI, or broker credential.");
        System.out.println(
                "In Azure, workload identity or managed identity is selected before "
                        + "developer-tool credentials when it is configured and available.");
    }

    private record CredentialStage(String name, CredentialKind kind) {
        SelectionAction actionFor(AttemptOutcome outcome) {
            return switch (outcome) {
                case TOKEN_ACQUIRED -> SelectionAction.STOP_AND_USE_TOKEN;
                case CREDENTIAL_UNAVAILABLE -> SelectionAction.TRY_NEXT;
                case AUTHENTICATION_FAILED -> kind == CredentialKind.DEVELOPER
                        ? SelectionAction.TRY_NEXT
                        : SelectionAction.STOP_AND_SURFACE_FAILURE;
            };
        }
    }

    private enum CredentialKind {
        DEPLOYED,
        DEVELOPER
    }

    private enum AttemptOutcome {
        TOKEN_ACQUIRED,
        CREDENTIAL_UNAVAILABLE,
        AUTHENTICATION_FAILED
    }

    private enum SelectionAction {
        STOP_AND_USE_TOKEN,
        TRY_NEXT,
        STOP_AND_SURFACE_FAILURE
    }

    private static IllegalStateException reportAuthenticationFailure(
            String guidance, RuntimeException exception) {
        System.err.println(guidance);
        System.err.printf(
                "%s: %s%n",
                exception.getClass().getSimpleName(),
                exception.getMessage());
        Throwable cause = exception.getCause();
        while (cause != null) {
            System.err.printf(
                    "Caused by %s: %s%n",
                    cause.getClass().getSimpleName(),
                    cause.getMessage());
            cause = cause.getCause();
        }
        return new IllegalStateException(guidance, exception);
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
