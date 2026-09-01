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
  loadWorkspace,
  ruleNames,
} from "./tools/storage-dotnet-polling-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadWorkspace(goldenRoot);
const sharedGolden = loadDotnetWorkspace(goldenRoot);

function workspace(source, project = golden.project) {
  return {
    ...golden,
    projects: undefined,
    project,
    source,
    sourceFiles: ["Program.cs"],
  };
}

function manifest({
  identity = "1.21.0",
  storage = "1.7.0",
  target = "net8.0",
} = {}) {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${target}</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="${identity}" />
    <PackageReference Include="Azure.ResourceManager.Storage"
                      Version="${storage}" />
  </ItemGroup>
</Project>`;
}

function changed(source, search, replacement) {
  const normalized = source.replaceAll("\r\n", "\n");
  assert.ok(normalized.includes(search), `missing fixture text: ${search}`);
  return normalized.replace(search, replacement);
}

function withoutUsings(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("using "))
    .join("\n");
}

test.skip("golden passes eight prompt rules and all shared .NET checks", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, sharedGolden), true, check);
  }
});

test.skip("manifest requires one runnable net8 project with exact stable pins", () => {
  const propertyManaged = manifest()
    .replace(
      "<TargetFramework>net8.0</TargetFramework>",
      "<NetTarget>net8.0</NetTarget><TargetFramework>$(NetTarget)</TargetFramework>",
    )
    .replace('Version="1.21.0"', 'Version="[1.21.0]"');
  assert.equal(
    evaluateRule(
      "prompt/storage-manifest",
      workspace(golden.source, propertyManaged),
    ),
    true,
  );

  const invalid = [
    manifest({ target: "net7.0" }),
    manifest({ identity: "1.20.0" }),
    manifest({ storage: "1.6.0" }),
    manifest({ storage: "1.*" }),
    manifest({ storage: "[1.7.0,)" }),
    manifest().replace("<OutputType>Exe</OutputType>", ""),
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<PackageReference Include="Azure.Identity" Version="1.21.0" Condition="false" />',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.ResourceManager.Storage"\n                      Version="1.7.0" />',
      '<!-- <PackageReference Include="Azure.ResourceManager.Storage" Version="1.7.0" /> -->',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />\n' +
        '<PackageReference Include="Azure.Identity" Version="9.9.9" />',
    ),
  ];
  for (const project of invalid) {
    assert.equal(
      evaluateRule(
        "prompt/storage-manifest",
        workspace(golden.source, project),
      ),
      false,
      project,
    );
  }
});

test.skip("focused golden omissions fail their own criteria", () => {
  const source = golden.source.replaceAll("\r\n", "\n");
  const cases = [
    [
      "prompt/storage-manifest",
      source,
      golden.project.replace("1.7.0", "1.6.0"),
    ],
    [
      "prompt/credential-resource-path",
      changed(
        source,
        "var armClient = new ArmClient(credential, subscriptionId);",
        "var armClient = new ArmClient(otherCredential, subscriptionId);",
      ),
      golden.project,
    ],
    [
      "prompt/storage-account-content",
      source.replace(
        "StorageSkuName.StandardLrs",
        "StorageSkuName.PremiumLrs",
      ),
      golden.project,
    ],
    [
      "prompt/create-started-operation",
      source.replace("WaitUntil.Started", "WaitUntil.Completed"),
      golden.project,
    ],
    [
      "prompt/connected-manual-polling",
      source.replace(
        "await createOperation.UpdateStatusAsync(timeout.Token);",
        "await otherOperation.UpdateStatusAsync(timeout.Token);",
      ),
      golden.project,
    ],
    [
      "prompt/exact-operation-completion",
      source.replace(
        "await createOperation.WaitForCompletionAsync(timeout.Token)",
        "await otherOperation.WaitForCompletionAsync(timeout.Token)",
      ),
      golden.project,
    ],
    [
      "prompt/created-account-output",
      source.replace(
        "createdAccount.Data.Location",
        "location",
      ),
      golden.project,
    ],
    [
      "prompt/timeout-request-errors",
      source.replace("exception.Status", "exception.Message"),
      golden.project,
    ],
  ];

  for (const [rule, changedSource, project] of cases) {
    assert.equal(
      evaluateRule(rule, workspace(changedSource, project)),
      false,
      rule,
    );
  }
});

test.skip("aliases, named arguments, target typing, and reachable helpers pass", () => {
  const source = `
using Azure;
using Identity = Azure.Identity;
using ARM = Azure.ResourceManager;
using Resources = Azure.ResourceManager.Resources;
using Storage = Azure.ResourceManager.Storage;
using Models = Azure.ResourceManager.Storage.Models;
using Threading = System.Threading;
using System;

string subscriptionId = Environment.GetEnvironmentVariable("AZURE_SUBSCRIPTION_ID")!;
string groupName = Environment.GetEnvironmentVariable("AZURE_RESOURCE_GROUP_NAME")!;
string accountName = Environment.GetEnvironmentVariable("AZURE_STORAGE_ACCOUNT_NAME")!;
string location = Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus";
Identity.DefaultAzureCredential credential = new();
await CreateAsync(
    credential, subscriptionId, groupName, accountName, location);

static async Task CreateAsync(
    Identity.DefaultAzureCredential credential,
    string subscriptionId,
    string groupName,
    string accountName,
    string location)
{
    ARM.ArmClient client = new(
        credential: credential,
        defaultSubscriptionId: subscriptionId);
    try
    {
        Resources.SubscriptionResource subscription =
            await client.GetDefaultSubscriptionAsync();
        Resources.ResourceGroupCollection groups =
            subscription.GetResourceGroups();
        Resources.ResourceGroupResource group =
            (await groups.GetAsync(name: groupName)).Value;
        Storage.StorageAccountCollection accounts =
            group.GetStorageAccounts();
        Models.StorageSku sku =
            new(Models.StorageSkuName.StandardLrs);
        Models.StorageAccountCreateOrUpdateContent data = new(
            sku: sku,
            kind: Models.StorageKind.StorageV2,
            location: location);
        using Threading.CancellationTokenSource timeout =
            new(TimeSpan.FromMinutes(1));
        Azure.ArmOperation<Storage.StorageAccountResource> operation =
            await accounts.CreateOrUpdateAsync(
                data: data,
                name: accountName,
                waitUntil: Azure.WaitUntil.Started);
        var cancellationToken = timeout.Token;
        while (operation.HasCompleted == false)
        {
            await operation.UpdateStatusAsync(
                cancellationToken: cancellationToken);
        }
        Azure.Response<Storage.StorageAccountResource> response =
            await operation.WaitForCompletionAsync(
                cancellationToken: cancellationToken);
        Storage.StorageAccountResource account = response.Value;
        Console.WriteLine(account.Data.Name);
        Console.WriteLine(account.Data.Kind);
    }
    catch (System.OperationCanceledException failure)
    {
        Console.Error.WriteLine(failure.Message);
    }
    catch (Azure.RequestFailedException failure)
    {
        Console.Error.WriteLine(
            $"{failure.Status}: {failure.ErrorCode}: {failure.Message}");
    }
}
`;

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("polling and result use must stay connected to the exact create operation", () => {
  const source = golden.source.replaceAll("\r\n", "\n");
  const invalid = [
    source.replace(
      "await createOperation.UpdateStatusAsync(timeout.Token);",
      "await unrelatedOperation.UpdateStatusAsync(timeout.Token);",
    ),
    source.replace(
      "await createOperation.WaitForCompletionAsync(timeout.Token)",
      "await unrelatedOperation.WaitForCompletionAsync(timeout.Token)",
    ),
    source.replace(
      "await createOperation.UpdateStatusAsync(timeout.Token);",
      "await createOperation.UpdateStatusAsync(CancellationToken.None);",
    ),
    source.replace(
      "await createOperation.UpdateStatusAsync(timeout.Token);",
      "break;\n        await createOperation.UpdateStatusAsync(timeout.Token);",
    ),
    source.replace(
      "await createOperation.WaitForCompletionAsync(timeout.Token)",
      "await createOperation.WaitForCompletionAsync(CancellationToken.None)",
    ),
    source.replace(
      "Response<StorageAccountResource> completion =\n        await createOperation.WaitForCompletionAsync(timeout.Token);\n    StorageAccountResource createdAccount = completion.Value;",
      "StorageAccountResource createdAccount = createOperation.Value;\n" +
        "    Response<StorageAccountResource> completion =\n" +
        "        await createOperation.WaitForCompletionAsync(timeout.Token);",
    ),
  ];

  for (const candidate of invalid) {
    assert.equal(
      evaluateRule("prompt/exact-operation-completion", workspace(candidate)),
      false,
      candidate,
    );
  }
});

test.skip("comments, strings, local SDK fakes, and unreachable code fail", () => {
  const minimal = `
using Azure;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.Resources;
using Azure.ResourceManager.Storage;
using Azure.ResourceManager.Storage.Models;
using System;
using System.Threading;
Console.WriteLine("no implementation");
`;
  const decoys = [
    `${minimal}
string example = """
${golden.source}
""";
/* ${golden.source} */`,
    `${golden.source}
class ArmClient {}
class StorageAccountCollection {}
class StorageAccountResource {}
class StorageAccountCreateOrUpdateContent {}
class StorageSku {}`,
    `${minimal}
static async Task NeverCalled()
{
${withoutUsings(golden.source)}
}`,
    `${minimal}
if (false)
{
${withoutUsings(golden.source)}
}`,
  ];

  decoys.forEach((candidate, index) => {
    for (const rule of ruleNames().filter(
      (name) => name !== "prompt/storage-manifest",
    )) {
      assert.equal(
        evaluateRule(rule, workspace(candidate)),
        false,
        `${index}:${rule}`,
      );
    }
  });
});

test.skip("disconnected content and path-incompatible inputs fail", () => {
  const source = golden.source.replaceAll("\r\n", "\n");
  const invalid = [
    [
      "prompt/credential-resource-path",
      source.replace(
        "new ArmClient(credential, subscriptionId)",
        "new ArmClient(credential, resourceGroupName)",
      ),
    ],
    [
      "prompt/credential-resource-path",
      source.replace(
        "GetAsync(resourceGroupName)",
        "GetAsync(accountName)",
      ),
    ],
    [
      "prompt/storage-account-content",
      source.replace(
        "StorageKind.StorageV2",
        "StorageKind.FileStorage",
      ),
    ],
    [
      "prompt/storage-account-content",
      source.replace(
        "location);",
        "accountName);",
      ),
    ],
    [
      "prompt/create-started-operation",
      source.replace(
        "accountName,\n            content",
        "resourceGroupName,\n            content",
      ),
    ],
  ];

  for (const [rule, candidate] of invalid) {
    assert.equal(evaluateRule(rule, workspace(candidate)), false, rule);
  }

  const disconnectedContent = source
    .replace(
      "using var timeout =",
      `var wrongContent = new StorageAccountCreateOrUpdateContent(
        sku, StorageKind.FileStorage, location);
    using var timeout =`,
    )
    .replace(
      "accountName,\n            content",
      "accountName,\n            wrongContent",
    );
  assert.equal(
    evaluateRule(
      "prompt/create-started-operation",
      workspace(disconnectedContent),
    ),
    false,
  );
});

test.skip("manifest and source evidence cannot be assembled across projects", () => {
  const split = {
    ...golden,
    projects: [
      {
        path: "App/App.csproj",
        project: manifest().replace(
          '<PackageReference Include="Azure.ResourceManager.Storage"\n                      Version="1.7.0" />',
          "",
        ),
        source: golden.source,
        sourceFiles: ["App/Program.cs"],
      },
      {
        path: "Packages/Packages.csproj",
        project: manifest().replace(
          '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
          "",
        ),
        source: 'Console.WriteLine("packages");',
        sourceFiles: ["Packages/Program.cs"],
      },
    ],
  };

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, split), false, rule);
  }
});
