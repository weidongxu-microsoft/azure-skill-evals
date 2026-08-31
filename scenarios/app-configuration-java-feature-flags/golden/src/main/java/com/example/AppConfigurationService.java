package com.example;

import com.azure.core.http.rest.Response;
import com.azure.core.util.Context;
import com.azure.data.appconfiguration.ConfigurationClient;
import com.azure.data.appconfiguration.models.ConfigurationSetting;
import com.azure.data.appconfiguration.models.SettingSelector;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

public final class AppConfigurationService {
    private final ConfigurationClient client;
    private final Map<String, ConfigurationSetting> cache = new ConcurrentHashMap<>();

    public AppConfigurationService(ConfigurationClient client) {
        this.client = client;
    }

    public ConfigurationSetting getSetting(String key) {
        ConfigurationSetting setting = client.getConfigurationSetting(key, null);
        cache.put(cacheKey(key, null), setting);
        return setting;
    }

    public ConfigurationSetting getSetting(String key, String label) {
        SettingSelector selector = new SettingSelector()
                .setKeyFilter(key)
                .setLabelFilter(label);
        ConfigurationSetting setting = client.listConfigurationSettings(selector)
                .stream()
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "Missing App Configuration setting: " + key + "@" + label));
        cache.put(cacheKey(key, label), setting);
        return setting;
    }

    public Map<String, String> getSettingsByPrefix(String prefix) {
        Map<String, String> values = new LinkedHashMap<>();
        SettingSelector selector = new SettingSelector().setKeyFilter(prefix + "*");
        client.listConfigurationSettings(selector).forEach(setting -> {
            values.put(setting.getKey(), setting.getValue());
            cache.put(cacheKey(setting.getKey(), setting.getLabel()), setting);
        });
        return values;
    }

    public ConditionalResult getIfChanged(String key, String label) {
        ConfigurationSetting cached = cache.get(cacheKey(key, label));
        if (cached == null || cached.getETag() == null) {
            return new ConditionalResult(false, getDirect(key, label));
        }

        ConfigurationSetting request = new ConfigurationSetting()
                .setKey(key)
                .setLabel(label)
                .setETag(cached.getETag());
        Response<ConfigurationSetting> response =
                client.getConfigurationSettingWithResponse(
                        request, null, true, Context.NONE);
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

    public boolean sentinelChanged(String key) {
        ConditionalResult result = getIfChanged(key, null);
        return result.modified();
    }

    public void refreshPrefix(String prefix) {
        getSettingsByPrefix(prefix);
    }

    public Optional<ConfigurationSetting> cached(String key, String label) {
        return Optional.ofNullable(cache.get(cacheKey(key, label)));
    }

    private ConfigurationSetting getDirect(String key, String label) {
        ConfigurationSetting setting = client.getConfigurationSetting(key, label);
        cache.put(cacheKey(key, label), setting);
        return setting;
    }

    private static String cacheKey(String key, String label) {
        return key + "\u0000" + (label == null ? "" : label);
    }

    public record ConditionalResult(boolean modified, ConfigurationSetting setting) {
    }
}
