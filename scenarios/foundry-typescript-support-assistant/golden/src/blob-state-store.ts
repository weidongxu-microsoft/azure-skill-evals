import type { ContainerClient } from "@azure/storage-blob";
import { emptyState, type AssistantStateStore } from "./state-store.js";
import type { AssistantState } from "./types.js";

export class BlobStateStore implements AssistantStateStore {
  private etag: string | undefined;

  public constructor(
    private readonly container: ContainerClient,
    private readonly blobName: string,
  ) {}

  public async initialize(): Promise<void> {
    await this.container.createIfNotExists();
  }

  public async load(): Promise<AssistantState> {
    try {
      const response = await this.container
        .getBlockBlobClient(this.blobName)
        .download();
      this.etag = response.etag;
      if (response.readableStreamBody === undefined) {
        throw new Error(`State blob ${this.blobName} returned no content.`);
      }
      if (!isAsyncIterable(response.readableStreamBody)) {
        throw new Error(`State blob ${this.blobName} returned an unreadable stream.`);
      }
      const parsed: unknown = JSON.parse(
        await readableStreamToString(response.readableStreamBody),
      );
      if (!isAssistantState(parsed)) {
        throw new Error(`State blob ${this.blobName} has an unsupported shape.`);
      }
      return parsed;
    } catch (error) {
      if (hasStatusCode(error, 404)) {
        this.etag = undefined;
        return emptyState();
      }
      throw error;
    }
  }

  public async save(state: AssistantState): Promise<void> {
    const content = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    const response = await this.container
      .getBlockBlobClient(this.blobName)
      .uploadData(content, {
        blobHTTPHeaders: { blobContentType: "application/json" },
        conditions:
          this.etag === undefined
            ? { ifNoneMatch: "*" }
            : { ifMatch: this.etag },
      });
    this.etag = response.etag;
  }
}

function isAssistantState(value: unknown): value is AssistantState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<AssistantState>;
  return (
    candidate.version === 1 &&
    typeof candidate.conversations === "object" &&
    candidate.conversations !== null &&
    Array.isArray(candidate.answers) &&
    Array.isArray(candidate.unresolvedQuestions) &&
    Array.isArray(candidate.feedback)
  );
}

async function readableStreamToString(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isAsyncIterable(
  value: object,
): value is AsyncIterable<Uint8Array | string> {
  return Symbol.asyncIterator in value;
}

function hasStatusCode(error: unknown, expected: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (Reflect.get(error, "statusCode") === expected ||
      Reflect.get(error, "status") === expected)
  );
}
