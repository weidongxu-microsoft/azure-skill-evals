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

        TokenCredential credential =
                CredentialFactory.buildCredential(environment);
        if ("1".equals(System.getenv("CREDENTIAL_CHAIN_DRY_RUN"))) {
            return;
        }

        boolean syncSucceeded = ConnectivityTester.testSync(credential);
        boolean asyncSucceeded = ConnectivityTester.testAsync(credential).block();
        if (!syncSucceeded || !asyncSucceeded) {
            System.exit(1);
        }
    }
}
