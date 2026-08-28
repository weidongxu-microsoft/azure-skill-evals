import { Buffer } from "node:buffer";

import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

async function streamToString(
  stream: NodeJS.ReadableStream,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  if (!accountUrl) {
    throw new Error("AZURE_STORAGE_ACCOUNT_URL is required.");
  }

  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(accountUrl, credential);
  const containerName = "my-container";
  const blobName = "greeting.txt";
  const message = "Hello Azure!";
  const containerClient = serviceClient.getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  try {
    await containerClient.createIfNotExists();
    await blockBlobClient.upload(message, Buffer.byteLength(message));

    for await (const blob of containerClient.listBlobsFlat()) {
      console.log(blob.name);
    }

    const download = await blockBlobClient.download();
    if (!download.readableStreamBody) {
      throw new Error("The downloaded blob did not contain a response stream.");
    }
    const downloadedText = await streamToString(download.readableStreamBody);
    console.log(downloadedText);

    await blockBlobClient.delete();
    await containerClient.delete();
  } catch (error: unknown) {
    if (error instanceof RestError) {
      console.error(error.statusCode, error.message);
    }
    throw error;
  }
}

await main();
