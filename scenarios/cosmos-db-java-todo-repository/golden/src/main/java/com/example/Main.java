package com.example;

import com.azure.cosmos.CosmosAsyncClient;
import com.azure.cosmos.CosmosClient;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        runSyncDemo();
        runAsyncDemo();
    }

    private static void runSyncDemo() {
        try (CosmosClient client = CosmosFactory.createSyncClient()) {
            SyncTodoRepository repository =
                    new SyncTodoRepository(CosmosFactory.createSyncContainer(client));
            TodoItem created = repository.create(TodoItem.create(
                    "sync-1", "Write tests", "Cover repository behavior", "work"));
            TodoItem current = repository.read(created.getId(), created.getCategory());
            repository.queryByCategory(current.getCategory(), 25);
            current.setCompleted(true);
            TodoItem updated = repository.update(current);
            System.out.println("sync updated: " + updated.getTitle());
            repository.delete(updated.getId(), updated.getCategory());
        }
    }

    private static void runAsyncDemo() {
        CosmosAsyncClient client = CosmosFactory.createAsyncClient();
        try {
            AsyncTodoRepository repository =
                    new AsyncTodoRepository(CosmosFactory.createAsyncContainer(client));
            TodoItem created = repository.create(TodoItem.create(
                            "async-1", "Ship sample", "Run the async demo", "work"))
                    .block();
            TodoItem current =
                    repository.read(created.getId(), created.getCategory()).block();
            repository.queryByCategory(current.getCategory(), 25)
                    .doOnNext(page ->
                            page.getResults().forEach(System.out::println))
                    .then()
                    .block();
            current.setCompleted(true);
            TodoItem updated = repository.update(current).block();
            System.out.println("async updated: " + updated.getTitle());
            repository.delete(updated.getId(), updated.getCategory()).block();
        } finally {
            client.close();
        }
    }
}
