using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

string endpointText =
    Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT")
    ?? throw new InvalidOperationException(
        "Set AZURE_STORAGE_BLOB_ENDPOINT before running the application.");
string containerName =
    Environment.GetEnvironmentVariable("AZURE_STORAGE_CONTAINER")
    ?? throw new InvalidOperationException(
        "Set AZURE_STORAGE_CONTAINER before running the application.");
string blobName =
    Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB")
    ?? throw new InvalidOperationException(
        "Set AZURE_STORAGE_BLOB before running the application.");
string? leaseId =
    Environment.GetEnvironmentVariable("AZURE_STORAGE_LEASE_ID");

if (!Uri.TryCreate(endpointText, UriKind.Absolute, out Uri? serviceUri))
{
    throw new InvalidOperationException(
        "AZURE_STORAGE_BLOB_ENDPOINT must be an absolute URI.");
}

var options = new BlobClientOptions
{
    Retry =
    {
        Delay = TimeSpan.FromSeconds(1),
        MaxDelay = TimeSpan.FromSeconds(16),
        MaxRetries = 5,
        Mode = RetryMode.Exponential,
        NetworkTimeout = TimeSpan.FromSeconds(30),
    },
};
var credential = new DefaultAzureCredential();
var serviceClient = new BlobServiceClient(serviceUri, credential, options);
BlobContainerClient containerClient =
    serviceClient.GetBlobContainerClient(containerName);
BlobClient blobClient = containerClient.GetBlobClient(blobName);

try
{
    Response<BlobProperties> properties =
        await blobClient.GetPropertiesAsync();
    ETag currentETag = properties.Value.ETag;
    var conditions = new BlobRequestConditions
    {
        IfMatch = currentETag,
        LeaseId = leaseId,
    };
    var metadata = new Dictionary<string, string>
    {
        ["error-handling-sample"] = DateTimeOffset.UtcNow.ToString("O"),
    };

    Response<BlobInfo> updated =
        await blobClient.SetMetadataAsync(metadata, conditions);
    Console.WriteLine(
        $"Updated '{blobClient.Name}' with ETag {updated.Value.ETag}.");
}
catch (RequestFailedException failure)
{
    ReportFailure(failure);
    switch (failure.Status)
    {
        case 404:
            Console.Error.WriteLine(
                "The blob or container was not found.");
            break;
        case 403:
            Console.Error.WriteLine(
                "Access denied. Verify the caller's Storage Blob Data " +
                "Contributor RBAC role and required permissions.");
            break;
        case 409:
            Console.Error.WriteLine(
                "A lease or current storage state conflicts with the operation.");
            break;
        case 412:
            Console.Error.WriteLine(
                "The ETag precondition or lease condition no longer matches.");
            break;
        case 429:
            Console.Error.WriteLine(
                "Storage throttled the request after the configured Azure SDK " +
                "exponential retry backoff.");
            break;
        default:
            throw;
    }
}

static void ReportFailure(RequestFailedException failure)
{
    Response? response = failure.GetRawResponse();
    string clientRequestId =
        response is not null &&
        response.Headers.TryGetValue(
            "x-ms-client-request-id",
            out string? headerValue)
            ? headerValue
            : "<unavailable>";
    Console.Error.WriteLine(
        $"Blob request failed: status={failure.Status}, " +
        $"errorCode={failure.ErrorCode}, message={failure.Message}, " +
        $"clientRequestId={clientRequestId}, " +
        $"serviceRequestId={response?.Headers.RequestId}");
}
