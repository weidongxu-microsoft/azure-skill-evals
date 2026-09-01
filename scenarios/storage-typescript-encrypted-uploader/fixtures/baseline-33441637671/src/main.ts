import { createAzureConfiguration } from "./config.js";
import { EncryptedBlobClient } from "./encryptedBlobClient.js";
import { KeyManagement } from "./keyManagement.js";

async function main(): Promise<void> {
  const configuration = createAzureConfiguration();
  const keyManagement = new KeyManagement(
    configuration.keyClient,
    configuration.credential,
    configuration.keyName
  );
  const encryptedBlobs = new EncryptedBlobClient(
    configuration.containerClient,
    keyManagement
  );

  const blobName = process.env.AZURE_STORAGE_BLOB_NAME?.trim() || "encrypted-demo.bin";
  const sample = "Hello from client-side Azure Blob encryption!";
  const upload = await encryptedBlobs.upload(blobName, Buffer.from(sample, "utf8"));
  const decrypted = await encryptedBlobs.download(blobName);

  console.log(`Vault key ID: ${upload.keyId}`);
  console.log(`Wrapped DEK (base64): ${upload.wrappedDataKeyBase64}`);
  console.log(`Decrypted output: ${decrypted.toString("utf8")}`);
}

main().catch((error: unknown) => {
  console.error("Encrypted blob round-trip failed:", error);
  process.exitCode = 1;
});
