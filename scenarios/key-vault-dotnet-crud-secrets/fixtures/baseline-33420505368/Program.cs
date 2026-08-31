using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

const string secretName = "my-secret";

string? vaultUrl = Environment.GetEnvironmentVariable("KEY_VAULT_URL");
if (!Uri.TryCreate(vaultUrl, UriKind.Absolute, out Uri? vaultUri))
{
    Console.Error.WriteLine(
        "Set KEY_VAULT_URL to an absolute Azure Key Vault URL, such as https://my-vault.vault.azure.net/.");
    return 1;
}

var client = new SecretClient(vaultUri, new DefaultAzureCredential());

try
{
    await client.SetSecretAsync(secretName, "my-secret-value");
    Console.WriteLine($"Created secret '{secretName}'.");

    KeyVaultSecret secret = await client.GetSecretAsync(secretName);
    Console.WriteLine($"Secret value: {secret.Value}");

    await client.SetSecretAsync(secretName, "updated-value");
    Console.WriteLine($"Updated secret '{secretName}'.");

    DeleteSecretOperation deleteOperation = await client.StartDeleteSecretAsync(secretName);
    await deleteOperation.WaitForCompletionAsync();
    Console.WriteLine($"Deleted secret '{secretName}'.");

    await client.PurgeDeletedSecretAsync(secretName);
    Console.WriteLine($"Purged secret '{secretName}'.");

    return 0;
}
catch (RequestFailedException ex)
{
    Console.Error.WriteLine(
        $"Azure Key Vault request failed with status {ex.Status} ({ex.ErrorCode ?? "unknown error code"}): {ex.Message}");

    if (ex.Status == 403)
    {
        Console.Error.WriteLine(
            "Ensure this identity has permission to set, get, delete, and purge secrets in the vault.");
    }
    else if (ex.Status == 404)
    {
        Console.Error.WriteLine(
            "Verify that KEY_VAULT_URL identifies an existing vault and that the secret was not removed externally.");
    }

    return 1;
}
