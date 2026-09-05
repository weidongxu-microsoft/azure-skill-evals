package com.example;

import com.azure.core.credential.TokenCredential;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        DeploymentEnvironment environment =
                EnvironmentDetector.detectEnvironment();
        System.out.println("Detected environment: " + environment);
        System.out.println(
                "Selected strategy: " + CredentialFactory.strategyFor(environment));
        boolean caeEnabled =
                !"false".equalsIgnoreCase(System.getenv("AZURE_ENABLE_CAE"));
        System.out.println("CAE requested: " + caeEnabled);

        TokenCredential credential =
                CredentialFactory.buildCredential(environment);
        if ("1".equals(System.getenv("CREDENTIAL_CHAIN_DRY_RUN"))) {
            return;
        }

        boolean syncSucceeded =
                ConnectivityTester.testSync(credential, caeEnabled);
        boolean asyncSucceeded =
                ConnectivityTester.testAsync(credential, caeEnabled).block();
        if (!syncSucceeded || !asyncSucceeded) {
            System.exit(1);
        }
    }
}
