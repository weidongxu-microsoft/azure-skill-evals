import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { URL } from "node:url";
import { RestError } from "@azure/ai-projects";
import { loadEvaluationCases } from "./evaluation-data.js";
import type { SupportAssistant } from "./support-assistant.js";

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MANUALS = [
  resolve("materials/contoso-aero-300.md"),
  resolve("materials/contoso-aero-300-warranty.md"),
];
const DEFAULT_EVALUATION_DATASET = resolve("evaluation/support-cases.jsonl");

export interface SupportServerOptions {
  requireAuthentication: boolean;
  adminPrincipalIds: ReadonlySet<string>;
}

const TEST_OPTIONS: SupportServerOptions = {
  requireAuthentication: false,
  adminPrincipalIds: new Set(["test-user"]),
};

export function createSupportServer(
  assistant: SupportAssistant,
  options: SupportServerOptions = TEST_OPTIONS,
): Server {
  let operationQueue = Promise.resolve();
  const operations = new Map<string, OperationRecord>();
  const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = operationQueue;
    let release = (): void => undefined;
    operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      const principalId = authorize(request, options);
      const result = await runExclusive(() =>
        route(request, assistant, principalId, options, operations),
      );
      sendJson(response, result.status, result.body);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof RestError
          ? `Azure request failed: status=${String(error.statusCode)} code=${error.code ?? "unknown"} message=${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      sendJson(response, status, { error: message });
    }
  });
}

async function route(
  request: IncomingMessage,
  assistant: SupportAssistant,
  principalId: string,
  options: SupportServerOptions,
  operations: Map<string, OperationRecord>,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (
    url.pathname.startsWith("/admin/") &&
    !options.adminPrincipalIds.has(principalId)
  ) {
    throw new HttpError(403, "Administrator access is required.");
  }

  if (request.method === "POST" && url.pathname === "/admin/ingest") {
    await readJson(request);
    await assistant.ingest(DEFAULT_MANUALS);
    return { status: 201, body: { status: "ingested" } };
  }

  const messageMatch = url.pathname.match(
    /^\/conversations\/([^/]+)\/messages$/,
  );
  if (request.method === "POST" && messageMatch !== null) {
    const body = await readJson(request);
    const question = requiredString(body, "question");
    const answer = await assistant.ask(
      scopedConversationId(
        principalId,
        decodeURIComponent(messageMatch[1] ?? ""),
      ),
      question,
    );
    return { status: 200, body: answer };
  }

  const feedbackMatch = url.pathname.match(
    /^\/conversations\/([^/]+)\/feedback$/,
  );
  if (request.method === "POST" && feedbackMatch !== null) {
    const body = await readJson(request);
    const rating = requiredString(body, "rating");
    if (rating !== "positive" && rating !== "negative") {
      throw new HttpError(400, "rating must be positive or negative.");
    }
    await assistant.recordFeedback(
      scopedConversationId(
        principalId,
        decodeURIComponent(feedbackMatch[1] ?? ""),
      ),
      requiredString(body, "responseId"),
      rating,
      optionalString(body, "comment"),
    );
    return { status: 201, body: { status: "recorded" } };
  }

  if (request.method === "GET" && url.pathname === "/admin/unresolved") {
    return {
      status: 200,
      body: { items: await assistant.listUnresolvedQuestions() },
    };
  }

  if (request.method === "POST" && url.pathname === "/admin/evaluations") {
    const body = await readJson(request);
    const datasetPath = resolve(
      optionalString(body, "datasetPath") ?? DEFAULT_EVALUATION_DATASET,
    );
    const operationId = startOperation(
      operations,
      async () =>
        await assistant.evaluate(await loadEvaluationCases(datasetPath)),
    );
    return { status: 202, body: { operationId } };
  }

  const operationMatch = url.pathname.match(/^\/admin\/operations\/([^/]+)$/);
  if (request.method === "GET" && operationMatch !== null) {
    const operationId = decodeURIComponent(operationMatch[1] ?? "");
    const operation = operations.get(operationId);
    if (operation === undefined) {
      throw new HttpError(404, "Operation not found.");
    }
    return { status: 200, body: operation };
  }

  if (request.method === "DELETE" && url.pathname === "/admin/resources") {
    if ([...operations.values()].some((operation) => operation.status === "running")) {
      throw new HttpError(
        409,
        "Wait for active evaluation operations before cleanup.",
      );
    }
    await assistant.cleanup();
    return { status: 200, body: { status: "deleted" } };
  }

  throw new HttpError(404, "Route not found.");
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body exceeds 1 MiB.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "Request body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "Request body contains invalid JSON.");
  }
}

function requiredString(
  body: Record<string, unknown>,
  property: string,
): string {
  const value = optionalString(body, property);
  if (value === undefined) {
    throw new HttpError(400, `${property} is required.`);
  }
  return value;
}

function optionalString(
  body: Record<string, unknown>,
  property: string,
): string | undefined {
  const value = body[property];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${property} must be a non-empty string.`);
  }
  return value.trim();
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface OperationRecord {
  status: "running" | "completed" | "failed";
  result?: unknown;
  error?: string;
}

function startOperation(
  operations: Map<string, OperationRecord>,
  operation: () => Promise<unknown>,
): string {
  const operationId = randomUUID();
  operations.set(operationId, { status: "running" });
  void executeOperation(operations, operationId, operation);
  return operationId;
}

async function executeOperation(
  operations: Map<string, OperationRecord>,
  operationId: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await operation();
    operations.set(operationId, { status: "completed", result });
  } catch (error) {
    operations.set(operationId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function authorize(
  request: IncomingMessage,
  options: SupportServerOptions,
): string {
  if (!options.requireAuthentication) {
    return "test-user";
  }
  const principalId = request.headers["x-ms-client-principal-id"];
  if (typeof principalId !== "string" || principalId.trim().length === 0) {
    throw new HttpError(401, "Microsoft Entra authentication is required.");
  }
  return principalId.trim();
}

function scopedConversationId(
  principalId: string,
  conversationId: string,
): string {
  if (conversationId.length === 0) {
    throw new HttpError(400, "conversation ID is required.");
  }
  return `${principalId}:${conversationId}`;
}
