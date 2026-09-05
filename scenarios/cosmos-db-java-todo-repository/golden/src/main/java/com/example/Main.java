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
            System.out.println("sync created: " + created.getId());
            TodoItem current = repository.read(created.getId(), created.getCategory());
            System.out.println("sync read: " + current.getTitle());
            repository.queryByCategory(current.getCategory(), 25);
            current.setCompleted(true);
            TodoItem updated = repository.update(current);
            System.out.println(
                    "sync updated: " + updated.getTitle()
                            + ", completed=" + updated.isCompleted());
            repository.delete(updated.getId(), updated.getCategory());
            System.out.println("sync deleted: " + updated.getId());
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
            requireResult(created, "async create");
            System.out.println("async created: " + created.getId());
            TodoItem current =
                    repository.read(created.getId(), created.getCategory()).block();
            requireResult(current, "async read");
            System.out.println("async read: " + current.getTitle());
            repository.queryByCategory(current.getCategory(), 25)
                    .doOnNext(page ->
                            page.getResults().forEach(System.out::println))
                    .then()
                    .block();
            current.setCompleted(true);
            TodoItem updated = repository.update(current).block();
            requireResult(updated, "async update");
            System.out.println(
                    "async updated: " + updated.getTitle()
                            + ", completed=" + updated.isCompleted());
            repository.delete(updated.getId(), updated.getCategory()).block();
            System.out.println("async deleted: " + updated.getId());
        } finally {
            client.close();
        }
    }

    private static void requireResult(TodoItem item, String operation) {
        if (item == null) {
            throw new IllegalStateException(operation + " completed without an item");
        }
    }
}
