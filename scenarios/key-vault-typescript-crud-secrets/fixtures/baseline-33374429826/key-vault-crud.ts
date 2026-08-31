import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

const secretName = "my-secret";

async function main(): Promise<void> {
  const vaultUrl = process.env.KEY_VAULT_URL;
  if (!vaultUrl) {
    throw new Error(
      "KEY_VAULT_URL is required (for example, https://<vault-name>.vault.azure.net).",
    );
  }

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(vaultUrl, credential);

  await client.setSecret(secretName, "my-secret-value");
  console.log(`Created secret "${secretName}".`);

  const secret = await client.getSecret(secretName);
  if (secret.value === undefined) {
    throw new Error(`Secret "${secretName}" was read without a value.`);
  }
  console.log(`Secret value: ${secret.value}`);

  await client.setSecret(secretName, "updated-value");
  console.log(`Updated secret "${secretName}".`);

  const deletePoller = await client.beginDeleteSecret(secretName);
  await deletePoller.pollUntilDone();
  console.log(`Deleted secret "${secretName}".`);

  await client.purgeDeletedSecret(secretName);
  console.log(`Purged secret "${secretName}".`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Key Vault operation failed: ${message}`);
  process.exitCode = 1;
});
