package com.example;

import reactor.core.Disposable;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public final class ConfigurationWatcher implements AutoCloseable {
    private final AppConfigurationService syncService;
    private final AsyncAppConfigurationService asyncService;
    private final List<String> sentinelKeys;
    private final Duration pollingInterval;
    private final String refreshPrefix;
    private final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor();
    private final CompletableFuture<Void> firstPoll = new CompletableFuture<>();
    private ScheduledFuture<?> pollingTask;
    private Disposable asyncPoll;

    public ConfigurationWatcher(
            AppConfigurationService service,
            List<String> sentinelKeys,
            Duration pollingInterval,
            String refreshPrefix) {
        this.syncService = service;
        this.asyncService = null;
        this.sentinelKeys = List.copyOf(sentinelKeys);
        this.pollingInterval = pollingInterval;
        this.refreshPrefix = refreshPrefix;
    }

    public ConfigurationWatcher(
            AsyncAppConfigurationService service,
            List<String> sentinelKeys,
            Duration pollingInterval,
            String refreshPrefix) {
        this.syncService = null;
        this.asyncService = service;
        this.sentinelKeys = List.copyOf(sentinelKeys);
        this.pollingInterval = pollingInterval;
        this.refreshPrefix = refreshPrefix;
    }

    public synchronized void start() {
        if (isRunning()) {
            return;
        }
        pollingTask = scheduler.scheduleWithFixedDelay(
                this::runSyncPoll,
                0,
                pollingInterval.toMillis(),
                TimeUnit.MILLISECONDS);
    }

    public synchronized void startAsync() {
        if (isRunning()) {
            return;
        }
        pollingTask = scheduler.scheduleWithFixedDelay(
                this::runAsyncPoll,
                0,
                pollingInterval.toMillis(),
                TimeUnit.MILLISECONDS);
    }

    public void awaitFirstPoll() {
        firstPoll.join();
    }

    public Mono<Void> awaitFirstPollAsync() {
        return Mono.fromFuture(firstPoll);
    }

    public void checkOnce() {
        boolean changed = sentinelKeys.stream()
                .map(syncService::sentinelChanged)
                .reduce(false, Boolean::logicalOr);
        if (changed) {
            syncService.refreshPrefix(refreshPrefix);
        }
    }

    public Mono<Void> checkOnceAsync() {
        return Flux.fromIterable(sentinelKeys)
                .concatMap(asyncService::sentinelChangedAsync)
                .any(Boolean.TRUE::equals)
                .flatMap(changed ->
                        changed
                                ? asyncService.refreshPrefixAsync(refreshPrefix)
                                : Mono.empty());
    }

    public synchronized void stop() {
        if (pollingTask != null) {
            pollingTask.cancel(true);
            pollingTask = null;
        }
        if (asyncPoll != null) {
            asyncPoll.dispose();
            asyncPoll = null;
        }
    }

    private boolean isRunning() {
        return pollingTask != null
                && !pollingTask.isDone()
                && !pollingTask.isCancelled();
    }

    private void runSyncPoll() {
        try {
            checkOnce();
            firstPoll.complete(null);
        } catch (RuntimeException exception) {
            firstPoll.completeExceptionally(exception);
            throw exception;
        }
    }

    private synchronized void runAsyncPoll() {
        if (asyncPoll != null && !asyncPoll.isDisposed()) {
            return;
        }
        asyncPoll = checkOnceAsync().subscribe(
                ignored -> {
                },
                firstPoll::completeExceptionally,
                () -> firstPoll.complete(null));
    }

    @Override
    public void close() {
        stop();
        scheduler.shutdownNow();
    }
}
