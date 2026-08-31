using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

string vaultUrl = Environment.GetEnvironmentVariable("AZURE_KEY_VAULT_URL")
    ?? throw new InvalidOperationException(
        "Set AZURE_KEY_VAULT_URL to the vault endpoint.");

var client = new SecretClient(
    new Uri(vaultUrl),
    new DefaultAzureCredential());
CancellationToken cancellationToken = CancellationToken.None;

try
{
    await ListItemsAsync(client, cancellationToken);
    await ListPagesAsync(client, cancellationToken);
    ListPages(client, cancellationToken);
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(
        $"Key Vault pagination failed: status={failure.Status}, " +
        $"errorCode={failure.ErrorCode}, message={failure.Message}");
}

static async Task ListItemsAsync(
    SecretClient client,
    CancellationToken cancellationToken)
{
    AsyncPageable<SecretProperties> secrets =
        client.GetPropertiesOfSecretsAsync(cancellationToken);

    await foreach (SecretProperties secret in
        secrets.WithCancellation(cancellationToken))
    {
        PrintSecret(secret);
    }
}

static async Task ListPagesAsync(
    SecretClient client,
    CancellationToken cancellationToken)
{
    AsyncPageable<SecretProperties> secrets =
        client.GetPropertiesOfSecretsAsync(cancellationToken);

    await foreach (Page<SecretProperties> page in
        secrets.AsPages(pageSizeHint: 50))
    {
        foreach (SecretProperties secret in page.Values)
        {
            PrintSecret(secret);
        }
    }
}

static void ListPages(
    SecretClient client,
    CancellationToken cancellationToken)
{
    Pageable<SecretProperties> secrets =
        client.GetPropertiesOfSecrets(cancellationToken: cancellationToken);

    foreach (Page<SecretProperties> page in
        secrets.AsPages(pageSizeHint: 50))
    {
        foreach (SecretProperties secret in page.Values)
        {
            PrintSecret(secret);
        }
    }
}

static void PrintSecret(SecretProperties secret)
{
    string state = secret.Enabled == false ? "disabled" : "enabled";
    Console.WriteLine(
        $"Name={secret.Name}; ContentType={secret.ContentType}; " +
        $"Enabled={secret.Enabled}; CreatedOn={secret.CreatedOn:O}; " +
        $"State={state}");
}
