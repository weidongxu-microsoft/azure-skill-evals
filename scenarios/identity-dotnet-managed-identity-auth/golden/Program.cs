using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;

string endpoint =
    Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT")
    ?? throw new InvalidOperationException(
        "Set AZURE_STORAGE_BLOB_ENDPOINT before running the application.");
string clientId =
    Environment.GetEnvironmentVariable("AZURE_CLIENT_ID")
    ?? throw new InvalidOperationException(
        "Set AZURE_CLIENT_ID to the user-assigned managed identity client ID.");

var systemAssignedCredential =
    new ManagedIdentityCredential(ManagedIdentityId.SystemAssigned);
var userAssignedId = ManagedIdentityId.FromUserAssignedClientId(clientId);
var userAssignedCredential = new ManagedIdentityCredential(userAssignedId);

var defaultCredential = new DefaultAzureCredential(
    new DefaultAzureCredentialOptions
    {
        ManagedIdentityClientId = clientId,
        ExcludeManagedIdentityCredential = false,
        ExcludeInteractiveBrowserCredential = true,
    });

TokenCredential localFallbackCredential = new ChainedTokenCredential(
    userAssignedCredential,
    new AzureCliCredential());

var client = new BlobServiceClient(new Uri(endpoint), localFallbackCredential);

try
{
    var response = await client.GetAccountInfoAsync();
    Console.WriteLine($"Account kind: {response.Value.AccountKind}");
    Console.WriteLine($"SKU: {response.Value.SkuName}");
}
catch (CredentialUnavailableException exception)
{
    Console.Error.WriteLine(
        $"Managed identity and Azure CLI credentials were unavailable: {exception.Message}");
    Environment.ExitCode = 1;
}
