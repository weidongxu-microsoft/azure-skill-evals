import { writeFile } from "node:fs/promises";

import {
  createContainerClient,
  loadBlobStorageConfiguration,
} from "./config.js";
import { BlobStorageManager } from "./blobStorageManager.js";

async function main(): Promise<void> {
  const configuration = loadBlobStorageConfiguration();
  const containerClient = createContainerClient(configuration);
  const manager = new BlobStorageManager(containerClient);
  const blobName = "sample.txt";
  const uploadPath = "sample-upload.txt";
  const overwritePath = "sample-overwrite.txt";

  await manager.ensureContainer();
  await writeFile(uploadPath, "Hello from Azure Blob Storage!\n", "utf8");
  await writeFile(overwritePath, "Updated with an exclusive lease.\n", "utf8");

  console.log(`Uploading ${blobName} with blob index tags...`);
  await manager.uploadFile(uploadPath, blobName, {
    metadata: { source: "golden" },
    tags: { category: "sample", workflow: "blob-manager" },
  });

  console.log("Listing blobs in the container...");
  for await (const listedBlobName of manager.listBlobNames()) {
    console.log(`- ${listedBlobName}`);
  }

  console.log(`Downloading ${blobName}...`);
  const downloadedText = await manager.downloadText(blobName);
  console.log(downloadedText);

  console.log(`Overwriting ${blobName} with a lease...`);
  await manager.overwriteFileWithLease(overwritePath, blobName, {
    metadata: { source: "golden-overwrite" },
    tags: { category: "sample", workflow: "blob-manager-updated" },
  });

  console.log(`Deleting ${blobName}...`);
  await manager.deleteBlob(blobName);
  console.log("Blob lifecycle complete.");
}

await main();
