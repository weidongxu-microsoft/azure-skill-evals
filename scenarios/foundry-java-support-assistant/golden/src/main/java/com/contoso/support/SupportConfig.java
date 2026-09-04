package com.contoso.support;

import java.net.URI;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

public record SupportConfig(
    URI projectEndpoint,
    String modelDeploymentName,
    String evaluationModelDeploymentName,
    URI storageAccountEndpoint,
    String stateContainer,
    String stateBlob,
    String tokenScope,
    Set<String> adminPrincipalIds,
    int port,
    Path[] materials,
    Path evaluationDataset) {

    public static SupportConfig load() {
        return load(System.getenv());
    }

    static SupportConfig load(Map<String, String> environment) {
        int port = Integer.parseInt(environment.getOrDefault("PORT", "3000"));
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException(
                "PORT must be between 1 and 65535.");
        }
        Set<String> administrators = Arrays.stream(required(
                environment, "SUPPORT_ADMIN_PRINCIPAL_IDS").split(","))
            .map(String::trim)
            .filter(value -> !value.isEmpty())
            .collect(Collectors.toUnmodifiableSet());
        if (administrators.isEmpty()) {
            throw new IllegalArgumentException(
                "SUPPORT_ADMIN_PRINCIPAL_IDS must contain an object ID.");
        }
        return new SupportConfig(
            URI.create(required(environment, "FOUNDRY_PROJECT_ENDPOINT")),
            required(environment, "MODEL_DEPLOYMENT_NAME"),
            required(environment, "EVALUATION_MODEL_DEPLOYMENT_NAME"),
            URI.create(required(environment, "STORAGE_ACCOUNT_ENDPOINT")),
            environment.getOrDefault(
                "SUPPORT_STATE_CONTAINER", "support-assistant"),
            environment.getOrDefault(
                "SUPPORT_STATE_BLOB", "state/application.json"),
            environment.getOrDefault(
                "FOUNDRY_TOKEN_SCOPE",
                "https://ai.azure.com/.default"),
            administrators,
            port,
            new Path[] {
                Path.of("materials", "contoso-aero-300.md"),
                Path.of(
                    "materials", "contoso-aero-300-warranty.md")
            },
            Path.of("evaluation", "support-cases.jsonl"));
    }

    private static String required(
        Map<String, String> environment,
        String name) {
        String value = environment.get(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required.");
        }
        return value.trim();
    }
}
