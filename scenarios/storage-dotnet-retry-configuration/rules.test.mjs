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
} from "./tools/storage-dotnet-retry-rules.mjs";

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

test("golden passes five prompt rules and every shared .NET check", () => {
  assert.equal(ruleNames().length, 5);
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
    </PropertyGroup>
    <ItemGroup>
      <PackageReference Include="azure.identity"
                        Version="[$(IdentityVersion)]" />
      <PackageReference Include="AZURE.STORAGE.BLOBS">
        <Version>$(BlobsVersion)</Version>
      </PackageReference>
    </ItemGroup>
  </Project>`;
  assert.equal(
    evaluateRule(
      "prompt/storage-retry-manifest",
      workspace(completeWorkspace.source, propertyManaged),
    ),
    true,
  );

  const invalid = [
    manifest({ target: "net7.0" }),
    manifest({ target: "$(MissingTarget)" }),
    manifest({ identity: "1.22.0" }),
    manifest({ blobs: "12.*" }),
    manifest({ blobs: "[12.29.2,)" }),
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<!-- <PackageReference Include="Azure.Identity" Version="1.21.0" /> -->',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.Storage.Blobs" Version="12.29.2" />',
      '<PackageReference Include="Azure.Storage.Blobs" Version="12.29.2" Condition="false" />',
    ),
    manifest({
      extra:
        '<PackageReference Include="Azure.Storage.Blobs" Version="99.0.0" />',
    }),
  ];
  for (const project of invalid) {
    assert.equal(
      evaluateRule(
        "prompt/storage-retry-manifest",
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
      "prompt/storage-retry-manifest",
      completeWorkspace.source,
      completeWorkspace.project.replace("12.29.2", "12.28.0"),
    ],
    [
      "prompt/configured-upload-client",
      completeWorkspace.source.replace(
        "MaxRetries = 5",
        "MaxRetries = 4",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/operation-timeout",
      completeWorkspace.source.replace(
        "TimeSpan.FromMinutes(2)",
        "TimeSpan.FromMinutes(3)",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/failure-classification",
      completeWorkspace.source.replace(
        "status is 408 or 429 or 500 or 502 or 503 or 504",
        "status is 408 or 429 or 500 or 503 or 504",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/circuit-breaker",
      completeWorkspace.source.replace(
        "FailureThreshold = 3",
        "FailureThreshold = 4",
      ),
      completeWorkspace.project,
    ],
  ];

  for (const [rule, source, project] of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test("equivalent assignments, timespans, aliases, and upload helpers pass", () => {
  const source = completeWorkspace.source
    .replace(
      /var clientOptions = new BlobClientOptions\r?\n\{[\s\S]*?\r?\n\};/,
      `BlobClientOptions clientOptions = new();
clientOptions.Retry.Mode = RetryMode.Exponential;
clientOptions.Retry.MaxRetries = 5;
clientOptions.Retry.Delay = TimeSpan.FromMilliseconds(1000);
clientOptions.Retry.MaxDelay = TimeSpan.FromMilliseconds(16000);
clientOptions.Retry.NetworkTimeout = TimeSpan.FromMinutes(0.5);`,
    )
    .replace(
      "TimeSpan.FromMinutes(2)",
      "TimeSpan.FromSeconds(120)",
    )
    .replace(
      `await blobClient.UploadAsync(
                content,
                overwrite: true,
                cancellationToken: operationTimeout.Token);`,
      "await UploadBlobAsync(blobClient, content, operationTimeout.Token);",
    )
    .replace(
      "static class RetryClassification",
      `static async Task UploadBlobAsync(
    BlobClient client,
    Stream content,
    CancellationToken cancellationToken)
{
    await client.UploadAsync(
        content,
        overwrite: true,
        cancellationToken: cancellationToken);
}

static class RetryClassification`,
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("comments, strings, local SDK fakes, and unreachable code fail", () => {
  const minimal = `using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;
Console.WriteLine("started");`;
  const runtimeStart = completeWorkspace.source.indexOf("string endpointText");
  const typesStart = completeWorkspace.source.indexOf(
    "static class RetryClassification",
  );
  const runtime = completeWorkspace.source.slice(runtimeStart, typesStart);
  const types = completeWorkspace.source.slice(typesStart);
  const decoys = [
    `${minimal}
string sample = """
${completeWorkspace.source}
""";
/* ${completeWorkspace.source} */`,
    `${completeWorkspace.source}
class BlobServiceClient {}
class BlobContainerClient {}
class BlobClient {}
class BlobClientOptions {}
class DefaultAzureCredential {}
class RequestFailedException : Exception {}`,
    `${minimal}
static async Task UnusedAsync()
{
${runtime}
}
${types}`,
    `${minimal}
if (false)
{
${runtime}
}
${types}`,
  ];

  decoys.forEach((source, index) => {
    for (const rule of ruleNames().filter(
      (name) => name !== "prompt/storage-retry-manifest",
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
      '<PackageReference Include="Azure.Storage.Blobs" Version="12.29.2" />',
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

test("retry options must configure the exact client that uploads", () => {
  const disconnected = completeWorkspace.source.replace(
    /var serviceClient =\s*\r?\n\s*new BlobServiceClient\(serviceUri, credential, clientOptions\);/,
    `var configuredService =
    new BlobServiceClient(serviceUri, credential, clientOptions);
var serviceClient = new BlobServiceClient(serviceUri, credential);`,
  );

  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/storage-retry-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(disconnected)), false, rule);
  }
});

test("timeout, error, and circuit evidence must share the upload path", () => {
  const wrongTimeout = completeWorkspace.source
    .replace(
      "cancellationToken: operationTimeout.Token",
      "cancellationToken: CancellationToken.None",
    )
    .replace(
      "Console.WriteLine($\"Uploaded '{blobClient.Name}'.\");",
      `Console.WriteLine($"Uploaded '{blobClient.Name}'.");
var otherService = new BlobServiceClient(serviceUri, credential);
var otherBlob = otherService
    .GetBlobContainerClient(containerName)
    .GetBlobClient(blobName);
await otherBlob.UploadAsync(
    BinaryData.FromString("other"),
    overwrite: true,
    cancellationToken: operationTimeout.Token);`,
    );
  assert.equal(
    evaluateRule("prompt/operation-timeout", workspace(wrongTimeout)),
    false,
  );

  const wrongCircuit = completeWorkspace.source
    .replace(
      "BlobClient blobClient = containerClient.GetBlobClient(blobName);",
      `BlobClient blobClient = containerClient.GetBlobClient(blobName);
var otherService = new BlobServiceClient(serviceUri, credential);
var otherBlob = otherService
    .GetBlobContainerClient(containerName)
    .GetBlobClient(blobName);`,
    )
    .replace(
      "await blobClient.UploadAsync(",
      "await otherBlob.UploadAsync(",
    )
    .replace(
      `        });
    Console.WriteLine($"Uploaded '{blobClient.Name}'.");`,
      `        });
    await blobClient.UploadAsync(
        BinaryData.FromString("configured"),
        overwrite: true,
        cancellationToken: operationTimeout.Token);
    Console.WriteLine($"Uploaded '{blobClient.Name}'.");`,
    );
  assert.equal(
    evaluateRule("prompt/circuit-breaker", workspace(wrongCircuit)),
    false,
  );

  const disconnectedClassification = completeWorkspace.source
    .replace(
      /catch \(RequestFailedException failure\)\s*\{[\s\S]*?\r?\n\}\r?\ncatch \(OperationCanceledException\)/,
      `catch (RequestFailedException failure)
{
    Console.Error.WriteLine($"Upload failed: {failure.Status}.");
}
catch (OperationCanceledException)`,
    )
    .replace(
      "static class RetryClassification",
      `static async Task UnrelatedClassificationAsync(BlobClient blob)
{
    try
    {
        await blob.UploadAsync(BinaryData.FromString("unrelated"));
    }
    catch (RequestFailedException failure)
    {
        if (RetryClassification.IsTransient(failure.Status))
        {
            Console.Error.WriteLine("Transient retry failure.");
        }
        else if (RetryClassification.IsNonTransient(failure.Status))
        {
            Console.Error.WriteLine("Non-transient authentication request.");
        }
    }
}

static class RetryClassification`,
    );
  assert.equal(
    evaluateRule(
      "prompt/failure-classification",
      workspace(disconnectedClassification),
    ),
    false,
  );
});

test("all prompt-specified retry, timeout, and breaker values are exact", () => {
  const invalid = [
    ["prompt/configured-upload-client", "RetryMode.Exponential", "RetryMode.Fixed"],
    ["prompt/configured-upload-client", "TimeSpan.FromSeconds(1)", "TimeSpan.FromSeconds(2)"],
    ["prompt/configured-upload-client", "TimeSpan.FromSeconds(16)", "TimeSpan.FromSeconds(15)"],
    ["prompt/configured-upload-client", "TimeSpan.FromSeconds(30)", "TimeSpan.FromSeconds(31)"],
    ["prompt/operation-timeout", "TimeSpan.FromMinutes(2)", "TimeSpan.FromSeconds(119)"],
    ["prompt/circuit-breaker", "BreakDuration =\r\n        TimeSpan.FromSeconds(30)", "BreakDuration =\r\n        TimeSpan.FromSeconds(29)"],
  ];
  for (const [rule, before, after] of invalid) {
    assert.equal(
      evaluateRule(rule, workspace(completeWorkspace.source.replace(before, after))),
      false,
      `${rule}: ${after}`,
    );
  }
});

test("the breaker opens only for transient failures and adds no retry loop", () => {
  const catchesEveryFailure = completeWorkspace.source.replace(
    /catch \(RequestFailedException failure\)\r?\n\s*when \(RetryClassification\.IsTransient\(failure\.Status\)\)/,
    "catch (RequestFailedException failure)",
  );
  assert.equal(
    evaluateRule("prompt/circuit-breaker", workspace(catchesEveryFailure)),
    false,
  );

  const extraRetryLoop = completeWorkspace.source
    .replace(
      "    await circuitBreaker.ExecuteAsync(",
      `    for (int retry = 0; retry < 2; retry++)
    {
        await circuitBreaker.ExecuteAsync(`,
    )
    .replace(
      `        });
    Console.WriteLine($"Uploaded '{blobClient.Name}'.");`,
      `        });
    }
    Console.WriteLine($"Uploaded '{blobClient.Name}'.");`,
    );
  assert.equal(
    evaluateRule("prompt/circuit-breaker", workspace(extraRetryLoop)),
    false,
  );
});
