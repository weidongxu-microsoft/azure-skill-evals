import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

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
  const client = new SecretClient(
    requireEnvironment("AZURE_KEY_VAULT_URL"),
    new DefaultAzureCredential(),
  );
  const secretName = "my-secret";

  try {
    await client.setSecret(secretName, "my-secret-value");
    const retrieved = await client.getSecret(secretName);
    console.log(retrieved.value);
    await client.setSecret(secretName, "updated-value");

    const deletePoller = await client.beginDeleteSecret(secretName);
    await deletePoller.pollUntilDone();
    await client.purgeDeletedSecret(secretName);
  } catch (error: unknown) {
    if (error instanceof RestError) {
      console.error(
        `Key Vault request failed (${error.statusCode ?? "unknown"}):`,
        error.message,
      );
    }
    throw error;
  }
}

await main();
