import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/event-hubs-python-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadPythonWorkspace(goldenWorkspacePath);
const baseline33374429826 = loadPythonWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33374429826", import.meta.url),
  ),
);
const baseline33403910898 = loadPythonWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33403910898", import.meta.url),
  ),
);
const applicablePythonChecks = [
  "language/correct-imports",
  "language/client-lifecycle",
  "language/async-client",
];

function withPython(python) {
  return { ...completeWorkspace, python };
}

test("Event Hubs Python reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("Event Hubs Python reference passes every language check", () => {
  for (const check of applicablePythonChecks) {
    assert.equal(evaluatePythonCheck(check, completeWorkspace), true, check);
  }
});

test("baseline run 33374429826 preserves its genuine invalid-constructor failure", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, baseline33374429826),
      rule !== "prompt/event-batch",
      rule,
    );
  }
  for (const check of applicablePythonChecks) {
    assert.equal(
      evaluatePythonCheck(check, baseline33374429826),
      true,
      check,
    );
  }
  assert.equal(
    evaluatePythonCheck(
      "language/exception-handling",
      baseline33374429826,
    ),
    false,
  );
});

test("baseline run 33403910898 exact output passes every configured grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33403910898), true, rule);
  }
  for (const check of applicablePythonChecks) {
    assert.equal(evaluatePythonCheck(check, baseline33403910898), true, check);
  }
});

test("each missing core behavior fails its focused prompt rule", async (t) => {
  const mutations = [
    {
      name: "required checkpoint package",
      rule: "prompt/event-hubs-packages",
      workspace: {
        ...completeWorkspace,
        dependencies: completeWorkspace.dependencies.replace(
          "azure-eventhub-checkpointstoreblob-aio==1.2.0",
          "",
        ),
      },
    },
    {
      name: "producer construction",
      rule: "prompt/producer-client",
      workspace: withPython(
        completeWorkspace.python.replaceAll(
          "EventHubProducerClient",
          "MissingProducerClient",
        ),
      ),
    },
    {
      name: "ten-event batch",
      rule: "prompt/event-batch",
      workspace: withPython(
        completeWorkspace.python.replace("range(10)", "range(9)"),
      ),
    },
    {
      name: "batch send",
      rule: "prompt/send-batch",
      workspace: withPython(
        completeWorkspace.python.replace("send_batch", "skip_batch"),
      ),
    },
    {
      name: "consumer checkpoint store",
      rule: "prompt/checkpointed-consumer",
      workspace: withPython(
        completeWorkspace.python.replace(
          "checkpoint_store=checkpoint_store,",
          "",
        ),
      ),
    },
    {
      name: "event body output",
      rule: "prompt/receive-handlers",
      workspace: withPython(
        completeWorkspace.python.replace(
          "print(event.body_as_str(encoding=\"UTF-8\"))",
          "print(\"event received\")",
        ),
      ),
    },
    {
      name: "checkpoint update",
      rule: "prompt/update-checkpoint",
      workspace: withPython(
        completeWorkspace.python.replace(
          "await partition_context.update_checkpoint(event)",
          "return",
        ),
      ),
    },
    {
      name: "producer cleanup",
      rule: "prompt/client-lifecycle",
      workspace: withPython(`
producer = EventHubProducerClient.from_connection_string(connection_string)
consumer = EventHubConsumerClient.from_connection_string(
    connection_string,
    consumer_group=consumer_group,
)
async with consumer:
    pass
`),
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, () => {
      assert.equal(evaluateRule(mutation.rule, mutation.workspace), false);
    });
  }
});

test("direct constructors and connection strings with entity paths are accepted", () => {
  const directConstructors = withPython(`
from azure.eventhub.aio import EventHubConsumerClient, EventHubProducerClient
from azure.eventhub.extensions.checkpointstoreblobaio import BlobCheckpointStore

producer = EventHubProducerClient(
    fully_qualified_namespace=namespace,
    eventhub_name=event_hub_name,
    credential=credential,
)
checkpoint = BlobCheckpointStore(
    blob_account_url=storage_url,
    container_name=container_name,
    credential=credential,
)
consumer = EventHubConsumerClient(
    fully_qualified_namespace=namespace,
    eventhub_name=event_hub_name,
    consumer_group=consumer_group,
    credential=credential,
    checkpoint_store=checkpoint,
)
`);
  assert.equal(evaluateRule("prompt/producer-client", directConstructors), true);
  assert.equal(
    evaluateRule("prompt/checkpointed-consumer", directConstructors),
    true,
  );

  const entityPathConnections = withPython(`
producer = EventHubProducerClient.from_connection_string(event_hubs_connection)
checkpoint = BlobCheckpointStore.from_connection_string(
    storage_connection,
    container_name,
)
consumer = EventHubConsumerClient.from_connection_string(
    event_hubs_connection,
    consumer_group=consumer_group,
    checkpoint_store=checkpoint,
)
`);
  assert.equal(
    evaluateRule("prompt/producer-client", entityPathConnections),
    true,
  );
  assert.equal(
    evaluateRule("prompt/checkpointed-consumer", entityPathConnections),
    true,
  );
});

test("receive_batch, positional handlers, and an inline error handler are accepted", () => {
  const workspace = withPython(`
consumer = EventHubConsumerClient.from_connection_string(
    connection_string,
    consumer_group=consumer_group,
    checkpoint_store=BlobCheckpointStore.from_connection_string(
        storage_connection,
        container_name,
    ),
)

async def handle_batch(partition_context, events):
    for event in events:
        print(event.body)
    await partition_context.update_checkpoint(events[-1])

await consumer.receive_batch(
    handle_batch,
    on_error=lambda partition_context, error: print(error),
)
`);

  assert.equal(evaluateRule("prompt/checkpointed-consumer", workspace), true);
  assert.equal(evaluateRule("prompt/receive-handlers", workspace), true);
  assert.equal(evaluateRule("prompt/update-checkpoint", workspace), true);
});

test("received bodies may be assigned before printing", () => {
  const workspace = withPython(`
consumer = EventHubConsumerClient.from_connection_string(
    connection_string,
    consumer_group=consumer_group,
    checkpoint_store=checkpoint_store,
)

async def handle(partition_context, event):
    body = event.body_as_str()
    print(body)
    await partition_context.update_checkpoint(event=event)

async def errors(partition_context, error):
    print(error)

await consumer.receive(on_event=handle, on_error=errors)
`);

  assert.equal(evaluateRule("prompt/receive-handlers", workspace), true);
  assert.equal(evaluateRule("prompt/update-checkpoint", workspace), true);
});

test("unrelated bodies and checkpoint events do not satisfy handlers", () => {
  const workspace = withPython(`
consumer = EventHubConsumerClient.from_connection_string(
    connection_string,
    consumer_group=consumer_group,
    checkpoint_store=checkpoint_store,
)

async def handle(partition_context, event):
    print(unrelated.body)
    await partition_context.update_checkpoint(other_event)

async def errors(partition_context, error):
    print(error)

await consumer.receive(on_event=handle, on_error=errors)
`);

  assert.equal(evaluateRule("prompt/receive-handlers", workspace), false);
  assert.equal(evaluateRule("prompt/update-checkpoint", workspace), false);
});

test("alternate event properties and ten-value ranges are accepted", () => {
  const workspace = withPython(`
producer = EventHubProducerClient.from_connection_string(connection_string)
batch = await producer.create_batch()
for sequence in range(1, 11):
    outgoing = EventData(sequence)
    outgoing.properties.update({"sequence": sequence})
    batch.add(outgoing)
await producer.send_batch(batch)
`);

  assert.equal(evaluateRule("prompt/event-batch", workspace), true);
  assert.equal(evaluateRule("prompt/send-batch", workspace), true);
});

test("constant arithmetic may define an exact ten-event loop", () => {
  const workspace = withPython(`
producer = EventHubProducerClient.from_connection_string(connection_string)
batch = await producer.create_batch()
EVENT_COUNT = 10
for sequence in range(1, EVENT_COUNT + 1):
    outgoing = EventData(f"event-{sequence}")
    outgoing.properties = {"sequence": sequence}
    batch.add(outgoing)
`);

  assert.equal(evaluateRule("prompt/event-batch", workspace), true);
});

test("invalid EventData constructor properties remain rejected", () => {
  const workspace = withPython(`
producer = EventHubProducerClient.from_connection_string(connection_string)
batch = await producer.create_batch()
EVENT_COUNT = 10
for sequence in range(1, EVENT_COUNT + 1):
    batch.add(
        EventData(
            f"event-{sequence}",
            application_properties={"sequence": sequence},
        )
    )
`);

  assert.equal(evaluateRule("prompt/event-batch", workspace), false);
});

test("batch checks preserve bounds, provenance, order, and reachability", async (t) => {
  const cases = [
    {
      name: "wrong arithmetic bound",
      source: `
producer = EventHubProducerClient.from_connection_string(connection_string)
batch = await producer.create_batch()
EVENT_COUNT = 10
for sequence in range(EVENT_COUNT + 1):
    outgoing = EventData(sequence)
    outgoing.properties = {"sequence": sequence}
    batch.add(outgoing)
`,
    },
    {
      name: "property belongs to another event",
      source: `
producer = EventHubProducerClient.from_connection_string(connection_string)
batch = await producer.create_batch()
for sequence in range(10):
    outgoing = EventData(sequence)
    decoy = EventData(sequence)
    decoy.properties = {"sequence": sequence}
    batch.add(outgoing)
`,
    },
    {
      name: "property is assigned after enqueue",
      source: `
producer = EventHubProducerClient.from_connection_string(connection_string)
batch = await producer.create_batch()
for sequence in range(10):
    outgoing = EventData(sequence)
    batch.add(outgoing)
    outgoing.properties = {"sequence": sequence}
`,
    },
    {
      name: "batch implementation is unreachable",
      source: `
def decoy():
    producer = EventHubProducerClient.from_connection_string(connection_string)
    batch = await producer.create_batch()
    for sequence in range(10):
        outgoing = EventData(sequence)
        outgoing.properties = {"sequence": sequence}
        batch.add(outgoing)

if False:
    decoy()
`,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      assert.equal(
        evaluateRule("prompt/event-batch", withPython(entry.source)),
        false,
      );
    });
  }
});

test("f-string receive diagnostics retain error-parameter provenance", () => {
  const valid = withPython(`
consumer = EventHubConsumerClient.from_connection_string(
    connection_string,
    consumer_group=consumer_group,
    checkpoint_store=checkpoint_store,
)

async def handle(partition_context, event):
    print(f"body={event.body_as_str()}")

async def errors(partition_context, caught_error):
    print(f"receive failed: {caught_error}")

await consumer.receive(on_event=handle, on_error=errors)
`);
  assert.equal(evaluateRule("prompt/receive-handlers", valid), true);

  const unrelatedError = withPython(
    valid.python.replace(
      'print(f"receive failed: {caught_error}")',
      'print(f"receive failed: {unrelated_error}")',
    ),
  );
  assert.equal(
    evaluateRule("prompt/receive-handlers", unrelatedError),
    false,
  );
});

test("unreachable receive handlers do not score", () => {
  const workspace = withPython(`
async def handle(partition_context, event):
    print(event.body)

async def errors(partition_context, error):
    print(f"receive failed: {error}")

def decoy():
    consumer = EventHubConsumerClient.from_connection_string(
        connection_string,
        consumer_group=consumer_group,
        checkpoint_store=checkpoint_store,
    )
    return consumer.receive(on_event=handle, on_error=errors)

if False:
    decoy()
`);

  assert.equal(evaluateRule("prompt/receive-handlers", workspace), false);
});

test("nested receive callbacks must be reachable and passed in their lexical scope", async (t) => {
  const cases = [
    {
      name: "unreachable nested receive",
      source: `
async def run():
    async def on_event(partition_context, event):
        print(event.body)
    async def on_error(partition_context, error):
        print(error)
    consumer = EventHubConsumerClient.from_connection_string(
        connection_string,
        consumer_group=consumer_group,
        checkpoint_store=checkpoint_store,
    )
    await consumer.receive(on_event=on_event, on_error=on_error)
`,
    },
    {
      name: "lexical callback shadowing",
      source: `
async def on_event(partition_context, event):
    print(event.body)
async def on_error(partition_context, error):
    print(error)
async def run():
    async def on_event(partition_context, event):
        print("not the body")
    consumer = EventHubConsumerClient.from_connection_string(
        connection_string,
        consumer_group=consumer_group,
        checkpoint_store=checkpoint_store,
    )
    await consumer.receive(on_event=on_event, on_error=on_error)
await run()
`,
    },
    {
      name: "unrelated nested error value",
      source: `
async def run():
    async def on_event(partition_context, event):
        print(event.body)
    async def on_error(partition_context, error):
        print(unrelated_error)
    consumer = EventHubConsumerClient.from_connection_string(
        connection_string,
        consumer_group=consumer_group,
        checkpoint_store=checkpoint_store,
    )
    await consumer.receive(on_event=on_event, on_error=on_error)
await run()
`,
    },
    {
      name: "handlers not passed to receive",
      source: `
async def run():
    async def on_event(partition_context, event):
        print(event.body)
    async def on_error(partition_context, error):
        print(error)
    consumer = EventHubConsumerClient.from_connection_string(
        connection_string,
        consumer_group=consumer_group,
        checkpoint_store=checkpoint_store,
    )
    await consumer.receive()
await run()
`,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      assert.equal(
        evaluateRule("prompt/receive-handlers", withPython(entry.source)),
        false,
      );
    });
  }
});

test("events in the ten-event batch must have a body", () => {
  const workspace = withPython(`
producer = EventHubProducerClient.from_connection_string(connection_string)
batch = await producer.create_batch()
for sequence in range(10):
    outgoing = EventData()
    outgoing.properties = {"sequence": sequence}
    batch.add(outgoing)
`);

  assert.equal(evaluateRule("prompt/event-batch", workspace), false);
});

test("explicit close and exit-stack lifecycle forms are accepted", () => {
  const explicitClose = withPython(`
producer = EventHubProducerClient.from_connection_string(connection_string)
consumer = EventHubConsumerClient.from_connection_string(
    connection_string,
    consumer_group=consumer_group,
)
await producer.close()
await consumer.close()
`);
  assert.equal(evaluateRule("prompt/client-lifecycle", explicitClose), true);

  const exitStack = withPython(`
producer = EventHubProducerClient.from_connection_string(connection_string)
consumer = EventHubConsumerClient.from_connection_string(
    connection_string,
    consumer_group=consumer_group,
)
await stack.enter_async_context(producer)
await stack.enter_async_context(consumer)
`);
  assert.equal(evaluateRule("prompt/client-lifecycle", exitStack), true);
});

test("comments and strings cannot satisfy source behavior rules", () => {
  const workspace = withPython(`
# producer = EventHubProducerClient.from_connection_string(connection_string)
description = "consumer.receive(on_event=handler, on_error=handler)"
`);

  assert.equal(evaluateRule("prompt/producer-client", workspace), false);
  assert.equal(evaluateRule("prompt/receive-handlers", workspace), false);
});
