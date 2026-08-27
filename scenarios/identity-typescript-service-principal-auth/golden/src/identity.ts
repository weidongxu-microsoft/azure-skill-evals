import "dotenv/config";

import {
  AuthenticationError,
  ClientSecretCredential,
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
  const credential = new ClientSecretCredential(
    requireEnvironment("AZURE_TENANT_ID"),
    requireEnvironment("AZURE_CLIENT_ID"),
    requireEnvironment("AZURE_CLIENT_SECRET"),
  );
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
    } else {
      throw error;
    }
  }
}

await main();
