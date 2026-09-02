import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssistantState } from "./types.js";

export interface AssistantStateStore {
  load(): Promise<AssistantState>;
  save(state: AssistantState): Promise<void>;
}

export class StateStore implements AssistantStateStore {
  public constructor(private readonly path: string) {}

  public async load(): Promise<AssistantState> {
    try {
      const content = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (!isAssistantState(parsed)) {
        throw new Error(`State file has an unsupported shape: ${this.path}`);
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  public async save(state: AssistantState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }
}

export function emptyState(): AssistantState {
  return {
    version: 1,
    conversations: {},
    answers: [],
    unresolvedQuestions: [],
    feedback: [],
  };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
