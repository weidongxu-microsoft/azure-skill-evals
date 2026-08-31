import { createAzureConnections } from "./config.js";
import { EncryptedBlobStorage } from "./encryptedBlobStorage.js";
import { KeyManagement } from "./keyManagement.js";

async function main(): Promise<void> {
  const connections = createAzureConnections();
  const keyManagement = new KeyManagement(
    connections.keyClient,
    connections.credential,
    connections.keyName,
  );
  const encryptedBlobs = new EncryptedBlobStorage(
    connections.containerClient,
    keyManagement,
  );

  const blobName = process.env.AZURE_STORAGE_BLOB_NAME ?? "encrypted-sample.bin";
  const sample = "Client-side encryption with Azure Key Vault";

  await connections.containerClient.createIfNotExists();
  const upload = await encryptedBlobs.upload(blobName, sample);
  const decrypted = await encryptedBlobs.download(blobName);

  console.log(`Vault key ID: ${upload.keyId}`);
  console.log(`Wrapped DEK (base64): ${upload.wrappedDataKeyBase64}`);
  console.log(`Decrypted output: ${decrypted.toString("utf8")}`);
}

main().catch((error: unknown) => {
  console.error("Encrypted blob round-trip failed:", error);
  process.exitCode = 1;
});
