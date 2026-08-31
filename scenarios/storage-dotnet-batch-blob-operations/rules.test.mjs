import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  dotnetCheckNames,
  evaluateDotnetCheck,
  loadDotnetWorkspace,
} from "../../languages/dotnet/checks.mjs";
import {
  evaluateRule,
  loadWorkspace,
  ruleNames,
} from "./tools/storage-dotnet-batch-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const scenarioRoot = fileURLToPath(new URL(".", import.meta.url));
const completeWorkspace = loadWorkspace(goldenRoot);
const sharedWorkspace = loadDotnetWorkspace(goldenRoot);

function workspace(source, project = completeWorkspace.project) {
  return {
    ...completeWorkspace,
    projects: undefined,
    project,
    source,
    sourceFiles: ["Program.cs"],
  };
}

function manifest({
  target = "net8.0",
  identity = "1.21.0",
  blobs = "12.29.2",
  batch = "12.26.0",
  extra = "",
} = {}) {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${target}</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="${identity}" />
    <PackageReference Include="Azure.Storage.Blobs" Version="${blobs}" />
    <PackageReference Include="Azure.Storage.Blobs.Batch" Version="${batch}" />
    ${extra}
  </ItemGroup>
</Project>`;
}

function loadedWorkspace(files) {
  const root = mkdtempSync(join(scenarioRoot, ".rules-test-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, ...name.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return loadWorkspace(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test("golden passes seven prompt rules and every shared .NET check", () => {
  assert.equal(ruleNames().length, 7);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, sharedWorkspace), true, check);
  }
});

test("manifest requires one executable net8 project with exact stable pins", () => {
  const propertyManaged = `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
      <OutputType>Exe</OutputType>
      <BaseTarget>net8.0</BaseTarget>
      <TargetFramework>$(BaseTarget)</TargetFramework>
      <IdentityVersion>1.21.0</IdentityVersion>
      <BlobsVersion>12.29.2</BlobsVersion>
      <BatchVersion>12.26.0</BatchVersion>
    </PropertyGroup>
    <ItemGroup>
      <PackageReference Include="azure.identity"
                        Version="[$(IdentityVersion)]" />
      <PackageReference Include="AZURE.STORAGE.BLOBS"
                        Version="$(BlobsVersion)" />
      <PackageReference Include="Azure.Storage.Blobs.Batch">
        <Version>$(BatchVersion)</Version>
      </PackageReference>
    </ItemGroup>
  </Project>`;
  assert.equal(
    evaluateRule(
      "prompt/storage-batch-manifest",
      workspace(completeWorkspace.source, propertyManaged),
    ),
    true,
  );

  const invalid = [
    manifest({ target: "net7.0" }),
    manifest({ identity: "1.22.0" }),
    manifest({ blobs: "12.*" }),
    manifest({ batch: "[12.26.0,)" }),
    manifest().replace(
      '<PackageReference Include="Azure.Storage.Blobs.Batch" Version="12.26.0" />',
      '<!-- <PackageReference Include="Azure.Storage.Blobs.Batch" Version="12.26.0" /> -->',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.Storage.Blobs" Version="12.29.2" />',
      '<PackageReference Include="Azure.Storage.Blobs" Version="12.29.2" Condition="false" />',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<PackageReference Include="Azure.Identity" Version="1.21.0" ExcludeAssets="compile" />',
    ),
    manifest({
      extra:
        '<PackageReference Include="Azure.Storage.Blobs.Batch" Version="99.0.0" />',
    }),
    manifest({
      extra: '<Compile Remove="Program.cs" />',
    }),
  ];
  for (const project of invalid) {
    assert.equal(
      evaluateRule(
        "prompt/storage-batch-manifest",
        workspace(completeWorkspace.source, project),
      ),
      false,
      project,
    );
  }
});

test("focused golden omissions fail their own criteria", () => {
  const cases = [
    [
      "prompt/storage-batch-manifest",
      completeWorkspace.source,
      completeWorkspace.project.replace("12.26.0", "12.25.0"),
    ],
    [
      "prompt/authenticated-batch-client",
      completeWorkspace.source.replace(
        '"https://storage.azure.com/.default"',
        '"https://management.azure.com/.default"',
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/delete-batches",
      completeWorkspace.source.replace("Enumerable.Range(0, 500)", "Enumerable.Range(0, 499)"),
      completeWorkspace.project,
    ],
    [
      "prompt/tier-batch",
      completeWorkspace.source.replace("AccessTier.Cool", "AccessTier.Hot"),
      completeWorkspace.project,
    ],
    [
      "prompt/custom-batch-responses",
      completeWorkspace.source.replace(
        "customDelete.Status",
        "customDelete.ReasonPhrase",
      ).replace(
        "customTier.Status",
        "customTier.ReasonPhrase",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/partial-failure-handling",
      completeWorkspace.source.replaceAll(
        "aggregate.InnerExceptions",
        "Array.Empty<Exception>()",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/batch-limits",
      completeWorkspace.source.replace(
        "4 * 1024 * 1024",
        "8 * 1024 * 1024",
      ),
      completeWorkspace.project,
    ],
  ];
  for (const [rule, source, project] of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test("qualified aliases, target-typed constructors, and helper catches pass", () => {
  const source = completeWorkspace.source
    .replace(
      "using Azure;",
      "using Core = Azure;\nusing Identity = Azure.Identity;",
    )
    .replace("using Azure.Identity;", "")
    .replace(
      "using Azure.Storage.Blobs;",
      "using Blobs = Azure.Storage.Blobs;",
    )
    .replace(
      "using Azure.Storage.Blobs.Models;",
      "using Models = Azure.Storage.Blobs.Models;",
    )
    .replace(
      "using Azure.Storage.Blobs.Specialized;",
      "using Batch = Azure.Storage.Blobs.Specialized;",
    )
    .replaceAll("DefaultAzureCredential", "Identity.DefaultAzureCredential")
    .replaceAll("BlobServiceClient", "Blobs.BlobServiceClient")
    .replace(
      "BlobContainerClient container",
      "Blobs.BlobContainerClient container",
    )
    .replace(
      "BlobBatchClient batchClient",
      "Batch.BlobBatchClient batchClient",
    )
    .replaceAll("BlobBatch customBatch", "Batch.BlobBatch customBatch")
    .replaceAll("DeleteSnapshotsOption", "Models.DeleteSnapshotsOption")
    .replaceAll("AccessTier.Cool", "Models.AccessTier.Cool")
    .replaceAll("AccessTier.Hot", "Models.AccessTier.Hot")
    .replaceAll("RequestFailedException", "Core.RequestFailedException")
    .replaceAll("Response[]", "Core.Response[]")
    .replaceAll("Response custom", "Core.Response custom")
    .replaceAll("Response submission", "Core.Response submission")
    .replace(
      "var serviceClient = new Blobs.BlobServiceClient(serviceUri, credential);",
      "Blobs.BlobServiceClient serviceClient = new(serviceUri, credential);",
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("comments, strings, local SDK fakes, and unreachable helpers fail", () => {
  const minimal = `Console.WriteLine("started");`;
  const decoys = [
    `${minimal}
string example = """
${completeWorkspace.source}
""";
/* ${completeWorkspace.source} */`,
    `${completeWorkspace.source}
class BlobBatchClient {}
class BlobBatch {}
class BlobServiceClient {}
class DefaultAzureCredential {}
class RequestFailedException : Exception {}`,
    `${minimal}
static async Task UnusedAsync()
{
${completeWorkspace.source
  .split("\n")
  .filter((line) => !line.startsWith("using "))
  .join("\n")}
}`,
    `${minimal}
if (false)
{
${completeWorkspace.source
  .split("\n")
  .filter((line) => !line.startsWith("using "))
  .join("\n")}
}`,
  ];

  decoys.forEach((source, index) => {
    for (const rule of ruleNames().filter(
      (name) => name !== "prompt/storage-batch-manifest",
    )) {
      assert.equal(
        evaluateRule(rule, workspace(source)),
        false,
        `${index}:${rule}`,
      );
    }
  });
});

test("manifest and source cannot be assembled from disconnected projects", () => {
  const split = loadedWorkspace({
    "App/App.csproj": manifest().replace(
      '<PackageReference Include="Azure.Storage.Blobs.Batch" Version="12.26.0" />',
      "",
    ),
    "App/Program.cs": completeWorkspace.source,
    "Packages/Packages.csproj": manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      "",
    ),
    "Packages/Program.cs": 'Console.WriteLine("packages");',
  });
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, split), false, rule);
  }
});

test("operations must use the authenticated client and same-account targets", () => {
  const otherClient = completeWorkspace.source
    .replace(
      "BlobBatchClient batchClient = serviceClient.GetBlobBatchClient();",
      `BlobBatchClient batchClient = serviceClient.GetBlobBatchClient();
var otherService = new BlobServiceClient(
    new Uri("https://other.blob.core.windows.net"),
    credential);
var otherBatch = otherService.GetBlobBatchClient();`,
    )
    .replaceAll(
      "await batchClient.DeleteBlobsAsync",
      "await otherBatch.DeleteBlobsAsync",
    )
    .replaceAll(
      "await batchClient.SetBlobsAccessTierAsync",
      "await otherBatch.SetBlobsAccessTierAsync",
    );
  assert.equal(
    evaluateRule("prompt/delete-batches", workspace(otherClient)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/tier-batch", workspace(otherClient)),
    false,
  );

  const foreignTargets = completeWorkspace.source
    .replace(
      "container.GetBlobClient($\"delete-{index:000}\").Uri",
      'new Uri($"https://other.blob.core.windows.net/c/delete-{index:000}")',
    )
    .replace(
      "container.GetBlobClient($\"tier-{index:000}\").Uri",
      'new Uri($"https://other.blob.core.windows.net/c/tier-{index:000}")',
    );
  assert.equal(
    evaluateRule("prompt/delete-batches", workspace(foreignTargets)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/tier-batch", workspace(foreignTargets)),
    false,
  );
});

test("response evidence must occur after the connected operation or submission", () => {
  const beforeConvenience = completeWorkspace.source
    .replace(
      "Response[] responses = await batchClient.DeleteBlobsAsync(",
      `Response[] responses = Array.Empty<Response>();
        Console.WriteLine(responses[0].Status);
        responses = await batchClient.DeleteBlobsAsync(`,
    )
    .replace(
      'Console.WriteLine(\n                $"Delete {chunk[index]} returned {responses[index].Status}.");',
      'Console.WriteLine($"Delete {chunk[index]} completed.");',
    );
  assert.equal(
    evaluateRule("prompt/delete-batches", workspace(beforeConvenience)),
    false,
  );

  const beforeSubmit = completeWorkspace.source
    .replace(
      "try\n{\n    Response submission = await batchClient.SubmitBatchAsync(",
      `Console.WriteLine(customDelete.Status);
Console.WriteLine(customTier.Status);
try
{
    Response submission = await batchClient.SubmitBatchAsync(`,
    )
    .replace(
      'Console.WriteLine($"Custom delete returned {customDelete.Status}.");',
      'Console.WriteLine("Custom delete completed.");',
    )
    .replace(
      'Console.WriteLine($"Custom set-tier returned {customTier.Status}.");',
      'Console.WriteLine("Custom set-tier completed.");',
    );
  assert.equal(
    evaluateRule("prompt/custom-batch-responses", workspace(beforeSubmit)),
    false,
  );

  const oppositeBranches = `
using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Specialized;
var endpointText = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
var containerName = Environment.GetEnvironmentVariable("AZURE_STORAGE_CONTAINER");
var endpoint = new Uri(endpointText!, UriKind.Absolute);
var credential = new DefaultAzureCredential();
var service = new BlobServiceClient(endpoint, credential);
var batchClient = service.GetBlobBatchClient();
var container = service.GetBlobContainerClient(containerName);
using var batch = batchClient.CreateBatch();
if (DateTime.UtcNow.Ticks > 0)
{
    Response customDelete = batch.DeleteBlob(
        container.GetBlobClient("delete").Uri);
}
else
{
    await batchClient.SubmitBatchAsync(batch, false);
    Console.WriteLine(customDelete.Status);
}`;
  assert.equal(
    evaluateRule("prompt/custom-batch-responses", workspace(oppositeBranches)),
    false,
  );
});

test("failure handlers must guard a connected awaited batch operation", () => {
  const disconnected = completeWorkspace.source
    .replace(
      "Response[] responses = await batchClient.DeleteBlobsAsync(",
      "Response[] responses = batchClient.DeleteBlobsAsync(",
    )
    .replace(
      "DeleteSnapshotsOption.IncludeSnapshots);",
      "DeleteSnapshotsOption.IncludeSnapshots).Result;",
    )
    .replace(
      "Response[] responses = await batchClient.SetBlobsAccessTierAsync(",
      "Response[] responses = batchClient.SetBlobsAccessTierAsync(",
    )
    .replace(
      "tierUris,\n        AccessTier.Cool);",
      "tierUris,\n        AccessTier.Cool).Result;",
    );
  assert.equal(
    evaluateRule("prompt/partial-failure-handling", workspace(disconnected)),
    false,
  );
});

test("500 deletes require chunks no larger than 256 and the 4 MiB limit", () => {
  const singleRequest = completeWorkspace.source
    .replace(
      "foreach (Uri[] chunk in deleteUris.Chunk(MaxOperationsPerBatch))",
      "foreach (Uri[] chunk in new[] { deleteUris })",
    );
  assert.equal(
    evaluateRule("prompt/delete-batches", workspace(singleRequest)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/batch-limits", workspace(singleRequest)),
    false,
  );

  const tooLarge = completeWorkspace.source.replace(
    "const int MaxOperationsPerBatch = 256;",
    "const int MaxOperationsPerBatch = 257;",
  );
  assert.equal(
    evaluateRule("prompt/delete-batches", workspace(tooLarge)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/batch-limits", workspace(tooLarge)),
    false,
  );
});

test("custom responses and submission must belong to the same batch client", () => {
  const disconnected = completeWorkspace.source
    .replace(
      "using BlobBatch customBatch = batchClient.CreateBatch();",
      `using BlobBatch customBatch = batchClient.CreateBatch();
using BlobBatch otherBatch = batchClient.CreateBatch();`,
    )
    .replace(
      "customBatch.DeleteBlob(",
      "otherBatch.DeleteBlob(",
    )
    .replace(
      "customBatch.SetBlobAccessTier(",
      "otherBatch.SetBlobAccessTier(",
    );
  assert.equal(
    evaluateRule("prompt/custom-batch-responses", workspace(disconnected)),
    false,
  );

  const ignoredResponse = completeWorkspace.source.replace(
    "Response customTier = customBatch.SetBlobAccessTier(",
    "customBatch.SetBlobAccessTier(",
  );
  assert.equal(
    evaluateRule("prompt/custom-batch-responses", workspace(ignoredResponse)),
    false,
  );
});
