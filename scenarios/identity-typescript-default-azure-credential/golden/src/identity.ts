import {
  AuthenticationError,
  DefaultAzureCredential,
} from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { setLogLevel } from "@azure/logger";

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
  setLogLevel("info");

  const credential = new DefaultAzureCredential({
    managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  });
  const client = new SecretClient(
    requireEnvironment("AZURE_KEY_VAULT_URL"),
    credential,
  );

  try {
    const secret = await client.getSecret(
      requireEnvironment("AZURE_KEY_VAULT_SECRET_NAME"),
    );
    console.log(secret.value);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      console.error("Azure authentication failed.", error.message);
    }
    throw error;
  }
}

await main();
