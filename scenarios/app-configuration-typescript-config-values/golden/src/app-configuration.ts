import {
  AppConfigurationClient,
  featureFlagContentType,
  featureFlagPrefix,
  type ConfigurationSetting,
  type FeatureFlagValue,
} from "@azure/app-configuration";

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before running.`);
  }
  return value;
}

function isRestError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  );
}

async function main(): Promise<void> {
  const client = new AppConfigurationClient(
    requireEnvironment("AZURE_APPCONFIG_CONNECTION_STRING"),
  );
  const key = "app:Settings:FontSize";

  try {
    await client.setConfigurationSetting({ key, value: "24" });
    await client.setConfigurationSetting({
      key,
      value: "24",
      label: "Production",
    });

    const setting = await client.getConfigurationSetting({ key });
    console.log(setting.value);

    for await (const item of client.listConfigurationSettings({
      keyFilter: "app:Settings:*",
    })) {
      console.log(`${item.key}=${item.value}`);
    }

    const featureFlag: ConfigurationSetting<FeatureFlagValue> = {
      key: `${featureFlagPrefix}BetaFeature`,
      contentType: featureFlagContentType,
      isReadOnly: false,
      value: {
        id: "BetaFeature",
        enabled: true,
        conditions: { clientFilters: [] },
      },
    };
    await client.setConfigurationSetting(featureFlag);
    await client.deleteConfigurationSetting({ key });
  } catch (error: unknown) {
    if (isRestError(error)) {
      console.error(
        `App Configuration request failed with status ${error.statusCode}.`,
      );
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

await main();
