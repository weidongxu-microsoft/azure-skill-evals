using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;

var endpointValue = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");

if (string.IsNullOrWhiteSpace(endpointValue))
{
    Console.Error.WriteLine(
        "AZURE_STORAGE_BLOB_ENDPOINT is required (for example, https://<account>.blob.core.windows.net/).");
    return 1;
}

if (!Uri.TryCreate(endpointValue, UriKind.Absolute, out var accountEndpoint) ||
    (accountEndpoint.Scheme != Uri.UriSchemeHttps && accountEndpoint.Scheme != Uri.UriSchemeHttp))
{
    Console.Error.WriteLine(
        "AZURE_STORAGE_BLOB_ENDPOINT must be an absolute HTTP or HTTPS URI.");
    return 1;
}

var credential = new DefaultAzureCredential(
    new DefaultAzureCredentialOptions
    {
        ExcludeManagedIdentityCredential = false,
        ExcludeAzureCliCredential = false
    });

var blobServiceClient = new BlobServiceClient(accountEndpoint, credential);

try
{
    var accountInfo = await blobServiceClient.GetAccountInfoAsync();

    Console.WriteLine($"Authenticated to {blobServiceClient.Uri}");
    Console.WriteLine($"Account kind: {accountInfo.Value.AccountKind}");
    Console.WriteLine($"SKU: {accountInfo.Value.SkuName}");
}
catch (CredentialUnavailableException ex)
{
    Console.Error.WriteLine(
        $"No credential in the DefaultAzureCredential chain was available: {ex.Message}");
    return 2;
}
catch (AuthenticationFailedException ex)
{
    Console.Error.WriteLine($"Azure authentication failed: {ex.Message}");

    if (ex.InnerException is not null)
    {
        Console.Error.WriteLine($"Details: {ex.InnerException.Message}");
    }

    return 3;
}
catch (RequestFailedException ex)
{
    Console.Error.WriteLine(
        $"Azure Blob Storage rejected the request (status {ex.Status}, code {ex.ErrorCode}): {ex.Message}");
    return 4;
}

return 0;
