import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";

import { KeyManager } from "./keyManager.js";

export interface ApplicationClients {
  containerClient: ContainerClient;
  keyManager: KeyManager;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running the application.`);
  return value;
}

export function createApplicationClients(): ApplicationClients {
  const credential = new DefaultAzureCredential();
  const storageEndpoint = requiredEnvironment("AZURE_STORAGE_ACCOUNT_URL");
  const containerName = requiredEnvironment("AZURE_STORAGE_CONTAINER_NAME");
  const vaultUrl = requiredEnvironment("AZURE_KEY_VAULT_URL");
  const keyName = requiredEnvironment("AZURE_KEY_NAME");

  const blobService = new BlobServiceClient(storageEndpoint, credential);
  return {
    containerClient: blobService.getContainerClient(containerName),
    keyManager: new KeyManager(vaultUrl, keyName, credential),
  };
}
