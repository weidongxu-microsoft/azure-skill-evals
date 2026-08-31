package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.identity.AzureCliCredentialBuilder;
import com.azure.identity.AzurePowerShellCredentialBuilder;
import com.azure.identity.ChainedTokenCredentialBuilder;
import com.azure.identity.EnvironmentCredentialBuilder;
import com.azure.identity.ManagedIdentityCredentialBuilder;
import com.azure.identity.WorkloadIdentityCredentialBuilder;

public final class CredentialFactory {
    private CredentialFactory() {
    }

    public static TokenCredential buildCredential(
            DeploymentEnvironment environment) {
        return switch (environment) {
            case DEV -> createDevelopmentCredential();
            case CI -> createCiCredential();
            case PRODUCTION -> createProductionCredential();
        };
    }

    private static TokenCredential createDevelopmentCredential() {
        return new ChainedTokenCredentialBuilder()
                .addLast(new AzureCliCredentialBuilder().build())
                .addLast(new AzurePowerShellCredentialBuilder().build())
                .build();
    }

    private static TokenCredential createCiCredential() {
        return new ChainedTokenCredentialBuilder()
                .addLast(new EnvironmentCredentialBuilder().build())
                .addLast(new WorkloadIdentityCredentialBuilder().build())
                .build();
    }

    private static TokenCredential createProductionCredential() {
        return new ChainedTokenCredentialBuilder()
                .addLast(createManagedIdentityCredential())
                .addLast(new WorkloadIdentityCredentialBuilder().build())
                .build();
    }

    private static TokenCredential createManagedIdentityCredential() {
        String clientId = System.getenv("AZURE_CLIENT_ID");
        ManagedIdentityCredentialBuilder builder =
                new ManagedIdentityCredentialBuilder();
        if (clientId != null && !clientId.isBlank()) {
            builder.clientId(clientId);
        }
        return builder.build();
    }

    public static String strategyFor(DeploymentEnvironment environment) {
        return switch (environment) {
            case DEV -> "Azure CLI, then Azure PowerShell";
            case CI -> "environment credential, then workload identity";
            case PRODUCTION -> "managed identity, then workload identity";
        };
    }
}
