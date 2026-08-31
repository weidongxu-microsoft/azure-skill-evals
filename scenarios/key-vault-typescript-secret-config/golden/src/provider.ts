import { RestError } from "@azure/core-rest-pipeline";
import type { SecretClient } from "@azure/keyvault-secrets";

export interface ConfigSecret {
  value: string;
  expiresOn?: Date;
}

export class SecretProvider {
  public constructor(private readonly client: SecretClient) {}

  public async get(
    name: string,
    defaultValue = "",
    version?: string,
  ): Promise<ConfigSecret> {
    try {
      const secret = await this.client.getSecret(
        name,
        version ? { version } : {},
      );
      return {
        value: secret.value ?? defaultValue,
        expiresOn: secret.properties.expiresOn,
      };
    } catch (error: unknown) {
      if (error instanceof RestError && error.statusCode === 404) {
        return { value: defaultValue };
      }
      throw error;
    }
  }
}
