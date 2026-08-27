import {
  AzureCliCredential,
  ChainedTokenCredential,
  CredentialUnavailableError,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
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
  const systemAssignedCredential = new ManagedIdentityCredential();
  const clientId = process.env.AZURE_CLIENT_ID;
  if (!clientId) {
    throw new Error("Set AZURE_CLIENT_ID before running the application.");
  }

  const userAssignedCredential = new ManagedIdentityCredential({ clientId });
  const defaultCredential = new DefaultAzureCredential({
    managedIdentityClientId: clientId,
  });
  void defaultCredential;

  try {
    await userAssignedCredential.getToken(
      "https://vault.azure.net/.default",
    );
  } catch (error: unknown) {
    if (error instanceof CredentialUnavailableError) {
      console.warn(
        "Managed identity is unavailable; using the Azure CLI fallback.",
        error.message,
      );
    } else {
      throw error;
    }
  }

  const credential = new ChainedTokenCredential(
    userAssignedCredential,
    new AzureCliCredential(),
  );
  const client = new SecretClient(
    requireEnvironment("AZURE_KEY_VAULT_URL"),
    credential,
  );
  const secret = await client.getSecret(
    requireEnvironment("AZURE_KEY_VAULT_SECRET_NAME"),
  );
  console.log(secret.value);

  void systemAssignedCredential;
}

await main();
