using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Consumer;
using Azure.Messaging.EventHubs.Processor;
using Azure.Messaging.EventHubs.Producer;
using Azure.Storage.Blobs;

string eventHubsConnectionString =
    Environment.GetEnvironmentVariable("EVENT_HUBS_CONNECTION_STRING")
    ?? throw new InvalidOperationException(
        "Set EVENT_HUBS_CONNECTION_STRING before running.");
string eventHubName =
    Environment.GetEnvironmentVariable("EVENT_HUB_NAME")
    ?? throw new InvalidOperationException(
        "Set EVENT_HUB_NAME before running.");
string blobConnectionString =
    Environment.GetEnvironmentVariable("BLOB_STORAGE_CONNECTION_STRING")
    ?? throw new InvalidOperationException(
        "Set BLOB_STORAGE_CONNECTION_STRING before running.");
string blobContainerName =
    Environment.GetEnvironmentVariable("BLOB_CONTAINER_NAME")
    ?? "event-hubs-checkpoints";

var checkpointStore = new BlobContainerClient(
    blobConnectionString,
    blobContainerName);
await checkpointStore.CreateIfNotExistsAsync();

await using var producer = new EventHubProducerClient(
    eventHubsConnectionString,
    eventHubName);
using EventDataBatch batch = await producer.CreateBatchAsync();
for (int eventNumber = 0; eventNumber < 10; eventNumber++)
{
    var eventData = new EventData(
        BinaryData.FromString($"Event {eventNumber}"));
    eventData.Properties["EventNumber"] = eventNumber;
    if (!batch.TryAdd(eventData))
    {
        throw new InvalidOperationException(
            $"Event {eventNumber} is too large for the batch.");
    }
}

await producer.SendAsync(batch);

var processor = new EventProcessorClient(
    checkpointStore,
    EventHubConsumerClient.DefaultConsumerGroupName,
    eventHubsConnectionString,
    eventHubName);
processor.ProcessEventAsync += ProcessEventHandler;
processor.ProcessErrorAsync += ProcessErrorHandler;

try
{
    await processor.StartProcessingAsync();
    await Task.Delay(TimeSpan.FromSeconds(30));
}
finally
{
    await processor.StopProcessingAsync();
    processor.ProcessEventAsync -= ProcessEventHandler;
    processor.ProcessErrorAsync -= ProcessErrorHandler;
}

static async Task ProcessEventHandler(ProcessEventArgs eventArgs)
{
    Console.WriteLine(eventArgs.Data.EventBody.ToString());
    await eventArgs.UpdateCheckpointAsync();
}

static Task ProcessErrorHandler(ProcessErrorEventArgs errorArgs)
{
    Console.Error.WriteLine(errorArgs.Exception);
    return Task.CompletedTask;
}
