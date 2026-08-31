using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

string vaultUrl = Environment.GetEnvironmentVariable("AZURE_KEY_VAULT_URL")
    ?? throw new InvalidOperationException(
        "Set AZURE_KEY_VAULT_URL to the vault endpoint.");
string secretName = args.Length > 1 ? args[1] : "sample-secret";

var options = new SecretClientOptions
{
    Retry =
    {
        Delay = TimeSpan.FromSeconds(1),
        MaxDelay = TimeSpan.FromSeconds(16),
        MaxRetries = 5,
        Mode = RetryMode.Exponential,
        NetworkTimeout = TimeSpan.FromSeconds(30),
    },
};
var client = new SecretClient(
    new Uri(vaultUrl),
    new DefaultAzureCredential(),
    options);

switch (args.FirstOrDefault()?.ToLowerInvariant())
{
    case "set":
        await SetSecretAsync(client, secretName);
        break;
    case "purge":
        await PurgeDeletedSecretAsync(client, secretName);
        break;
    default:
        await GetSecretAsync(client, secretName);
        break;
}

static async Task GetSecretAsync(SecretClient client, string secretName)
{
    try
    {
        Response<KeyVaultSecret> response =
            await client.GetSecretAsync(secretName);
        Console.WriteLine(response.Value.Value);
    }
    catch (RequestFailedException failure)
    {
        ReportFailure(failure);
        switch (failure.Status)
        {
            case 403:
                DiagnoseAccessDenied();
                return;
            case 404:
                await DiagnoseMissingSecretAsync(client, secretName);
                return;
            case 429:
                ReportThrottling();
                return;
            default:
                throw;
        }
    }
}

static async Task SetSecretAsync(SecretClient client, string secretName)
{
    try
    {
        await client.SetSecretAsync(secretName, "sample-value");
        Console.WriteLine($"Stored secret '{secretName}'.");
    }
    catch (RequestFailedException failure)
    {
        ReportFailure(failure);
        switch (failure.Status)
        {
            case 403:
                DiagnoseAccessDenied();
                return;
            case 409:
                Console.Error.WriteLine(
                    "A version conflict or concurrent change occurred. " +
                    "A soft-deleted name can also remain recoverable.");
                return;
            case 429:
                ReportThrottling();
                return;
            default:
                throw;
        }
    }
}

static async Task DiagnoseMissingSecretAsync(
    SecretClient client,
    string secretName)
{
    try
    {
        Response<DeletedSecret> deleted =
            await client.GetDeletedSecretAsync(secretName);
        Console.Error.WriteLine(
            $"Secret '{deleted.Value.Name}' is soft-deleted and recoverable.");
    }
    catch (RequestFailedException failure) when (failure.Status == 404)
    {
        Console.Error.WriteLine(
            $"Secret '{secretName}' was not found and is not soft-deleted.");
    }
}

static async Task PurgeDeletedSecretAsync(
    SecretClient client,
    string secretName)
{
    try
    {
        await client.PurgeDeletedSecretAsync(secretName);
        Console.WriteLine($"Purged deleted secret '{secretName}'.");
    }
    catch (RequestFailedException failure)
        when (failure.Status is 403 or 409)
    {
        ReportFailure(failure);
        Console.Error.WriteLine(
            "Purge protection prevents permanent deletion until its " +
            "retention period expires.");
    }
}

static void ReportFailure(RequestFailedException failure)
{
    Console.Error.WriteLine(
        $"Key Vault request failed: status={failure.Status}, " +
        $"errorCode={failure.ErrorCode}, message={failure.Message}");
}

static void DiagnoseAccessDenied()
{
    Console.Error.WriteLine(
        "Access denied. Verify the caller's Key Vault RBAC role assignment " +
        "or the vault's legacy access policy.");
}

static void ReportThrottling()
{
    Console.Error.WriteLine(
        "Key Vault throttled the request. The Azure SDK applies the " +
        "configured exponential retry backoff before surfacing status 429.");
}
