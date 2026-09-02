import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { BlobStateStore } from "./blob-state-store.js";
import { loadServerConfig } from "./config.js";
import { FoundrySupportGateway } from "./foundry-gateway.js";
import { createSupportServer } from "./server.js";
import { SupportAssistant } from "./support-assistant.js";

async function main(): Promise<void> {
  const config = loadServerConfig();
  const credential = new DefaultAzureCredential();
  const store = new BlobStateStore(
    new BlobServiceClient(config.storageAccountEndpoint, credential)
      .getContainerClient(config.stateContainerName),
    config.stateBlobName,
  );
  await store.initialize();

  const project = new AIProjectClient(config.projectEndpoint, credential);
  const assistant = new SupportAssistant(
    new FoundrySupportGateway(
      project,
      config.modelDeploymentName,
      config.evaluationModelDeploymentName,
    ),
    store,
  );
  const server = createSupportServer(assistant, {
    requireAuthentication: true,
    adminPrincipalIds: new Set(config.adminPrincipalIds),
  });
  server.listen(config.port, () => {
    console.log(`Support assistant listening on port ${String(config.port)}.`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
