package com.example;

public final class EnvironmentDetector {
    private EnvironmentDetector() {
    }

    public static DeploymentEnvironment detectEnvironment() {
        if (present("CI")
                || present("TF_BUILD")
                || present("BUILD_SOURCESDIRECTORY")
                || present("AZURE_PIPELINE_WORKSPACE")) {
            return DeploymentEnvironment.CI;
        }
        if (present("IDENTITY_ENDPOINT") || present("MSI_ENDPOINT")) {
            return DeploymentEnvironment.PRODUCTION;
        }
        return DeploymentEnvironment.DEV;
    }

    private static boolean present(String name) {
        String value = System.getenv(name);
        return value != null && !value.isBlank();
    }
}
