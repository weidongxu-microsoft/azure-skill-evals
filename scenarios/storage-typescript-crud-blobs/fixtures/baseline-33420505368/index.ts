import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

const containerName = "my-container";
const blobName = "greeting.txt";
const content = "Hello Azure!";

async function main(): Promise<void> {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  if (!accountName) {
    throw new Error(
      "AZURE_STORAGE_ACCOUNT_NAME must be set to the Azure Storage account name.",
    );
  }

  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential,
  );
  const containerClient = serviceClient.getContainerClient(containerName);

  await containerClient.createIfNotExists();
  console.log(`Container ready: ${containerName}`);

  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  await blockBlobClient.upload(content, Buffer.byteLength(content));
  console.log(`Uploaded blob: ${blobName}`);

  console.log("Blobs in container:");
  for await (const blob of containerClient.listBlobsFlat()) {
    console.log(blob.name);
  }

  const downloadResponse = await blockBlobClient.download();
  if (!downloadResponse.readableStreamBody) {
    throw new Error(`The download response for "${blobName}" contained no body.`);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of downloadResponse.readableStreamBody) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  console.log(Buffer.concat(chunks).toString("utf8"));

  await blockBlobClient.delete();
  console.log(`Deleted blob: ${blobName}`);

  await containerClient.delete();
  console.log(`Deleted container: ${containerName}`);
}

main().catch((error: unknown) => {
  if (error instanceof RestError) {
    console.error(
      `Azure request failed (${error.statusCode ?? "unknown status"}): ${error.message}`,
    );
    if (error.code) {
      console.error(`Error code: ${error.code}`);
    }
  } else if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error("An unknown error occurred:", error);
  }

  process.exitCode = 1;
});
