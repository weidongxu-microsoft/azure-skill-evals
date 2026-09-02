import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { AIProjectClient, RestError } from "@azure/ai-projects";
import type {
  Citation,
  EvaluationMetric,
  EvaluationRow,
  FoundryResources,
  GatewayAnswer,
  SupportGateway,
} from "./types.js";

type OpenAIClient = ReturnType<AIProjectClient["getOpenAIClient"]>;
type EvalCreateBody = Parameters<OpenAIClient["evals"]["create"]>[0];
type FoundryResponse = Extract<
  Awaited<ReturnType<OpenAIClient["responses"]["create"]>>,
  { output: unknown }
>;

const TERMINAL_EVALUATION_STATUSES = new Set([
  "completed",
  "failed",
  "canceled",
  "cancelled",
]);
const TERMINAL_FILE_STATUSES = new Set(["completed", "failed", "cancelled"]);

interface AzureEvaluatorCriterion {
  type: "azure_ai_evaluator";
  name: string;
  evaluator_name: string;
  initialization_parameters: {
    deployment_name: string;
  };
  data_mapping: Record<string, string>;
}

export class FoundrySupportGateway implements SupportGateway {
  private readonly openAI: OpenAIClient;

  public constructor(
    private readonly project: AIProjectClient,
    private readonly modelDeploymentName: string,
    private readonly evaluationModelDeploymentName: string,
    private readonly pollIntervalMs = 2_000,
    private readonly ingestionTimeoutMs = 10 * 60_000,
    private readonly evaluationTimeoutMs = 10 * 60_000,
  ) {
    this.openAI = project.getOpenAIClient();
  }

  public async ingest(manualPaths: string[]): Promise<FoundryResources> {
    if (manualPaths.length === 0) {
      throw new Error("At least one manual is required.");
    }

    const suffix = Date.now().toString(36);
    const vectorStore = await this.openAI.vectorStores.create({
      name: `contoso-support-${suffix}`,
    });
    const fileIds: string[] = [];
    let agent: { name: string; version: string } | undefined;

    try {
      for (const manualPath of manualPaths) {
        const uploadedFile = await this.openAI.files.create({
          file: createReadStream(manualPath),
          purpose: "assistants",
        });
        fileIds.push(uploadedFile.id);
        const indexedFile = await this.openAI.vectorStores.files.create(
          vectorStore.id,
          { file_id: uploadedFile.id },
        );
        const completedFile = await this.pollVectorStoreFile(
          vectorStore.id,
          indexedFile.id,
        );
        if (completedFile.status !== "completed") {
          const detail = completedFile.last_error?.message ?? completedFile.status;
          throw new Error(
            `Indexing failed for ${basename(manualPath)}: ${detail}`,
          );
        }
      }

      agent = await this.project.agents.createVersion(
        `contoso-product-support-${suffix}`,
        {
          kind: "prompt",
          model: this.modelDeploymentName,
          instructions: [
            "You are Contoso's internal product-support assistant.",
            "Use file search before answering every product question.",
            "Answer only from the indexed product manuals.",
            "If the manuals do not support an answer, begin the response with 'UNSUPPORTED:' and explain what information is missing.",
            "Never use general knowledge to fill gaps.",
            "For supported answers, preserve the file-search citations in the response.",
          ].join(" "),
          tools: [
            {
              type: "file_search",
              vector_store_ids: [vectorStore.id],
            },
          ],
        },
      );

      return {
        vectorStoreId: vectorStore.id,
        fileIds,
        agentName: agent.name,
        agentVersion: agent.version,
      };
    } catch (error) {
      const cleanupErrors = await this.cleanupResources(
        {
          vectorStoreId: vectorStore.id,
          fileIds,
          ...(agent === undefined
            ? {}
            : { agentName: agent.name, agentVersion: agent.version }),
        },
        [],
      );
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [toError(error), ...cleanupErrors],
          "Ingestion failed and some created resources could not be cleaned up.",
        );
      }
      throw error;
    }
  }

  public async ask(
    resources: FoundryResources,
    conversationId: string | undefined,
    question: string,
  ): Promise<GatewayAnswer> {
    let activeConversationId = conversationId;
    let createdConversation = false;

    if (activeConversationId === undefined) {
      const conversation = await this.openAI.conversations.create({});
      activeConversationId = conversation.id;
      createdConversation = true;
    }

    const createdInput = await this.openAI.conversations.items.create(
      activeConversationId,
      {
        items: [{ type: "message", role: "user", content: question }],
      },
    );
    const turnItemIds = createdInput.data.flatMap((item) =>
      typeof item.id === "string" ? [item.id] : [],
    );

    try {
      const response = await this.openAI.responses.create(
        {
          conversation: activeConversationId,
          include: ["file_search_call.results"],
        },
        {
          body: {
            agent_reference: {
              name: resources.agentName,
              type: "agent_reference",
              version: resources.agentVersion,
            },
          },
        },
      );
      if (!("output" in response)) {
        throw new Error("Foundry unexpectedly returned a streaming response.");
      }
      turnItemIds.push(
        ...response.output.flatMap((item) =>
          typeof item.id === "string" ? [item.id] : [],
        ),
      );
      if (response.status !== "completed") {
        throw new Error(
          `Foundry response ${response.id} ended with status ${response.status}.`,
        );
      }

      const citations = extractFileCitations(response);
      const retrievedContext = extractRetrievedContext(response);
      const text = response.output_text.trim();
      return {
        conversationId: activeConversationId,
        responseId: response.id,
        text,
        citations,
        retrievedContext,
        turnItemIds,
        supported:
          citations.length > 0 && !text.toUpperCase().startsWith("UNSUPPORTED:"),
      };
    } catch (error) {
      try {
        if (createdConversation) {
          await this.deleteConversation(activeConversationId);
        } else {
          await this.rollbackTurn(activeConversationId, turnItemIds);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [toError(error), toError(cleanupError)],
          "The response failed and its conversation changes could not be rolled back.",
        );
      }
      throw error;
    }
  }

  public async deleteConversation(conversationId: string): Promise<void> {
    await this.rollbackTurn(
      conversationId,
      await this.listConversationItemIds(conversationId),
    );
    await this.openAI.conversations.delete(conversationId);
  }

  public async rollbackTurn(
    conversationId: string,
    itemIds: string[],
  ): Promise<void> {
    const errors: Error[] = [];
    for (const itemId of itemIds) {
      try {
        await this.openAI.conversations.items.delete(itemId, {
          conversation_id: conversationId,
        });
      } catch (error) {
        if (!isNotFound(error)) {
          errors.push(toError(error));
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "The conversation turn was not rolled back.");
    }
  }

  public async runEvaluation(
    rows: EvaluationRow[],
  ): Promise<EvaluationMetric[]> {
    if (rows.length === 0) {
      throw new Error("At least one evaluation row is required.");
    }

    const testingCriteria = [
      {
        type: "azure_ai_evaluator",
        name: "groundedness",
        evaluator_name: "builtin.groundedness",
        initialization_parameters: {
          deployment_name: this.evaluationModelDeploymentName,
        },
        data_mapping: {
          query: "{{item.query}}",
          response: "{{item.response}}",
          context: "{{item.context}}",
        },
      },
      {
        type: "azure_ai_evaluator",
        name: "relevance",
        evaluator_name: "builtin.relevance",
        initialization_parameters: {
          deployment_name: this.evaluationModelDeploymentName,
        },
        data_mapping: {
          query: "{{item.query}}",
          response: "{{item.response}}",
        },
      },
    ] satisfies AzureEvaluatorCriterion[];

    const evaluation = await this.openAI.evals.create({
      name: `contoso-support-${Date.now().toString(36)}`,
      data_source_config: {
        type: "custom",
        item_schema: {
          type: "object",
          properties: {
            query: { type: "string" },
            response: { type: "string" },
            context: { type: "string" },
            ground_truth: { type: "string" },
          },
          required: ["query", "response", "context", "ground_truth"],
        },
        include_sample_schema: true,
      },
      // Foundry accepts Azure evaluators that are not yet in OpenAI's type union.
      testing_criteria:
        testingCriteria as unknown as EvalCreateBody["testing_criteria"],
    });

    try {
      let run = await this.openAI.evals.runs.create(evaluation.id, {
        name: `contoso-support-run-${Date.now().toString(36)}`,
        data_source: {
          type: "jsonl",
          source: {
            type: "file_content",
            content: rows.map((item) => ({ item })),
          },
        },
      });
      const deadline = Date.now() + this.evaluationTimeoutMs;

      while (!TERMINAL_EVALUATION_STATUSES.has(run.status)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Evaluation run ${run.id} did not finish within ${String(this.evaluationTimeoutMs)} ms.`,
          );
        }
        await delay(this.pollIntervalMs);
        run = await this.openAI.evals.runs.retrieve(run.id, {
          eval_id: evaluation.id,
        });
      }
      if (run.status !== "completed") {
        throw new Error(
          `Evaluation run ${run.id} ended with status ${run.status}.`,
        );
      }

      const metrics: EvaluationMetric[] = [];
      for await (const item of this.openAI.evals.runs.outputItems.list(run.id, {
        eval_id: evaluation.id,
      })) {
        for (const result of item.results) {
          metrics.push({
            itemId: item.id,
            itemStatus: item.status,
            name: result.name,
            score: result.score,
            passed: result.passed,
          });
        }
      }
      return metrics;
    } finally {
      await this.openAI.evals.delete(evaluation.id);
    }
  }

  public async cleanup(
    resources: FoundryResources,
    conversationIds: string[],
  ): Promise<void> {
    const errors = await this.cleanupResources(resources, conversationIds);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Some Foundry resources were not deleted.");
    }
  }

  private async cleanupResources(
    resources: Partial<FoundryResources> & { vectorStoreId?: string },
    conversationIds: string[],
  ): Promise<Error[]> {
    const errors: Error[] = [];
    for (const conversationId of new Set(conversationIds)) {
      try {
        await this.deleteConversation(conversationId);
      } catch (error) {
        if (!isNotFound(error)) {
          errors.push(toError(error));
        }
      }
    }
    if (
      resources.agentName !== undefined &&
      resources.agentVersion !== undefined
    ) {
      try {
        await this.project.agents.deleteVersion(
          resources.agentName,
          resources.agentVersion,
        );
      } catch (error) {
        if (!isNotFound(error)) {
          errors.push(toError(error));
        }
      }
    }
    if (resources.vectorStoreId !== undefined) {
      try {
        await this.openAI.vectorStores.delete(resources.vectorStoreId);
      } catch (error) {
        if (!isNotFound(error)) {
          errors.push(toError(error));
        }
      }
    }
    for (const fileId of resources.fileIds ?? []) {
      try {
        await this.openAI.files.delete(fileId);
      } catch (error) {
        if (!isNotFound(error)) {
          errors.push(toError(error));
        }
      }
    }
    return errors;
  }

  private async pollVectorStoreFile(
    vectorStoreId: string,
    fileId: string,
  ) {
    const deadline = Date.now() + this.ingestionTimeoutMs;
    let file = await this.openAI.vectorStores.files.retrieve(fileId, {
      vector_store_id: vectorStoreId,
    });
    while (!TERMINAL_FILE_STATUSES.has(file.status)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Vector-store file ${fileId} did not finish within ${String(this.ingestionTimeoutMs)} ms.`,
        );
      }
      await delay(this.pollIntervalMs);
      file = await this.openAI.vectorStores.files.retrieve(fileId, {
        vector_store_id: vectorStoreId,
      });
    }
    return file;
  }

  private async listConversationItemIds(
    conversationId: string,
  ): Promise<string[]> {
    const itemIds: string[] = [];
    for await (const item of this.openAI.conversations.items.list(
      conversationId,
    )) {
      if (typeof item.id === "string") {
        itemIds.push(item.id);
      }
    }
    return itemIds;
  }
}

function extractFileCitations(response: FoundryResponse): Citation[] {
  const citations = new Map<string, Citation>();
  for (const output of response.output) {
    if (output.type !== "message") {
      continue;
    }
    for (const content of output.content) {
      if (content.type !== "output_text") {
        continue;
      }
      for (const annotation of content.annotations) {
        if (annotation.type === "file_citation") {
          citations.set(annotation.file_id, {
            fileId: annotation.file_id,
            filename: annotation.filename,
          });
        }
      }
    }
  }
  return [...citations.values()];
}

function extractRetrievedContext(response: FoundryResponse): string[] {
  const chunks: string[] = [];
  for (const output of response.output) {
    if (output.type !== "file_search_call") {
      continue;
    }
    for (const result of output.results ?? []) {
      if (typeof result.text === "string" && result.text.trim().length > 0) {
        chunks.push(result.text.trim());
      }
    }
  }
  return chunks;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNotFound(error: unknown): boolean {
  if (error instanceof RestError) {
    return error.statusCode === 404;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    Reflect.get(error, "status") === 404
  );
}
