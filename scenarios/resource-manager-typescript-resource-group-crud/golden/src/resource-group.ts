import { ResourceManagementClient } from "@azure/arm-resources";
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";

declare const process: {
  env: Record<string, string | undefined>;
};

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before running the application.`);
  }
  return value;
}

async function main(): Promise<void> {
  const subscriptionId = requireEnvironment("AZURE_SUBSCRIPTION_ID");
  const resourceGroupName = requireEnvironment("AZURE_RESOURCE_GROUP_NAME");
  const location = "eastus";
  const credential = new DefaultAzureCredential();
  const client = new ResourceManagementClient(credential, subscriptionId);

  try {
    const created = await client.resourceGroups.createOrUpdate(
      resourceGroupName,
      { location },
    );
    console.log("Created:", created);

    for await (const resourceGroup of client.resourceGroups.list()) {
      console.log("Resource group:", resourceGroup);
    }

    const retrieved = await client.resourceGroups.get(resourceGroupName);
    console.log("Retrieved:", retrieved);

    const updated = await client.resourceGroups.update(
      resourceGroupName,
      {
        tags: { environment: "development" },
      },
    );
    console.log("Updated:", updated);

    await client.resourceGroups.beginDeleteAndWait(resourceGroupName);
    console.log(`Deleted resource group ${resourceGroupName}.`);
  } catch (error: unknown) {
    if (error instanceof RestError) {
      console.error(
        `Azure Resource Manager request failed (${error.statusCode ?? "unknown"}):`,
        error.message,
      );
    }
    throw error;
  }
}

await main();
