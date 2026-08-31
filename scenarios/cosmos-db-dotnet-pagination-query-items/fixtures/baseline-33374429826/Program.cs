using Microsoft.Azure.Cosmos;
using Newtonsoft.Json;

string endpoint = GetRequiredEnvironmentVariable("COSMOS_ENDPOINT");
string key = GetRequiredEnvironmentVariable("COSMOS_KEY");
string databaseId = GetRequiredEnvironmentVariable("COSMOS_DATABASE_ID");
string containerId = GetRequiredEnvironmentVariable("COSMOS_CONTAINER_ID");
string? continuationToken = ParseContinuationToken(args);

using CosmosClient client = new(endpoint, key);
Container container = client.GetContainer(databaseId, containerId);

QueryDefinition query = new QueryDefinition(
        "SELECT * FROM c WHERE c.category = @category")
    .WithParameter("@category", "electronics");

QueryRequestOptions requestOptions = new()
{
    MaxItemCount = 50
};

using FeedIterator<CatalogItem> iterator =
    container.GetItemQueryIterator<CatalogItem>(
        query,
        continuationToken,
        requestOptions);

double totalRequestCharge = 0;

while (iterator.HasMoreResults)
{
    FeedResponse<CatalogItem> page = await iterator.ReadNextAsync();
    totalRequestCharge += page.RequestCharge;

    Console.WriteLine(
        $"Continuation token: {page.ContinuationToken ?? "<none>"}");

    foreach (CatalogItem item in page)
    {
        Console.WriteLine(JsonConvert.SerializeObject(item));
    }
}

Console.WriteLine($"Total request charge: {totalRequestCharge:F2} RU");
Console.WriteLine(
    "Direct FeedIterator<T> pagination is preferable when explicit control " +
    "over page size, continuation tokens, request options, and per-page " +
    "request charges is needed. Start with GetItemLinqQueryable<T>() when " +
    "composing a type-safe query with LINQ is the primary goal.");

static string GetRequiredEnvironmentVariable(string name)
{
    return Environment.GetEnvironmentVariable(name)
        ?? throw new InvalidOperationException(
            $"Required environment variable '{name}' is not set.");
}

static string? ParseContinuationToken(string[] arguments)
{
    const string option = "--continuation-token";

    if (arguments.Length == 0)
    {
        return null;
    }

    if (arguments.Length == 2 &&
        string.Equals(arguments[0], option, StringComparison.Ordinal))
    {
        return arguments[1];
    }

    throw new ArgumentException(
        $"Usage: dotnet run -- [{option} <saved-token>]");
}

public sealed class CatalogItem
{
    [JsonExtensionData]
    public IDictionary<string, object?> Properties { get; set; } =
        new Dictionary<string, object?>();
}
