package com.example;

import com.azure.cosmos.ConsistencyLevel;
import com.azure.cosmos.CosmosClient;
import com.azure.cosmos.CosmosClientBuilder;
import com.azure.cosmos.CosmosContainer;
import com.azure.cosmos.CosmosDatabase;
import com.azure.cosmos.CosmosException;
import com.azure.cosmos.models.CosmosContainerProperties;
import com.azure.cosmos.models.CosmosItemRequestOptions;
import com.azure.cosmos.models.CosmosItemResponse;
import com.azure.cosmos.models.CosmosQueryRequestOptions;
import com.azure.cosmos.models.PartitionKey;
import com.azure.cosmos.models.SqlParameter;
import com.azure.cosmos.models.SqlQuerySpec;
import com.azure.cosmos.models.ThroughputProperties;

import java.util.List;

public final class CosmosCrudApp {
    private static final String DATABASE_NAME = "TestDB";
    private static final String CONTAINER_NAME = "Items";

    private CosmosCrudApp() {
    }

    public static void main(String[] args) {
        String endpoint = requireEnvironmentVariable("COSMOS_ENDPOINT");
        String key = requireEnvironmentVariable("COSMOS_KEY");

        try (CosmosClient client = new CosmosClientBuilder()
                .endpoint(endpoint)
                .key(key)
                .consistencyLevel(ConsistencyLevel.SESSION)
                .buildClient()) {
            CosmosDatabase database = createDatabase(client);
            CosmosContainer container = createContainer(database);

            Item item = new Item("item-1", "electronics", "Wireless Mouse", 10);
            createItem(container, item);
            readItem(container, item.getId(), item.getCategory());
            queryItems(container, "electronics");

            item.setQuantity(25);
            replaceItem(container, item);
            deleteItem(container, item.getId(), item.getCategory());
        } catch (CosmosException exception) {
            handleCosmosException(exception);
        }
    }

    private static CosmosDatabase createDatabase(CosmosClient client) {
        client.createDatabaseIfNotExists(DATABASE_NAME);
        return client.getDatabase(DATABASE_NAME);
    }

    private static CosmosContainer createContainer(CosmosDatabase database) {
        CosmosContainerProperties properties =
                new CosmosContainerProperties(CONTAINER_NAME, "/category");
        database.createContainerIfNotExists(
                properties,
                ThroughputProperties.createManualThroughput(400));
        return database.getContainer(CONTAINER_NAME);
    }

    private static void createItem(CosmosContainer container, Item item) {
        CosmosItemResponse<Item> response = container.createItem(
                item,
                new PartitionKey(item.getCategory()),
                new CosmosItemRequestOptions());
        System.out.printf("Created %s (status %d)%n",
                response.getItem().getId(), response.getStatusCode());
    }

    private static Item readItem(CosmosContainer container, String id, String category) {
        CosmosItemResponse<Item> response =
                container.readItem(id, new PartitionKey(category), Item.class);
        Item item = response.getItem();
        System.out.printf("Read %s: %s, quantity %d%n",
                item.getId(), item.getName(), item.getQuantity());
        return item;
    }

    private static void queryItems(CosmosContainer container, String category) {
        SqlQuerySpec query = new SqlQuerySpec(
                "SELECT * FROM c WHERE c.category = @category",
                List.of(new SqlParameter("@category", category)));

        for (Item item : container.queryItems(
                query, new CosmosQueryRequestOptions(), Item.class)) {
            System.out.printf("Query result: %s (%s)%n", item.getName(), item.getId());
        }
    }

    private static void replaceItem(CosmosContainer container, Item item) {
        CosmosItemResponse<Item> response = container.replaceItem(
                item,
                item.getId(),
                new PartitionKey(item.getCategory()),
                new CosmosItemRequestOptions());
        System.out.printf("Updated %s to quantity %d (status %d)%n",
                response.getItem().getId(),
                response.getItem().getQuantity(),
                response.getStatusCode());
    }

    private static void deleteItem(CosmosContainer container, String id, String category) {
        int statusCode = container.deleteItem(
                id,
                new PartitionKey(category),
                new CosmosItemRequestOptions()).getStatusCode();
        System.out.printf("Deleted %s (status %d)%n", id, statusCode);
    }

    private static String requireEnvironmentVariable(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must be set");
        }
        return value;
    }

    private static void handleCosmosException(CosmosException exception) {
        int statusCode = exception.getStatusCode();
        String description = switch (statusCode) {
            case 400 -> "Bad request";
            case 401, 403 -> "Authentication or authorization failed";
            case 404 -> "Database, container, or item not found";
            case 409 -> "Resource already exists";
            case 429 -> "Request rate is too large";
            default -> "Cosmos DB request failed";
        };

        System.err.printf("%s (status %d, activity ID %s): %s%n",
                description,
                statusCode,
                exception.getActivityId(),
                exception.getMessage());
    }

    public static final class Item {
        private String id;
        private String category;
        private String name;
        private int quantity;

        public Item() {
        }

        public Item(String id, String category, String name, int quantity) {
            this.id = id;
            this.category = category;
            this.name = name;
            this.quantity = quantity;
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getCategory() {
            return category;
        }

        public void setCategory(String category) {
            this.category = category;
        }

        public String getName() {
            return name;
        }

        public void setName(String name) {
            this.name = name;
        }

        public int getQuantity() {
            return quantity;
        }

        public void setQuantity(int quantity) {
            this.quantity = quantity;
        }
    }
}
