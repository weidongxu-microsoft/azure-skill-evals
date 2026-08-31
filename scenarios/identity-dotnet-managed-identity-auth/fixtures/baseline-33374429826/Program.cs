using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;

string endpointValue = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT")
    ?? throw new InvalidOperationException(
        "AZURE_STORAGE_BLOB_ENDPOINT must be set to the Blob service endpoint.");
string clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID")
    ?? throw new InvalidOperationException(
        "AZURE_CLIENT_ID must be set to the user-assigned managed identity client ID.");

if (!Uri.TryCreate(endpointValue, UriKind.Absolute, out Uri? blobEndpoint))
{
    throw new InvalidOperationException(
        "AZURE_STORAGE_BLOB_ENDPOINT must be a valid absolute URI.");
}

ManagedIdentityCredential systemAssignedCredential = new(ManagedIdentityId.SystemAssigned);
ManagedIdentityCredential userAssignedCredential = new(
    ManagedIdentityId.FromUserAssignedClientId(clientId));

DefaultAzureCredential defaultCredential = new(new DefaultAzureCredentialOptions
{
    ManagedIdentityClientId = clientId,
    ExcludeManagedIdentityCredential = false
});

ChainedTokenCredential managedIdentityThenCliCredential = new(
    userAssignedCredential,
    new AzureCliCredential());

TokenCredential credential = managedIdentityThenCliCredential;
BlobServiceClient blobServiceClient = new(blobEndpoint, credential);

try
{
    var accountInfo = await blobServiceClient.GetAccountInfoAsync();
    Console.WriteLine($"Account kind: {accountInfo.Value.AccountKind}");
    Console.WriteLine($"SKU: {accountInfo.Value.SkuName}");
}
catch (CredentialUnavailableException exception)
{
    Console.Error.WriteLine("Azure authentication credentials were unavailable.");
    Console.Error.WriteLine($"Blob endpoint: {blobEndpoint}");
    Console.Error.WriteLine(
        "Attempted the user-assigned managed identity configured by AZURE_CLIENT_ID, "
        + "followed by Azure CLI authentication.");
    Console.Error.WriteLine($"Credential diagnostic: {exception.Message}");
    Environment.ExitCode = 1;
}

_ = systemAssignedCredential;
_ = defaultCredential;
