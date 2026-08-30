import type { ConfigSecret, SecretProvider } from "./provider.js";

export class SecretCache {
  private readonly values = new Map<string, ConfigSecret>();

  public constructor(
    private readonly provider: SecretProvider,
    private readonly warningWindowMs: number,
  ) {}

  public async bulkLoad(names: readonly string[]): Promise<void> {
    for (const name of names) {
      await this.refresh(name);
    }
  }

  public async get(name: string, defaultValue = ""): Promise<string> {
    if (!this.values.has(name)) {
      await this.refresh(name, defaultValue);
    }
    return this.values.get(name)?.value ?? defaultValue;
  }

  public async refresh(
    name: string,
    defaultValue = "",
  ): Promise<ConfigSecret> {
    const secret = await this.provider.get(name, defaultValue);
    this.values.set(name, secret);
    return secret;
  }

  public async refreshExpiring(): Promise<string[]> {
    const deadline = Date.now() + this.warningWindowMs;
    const expiring = [...this.values]
      .filter(([, secret]) =>
        secret.expiresOn !== undefined &&
        secret.expiresOn.getTime() <= deadline)
      .map(([name]) => name);
    for (const name of expiring) {
      console.warn(`Warning: ${name} expires soon`);
      await this.refresh(name);
    }
    return expiring;
  }
}
