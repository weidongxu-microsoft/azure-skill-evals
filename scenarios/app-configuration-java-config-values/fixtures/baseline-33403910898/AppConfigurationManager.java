import com.azure.core.exception.HttpResponseException;
import com.azure.data.appconfiguration.ConfigurationClient;
import com.azure.data.appconfiguration.ConfigurationClientBuilder;
import com.azure.data.appconfiguration.models.ConfigurationSetting;
import com.azure.data.appconfiguration.models.FeatureFlagConfigurationSetting;
import com.azure.data.appconfiguration.models.SettingSelector;

public final class AppConfigurationManager {
    private static final String CONNECTION_STRING_ENV = "AZURE_APP_CONFIGURATION_CONNECTION_STRING";
    private static final String FONT_SIZE_KEY = "app:Settings:FontSize";
    private static final String FONT_SIZE_VALUE = "24";

    private AppConfigurationManager() {
    }

    public static void main(String[] args) {
        String connectionString = System.getenv(CONNECTION_STRING_ENV);
        if (connectionString == null || connectionString.isBlank()) {
            System.err.printf("Set the %s environment variable.%n", CONNECTION_STRING_ENV);
            return;
        }

        ConfigurationClient client = new ConfigurationClientBuilder()
            .connectionString(connectionString)
            .buildClient();

        try {
            client.setConfigurationSetting(FONT_SIZE_KEY, null, FONT_SIZE_VALUE);
            client.setConfigurationSetting(FONT_SIZE_KEY, "Production", FONT_SIZE_VALUE);

            ConfigurationSetting fontSize = client.getConfigurationSetting(FONT_SIZE_KEY, null);
            System.out.printf("%s=%s%n", fontSize.getKey(), fontSize.getValue());

            SettingSelector selector = new SettingSelector().setKeyFilter("app:Settings:*");
            for (ConfigurationSetting setting : client.listConfigurationSettings(selector)) {
                System.out.printf(
                    "key=%s, label=%s, value=%s%n",
                    setting.getKey(),
                    setting.getLabel(),
                    setting.getValue());
            }

            FeatureFlagConfigurationSetting betaFeature =
                new FeatureFlagConfigurationSetting("BetaFeature", true);
            client.setConfigurationSetting(betaFeature);

            client.deleteConfigurationSetting(FONT_SIZE_KEY, null);
        } catch (HttpResponseException exception) {
            int statusCode = exception.getResponse().getStatusCode();
            System.err.printf("Azure App Configuration request failed with HTTP %d: %s%n",
                statusCode, exception.getMessage());

            if (statusCode == 401 || statusCode == 403) {
                System.err.println("Check the connection string and data-plane permissions.");
            } else if (statusCode == 404) {
                System.err.println("The requested configuration setting was not found.");
            }
        }
    }
}
