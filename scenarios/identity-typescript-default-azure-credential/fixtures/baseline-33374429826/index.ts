import { AuthenticationError, DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { setLogLevel } from "@azure/logger";

setLogLevel("verbose");

const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
const secretName = process.env.AZURE_KEY_VAULT_SECRET_NAME;

if (!vaultUrl || !secretName) {
  throw new Error(
    "AZURE_KEY_VAULT_URL and AZURE_KEY_VAULT_SECRET_NAME must be set.",
  );
}

const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);

async function main(name: string): Promise<void> {
  try {
    const secret = await client.getSecret(name);
    console.log(secret.value);
  } catch (error: unknown) {
    if (error instanceof AuthenticationError) {
      console.error(`Azure credential authentication failed: ${error.message}`);
      return;
    }

    throw error;
  }
}

await main(secretName);
