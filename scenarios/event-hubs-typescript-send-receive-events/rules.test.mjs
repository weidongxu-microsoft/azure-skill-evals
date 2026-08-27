import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateTypeScriptCheck,
  loadTypeScriptWorkspace,
  typeScriptCheckNames,
} from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/event-hubs-typescript-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadTypeScriptWorkspace(goldenWorkspacePath);

function withSource(source) {
  return { ...completeWorkspace, source };
}

test("TypeScript Event Hubs reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("TypeScript Event Hubs reference passes every language check", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, completeWorkspace),
      true,
      check,
    );
  }
});

test("all three Event Hubs packages are required", () => {
  const packageJson = completeWorkspace.packageJson.replace(
    '"@azure/storage-blob": "12.33.0"',
    '"unrelated-package": "1.0.0"',
  );

  assert.equal(
    evaluateRule("prompt/event-hubs-packages", {
      ...completeWorkspace,
      packageJson,
    }),
    false,
  );
});

test("an imported producer without construction fails", () => {
  const source = completeWorkspace.source.replace(
    "new EventHubProducerClient(connectionString, eventHubName)",
    "{ createBatch: async () => undefined }",
  );

  assert.equal(evaluateRule("prompt/producer-client", withSource(source)), false);
});

test("a nine-event batch fails", () => {
  const source = completeWorkspace.source.replace(
    "index < 10",
    "index < 9",
  );

  assert.equal(evaluateRule("prompt/event-batch", withSource(source)), false);
});

test("events without custom properties fail", () => {
  const source = completeWorkspace.source.replace(
    'properties: { sequence: index, source: "typescript-reference" },',
    "",
  );

  assert.equal(evaluateRule("prompt/event-batch", withSource(source)), false);
});

test("an ignored tryAdd failure fails", () => {
  const source = `
const producer = new EventHubProducerClient(connectionString, eventHubName);
const batch = await producer.createBatch();
for (let index = 0; index < 10; index += 1) {
  const event = { body: index, properties: { sequence: index } };
  batch.tryAdd(event);
}
`;

  assert.equal(evaluateRule("prompt/event-batch", withSource(source)), false);
});

test("batch behavior must occur inside an exact ten-event loop", () => {
  const sources = [
    `
const producer = new EventHubProducerClient(connectionString, eventHubName);
const batch = await producer.createBatch();
for (let index = 0; index < 10; index += 1) {
  console.log(index);
}
const event = { body: "one", properties: { sequence: 1 } };
if (!batch.tryAdd(event)) throw new Error("full");
`,
    `
const producer = new EventHubProducerClient(connectionString, eventHubName);
const batch = await producer.createBatch();
for (let index = 0; index < 10; index += 2) {
  const event = { body: index, properties: { sequence: index } };
  if (!batch.tryAdd(event)) throw new Error("full");
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/event-batch", withSource(source)),
      false,
    );
  }
});

test("sending a different value does not satisfy batch sending", () => {
  const source = completeWorkspace.source.replace(
    "producer.sendBatch(batch)",
    "producer.sendBatch([])",
  );

  assert.equal(evaluateRule("prompt/send-batch", withSource(source)), false);
});

test("a checkpoint store not supplied to the consumer fails", () => {
  const source = completeWorkspace.source.replace(
    "    checkpointStore,",
    "",
  );

  assert.equal(
    evaluateRule("prompt/checkpointed-consumer", withSource(source)),
    false,
  );
});

test("receiving requires both handlers and body output", () => {
  const noErrorHandler = completeWorkspace.source.replace(
    "processError:",
    "ignoredError:",
  );
  const noBodyOutput = completeWorkspace.source.replace(
    "console.log(event.body);",
    "",
  );

  assert.equal(
    evaluateRule("prompt/receive-handlers", withSource(noErrorHandler)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/receive-handlers", withSource(noBodyOutput)),
    false,
  );

  const emptyErrorHandler = completeWorkspace.source.replace(
    /processError: async \(error, context\) => \{[\s\S]*?\n      \},/,
    "processError: async () => {},",
  );
  assert.equal(
    evaluateRule("prompt/receive-handlers", withSource(emptyErrorHandler)),
    false,
  );
});

test("checkpoint updates must occur in the event handler", () => {
  const source = completeWorkspace.source.replace(
    "await context.updateCheckpoint(events[events.length - 1]);",
    "",
  );

  assert.equal(
    evaluateRule("prompt/update-checkpoint", withSource(source)),
    false,
  );
});

test("subscription, consumer, and producer must all close", () => {
  for (const closeCall of [
    "await subscription?.close();",
    "await consumer.close();",
    "await producer.close();",
  ]) {
    const source = completeWorkspace.source.replace(closeCall, "");
    assert.equal(
      evaluateRule("prompt/client-lifecycle", withSource(source)),
      false,
      closeCall.trim(),
    );
  }
});

test("a subscription that closes immediately does not receive until shutdown", () => {
  const source = completeWorkspace.source.replace(
    "    await waitForShutdown();",
    "",
  );

  assert.equal(
    evaluateRule("prompt/client-lifecycle", withSource(source)),
    false,
  );
});

test("embedded entity-path overloads are accepted", () => {
  const source = `
const producer = new EventHubProducerClient(connectionString);
const container = blobServiceClient.getContainerClient("checkpoints");
const checkpointStore = new BlobCheckpointStore(container);
const consumer = new EventHubConsumerClient(
  "$Default",
  connectionString,
  checkpointStore,
);
`;

  assert.equal(
    evaluateRule("prompt/producer-client", withSource(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/checkpointed-consumer", withSource(source)),
    true,
  );
});

test("inline batch events and Array.from iteration are accepted", () => {
  const source = `
const producer = new EventHubProducerClient(connectionString, eventHubName);
const batch = await producer.createBatch();
for (const index of Array.from({ length: 10 }, (_, value) => value)) {
  if (!batch.tryAdd({
    body: \`event-\${index}\`,
    properties: { sequence: index },
  })) throw new Error("full");
}
await producer.sendBatch(batch);
`;

  assert.equal(evaluateRule("prompt/event-batch", withSource(source)), true);
  assert.equal(evaluateRule("prompt/send-batch", withSource(source)), true);
});

test("named handlers and the partition subscription overload are accepted", () => {
  const source = `
const checkpointStore = new BlobCheckpointStore(containerClient);
const consumer = new EventHubConsumerClient(
  "$Default",
  connectionString,
  checkpointStore,
);

async function onEvents(events, context) {
  for (const event of events) {
    console.info(event.body);
    await context.updateCheckpoint(event);
  }
}

async function onError(error) {
  console.error(error);
}

const handlers = { processEvents: onEvents, processError: onError };
const subscription = consumer.subscribe("0", handlers);
`;

  assert.equal(
    evaluateRule("prompt/receive-handlers", withSource(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/update-checkpoint", withSource(source)),
    true,
  );
});

test("inline handlers are accepted but disconnected handler text is not", () => {
  const inline = `
const checkpointStore = new BlobCheckpointStore(containerClient);
const consumer = new EventHubConsumerClient(
  "$Default",
  connectionString,
  checkpointStore,
);
consumer.subscribe({
  processEvents: async (events, context) => {
    for (const event of events) console.log(event.body);
    await context.updateCheckpoint(events.at(-1));
  },
  processError: async (error) => console.error(error),
});
`;
  const disconnected = inline.replace(
    "consumer.subscribe({",
    "const unrelatedHandlers = {",
  );

  assert.equal(
    evaluateRule("prompt/receive-handlers", withSource(inline)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/update-checkpoint", withSource(inline)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/receive-handlers", withSource(disconnected)),
    false,
  );
});

test("comments and strings cannot satisfy TypeScript behavior rules", () => {
  const source = `
// const producer = new EventHubProducerClient(connectionString);
const documentation = \`
  const producer = new EventHubProducerClient(connectionString);
  const batch = await producer.createBatch();
  for (let index = 0; index < 10; index += 1) {
    const event = { body: index, properties: { sequence: index } };
    if (!batch.tryAdd(event)) throw new Error("full");
  }
\`;
`;

  assert.equal(
    evaluateRule("prompt/producer-client", withSource(source)),
    false,
  );
  assert.equal(evaluateRule("prompt/event-batch", withSource(source)), false);
});

test("explicit cleanup in Promise.all is accepted", () => {
  const source = `
const producer = new EventHubProducerClient(connectionString, eventHubName);
const checkpointStore = new BlobCheckpointStore(containerClient);
const consumer = new EventHubConsumerClient(
  "$Default",
  connectionString,
  checkpointStore,
);
const subscription = consumer.subscribe(handlers);
await waitForShutdown();
await Promise.all([
  subscription.close(),
  consumer.close(),
  producer.close(),
]);
`;

  assert.equal(
    evaluateRule("prompt/client-lifecycle", withSource(source)),
    true,
  );
});
