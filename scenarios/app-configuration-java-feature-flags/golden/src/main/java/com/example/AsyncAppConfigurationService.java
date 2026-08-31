package com.example;

import com.azure.core.http.rest.Response;
import com.azure.data.appconfiguration.ConfigurationAsyncClient;
import com.azure.data.appconfiguration.models.ConfigurationSetting;
import com.azure.data.appconfiguration.models.SettingSelector;
import reactor.core.publisher.Mono;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class AsyncAppConfigurationService {
    private final ConfigurationAsyncClient client;
    private final Map<String, ConfigurationSetting> cache = new ConcurrentHashMap<>();

    public AsyncAppConfigurationService(ConfigurationAsyncClient client) {
        this.client = client;
    }

    public Mono<ConfigurationSetting> getSettingAsync(String key) {
        return client.getConfigurationSetting(key, null)
                .doOnNext(setting ->
                        cache.put(cacheKey(setting.getKey(), setting.getLabel()), setting));
    }

    public Mono<ConfigurationSetting> getSettingAsync(String key, String label) {
        SettingSelector selector = new SettingSelector()
                .setKeyFilter(key)
                .setLabelFilter(label);
        return client.listConfigurationSettings(selector)
                .next()
                .switchIfEmpty(Mono.error(new IllegalStateException(
                        "Missing App Configuration setting: " + key + "@" + label)))
                .doOnNext(setting ->
                        cache.put(cacheKey(setting.getKey(), setting.getLabel()), setting));
    }

    public Mono<Map<String, String>> getSettingsByPrefixAsync(String prefix) {
        SettingSelector selector = new SettingSelector().setKeyFilter(prefix + "*");
        return client.listConfigurationSettings(selector)
                .doOnNext(setting ->
                        cache.put(cacheKey(setting.getKey(), setting.getLabel()), setting))
                .collectMap(ConfigurationSetting::getKey, ConfigurationSetting::getValue);
    }

    public Mono<ConditionalResult> getIfChangedAsync(String key, String label) {
        ConfigurationSetting cached = cache.get(cacheKey(key, label));
        if (cached == null || cached.getETag() == null) {
            return client.getConfigurationSetting(key, label)
                    .doOnNext(setting -> cache.put(cacheKey(key, label), setting))
                    .map(setting -> new ConditionalResult(false, setting));
        }

        ConfigurationSetting request = new ConfigurationSetting()
                .setKey(key)
                .setLabel(label)
                .setETag(cached.getETag());
        return client.getConfigurationSettingWithResponse(
                        request, null, true)
                .map(response -> conditionalResult(response, cached, key, label));
    }

    public Mono<Boolean> sentinelChangedAsync(String key) {
        return getIfChangedAsync(key, null).map(ConditionalResult::modified);
    }

    public Mono<Void> refreshPrefixAsync(String prefix) {
        return getSettingsByPrefixAsync(prefix).then();
    }

    private ConditionalResult conditionalResult(
            Response<ConfigurationSetting> response,
            ConfigurationSetting cached,
            String key,
            String label) {
        if (response.getStatusCode() == 304) {
            return new ConditionalResult(false, cached);
        }
        if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
            throw new IllegalStateException(
                    "Unexpected App Configuration status: "
                            + response.getStatusCode());
        }
        ConfigurationSetting changed = response.getValue();
        cache.put(cacheKey(key, label), changed);
        return new ConditionalResult(true, changed);
    }

    private static String cacheKey(String key, String label) {
        return key + "\u0000" + (label == null ? "" : label);
    }

    public record ConditionalResult(boolean modified, ConfigurationSetting setting) {
    }
}
