import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";
import type { ContainerClient, Metadata } from "@azure/storage-blob";
import { KeyManagement } from "./keyManagement.js";

const ENCRYPTION_ALGORITHM = "AES-256-GCM";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

interface EncryptionMetadata {
  keyId: string;
  wrappedDataKey: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export interface UploadResult {
  keyId: string;
  wrappedDataKeyBase64: string;
}

export class EncryptedBlobClient {
  public constructor(
    private readonly containerClient: ContainerClient,
    private readonly keyManagement: KeyManagement
  ) {}

  public async upload(blobName: string, plaintext: Buffer): Promise<UploadResult> {
    const protectedKey = await this.keyManagement.createProtectedDataKey();
    const iv = randomBytes(IV_BYTES);

    try {
      const cipher = createCipheriv(
        "aes-256-gcm",
        protectedKey.dataKey,
        iv,
        { authTagLength: AUTH_TAG_BYTES }
      );
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final()
      ]);
      const authTag = cipher.getAuthTag();
      const wrappedDataKeyBase64 = Buffer.from(
        protectedKey.wrappedDataKey
      ).toString("base64");

      const metadata: Metadata = {
        encryptionalgorithm: ENCRYPTION_ALGORITHM,
        keyid: protectedKey.keyId,
        wrappeddek: wrappedDataKeyBase64,
        iv: iv.toString("base64"),
        authtag: authTag.toString("base64")
      };

      try {
        await this.containerClient
          .getBlockBlobClient(blobName)
          .uploadData(ciphertext, {
            metadata,
            blobHTTPHeaders: {
              blobContentType: "application/octet-stream"
            }
          });
      } catch (error) {
        throw new Error(`Blob Storage could not upload blob "${blobName}"`, {
          cause: error
        });
      }

      return {
        keyId: protectedKey.keyId,
        wrappedDataKeyBase64
      };
    } finally {
      protectedKey.dataKey.fill(0);
    }
  }

  public async download(blobName: string): Promise<Buffer> {
    let ciphertext: Buffer;
    let metadata: Metadata | undefined;

    try {
      const response = await this.containerClient
        .getBlockBlobClient(blobName)
        .download();
      metadata = response.metadata;
      ciphertext = await streamToBuffer(response.readableStreamBody);
    } catch (error) {
      throw new Error(`Blob Storage could not download blob "${blobName}"`, {
        cause: error
      });
    }

    const encryption = parseEncryptionMetadata(metadata, blobName);
    const dataKey = await this.keyManagement.recoverDataKey(
      encryption.keyId,
      encryption.wrappedDataKey
    );

    try {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, encryption.iv, {
        authTagLength: AUTH_TAG_BYTES
      });
      decipher.setAuthTag(encryption.authTag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);
    } catch (error) {
      throw new Error(
        `Could not authenticate or decrypt blob "${blobName}"`,
        { cause: error }
      );
    } finally {
      dataKey.fill(0);
    }
  }
}

function parseEncryptionMetadata(
  metadata: Metadata | undefined,
  blobName: string
): EncryptionMetadata {
  if (
    metadata?.encryptionalgorithm !== ENCRYPTION_ALGORITHM ||
    !metadata.keyid ||
    !metadata.wrappeddek ||
    !metadata.iv ||
    !metadata.authtag
  ) {
    throw new Error(
      `Blob "${blobName}" is missing valid client-side encryption metadata`
    );
  }

  const wrappedDataKey = decodeBase64(metadata.wrappeddek, "wrapped DEK");
  const iv = decodeBase64(metadata.iv, "initialization vector");
  const authTag = decodeBase64(metadata.authtag, "authentication tag");

  if (wrappedDataKey.length === 0) {
    throw new Error(`Blob "${blobName}" has an empty wrapped DEK`);
  }
  if (iv.length !== IV_BYTES) {
    throw new Error(`Blob "${blobName}" has an invalid initialization vector`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(`Blob "${blobName}" has an invalid authentication tag`);
  }

  return {
    keyId: metadata.keyid,
    wrappedDataKey,
    iv,
    authTag
  };
}

function decodeBase64(value: string, fieldName: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`Blob metadata contains an invalid base64 ${fieldName}`);
  }
  return decoded;
}

async function streamToBuffer(
  stream: NodeJS.ReadableStream | undefined
): Promise<Buffer> {
  if (!stream) {
    throw new Error("Blob download response did not contain a body");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
