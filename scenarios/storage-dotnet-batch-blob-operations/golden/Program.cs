using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Blobs.Specialized;

const int MaxOperationsPerBatch = 256;
const int MaxBatchBodyBytes = 4 * 1024 * 1024;
const string StorageScope = "https://storage.azure.com/.default";

string endpointText =
    Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT")
    ?? throw new InvalidOperationException(
        "Set AZURE_STORAGE_BLOB_ENDPOINT before running the application.");
string containerName =
    Environment.GetEnvironmentVariable("AZURE_STORAGE_CONTAINER")
    ?? throw new InvalidOperationException(
        "Set AZURE_STORAGE_CONTAINER before running the application.");

if (!Uri.TryCreate(endpointText, UriKind.Absolute, out Uri? serviceUri))
{
    throw new InvalidOperationException(
        "AZURE_STORAGE_BLOB_ENDPOINT must be an absolute URI.");
}

var credential = new DefaultAzureCredential();
var serviceClient = new BlobServiceClient(serviceUri, credential);
BlobBatchClient batchClient = serviceClient.GetBlobBatchClient();
BlobContainerClient container = serviceClient.GetBlobContainerClient(containerName);

Uri[] deleteUris = Enumerable.Range(0, 500)
    .Select(index => container.GetBlobClient($"delete-{index:000}").Uri)
    .ToArray();
Uri[] tierUris = Enumerable.Range(0, 200)
    .Select(index => container.GetBlobClient($"tier-{index:000}").Uri)
    .ToArray();

Console.WriteLine(
    $"Blob batches allow at most {MaxOperationsPerBatch} operations and " +
    $"{MaxBatchBodyBytes} bytes (4 MiB) per request.");
Console.WriteLine(
    $"BlobServiceClient requests {StorageScope} for DefaultAzureCredential.");

foreach (Uri[] chunk in deleteUris.Chunk(MaxOperationsPerBatch))
{
    try
    {
        Response[] responses = await batchClient.DeleteBlobsAsync(
            chunk,
            DeleteSnapshotsOption.IncludeSnapshots);
        for (int index = 0; index < responses.Length; index++)
        {
            Console.WriteLine(
                $"Delete {chunk[index]} returned {responses[index].Status}.");
        }
    }
    catch (AggregateException aggregate)
    {
        ReportPartialFailures("delete", aggregate);
    }
    catch (RequestFailedException failure)
    {
        ReportSubmissionFailure("delete", failure);
    }
}

try
{
    Response[] responses = await batchClient.SetBlobsAccessTierAsync(
        tierUris,
        AccessTier.Cool);
    for (int index = 0; index < responses.Length; index++)
    {
        Console.WriteLine(
            $"Set tier {tierUris[index]} returned {responses[index].Status}.");
    }
}
catch (AggregateException aggregate)
{
    ReportPartialFailures("set-tier", aggregate);
}
catch (RequestFailedException failure)
{
    ReportSubmissionFailure("set-tier", failure);
}

using BlobBatch customBatch = batchClient.CreateBatch();
Response customDelete = customBatch.DeleteBlob(
    container.GetBlobClient("custom-delete").Uri,
    DeleteSnapshotsOption.IncludeSnapshots);
Response customTier = customBatch.SetBlobAccessTier(
    container.GetBlobClient("custom-tier").Uri,
    AccessTier.Cool);

try
{
    Response submission = await batchClient.SubmitBatchAsync(
        customBatch,
        throwOnAnyFailure: false);
    Console.WriteLine($"Custom batch submission returned {submission.Status}.");
    Console.WriteLine($"Custom delete returned {customDelete.Status}.");
    Console.WriteLine($"Custom set-tier returned {customTier.Status}.");
}
catch (RequestFailedException failure)
{
    ReportSubmissionFailure("custom", failure);
}

static void ReportPartialFailures(
    string operation,
    AggregateException aggregate)
{
    foreach (RequestFailedException failure in
             aggregate.InnerExceptions.OfType<RequestFailedException>())
    {
        Console.Error.WriteLine(
            $"{operation} suboperation failed: " +
            $"{failure.Status} {failure.ErrorCode}: {failure.Message}");
    }
}

static void ReportSubmissionFailure(
    string operation,
    RequestFailedException failure)
{
    Console.Error.WriteLine(
        $"{operation} batch submission failed: " +
        $"{failure.Status} {failure.ErrorCode}: {failure.Message}");
}
