package com.example;

import com.azure.cosmos.CosmosAsyncContainer;
import com.azure.cosmos.CosmosException;
import com.azure.cosmos.models.CosmosItemRequestOptions;
import com.azure.cosmos.models.CosmosItemResponse;
import com.azure.cosmos.models.CosmosQueryRequestOptions;
import com.azure.cosmos.models.FeedResponse;
import com.azure.cosmos.models.PartitionKey;
import com.azure.cosmos.models.SqlParameter;
import com.azure.cosmos.models.SqlQuerySpec;
import java.util.List;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public final class AsyncTodoRepository {
    private final CosmosAsyncContainer container;

    public AsyncTodoRepository(CosmosAsyncContainer container) {
        this.container = container;
    }

    public Mono<TodoItem> create(TodoItem item) {
        return container.createItem(
                        item,
                        new PartitionKey(item.getCategory()),
                        new CosmosItemRequestOptions())
                .doOnNext(response ->
                        logCharge("async create", response.getRequestCharge()))
                .map(CosmosItemResponse::getItem)
                .onErrorMap(CosmosException.class, error -> translate("create", error));
    }

    public Mono<TodoItem> read(String id, String category) {
        return container.readItem(id, new PartitionKey(category), TodoItem.class)
                .doOnNext(response ->
                        logCharge("async read", response.getRequestCharge()))
                .map(CosmosItemResponse::getItem)
                .onErrorMap(CosmosException.class, error -> translate("read", error));
    }

    public Mono<TodoItem> update(TodoItem item) {
        if (item.getEtag() == null || item.getEtag().isBlank()) {
            return Mono.error(
                    new IllegalArgumentException("An ETag from a prior read is required"));
        }
        CosmosItemRequestOptions options =
                new CosmosItemRequestOptions().setIfMatchETag(item.getEtag());
        return container.replaceItem(
                        item,
                        item.getId(),
                        new PartitionKey(item.getCategory()),
                        options)
                .doOnNext(response ->
                        logCharge("async update", response.getRequestCharge()))
                .map(CosmosItemResponse::getItem)
                .onErrorMap(CosmosException.class, error -> translate("update", error));
    }

    public Mono<Void> delete(String id, String category) {
        return container.deleteItem(
                        id,
                        new PartitionKey(category),
                        new CosmosItemRequestOptions())
                .doOnNext(response ->
                        logCharge("async delete", response.getRequestCharge()))
                .onErrorMap(CosmosException.class, error -> translate("delete", error))
                .then();
    }

    public Flux<FeedResponse<TodoItem>> queryByCategory(
            String category, int pageSize) {
        SqlQuerySpec query = new SqlQuerySpec(
                "SELECT * FROM c WHERE c.category = @category",
                List.of(new SqlParameter("@category", category)));
        CosmosQueryRequestOptions options = new CosmosQueryRequestOptions();
        return container.queryItems(query, options, TodoItem.class)
                .byPage(null, pageSize)
                .doOnNext(page -> {
                    System.out.printf(
                            "async query page count=%d continuation=%s%n",
                            page.getResults().size(),
                            page.getContinuationToken());
                    logCharge("async query page", page.getRequestCharge());
                })
                .onErrorMap(CosmosException.class, error -> translate("query", error));
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
