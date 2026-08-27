using Azure.Identity;
using Azure.Storage.Blobs;

string tenantId = Environment.GetEnvironmentVariable("AZURE_TENANT_ID")
    ?? throw new InvalidOperationException("AZURE_TENANT_ID is required.");
string clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID")
    ?? throw new InvalidOperationException("AZURE_CLIENT_ID is required.");
string clientSecret = Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET")
    ?? throw new InvalidOperationException("AZURE_CLIENT_SECRET is required.");
string endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT")
    ?? throw new InvalidOperationException(
        "AZURE_STORAGE_BLOB_ENDPOINT is required.");

ClientSecretCredential credential = new(tenantId, clientId, clientSecret);
BlobServiceClient client = new(new Uri(endpoint), credential);

try
{
    var response = await client.GetAccountInfoAsync();
    Console.WriteLine($"Account kind: {response.Value.AccountKind}");
    Console.WriteLine($"SKU: {response.Value.SkuName}");
}
catch (AuthenticationFailedException exception)
{
    Console.Error.WriteLine(
        $"Service principal authentication failed: {exception.Message}");
}
