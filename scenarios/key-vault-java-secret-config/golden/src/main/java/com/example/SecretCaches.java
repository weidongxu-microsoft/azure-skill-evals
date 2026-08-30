package com.example;

import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

public final class SecretCaches {
    private SecretCaches() {
    }

    public static final class SyncCache {
        private final SecretProviders.SyncProvider provider;
        private final Duration warningWindow;
        private final Map<String, ConfigSecret> values =
                new ConcurrentHashMap<>();

        public SyncCache(
                SecretProviders.SyncProvider provider,
                Duration warningWindow) {
            this.provider = provider;
            this.warningWindow = warningWindow;
        }

        public void bulkLoad(List<String> names) {
            for (String name : names) {
                refresh(name);
            }
        }

        public String get(String name, String defaultValue) {
            if (!values.containsKey(name)) {
                refresh(name, defaultValue);
            }
            return values.get(name).value();
        }

        public ConfigSecret refresh(String name) {
            return refresh(name, "");
        }

        public ConfigSecret refresh(String name, String defaultValue) {
            ConfigSecret secret = provider.get(name, null, defaultValue);
            values.put(name, secret);
            return secret;
        }

        public List<String> refreshExpiring() {
            OffsetDateTime deadline =
                    OffsetDateTime.now().plus(warningWindow);
            List<String> expiring = values.entrySet().stream()
                    .filter(entry -> entry.getValue().expiresOn() != null)
                    .filter(entry ->
                            !entry.getValue().expiresOn().isAfter(deadline))
                    .map(Map.Entry::getKey)
                    .toList();
            for (String name : expiring) {
                System.out.println("Warning: " + name + " expires soon");
                refresh(name);
            }
            return expiring;
        }
    }

    public static final class AsyncCache {
        private final SecretProviders.AsyncProvider provider;
        private final Duration warningWindow;
        private final Map<String, ConfigSecret> values =
                new ConcurrentHashMap<>();

        public AsyncCache(
                SecretProviders.AsyncProvider provider,
                Duration warningWindow) {
            this.provider = provider;
            this.warningWindow = warningWindow;
        }

        public Mono<Void> bulkLoad(List<String> names) {
            return Flux.fromIterable(names)
                    .concatMap(this::refresh)
                    .then();
        }

        public Mono<String> get(String name, String defaultValue) {
            ConfigSecret cached = values.get(name);
            if (cached != null) {
                return Mono.just(cached.value());
            }
            return refresh(name, defaultValue).map(ConfigSecret::value);
        }

        public Mono<ConfigSecret> refresh(String name) {
            return refresh(name, "");
        }

        public Mono<ConfigSecret> refresh(
                String name,
                String defaultValue) {
            return provider.get(name, null, defaultValue)
                    .doOnNext(secret -> values.put(name, secret));
        }

        public Mono<List<String>> refreshExpiring() {
            OffsetDateTime deadline =
                    OffsetDateTime.now().plus(warningWindow);
            List<String> expiring = values.entrySet().stream()
                    .filter(entry -> entry.getValue().expiresOn() != null)
                    .filter(entry ->
                            !entry.getValue().expiresOn().isAfter(deadline))
                    .map(Map.Entry::getKey)
                    .toList();
            return Flux.fromIterable(expiring)
                    .doOnNext(name ->
                            System.out.println(
                                    "Warning: " + name + " expires soon"))
                    .concatMap(this::refresh)
                    .then(Mono.just(expiring));
        }
    }
}
