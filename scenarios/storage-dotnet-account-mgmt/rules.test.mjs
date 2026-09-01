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
  evaluateRule,
  loadWorkspace,
  ruleNames,
} from "./tools/storage-dotnet-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const scenarioRoot = fileURLToPath(new URL(".", import.meta.url));
const golden = loadWorkspace(goldenRoot);

function workspace(source, project = golden.project) {
  return { ...golden, project, source };
}

function manifest({
  target = "net8.0",
  identity = "1.21.0",
  storage = "1.7.0",
} = {}) {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>${target}</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="${identity}" />
    <PackageReference Include="Azure.ResourceManager.Storage"
                      Version="${storage}" />
  </ItemGroup>
</Project>`;
}

function changed(source, search, replacement) {
  const normalizedSource = source.replaceAll("\r\n", "\n");
  const normalizedSearch = search.replaceAll("\r\n", "\n");
  const normalizedReplacement = replacement.replaceAll("\r\n", "\n");
  assert.ok(
    normalizedSource.includes(normalizedSearch),
    `missing fixture text: ${search}`,
  );
  return normalizedSource.replace(normalizedSearch, normalizedReplacement);
}

function compileManifest(items = "", properties = "", projectContent = "") {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    ${properties}
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="1.21.0" />
    <PackageReference Include="Azure.ResourceManager.Storage"
                      Version="1.7.0" />
    ${items}
  </ItemGroup>
  ${projectContent}
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

test.skip("golden passes exactly the nine-criterion contract", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test.skip("source manifest accepts active exact net8 package references", () => {
  const valid = [
    manifest(),
    `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup>
        <NetVersion>net8.0-windows10.0.19041.0</NetVersion>
        <TargetFrameworks>net7.0;$(NetVersion)</TargetFrameworks>
        <IdentityVersion>1.21.0</IdentityVersion>
        <StorageVersion>1.7.0</StorageVersion>
      </PropertyGroup>
      <Choose>
        <When Condition="true">
          <ItemGroup>
            <PackageReference Include="azure.identity"
                              Version="[$(IdentityVersion)]" />
            <PackageReference Include="AZURE.RESOURCEMANAGER.STORAGE">
              <Version>[$(StorageVersion)]</Version>
            </PackageReference>
          </ItemGroup>
        </When>
      </Choose>
    </Project>`,
  ];
  for (const project of valid) {
    assert.equal(
      evaluateRule("prompt/source-manifest", workspace(golden.source, project)),
      true,
      project,
    );
  }
});

test.skip("source manifest rejects inactive, floating, wrong, and split pins", () => {
  const invalid = [
    manifest({ target: "net7.0" }),
    manifest({ identity: "1.22.0" }),
    manifest({ storage: "1.8.0" }),
    manifest({ storage: "1.*" }),
    changed(
      manifest(),
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<PackageReference Include="Azure.Identity" Version="1.21.0" Condition="false" />',
    ),
    changed(
      manifest(),
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<!-- <PackageReference Include="Azure.Identity" Version="1.21.0" /> -->',
    ),
    `${manifest({ identity: "0.0.0" })}
     ${manifest({ storage: "0.0.0" })}`,
    `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
      <Target Name="Decoy">
        <ItemGroup>
          <PackageReference Include="Azure.Identity" Version="1.21.0" />
          <PackageReference Include="Azure.ResourceManager.Storage"
                            Version="1.7.0" />
        </ItemGroup>
      </Target>
    </Project>`,
  ];
  for (const project of invalid) {
    assert.equal(
      evaluateRule("prompt/source-manifest", workspace(golden.source, project)),
      false,
      project,
    );
  }
  assert.equal(
    evaluateRule("prompt/source-manifest", workspace("", manifest())),
    false,
  );
});

test.skip("Compile Remove cannot leave excluded source eligible", () => {
  const removed = loadedWorkspace({
    "App.csproj": compileManifest('<Compile Remove="Program.cs" />'),
    "Program.cs": golden.source,
  });
  assert.deepEqual(removed.sourceFiles, []);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, removed), false, rule);
  }
});

test.skip("explicit src Compile inputs support legitimate multi-file projects", () => {
  const included = loadedWorkspace({
    "App.csproj": compileManifest(
      '<Compile Include="$(SourceRoot)/**/*.cs" />',
      `<EnableDefaultCompileItems>false</EnableDefaultCompileItems>
       <SourceRoot>src</SourceRoot>`,
    ),
    "src/Program.cs": golden.source,
    "src/StorageNames.cs":
      "internal static class StorageNames { internal const string Blob = \"default\"; }",
  });
  assert.deepEqual(included.sourceFiles, [
    "src/Program.cs",
    "src/StorageNames.cs",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, included), true, rule);
  }
});

test.skip("Compile Include, Exclude, and Remove follow document order", () => {
  const excludedDecoy = loadedWorkspace({
    "App.csproj": compileManifest(
      '<Compile Include="src/**/*.cs" Exclude="src/Decoy.cs" />',
      "<EnableDefaultCompileItems>false</EnableDefaultCompileItems>",
    ),
    "src/Decoy.cs": "// deliberately excluded",
    "src/Program.cs": golden.source,
  });
  assert.deepEqual(excludedDecoy.sourceFiles, ["src/Program.cs"]);
  assert.equal(
    evaluateRule("prompt/delete-storage-account", excludedDecoy),
    true,
  );

  const excludedOnlySource = loadedWorkspace({
    "App.csproj": compileManifest(
      '<Compile Include="src/**/*.cs" Exclude="src/Program.cs" />',
      "<EnableDefaultCompileItems>false</EnableDefaultCompileItems>",
    ),
    "src/Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/source-manifest", excludedOnlySource),
    false,
  );

  const removedAfterInclude = loadedWorkspace({
    "App.csproj": compileManifest(
      `<Compile Include="src/**/*.cs" />
       <Compile Remove="src/Program.cs" />`,
      "<EnableDefaultCompileItems>false</EnableDefaultCompileItems>",
    ),
    "src/Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/source-manifest", removedAfterInclude),
    false,
  );

  const includedAfterRemove = loadedWorkspace({
    "App.csproj": compileManifest(
      `<Compile Remove="src/Program.cs" />
       <Compile Include="src/Program.cs" />`,
      "<EnableDefaultCompileItems>false</EnableDefaultCompileItems>",
    ),
    "src/Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/delete-storage-account", includedAfterRemove),
    true,
  );
});

test.skip("Compile conditions and Choose use conservative static evaluation", () => {
  const staticallyKept = loadedWorkspace({
    "App.csproj": compileManifest(
      `<Compile Remove="Program.cs"
                Condition="'$(KeepSource)' != 'true'" />`,
      "<KeepSource>TRUE</KeepSource>",
      `<Choose>
         <When Condition="false">
           <ItemGroup><Compile Remove="Program.cs" /></ItemGroup>
         </When>
         <Otherwise><PropertyGroup><Selected>true</Selected></PropertyGroup></Otherwise>
       </Choose>`,
    ),
    "Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/delete-storage-account", staticallyKept),
    true,
  );

  const staticallyRemoved = loadedWorkspace({
    "App.csproj": compileManifest(
      "",
      "",
      `<Choose>
         <When Condition="true">
           <ItemGroup><Compile Remove="Program.cs" /></ItemGroup>
         </When>
         <Otherwise>
           <ItemGroup><Compile Include="Program.cs" /></ItemGroup>
         </Otherwise>
       </Choose>`,
    ),
    "Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/source-manifest", staticallyRemoved),
    false,
  );

  const dynamicallyRemoved = loadedWorkspace({
    "App.csproj": compileManifest(
      '<Compile Remove="Program.cs" Condition="$(UnknownCondition)" />',
    ),
    "Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/source-manifest", dynamicallyRemoved),
    false,
  );

  const dynamicallyIncluded = loadedWorkspace({
    "App.csproj": compileManifest(
      '<Compile Include="$(UnknownSources)" />',
      "<EnableDefaultCompileItems>false</EnableDefaultCompileItems>",
    ),
    "Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/source-manifest", dynamicallyIncluded),
    false,
  );
});

test.skip("local SDK default-item properties constrain Compile inputs", () => {
  const defaultExcluded = loadedWorkspace({
    "App.csproj": compileManifest(
      "",
      "<DefaultItemExcludes>Program.cs</DefaultItemExcludes>",
    ),
    "Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/source-manifest", defaultExcluded),
    false,
  );

  const explicitlyRestored = loadedWorkspace({
    "App.csproj": compileManifest(
      '<Compile Include="Program.cs" />',
      "<DefaultItemExcludes>Program.cs</DefaultItemExcludes>",
    ),
    "Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/delete-storage-account", explicitlyRestored),
    true,
  );

  const unknownDefaults = loadedWorkspace({
    "App.csproj": compileManifest(
      "",
      "<DefaultItemExcludes>$(UnknownExcludes)</DefaultItemExcludes>",
    ),
    "Program.cs": golden.source,
  });
  assert.equal(
    evaluateRule("prompt/source-manifest", unknownDefaults),
    false,
  );
});

test.skip("projects keep package manifests and active sources isolated", () => {
  const split = loadedWorkspace({
    "manifest/App.csproj": compileManifest(
      "",
      "<EnableDefaultCompileItems>false</EnableDefaultCompileItems>",
    ),
    "source/App.csproj":
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    "source/Program.cs": golden.source,
  });
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, split), false, rule);
  }

  const complete = loadedWorkspace({
    "complete/App.csproj": compileManifest(),
    "complete/Program.cs": golden.source,
    "decoy/App.csproj":
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net7.0</TargetFramework></PropertyGroup></Project>',
    "decoy/Program.cs": "// unrelated project",
  });
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, complete), true, rule);
  }
});

test.skip("bin, obj, and test paths or projects cannot contribute source", () => {
  const ignored = loadedWorkspace({
    "App.csproj": compileManifest(),
    "bin/Program.cs": golden.source,
    "obj/Program.cs": golden.source,
    "tests/Program.cs": golden.source,
    "Storage.Tests/Program.cs": golden.source,
  });
  assert.deepEqual(ignored.sourceFiles, []);
  assert.equal(evaluateRule("prompt/source-manifest", ignored), false);

  const testProject = loadedWorkspace({
    "App.Tests.csproj": compileManifest(),
    "Program.cs": golden.source,
  });
  assert.deepEqual(testProject.projects, []);
  assert.equal(evaluateRule("prompt/source-manifest", testProject), false);
});

test.skip("focused golden omissions fail their criterion", () => {
  const cases = [
    [
      "prompt/credential-arm-client",
      changed(
        golden.source,
        "new DefaultAzureCredential()",
        "otherCredential",
      ),
    ],
    [
      "prompt/subscription-resource-group-accounts",
      changed(
        golden.source,
        "resourceGroup.GetStorageAccounts()",
        "otherResourceGroup.GetStorageAccounts()",
      ),
    ],
    [
      "prompt/create-storage-account",
      changed(
        golden.source,
        "StorageSkuName.StandardLrs",
        "StorageSkuName.PremiumLrs",
      ),
    ],
    [
      "prompt/create-storage-account",
      changed(golden.source, "StorageKind.StorageV2", "StorageKind.FileStorage"),
    ],
    [
      "prompt/create-storage-account",
      changed(
        golden.source,
        'Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus"',
        'Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "westus"',
      ),
    ],
    [
      "prompt/create-storage-account",
      changed(
        golden.source,
        'Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus"',
        '"eastus"',
      ),
    ],
    [
      "prompt/list-storage-accounts",
      changed(
        golden.source,
        'Console.WriteLine($"Storage account: {item.Data.Name}");',
        'Console.WriteLine("Storage account");',
      ),
    ],
    [
      "prompt/get-storage-account",
      changed(
        golden.source,
        '"Retrieved {retrieved.Data.Name} in {retrieved.Data.Location}."',
        '"Retrieved {created.Data.Name} in {created.Data.Location}."',
      ),
    ],
    [
      "prompt/configure-blob-service",
      changed(golden.source, "IsVersioningEnabled = true", "IsVersioningEnabled = false"),
    ],
    [
      "prompt/configure-blob-service",
      changed(
        golden.source,
        "retrieved.GetBlobService()",
        'retrieved.GetBlobService("logs")',
      ),
    ],
    [
      "prompt/configure-blob-service",
      changed(
        golden.source,
        "configuredBlobService.Data.IsVersioningEnabled",
        "blobData.IsVersioningEnabled",
      ),
    ],
    [
      "prompt/delete-storage-account",
      changed(
        golden.source,
        "await retrieved.DeleteAsync(WaitUntil.Completed);",
        "await otherAccount.DeleteAsync(WaitUntil.Completed);",
      ),
    ],
    [
      "prompt/request-failed-error",
      changed(
        golden.source,
        "catch (RequestFailedException exception)",
        "catch (Exception exception)",
      ),
    ],
  ];
  for (const [rule, source] of cases) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test.skip("explicit waits complete create, Blob service, and delete operations", () => {
  let source = changed(
    golden.source,
    `await accounts.CreateOrUpdateAsync(
            WaitUntil.Completed,
            accountName,
            content);`,
    `await accounts.CreateOrUpdateAsync(
            WaitUntil.Started,
            accountName,
            content);
    createOperation = await createOperation.WaitForCompletionAsync();`,
  );
  source = changed(
    source,
    `await blobService.CreateOrUpdateAsync(
            WaitUntil.Completed,
            blobData);`,
    `await blobService.CreateOrUpdateAsync(
            WaitUntil.Started,
            blobData);
    blobOperation = await blobOperation.WaitForCompletionAsync();`,
  );
  source = changed(
    source,
    "await retrieved.DeleteAsync(WaitUntil.Completed);",
    `ArmOperation deleteOperation =
        await retrieved.DeleteAsync(WaitUntil.Started);
    await deleteOperation.WaitForCompletionAsync();`,
  );
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("WaitUntil.Started alone and premature confirmations are rejected", () => {
  const startedCreate = changed(
    golden.source,
    "accounts.CreateOrUpdateAsync(\r\n            WaitUntil.Completed",
    "accounts.CreateOrUpdateAsync(\r\n            WaitUntil.Started",
  );
  const startedBlob = changed(
    golden.source,
    "blobService.CreateOrUpdateAsync(\r\n            WaitUntil.Completed",
    "blobService.CreateOrUpdateAsync(\r\n            WaitUntil.Started",
  );
  const startedDelete = changed(
    golden.source,
    "retrieved.DeleteAsync(WaitUntil.Completed)",
    "retrieved.DeleteAsync(WaitUntil.Started)",
  );
  assert.equal(
    evaluateRule("prompt/create-storage-account", workspace(startedCreate)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/configure-blob-service", workspace(startedBlob)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/delete-storage-account", workspace(startedDelete)),
    false,
  );

  const confirmation = 'Console.WriteLine($"Deleted storage account {accountName}.");';
  const premature = changed(
    golden.source,
    `await retrieved.DeleteAsync(WaitUntil.Completed);\r\n    ${confirmation}`,
    `${confirmation}\r\n    await retrieved.DeleteAsync(WaitUntil.Completed);`,
  );
  assert.equal(
    evaluateRule("prompt/delete-storage-account", workspace(premature)),
    false,
  );
});

test.skip("wrong account identity and access-tier substitutes are rejected", () => {
  const wrongGet = changed(
    golden.source,
    "accounts.GetAsync(accountName)",
    'accounts.GetAsync("other-account")',
  );
  assert.equal(
    evaluateRule("prompt/get-storage-account", workspace(wrongGet)),
    false,
  );

  const accessTier = changed(
    golden.source,
    "new StorageSku(StorageSkuName.StandardLrs)",
    "new StorageSku(StorageAccountAccessTier.Cool)",
  );
  assert.equal(
    evaluateRule("prompt/create-storage-account", workspace(accessTier)),
    false,
  );

  const disconnected = changed(
    golden.source,
    "StorageAccountCollection accounts = resourceGroup.GetStorageAccounts();",
    "StorageAccountCollection accounts = otherResourceGroup.GetStorageAccounts();",
  );
  assert.equal(
    evaluateRule("prompt/create-storage-account", workspace(disconnected)),
    false,
  );
});

test.skip("qualified types, aliases, named arguments, and target typing pass", () => {
  const source = `
using Azure;
using Identity = Azure.Identity;
using ARM = Azure.ResourceManager;
using Resources = Azure.ResourceManager.Resources;
using Storage = Azure.ResourceManager.Storage;
using Models = Azure.ResourceManager.Storage.Models;
using W = Azure.WaitUntil;
var subscriptionId = System.Environment.GetEnvironmentVariable(
    "AZURE_SUBSCRIPTION_ID");
var resourceGroupName = System.Environment.GetEnvironmentVariable(
    "AZURE_RESOURCE_GROUP_NAME");
var accountName = System.Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_ACCOUNT_NAME");
var location = System.Environment.GetEnvironmentVariable("AZURE_LOCATION")
    ?? "eastus";
Identity.DefaultAzureCredential credential = new();
ARM.ArmClient client = new(
    defaultSubscriptionId: subscriptionId,
    credential: credential);
Resources.SubscriptionResource subscription =
    await client.GetDefaultSubscriptionAsync();
Resources.ResourceGroupCollection groups = subscription.GetResourceGroups();
Resources.ResourceGroupResource group =
    (await groups.GetAsync(name: resourceGroupName)).Value;
Storage.StorageAccountCollection accounts = group.GetStorageAccounts();
try
{
    Models.StorageSku sku = new(Models.StorageSkuName.StandardLrs);
    Models.StorageAccountCreateOrUpdateContent content = new(
        location: location, kind: Models.StorageKind.StorageV2, sku: sku);
    Azure.ArmOperation<Storage.StorageAccountResource> creation =
        await accounts.CreateOrUpdateAsync(
            data: content, name: accountName, waitUntil: W.Completed);
    Storage.StorageAccountResource created = creation.Value;
    await foreach (
        Storage.StorageAccountResource item in accounts.GetAllAsync())
    {
        System.Console.WriteLine(item.Data.Name);
    }
    Storage.StorageAccountResource account =
        (await accounts.GetAsync(name: accountName)).Value;
    System.Console.WriteLine(account.Data.Kind);
    Storage.BlobServiceResource service = account.GetBlobService();
    Models.BlobServiceData data = new();
    data.IsVersioningEnabled = true;
    Azure.ArmOperation<Storage.BlobServiceResource> blob =
        await service.CreateOrUpdateAsync(
            data: data, waitUntil: W.Completed);
    Storage.BlobServiceResource configured = blob.Value;
    System.Console.WriteLine(configured.Data.IsVersioningEnabled);
    await account.DeleteAsync(waitUntil: W.Completed);
    System.Console.WriteLine(accountName);
}
catch (Azure.RequestFailedException failure)
{
    System.Console.Error.WriteLine(failure.Message);
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("reachable helpers and members preserve resource identity", () => {
  let source = changed(
    golden.source,
    `ArmOperation<StorageAccountResource> createOperation =
        await accounts.CreateOrUpdateAsync(
            WaitUntil.Completed,
            accountName,
            content);
    StorageAccountResource created = createOperation.Value;`,
    `StorageAccountResource created =
        await CreateAccountAsync(accounts, accountName, content);`,
  );
  source += `
static async Task<StorageAccountResource> CreateAccountAsync(
    StorageAccountCollection accounts,
    string name,
    StorageAccountCreateOrUpdateContent content)
{
    ArmOperation<StorageAccountResource> operation =
        await accounts.CreateOrUpdateAsync(
            WaitUntil.Completed, name, content);
    return operation.Value;
}`;
  assert.equal(
    evaluateRule("prompt/delete-storage-account", workspace(source)),
    true,
  );

  const normalized = golden.source.replaceAll("\r\n", "\n");
  const bodyStart = normalized.indexOf("string subscriptionId");
  const memberSource = `${normalized.slice(0, bodyStart)}
var workflow = new StorageWorkflow();
await workflow.RunAsync();

sealed class StorageWorkflow
{
    public async Task RunAsync()
    {
${normalized.slice(bodyStart).replaceAll(/^/gm, "        ")}
    }
}`;
  assert.equal(
    evaluateRule("prompt/delete-storage-account", workspace(memberSource)),
    true,
  );

  const decoy = changed(
    golden.source,
    "try\r\n{",
    "if (false)\r\n{\r\n",
  );
  assert.equal(
    evaluateRule("prompt/create-storage-account", workspace(decoy)),
    false,
  );
});

test.skip("unqualified local fakes and code-shaped comments do not pass", () => {
  const fakeTypes = `
using Azure;
using Azure.Identity;
using Azure.ResourceManager;
sealed class ArmClient
{
    public ArmClient(object credential, string subscriptionId) {}
}
sealed class DefaultAzureCredential {}
${golden.source
    .replace("using Azure;", "")
    .replace("using Azure.Identity;", "")
    .replace("using Azure.ResourceManager;", "")}`;
  assert.equal(
    evaluateRule("prompt/credential-arm-client", workspace(fakeTypes)),
    false,
  );

  const comments = `
// new DefaultAzureCredential();
// await accounts.CreateOrUpdateAsync(WaitUntil.Completed, accountName, data);
Console.WriteLine("GetAsync IsVersioningEnabled Standard_LRS StorageV2");`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(comments)), false, rule);
  }
});

test.skip("all reachable catch paths are causal and request failures are diagnostic", () => {
  const swallowed = changed(
    golden.source,
    "catch (RequestFailedException exception)",
    `catch (InvalidOperationException)
{
}
catch (RequestFailedException exception)`,
  );
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(swallowed)),
    false,
  );

  const causal = changed(
    golden.source,
    "catch (RequestFailedException exception)",
    `catch (InvalidOperationException exception)
{
    throw new ApplicationException("Unexpected storage failure", exception);
}
catch (RequestFailedException exception)`,
  );
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(causal)),
    true,
  );

  const hardcoded = changed(
    golden.source,
    `Console.Error.WriteLine(
        $"Azure Storage management request failed " +
        $"({exception.Status}, {exception.ErrorCode}): {exception.Message}");`,
    'Console.Error.WriteLine("Storage failed");',
  );
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(hardcoded)),
    false,
  );
});
