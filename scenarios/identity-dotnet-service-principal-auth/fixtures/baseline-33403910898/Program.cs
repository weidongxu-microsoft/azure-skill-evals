using Azure.Identity;
using Azure.Storage.Blobs;

static string GetRequiredEnvironmentVariable(string name)
{
    string? value = Environment.GetEnvironmentVariable(name);

    if (string.IsNullOrWhiteSpace(value))
    {
        throw new InvalidOperationException(
            $"Required environment variable '{name}' is not set or is empty.");
    }

    return value;
}

string tenantId = GetRequiredEnvironmentVariable("AZURE_TENANT_ID");
string clientId = GetRequiredEnvironmentVariable("AZURE_CLIENT_ID");
string clientSecret = GetRequiredEnvironmentVariable("AZURE_CLIENT_SECRET");
string blobEndpoint = GetRequiredEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");

var credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
var blobServiceClient = new BlobServiceClient(new Uri(blobEndpoint), credential);

try
{
    var accountInfo = await blobServiceClient.GetAccountInfoAsync();

    Console.WriteLine($"Account kind: {accountInfo.Value.AccountKind}");
    Console.WriteLine($"SKU: {accountInfo.Value.SkuName}");
}
catch (AuthenticationFailedException exception)
{
    Console.Error.WriteLine(
        $"Azure Blob Storage authentication failed ({exception.GetType().Name}): {exception.Message}");

    if (exception.InnerException is not null)
    {
        Console.Error.WriteLine(
            $"Underlying error ({exception.InnerException.GetType().Name}): {exception.InnerException.Message}");
    }

    Environment.ExitCode = 1;
}
