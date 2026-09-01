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
} from "./tools/storage-dotnet-error-handling-rules.mjs";

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

test.skip("golden passes seven prompt rules and every shared .NET check", () => {
  assert.equal(ruleNames().length, 7);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, sharedWorkspace), true, check);
  }
});

test.skip("manifest requires one executable net8 project with exact stable pins", () => {
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
      "prompt/storage-error-manifest",
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
        "prompt/storage-error-manifest",
        workspace(completeWorkspace.source, project),
      ),
      false,
      project,
    );
  }
});

test.skip("focused golden omissions fail their own criteria", () => {
  const cases = [
    [
      "prompt/storage-error-manifest",
      completeWorkspace.source,
      completeWorkspace.project.replace("12.29.2", "12.28.0"),
    ],
    [
      "prompt/configured-blob-client",
      completeWorkspace.source.replace(
        "new BlobServiceClient(serviceUri, credential, options)",
        'new BlobServiceClient("UseDevelopmentStorage=true")',
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/connected-storage-operations",
      completeWorkspace.source.replace(
        "await blobClient.SetMetadataAsync(metadata, conditions)",
        "await otherBlob.SetMetadataAsync(metadata, conditions)",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/exception-details",
      completeWorkspace.source.replace(
        '"x-ms-client-request-id"',
        '"x-ms-version"',
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/common-status-handling",
      completeWorkspace.source.replace("case 409:", "case 400:"),
      completeWorkspace.project,
    ],
    [
      "prompt/conditional-request",
      completeWorkspace.source.replace(
        "IfMatch = currentETag",
        "IfMatch = ETag.All",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/retry-policy",
      completeWorkspace.source.replace("MaxRetries = 5", "MaxRetries = 0"),
      completeWorkspace.project,
    ],
  ];

  for (const [rule, source, project] of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test.skip("qualified aliases, target-typed constructors, and helpers pass", () => {
  const source = completeWorkspace.source
    .replace(
      "using Azure;",
      "using Azure;\nusing Failure = Azure.RequestFailedException;",
    )
    .replace(
      "using Azure.Identity;",
      "using Identity = Azure.Identity;",
    )
    .replace(
      "using Azure.Storage.Blobs;",
      "using Blobs = Azure.Storage.Blobs;",
    )
    .replace(
      "using Azure.Storage.Blobs.Models;",
      "using Models = Azure.Storage.Blobs.Models;",
    )
    .replaceAll("DefaultAzureCredential", "Identity.DefaultAzureCredential")
    .replaceAll("BlobClientOptions", "Blobs.BlobClientOptions")
    .replaceAll("BlobServiceClient", "Blobs.BlobServiceClient")
    .replaceAll("BlobContainerClient", "Blobs.BlobContainerClient")
    .replaceAll("BlobClient blobClient", "Blobs.BlobClient blobClient")
    .replaceAll("BlobProperties", "Models.BlobProperties")
    .replaceAll("BlobRequestConditions", "Models.BlobRequestConditions")
    .replaceAll("BlobInfo", "Models.BlobInfo")
    .replaceAll("RequestFailedException", "Failure")
    .replace(
      "GetBlobs.BlobContainerClient",
      "GetBlobContainerClient",
    )
    .replace(
      "using Failure = Azure.Failure;",
      "using Failure = Azure.RequestFailedException;",
    )
    .replace(
      "var serviceClient = new Blobs.BlobServiceClient(serviceUri, credential, options)",
      "Blobs.BlobServiceClient serviceClient = new(serviceUri, credential, options)",
    )
    .replace(
      "Response? response = failure.GetRawResponse();",
      "var raw = failure.GetRawResponse();",
    )
    .replaceAll("response is not null", "raw is not null")
    .replaceAll("response.Headers.", "raw.Headers.")
    .replaceAll("response?.Headers.", "raw.Headers.");

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("comments, strings, local SDK fakes, and unreachable helpers fail", () => {
  const minimal = `using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
Console.WriteLine("started");`;
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
class BlobRequestConditions {}
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
      (name) => name !== "prompt/storage-error-manifest",
    )) {
      assert.equal(
        evaluateRule(rule, workspace(source)),
        false,
        `${index}:${rule}`,
      );
    }
  });
});

test.skip("manifest and source cannot be assembled from disconnected projects", () => {
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

test.skip("operations must use the blob derived from the configured service client", () => {
  const disconnected = completeWorkspace.source
    .replace(
      "BlobClient blobClient = containerClient.GetBlobClient(blobName);",
      `BlobClient blobClient = containerClient.GetBlobClient(blobName);
var otherService = new BlobServiceClient("UseDevelopmentStorage=true");
var otherContainer = otherService.GetBlobContainerClient(containerName);
var otherBlob = otherContainer.GetBlobClient(blobName);`,
    )
    .replaceAll("await blobClient.GetPropertiesAsync", "await otherBlob.GetPropertiesAsync")
    .replaceAll("await blobClient.SetMetadataAsync", "await otherBlob.SetMetadataAsync");

  for (const rule of [
    "prompt/connected-storage-operations",
    "prompt/exception-details",
    "prompt/common-status-handling",
    "prompt/conditional-request",
  ]) {
    assert.equal(evaluateRule(rule, workspace(disconnected)), false, rule);
  }
});

test.skip("request and error evidence must be on compatible operation paths", () => {
  const disconnectedDiagnostics = completeWorkspace.source
    .replace("ReportFailure(failure);", 'Console.Error.WriteLine("failed");')
    .replace(
      "static void ReportFailure(RequestFailedException failure)",
      `static async Task UnrelatedAsync(BlobClient blobClient)
{
    try
    {
        await blobClient.GetPropertiesAsync();
    }
    catch (RequestFailedException failure)
    {
        ReportFailure(failure);
    }
}

static void ReportFailure(RequestFailedException failure)`,
    );
  assert.equal(
    evaluateRule(
      "prompt/exception-details",
      workspace(disconnectedDiagnostics),
    ),
    false,
  );

  const disconnectedCondition = completeWorkspace.source
    .replace(
      "await blobClient.SetMetadataAsync(metadata, conditions);",
      'Console.WriteLine("condition prepared");',
    )
    .replace(
      "static void ReportFailure(RequestFailedException failure)",
      `static async Task UnrelatedAsync(
    BlobClient blobClient,
    IDictionary<string, string> metadata,
    BlobRequestConditions conditions)
{
    await blobClient.SetMetadataAsync(metadata, conditions);
}

static void ReportFailure(RequestFailedException failure)`,
    );
  assert.equal(
    evaluateRule(
      "prompt/conditional-request",
      workspace(disconnectedCondition),
    ),
    false,
  );

  const splitConditions = completeWorkspace.source.replace(
    /var conditions = new BlobRequestConditions\r?\n    \{\r?\n        IfMatch = currentETag,\r?\n        LeaseId = leaseId,\r?\n    \};/,
    `var conditions = new BlobRequestConditions
    {
        IfMatch = currentETag,
    };
    var unrelatedConditions = new BlobRequestConditions
    {
        LeaseId = leaseId,
    };`,
  );
  assert.equal(
    evaluateRule("prompt/conditional-request", workspace(splitConditions)),
    false,
  );

  const splitStatuses = completeWorkspace.source
    .replace("case 409:", "case 400:")
    .replace(
      "static void ReportFailure(RequestFailedException failure)",
      `static async Task SeparateConflictAsync(BlobClient blobClient)
{
    try
    {
        await blobClient.GetPropertiesAsync();
    }
    catch (RequestFailedException failure) when (failure.Status == 409)
    {
        Console.Error.WriteLine("A lease conflict blocked the operation.");
    }
}

static void ReportFailure(RequestFailedException failure)`,
    );
  assert.equal(
    evaluateRule("prompt/common-status-handling", workspace(splitStatuses)),
    false,
  );
});
