import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

export function createSecretClient(): SecretClient {
  const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
  if (!vaultUrl) {
    throw new Error("Set AZURE_KEY_VAULT_URL before running.");
  }
  return new SecretClient(vaultUrl, new DefaultAzureCredential());
}
