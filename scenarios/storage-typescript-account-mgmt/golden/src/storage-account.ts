import { StorageManagementClient } from "@azure/arm-storage";
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
  const accountName = requireEnvironment("AZURE_STORAGE_ACCOUNT_NAME");
  const location = "eastus";
  const credential = new DefaultAzureCredential();
  const client = new StorageManagementClient(credential, subscriptionId);

  try {
    const created = await client.storageAccounts.beginCreateAndWait(
      resourceGroupName,
      accountName,
      {
        location,
        sku: { name: "Standard_LRS" },
        kind: "StorageV2",
      },
    );
    console.log("Created storage account:", created.name);

    for await (
      const account of client.storageAccounts.listByResourceGroup(
        resourceGroupName,
      )
    ) {
      console.log("Storage account:", account.name);
    }

    const properties = await client.storageAccounts.getProperties(
      resourceGroupName,
      accountName,
    );
    console.log("Primary location:", properties.primaryLocation);

    const blobProperties = await client.blobServices.setServiceProperties(
      resourceGroupName,
      accountName,
      {
        isVersioningEnabled: true,
      },
    );
    console.log(
      "Blob versioning enabled:",
      blobProperties.isVersioningEnabled,
    );

    await client.storageAccounts.delete(resourceGroupName, accountName);
    console.log(`Deleted storage account ${accountName}.`);
  } catch (error: unknown) {
    if (error instanceof RestError) {
      console.error(
        `Azure Storage request failed (${error.statusCode ?? "unknown"}):`,
        error.message,
      );
    }
    throw error;
  }
}

await main();
