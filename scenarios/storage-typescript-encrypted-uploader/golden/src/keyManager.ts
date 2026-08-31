import { RestError } from "@azure/core-rest-pipeline";
import { CryptographyClient, KeyClient } from "@azure/keyvault-keys";

type TokenCredential = ConstructorParameters<typeof KeyClient>[1];

export interface WrappedDataEncryptionKey {
  keyId: string;
  wrappedDek: Buffer;
}

export class KeyManager {
  private readonly keyClient: KeyClient;

  public constructor(
    vaultUrl: string,
    private readonly keyName: string,
    private readonly credential: TokenCredential,
  ) {
    this.keyClient = new KeyClient(vaultUrl, credential);
  }

  public async wrapDataEncryptionKey(
    dataEncryptionKey: Buffer,
  ): Promise<WrappedDataEncryptionKey> {
    try {
      const key = await this.keyClient.getKey(this.keyName);
      if (!key.id) throw new Error("The Key Vault key did not include an ID.");

      const cryptographyClient = new CryptographyClient(key.id, this.credential);
      const result = await cryptographyClient.wrapKey("RSA-OAEP", dataEncryptionKey);
      return { keyId: key.id, wrappedDek: Buffer.from(result.result) };
    } catch (error) {
      if (error instanceof RestError) {
        throw new Error(`Key Vault could not wrap the data key: ${error.message}`);
      }
      throw error;
    }
  }

  public async unwrapDataEncryptionKey(
    keyId: string,
    wrappedDek: Buffer,
  ): Promise<Buffer> {
    try {
      const cryptographyClient = new CryptographyClient(keyId, this.credential);
      const result = await cryptographyClient.unwrapKey("RSA-OAEP", wrappedDek);
      return Buffer.from(result.result);
    } catch (error) {
      if (error instanceof RestError) {
        throw new Error(`Key Vault could not unwrap the data key: ${error.message}`);
      }
      throw error;
    }
  }
}
