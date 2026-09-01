import { ManagedIdentityCredential } from "@azure/identity";
import { KeyClient } from "@azure/keyvault-keys";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";

export interface AzureConfiguration {
  credential: ManagedIdentityCredential;
  keyClient: KeyClient;
  containerClient: ContainerClient;
  keyName: string;
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export function createAzureConfiguration(): AzureConfiguration {
  const blobEndpoint = requiredEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
  const containerName = requiredEnvironmentVariable("AZURE_STORAGE_CONTAINER_NAME");
  const vaultUrl = requiredEnvironmentVariable("AZURE_KEY_VAULT_URL");
  const keyName = requiredEnvironmentVariable("AZURE_KEY_VAULT_KEY_NAME");
  const managedIdentityClientId = process.env.AZURE_CLIENT_ID?.trim();

  const credential = managedIdentityClientId
    ? new ManagedIdentityCredential({ clientId: managedIdentityClientId })
    : new ManagedIdentityCredential();

  const blobServiceClient = new BlobServiceClient(blobEndpoint, credential);

  return {
    credential,
    keyClient: new KeyClient(vaultUrl, credential),
    containerClient: blobServiceClient.getContainerClient(containerName),
    keyName
  };
}
