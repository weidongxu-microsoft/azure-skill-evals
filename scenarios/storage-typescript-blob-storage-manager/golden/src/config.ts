import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel } from "@azure/logger";
import {
  BlobServiceClient,
  StorageRetryPolicyType,
  type ContainerClient,
  type StorageRetryOptions,
} from "@azure/storage-blob";

type AzureLogLevel = "verbose" | "info" | "warning" | "error";

export interface BlobStorageConfiguration {
  accountUrl: string;
  containerName: string;
  logLevel: AzureLogLevel;
  retryOptions: StorageRetryOptions;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before running the application.`);
  }
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return parsed;
}

export function loadBlobStorageConfiguration(): BlobStorageConfiguration {
  const logLevel = (process.env.AZURE_LOG_LEVEL ?? "info") as AzureLogLevel;
  setLogLevel(logLevel);

  return {
    accountUrl: requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    logLevel,
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      maxRetryDelayInMs: integerEnvironment(
        "AZURE_STORAGE_MAX_RETRY_DELAY_MS",
        30_000,
      ),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1_000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(
  configuration: BlobStorageConfiguration,
): ContainerClient {
  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(
    configuration.accountUrl,
    credential,
    {
      retryOptions: configuration.retryOptions,
    },
  );
  return serviceClient.getContainerClient(configuration.containerName);
}
