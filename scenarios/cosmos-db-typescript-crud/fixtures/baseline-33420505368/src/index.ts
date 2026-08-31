import { CosmosClient, type SqlQuerySpec } from "@azure/cosmos";

interface InventoryItem {
  id: string;
  category: string;
  name: string;
  quantity: number;
}

interface CosmosError extends Error {
  code?: number;
  statusCode?: number;
  retryAfterInMs?: number;
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireStatus(
  operation: string,
  actualStatus: number,
  expectedStatuses: readonly number[],
): void {
  if (!expectedStatuses.includes(actualStatus)) {
    throw new Error(
      `${operation} returned status ${actualStatus}; expected ${expectedStatuses.join(" or ")}`,
    );
  }
}

function isCosmosError(error: unknown): error is CosmosError {
  return (
    error instanceof Error &&
    (typeof (error as CosmosError).code === "number" ||
      typeof (error as CosmosError).statusCode === "number")
  );
}

async function main(): Promise<void> {
  const endpoint = requireEnvironmentVariable("COSMOS_ENDPOINT");
  const key = requireEnvironmentVariable("COSMOS_KEY");
  const client = new CosmosClient({ endpoint, key });

  const databaseResponse = await client.databases.createIfNotExists({
    id: "TestDB",
  });
  requireStatus("Create database", databaseResponse.statusCode, [200, 201]);

  const containerResponse =
    await databaseResponse.database.containers.createIfNotExists({
      id: "Items",
      partitionKey: { paths: ["/category"] },
    });
  requireStatus("Create container", containerResponse.statusCode, [200, 201]);
  const container = containerResponse.container;

  const item: InventoryItem = {
    id: "item-001",
    category: "electronics",
    name: "Wireless keyboard",
    quantity: 5,
  };

  const createResponse = await container.items.create<InventoryItem>(item);
  requireStatus("Create item", createResponse.statusCode, [201]);
  console.log("Created:", createResponse.resource);

  const itemReference = container.item(item.id, item.category);
  const readResponse = await itemReference.read<InventoryItem>();
  requireStatus("Read item", readResponse.statusCode, [200]);
  if (!readResponse.resource) {
    throw new Error("Read succeeded but returned no item");
  }
  console.log("Read:", readResponse.resource);

  const query: SqlQuerySpec = {
    query: "SELECT * FROM items WHERE items.category = @category",
    parameters: [{ name: "@category", value: "electronics" }],
  };
  const queryResponse = await container.items
    .query<InventoryItem>(query)
    .fetchAll();
  console.log("Queried:", queryResponse.resources);

  const updatedItem: InventoryItem = { ...item, quantity: 10 };
  const replaceResponse =
    await itemReference.replace<InventoryItem>(updatedItem);
  requireStatus("Replace item", replaceResponse.statusCode, [200]);
  console.log("Updated:", replaceResponse.resource);

  const deleteResponse = await itemReference.delete();
  requireStatus("Delete item", deleteResponse.statusCode, [204]);
  console.log("Deleted item:", item.id);
}

main().catch((error: unknown) => {
  if (!isCosmosError(error)) {
    console.error("Unexpected error:", error);
    process.exitCode = 1;
    return;
  }

  const statusCode = error.statusCode ?? error.code;
  switch (statusCode) {
    case 401:
    case 403:
      console.error(`Cosmos DB authorization failed (${statusCode}):`, error.message);
      break;
    case 404:
      console.error("Cosmos DB resource was not found (404):", error.message);
      break;
    case 409:
      console.error("Cosmos DB resource already exists (409):", error.message);
      break;
    case 429:
      console.error(
        `Cosmos DB request was throttled (429); retry after ${error.retryAfterInMs ?? "the server-specified delay"} ms:`,
        error.message,
      );
      break;
    default:
      console.error(`Cosmos DB request failed (${statusCode}):`, error.message);
  }
  process.exitCode = 1;
});
