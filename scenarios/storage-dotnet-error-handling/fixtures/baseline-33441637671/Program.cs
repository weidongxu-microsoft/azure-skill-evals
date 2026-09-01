using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

internal static class Program
{
    private static async Task<int> Main()
    {
        try
        {
            Uri endpoint = GetRequiredAbsoluteUri("AZURE_STORAGE_BLOB_ENDPOINT");
            string containerName = GetRequiredEnvironmentVariable("AZURE_STORAGE_CONTAINER");
            string blobName = GetRequiredEnvironmentVariable("AZURE_STORAGE_BLOB");
            string? leaseId = Environment.GetEnvironmentVariable("AZURE_STORAGE_LEASE_ID");

            BlobClientOptions options = new()
            {
                Retry =
                {
                    Mode = RetryMode.Exponential,
                    Delay = TimeSpan.FromSeconds(1),
                    MaxDelay = TimeSpan.FromSeconds(8),
                    MaxRetries = 4,
                    NetworkTimeout = TimeSpan.FromSeconds(30)
                }
            };

            BlobServiceClient serviceClient = new(
                endpoint,
                new DefaultAzureCredential(),
                options);
            BlobContainerClient containerClient = serviceClient.GetBlobContainerClient(containerName);
            BlobClient blobClient = containerClient.GetBlobClient(blobName);

            try
            {
                Response<BlobProperties> propertiesResponse =
                    await blobClient.GetPropertiesAsync().ConfigureAwait(false);

                BlobRequestConditions conditions = new()
                {
                    IfMatch = propertiesResponse.Value.ETag,
                    LeaseId = string.IsNullOrWhiteSpace(leaseId) ? null : leaseId
                };

                Dictionary<string, string> metadata =
                    new(propertiesResponse.Value.Metadata, StringComparer.OrdinalIgnoreCase)
                    {
                        ["errorhandlingdemolastrunutc"] = DateTimeOffset.UtcNow.ToString("O")
                    };

                await blobClient.SetMetadataAsync(metadata, conditions).ConfigureAwait(false);
                Console.WriteLine(
                    $"Updated metadata for blob '{blobName}' in container '{containerName}'.");
                return 0;
            }
            catch (RequestFailedException exception)
            {
                LogRequestFailure(exception);
                return 1;
            }
        }
        catch (ArgumentException exception)
        {
            Console.Error.WriteLine($"Configuration error: {exception.Message}");
            return 2;
        }
    }

    private static void LogRequestFailure(RequestFailedException exception)
    {
        Response? response = exception.GetRawResponse();
        string clientRequestId = response is not null && response.Headers.TryGetValue(
            "x-ms-client-request-id",
            out string? headerValue)
            ? headerValue
            : "<not provided>";
        string? responseRequestId = response?.Headers.RequestId;
        string serviceRequestId = string.IsNullOrWhiteSpace(responseRequestId)
            ? "<not provided>"
            : responseRequestId;

        Console.Error.WriteLine(
            $"Azure Storage request failed. Status={exception.Status}; " +
            $"ErrorCode={exception.ErrorCode ?? "<not provided>"}; " +
            $"Message={exception.Message}; ClientRequestId={clientRequestId}; " +
            $"ServiceRequestId={serviceRequestId}");

        string explanation = exception.Status switch
        {
            404 => "The blob or container is missing. Verify both resource names and the endpoint.",
            403 => "Authorization failed. Verify the identity has the required Azure Storage data-plane RBAC permissions.",
            409 => "A lease or storage-state conflict prevented the update. Check the active lease and current blob state.",
            412 => "The ETag/precondition or lease condition failed. Re-read the blob and retry with its current ETag and lease.",
            429 => "Azure Storage is still throttling the request after the configured SDK retry policy was exhausted.",
            _ => "The Azure Storage operation failed with an unhandled service status."
        };

        Console.Error.WriteLine(explanation);
    }

    private static string GetRequiredEnvironmentVariable(string name)
    {
        string? value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException($"Environment variable {name} is required.");
        }

        return value;
    }

    private static Uri GetRequiredAbsoluteUri(string name)
    {
        string value = GetRequiredEnvironmentVariable(name);
        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            throw new ArgumentException(
                $"Environment variable {name} must be an absolute HTTP or HTTPS URI.");
        }

        return uri;
    }
}
