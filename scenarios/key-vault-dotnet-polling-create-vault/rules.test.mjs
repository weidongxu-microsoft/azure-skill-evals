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
} from "./tools/key-vault-dotnet-polling-rules.mjs";

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
  keyVault = "1.4.0",
  secrets = "4.11.0",
  target = "net8.0",
} = {}) {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${target}</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="${identity}" />
    <PackageReference Include="Azure.ResourceManager.KeyVault"
                      Version="${keyVault}" />
    <PackageReference Include="Azure.Security.KeyVault.Secrets"
                      Version="${secrets}" />
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

test("golden passes eight prompt rules and all shared .NET checks", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, sharedGolden), true, check);
  }
});

test("manifest requires one runnable net8 project with exact stable pins", () => {
  const propertyManaged = manifest()
    .replace(
      "<TargetFramework>net8.0</TargetFramework>",
      "<NetTarget>net8.0</NetTarget><TargetFramework>$(NetTarget)</TargetFramework>",
    )
    .replace('Version="1.21.0"', 'Version="[1.21.0]"');
  assert.equal(
    evaluateRule(
      "prompt/key-vault-manifest",
      workspace(golden.source, propertyManaged),
    ),
    true,
  );

  const invalid = [
    manifest({ target: "net7.0" }),
    manifest({ identity: "1.20.0" }),
    manifest({ keyVault: "1.3.2" }),
    manifest({ keyVault: "1.*" }),
    manifest({ secrets: "[4.11.0,)" }),
    manifest().replace("<OutputType>Exe</OutputType>", ""),
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<PackageReference Include="Azure.Identity" Version="1.21.0" Condition="false" />',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.ResourceManager.KeyVault"\n                      Version="1.4.0" />',
      '<!-- <PackageReference Include="Azure.ResourceManager.KeyVault" Version="1.4.0" /> -->',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.Security.KeyVault.Secrets"\n                      Version="4.11.0" />',
      '<PackageReference Include="Azure.Security.KeyVault.Secrets" Version="4.11.0" ExcludeAssets="compile" />',
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
        "prompt/key-vault-manifest",
        workspace(golden.source, project),
      ),
      false,
      project,
    );
  }
});

test("focused golden omissions fail their own criteria", () => {
  const source = golden.source.replaceAll("\r\n", "\n");
  const cases = [
    [
      "prompt/key-vault-manifest",
      source,
      golden.project.replace("1.4.0", "1.3.2"),
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
      "prompt/vault-security-content",
      source.replace("EnablePurgeProtection = true", "EnablePurgeProtection = false"),
      golden.project,
    ],
    [
      "prompt/create-started-operation",
      source.replace("WaitUntil.Started", "WaitUntil.Completed"),
      golden.project,
    ],
    [
      "prompt/exact-operation-completion",
      source.replace(
        "await createOperation.WaitForCompletionAsync();",
        "await unrelatedOperation.WaitForCompletionAsync();",
      ),
      golden.project,
    ],
    [
      "prompt/connected-secret-client",
      source.replace(
        "createdVault.Data.Properties.VaultUri",
        'new Uri("https://unrelated.vault.azure.net")',
      ),
      golden.project,
    ],
    [
      "prompt/created-vault-output",
      source.replace("createdVault.Data.Name", "vaultName"),
      golden.project,
    ],
    [
      "prompt/request-failed-error",
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

test("aliases, target-typed constructors, and reachable helpers pass", () => {
  const source = `
using Azure;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.KeyVault;
using Azure.ResourceManager.KeyVault.Models;
using Azure.ResourceManager.Resources;
using Azure.Security.KeyVault.Secrets;

string subscriptionId = Environment.GetEnvironmentVariable("AZURE_SUBSCRIPTION_ID")!;
string groupName = Environment.GetEnvironmentVariable("AZURE_RESOURCE_GROUP_NAME")!;
string vaultName = Environment.GetEnvironmentVariable("AZURE_KEY_VAULT_NAME")!;
Guid tenant = Guid.Parse(Environment.GetEnvironmentVariable("AZURE_TENANT_ID")!);
string location = Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus";
DefaultAzureCredential identity = new();
await CreateAsync(identity, subscriptionId, groupName, vaultName, tenant, location);

static async Task CreateAsync(
    DefaultAzureCredential credential,
    string subscriptionId,
    string groupName,
    string vaultName,
    Guid tenant,
    string location)
{
    ArmClient client = new(credential, subscriptionId);
    try
    {
        SubscriptionResource subscription =
            await client.GetDefaultSubscriptionAsync();
        ResourceGroupCollection groups = subscription.GetResourceGroups();
        ResourceGroupResource group = (await groups.GetAsync(groupName)).Value;
        KeyVaultCollection collection = group.GetKeyVaults();
        KeyVaultSku sku = new(KeyVaultSkuFamily.A, KeyVaultSkuName.Standard);
        KeyVaultProperties properties = new(tenant, sku);
        properties.EnableRbacAuthorization = true;
        properties.EnableSoftDelete = true;
        properties.EnablePurgeProtection = true;
        KeyVaultCreateOrUpdateContent request = new(location, properties);
        ArmOperation<KeyVaultResource> pending =
            await collection.CreateOrUpdateAsync(
                WaitUntil.Started, vaultName, request);
        Response<KeyVaultResource> completion =
            await pending.WaitForCompletionAsync().ConfigureAwait(false);
        KeyVaultResource vault = completion.Value;
        Uri endpoint = vault.Data.Properties.VaultUri;
        SecretClient secrets = new(endpoint, credential);
        Console.WriteLine(vault.Data.Name);
        Console.WriteLine(secrets.VaultUri);
    }
    catch (RequestFailedException failure)
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

test("completion must await the exact started operation before using Value", () => {
  const source = golden.source.replaceAll("\r\n", "\n");
  const invalid = [
    source.replace("WaitUntil.Started", "WaitUntil.Completed"),
    source.replace(
      "await createOperation.WaitForCompletionAsync();",
      "createOperation.WaitForCompletionAsync();",
    ),
    source.replace(
      "await createOperation.WaitForCompletionAsync();",
      "await other.WaitForCompletionAsync();",
    ),
    source.replace(
      "await createOperation.WaitForCompletionAsync();\n    KeyVaultResource createdVault = createOperation.Value;",
      "KeyVaultResource createdVault = createOperation.Value;\n    await createOperation.WaitForCompletionAsync();",
    ),
  ];

  for (const candidate of invalid) {
    assert.equal(
      evaluateRule("prompt/exact-operation-completion", workspace(candidate)),
      false,
      candidate,
    );
    assert.equal(
      evaluateRule("prompt/connected-secret-client", workspace(candidate)),
      false,
      candidate,
    );
  }
});

test("comments, strings, local SDK fakes, and unreachable helpers fail", () => {
  const minimal = `
using Azure;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.KeyVault;
using Azure.ResourceManager.KeyVault.Models;
using Azure.ResourceManager.Resources;
using Azure.Security.KeyVault.Secrets;
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
class KeyVaultCollection {}
class KeyVaultResource {}
class KeyVaultProperties {}
class KeyVaultCreateOrUpdateContent {}
class SecretClient {}`,
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
      (name) => name !== "prompt/key-vault-manifest",
    )) {
      assert.equal(
        evaluateRule(rule, workspace(candidate)),
        false,
        `${index}:${rule}`,
      );
    }
  });
});

test("disconnected credentials, resources, and content cannot combine", () => {
  const source = golden.source.replaceAll("\r\n", "\n");
  const wrongCredential = source
    .replace(
      "var armClient = new ArmClient(credential, subscriptionId);",
      `var armClient = new ArmClient(credential, subscriptionId);
var otherCredential = new DefaultAzureCredential();`,
    )
    .replace(
      "createdVault.Data.Properties.VaultUri,\n        credential",
      "createdVault.Data.Properties.VaultUri,\n        otherCredential",
    );
  assert.equal(
    evaluateRule("prompt/connected-secret-client", workspace(wrongCredential)),
    false,
  );

  const wrongContent = source
    .replace(
      "var content = new KeyVaultCreateOrUpdateContent(location, properties);",
      `var content = new KeyVaultCreateOrUpdateContent(location, properties);
var unsafeProperties = new KeyVaultProperties(tenantId, sku);
var unsafeContent = new KeyVaultCreateOrUpdateContent(location, unsafeProperties);`,
    )
    .replace(
      "vaultName,\n            content",
      "vaultName,\n            unsafeContent",
    );
  assert.equal(
    evaluateRule("prompt/vault-security-content", workspace(wrongContent)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/create-started-operation", workspace(wrongContent)),
    false,
  );

  const unrelatedVault = source
    .replace(
      "KeyVaultResource createdVault = createOperation.Value;",
      `KeyVaultResource createdVault = createOperation.Value;
KeyVaultResource otherVault = unrelatedOperation.Value;`,
    )
    .replace(
      "createdVault.Data.Properties.VaultUri",
      "otherVault.Data.Properties.VaultUri",
    );
  assert.equal(
    evaluateRule("prompt/connected-secret-client", workspace(unrelatedVault)),
    false,
  );
});

test("resource path inputs cannot be substituted with incompatible values", () => {
  const source = golden.source.replaceAll("\r\n", "\n");
  const invalid = [
    [
      "prompt/credential-resource-path",
      source.replace("GetAsync(resourceGroupName)", "GetAsync(subscriptionId)"),
    ],
    [
      "prompt/vault-security-content",
      source.replace(
        "new KeyVaultProperties(tenantId, sku)",
        "new KeyVaultProperties(Guid.Parse(resourceGroupName), sku)",
      ),
    ],
    [
      "prompt/vault-security-content",
      source.replace(
        "new KeyVaultCreateOrUpdateContent(location, properties)",
        "new KeyVaultCreateOrUpdateContent(resourceGroupName, properties)",
      ),
    ],
    [
      "prompt/create-started-operation",
      source.replace(
        "vaultName,\n            content",
        "resourceGroupName,\n            content",
      ),
    ],
  ];

  for (const [rule, candidate] of invalid) {
    assert.equal(evaluateRule(rule, workspace(candidate)), false, rule);
  }
});

test("manifest and source evidence cannot be assembled across projects", () => {
  const split = {
    ...golden,
    projects: [
      {
        path: "App/App.csproj",
        project: manifest().replace(
          '<PackageReference Include="Azure.ResourceManager.KeyVault"\n                      Version="1.4.0" />',
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
