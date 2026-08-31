import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { ContainerClient, Metadata } from "@azure/storage-blob";
import {
  KEY_WRAP_ALGORITHM,
  type KeyManagement,
} from "./keyManagement.js";

const CONTENT_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const REQUIRED_METADATA = [
  "encryptionalgorithm",
  "keywrapalgorithm",
  "keyid",
  "wrappeddek",
  "iv",
  "authtag",
] as const;

export interface UploadEncryptionDetails {
  keyId: string;
  wrappedDataKeyBase64: string;
}

export class EncryptedBlobStorage {
  public constructor(
    private readonly containerClient: ContainerClient,
    private readonly keyManagement: KeyManagement,
  ) {}

  public async upload(
    blobName: string,
    plaintext: Buffer | string,
  ): Promise<UploadEncryptionDetails> {
    const envelope = await this.keyManagement.generateAndWrapDataKey();

    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(CONTENT_ALGORITHM, envelope.dataKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(
          typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext,
        ),
        cipher.final(),
      ]);
      const authenticationTag = cipher.getAuthTag();
      const wrappedDataKeyBase64 = envelope.wrappedKey.toString("base64");

      const metadata: Metadata = {
        encryptionalgorithm: CONTENT_ALGORITHM,
        keywrapalgorithm: KEY_WRAP_ALGORITHM,
        keyid: envelope.keyId,
        wrappeddek: wrappedDataKeyBase64,
        iv: iv.toString("base64"),
        authtag: authenticationTag.toString("base64"),
      };

      try {
        await this.containerClient.getBlockBlobClient(blobName).uploadData(
          ciphertext,
          {
            metadata,
            blobHTTPHeaders: {
              blobContentType: "application/octet-stream",
            },
          },
        );
      } catch (error) {
        throw new Error(`Blob Storage could not upload "${blobName}"`, {
          cause: error,
        });
      }

      return {
        keyId: envelope.keyId,
        wrappedDataKeyBase64,
      };
    } finally {
      envelope.dataKey.fill(0);
    }
  }

  public async download(blobName: string): Promise<Buffer> {
    let ciphertext: Buffer;
    let metadata: Metadata;

    try {
      const response = await this.containerClient
        .getBlockBlobClient(blobName)
        .download();
      metadata = response.metadata ?? {};
      ciphertext = await streamToBuffer(response.readableStreamBody);
    } catch (error) {
      throw new Error(`Blob Storage could not download "${blobName}"`, {
        cause: error,
      });
    }

    const values = readEncryptionMetadata(metadata, blobName);
    if (values.encryptionalgorithm !== CONTENT_ALGORITHM) {
      throw new Error(
        `Blob "${blobName}" uses unsupported encryption algorithm "${values.encryptionalgorithm}"`,
      );
    }
    if (values.keywrapalgorithm !== KEY_WRAP_ALGORITHM) {
      throw new Error(
        `Blob "${blobName}" uses unsupported key-wrap algorithm "${values.keywrapalgorithm}"`,
      );
    }

    const dataKey = await this.keyManagement.unwrapDataKey(
      Buffer.from(values.wrappeddek, "base64"),
      values.keyid,
    );

    try {
      const decipher = createDecipheriv(
        CONTENT_ALGORITHM,
        dataKey,
        Buffer.from(values.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(values.authtag, "base64"));
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      throw new Error(
        `Authentication or decryption failed for blob "${blobName}"`,
        { cause: error },
      );
    } finally {
      dataKey.fill(0);
    }
  }
}

type EncryptionMetadata = Record<(typeof REQUIRED_METADATA)[number], string>;

function readEncryptionMetadata(
  metadata: Metadata,
  blobName: string,
): EncryptionMetadata {
  return {
    encryptionalgorithm: requireMetadata(
      metadata,
      "encryptionalgorithm",
      blobName,
    ),
    keywrapalgorithm: requireMetadata(metadata, "keywrapalgorithm", blobName),
    keyid: requireMetadata(metadata, "keyid", blobName),
    wrappeddek: requireMetadata(metadata, "wrappeddek", blobName),
    iv: requireMetadata(metadata, "iv", blobName),
    authtag: requireMetadata(metadata, "authtag", blobName),
  };
}

function requireMetadata(
  metadata: Metadata,
  name: (typeof REQUIRED_METADATA)[number],
  blobName: string,
): string {
  const value = metadata[name];
  if (!value) {
    throw new Error(`Blob "${blobName}" is missing metadata "${name}"`);
  }
  return value;
}

async function streamToBuffer(
  stream: NodeJS.ReadableStream | undefined,
): Promise<Buffer> {
  if (!stream) {
    throw new Error("Blob download did not return a readable stream");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
