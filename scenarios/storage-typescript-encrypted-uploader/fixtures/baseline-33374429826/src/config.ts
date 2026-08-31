import { ManagedIdentityCredential } from "@azure/identity";
import { KeyClient } from "@azure/keyvault-keys";
import {
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";

export interface AzureConnections {
  credential: ManagedIdentityCredential;
  blobServiceClient: BlobServiceClient;
  containerClient: ContainerClient;
  keyClient: KeyClient;
  keyName: string;
}

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export function createAzureConnections(): AzureConnections {
  const blobServiceUrl = requireEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
  const containerName = requireEnvironmentVariable("AZURE_STORAGE_CONTAINER_NAME");
  const keyVaultUrl = requireEnvironmentVariable("AZURE_KEY_VAULT_URL");
  const keyName = requireEnvironmentVariable("AZURE_KEY_VAULT_KEY_NAME");

  // One credential instance is shared by Storage, Key Vault, and crypto clients.
  const credential = new ManagedIdentityCredential();
  const blobServiceClient = new BlobServiceClient(blobServiceUrl, credential);

  return {
    credential,
    blobServiceClient,
    containerClient: blobServiceClient.getContainerClient(containerName),
    keyClient: new KeyClient(keyVaultUrl, credential),
    keyName,
  };
}
