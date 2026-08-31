import { SecretCache } from "./cache.js";
import { createSecretClient } from "./config.js";
import { SecretProvider } from "./provider.js";
import { cleanupAndRecreate, rotateVersion } from "./rotation.js";

const CONFIG_KEYS = ["database-url", "api-key", "feature-toggle"];

async function main(): Promise<void> {
  const client = createSecretClient();
  const cache = new SecretCache(
    new SecretProvider(client),
    7 * 24 * 60 * 60 * 1000,
  );
  await cache.bulkLoad(CONFIG_KEYS);
  console.log(await cache.get("database-url", "missing"));
  await cache.refresh("api-key");
  await cache.refreshExpiring();
  await rotateVersion(
    client,
    "api-key",
    "rotated-value",
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  );
  await cleanupAndRecreate(
    client,
    "api-key",
    "recreated-value",
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  );
}

await main();
