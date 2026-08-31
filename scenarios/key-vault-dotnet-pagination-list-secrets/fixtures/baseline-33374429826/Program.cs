using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

const int PageSizeHint = 50;

string? vaultUrl = args.FirstOrDefault() ?? Environment.GetEnvironmentVariable("KEY_VAULT_URL");
if (!Uri.TryCreate(vaultUrl, UriKind.Absolute, out Uri? vaultUri))
{
    Console.Error.WriteLine(
        "Usage: dotnet run -- <https://your-vault.vault.azure.net/> " +
        "or set KEY_VAULT_URL.");
    return 1;
}

var client = new SecretClient(vaultUri, new DefaultAzureCredential());
bool succeeded = true;

Console.WriteLine("Asynchronous item-by-item iteration:");
try
{
    await foreach (SecretProperties secret in client.GetPropertiesOfSecretsAsync())
    {
        PrintSecret(secret);
    }
}
catch (RequestFailedException exception)
{
    succeeded = false;
    ReportFailure("asynchronous item-by-item iteration", exception);
}

Console.WriteLine($"\nAsynchronous page iteration (page-size hint: {PageSizeHint}):");
try
{
    AsyncPageable<SecretProperties> secrets = client.GetPropertiesOfSecretsAsync();
    await foreach (Page<SecretProperties> page in secrets.AsPages(pageSizeHint: PageSizeHint))
    {
        foreach (SecretProperties secret in page.Values)
        {
            PrintSecret(secret);
        }
    }
}
catch (RequestFailedException exception)
{
    succeeded = false;
    ReportFailure("asynchronous page iteration", exception);
}

Console.WriteLine("\nSynchronous item-by-item iteration:");
try
{
    Pageable<SecretProperties> secrets = client.GetPropertiesOfSecrets();
    foreach (SecretProperties secret in secrets)
    {
        PrintSecret(secret);
    }
}
catch (RequestFailedException exception)
{
    succeeded = false;
    ReportFailure("synchronous iteration", exception);
}

return succeeded ? 0 : 1;

static void PrintSecret(SecretProperties secret)
{
    string enabled = secret.Enabled switch
    {
        true => "True",
        false => "False (DISABLED)",
        null => "Unknown"
    };

    Console.WriteLine(
        $"Name={secret.Name}; " +
        $"ContentType={secret.ContentType ?? "<none>"}; " +
        $"Enabled={enabled}; " +
        $"CreatedOn={secret.CreatedOn?.ToString("O") ?? "<unknown>"}");
}

static void ReportFailure(string path, RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"Azure Key Vault request failed during {path}: " +
        $"Status={exception.Status}, ErrorCode={exception.ErrorCode ?? "<none>"}, " +
        $"Message={exception.Message}");
}
