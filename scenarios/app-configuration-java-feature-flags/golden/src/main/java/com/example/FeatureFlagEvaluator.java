package com.example;

import com.azure.core.util.BinaryData;
import com.azure.data.appconfiguration.models.ConfigurationSetting;
import reactor.core.publisher.Mono;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Map;

public final class FeatureFlagEvaluator {
    public static final String FEATURE_FLAG_PREFIX = ".appconfig.featureflag/";

    private final AppConfigurationService syncService;
    private final AsyncAppConfigurationService asyncService;

    public FeatureFlagEvaluator(AppConfigurationService syncService) {
        this.syncService = syncService;
        this.asyncService = null;
    }

    public FeatureFlagEvaluator(AsyncAppConfigurationService asyncService) {
        this.syncService = null;
        this.asyncService = asyncService;
    }

    public boolean isEnabled(String flagId, String userId) {
        ConfigurationSetting setting =
                syncService.getSetting(FEATURE_FLAG_PREFIX + flagId);
        return evaluate(setting.getValue(), flagId, userId);
    }

    public Mono<Boolean> isEnabledAsync(String flagId, String userId) {
        return asyncService.getSettingAsync(FEATURE_FLAG_PREFIX + flagId)
                .map(setting -> evaluate(setting.getValue(), flagId, userId));
    }

    @SuppressWarnings("unchecked")
    static boolean evaluate(String json, String flagId, String userId) {
        Map<String, Object> document =
                BinaryData.fromString(json).toObject(Map.class);
        if (!Boolean.TRUE.equals(document.get("enabled"))) {
            return false;
        }

        Object conditionsValue = document.get("conditions");
        if (!(conditionsValue instanceof Map<?, ?> conditions)) {
            return true;
        }
        Object filtersValue = conditions.get("client_filters");
        if (!(filtersValue instanceof List<?> filters)) {
            return true;
        }
        for (Object value : filters) {
            if (!(value instanceof Map<?, ?> filter)
                    || !"Microsoft.Percentage".equals(filter.get("name"))) {
                continue;
            }
            Object parametersValue = filter.get("parameters");
            if (!(parametersValue instanceof Map<?, ?> parameters)) {
                continue;
            }
            double percentage = Double.parseDouble(
                    String.valueOf(parameters.get("Value")));
            return rolloutBucket(flagId, userId) < percentage;
        }
        return true;
    }

    static int rolloutBucket(String flagId, String userId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(
                    (flagId + ":" + userId).getBytes(StandardCharsets.UTF_8));
            long value = ByteBuffer.wrap(hash).getLong();
            return Math.floorMod(value, 100);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is required by Java", exception);
        }
    }
}
