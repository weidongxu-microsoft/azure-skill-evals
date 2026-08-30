using Microsoft.Azure.Cosmos;

string connectionString =
    Environment.GetEnvironmentVariable("COSMOS_CONNECTION_STRING")
    ?? throw new InvalidOperationException(
        "Set COSMOS_CONNECTION_STRING before running the application.");
string databaseName =
    Environment.GetEnvironmentVariable("COSMOS_DATABASE") ?? "TestDB";
string containerName =
    Environment.GetEnvironmentVariable("COSMOS_CONTAINER") ?? "Items";
string? resumeToken = args.Length > 0 ? args[0] : null;

using CosmosClient client = new(connectionString);
Container container = client.GetContainer(databaseName, containerName);

var query = new QueryDefinition(
    "SELECT * FROM c WHERE c.category = @category")
    .WithParameter("@category", "electronics");
var requestOptions = new QueryRequestOptions
{
    MaxItemCount = 50,
};

PaginationResult result = await ReadPagesAsync(
    container,
    query,
    requestOptions,
    resumeToken);
Console.WriteLine($"Total request charge: {result.RequestCharge:F2} RU.");

static async Task<PaginationResult> ReadPagesAsync(
    Container container,
    QueryDefinition query,
    QueryRequestOptions requestOptions,
    string? resumeToken)
{
    using FeedIterator<CatalogItem> iterator =
        container.GetItemQueryIterator<CatalogItem>(
            queryDefinition: query,
            continuationToken: resumeToken,
            requestOptions: requestOptions);

    double totalRequestCharge = 0;
    string? latestToken = resumeToken;

    while (iterator.HasMoreResults)
    {
        FeedResponse<CatalogItem> page = await iterator.ReadNextAsync();
        foreach (CatalogItem item in page)
        {
            Console.WriteLine($"{item.id}: {item.name}");
        }

        latestToken = page.ContinuationToken;
        Console.WriteLine($"Continuation token: {latestToken}");
        totalRequestCharge += page.RequestCharge;
    }

    return new PaginationResult(totalRequestCharge, latestToken);
}

internal sealed class CatalogItem
{
    public required string id { get; init; }

    public required string category { get; init; }

    public required string name { get; init; }
}

internal sealed record PaginationResult(
    double RequestCharge,
    string? ContinuationToken);
