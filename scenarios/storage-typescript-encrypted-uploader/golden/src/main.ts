import { createApplicationClients } from "./config.js";
import { EncryptedBlobManager } from "./encryptedBlobManager.js";

async function main(): Promise<void> {
  const { containerClient, keyManager } = createApplicationClients();
  await containerClient.createIfNotExists();

  const uploader = new EncryptedBlobManager(containerClient, keyManager);
  const blobName = "encrypted-sample.txt";
  const upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");
  const decrypted = await uploader.downloadText(blobName);

  console.log(`Vault key ID: ${upload.keyId}`);
  console.log(`Wrapped DEK (base64): ${upload.wrappedDek}`);
  console.log(`Decrypted output: ${decrypted}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
