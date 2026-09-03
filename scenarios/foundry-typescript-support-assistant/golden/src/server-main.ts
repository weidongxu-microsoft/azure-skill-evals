import { AIProjectClient } from "@azure/ai-projects";
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import { setLogLevel, type AzureLogLevel } from "@azure/logger";
import { BlobServiceClient } from "@azure/storage-blob";
import { logError, logInfo } from "./app-logger.js";
import { BlobStateStore } from "./blob-state-store.js";
import { loadServerConfig } from "./config.js";
import { FoundrySupportGateway } from "./foundry-gateway.js";
import { createSupportServer } from "./server.js";
import { SupportAssistant } from "./support-assistant.js";

async function main(): Promise<void> {
  configureAzureLogging(process.env["AZURE_LOG_LEVEL"]);
  const config = loadServerConfig();
  const credential =
    process.env["AZURE_TOKEN_CREDENTIALS"] === "prod"
      ? new ManagedIdentityCredential()
      : new DefaultAzureCredential();
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
    logInfo("server.started", { port: config.port });
  });
}

function configureAzureLogging(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  const levels = new Set<AzureLogLevel>([
    "verbose",
    "info",
    "warning",
    "error",
  ]);
  if (!levels.has(value as AzureLogLevel)) {
    throw new Error(
      "AZURE_LOG_LEVEL must be verbose, info, warning, or error.",
    );
  }
  setLogLevel(value as AzureLogLevel);
}

main().catch((error: unknown) => {
  logError("server.start_failed", error);
  process.exitCode = 1;
});
