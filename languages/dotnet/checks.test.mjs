import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { evaluateDotnetCheck, loadDotnetWorkspace } from "./checks.mjs";

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
