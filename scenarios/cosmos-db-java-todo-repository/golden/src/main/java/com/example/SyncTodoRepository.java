package com.example;

import com.azure.cosmos.CosmosContainer;
import com.azure.cosmos.CosmosException;
import com.azure.cosmos.models.CosmosItemRequestOptions;
import com.azure.cosmos.models.CosmosItemResponse;
import com.azure.cosmos.models.CosmosQueryRequestOptions;
import com.azure.cosmos.models.FeedResponse;
import com.azure.cosmos.models.PartitionKey;
import com.azure.cosmos.models.SqlParameter;
import com.azure.cosmos.models.SqlQuerySpec;
import com.azure.cosmos.util.CosmosPagedIterable;
import java.util.List;

public final class SyncTodoRepository {
    private final CosmosContainer container;

    public SyncTodoRepository(CosmosContainer container) {
        this.container = container;
    }

    public TodoItem create(TodoItem item) {
        try {
            CosmosItemResponse<TodoItem> response = container.createItem(
                    item,
                    new PartitionKey(item.getCategory()),
                    new CosmosItemRequestOptions());
            logCharge("sync create", response.getRequestCharge());
            return response.getItem();
        } catch (CosmosException exception) {
            throw translate("create", exception);
        }
    }

    public TodoItem read(String id, String category) {
        try {
            CosmosItemResponse<TodoItem> response = container.readItem(
                    id, new PartitionKey(category), TodoItem.class);
            logCharge("sync read", response.getRequestCharge());
            return response.getItem();
        } catch (CosmosException exception) {
            throw translate("read", exception);
        }
    }

    public TodoItem update(TodoItem item) {
        if (item.getEtag() == null || item.getEtag().isBlank()) {
            throw new IllegalArgumentException("An ETag from a prior read is required");
        }
        CosmosItemRequestOptions options =
                new CosmosItemRequestOptions().setIfMatchETag(item.getEtag());
        try {
            CosmosItemResponse<TodoItem> response = container.replaceItem(
                    item,
                    item.getId(),
                    new PartitionKey(item.getCategory()),
                    options);
            logCharge("sync update", response.getRequestCharge());
            return response.getItem();
        } catch (CosmosException exception) {
            throw translate("update", exception);
        }
    }

    public void delete(String id, String category) {
        try {
            var response = container.deleteItem(
                    id,
                    new PartitionKey(category),
                    new CosmosItemRequestOptions());
            logCharge("sync delete", response.getRequestCharge());
        } catch (CosmosException exception) {
            throw translate("delete", exception);
        }
    }

    public void queryByCategory(String category, int pageSize) {
        SqlQuerySpec query = new SqlQuerySpec(
                "SELECT * FROM c WHERE c.category = @category",
                List.of(new SqlParameter("@category", category)));
        CosmosQueryRequestOptions options = new CosmosQueryRequestOptions();
        try {
            CosmosPagedIterable<TodoItem> results =
                    container.queryItems(query, options, TodoItem.class);
            for (FeedResponse<TodoItem> page : results.iterableByPage(null, pageSize)) {
                System.out.printf(
                        "sync query page count=%d continuation=%s%n",
                        page.getResults().size(),
                        page.getContinuationToken());
                logCharge("sync query page", page.getRequestCharge());
                page.getResults().forEach(System.out::println);
            }
        } catch (CosmosException exception) {
            throw translate("query", exception);
        }
    }

    private static RuntimeException translate(
            String operation, CosmosException exception) {
        return switch (exception.getStatusCode()) {
            case 404 -> new IllegalStateException(
                    operation + " could not find the ToDo item", exception);
            case 409 -> new IllegalStateException(
                    operation + " found an existing ToDo item", exception);
            case 412 -> new TodoConflictException(
                    operation + " rejected because the ToDo item changed",
                    exception);
            default -> exception;
        };
    }

    private static void logCharge(String operation, double requestCharge) {
        System.out.printf("%s consumed %.2f RU%n", operation, requestCharge);
    }
}
