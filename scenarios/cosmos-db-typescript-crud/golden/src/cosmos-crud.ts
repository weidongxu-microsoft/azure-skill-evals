import { CosmosClient, type SqlQuerySpec } from "@azure/cosmos";

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

interface InventoryItem {
  id: string;
  category: string;
  name: string;
  quantity: number;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before running the application.`);
  }
  return value;
}

function isCosmosError(error: unknown): error is Error & { code: number } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "number"
  );
}

async function main(): Promise<void> {
  const client = new CosmosClient({
    endpoint: requireEnvironment("COSMOS_ENDPOINT"),
    key: requireEnvironment("COSMOS_KEY"),
  });

  try {
    const { database } = await client.databases.createIfNotExists({
      id: "TestDB",
    });
    const { container } = await database.containers.createIfNotExists({
      id: "Items",
      partitionKey: { paths: ["/category"] },
    });

    const item: InventoryItem = {
      id: "item-1",
      category: "electronics",
      name: "Laptop",
      quantity: 1,
    };
    await container.items.create(item);

    const { resource: readItem } = await container
      .item(item.id, item.category)
      .read<InventoryItem>();
    console.log(`Read ${readItem?.name}`);

    const query: SqlQuerySpec = {
      query: "SELECT * FROM c WHERE c.category = @category",
      parameters: [{ name: "@category", value: "electronics" }],
    };
    const iterator = container.items.query<InventoryItem>(query);
    while (iterator.hasMoreResults()) {
      const { resources } = await iterator.fetchNext();
      for (const result of resources) {
        console.log(`Queried ${result.name}`);
      }
    }

    item.quantity = 2;
    await container.item(item.id, item.category).replace(item);
    await container.item(item.id, item.category).delete();
  } catch (error: unknown) {
    if (isCosmosError(error)) {
      console.error(`Cosmos DB request failed with status ${error.code}.`);
    } else {
      throw error;
    }
    process.exitCode = 1;
  } finally {
    client.dispose();
  }
}

await main();
