import { createReadStream } from "node:fs";
import { type Readable } from "node:stream";

import { RestError } from "@azure/core-rest-pipeline";
import {
  BlobLeaseClient,
  type BlobDownloadResponseParsed,
  type BlockBlobUploadStreamOptions,
  type ContainerClient,
} from "@azure/storage-blob";

export interface UploadBlobOptions {
  metadata?: Record<string, string>;
  tags?: Record<string, string>;
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isStatusCode(error: unknown, statusCode: number): error is RestError {
  return error instanceof RestError && error.statusCode === statusCode;
}

export class BlobStorageManager {
  constructor(private readonly containerClient: ContainerClient) {}

  async ensureContainer(): Promise<void> {
    await this.containerClient.createIfNotExists();
  }

  async uploadFile(
    filePath: string,
    blobName: string,
    options: UploadBlobOptions = {},
  ): Promise<void> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    const uploadOptions: BlockBlobUploadStreamOptions = {
      metadata: options.metadata,
      tags: options.tags,
    };

    await blockBlobClient.uploadStream(
      createReadStream(filePath),
      undefined,
      undefined,
      uploadOptions,
    );
  }

  async *listBlobNames(): AsyncGenerator<string> {
    for await (const blob of this.containerClient.listBlobsFlat()) {
      yield blob.name;
    }
  }

  async downloadText(blobName: string): Promise<string> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

    try {
      const response = await blockBlobClient.download();
      return await this.readDownload(response);
    } catch (error: unknown) {
      if (isStatusCode(error, 404)) {
        console.error(`Blob ${blobName} was not found.`);
      }
      throw error;
    }
  }

  async overwriteFileWithLease(
    filePath: string,
    blobName: string,
    options: UploadBlobOptions = {},
  ): Promise<void> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    const leaseClient = new BlobLeaseClient(blockBlobClient);
    let leaseId: string | undefined;

    try {
      const lease = await leaseClient.acquireLease(60);
      leaseId = lease.leaseId;

      await blockBlobClient.uploadStream(
        createReadStream(filePath),
        undefined,
        undefined,
        {
          conditions: { leaseId },
          metadata: options.metadata,
          tags: options.tags,
        },
      );
    } catch (error: unknown) {
      if (isStatusCode(error, 409)) {
        console.error(`Blob ${blobName} is already leased by another writer.`);
      }
      throw error;
    } finally {
      if (leaseId) {
        await leaseClient.releaseLease();
      }
    }
  }

  async deleteBlob(blobName: string): Promise<void> {
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

    try {
      await blockBlobClient.delete();
    } catch (error: unknown) {
      if (isStatusCode(error, 404)) {
        console.error(`Blob ${blobName} was already deleted.`);
      }
      throw error;
    }
  }

  private async readDownload(
    response: BlobDownloadResponseParsed,
  ): Promise<string> {
    if (!response.readableStreamBody) {
      throw new Error("The blob response did not include a readable stream.");
    }
    return streamToString(response.readableStreamBody as Readable);
  }
}
