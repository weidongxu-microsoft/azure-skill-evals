import { randomBytes } from "node:crypto";
import {
  CryptographyClient,
  KeyClient
} from "@azure/keyvault-keys";
import type { KeyWrapAlgorithm } from "@azure/keyvault-keys";
import type { TokenCredential } from "@azure/core-auth";

const WRAP_ALGORITHM: KeyWrapAlgorithm = "RSA-OAEP-256";
const DATA_KEY_BYTES = 32;

export interface ProtectedDataKey {
  dataKey: Buffer;
  wrappedDataKey: Uint8Array;
  keyId: string;
}

export class KeyManagement {
  public constructor(
    private readonly keyClient: KeyClient,
    private readonly credential: TokenCredential,
    private readonly keyName: string
  ) {}

  public async createProtectedDataKey(): Promise<ProtectedDataKey> {
    const dataKey = randomBytes(DATA_KEY_BYTES);

    try {
      const key = await this.keyClient.getKey(this.keyName);
      if (!key.id) {
        throw new Error(`Key Vault key ${this.keyName} did not include a key ID`);
      }

      const cryptoClient = new CryptographyClient(key.id, this.credential);
      const result = await cryptoClient.wrapKey(WRAP_ALGORITHM, dataKey);

      return {
        dataKey,
        wrappedDataKey: result.result,
        keyId: key.id
      };
    } catch (error) {
      dataKey.fill(0);
      throw new Error(
        `Key Vault could not wrap a data encryption key with key "${this.keyName}"`,
        { cause: error }
      );
    }
  }

  public async recoverDataKey(
    keyId: string,
    wrappedDataKey: Uint8Array
  ): Promise<Buffer> {
    try {
      const cryptoClient = new CryptographyClient(keyId, this.credential);
      const result = await cryptoClient.unwrapKey(
        WRAP_ALGORITHM,
        wrappedDataKey
      );
      const dataKey = Buffer.from(result.result);

      if (dataKey.length !== DATA_KEY_BYTES) {
        dataKey.fill(0);
        throw new Error(
          `Unwrapped data encryption key has invalid length ${dataKey.length}`
        );
      }

      return dataKey;
    } catch (error) {
      throw new Error(
        `Key Vault could not unwrap the data encryption key with key "${keyId}"`,
        { cause: error }
      );
    }
  }
}
