package com.example;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;

public final class Main {
    private static final List<String> CONFIG_KEYS =
            List.of("database-url", "api-key", "feature-toggle");

    private Main() {
    }

    private static void runSyncDemo(
            ClientFactory.Clients clients) {
        SecretCaches.SyncCache cache = new SecretCaches.SyncCache(
                new SecretProviders.SyncProvider(clients.syncClient()),
                Duration.ofDays(7));
        cache.bulkLoad(CONFIG_KEYS);
        System.out.println(cache.get("database-url", "missing"));
        cache.refresh("api-key");
        cache.refreshExpiring();
        SecretRotation.rotateSync(
                clients.syncClient(),
                "api-key",
                "rotated-value",
                OffsetDateTime.now(ZoneOffset.UTC).plusDays(90));
    }

    private static void runAsyncDemo(
            ClientFactory.Clients clients) {
        SecretCaches.AsyncCache cache = new SecretCaches.AsyncCache(
                new SecretProviders.AsyncProvider(clients.asyncClient()),
                Duration.ofDays(7));
        cache.bulkLoad(CONFIG_KEYS)
                .then(cache.get("database-url", "missing")
                        .doOnNext(System.out::println))
                .then(cache.refresh("api-key"))
                .then(cache.refreshExpiring())
                .then(SecretRotation.rotateAsync(
                        clients.asyncClient(),
                        "api-key",
                        "rotated-value",
                        OffsetDateTime.now(ZoneOffset.UTC).plusDays(90)))
                .block();
    }

    public static void main(String[] args) {
        ClientFactory.Clients clients = ClientFactory.loadConfiguration();
        runSyncDemo(clients);
        runAsyncDemo(clients);
    }
}
