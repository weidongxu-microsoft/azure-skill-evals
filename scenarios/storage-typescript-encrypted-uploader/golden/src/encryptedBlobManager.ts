import { RestError } from "@azure/core-rest-pipeline";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { ContainerClient } from "@azure/storage-blob";

import { KeyManager } from "./keyManager.js";

export interface UploadResult {
  keyId: string;
  wrappedDek: string;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export class EncryptedBlobManager {
  public constructor(
    private readonly containerClient: ContainerClient,
    private readonly keyManager: KeyManager,
  ) {}

  public async uploadText(blobName: string, plaintext: string): Promise<UploadResult> {
    const dataEncryptionKey = randomBytes(32);
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dataEncryptionKey, initializationVector);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();

    try {
      const { keyId, wrappedDek } =
        await this.keyManager.wrapDataEncryptionKey(dataEncryptionKey);
      await this.containerClient.getBlockBlobClient(blobName).uploadData(ciphertext, {
        metadata: {
          wrappedDek: wrappedDek.toString("base64"),
          iv: initializationVector.toString("base64"),
          authTag: authenticationTag.toString("base64"),
          keyId,
        },
      });
      return { keyId, wrappedDek: wrappedDek.toString("base64") };
    } catch (error) {
      if (error instanceof RestError) {
        if (error.statusCode === 404) throw new Error("The upload container was not found.");
        throw new Error(`Blob upload failed: ${error.message}`);
      }
      throw error;
    }
  }

  public async downloadText(blobName: string): Promise<string> {
    try {
      const blobClient = this.containerClient.getBlockBlobClient(blobName);
      const properties = await blobClient.getProperties();
      const metadata = properties.metadata;
      if (
        !metadata ||
        !metadata.wrappedDek ||
        !metadata.iv ||
        !metadata.authTag ||
        !metadata.keyId
      ) {
        throw new Error("Blob encryption metadata is incomplete.");
      }

      const download = await blobClient.download();
      if (!download.readableStreamBody) throw new Error("Blob download had no content stream.");
      const ciphertext = await streamToBuffer(download.readableStreamBody);
      const wrappedDek = Buffer.from(metadata.wrappedDek, "base64");
      const dataEncryptionKey = await this.keyManager.unwrapDataEncryptionKey(
        metadata.keyId,
        wrappedDek,
      );
      const decipher = createDecipheriv(
        "aes-256-gcm",
        dataEncryptionKey,
        Buffer.from(metadata.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch (error) {
      if (error instanceof RestError) {
        if (error.statusCode === 404) throw new Error("The encrypted blob was not found.");
        throw new Error(`Blob download failed: ${error.message}`);
      }
      throw error;
    }
  }
}
