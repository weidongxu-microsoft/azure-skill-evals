import { ResourceManagementClient } from "@azure/arm-resources";
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";

const location = "eastus";

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

function printResource(label: string, resource: unknown): void {
  console.log(`${label}:\n${JSON.stringify(resource, null, 2)}`);
}

async function main(): Promise<void> {
  const subscriptionId = requireEnvironmentVariable("AZURE_SUBSCRIPTION_ID");
  const resourceGroupName = requireEnvironmentVariable("RESOURCE_GROUP_NAME");
  const credential = new DefaultAzureCredential();
  const client = new ResourceManagementClient(credential, subscriptionId);

  const created = await client.resourceGroups.createOrUpdate(resourceGroupName, {
    location,
  });
  printResource("Created resource group", created);

  console.log("Resource groups:");
  for await (const resourceGroup of client.resourceGroups.list()) {
    printResource("Resource group", resourceGroup);
  }

  const retrieved = await client.resourceGroups.get(resourceGroupName);
  printResource("Retrieved resource group", retrieved);

  const updated = await client.resourceGroups.update(resourceGroupName, {
    tags: {
      environment: "development",
    },
  });
  printResource("Updated resource group", updated);

  await client.resourceGroups.beginDeleteAndWait(resourceGroupName);
  console.log(`Deleted resource group "${resourceGroupName}".`);
}

void main().catch((error: unknown) => {
  if (
    error instanceof Error &&
    [
      "AuthenticationError",
      "AggregateAuthenticationError",
      "CredentialUnavailableError",
    ].includes(error.name)
  ) {
    console.error(`Azure authentication failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (error instanceof RestError) {
    const status = error.statusCode ? ` (HTTP ${error.statusCode})` : "";
    const code = error.code ? ` [${error.code}]` : "";
    console.error(`Azure resource request failed${status}${code}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  throw error;
});
