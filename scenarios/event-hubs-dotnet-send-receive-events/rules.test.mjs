import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  dotnetCheckNames,
  evaluateDotnetCheck,
  loadDotnetWorkspace,
} from "../../languages/dotnet/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/event-hubs-dotnet-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadDotnetWorkspace(goldenWorkspacePath);

test(".NET Event Hubs reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test(".NET Event Hubs reference passes every language check", () => {
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, completeWorkspace), true, check);
  }
});

test("focused omissions fail each core prompt rule", () => {
  const cases = [
    {
      rule: "prompt/event-hubs-packages",
      source: completeWorkspace.source,
      project: completeWorkspace.project.replace(
        "Azure.Messaging.EventHubs.Processor",
        "Contoso.EventProcessor",
      ),
    },
    {
      rule: "prompt/producer-client",
      source: completeWorkspace.source.replace(
        "new EventHubProducerClient(",
        "CreateProducer(",
      ),
    },
    {
      rule: "prompt/event-batch",
      source: completeWorkspace.source.replace(
        "eventNumber < 10",
        "eventNumber < 9",
      ),
    },
    {
      rule: "prompt/send-batch",
      source: completeWorkspace.source.replace(
        "producer.SendAsync(batch)",
        "producer.GetEventHubPropertiesAsync()",
      ),
    },
    {
      rule: "prompt/checkpointed-consumer",
      source: completeWorkspace.source.replace(
        "EventHubConsumerClient.DefaultConsumerGroupName",
        '"uncheckpointed"',
      ),
    },
    {
      rule: "prompt/receive-handlers",
      source: completeWorkspace.source.replace(
        "Console.WriteLine(eventArgs.Data.EventBody.ToString());",
        "Console.WriteLine(\"received\");",
      ),
    },
    {
      rule: "prompt/update-checkpoint",
      source: completeWorkspace.source.replace(
        "await eventArgs.UpdateCheckpointAsync();",
        "",
      ),
    },
    {
      rule: "prompt/client-lifecycle",
      source: completeWorkspace.source.replace(
        "await processor.StopProcessingAsync();",
        "",
      ),
    },
  ];

  for (const { rule, source, project = completeWorkspace.project } of cases) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source, project }),
      false,
      rule,
    );
  }
});

test("supported constructor overloads and target-typed clients are accepted", () => {
  const source = `
string connectionString = GetConnectionStringWithEntityPath();
var store = new BlobContainerClient(blobConnectionString, containerName);
EventHubProducerClient producer = new(connectionString);
EventProcessorClient processor = new(
    store,
    "$Default",
    connectionString);
`;

  assert.equal(
    evaluateRule("prompt/producer-client", { ...completeWorkspace, source }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/checkpointed-consumer", {
      ...completeWorkspace,
      source,
    }),
    true,
  );
});

test("Enumerable.Range batch construction is accepted", () => {
  const source = `
var producer = new EventHubProducerClient(connectionString);
using var batch = await producer.CreateBatchAsync();
foreach (int index in Enumerable.Range(0, 10))
{
    EventData message = new(BinaryData.FromString($"event {index}"));
    message.Properties["index"] = index;
    if (!batch.TryAdd(message)) throw new InvalidOperationException();
}
await producer.SendAsync(batch);
`;

  assert.equal(
    evaluateRule("prompt/event-batch", { ...completeWorkspace, source }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/send-batch", { ...completeWorkspace, source }),
    true,
  );
});

test("TryAdd results and custom properties must belong to the ten-event loop", () => {
  const ignoredTryAdd = `
var producer = new EventHubProducerClient(connectionString);
using var batch = await producer.CreateBatchAsync();
for (int index = 0; index < 10; index++)
{
    var message = new EventData(BinaryData.FromString($"event {index}"));
    message.Properties["index"] = index;
    batch.TryAdd(message);
}
`;
  const unrelatedLoop = `
var producer = new EventHubProducerClient(connectionString);
using var batch = await producer.CreateBatchAsync();
for (int index = 0; index < 10; index++) { Console.WriteLine(index); }
var message = new EventData(BinaryData.FromString("event"));
message.Properties["index"] = 1;
if (!batch.TryAdd(message)) throw new InvalidOperationException();
`;
  const fiveIterations = `
var producer = new EventHubProducerClient(connectionString);
using var batch = await producer.CreateBatchAsync();
for (int index = 0; index < 10; index += 2)
{
    var message = new EventData(BinaryData.FromString($"event {index}"));
    message.Properties["index"] = index;
    if (!batch.TryAdd(message)) throw new InvalidOperationException();
}
`;
  const emptyBody = `
var producer = new EventHubProducerClient(connectionString);
using var batch = await producer.CreateBatchAsync();
for (int index = 0; index < 10; index++)
{
    var message = new EventData();
    message.Properties["index"] = index;
    if (!batch.TryAdd(message)) throw new InvalidOperationException();
}
`;

  for (const source of [
    ignoredTryAdd,
    unrelatedLoop,
    fiveIterations,
    emptyBody,
  ]) {
    assert.equal(
      evaluateRule("prompt/event-batch", { ...completeWorkspace, source }),
      false,
    );
  }
});

test("named handlers may decode bodies before printing", () => {
  const source = `
var processor = new EventProcessorClient(store, "$Default", connectionString);
processor.ProcessEventAsync += ReceiveAsync;
processor.ProcessErrorAsync += ErrorAsync;

static async Task ReceiveAsync(ProcessEventArgs args)
{
    string text = args.Data.EventBody.ToString();
    Console.WriteLine(text);
    await args.UpdateCheckpointAsync();
}

static Task ErrorAsync(ProcessErrorEventArgs args)
{
    string message = args.Exception.Message;
    Console.Error.WriteLine(message);
    return Task.CompletedTask;
}
`;

  assert.equal(
    evaluateRule("prompt/receive-handlers", { ...completeWorkspace, source }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/update-checkpoint", { ...completeWorkspace, source }),
    true,
  );
});

test("inline handlers and EventBody byte conversion are accepted", () => {
  const source = `
var processor = new EventProcessorClient(store, "$Default", connectionString);
processor.ProcessEventAsync += async args =>
{
    Console.WriteLine(args.Data.EventBody.ToArray());
    await args.UpdateCheckpointAsync();
};
processor.ProcessErrorAsync += args =>
{
    Console.Error.WriteLine(args.Exception);
    return Task.CompletedTask;
};
`;

  assert.equal(
    evaluateRule("prompt/receive-handlers", { ...completeWorkspace, source }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/update-checkpoint", { ...completeWorkspace, source }),
    true,
  );
});

test("structured and explicit cleanup forms are accepted", () => {
  const sources = [
    `
await using var producer = new EventHubProducerClient(connectionString);
var processor = new EventProcessorClient(store, "$Default", connectionString);
processor.ProcessEventAsync += async args => await args.UpdateCheckpointAsync();
processor.ProcessErrorAsync += args => Task.CompletedTask;
try
{
    await processor.StartProcessingAsync();
    await Task.Delay(1000);
}
finally
{
    await processor.StopProcessingAsync();
}
`,
    `
var producer = new EventHubProducerClient(connectionString, eventHubName);
var processor = new EventProcessorClient(
    store, "$Default", connectionString, eventHubName);
try
{
    await processor.StartProcessingAsync();
    Console.ReadLine();
}
finally
{
    await processor.StopProcessingAsync();
    await producer.CloseAsync();
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/client-lifecycle", {
        ...completeWorkspace,
        source,
      }),
      true,
    );
  }
});

test("lifecycle cleanup must target the Event Hubs clients", () => {
  const source = `
var producer = new EventHubProducerClient(connectionString);
var processor = new EventProcessorClient(store, "$Default", connectionString);
await processor.StartProcessingAsync();
await Task.Delay(1000);
await other.StopProcessingAsync();
await other.DisposeAsync();
`;

  assert.equal(
    evaluateRule("prompt/client-lifecycle", { ...completeWorkspace, source }),
    false,
  );
});

test("comments and strings cannot satisfy .NET behavior rules", () => {
  const source = `
// var producer = new EventHubProducerClient(connectionString);
string documentation = """
var producer = new EventHubProducerClient(connectionString);
using var batch = await producer.CreateBatchAsync();
for (int index = 0; index < 10; index++)
{
    var message = new EventData(BinaryData.FromString("event"));
    message.Properties["index"] = index;
    if (!batch.TryAdd(message)) throw new InvalidOperationException();
}
""";
`;

  assert.equal(
    evaluateRule("prompt/producer-client", {
      ...completeWorkspace,
      source,
    }),
    false,
  );
  assert.equal(
    evaluateRule("prompt/event-batch", {
      ...completeWorkspace,
      source,
    }),
    false,
  );
});

test("processor cleanup must be guaranteed and producer disposal must be async", () => {
  const sources = [
    `
await using var producer = new EventHubProducerClient(connectionString);
var processor = new EventProcessorClient(store, "$Default", connectionString);
await processor.StartProcessingAsync();
await Task.Delay(1000);
await processor.StopProcessingAsync();
`,
    `
using var producer = new EventHubProducerClient(connectionString);
var processor = new EventProcessorClient(store, "$Default", connectionString);
try
{
    await processor.StartProcessingAsync();
    await Task.Delay(1000);
}
finally
{
    await processor.StopProcessingAsync();
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/client-lifecycle", {
        ...completeWorkspace,
        source,
      }),
      false,
    );
  }
});

test("created batches must be disposed by lifecycle cleanup", () => {
  const source = completeWorkspace.source.replace(
    "using EventDataBatch batch",
    "EventDataBatch batch",
  );

  assert.equal(
    evaluateRule("prompt/client-lifecycle", { ...completeWorkspace, source }),
    false,
  );
});
