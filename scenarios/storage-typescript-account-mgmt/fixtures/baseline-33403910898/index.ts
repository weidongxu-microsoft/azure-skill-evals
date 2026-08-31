import { StorageManagementClient } from "@azure/arm-storage";
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

function isAuthenticationError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    [
      "AuthenticationError",
      "AggregateAuthenticationError",
      "CredentialUnavailableError",
    ].includes(error.name)
  );
}

async function main(): Promise<void> {
  const subscriptionId = requireEnvironmentVariable("AZURE_SUBSCRIPTION_ID");
  const resourceGroupName = requireEnvironmentVariable("RESOURCE_GROUP_NAME");
  const storageAccountName = requireEnvironmentVariable("STORAGE_ACCOUNT_NAME");

  const credential = new DefaultAzureCredential();
  const client = new StorageManagementClient(credential, subscriptionId);

  await client.storageAccounts.beginCreateAndWait(
    resourceGroupName,
    storageAccountName,
    {
      location: "eastus",
      sku: { name: "Standard_LRS" },
      kind: "StorageV2",
    },
  );

  for await (const account of client.storageAccounts.listByResourceGroup(
    resourceGroupName,
  )) {
    console.log(`Storage account: ${account.name}`);
  }

  const account = await client.storageAccounts.getProperties(
    resourceGroupName,
    storageAccountName,
  );
  console.log(`Provisioning state: ${account.provisioningState}`);

  const blobService = await client.blobServices.setServiceProperties(
    resourceGroupName,
    storageAccountName,
    { isVersioningEnabled: true },
  );
  console.log(`Blob versioning enabled: ${blobService.isVersioningEnabled}`);

  await client.storageAccounts.delete(
    resourceGroupName,
    storageAccountName,
  );
  console.log(`Deleted storage account: ${storageAccountName}`);
}

try {
  await main();
} catch (error: unknown) {
  if (isAuthenticationError(error)) {
    console.error(`Azure authentication failed: ${error.message}`);
    process.exitCode = 1;
  } else if (error instanceof RestError) {
    const details = [
      error.code && `code=${error.code}`,
      error.statusCode && `status=${error.statusCode}`,
    ]
      .filter(Boolean)
      .join(", ");
    console.error(
      `Azure Storage request failed${details ? ` (${details})` : ""}: ${error.message}`,
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
