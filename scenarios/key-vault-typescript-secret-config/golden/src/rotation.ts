import type { SecretClient } from "@azure/keyvault-secrets";

export async function rotateVersion(
  client: SecretClient,
  name: string,
  value: string,
  expiresOn: Date,
): Promise<void> {
  await client.setSecret(name, value, { expiresOn });
}

export async function cleanupAndRecreate(
  client: SecretClient,
  name: string,
  value: string,
  expiresOn: Date,
): Promise<void> {
  const poller = await client.beginDeleteSecret(name);
  await poller.pollUntilDone();
  await client.purgeDeletedSecret(name);
  await client.setSecret(name, value, { expiresOn });
}
