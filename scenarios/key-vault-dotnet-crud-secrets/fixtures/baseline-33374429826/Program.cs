using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

const string secretName = "my-secret";

string? vaultUriValue = Environment.GetEnvironmentVariable("KEY_VAULT_URI");
if (!Uri.TryCreate(vaultUriValue, UriKind.Absolute, out Uri? vaultUri))
{
    Console.Error.WriteLine(
        "Set KEY_VAULT_URI to the vault URI, for example https://my-vault.vault.azure.net/.");
    return 2;
}

SecretClient client = new(vaultUri, new DefaultAzureCredential());
string operation = "create";

try
{
    await client.SetSecretAsync(secretName, "my-secret-value");

    operation = "read";
    KeyVaultSecret secret = (await client.GetSecretAsync(secretName)).Value;
    Console.WriteLine($"Secret value: {secret.Value}");

    operation = "update";
    await client.SetSecretAsync(secretName, "updated-value");

    operation = "delete";
    DeleteSecretOperation deleteOperation = await client.StartDeleteSecretAsync(secretName);
    await deleteOperation.WaitForCompletionAsync();

    operation = "purge";
    await client.PurgeDeletedSecretAsync(secretName);

    Console.WriteLine("Secret updated, deleted, and purged successfully.");
    return 0;
}
catch (RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"Azure Key Vault failed to {operation} secret '{secretName}'. " +
        $"Status: {exception.Status}; Error code: {exception.ErrorCode ?? "unknown"}; " +
        $"Message: {exception.Message}");

    if (operation == "purge" && exception.Status == 403)
    {
        Console.Error.WriteLine(
            "The signed-in identity needs permission to purge secrets, and purge protection must not block purging.");
    }

    return 1;
}
