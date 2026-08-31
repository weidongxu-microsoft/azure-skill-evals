package com.example;

import com.azure.core.credential.TokenCredential;
import com.azure.data.appconfiguration.ConfigurationAsyncClient;
import com.azure.data.appconfiguration.ConfigurationClient;
import com.azure.data.appconfiguration.ConfigurationClientBuilder;
import com.azure.identity.ManagedIdentityCredentialBuilder;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.List;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        String endpoint = requireEnvironment("AZURE_APPCONFIG_ENDPOINT");
        TokenCredential credential = new ManagedIdentityCredentialBuilder().build();
        ConfigurationClientBuilder builder = new ConfigurationClientBuilder()
                .endpoint(endpoint)
                .credential(credential);
        ConfigurationClient syncClient = builder.buildClient();
        ConfigurationAsyncClient asyncClient = builder.buildAsyncClient();

        AppConfigurationService syncService =
                new AppConfigurationService(syncClient);
        runSyncDemo(syncService);

        AsyncAppConfigurationService asyncService =
                new AsyncAppConfigurationService(asyncClient);
        runAsyncDemo(asyncService).block();
    }

    private static void runSyncDemo(AppConfigurationService service) {
        System.out.println(service.getSetting("app:Settings:Theme").getValue());
        System.out.println(
                service.getSetting("app:Settings:Theme", "production").getValue());
        System.out.println(service.getSettingsByPrefix("app:Settings:"));
        service.getIfChanged("app:Settings:Theme", "production");

        FeatureFlagEvaluator flags = new FeatureFlagEvaluator(service);
        for (String userId : List.of("alice", "bob", "carol")) {
            System.out.printf(
                    "sync BetaFeature for %s: %s%n",
                    userId,
                    flags.isEnabled("BetaFeature", userId));
        }

        try (ConfigurationWatcher watcher = new ConfigurationWatcher(
                service,
                List.of("app:Sentinel"),
                Duration.ofSeconds(30),
                "app:Settings:")) {
            watcher.start();
            watcher.awaitFirstPoll();
        }
    }

    private static Mono<Void> runAsyncDemo(
            AsyncAppConfigurationService service) {
        FeatureFlagEvaluator flags = new FeatureFlagEvaluator(service);
        ConfigurationWatcher watcher = new ConfigurationWatcher(
                service,
                List.of("app:Sentinel"),
                Duration.ofSeconds(30),
                "app:Settings:");

        Mono<Void> demo = service.getSettingAsync("app:Settings:Theme")
                .doOnNext(setting -> System.out.println(setting.getValue()))
                .then(service.getSettingAsync(
                        "app:Settings:Theme", "production"))
                .doOnNext(setting -> System.out.println(setting.getValue()))
                .then(service.getSettingsByPrefixAsync("app:Settings:"))
                .doOnNext(System.out::println)
                .then(service.getIfChangedAsync(
                        "app:Settings:Theme", "production"))
                .thenMany(FluxSupport.users())
                .concatMap(userId -> flags.isEnabledAsync(
                        "BetaFeature", userId))
                .then(watcher.awaitFirstPollAsync());
        watcher.startAsync();
        return demo.doFinally(signal -> watcher.close());
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }

    private static final class FluxSupport {
        private FluxSupport() {
        }

        static reactor.core.publisher.Flux<String> users() {
            return reactor.core.publisher.Flux.just("alice", "bob", "carol");
        }
    }
}
