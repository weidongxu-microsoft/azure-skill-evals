using System.Net;
using Microsoft.Azure.Cosmos;

string connectionString =
    Environment.GetEnvironmentVariable("COSMOS_CONNECTION_STRING")
    ?? throw new InvalidOperationException(
        "Set COSMOS_CONNECTION_STRING before running the application.");
string databaseName =
    Environment.GetEnvironmentVariable("COSMOS_DATABASE") ?? "TestDB";
string containerName =
    Environment.GetEnvironmentVariable("COSMOS_CONTAINER") ?? "Items";

var options = new CosmosClientOptions
{
    MaxRetryAttemptsOnRateLimitedRequests = 3,
    MaxRetryWaitTimeOnRateLimitedRequests = TimeSpan.FromSeconds(30),
};
using CosmosClient client = new(connectionString, options);
Container container = client.GetContainer(databaseName, containerName);

ItemResponse<InventoryItem>? response = await ReadWithRetryAsync(
    container,
    "item-1",
    new PartitionKey("electronics"));
if (response is not null)
{
    Console.WriteLine($"Read item {response.Resource.id}.");
}

static async Task<ItemResponse<InventoryItem>?> ReadWithRetryAsync(
    Container container,
    string id,
    PartitionKey partitionKey)
{
    const int maxAttempts = 5;

    for (int attempt = 1; attempt <= maxAttempts; attempt++)
    {
        try
        {
            ItemResponse<InventoryItem> response =
                await container.ReadItemAsync<InventoryItem>(
                    id,
                    partitionKey);
            Console.WriteLine(
                $"Request charge: {response.RequestCharge:F2} RU.");
            return response;
        }
        catch (CosmosException exception)
        {
            Console.Error.WriteLine(
                $"Cosmos status={(int)exception.StatusCode}, "
                + $"substatus={exception.SubStatusCode}, "
                + $"retry-after={exception.RetryAfter}, "
                + $"diagnostics={exception.Diagnostics}");

            switch (exception.StatusCode)
            {
                case HttpStatusCode.TooManyRequests
                    when attempt < maxAttempts:
                    TimeSpan delay =
                        exception.RetryAfter
                        ?? TimeSpan.FromMilliseconds(100);
                    await Task.Delay(delay);
                    continue;

                case HttpStatusCode.NotFound:
                    Console.Error.WriteLine(
                        $"Item '{id}' was not found.");
                    return null;

                case HttpStatusCode.Conflict:
                    Console.Error.WriteLine(
                        $"Item '{id}' already exists.");
                    return null;

                default:
                    throw;
            }
        }
    }

    throw new InvalidOperationException("The bounded retry loop ended.");
}

internal sealed class InventoryItem
{
    public required string id { get; init; }

    public required string category { get; init; }
}
