using System.Diagnostics.Tracing;
using Azure.Core.Diagnostics;
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

using AzureEventSourceListener diagnostics =
    AzureEventSourceListener.CreateConsoleLogger(EventLevel.Informational);

var credential = new DefaultAzureCredential(
    new DefaultAzureCredentialOptions
    {
        ExcludeInteractiveBrowserCredential = true,
    });
var client = new BlobServiceClient(serviceUri, credential);

try
{
    var response = await client.GetAccountInfoAsync();
    Console.WriteLine(response.Value.SkuName);
    Console.WriteLine(response.Value.AccountKind);
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
