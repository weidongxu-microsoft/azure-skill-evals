import { AuthenticationError, ClientSecretCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import dotenv from "dotenv";

dotenv.config();

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const tenantId = requireEnvironmentVariable("AZURE_TENANT_ID");
const clientId = requireEnvironmentVariable("AZURE_CLIENT_ID");
const clientSecret = requireEnvironmentVariable("AZURE_CLIENT_SECRET");
const keyVaultUrl = requireEnvironmentVariable("AZURE_KEY_VAULT_URL");
const secretName = requireEnvironmentVariable("AZURE_KEY_VAULT_SECRET_NAME");

const credential = new ClientSecretCredential(
  tenantId,
  clientId,
  clientSecret,
);
const client = new SecretClient(keyVaultUrl, credential);

try {
  const secret = await client.getSecret(secretName);
  console.log(secret.value);
} catch (error: unknown) {
  if (error instanceof AuthenticationError) {
    console.error(
      "Azure authentication failed. Verify the service principal credentials.",
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}
