using Azure;
using Azure.Data.AppConfiguration;

string connectionString =
    Environment.GetEnvironmentVariable("AZURE_APPCONFIG_CONNECTION_STRING")
    ?? throw new InvalidOperationException(
        "Set AZURE_APPCONFIG_CONNECTION_STRING before running.");

var client = new ConfigurationClient(connectionString);
const string key = "app:Settings:FontSize";

try
{
    await client.SetConfigurationSettingAsync(key, "24");
    await client.SetConfigurationSettingAsync(key, "24", "Production");

    Response<ConfigurationSetting> response =
        await client.GetConfigurationSettingAsync(key);
    Console.WriteLine(response.Value.Value);

    var selector = new SettingSelector
    {
        KeyFilter = "app:Settings:*",
    };
    await foreach (ConfigurationSetting setting
        in client.GetConfigurationSettingsAsync(selector))
    {
        Console.WriteLine($"{setting.Key}={setting.Value}");
    }

    var featureFlag = new FeatureFlagConfigurationSetting(
        "BetaFeature",
        isEnabled: true);
    await client.SetConfigurationSettingAsync(featureFlag);
    await client.DeleteConfigurationSettingAsync(key);
}
catch (RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"App Configuration request failed with status {exception.Status}: "
        + exception.Message);
    Environment.ExitCode = 1;
}
