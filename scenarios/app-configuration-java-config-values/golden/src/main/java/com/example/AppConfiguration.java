package com.example;

import com.azure.core.exception.HttpResponseException;
import com.azure.data.appconfiguration.ConfigurationClient;
import com.azure.data.appconfiguration.ConfigurationClientBuilder;
import com.azure.data.appconfiguration.models.ConfigurationSetting;
import com.azure.data.appconfiguration.models.FeatureFlagConfigurationSetting;
import com.azure.data.appconfiguration.models.SettingSelector;

public final class AppConfiguration {
    private AppConfiguration() {
    }

    public static void main(String[] args) {
        String connectionString =
                requireEnvironment("AZURE_APPCONFIG_CONNECTION_STRING");
        ConfigurationClient client = new ConfigurationClientBuilder()
                .connectionString(connectionString)
                .buildClient();
        String key = "app:Settings:FontSize";

        try {
            client.setConfigurationSetting(key, null, "24");
            client.setConfigurationSetting(key, "Production", "24");

            ConfigurationSetting setting =
                    client.getConfigurationSetting(key, null);
            System.out.println(setting.getValue());

            SettingSelector selector =
                    new SettingSelector().setKeyFilter("app:Settings:*");
            client.listConfigurationSettings(selector).forEach(item ->
                    System.out.println(item.getKey() + "=" + item.getValue()));

            client.setConfigurationSetting(
                    new FeatureFlagConfigurationSetting("BetaFeature", true));
            client.deleteConfigurationSetting(key, null);
        } catch (HttpResponseException exception) {
            System.err.printf(
                    "App Configuration request failed with status %d: %s%n",
                    exception.getResponse().getStatusCode(),
                    exception.getMessage());
            System.exit(1);
        }
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
