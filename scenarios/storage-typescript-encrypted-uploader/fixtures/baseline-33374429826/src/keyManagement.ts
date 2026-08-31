import { randomBytes } from "node:crypto";
import type { ManagedIdentityCredential } from "@azure/identity";
import {
  CryptographyClient,
  type KeyClient,
  type KeyWrapAlgorithm,
} from "@azure/keyvault-keys";

const DATA_KEY_BYTES = 32;
export const KEY_WRAP_ALGORITHM: KeyWrapAlgorithm = "RSA-OAEP-256";

export interface GeneratedDataKey {
  dataKey: Buffer;
  wrappedKey: Buffer;
  keyId: string;
}

export class KeyManagement {
  public constructor(
    private readonly keyClient: KeyClient,
    private readonly credential: ManagedIdentityCredential,
    private readonly keyName: string,
  ) {}

  public async generateAndWrapDataKey(): Promise<GeneratedDataKey> {
    const dataKey = randomBytes(DATA_KEY_BYTES);

    try {
      const key = await this.keyClient.getKey(this.keyName);
      if (!key.id) {
        throw new Error(`Key Vault key "${this.keyName}" has no key ID`);
      }

      const cryptoClient = new CryptographyClient(key.id, this.credential);
      const wrapped = await cryptoClient.wrapKey(KEY_WRAP_ALGORITHM, dataKey);

      return {
        dataKey,
        wrappedKey: Buffer.from(wrapped.result),
        keyId: key.id,
      };
    } catch (error) {
      dataKey.fill(0);
      throw new Error(
        `Key Vault could not generate the envelope key using "${this.keyName}"`,
        { cause: error },
      );
    }
  }

  public async unwrapDataKey(
    wrappedKey: Uint8Array,
    keyId: string,
  ): Promise<Buffer> {
    try {
      // The versioned ID stored with the blob ensures the same KEK is used.
      const cryptoClient = new CryptographyClient(keyId, this.credential);
      const unwrapped = await cryptoClient.unwrapKey(
        KEY_WRAP_ALGORITHM,
        wrappedKey,
      );
      const dataKey = Buffer.from(unwrapped.result);

      if (dataKey.length !== DATA_KEY_BYTES) {
        dataKey.fill(0);
        throw new Error(`Unwrapped data key has invalid length ${dataKey.length}`);
      }

      return dataKey;
    } catch (error) {
      throw new Error(`Key Vault could not unwrap the data key with "${keyId}"`, {
        cause: error,
      });
    }
  }
}
