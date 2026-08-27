package com.example;

import com.azure.cosmos.CosmosClient;
import com.azure.cosmos.CosmosClientBuilder;
import com.azure.cosmos.CosmosContainer;
import com.azure.cosmos.CosmosDatabase;
import com.azure.cosmos.CosmosException;
import com.azure.cosmos.models.CosmosItemRequestOptions;
import com.azure.cosmos.models.CosmosItemResponse;
import com.azure.cosmos.models.CosmosQueryRequestOptions;
import com.azure.cosmos.models.PartitionKey;
import com.azure.cosmos.models.SqlParameter;
import com.azure.cosmos.models.SqlQuerySpec;
import com.azure.cosmos.util.CosmosPagedIterable;
import java.util.List;

public final class CosmosCrud {
    private CosmosCrud() {
    }

    public static void main(String[] args) {
        String endpoint = requireEnvironment("COSMOS_ENDPOINT");
        String key = requireEnvironment("COSMOS_KEY");

        try (CosmosClient client = new CosmosClientBuilder()
                .endpoint(endpoint)
                .key(key)
                .buildClient()) {
            client.createDatabaseIfNotExists("TestDB");
            CosmosDatabase database = client.getDatabase("TestDB");
            database.createContainerIfNotExists("Items", "/category");
            CosmosContainer container = database.getContainer("Items");

            InventoryItem item =
                    new InventoryItem("item-1", "electronics", "Laptop", 1);
            container.createItem(
                    item,
                    new PartitionKey(item.getCategory()),
                    new CosmosItemRequestOptions());

            CosmosItemResponse<InventoryItem> readResponse =
                    container.readItem(
                            item.getId(),
                            new PartitionKey(item.getCategory()),
                            InventoryItem.class);
            System.out.println("Read " + readResponse.getItem().getName());

            SqlQuerySpec query = new SqlQuerySpec(
                    "SELECT * FROM c WHERE c.category = @category",
                    List.of(new SqlParameter("@category", "electronics")));
            CosmosPagedIterable<InventoryItem> results =
                    container.queryItems(
                            query,
                            new CosmosQueryRequestOptions(),
                            InventoryItem.class);
            results.forEach(result ->
                    System.out.println("Queried " + result.getName()));

            item.setQuantity(2);
            container.replaceItem(
                    item,
                    item.getId(),
                    new PartitionKey(item.getCategory()),
                    new CosmosItemRequestOptions());
            container.deleteItem(
                    item.getId(),
                    new PartitionKey(item.getCategory()),
                    new CosmosItemRequestOptions());
        } catch (CosmosException exception) {
            System.err.printf(
                    "Cosmos DB request failed with status %d: %s%n",
                    exception.getStatusCode(),
                    exception.getMessage());
            System.exit(1);
        }
    }
    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }

    public static final class InventoryItem {
        private String id;
        private String category;
        private String name;
        private int quantity;

        public InventoryItem() {
        }

        public InventoryItem(
                String id,
                String category,
                String name,
                int quantity) {
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
