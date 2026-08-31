package com.example;

import com.azure.cosmos.CosmosAsyncClient;
import com.azure.cosmos.CosmosAsyncContainer;
import com.azure.cosmos.CosmosClient;
import com.azure.cosmos.CosmosClientBuilder;
import com.azure.cosmos.CosmosContainer;
import com.azure.cosmos.models.CosmosContainerProperties;
import com.azure.cosmos.models.ExcludedPath;
import com.azure.cosmos.models.IndexingPolicy;
import com.azure.identity.ManagedIdentityCredentialBuilder;
import java.util.List;

public final class CosmosFactory {
    private static final String DATABASE_NAME = "TodoDatabase";
    private static final String CONTAINER_NAME = "Todos";
    private static final int DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

    private CosmosFactory() {
    }

    public static CosmosClient createSyncClient() {
        String endpoint = requireEnvironment("AZURE_COSMOS_ENDPOINT");
        return new CosmosClientBuilder()
                .endpoint(endpoint)
                .credential(new ManagedIdentityCredentialBuilder().build())
                .buildClient();
    }

    public static CosmosAsyncClient createAsyncClient() {
        String endpoint = requireEnvironment("AZURE_COSMOS_ENDPOINT");
        return new CosmosClientBuilder()
                .endpoint(endpoint)
                .credential(new ManagedIdentityCredentialBuilder().build())
                .buildAsyncClient();
    }

    public static CosmosContainer createSyncContainer(CosmosClient client) {
        client.createDatabaseIfNotExists(DATABASE_NAME);
        var database = client.getDatabase(DATABASE_NAME);
        database.createContainerIfNotExists(containerProperties());
        return database.getContainer(CONTAINER_NAME);
    }

    public static CosmosAsyncContainer createAsyncContainer(
            CosmosAsyncClient client) {
        client.createDatabaseIfNotExists(DATABASE_NAME).block();
        var database = client.getDatabase(DATABASE_NAME);
        database.createContainerIfNotExists(containerProperties()).block();
        return database.getContainer(CONTAINER_NAME);
    }

    private static CosmosContainerProperties containerProperties() {
        CosmosContainerProperties properties =
                new CosmosContainerProperties(CONTAINER_NAME, "/category");
        properties.setDefaultTimeToLiveInSeconds(DEFAULT_TTL_SECONDS);
        IndexingPolicy indexingPolicy = new IndexingPolicy();
        indexingPolicy.setExcludedPaths(
                List.of(new ExcludedPath("/description/?")));
        properties.setIndexingPolicy(indexingPolicy);
        return properties;
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
