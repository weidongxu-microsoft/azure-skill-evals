import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  dotnetCodeOnly,
  evaluateDotnetCheck,
  loadDotnetWorkspace,
} from "./checks.mjs";

const completeWorkspace = {
  sourceFiles: ["Program.cs"],
  projectFiles: ["Example.csproj"],
  project: `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.Azure.Cosmos" Version="3.0.0" />
  </ItemGroup>
</Project>
`,
  source: `
using Microsoft.Azure.Cosmos;

static async Task Main()
{
    using CosmosClient client = new("connection-string");
    await client.ReadAccountAsync();
}
`,
};

test("shared .NET checks accept a current async SDK application", () => {
  for (const check of [
    "language/project-manifest",
    "language/current-azure-packages",
    "language/async-await",
    "language/client-lifecycle",
  ]) {
    assert.equal(evaluateDotnetCheck(check, completeWorkspace), true, check);
  }
});

test("legacy packages and undisposed clients fail", () => {
  const workspace = {
    ...completeWorkspace,
    project: completeWorkspace.project.replace(
      "Microsoft.Azure.Cosmos",
      "Microsoft.Azure.DocumentDB",
    ),
    source: completeWorkspace.source.replace("using CosmosClient", "CosmosClient"),
  };

  assert.equal(
    evaluateDotnetCheck("language/current-azure-packages", workspace),
    false,
  );
  assert.equal(
    evaluateDotnetCheck("language/client-lifecycle", workspace),
    false,
  );
});

test("loader accepts a conventional project and ignores build output", () => {
  const root = fileURLToPath(
    new URL(
      "../../scenarios/cosmos-db-dotnet-crud/golden",
      import.meta.url,
    ),
  );
  const workspace = loadDotnetWorkspace(root);

  assert.equal(workspace.sourceFiles.length, 1);
  assert.equal(workspace.projectFiles.length, 1);
});

test("Event Hubs producer disposal and processor stopping are type-aware", () => {
  const validSources = [
    `
await using var producer = new EventHubProducerClient(connectionString);
var processor = new EventProcessorClient(store, group, connectionString);
await processor.StopProcessingAsync();
`,
    `
EventHubProducerClient producer = new(connectionString, eventHubName);
EventProcessorClient processor =
    new(store, group, connectionString, eventHubName);
try
{
    await processor.StartProcessingAsync();
}
finally
{
    await processor.StopProcessingAsync();
    await producer.CloseAsync();
}
`,
  ];

  for (const source of validSources) {
    assert.equal(
      evaluateDotnetCheck("language/client-lifecycle", {
        ...completeWorkspace,
        source,
      }),
      true,
    );
  }
});

test("Event Hubs lifecycle rejects unrelated or incomplete cleanup", () => {
  const invalidSources = [
    `
var producer = new EventHubProducerClient(connectionString);
other.DisposeAsync();
`,
    `
await using var producer = new EventHubProducerClient(connectionString);
var processor = new EventProcessorClient(store, group, connectionString);
other.StopProcessingAsync();
`,
    `
var first = new EventHubProducerClient(connectionString);
await using var second = new EventHubProducerClient(connectionString);
first.SendAsync(batch);
`,
    `
using var producer = new EventHubProducerClient(connectionString);
`,
    `
var producer = new EventHubProducerClient(connectionString);
producer.Dispose();
`,
  ];

  for (const source of invalidSources) {
    assert.equal(
      evaluateDotnetCheck("language/client-lifecycle", {
        ...completeWorkspace,
        source,
      }),
      false,
    );
  }
});

test("comments and strings cannot satisfy shared source checks", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
// await producer.DisposeAsync();
var producer = new EventHubProducerClient(connectionString);
string example = """
await producer.DisposeAsync();
""";
`,
  };

  assert.equal(evaluateDotnetCheck("language/async-await", workspace), false);
  assert.equal(
    evaluateDotnetCheck("language/client-lifecycle", workspace),
    false,
  );
});

test("code filtering preserves only expressions from interpolated strings", () => {
  const filtered = dotnetCodeOnly(`
Console.WriteLine($"Account kind: {response.Value.AccountKind}");
Console.WriteLine($@"SKU: {account.SkuName}");
string fake = "await fakeClient.GetAccountInfoAsync()";
`);

  assert.match(filtered, /\bresponse\.Value\.AccountKind\b/);
  assert.match(filtered, /\baccount\.SkuName\b/);
  assert.doesNotMatch(filtered, /\bfakeClient\b/);
  assert.doesNotMatch(filtered, /Account kind|SKU/);
});

test("Service Bus factory resources require async disposal and processor stop", () => {
  const source = `
await using var client = new ServiceBusClient(
    fullyQualifiedNamespace, credential);
await using var sender = client.CreateSender(queueName);
await using ServiceBusReceiver receiver = client.CreateReceiver(queueName);
await using var processor = client.CreateProcessor(queueName);
try
{
    await processor.StartProcessingAsync();
    await Task.Delay(TimeSpan.FromSeconds(10));
}
finally
{
    await processor.StopProcessingAsync();
}
`;

  assert.equal(
    evaluateDotnetCheck("language/client-lifecycle", {
      ...completeWorkspace,
      source,
    }),
    true,
  );
});

test("Service Bus lifecycle is type-aware and rejects incomplete cleanup", () => {
  const base = `
await using var client = new ServiceBusClient(namespaceName, credential);
await using var sender = client.CreateSender(queueName);
await using var receiver = client.CreateReceiver(queueName);
await using var processor = client.CreateProcessor(queueName);
try
{
    await processor.StartProcessingAsync();
    await Task.Delay(1000);
}
finally
{
    await processor.StopProcessingAsync();
}
`;
  const invalid = [
    base.replace("await using var sender", "var sender"),
    base.replace("await using var receiver", "using var receiver"),
    base.replace("await using var processor", "var processor"),
    base.replace("await processor.StopProcessingAsync();", ""),
    base.replace(
      "await processor.StopProcessingAsync();",
      "await other.StopProcessingAsync();",
    ),
    base.replace("await Task.Delay(1000);", ""),
    base.replace(
      "await processor.StopProcessingAsync();",
      "processor.StopProcessingAsync();",
    ),
    base.replace("finally", "if (cleanup)"),
    base.replace("await using var client", "using var client"),
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateDotnetCheck("language/client-lifecycle", {
        ...completeWorkspace,
        source,
      }),
      false,
      source,
    );
  }
});

test("Service Bus explicit awaited disposal is accepted", () => {
  const source = `
var client = new ServiceBusClient(namespaceName, credential);
var sender = client.CreateSender(queueName);
var receiver = client.CreateReceiver(queueName);
await sender.DisposeAsync();
await receiver.DisposeAsync();
await client.DisposeAsync();
`;
  assert.equal(
    evaluateDotnetCheck("language/client-lifecycle", {
      ...completeWorkspace,
      source,
    }),
    true,
  );
});

test("Service Bus disposal must follow the exact resource's last use", () => {
  const earlySender = `
var client = new ServiceBusClient(namespaceName, credential);
var sender = client.CreateSender(queueName);
await sender.DisposeAsync();
await sender.SendMessageAsync(message);
await client.DisposeAsync();
`;
  const earlyClient = `
var client = new ServiceBusClient(namespaceName, credential);
var sender = client.CreateSender(queueName);
await client.DisposeAsync();
await sender.SendMessageAsync(message);
await sender.DisposeAsync();
`;
  const earlyThenRepeated = `
await using var client = new ServiceBusClient(namespaceName, credential);
await using var sender = client.CreateSender(queueName);
await sender.DisposeAsync();
await sender.SendMessageAsync(message);
`;
  for (const source of [earlySender, earlyClient, earlyThenRepeated]) {
    assert.equal(
      evaluateDotnetCheck("language/client-lifecycle", {
        ...completeWorkspace,
        source,
      }),
      false,
    );
  }
});
