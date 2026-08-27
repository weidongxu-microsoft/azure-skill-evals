using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

string vaultUrl = Environment.GetEnvironmentVariable("AZURE_KEY_VAULT_URL")
    ?? throw new InvalidOperationException(
        "Set AZURE_KEY_VAULT_URL to the vault endpoint.");

SecretClient client = new(new Uri(vaultUrl), new DefaultAzureCredential());

try
{
    await client.SetSecretAsync("my-secret", "my-secret-value");

    Response<KeyVaultSecret> retrieved =
        await client.GetSecretAsync("my-secret");
    Console.WriteLine(retrieved.Value.Value);

    await client.SetSecretAsync("my-secret", "updated-value");

    DeleteSecretOperation deletion =
        await client.StartDeleteSecretAsync("my-secret");
    await deletion.WaitForCompletionAsync();
    await client.PurgeDeletedSecretAsync("my-secret");
}
catch (RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"Key Vault request failed ({exception.Status}, {exception.ErrorCode}): " +
        exception.Message);
}
