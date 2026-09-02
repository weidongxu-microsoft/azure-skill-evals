import { resolve } from "node:path";
import { AIProjectClient, RestError } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel, type AzureLogLevel } from "@azure/logger";
import { BlobServiceClient } from "@azure/storage-blob";
import { BlobStateStore } from "./blob-state-store.js";
import { loadConfig } from "./config.js";
import { loadEvaluationCases } from "./evaluation-data.js";
import { FoundrySupportGateway } from "./foundry-gateway.js";
import { SupportAssistant } from "./support-assistant.js";

const DEFAULT_MANUALS = [
  resolve("materials/contoso-aero-300.md"),
  resolve("materials/contoso-aero-300-warranty.md"),
];
const DEFAULT_EVALUATION_DATASET = resolve("evaluation/support-cases.jsonl");

async function main(args: string[]): Promise<void> {
  configureAzureLogging(process.env["AZURE_LOG_LEVEL"]);
  const config = loadConfig();
  const credential = new DefaultAzureCredential();
  const project = new AIProjectClient(
    config.projectEndpoint,
    credential,
  );
  const store = new BlobStateStore(
    new BlobServiceClient(config.storageAccountEndpoint, credential)
      .getContainerClient(config.stateContainerName),
    config.stateBlobName,
  );
  await store.initialize();
  const assistant = new SupportAssistant(
    new FoundrySupportGateway(
      project,
      config.modelDeploymentName,
      config.evaluationModelDeploymentName,
    ),
    store,
  );

  const [command, ...commandArgs] = args;
  switch (command) {
    case "ingest": {
      await assistant.ingest(
        commandArgs.length === 0
          ? DEFAULT_MANUALS
          : commandArgs.map((path) => resolve(path)),
      );
      console.log("Manual ingestion completed.");
      break;
    }
    case "ask": {
      const [conversationId, ...questionParts] = commandArgs;
      if (!conversationId || questionParts.length === 0) {
        throw new Error("Usage: ask <conversation-id> <question>");
      }
      const answer = await assistant.ask(
        conversationId,
        questionParts.join(" "),
      );
      console.log(JSON.stringify(answer, null, 2));
      break;
    }
    case "feedback": {
      const [conversationId, responseId, rating, ...commentParts] = commandArgs;
      if (
        !conversationId ||
        !responseId ||
        (rating !== "positive" && rating !== "negative")
      ) {
        throw new Error(
          "Usage: feedback <conversation-id> <response-id> <positive|negative> [comment]",
        );
      }
      const comment = commentParts.join(" ").trim();
      await assistant.recordFeedback(
        conversationId,
        responseId,
        rating,
        comment.length === 0 ? undefined : comment,
      );
      console.log("Feedback recorded.");
      break;
    }
    case "evaluate": {
      const datasetPath = resolve(commandArgs[0] ?? DEFAULT_EVALUATION_DATASET);
      const metrics = await assistant.evaluate(
        await loadEvaluationCases(datasetPath),
      );
      console.log(JSON.stringify(metrics, null, 2));
      break;
    }
    case "cleanup": {
      await assistant.cleanup();
      console.log("Foundry resources deleted.");
      break;
    }
    default:
      throw new Error(
        "Usage: <ingest|ask|feedback|evaluate|cleanup> [arguments]",
      );
  }
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

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof RestError) {
    console.error(
      `Azure request failed: status=${String(error.statusCode)} code=${error.code ?? "unknown"} message=${error.message}`,
    );
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
