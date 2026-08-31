using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

const string EndpointVariable = "AZURE_STORAGE_BLOB_ENDPOINT";

string? endpointValue = Environment.GetEnvironmentVariable(EndpointVariable);
if (!Uri.TryCreate(endpointValue, UriKind.Absolute, out Uri? endpoint))
{
    Console.Error.WriteLine(
        $"{EndpointVariable} must be set to an absolute Blob service URI, " +
        "for example https://<account-name>.blob.core.windows.net/.");
    return 1;
}

try
{
    TokenCredential credential = new DefaultAzureCredential();
    var blobServiceClient = new BlobServiceClient(endpoint, credential);

    Response<AccountInfo> response = await blobServiceClient.GetAccountInfoAsync();
    AccountInfo accountInfo = response.Value;

    Console.WriteLine($"Connected to: {blobServiceClient.Uri}");
    Console.WriteLine($"Account kind: {accountInfo.AccountKind}");
    Console.WriteLine($"SKU: {accountInfo.SkuName}");
}
catch (CredentialUnavailableException exception)
{
    Console.Error.WriteLine(
        $"No credential source was available. In Azure, configure a managed identity; " +
        $"locally, sign in with 'az login'. Details: {exception.Message}");
    return 2;
}
catch (AuthenticationFailedException exception)
{
    Console.Error.WriteLine(
        $"Azure authentication failed. Verify the selected identity and its configuration. " +
        $"Details: {exception.Message}");
    return 3;
}
catch (RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"Blob service request failed (HTTP {exception.Status}, code {exception.ErrorCode ?? "unknown"}): " +
        exception.Message);
    return 4;
}

return 0;
