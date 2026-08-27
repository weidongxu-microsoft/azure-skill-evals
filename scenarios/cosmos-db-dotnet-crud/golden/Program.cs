using Microsoft.Azure.Cosmos;

string connectionString =
    Environment.GetEnvironmentVariable("COSMOS_CONNECTION_STRING")
    ?? throw new InvalidOperationException(
        "Set COSMOS_CONNECTION_STRING before running the application.");

using CosmosClient client = new(connectionString);

try
{
    DatabaseResponse databaseResponse =
        await client.CreateDatabaseIfNotExistsAsync("TestDB");
    Database database = databaseResponse.Database;

    ContainerResponse containerResponse =
        await database.CreateContainerIfNotExistsAsync("Items", "/category");
    Container container = containerResponse.Container;

    var item = new InventoryItem
    {
        id = "item-1",
        category = "electronics",
        name = "Laptop",
        quantity = 1,
    };

    await container.CreateItemAsync(item, new PartitionKey(item.category));

    ItemResponse<InventoryItem> readResponse =
        await container.ReadItemAsync<InventoryItem>(
            item.id,
            new PartitionKey(item.category));
    Console.WriteLine($"Read {readResponse.Resource.name}");

    var query = new QueryDefinition(
        "SELECT * FROM c WHERE c.category = @category")
        .WithParameter("@category", "electronics");
    using FeedIterator<InventoryItem> iterator =
        container.GetItemQueryIterator<InventoryItem>(query);
    while (iterator.HasMoreResults)
    {
        FeedResponse<InventoryItem> page = await iterator.ReadNextAsync();
        foreach (InventoryItem result in page)
        {
            Console.WriteLine($"Queried {result.name}");
        }
    }

    item.quantity = 2;
    await container.ReplaceItemAsync(
        item,
        item.id,
        new PartitionKey(item.category));
    await container.DeleteItemAsync<InventoryItem>(
        item.id,
        new PartitionKey(item.category));
}
catch (CosmosException exception)
{
    Console.Error.WriteLine(
        $"Cosmos DB request failed with status {(int)exception.StatusCode}: "
        + exception.Message);
    Environment.ExitCode = 1;
}

internal sealed class InventoryItem
{
    public required string id { get; init; }

    public required string category { get; init; }

    public required string name { get; init; }

    public int quantity { get; set; }
}
