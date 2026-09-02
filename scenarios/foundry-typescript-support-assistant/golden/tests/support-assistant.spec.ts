import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSupportServer } from "../src/server.js";
import { StateStore } from "../src/state-store.js";
import { SupportAssistant } from "../src/support-assistant.js";
import type {
  AssistantState,
  EvaluationMetric,
  EvaluationRow,
  FoundryResources,
  GatewayAnswer,
  SupportAnswer,
  SupportGateway,
} from "../src/types.js";

const RESOURCES: FoundryResources = {
  vectorStoreId: "vector-store-1",
  fileIds: ["file-1"],
  agentName: "support-agent",
  agentVersion: "1",
};

test("records supported answers, feedback, and unresolved questions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-assistant-"));
  try {
    const statePath = join(directory, "state.json");
    const gateway = new FakeGateway();
    const assistant = new SupportAssistant(gateway, new StateStore(statePath));

    await assistant.ingest(["manual.md"]);
    const supported = await assistant.ask("employee-1", "How do I reset it?");
    await assistant.recordFeedback(
      "employee-1",
      supported.responseId,
      "positive",
      "Clear steps",
    );
    gateway.nextSupported = false;
    const unsupported = await assistant.ask(
      "employee-1",
      "Does it support satellite control?",
    );

    assert.equal(supported.supported, true);
    assert.equal(unsupported.supported, false);
    assert.equal(gateway.seenConversationIds[1], supported.conversationId);

    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      answers: unknown[];
      feedback: unknown[];
      unresolvedQuestions: unknown[];
    };
    assert.equal(state.answers.length, 2);
    assert.equal(state.feedback.length, 1);
    assert.equal(state.unresolvedQuestions.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs evaluation and deletes its temporary conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-assistant-"));
  try {
    const gateway = new FakeGateway();
    const assistant = new SupportAssistant(
      gateway,
      new StateStore(join(directory, "state.json")),
    );
    await assistant.ingest(["manual.md"]);

    const metrics = await assistant.evaluate([
      {
        id: "reset",
        query: "How do I reset it?",
        context: "Hold reset for ten seconds.",
        groundTruth: "Hold reset for ten seconds.",
      },
    ]);

    assert.equal(metrics[0]?.name, "groundedness");
    assert.deepEqual(gateway.deletedConversationIds, ["conversation-1"]);
    assert.equal(gateway.evaluationRows[0]?.query, "How do I reset it?");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects feedback for an unknown response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-assistant-"));
  try {
    const assistant = new SupportAssistant(
      new FakeGateway(),
      new StateStore(join(directory, "state.json")),
    );
    await assistant.ingest(["manual.md"]);

    await assert.rejects(
      assistant.recordFeedback(
        "employee-1",
        "missing-response",
        "negative",
      ),
      /does not belong to conversation/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deletes new cloud resources when initial state persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-assistant-"));
  try {
    const gateway = new FakeGateway();
    const assistant = new SupportAssistant(
      gateway,
      new FailingStateStore(join(directory, "state.json"), 1),
    );

    await assert.rejects(assistant.ingest(["manual.md"]), /save failed/);

    assert.equal(gateway.cleanupCallCount, 1);
    assert.deepEqual(gateway.cleanedConversationIds, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deletes a new conversation when answer persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-assistant-"));
  try {
    const gateway = new FakeGateway();
    const assistant = new SupportAssistant(
      gateway,
      new FailingStateStore(join(directory, "state.json"), 2),
    );
    await assistant.ingest(["manual.md"]);

    await assert.rejects(
      assistant.ask("employee-1", "How do I reset it?"),
      /save failed/,
    );

    assert.deepEqual(gateway.deletedConversationIds, ["conversation-1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rolls back an existing turn when answer persistence fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-assistant-"));
  try {
    const gateway = new FakeGateway();
    const assistant = new SupportAssistant(
      gateway,
      new FailingStateStore(join(directory, "state.json"), 3),
    );
    await assistant.ingest(["manual.md"]);
    await assistant.ask("employee-1", "How do I reset it?");

    await assert.rejects(
      assistant.ask("employee-1", "What does the light do next?"),
      /save failed/,
    );

    assert.deepEqual(gateway.rolledBackTurns, [
      {
        conversationId: "conversation-1",
        itemIds: ["user-item-2", "assistant-item-2"],
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleans up persistent Foundry resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-assistant-"));
  try {
    const gateway = new FakeGateway();
    const store = new StateStore(join(directory, "state.json"));
    const assistant = new SupportAssistant(gateway, store);
    await assistant.ingest(["manual.md"]);
    await assistant.ask("employee-1", "How do I reset it?");

    await assistant.cleanup();

    assert.deepEqual(gateway.cleanedConversationIds, ["conversation-1"]);
    assert.equal((await store.load()).resources, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hosts the support workflow over HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-assistant-"));
  const gateway = new FakeGateway();
  const assistant = new SupportAssistant(
    gateway,
    new StateStore(join(directory, "state.json")),
  );
  const server = createSupportServer(assistant);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const ingest = await postJson(`${baseUrl}/admin/ingest`, {
      manualPaths: ["manual.md"],
    });
    assert.equal(ingest.status, 201);

    const answerResponse = await postJson(
      `${baseUrl}/conversations/employee-1/messages`,
      { question: "How do I reset it?" },
    );
    assert.equal(answerResponse.status, 200);
    const answer = (await answerResponse.json()) as SupportAnswer;

    const feedback = await postJson(
      `${baseUrl}/conversations/employee-1/feedback`,
      {
        responseId: answer.responseId,
        rating: "positive",
        comment: "Clear steps",
      },
    );
    assert.equal(feedback.status, 201);

    gateway.nextSupported = false;
    const unsupported = await postJson(
      `${baseUrl}/conversations/employee-1/messages`,
      { question: "Can it control a satellite?" },
    );
    assert.equal(unsupported.status, 200);

    const unresolved = await fetch(`${baseUrl}/admin/unresolved`);
    const unresolvedBody = (await unresolved.json()) as { items: unknown[] };
    assert.equal(unresolvedBody.items.length, 1);

    const cleanup = await fetch(`${baseUrl}/admin/resources`, {
      method: "DELETE",
    });
    assert.equal(cleanup.status, 200);
  } finally {
    server.close();
    await once(server, "close");
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires Entra identity and administrator authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-assistant-"));
  const assistant = new SupportAssistant(
    new FakeGateway(),
    new StateStore(join(directory, "state.json")),
  );
  const server = createSupportServer(assistant, {
    requireAuthentication: true,
    adminPrincipalIds: new Set(["admin-object-id"]),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  try {
    const unauthenticated = await postJson(
      `${baseUrl}/conversations/chat-1/messages`,
      { question: "How do I reset it?" },
    );
    assert.equal(unauthenticated.status, 401);

    const unauthorized = await fetch(`${baseUrl}/admin/unresolved`, {
      headers: { "x-ms-client-principal-id": "employee-object-id" },
    });
    assert.equal(unauthorized.status, 403);

    const authorized = await fetch(`${baseUrl}/admin/unresolved`, {
      headers: { "x-ms-client-principal-id": "admin-object-id" },
    });
    assert.equal(authorized.status, 200);
  } finally {
    server.close();
    await once(server, "close");
    await rm(directory, { recursive: true, force: true });
  }
});

class FakeGateway implements SupportGateway {
  public nextSupported = true;
  public seenConversationIds: Array<string | undefined> = [];
  public deletedConversationIds: string[] = [];
  public cleanedConversationIds: string[] = [];
  public cleanupCallCount = 0;
  public rolledBackTurns: Array<{
    conversationId: string;
    itemIds: string[];
  }> = [];
  public evaluationRows: EvaluationRow[] = [];
  private answerNumber = 0;

  public async ingest(_manualPaths: string[]): Promise<FoundryResources> {
    return RESOURCES;
  }

  public async ask(
    _resources: FoundryResources,
    conversationId: string | undefined,
    _question: string,
  ): Promise<GatewayAnswer> {
    this.seenConversationIds.push(conversationId);
    this.answerNumber += 1;
    return {
      conversationId: conversationId ?? `conversation-${this.answerNumber}`,
      responseId: `response-${this.answerNumber}`,
      text: this.nextSupported ? "Hold reset for ten seconds." : "UNSUPPORTED",
      citations: this.nextSupported
        ? [{ fileId: "file-1", filename: "manual.md" }]
        : [],
      supported: this.nextSupported,
      retrievedContext: this.nextSupported
        ? ["Hold reset for ten seconds."]
        : [],
      turnItemIds: [
        `user-item-${this.answerNumber}`,
        `assistant-item-${this.answerNumber}`,
      ],
    };
  }

  public async deleteConversation(conversationId: string): Promise<void> {
    this.deletedConversationIds.push(conversationId);
  }

  public async rollbackTurn(
    conversationId: string,
    itemIds: string[],
  ): Promise<void> {
    this.rolledBackTurns.push({ conversationId, itemIds });
  }

  public async runEvaluation(
    rows: EvaluationRow[],
  ): Promise<EvaluationMetric[]> {
    this.evaluationRows = rows;
    return [
      {
        itemId: "item-1",
        itemStatus: "completed",
        name: "groundedness",
        score: 5,
        passed: true,
      },
    ];
  }

  public async cleanup(
    _resources: FoundryResources,
    conversationIds: string[],
  ): Promise<void> {
    this.cleanupCallCount += 1;
    this.cleanedConversationIds = conversationIds;
  }
}

class FailingStateStore extends StateStore {
  private saveNumber = 0;

  public constructor(
    path: string,
    private readonly failOnSaveNumber: number,
  ) {
    super(path);
  }

  public override async save(state: AssistantState): Promise<void> {
    this.saveNumber += 1;
    if (this.saveNumber === this.failOnSaveNumber) {
      throw new Error("save failed");
    }
    await super.save(state);
  }
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
