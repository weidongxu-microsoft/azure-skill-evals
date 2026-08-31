import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateJavaCheck,
  javaCheckNames,
  loadJavaWorkspace,
} from "../../languages/java/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/app-configuration-feature-flags-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);
const evalSpec = readFileSync(
  fileURLToPath(new URL("./eval.yaml", import.meta.url)),
  "utf8",
);

function workspace(source, build = golden.build) {
  return {
    sourceFiles: ["src/main/java/example/Application.java"],
    buildFiles: ["pom.xml"],
    source,
    build,
  };
}

const baseline33374429826 = {
  sourceFiles: ["src/main/java/com/example/appconfig/AsyncConfigurationService.java", "src/main/java/com/example/appconfig/AsyncConfigurationWatcher.java", "src/main/java/com/example/appconfig/AsyncFeatureFlagEvaluator.java", "src/main/java/com/example/appconfig/ConfigurationService.java", "src/main/java/com/example/appconfig/ConfigurationWatcher.java", "src/main/java/com/example/appconfig/FeatureFlagEvaluator.java", "src/main/java/com/example/appconfig/Main.java"],
  buildFiles: ["pom.xml"],
  source: [
  [
    "package com.example.appconfig;",
    "",
    "import com.azure.core.http.HttpHeaderName;",
    "import com.azure.core.http.MatchConditions;",
    "import com.azure.core.http.rest.PagedResponse;",
    "import com.azure.data.appconfiguration.ConfigurationAsyncClient;",
    "import com.azure.data.appconfiguration.models.ConfigurationSetting;",
    "import com.azure.data.appconfiguration.models.SettingSelector;",
    "import reactor.core.publisher.Flux;",
    "import reactor.core.publisher.Mono;",
    "",
    "import java.util.ArrayList;",
    "import java.util.LinkedHashMap;",
    "import java.util.List;",
    "import java.util.Map;",
    "import java.util.Objects;",
    "import java.util.Optional;",
    "import java.util.Set;",
    "import java.util.concurrent.ConcurrentHashMap;",
    "",
    "public final class AsyncConfigurationService {",
    "    private final ConfigurationAsyncClient client;",
    "    private final Map<SettingKey, ConfigurationSetting> settingCache = new ConcurrentHashMap<>();",
    "    private final Map<PrefixQuery, List<PageCache>> prefixCache = new ConcurrentHashMap<>();",
    "    private final Set<SettingKey> requestedSettings = ConcurrentHashMap.newKeySet();",
    "    private final Set<PrefixQuery> requestedPrefixes = ConcurrentHashMap.newKeySet();",
    "",
    "    public AsyncConfigurationService(ConfigurationAsyncClient client) {",
    "        this.client = Objects.requireNonNull(client, \"client\");",
    "    }",
    "",
    "    public Mono<Optional<String>> getSetting(String key) {",
    "        return getSetting(key, null);",
    "    }",
    "",
    "    public Mono<Optional<String>> getSetting(String key, String label) {",
    "        Objects.requireNonNull(key, \"key\");",
    "        return Mono.defer(() -> {",
    "            SettingKey cacheKey = new SettingKey(key, label);",
    "            requestedSettings.add(cacheKey);",
    "            ConfigurationSetting cached = settingCache.get(cacheKey);",
    "            ConfigurationSetting request = cached == null",
    "                ? new ConfigurationSetting().setKey(key).setLabel(label)",
    "                : cached;",
    "",
    "            return client.getConfigurationSettingWithResponse(request, null, cached != null)",
    "                .map(response -> {",
    "                    ConfigurationSetting current =",
    "                        response.getStatusCode() == 304 ? cached : response.getValue();",
    "                    if (current != null) {",
    "                        settingCache.put(cacheKey, current);",
    "                    }",
    "                    return Optional.ofNullable(current).map(ConfigurationSetting::getValue);",
    "                });",
    "        });",
    "    }",
    "",
    "    public Mono<Map<String, String>> listSettings(String keyPrefix) {",
    "        return listSettings(keyPrefix, null);",
    "    }",
    "",
    "    public Mono<Map<String, String>> listSettings(String keyPrefix, String label) {",
    "        Objects.requireNonNull(keyPrefix, \"keyPrefix\");",
    "        PrefixQuery query = new PrefixQuery(keyPrefix, label);",
    "        requestedPrefixes.add(query);",
    "        return loadPrefix(query);",
    "    }",
    "",
    "    public Mono<Void> refreshAll() {",
    "        return Mono.defer(() -> {",
    "            List<SettingKey> settings = List.copyOf(requestedSettings);",
    "            List<PrefixQuery> prefixes = List.copyOf(requestedPrefixes);",
    "            settingCache.clear();",
    "            prefixCache.clear();",
    "            return Flux.concat(",
    "                    Flux.fromIterable(settings)",
    "                        .concatMap(setting -> getSetting(setting.key(), setting.label()).then()),",
    "                    Flux.fromIterable(prefixes).concatMap(prefix -> loadPrefix(prefix).then()))",
    "                .then();",
    "        });",
    "    }",
    "",
    "    private Mono<Map<String, String>> loadPrefix(PrefixQuery query) {",
    "        return Mono.defer(() -> {",
    "            List<PageCache> oldPages = prefixCache.getOrDefault(query, List.of());",
    "            SettingSelector selector =",
    "                new SettingSelector().setKeyFilter(escapeFilter(query.prefix()) + \"*\");",
    "            if (query.label() != null) {",
    "                selector.setLabelFilter(escapeFilter(query.label()));",
    "            }",
    "            if (!oldPages.isEmpty()) {",
    "                selector.setMatchConditions(oldPages.stream()",
    "                    .map(page -> new MatchConditions().setIfNoneMatch(page.etag()))",
    "                    .toList());",
    "            }",
    "",
    "            return client.listConfigurationSettings(selector).byPage().index()",
    "                .map(indexedPage -> toPageCache(indexedPage.getT2(), indexedPage.getT1(), oldPages))",
    "                .collectList()",
    "                .map(pages -> {",
    "                    List<PageCache> immutablePages = List.copyOf(pages);",
    "                    prefixCache.put(query, immutablePages);",
    "                    return flatten(immutablePages);",
    "                });",
    "        });",
    "    }",
    "",
    "    private static PageCache toPageCache(",
    "        PagedResponse<ConfigurationSetting> page, long index, List<PageCache> oldPages",
    "    ) {",
    "        PageCache oldPage = index < oldPages.size() ? oldPages.get((int) index) : null;",
    "        if (page.getStatusCode() == 304 && oldPage != null) {",
    "            return oldPage;",
    "        }",
    "        Map<String, String> values = new LinkedHashMap<>();",
    "        page.getValue().forEach(setting -> values.put(setting.getKey(), setting.getValue()));",
    "        return new PageCache(",
    "            page.getHeaders().getValue(HttpHeaderName.ETAG), Map.copyOf(values));",
    "    }",
    "",
    "    private static Map<String, String> flatten(List<PageCache> pages) {",
    "        Map<String, String> values = new LinkedHashMap<>();",
    "        pages.forEach(page -> values.putAll(page.values()));",
    "        return Map.copyOf(values);",
    "    }",
    "",
    "    private static String escapeFilter(String value) {",
    "        return value.replace(\"\\\\\", \"\\\\\\\\\").replace(\",\", \"\\\\,\").replace(\"*\", \"\\\\*\");",
    "    }",
    "",
    "    private record SettingKey(String key, String label) {",
    "    }",
    "",
    "    private record PrefixQuery(String prefix, String label) {",
    "    }",
    "",
    "    private record PageCache(String etag, Map<String, String> values) {",
    "    }",
    "}",
    ""
].join("\n"),
  [
    "package com.example.appconfig;",
    "",
    "import reactor.core.Disposable;",
    "import reactor.core.publisher.Flux;",
    "import reactor.core.publisher.Mono;",
    "",
    "import java.time.Duration;",
    "import java.util.List;",
    "import java.util.Map;",
    "import java.util.Objects;",
    "import java.util.Optional;",
    "import java.util.concurrent.ConcurrentHashMap;",
    "import java.util.function.Consumer;",
    "",
    "public final class AsyncConfigurationWatcher implements AutoCloseable {",
    "    private final AsyncConfigurationService configuration;",
    "    private final List<String> sentinelKeys;",
    "    private final Duration pollingInterval;",
    "    private final String label;",
    "    private final Consumer<Throwable> errorHandler;",
    "    private final Map<String, Optional<String>> sentinelValues = new ConcurrentHashMap<>();",
    "    private Disposable subscription;",
    "",
    "    public AsyncConfigurationWatcher(",
    "        AsyncConfigurationService configuration,",
    "        List<String> sentinelKeys,",
    "        Duration pollingInterval",
    "    ) {",
    "        this(configuration, sentinelKeys, pollingInterval, null, Throwable::printStackTrace);",
    "    }",
    "",
    "    public AsyncConfigurationWatcher(",
    "        AsyncConfigurationService configuration,",
    "        List<String> sentinelKeys,",
    "        Duration pollingInterval,",
    "        String label,",
    "        Consumer<Throwable> errorHandler",
    "    ) {",
    "        this.configuration = Objects.requireNonNull(configuration, \"configuration\");",
    "        this.sentinelKeys = List.copyOf(sentinelKeys);",
    "        if (this.sentinelKeys.isEmpty()) {",
    "            throw new IllegalArgumentException(\"At least one sentinel key is required\");",
    "        }",
    "        this.pollingInterval = Objects.requireNonNull(pollingInterval, \"pollingInterval\");",
    "        if (pollingInterval.isZero() || pollingInterval.isNegative()) {",
    "            throw new IllegalArgumentException(\"Polling interval must be positive\");",
    "        }",
    "        this.label = label;",
    "        this.errorHandler = Objects.requireNonNull(errorHandler, \"errorHandler\");",
    "    }",
    "",
    "    public synchronized void start() {",
    "        if (subscription != null) {",
    "            throw new IllegalStateException(\"Watcher has already been started\");",
    "        }",
    "        subscription = readSentinels(false)",
    "            .thenMany(Flux.interval(pollingInterval).concatMap(ignored -> readSentinels(true)))",
    "            .subscribe(ignored -> { }, errorHandler);",
    "    }",
    "",
    "    private Mono<Void> readSentinels(boolean refreshWhenChanged) {",
    "        return Flux.fromIterable(sentinelKeys)",
    "            .concatMap(key -> configuration.getSetting(key, label)",
    "                .map(current -> {",
    "                    Optional<String> previous = sentinelValues.put(key, current);",
    "                    return previous != null && !previous.equals(current);",
    "                }))",
    "            .collectList()",
    "            .flatMap(changes -> refreshWhenChanged && changes.stream().anyMatch(Boolean::booleanValue)",
    "                ? configuration.refreshAll()",
    "                : Mono.empty());",
    "    }",
    "",
    "    @Override",
    "    public synchronized void close() {",
    "        if (subscription != null) {",
    "            subscription.dispose();",
    "            subscription = null;",
    "        }",
    "    }",
    "}",
    ""
].join("\n"),
  [
    "package com.example.appconfig;",
    "",
    "import com.azure.data.appconfiguration.models.FeatureFlagConfigurationSetting;",
    "import reactor.core.publisher.Mono;",
    "",
    "import java.util.Objects;",
    "",
    "public final class AsyncFeatureFlagEvaluator {",
    "    private final AsyncConfigurationService configuration;",
    "",
    "    public AsyncFeatureFlagEvaluator(AsyncConfigurationService configuration) {",
    "        this.configuration = Objects.requireNonNull(configuration, \"configuration\");",
    "    }",
    "",
    "    public Mono<Boolean> isEnabled(String flagId) {",
    "        return isEnabled(flagId, null, null);",
    "    }",
    "",
    "    public Mono<Boolean> isEnabled(String flagId, String userId) {",
    "        return isEnabled(flagId, userId, null);",
    "    }",
    "",
    "    public Mono<Boolean> isEnabled(String flagId, String userId, String label) {",
    "        return configuration",
    "            .getSetting(FeatureFlagConfigurationSetting.KEY_PREFIX + flagId, label)",
    "            .map(value -> FeatureFlagEvaluator.evaluate(flagId, userId, value.orElse(null)));",
    "    }",
    "}",
    ""
].join("\n"),
  [
    "package com.example.appconfig;",
    "",
    "import com.azure.core.http.HttpHeaderName;",
    "import com.azure.core.http.MatchConditions;",
    "import com.azure.core.http.rest.PagedResponse;",
    "import com.azure.core.http.rest.Response;",
    "import com.azure.core.util.Context;",
    "import com.azure.data.appconfiguration.ConfigurationClient;",
    "import com.azure.data.appconfiguration.models.ConfigurationSetting;",
    "import com.azure.data.appconfiguration.models.SettingSelector;",
    "",
    "import java.util.ArrayList;",
    "import java.util.LinkedHashMap;",
    "import java.util.List;",
    "import java.util.Map;",
    "import java.util.Objects;",
    "import java.util.Optional;",
    "import java.util.Set;",
    "import java.util.concurrent.ConcurrentHashMap;",
    "",
    "public final class ConfigurationService {",
    "    private final ConfigurationClient client;",
    "    private final Map<SettingKey, ConfigurationSetting> settingCache = new ConcurrentHashMap<>();",
    "    private final Map<PrefixQuery, List<PageCache>> prefixCache = new ConcurrentHashMap<>();",
    "    private final Set<SettingKey> requestedSettings = ConcurrentHashMap.newKeySet();",
    "    private final Set<PrefixQuery> requestedPrefixes = ConcurrentHashMap.newKeySet();",
    "",
    "    public ConfigurationService(ConfigurationClient client) {",
    "        this.client = Objects.requireNonNull(client, \"client\");",
    "    }",
    "",
    "    public Optional<String> getSetting(String key) {",
    "        return getSetting(key, null);",
    "    }",
    "",
    "    public Optional<String> getSetting(String key, String label) {",
    "        Objects.requireNonNull(key, \"key\");",
    "        SettingKey cacheKey = new SettingKey(key, label);",
    "        requestedSettings.add(cacheKey);",
    "        ConfigurationSetting cached = settingCache.get(cacheKey);",
    "        ConfigurationSetting request = cached == null",
    "            ? new ConfigurationSetting().setKey(key).setLabel(label)",
    "            : cached;",
    "",
    "        Response<ConfigurationSetting> response =",
    "            client.getConfigurationSettingWithResponse(request, null, cached != null, Context.NONE);",
    "        ConfigurationSetting current = response.getStatusCode() == 304 ? cached : response.getValue();",
    "        if (current != null) {",
    "            settingCache.put(cacheKey, current);",
    "        }",
    "        return Optional.ofNullable(current).map(ConfigurationSetting::getValue);",
    "    }",
    "",
    "    public Map<String, String> listSettings(String keyPrefix) {",
    "        return listSettings(keyPrefix, null);",
    "    }",
    "",
    "    public Map<String, String> listSettings(String keyPrefix, String label) {",
    "        Objects.requireNonNull(keyPrefix, \"keyPrefix\");",
    "        PrefixQuery query = new PrefixQuery(keyPrefix, label);",
    "        requestedPrefixes.add(query);",
    "        return loadPrefix(query);",
    "    }",
    "",
    "    public void refreshAll() {",
    "        List<SettingKey> settings = List.copyOf(requestedSettings);",
    "        List<PrefixQuery> prefixes = List.copyOf(requestedPrefixes);",
    "        settingCache.clear();",
    "        prefixCache.clear();",
    "        settings.forEach(setting -> getSetting(setting.key(), setting.label()));",
    "        prefixes.forEach(this::loadPrefix);",
    "    }",
    "",
    "    private synchronized Map<String, String> loadPrefix(PrefixQuery query) {",
    "        List<PageCache> oldPages = prefixCache.getOrDefault(query, List.of());",
    "        SettingSelector selector = new SettingSelector().setKeyFilter(escapeFilter(query.prefix()) + \"*\");",
    "        if (query.label() != null) {",
    "            selector.setLabelFilter(escapeFilter(query.label()));",
    "        }",
    "        if (!oldPages.isEmpty()) {",
    "            selector.setMatchConditions(oldPages.stream()",
    "                .map(page -> new MatchConditions().setIfNoneMatch(page.etag()))",
    "                .toList());",
    "        }",
    "",
    "        List<PageCache> newPages = new ArrayList<>();",
    "        int pageIndex = 0;",
    "        for (PagedResponse<ConfigurationSetting> page",
    "            : client.listConfigurationSettings(selector).iterableByPage()) {",
    "            PageCache oldPage = pageIndex < oldPages.size() ? oldPages.get(pageIndex) : null;",
    "            Map<String, String> values = new LinkedHashMap<>();",
    "            page.getValue().forEach(setting -> values.put(setting.getKey(), setting.getValue()));",
    "            if (page.getStatusCode() == 304 && oldPage != null) {",
    "                newPages.add(oldPage);",
    "            } else {",
    "                String etag = page.getHeaders().getValue(HttpHeaderName.ETAG);",
    "                newPages.add(new PageCache(etag, Map.copyOf(values)));",
    "            }",
    "            pageIndex++;",
    "        }",
    "        prefixCache.put(query, List.copyOf(newPages));",
    "        return flatten(newPages);",
    "    }",
    "",
    "    private static Map<String, String> flatten(List<PageCache> pages) {",
    "        Map<String, String> values = new LinkedHashMap<>();",
    "        pages.forEach(page -> values.putAll(page.values()));",
    "        return Map.copyOf(values);",
    "    }",
    "",
    "    private static String escapeFilter(String value) {",
    "        return value.replace(\"\\\\\", \"\\\\\\\\\").replace(\",\", \"\\\\,\").replace(\"*\", \"\\\\*\");",
    "    }",
    "",
    "    private record SettingKey(String key, String label) {",
    "    }",
    "",
    "    private record PrefixQuery(String prefix, String label) {",
    "    }",
    "",
    "    private record PageCache(String etag, Map<String, String> values) {",
    "    }",
    "}",
    ""
].join("\n"),
  [
    "package com.example.appconfig;",
    "",
    "import java.time.Duration;",
    "import java.util.LinkedHashMap;",
    "import java.util.List;",
    "import java.util.Map;",
    "import java.util.Objects;",
    "import java.util.Optional;",
    "import java.util.concurrent.Executors;",
    "import java.util.concurrent.ScheduledExecutorService;",
    "import java.util.concurrent.TimeUnit;",
    "import java.util.function.Consumer;",
    "",
    "public final class ConfigurationWatcher implements AutoCloseable {",
    "    private final ConfigurationService configuration;",
    "    private final List<String> sentinelKeys;",
    "    private final Duration pollingInterval;",
    "    private final String label;",
    "    private final Consumer<Throwable> errorHandler;",
    "    private final ScheduledExecutorService scheduler;",
    "    private final Map<String, Optional<String>> sentinelValues = new LinkedHashMap<>();",
    "",
    "    public ConfigurationWatcher(",
    "        ConfigurationService configuration,",
    "        List<String> sentinelKeys,",
    "        Duration pollingInterval",
    "    ) {",
    "        this(configuration, sentinelKeys, pollingInterval, null, Throwable::printStackTrace);",
    "    }",
    "",
    "    public ConfigurationWatcher(",
    "        ConfigurationService configuration,",
    "        List<String> sentinelKeys,",
    "        Duration pollingInterval,",
    "        String label,",
    "        Consumer<Throwable> errorHandler",
    "    ) {",
    "        this.configuration = Objects.requireNonNull(configuration, \"configuration\");",
    "        this.sentinelKeys = List.copyOf(sentinelKeys);",
    "        if (this.sentinelKeys.isEmpty()) {",
    "            throw new IllegalArgumentException(\"At least one sentinel key is required\");",
    "        }",
    "        this.pollingInterval = Objects.requireNonNull(pollingInterval, \"pollingInterval\");",
    "        if (pollingInterval.isZero() || pollingInterval.isNegative()) {",
    "            throw new IllegalArgumentException(\"Polling interval must be positive\");",
    "        }",
    "        this.label = label;",
    "        this.errorHandler = Objects.requireNonNull(errorHandler, \"errorHandler\");",
    "        this.scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {",
    "            Thread thread = new Thread(runnable, \"app-configuration-watcher\");",
    "            thread.setDaemon(true);",
    "            return thread;",
    "        });",
    "    }",
    "",
    "    public synchronized void start() {",
    "        if (!sentinelValues.isEmpty()) {",
    "            throw new IllegalStateException(\"Watcher has already been started\");",
    "        }",
    "        sentinelKeys.forEach(key -> sentinelValues.put(key, configuration.getSetting(key, label)));",
    "        scheduler.scheduleWithFixedDelay(",
    "            this::pollSafely,",
    "            pollingInterval.toMillis(),",
    "            pollingInterval.toMillis(),",
    "            TimeUnit.MILLISECONDS);",
    "    }",
    "",
    "    private void pollSafely() {",
    "        try {",
    "            boolean changed = false;",
    "            for (String key : sentinelKeys) {",
    "                Optional<String> current = configuration.getSetting(key, label);",
    "                Optional<String> previous = sentinelValues.put(key, current);",
    "                changed |= !Objects.equals(previous, current);",
    "            }",
    "            if (changed) {",
    "                configuration.refreshAll();",
    "            }",
    "        } catch (RuntimeException exception) {",
    "            errorHandler.accept(exception);",
    "        }",
    "    }",
    "",
    "    @Override",
    "    public void close() {",
    "        scheduler.shutdownNow();",
    "    }",
    "}",
    ""
].join("\n"),
  [
    "package com.example.appconfig;",
    "",
    "import com.azure.data.appconfiguration.models.FeatureFlagConfigurationSetting;",
    "import com.fasterxml.jackson.databind.JsonNode;",
    "import com.fasterxml.jackson.databind.ObjectMapper;",
    "",
    "import java.nio.ByteBuffer;",
    "import java.nio.charset.StandardCharsets;",
    "import java.security.MessageDigest;",
    "import java.security.NoSuchAlgorithmException;",
    "import java.util.Locale;",
    "import java.util.Objects;",
    "",
    "public final class FeatureFlagEvaluator {",
    "    private static final ObjectMapper JSON = new ObjectMapper();",
    "    private static final String PERCENTAGE_FILTER = \"Microsoft.Percentage\";",
    "    private final ConfigurationService configuration;",
    "",
    "    public FeatureFlagEvaluator(ConfigurationService configuration) {",
    "        this.configuration = Objects.requireNonNull(configuration, \"configuration\");",
    "    }",
    "",
    "    public boolean isEnabled(String flagId) {",
    "        return isEnabled(flagId, null, null);",
    "    }",
    "",
    "    public boolean isEnabled(String flagId, String userId) {",
    "        return isEnabled(flagId, userId, null);",
    "    }",
    "",
    "    public boolean isEnabled(String flagId, String userId, String label) {",
    "        String value = configuration",
    "            .getSetting(FeatureFlagConfigurationSetting.KEY_PREFIX + flagId, label)",
    "            .orElse(null);",
    "        return evaluate(flagId, userId, value);",
    "    }",
    "",
    "    static boolean evaluate(String flagId, String userId, String json) {",
    "        if (json == null) {",
    "            return false;",
    "        }",
    "        try {",
    "            JsonNode flag = JSON.readTree(json);",
    "            if (!flag.path(\"enabled\").asBoolean(false)) {",
    "                return false;",
    "            }",
    "            JsonNode filters = flag.path(\"conditions\").path(\"client_filters\");",
    "            for (JsonNode filter : filters) {",
    "                if (PERCENTAGE_FILTER.equalsIgnoreCase(filter.path(\"name\").asText())) {",
    "                    double percentage = readPercentage(filter.path(\"parameters\"));",
    "                    return userId != null && inRollout(flagId, userId, percentage);",
    "                }",
    "            }",
    "            return true;",
    "        } catch (Exception exception) {",
    "            throw new IllegalArgumentException(\"Invalid feature flag JSON for '\" + flagId + \"'\", exception);",
    "        }",
    "    }",
    "",
    "    private static double readPercentage(JsonNode parameters) {",
    "        JsonNode value = parameters.path(\"Value\");",
    "        if (value.isMissingNode()) {",
    "            value = parameters.path(\"value\");",
    "        }",
    "        double percentage = value.isNumber()",
    "            ? value.doubleValue()",
    "            : Double.parseDouble(value.asText());",
    "        if (percentage < 0.0 || percentage > 100.0) {",
    "            throw new IllegalArgumentException(\"Percentage rollout must be between 0 and 100\");",
    "        }",
    "        return percentage;",
    "    }",
    "",
    "    private static boolean inRollout(String flagId, String userId, double percentage) {",
    "        try {",
    "            byte[] digest = MessageDigest.getInstance(\"SHA-256\")",
    "                .digest((flagId + \":\" + userId).toLowerCase(Locale.ROOT)",
    "                    .getBytes(StandardCharsets.UTF_8));",
    "            long hash = ByteBuffer.wrap(digest).getLong() & Long.MAX_VALUE;",
    "            return hash % 10_000 < Math.round(percentage * 100.0);",
    "        } catch (NoSuchAlgorithmException exception) {",
    "            throw new IllegalStateException(\"SHA-256 is unavailable\", exception);",
    "        }",
    "    }",
    "}",
    ""
].join("\n"),
  [
    "package com.example.appconfig;",
    "",
    "import com.azure.core.credential.TokenCredential;",
    "import com.azure.data.appconfiguration.ConfigurationAsyncClient;",
    "import com.azure.data.appconfiguration.ConfigurationClient;",
    "import com.azure.data.appconfiguration.ConfigurationClientBuilder;",
    "import com.azure.identity.ManagedIdentityCredentialBuilder;",
    "",
    "import java.time.Duration;",
    "import java.util.List;",
    "",
    "public final class Main {",
    "    private static final String LABEL = \"production\";",
    "    private static final List<String> USERS = List.of(\"alice\", \"bob\", \"carol\");",
    "",
    "    private Main() {",
    "    }",
    "",
    "    public static void main(String[] args) throws InterruptedException {",
    "        String endpoint = requireEnvironment(\"APP_CONFIG_ENDPOINT\");",
    "        TokenCredential credential = new ManagedIdentityCredentialBuilder().build();",
    "",
    "        ConfigurationClient syncClient = new ConfigurationClientBuilder()",
    "            .endpoint(endpoint)",
    "            .credential(credential)",
    "            .buildClient();",
    "        runSyncDemo(new ConfigurationService(syncClient));",
    "",
    "        ConfigurationAsyncClient asyncClient = new ConfigurationClientBuilder()",
    "            .endpoint(endpoint)",
    "            .credential(credential)",
    "            .buildAsyncClient();",
    "        runAsyncDemo(new AsyncConfigurationService(asyncClient));",
    "    }",
    "",
    "    private static void runSyncDemo(ConfigurationService configuration) throws InterruptedException {",
    "        System.out.println(\"Sync implementation\");",
    "        print(\"App:Title\", configuration.getSetting(\"App:Title\"));",
    "        print(\"App:ApiBaseUrl [production]\", configuration.getSetting(\"App:ApiBaseUrl\", LABEL));",
    "        System.out.println(\"App settings: \" + configuration.listSettings(\"App:\", LABEL));",
    "",
    "        FeatureFlagEvaluator flags = new FeatureFlagEvaluator(configuration);",
    "        USERS.forEach(user -> System.out.printf(",
    "            \"BetaCheckout for %s: %s%n\", user, flags.isEnabled(\"BetaCheckout\", user, LABEL)));",
    "",
    "        try (ConfigurationWatcher watcher = new ConfigurationWatcher(",
    "            configuration,",
    "            List.of(\"App:Sentinel\"),",
    "            Duration.ofSeconds(5),",
    "            LABEL,",
    "            error -> System.err.println(\"Sync watcher failed: \" + error.getMessage())",
    "        )) {",
    "            watcher.start();",
    "            System.out.println(\"Sync watcher started; change App:Sentinel to trigger a full refresh.\");",
    "            Thread.sleep(Duration.ofSeconds(10).toMillis());",
    "        }",
    "    }",
    "",
    "    private static void runAsyncDemo(AsyncConfigurationService configuration) {",
    "        System.out.println(\"Async implementation\");",
    "        configuration.getSetting(\"App:Title\")",
    "            .doOnNext(value -> print(\"App:Title\", value))",
    "            .then(configuration.getSetting(\"App:ApiBaseUrl\", LABEL)",
    "                .doOnNext(value -> print(\"App:ApiBaseUrl [production]\", value)))",
    "            .then(configuration.listSettings(\"App:\", LABEL)",
    "                .doOnNext(values -> System.out.println(\"App settings: \" + values)))",
    "            .block();",
    "",
    "        AsyncFeatureFlagEvaluator flags = new AsyncFeatureFlagEvaluator(configuration);",
    "        reactor.core.publisher.Flux.fromIterable(USERS)",
    "            .concatMap(user -> flags.isEnabled(\"BetaCheckout\", user, LABEL)",
    "                .doOnNext(enabled -> System.out.printf(",
    "                    \"BetaCheckout for %s: %s%n\", user, enabled)))",
    "            .then()",
    "            .block();",
    "",
    "        try (AsyncConfigurationWatcher watcher = new AsyncConfigurationWatcher(",
    "            configuration,",
    "            List.of(\"App:Sentinel\"),",
    "            Duration.ofSeconds(5),",
    "            LABEL,",
    "            error -> System.err.println(\"Async watcher failed: \" + error.getMessage())",
    "        )) {",
    "            watcher.start();",
    "            System.out.println(\"Async watcher started; change App:Sentinel to trigger a full refresh.\");",
    "            reactor.core.publisher.Mono.delay(Duration.ofSeconds(10)).block();",
    "        }",
    "    }",
    "",
    "    private static void print(String name, java.util.Optional<String> value) {",
    "        System.out.printf(\"%s: %s%n\", name, value.orElse(\"<not set>\"));",
    "    }",
    "",
    "    private static String requireEnvironment(String name) {",
    "        String value = System.getenv(name);",
    "        if (value == null || value.isBlank()) {",
    "            throw new IllegalStateException(name + \" must contain the Azure App Configuration endpoint\");",
    "        }",
    "        return value;",
    "    }",
    "}",
    ""
].join("\n")
].join("\n"),
  build: [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<project xmlns=\"http://maven.apache.org/POM/4.0.0\"",
    "         xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"",
    "         xsi:schemaLocation=\"http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd\">",
    "    <modelVersion>4.0.0</modelVersion>",
    "",
    "    <groupId>com.example</groupId>",
    "    <artifactId>azure-app-configuration-demo</artifactId>",
    "    <version>1.0.0</version>",
    "",
    "    <properties>",
    "        <maven.compiler.release>17</maven.compiler.release>",
    "        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>",
    "    </properties>",
    "",
    "    <dependencies>",
    "        <dependency>",
    "            <groupId>com.azure</groupId>",
    "            <artifactId>azure-data-appconfiguration</artifactId>",
    "            <version>1.10.1</version>",
    "        </dependency>",
    "        <dependency>",
    "            <groupId>com.azure</groupId>",
    "            <artifactId>azure-identity</artifactId>",
    "            <version>1.18.5</version>",
    "        </dependency>",
    "        <dependency>",
    "            <groupId>com.fasterxml.jackson.core</groupId>",
    "            <artifactId>jackson-databind</artifactId>",
    "            <version>2.18.3</version>",
    "        </dependency>",
    "        <dependency>",
    "            <groupId>org.slf4j</groupId>",
    "            <artifactId>slf4j-simple</artifactId>",
    "            <version>2.0.17</version>",
    "            <scope>runtime</scope>",
    "        </dependency>",
    "    </dependencies>",
    "",
    "    <build>",
    "        <plugins>",
    "            <plugin>",
    "                <groupId>org.apache.maven.plugins</groupId>",
    "                <artifactId>maven-compiler-plugin</artifactId>",
    "                <version>3.13.0</version>",
    "            </plugin>",
    "            <plugin>",
    "                <groupId>org.codehaus.mojo</groupId>",
    "                <artifactId>exec-maven-plugin</artifactId>",
    "                <version>3.5.0</version>",
    "                <configuration>",
    "                    <mainClass>com.example.appconfig.Main</mainClass>",
    "                </configuration>",
    "            </plugin>",
    "        </plugins>",
    "    </build>",
    "</project>",
    ""
].join("\n"),
};

test("the Java 17 golden passes prompt and shared Java checks", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/source-manifest",
    "prompt/managed-identity-clients",
    "prompt/configuration-reads",
    "prompt/conditional-etag-reads",
    "prompt/feature-flag-json",
    "prompt/deterministic-rollout",
    "prompt/sentinel-refresh",
    "prompt/connected-sync-async-demo",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, golden), true, check);
  }
});

test("the Maven manifest requires Java 17 and both exact active pins", () => {
  for (const [from, to] of [
    ["<maven.compiler.release>17", "<maven.compiler.release>21"],
    ["<version>1.10.1</version>", "<version>1.10.0</version>"],
    ["<version>1.18.5</version>", "<version>1.18.4</version>"],
  ]) {
    assert.equal(
      evaluateRule("prompt/source-manifest", {
        ...golden,
        build: golden.build.replace(from, to),
      }),
      false,
      `${from} -> ${to}`,
    );
  }

  const duplicate = golden.build.replace(
    "</dependencies>",
    `<dependency>
       <groupId>com.azure</groupId>
       <artifactId>azure-identity</artifactId>
       <version>1.18.4</version>
     </dependency>
   </dependencies>`,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", { ...golden, build: duplicate }),
    false,
  );
});

test("the eval stimulus preserves the Hyoka task without solution recipes", () => {
  assert.match(
    evalSpec,
    /A \*\*configuration service class\*\* \(both sync and async versions\)/,
  );
  assert.match(
    evalSpec,
    /Feature flags in App Configuration use a special key prefix/,
  );
  assert.match(
    evalSpec,
    /Run the full demo with the sync implementation first, then repeat with the async implementation/,
  );
  assert.match(evalSpec, /azure-data-appconfiguration` to `1\.10\.1/);
  assert.match(evalSpec, /azure-identity` to `1\.18\.5/);
  assert.doesNotMatch(evalSpec, /getConfigurationSettingWithResponse/);
  assert.doesNotMatch(evalSpec, /setIfNoneMatch|Context\.NONE/);
});

test("comments, strings, fake SDK types, and unreachable helpers do not count", () => {
  const decoy = `
class ManagedIdentityCredentialBuilder {
  ManagedIdentityCredentialBuilder build() { return this; }
}
class ConfigurationClientBuilder {
  ConfigurationClientBuilder endpoint(String value) { return this; }
  ConfigurationClientBuilder credential(Object value) { return this; }
  ConfigurationClient buildClient() { return null; }
  ConfigurationAsyncClient buildAsyncClient() { return null; }
}
class ConfigurationClient {}
class ConfigurationAsyncClient {}
class Decoy {
  static void unused() {
    String prose = "getConfigurationSettingWithResponse(setting, null, true, Context.NONE)";
    // new ConfigurationClientBuilder().endpoint(System.getenv("AZURE_APPCONFIG_ENDPOINT"));
    if (false) {
      new ConfigurationClientBuilder().buildClient();
    }
  }
  public static void main(String[] args) {
  }
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(decoy)), false, rule);
  }

  const helpersDisconnected = golden.source
    .replace("        runSyncDemo(syncService);", "")
    .replace("        runAsyncDemo(asyncService).block();", "");
  for (const rule of [
    "prompt/configuration-reads",
    "prompt/conditional-etag-reads",
    "prompt/feature-flag-json",
    "prompt/sentinel-refresh",
    "prompt/connected-sync-async-demo",
  ]) {
    assert.equal(
      evaluateRule(rule, workspace(helpersDisconnected)),
      false,
      rule,
    );
  }
});

test("operations after return and disconnected decoys do not count", () => {
  const deadMain = golden.source.replace(
    "public static void main(String[] args) {",
    `public static void main(String[] args) {
        return;`,
  );
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(deadMain)), false, rule);
  }

  const without304 = golden.source.replaceAll(
    "response.getStatusCode() == 304",
    "response.getStatusCode() == 200",
  );
  const disconnected304 = `${without304}
class StatusDecoy {
    static boolean unused(com.azure.core.http.rest.Response<?> response) {
        if (response.getStatusCode() == 304) {
            return false;
        }
        throw new IllegalStateException();
    }
}`;
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(disconnected304),
    ),
    false,
  );

  const deadConditionalCall = golden.source.replace(
    /Response<ConfigurationSetting> response =\s*client\.getConfigurationSettingWithResponse\(/,
    `        return new ConditionalResult(false, cached);
        Response<ConfigurationSetting> response =
                client.getConfigurationSettingWithResponse(`,
  );
  assert.notEqual(deadConditionalCall, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(deadConditionalCall),
    ),
    false,
  );
});

test("workspace definitions in exact Azure SDK packages are rejected", () => {
  const shadow = `${golden.source}
package com.azure.data.appconfiguration;
public class ConfigurationClientBuilder {}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(shadow)), false, rule);
  }

  const missingSdkImport = golden.source.replace(
    "import com.azure.data.appconfiguration.ConfigurationClientBuilder;",
    'String importDecoy = "import com.azure.data.appconfiguration.ConfigurationClientBuilder;";',
  );
  assert.equal(
    evaluateRule(
      "prompt/managed-identity-clients",
      workspace(missingSdkImport),
    ),
    false,
  );
});

test("managed identity clients reject hardcoded endpoints and wrong credentials", () => {
  const hardcodedWithDecoy = golden.source
    .replace(
      'String endpoint = requireEnvironment("AZURE_APPCONFIG_ENDPOINT");',
      `String ignored = System.getenv("AZURE_APPCONFIG_ENDPOINT");
        String endpoint = "https://fixed.azconfig.io";`,
    );
  assert.equal(
    evaluateRule(
      "prompt/managed-identity-clients",
      workspace(hardcodedWithDecoy),
    ),
    false,
  );

  const lateDecoy = golden.source
    .replace(
      'String endpoint = requireEnvironment("AZURE_APPCONFIG_ENDPOINT");',
      'String endpoint = "https://fixed.azconfig.io";',
    )
    .replace(
      "ConfigurationAsyncClient asyncClient = builder.buildAsyncClient();",
      `ConfigurationAsyncClient asyncClient = builder.buildAsyncClient();
        endpoint = System.getenv("AZURE_APPCONFIG_ENDPOINT");`,
    );
  assert.equal(
    evaluateRule("prompt/managed-identity-clients", workspace(lateDecoy)),
    false,
  );

  const defaultCredential = golden.source
    .replace(
      "import com.azure.identity.ManagedIdentityCredentialBuilder;",
      "import com.azure.identity.DefaultAzureCredentialBuilder;",
    )
    .replaceAll(
      "ManagedIdentityCredentialBuilder",
      "DefaultAzureCredentialBuilder",
    );
  assert.equal(
    evaluateRule(
      "prompt/managed-identity-clients",
      workspace(defaultCredential),
    ),
    false,
  );

  const renamedSourceHelper = golden.source.replaceAll(
    "requireEnvironment",
    "readConfiguredEndpoint",
  );
  assert.equal(
    evaluateRule(
      "prompt/managed-identity-clients",
      workspace(renamedSourceHelper),
    ),
    true,
  );
});

test("real 1.10.1 conditional overloads and both outcomes are required", () => {
  const wrongSync = golden.source.replace(
    "request, null, true, Context.NONE",
    "request, null, true",
  );
  assert.equal(
    evaluateRule("prompt/conditional-etag-reads", workspace(wrongSync)),
    false,
  );

  const nonexistentAsync = golden.source.replace(
    /request, null, true\)\s*\.map\(response/,
    "request, null, true, Context.NONE).map(response",
  );
  assert.notEqual(nonexistentAsync, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(nonexistentAsync),
    ),
    false,
  );

  const noNotModified = golden.source.replaceAll(
    "response.getStatusCode() == 304",
    "response.getStatusCode() == 200",
  );
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(noNotModified),
    ),
    false,
  );
});

test("conditional reads preserve baseline, 304, replacement, and error semantics", () => {
  const firstReadChanged = golden.source
    .replace(
      "new ConditionalResult(false, getDirect(key, label))",
      "new ConditionalResult(true, getDirect(key, label))",
    )
    .replace(
      "new ConditionalResult(false, setting));",
      "new ConditionalResult(true, setting));",
    );
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(firstReadChanged),
    ),
    false,
  );

  const modified304 = golden.source.replaceAll(
    "new ConditionalResult(false, cached)",
    "new ConditionalResult(true, response.getValue())",
  );
  assert.equal(
    evaluateRule("prompt/conditional-etag-reads", workspace(modified304)),
    false,
  );

  const noReplacement = golden.source.replaceAll(
    "cache.put(cacheKey(key, label), changed);",
    "",
  );
  assert.equal(
    evaluateRule("prompt/conditional-etag-reads", workspace(noReplacement)),
    false,
  );

  const swallowedErrors = golden.source.replaceAll(
    /if \(response\.getStatusCode\(\) < 200 \|\| response\.getStatusCode\(\) >= 300\) \{\s*throw new IllegalStateException\(\s*"Unexpected App Configuration status: "\s*\+ response\.getStatusCode\(\)\);\s*\}/g,
    "",
  );
  assert.notEqual(swallowedErrors, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(swallowedErrors),
    ),
    false,
  );
});

test("feature flags require the official prefix and parsed JSON payload", () => {
  const wrongPrefix = golden.source.replace(
    '".appconfig.featureflag/"',
    '"features/"',
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(wrongPrefix)),
    false,
  );

  const noParsing = golden.source.replace(
    "BinaryData.fromString(json).toObject(Map.class)",
    "Map.of(\"enabled\", true)",
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(noParsing)),
    false,
  );
});

test("the feature flag enabled state controls the result", () => {
  const ignoredEnabled = golden.source.replace(
    /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
    'document.get("enabled");',
  );
  assert.notEqual(ignoredEnabled, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(ignoredEnabled)),
    false,
  );

  const alternateControl = golden.source.replace(
    /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
    `boolean active = Boolean.TRUE.equals(document.get("enabled"));
        if (active) {
        } else {
            return false;
        }`,
  );
  assert.notEqual(alternateControl, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(alternateControl)),
    true,
  );

  const directGuard = golden.source.replace(
    /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
    'if (!Boolean.TRUE.equals(document.get("enabled"))) return false;',
  );
  assert.notEqual(directGuard, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(directGuard)),
    true,
  );

  const fixedRegardlessOfEnabled = golden.source
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      'boolean active = Boolean.TRUE.equals(document.get("enabled"));',
    )
    .replace(
      "return rolloutBucket(flagId, userId) < percentage;",
      `return active
                    ? rolloutBucket(flagId, userId) < 50
                    : rolloutBucket(flagId, userId) < 50;`,
    );
  assert.notEqual(fixedRegardlessOfEnabled, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/feature-flag-json",
      workspace(fixedRegardlessOfEnabled),
    ),
    false,
  );

  const meaningfulTernary = golden.source
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      'boolean active = Boolean.TRUE.equals(document.get("enabled"));',
    )
    .replace(
      "return rolloutBucket(flagId, userId) < percentage;",
      `return active
                    ? rolloutBucket(flagId, userId) < percentage
                    : false;`,
    );
  assert.notEqual(meaningfulTernary, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(meaningfulTernary)),
    true,
  );
});

test("enabled tautologies do not control Java feature results", () => {
  const tautology = golden.source
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      'boolean active = Boolean.TRUE.equals(document.get("enabled"));',
    )
    .replace(
      "return rolloutBucket(flagId, userId) < percentage;",
      "return (active || !active) && rolloutBucket(flagId, userId) < percentage;",
    );
  assert.notEqual(tautology, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(tautology)),
    false,
  );

  const enabledOrCheck = golden.source
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      'boolean active = Boolean.TRUE.equals(document.get("enabled"));',
    )
    .replace(
      "return rolloutBucket(flagId, userId) < percentage;",
      `boolean check1 = rolloutBucket(flagId, userId) < percentage;
            boolean check2 = percentage >= 0;
            return (active || check1) && check2;`,
    );
  assert.notEqual(enabledOrCheck, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(enabledOrCheck)),
    false,
  );
});

test("enabled helper guards remain valid in Java", () => {
  const helperGuard = golden.source
    .replace(
      '    @SuppressWarnings("unchecked")',
      `    static boolean flagIsActive(Map<String, Object> document) {
        return Boolean.TRUE.equals(document.get("enabled"));
    }

    @SuppressWarnings("unchecked")`,
    )
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      `if (!flagIsActive(document)) {
            return false;
        }`,
    );
  assert.notEqual(helperGuard, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(helperGuard)),
    true,
  );
});

test("percentage rollout depends on both flag and user with a stable digest", () => {
  const random = golden.source.replace(
    /try \{\s*MessageDigest digest[\s\S]*?\} catch \(NoSuchAlgorithmException exception\) \{[\s\S]*?\}/,
    "return (int) (Math.random() * 100);",
  );
  assert.equal(
    evaluateRule("prompt/deterministic-rollout", workspace(random)),
    false,
  );

  const alternateHash = golden.source.replace(
    /try \{\s*MessageDigest digest[\s\S]*?\} catch \(NoSuchAlgorithmException exception\) \{[\s\S]*?\}/,
    `return Math.floorMod(
            (flagId + ":" + userId).hashCode(), 100);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-rollout",
      workspace(alternateHash),
    ),
    false,
  );

  const constant = golden.source.replace(
    /try \{\s*MessageDigest digest[\s\S]*?\} catch \(NoSuchAlgorithmException exception\) \{[\s\S]*?\}/,
    "return 17;",
  );
  assert.equal(
    evaluateRule("prompt/deterministic-rollout", workspace(constant)),
    false,
  );

  for (const input of ["flagId", "userId"]) {
    const independent = golden.source.replace(
      '(flagId + ":" + userId).getBytes(StandardCharsets.UTF_8)',
      `${input}.getBytes(StandardCharsets.UTF_8)`,
    );
    assert.equal(
      evaluateRule(
        "prompt/deterministic-rollout",
        workspace(independent),
      ),
      false,
      input,
    );
  }

  const renamedHelper = golden.source
    .replaceAll("rolloutBucket", "stableCohort")
    .replace(
      "static int stableCohort(String flagId, String userId)",
      "static int stableCohort(String featureName, String subjectId)",
    )
    .replace(
      '(flagId + ":" + userId).getBytes(StandardCharsets.UTF_8)',
      '(featureName + ":" + subjectId).getBytes(StandardCharsets.UTF_8)',
    );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-rollout",
      workspace(renamedHelper),
    ),
    true,
  );

  const combinedInputHelper = golden.source
    .replace(
      "rolloutBucket(flagId, userId)",
      'stableDigest(flagId + ":" + userId)',
    )
    .replace(
      "static int rolloutBucket(String flagId, String userId)",
      "static int stableDigest(String cohortKey)",
    )
    .replace(
      '(flagId + ":" + userId).getBytes(StandardCharsets.UTF_8)',
      "cohortKey.getBytes(StandardCharsets.UTF_8)",
    );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-rollout",
      workspace(combinedInputHelper),
    ),
    true,
  );
});

test("sentinel refresh requires interval polling and change-gated refresh", () => {
  const noInterval = golden.source.replaceAll(
    "pollingInterval.toMillis()",
    "1000L",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(noInterval)),
    false,
  );

  const noConditionalRefresh = golden.source
    .replace(
      /if \(changed\) \{\s*syncService\.refreshPrefix\(refreshPrefix\);\s*\}/,
      "syncService.refreshPrefix(refreshPrefix);",
    )
    .replace(
      /changed\s*\?\s*asyncService\.refreshPrefixAsync\(refreshPrefix\)\s*:\s*Mono\.empty\(\)/,
      "asyncService.refreshPrefixAsync(refreshPrefix)",
    );
  assert.notEqual(noConditionalRefresh, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/sentinel-refresh",
      workspace(noConditionalRefresh),
    ),
    false,
  );
});

test("fixed-rate scheduling and renamed watcher helpers are accepted", () => {
  const fixedRate = golden.source.replaceAll(
    "scheduleWithFixedDelay",
    "scheduleAtFixedRate",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(fixedRate)),
    true,
  );

  const renamed = golden.source
    .replaceAll("checkOnceAsync", "pollSentinelsReactive")
    .replaceAll("checkOnce", "pollSentinels")
    .replaceAll("sentinelChangedAsync", "hasSentinelMovedReactive")
    .replaceAll("sentinelChanged", "hasSentinelMoved")
    .replaceAll("refreshPrefixAsync", "reloadCachedPrefixReactive")
    .replaceAll("refreshPrefix", "reloadCachedPrefix")
    .replaceAll("startAsync", "beginReactivePolling")
    .replaceAll("start", "beginPolling");
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(renamed)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/connected-sync-async-demo", workspace(renamed)),
    true,
  );
});

test("watcher lifecycle guards duplicate starts and cancels scheduled work", () => {
  const duplicateStarts = golden.source.replaceAll(
    /if \(isRunning\(\)\) \{\s*return;\s*\}/g,
    "",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(duplicateStarts)),
    false,
  );

  const leakedTask = golden.source.replace(
    "pollingTask.cancel(true);",
    "pollingTask.isCancelled();",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(leakedTask)),
    false,
  );

  const leakedSubscription = golden.source.replace(
    "asyncPoll.dispose();",
    "asyncPoll.isDisposed();",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(leakedSubscription)),
    false,
  );

  const immediateClose = golden.source
    .replace(/\s*watcher\.awaitFirstPoll\(\);/, "")
    .replace(/\.then\(watcher\.awaitFirstPollAsync\(\)\)/, "");
  assert.notEqual(immediateClose, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/connected-sync-async-demo",
      workspace(immediateClose),
    ),
    false,
  );
});

test("sync and async demos must be connected, ordered, and consumed", () => {
  const unblocked = golden.source.replace(
    "runAsyncDemo(asyncService).block();",
    "runAsyncDemo(asyncService);",
  );
  assert.equal(
    evaluateRule("prompt/connected-sync-async-demo", workspace(unblocked)),
    false,
  );

  const asyncFirst = golden.source
    .replace("runSyncDemo(syncService);", "__SYNC_DEMO__")
    .replace(
      "runAsyncDemo(asyncService).block();",
      `runSyncDemo(syncService);
        __ASYNC_DEMO__`,
    )
    .replace("__SYNC_DEMO__", "runAsyncDemo(asyncService).block();")
    .replace("__ASYNC_DEMO__", "");
  assert.equal(
    evaluateRule("prompt/connected-sync-async-demo", workspace(asyncFirst)),
    false,
  );

  const incompatible = golden.source
    .replace("runAsyncDemo(asyncService).block();", "")
    .replace(
      "runSyncDemo(syncService);",
      `if (System.nanoTime() > 0) {
            runSyncDemo(syncService);
        } else {
            runAsyncDemo(asyncService).block();
        }`,
    );
  assert.equal(
    evaluateRule(
      "prompt/connected-sync-async-demo",
      workspace(incompatible),
    ),
    false,
  );
});

test("legitimate direct label reads and equivalent condition polarity pass", () => {
  const directLabels = golden.source
    .replace(
      /SettingSelector selector = new SettingSelector\(\)\s*\.setKeyFilter\(key\)\s*\.setLabelFilter\(label\);\s*ConfigurationSetting setting = client\.listConfigurationSettings\(selector\)[\s\S]*?cache\.put\(cacheKey\(key, label\), setting\);/,
      `ConfigurationSetting setting =
                client.getConfigurationSetting(key, label);
        cache.put(cacheKey(key, label), setting);`,
    )
    .replace(
      /SettingSelector selector = new SettingSelector\(\)\s*\.setKeyFilter\(key\)\s*\.setLabelFilter\(label\);\s*return client\.listConfigurationSettings\(selector\)[\s\S]*?\.doOnNext\(setting ->\s*cache\.put\(cacheKey\(setting\.getKey\(\), setting\.getLabel\(\)\), setting\)\);/,
      `return client.getConfigurationSetting(key, label)
                .doOnNext(setting ->
                        cache.put(cacheKey(setting.getKey(), setting.getLabel()), setting));`,
    )
    .replaceAll(
      "response.getStatusCode() == 304",
      "304 == response.getStatusCode()",
    );
  assert.equal(
    evaluateRule("prompt/configuration-reads", workspace(directLabels)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/conditional-etag-reads", workspace(directLabels)),
    true,
  );
});

test("all prompt graders reject an empty generated workspace", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, {
        sourceFiles: [],
        buildFiles: ["pom.xml"],
        source: "",
        build: golden.build,
      }),
      false,
      rule,
    );
  }
});

test("baseline run 33374429826 exact App Configuration output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, baseline33374429826), true, check);
  }
});
