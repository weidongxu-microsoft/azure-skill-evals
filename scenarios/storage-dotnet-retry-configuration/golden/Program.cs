using System.Text;
using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;

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

if (!Uri.TryCreate(endpointText, UriKind.Absolute, out Uri? serviceUri))
{
    throw new InvalidOperationException(
        "AZURE_STORAGE_BLOB_ENDPOINT must be an absolute URI.");
}

var clientOptions = new BlobClientOptions
{
    Retry =
    {
        Mode = RetryMode.Exponential,
        MaxRetries = 5,
        Delay = TimeSpan.FromSeconds(1),
        MaxDelay = TimeSpan.FromSeconds(16),
        NetworkTimeout = TimeSpan.FromSeconds(30),
    },
};
var credential = new DefaultAzureCredential();
var serviceClient =
    new BlobServiceClient(serviceUri, credential, clientOptions);
BlobContainerClient containerClient =
    serviceClient.GetBlobContainerClient(containerName);
BlobClient blobClient = containerClient.GetBlobClient(blobName);

var circuitBreaker = new TransientFailureCircuitBreaker();
using var operationTimeout =
    new CancellationTokenSource(TimeSpan.FromMinutes(2));

try
{
    await circuitBreaker.ExecuteAsync(
        async () =>
        {
            await using var content = new MemoryStream(
                Encoding.UTF8.GetBytes(
                    $"retry-configuration sample at {DateTimeOffset.UtcNow:O}"));
            await blobClient.UploadAsync(
                content,
                overwrite: true,
                cancellationToken: operationTimeout.Token);
        });
    Console.WriteLine($"Uploaded '{blobClient.Name}'.");
}
catch (RequestFailedException failure)
{
    if (RetryClassification.IsTransient(failure.Status))
    {
        Console.Error.WriteLine(
            $"Transient status {failure.Status} remained after the Azure SDK " +
            $"exponential retries: {failure.ErrorCode}.");
    }
    else if (RetryClassification.IsNonTransient(failure.Status))
    {
        Console.Error.WriteLine(
            $"Non-transient request or authentication status {failure.Status}; " +
            $"correct the request, credentials, or permissions: " +
            $"{failure.ErrorCode}.");
    }
    else
    {
        Console.Error.WriteLine(
            $"Unhandled storage failure {failure.Status}: {failure.ErrorCode}.");
    }
}
catch (OperationCanceledException)
    when (operationTimeout.IsCancellationRequested)
{
    Console.Error.WriteLine("The upload exceeded its two-minute timeout.");
}
catch (CircuitOpenException failure)
{
    Console.Error.WriteLine(failure.Message);
}

static class RetryClassification
{
    public static bool IsTransient(int status) =>
        status is 408 or 429 or 500 or 502 or 503 or 504;

    public static bool IsNonTransient(int status) =>
        status is 400 or 401 or 403 or 404 or 409;
}

sealed class TransientFailureCircuitBreaker
{
    private const int FailureThreshold = 3;
    private static readonly TimeSpan BreakDuration =
        TimeSpan.FromSeconds(30);

    private int consecutiveTransientFailures;
    private DateTimeOffset? openedAt;

    public async Task ExecuteAsync(Func<Task> operation)
    {
        if (openedAt is DateTimeOffset opened)
        {
            if (DateTimeOffset.UtcNow - opened < BreakDuration)
            {
                throw new CircuitOpenException(
                    "The upload circuit is open after sustained transient failures.");
            }

            openedAt = null;
            consecutiveTransientFailures = 0;
        }

        try
        {
            await operation();
            consecutiveTransientFailures = 0;
        }
        catch (RequestFailedException failure)
            when (RetryClassification.IsTransient(failure.Status))
        {
            consecutiveTransientFailures++;
            if (consecutiveTransientFailures >= FailureThreshold)
            {
                openedAt = DateTimeOffset.UtcNow;
            }

            throw;
        }
        catch
        {
            consecutiveTransientFailures = 0;
            throw;
        }
    }
}

sealed class CircuitOpenException(string message) : Exception(message);
