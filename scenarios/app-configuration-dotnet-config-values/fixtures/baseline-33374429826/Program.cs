using Azure;
using Azure.Data.AppConfiguration;

const string connectionStringEnvironmentVariable = "AZURE_APP_CONFIGURATION_CONNECTION_STRING";
const string settingKey = "app:Settings:FontSize";
const string settingValue = "24";
const string productionLabel = "Production";

string? connectionString = Environment.GetEnvironmentVariable(connectionStringEnvironmentVariable);
if (string.IsNullOrWhiteSpace(connectionString))
{
    Console.Error.WriteLine(
        $"Set the {connectionStringEnvironmentVariable} environment variable to an Azure App Configuration connection string.");
    return 1;
}

try
{
    ConfigurationClient client = new(connectionString);

    client.SetConfigurationSetting(new ConfigurationSetting(settingKey, settingValue));
    client.SetConfigurationSetting(
        new ConfigurationSetting(settingKey, settingValue, productionLabel));

    ConfigurationSetting setting = client.GetConfigurationSetting(settingKey);
    Console.WriteLine($"{setting.Key} = {setting.Value}");

    SettingSelector selector = new()
    {
        KeyFilter = "app:Settings:*"
    };

    Console.WriteLine("Matching settings:");
    foreach (ConfigurationSetting matchingSetting in client.GetConfigurationSettings(selector))
    {
        string label = matchingSetting.Label is null ? "(no label)" : matchingSetting.Label;
        Console.WriteLine($"{matchingSetting.Key} [{label}] = {matchingSetting.Value}");
    }

    FeatureFlagConfigurationSetting featureFlag = new("BetaFeature", isEnabled: true);
    client.SetConfigurationSetting(featureFlag);

    client.DeleteConfigurationSetting(settingKey);
    Console.WriteLine($"Deleted setting '{settingKey}'.");

    return 0;
}
catch (RequestFailedException exception) when (exception.Status == 404)
{
    Console.Error.WriteLine($"A requested configuration setting was not found: {exception.Message}");
    return 2;
}
catch (RequestFailedException exception) when (exception.Status is 401 or 403)
{
    Console.Error.WriteLine(
        $"Azure App Configuration rejected the credentials (HTTP {exception.Status}): {exception.Message}");
    return 3;
}
catch (RequestFailedException exception) when (exception.Status == 429)
{
    Console.Error.WriteLine($"Azure App Configuration throttled the request (HTTP 429): {exception.Message}");
    return 4;
}
catch (RequestFailedException exception) when (exception.Status >= 500)
{
    Console.Error.WriteLine(
        $"Azure App Configuration returned a service error (HTTP {exception.Status}): {exception.Message}");
    return 5;
}
catch (RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"Azure App Configuration request failed (HTTP {exception.Status}, error code '{exception.ErrorCode}'): {exception.Message}");
    return 6;
}
