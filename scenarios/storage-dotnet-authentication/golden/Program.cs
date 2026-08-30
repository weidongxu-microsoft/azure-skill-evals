using Azure.Identity;
using Azure.Storage.Blobs;

string accountEndpoint =
    Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT")
    ?? throw new InvalidOperationException(
        "Set AZURE_STORAGE_BLOB_ENDPOINT before running the application.");

if (!Uri.TryCreate(accountEndpoint, UriKind.Absolute, out Uri? serviceUri))
{
    throw new InvalidOperationException(
        "AZURE_STORAGE_BLOB_ENDPOINT must be an absolute URI.");
}

var credential = new DefaultAzureCredential(
    new DefaultAzureCredentialOptions
    {
        ExcludeInteractiveBrowserCredential = true,
    });
var client = new BlobServiceClient(serviceUri, credential);

try
{
    var response = await client.GetAccountInfoAsync();
    Console.WriteLine($"Account kind: {response.Value.AccountKind}");
    Console.WriteLine($"SKU: {response.Value.SkuName}");
}
catch (CredentialUnavailableException exception)
{
    Console.Error.WriteLine(
        "No Azure credential is available: " + exception.Message);
    Environment.ExitCode = 1;
}
catch (AuthenticationFailedException exception)
{
    Console.Error.WriteLine(
        "Azure authentication failed: " + exception.Message);
    Environment.ExitCode = 1;
}
