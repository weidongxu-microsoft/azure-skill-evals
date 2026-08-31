import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadDotnetWorkspace } from "../../languages/dotnet/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/identity-dotnet-managed-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadDotnetWorkspace(goldenRoot);
const baseline33374429826 = loadDotnetWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33374429826", import.meta.url),
  ),
);
const sourceRules = ruleNames().filter(
  (name) => name !== "prompt/identity-packages",
);

function workspace(source, project = completeWorkspace.project) {
  return { ...completeWorkspace, source, project };
}

function projectManifest({
  target = "<TargetFramework>net8.0</TargetFramework>",
  identityVersion = "1.21.0",
  blobsVersion = "12.29.2",
} = {}) {
  const packageReference = (name, version) =>
    version === null
      ? `<PackageReference Include="${name}" />`
      : `<PackageReference Include="${name}" Version="${version}" />`;
  return `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>${target}</PropertyGroup>
  <ItemGroup>
    ${packageReference("Azure.Identity", identityVersion)}
    ${packageReference("Azure.Storage.Blobs", blobsVersion)}
  </ItemGroup>
</Project>`;
}

test("managed identity golden passes every criterion", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("baseline run 33374429826 exact output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
});

test("package grading accepts exact attribute and child versions", () => {
  const manifests = [
    projectManifest(),
    `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0-windows</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Version="[1.21.0]" Include="Azure.Identity" />
    <PackageReference Include='Azure.Storage.Blobs'>
      <Version>[12.29.2]</Version>
    </PackageReference>
  </ItemGroup>
</Project>`,
  ];

  for (const project of manifests) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class App {}", project),
      ),
      true,
    );
  }
});

test("package grading resolves same-project properties", () => {
  const project = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <BaseTfm>net8.0</BaseTfm>
    <TargetFramework>$(BaseTfm)</TargetFramework>
    <IdentityVersion>1.21.0</IdentityVersion>
    <BlobPatch>29.2</BlobPatch>
    <BlobVersion>12.$(BlobPatch)</BlobVersion>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Identity"
                      Version="$(IdentityVersion)" />
    <PackageReference Include="Azure.Storage.Blobs">
      <Version>[$(BlobVersion)]</Version>
    </PackageReference>
  </ItemGroup>
</Project>`;

  assert.equal(
    evaluateRule("prompt/identity-packages", workspace("class App {}", project)),
    true,
  );
});

test("package grading accepts a net8 entry in TargetFrameworks", () => {
  const project = projectManifest({
    target: `
      <TargetFrameworks>
        net6.0 ; net8.0-windows10.0.19041.0
      </TargetFrameworks>`,
  });

  assert.equal(
    evaluateRule("prompt/identity-packages", workspace("class App {}", project)),
    true,
  );
});

test("package grading requires a resolvable net8 target", () => {
  const invalidTargets = [
    "<TargetFramework>net6.0</TargetFramework>",
    "<TargetFrameworks>net6.0;net7.0</TargetFrameworks>",
    "",
    "<TargetFramework>$(MissingTarget)</TargetFramework>",
    "<TargetFramework>net8.0-</TargetFramework>",
  ];

  for (const target of invalidTargets) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class App {}", projectManifest({ target })),
      ),
      false,
      target,
    );
  }
});

test("package grading rejects missing or unresolved versions", () => {
  const invalid = [
    { identityVersion: null },
    { blobsVersion: null },
    { identityVersion: "$(IdentityVersion)" },
    { blobsVersion: "$(BlobVersion)" },
  ];

  for (const versions of invalid) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class App {}", projectManifest(versions)),
      ),
      false,
      JSON.stringify(versions),
    );
  }
});

test("package grading rejects inexact package versions", () => {
  const invalid = [
    { identityVersion: "1.0.0" },
    { identityVersion: "[1.21.0,)" },
    { identityVersion: "1.*" },
    { identityVersion: "(1.0.0,2.0.0)" },
    { identityVersion: "1.22.0" },
    { blobsVersion: "1.0.0" },
    { blobsVersion: "[12.29.2,)" },
    { blobsVersion: "12.*" },
    { blobsVersion: "(12.0.0,13.0.0)" },
    { blobsVersion: "12.30.0" },
  ];

  for (const versions of invalid) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class App {}", projectManifest(versions)),
      ),
      false,
      JSON.stringify(versions),
    );
  }
});

test("package grading ignores XML comments and project boundaries", () => {
  const commentOnlyPackages = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <!-- <PackageReference Include="Azure.Identity" Version="1.21.0" /> -->
    <!-- <PackageReference Include="Azure.Storage.Blobs" Version="12.29.2" /> -->
  </ItemGroup>
</Project>`;
  const commentOnlyTarget = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <!-- <TargetFramework>net8.0</TargetFramework> -->
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="1.21.0" />
    <PackageReference Include="Azure.Storage.Blobs" Version="12.29.2" />
  </ItemGroup>
</Project>`;
  const splitAcrossProjects = `
${projectManifest({ blobsVersion: null })}
${projectManifest({ identityVersion: null })}`;
  const crossProjectProperties = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <IdentityVersion>1.21.0</IdentityVersion>
    <BlobVersion>12.29.2</BlobVersion>
  </PropertyGroup>
</Project>
${projectManifest({
    identityVersion: "$(IdentityVersion)",
    blobsVersion: "$(BlobVersion)",
  })}`;

  for (const project of [
    commentOnlyPackages,
    commentOnlyTarget,
    splitAcrossProjects,
    crossProjectProperties,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class App {}", project),
      ),
      false,
    );
  }

  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace(
        "class App {}",
        `${projectManifest({ target: "<TargetFramework>net6.0</TargetFramework>" })}
         ${projectManifest()}`,
      ),
    ),
    true,
  );
});

test("focused golden omissions fail their criterion", () => {
  const cases = [
    {
      rule: "prompt/identity-packages",
      source: completeWorkspace.source,
      project: completeWorkspace.project.replace(
        'Include="Azure.Identity"',
        'Include="Contoso.Identity"',
      ),
    },
    {
      rule: "prompt/system-assigned-credential",
      source: completeWorkspace.source.replace(
        "new ManagedIdentityCredential(ManagedIdentityId.SystemAssigned);",
        "CreateSystemCredential();",
      ),
    },
    {
      rule: "prompt/user-assigned-credential",
      source: completeWorkspace.source.replace(
        "ManagedIdentityId.FromUserAssignedClientId(clientId)",
        'ManagedIdentityId.FromUserAssignedClientId("hard-coded")',
      ),
    },
    {
      rule: "prompt/default-azure-credential",
      source: completeWorkspace.source.replace(
        "ManagedIdentityClientId = clientId",
        'ManagedIdentityClientId = "hard-coded"',
      ),
    },
    {
      rule: "prompt/local-fallback-chain",
      source: completeWorkspace.source.replace(
        /userAssignedCredential,\r?\n\s+new AzureCliCredential\(\)/,
        "new AzureCliCredential(),\n    userAssignedCredential",
      ),
    },
    {
      rule: "prompt/credential-client-association",
      source: completeWorkspace.source.replace(
        "new BlobServiceClient(new Uri(endpoint), localFallbackCredential)",
        "new BlobServiceClient(new Uri(endpoint))",
      ),
    },
    {
      rule: "prompt/authenticated-operation",
      source: completeWorkspace.source.replace(
        'Console.WriteLine($"SKU: {response.Value.SkuName}");',
        'Console.WriteLine("account read");',
      ),
    },
    {
      rule: "prompt/credential-unavailable-error",
      source: completeWorkspace.source.replace(
        "catch (CredentialUnavailableException exception)",
        "catch (Exception exception)",
      ),
    },
  ];

  for (const { rule, source, project = completeWorkspace.project } of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test("qualified aliases, target typing, and bound options are accepted", () => {
  const source = `
using MI = Azure.Identity.ManagedIdentityCredential;
using MIID = Azure.Identity.ManagedIdentityId;
using Identity = Azure.Identity;
using Core = Azure.Core;
using Blobs = Azure.Storage.Blobs;

string clientId = System.Environment.GetEnvironmentVariable("AZURE_CLIENT_ID")
    ?? throw new InvalidOperationException();
var endpoint = System.Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
MI system = new(MIID.SystemAssigned);
var userId = MIID.FromUserAssignedClientId(clientId);
MI user = new(userId);
Identity.DefaultAzureCredentialOptions options = new();
options.ManagedIdentityClientId = clientId;
options.ExcludeManagedIdentityCredential = false;
Identity.DefaultAzureCredential dac = new(options);
Core.TokenCredential fallback = new Core.ChainedTokenCredential(
    user,
    new Identity.AzureCliCredential());
Blobs.BlobServiceClient client = new(new Uri(endpoint), fallback);
try
{
    Azure.Response<Azure.Storage.Blobs.Models.AccountInfo> result =
        await client.GetAccountInfoAsync();
    var account = result.Value;
    var kind = account.AccountKind;
    var sku = account.SkuName;
    Console.WriteLine(kind);
    Console.WriteLine(sku);
}
catch (Identity.CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}`;

  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("inline and array-backed current credential forms are accepted", () => {
  const sources = [
    `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var system = new ManagedIdentityCredential(ManagedIdentityId.SystemAssigned);
var user = new ManagedIdentityCredential(clientId);
var options = new DefaultAzureCredentialOptions
{
    ManagedIdentityClientId = clientId
};
var dac = new DefaultAzureCredential(options);
var cli = new AzureCliCredential();
var chain = new ChainedTokenCredential(
    new TokenCredential[] { user, cli });
var client = new BlobServiceClient(new Uri(endpoint), chain);
try
{
    Console.WriteLine((await client.GetAccountInfoAsync()).Value.AccountKind);
    Console.WriteLine((await client.GetAccountInfoAsync()).Value.SkuName);
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}`,
    `
string clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
ManagedIdentityCredential system = new();
ManagedIdentityCredential user = new(
    ManagedIdentityId.FromUserAssignedClientId(clientId));
var dac = new DefaultAzureCredential(
    new DefaultAzureCredentialOptions
    {
        ManagedIdentityClientId = clientId,
    });
TokenCredential chain = new ChainedTokenCredential(
    [user, new AzureCliCredential()]);
BlobServiceClient client = new(new Uri(endpoint), chain);
try
{
    var response = await client.GetAccountInfoAsync();
    Console.WriteLine(response.Value.AccountKind);
    Console.WriteLine(response.Value.SkuName);
}
catch (CredentialUnavailableException unavailable)
{
    Console.WriteLine(unavailable.ToString());
}`,
  ];

  for (const source of sources) {
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, workspace(source)), true, rule);
    }
  }
});

test("fallback chain order and connected credential types are enforced", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var managed = new ManagedIdentityCredential(clientId);
var cli = new AzureCliCredential();`;
  const invalid = [
    `${prefix}
var chain = new ChainedTokenCredential(cli, managed);`,
    `${prefix}
var chain = new ChainedTokenCredential(otherCredential, cli);`,
    `${prefix}
var credentials = new TokenCredential[] { managed, cli };
var chain = new ChainedTokenCredential(otherCredentials);`,
    `${prefix}
{
    var managed = otherCredential;
    var chain = new ChainedTokenCredential(managed, cli);
}`,
  ];

  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/local-fallback-chain", workspace(source)),
      false,
    );
  }
});

test("a bound credential array preserves fallback order", () => {
  const source = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var managed = new ManagedIdentityCredential(clientId);
var cli = new AzureCliCredential();
TokenCredential[] credentials = [managed, cli];
var chain = new ChainedTokenCredential(credentials);`;

  assert.equal(
    evaluateRule("prompt/local-fallback-chain", workspace(source)),
    true,
  );
});

test("default credential requires its connected options and enabled managed identity", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");`;
  const invalid = [
    `${prefix}
var configured = new DefaultAzureCredentialOptions {
    ManagedIdentityClientId = clientId
};
var credential = new DefaultAzureCredential();`,
    `${prefix}
var options = new DefaultAzureCredentialOptions();
options.ManagedIdentityClientId = clientId;
options.ManagedIdentityClientId = otherClientId;
var credential = new DefaultAzureCredential(options);`,
    `${prefix}
var options = new DefaultAzureCredentialOptions {
    ManagedIdentityClientId = clientId,
    ExcludeManagedIdentityCredential = true
};
var credential = new DefaultAzureCredential(options);`,
    `${prefix}
var options = new DefaultAzureCredentialOptions {
    ManagedIdentityClientId = clientId
};
{
    var options = new DefaultAzureCredentialOptions();
    var credential = new DefaultAzureCredential(options);
}`,
  ];

  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/default-azure-credential", workspace(source)),
      false,
    );
  }
});

test("wrong environment variables and string decoys do not create user identity", () => {
  const source = `
var clientId = Environment.GetEnvironmentVariable("OTHER_CLIENT_ID");
string decoy = """
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var user = new ManagedIdentityCredential(clientId);
""";
var user = new ManagedIdentityCredential(clientId);`;

  assert.equal(
    evaluateRule("prompt/user-assigned-credential", workspace(source)),
    false,
  );
});

test("environment provenance rejects literal fallback values", () => {
  const literalClientId = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID")
    ?? "00000000-0000-0000-0000-000000000000";
var user = new ManagedIdentityCredential(clientId);`;
  const literalEndpoint = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT") ?? "https://example.blob.core.windows.net";
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);`;

  assert.equal(
    evaluateRule("prompt/user-assigned-credential", workspace(literalClientId)),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      workspace(literalEndpoint),
    ),
    false,
  );
});

test("environment provenance accepts direct, aliased, and throwing reads", () => {
  const source = `
using Env = System.Environment;
var rawClientId = Env.GetEnvironmentVariable("AZURE_CLIENT_ID")
    ?? throw new InvalidOperationException();
var clientId = rawClientId;
var rawEndpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT")
    ?? throw new InvalidOperationException();
var endpoint = rawEndpoint;
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);`;

  assert.equal(
    evaluateRule("prompt/user-assigned-credential", workspace(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(source)),
    true,
  );
});

test("absolute Uri.TryCreate out variables preserve endpoint provenance", () => {
  const source = `
using Azure.Identity;
using Azure.Storage.Blobs;

var endpointValue = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
if (!Uri.TryCreate(endpointValue, UriKind.Absolute, out Uri? endpoint))
{
    throw new InvalidOperationException();
}
var credential = new ManagedIdentityCredential();
var client = new BlobServiceClient(endpoint, credential);
try
{
    var response = await client.GetAccountInfoAsync();
    Console.WriteLine(response.Value.AccountKind);
    Console.WriteLine(response.Value.SkuName);
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}`;

  for (const rule of [
    "prompt/credential-client-association",
    "prompt/authenticated-operation",
    "prompt/credential-unavailable-error",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("relative and disconnected Uri.TryCreate outputs are rejected", () => {
  const prefix = `
using Azure.Identity;
using Azure.Storage.Blobs;
var endpointValue = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential();
`;
  const invalid = [
    `${prefix}
Uri.TryCreate(endpointValue, UriKind.Relative, out Uri? endpoint);
var client = new BlobServiceClient(endpoint, credential);`,
    `${prefix}
Uri.TryCreate(endpointValue, UriKind.Absolute, out Uri? parsedEndpoint);
var client = new BlobServiceClient(endpoint, credential);`,
  ];

  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/credential-client-association", workspace(source)),
      false,
    );
  }
});

test("managed identity exclusion follows boolean bindings and source order", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");`;
  const invalid = [
    `${prefix}
var excluded = true;
var options = new DefaultAzureCredentialOptions {
    ManagedIdentityClientId = clientId,
    ExcludeManagedIdentityCredential = excluded
};
var credential = new DefaultAzureCredential(options);`,
    `${prefix}
var excluded = false;
excluded = true;
var options = new DefaultAzureCredentialOptions();
options.ManagedIdentityClientId = clientId;
options.ExcludeManagedIdentityCredential = excluded;
var credential = new DefaultAzureCredential(options);`,
    `${prefix}
var excluded = GetExclusionSetting();
var options = new DefaultAzureCredentialOptions {
    ManagedIdentityClientId = clientId,
    ExcludeManagedIdentityCredential = excluded
};
var credential = new DefaultAzureCredential(options);`,
    `${prefix}
var options = new DefaultAzureCredentialOptions {
    ManagedIdentityClientId = clientId
};
var alias = options;
alias.ExcludeManagedIdentityCredential = true;
var credential = new DefaultAzureCredential(options);`,
  ];

  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/default-azure-credential", workspace(source)),
      false,
    );
  }

  const valid = [
    `${prefix}
var options = new DefaultAzureCredentialOptions {
    ManagedIdentityClientId = clientId
};
var credential = new DefaultAzureCredential(options);`,
    `${prefix}
var excluded = false;
var options = new DefaultAzureCredentialOptions {
    ManagedIdentityClientId = clientId,
    ExcludeManagedIdentityCredential = excluded
};
var credential = new DefaultAzureCredential(options);`,
    `${prefix}
var excluded = true;
excluded = false;
var options = new DefaultAzureCredentialOptions();
var alias = options;
alias.ManagedIdentityClientId = clientId;
alias.ExcludeManagedIdentityCredential = excluded;
var credential = new DefaultAzureCredential(options);`,
    `${prefix}
var options = new DefaultAzureCredentialOptions {
    ManagedIdentityClientId = clientId,
    ExcludeManagedIdentityCredential = true
};
var alias = options;
alias.ExcludeManagedIdentityCredential = false;
var credential = new DefaultAzureCredential(options);`,
  ];

  for (const source of valid) {
    assert.equal(
      evaluateRule("prompt/default-azure-credential", workspace(source)),
      true,
    );
  }
});

test("credential and client provenance follows source order and lexical scope", () => {
  const invalid = [
    `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
credential = otherCredential;
var client = new BlobServiceClient(new Uri(endpoint), credential);`,
    `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
{
    var credential = otherCredential;
    var client = new BlobServiceClient(new Uri(endpoint), credential);
}`,
    `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);
client = new BlobServiceClient(new Uri(endpoint), otherCredential);
var response = await client.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`,
    `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable("OTHER_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);`,
  ];

  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(invalid[0])),
    false,
  );
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(invalid[1])),
    false,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(invalid[2])),
    false,
  );
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(invalid[3])),
    false,
  );
});

test("authenticated operation requires awaited associated results and both outputs", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);`;
  const invalid = [
    `${prefix}
var response = client.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`,
    `${prefix}
var other = new BlobServiceClient(new Uri(endpoint), otherCredential);
var response = await other.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`,
    `${prefix}
var response = await client.GetAccountInfoAsync();
response = await other.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`,
    `${prefix}
var response = await client.GetAccountInfoAsync();
var account = response.Value;
{
    var account = otherAccount;
    Console.WriteLine(account.AccountKind);
    Console.WriteLine(account.SkuName);
}`,
    `${prefix}
await client.GetAccountInfoAsync();
Console.WriteLine("AccountKind and SkuName");`,
  ];

  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
    );
  }
});

test("unavailable handling must protect an awaited authenticated operation", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);`;
  const invalid = [
    `${prefix}
try { client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}`,
    `${prefix}
try { await other.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}`,
    `${prefix}
try { await client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable) { }`,
    `${prefix}
try { await client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine("credential unavailable");
}`,
    `${prefix}
try { await client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    var details = unavailable.Message;
    Console.Error.WriteLine("credential unavailable");
}`,
    `${prefix}
try { await client.GetAccountInfoAsync(); }
catch (Exception exception)
{
    Console.Error.WriteLine(exception.Message);
}`,
    `${prefix}
try { await client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}
catch
{
    Console.Error.WriteLine("ignored");
}`,
  ];

  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      false,
    );
  }
});

test("a broad catch that rethrows does not swallow unrelated errors", () => {
  const source = `
using Identity = Azure.Identity;
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try
{
    await (client.GetAccountInfoAsync());
}
catch (Identity.CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}
catch (System.Exception)
{
    throw;
}`;

  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", workspace(source)),
    true,
  );
});

test("typed and instance member clients preserve authenticated provenance", () => {
  const sources = [
    `
using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;

sealed class StorageProbe
{
    private BlobServiceClient _client;

    public StorageProbe()
    {
        var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
        var endpoint = Environment.GetEnvironmentVariable(
            "AZURE_STORAGE_BLOB_ENDPOINT");
        var system = new ManagedIdentityCredential(
            ManagedIdentityId.SystemAssigned);
        var user = new ManagedIdentityCredential(
            ManagedIdentityId.FromUserAssignedClientId(clientId));
        var dac = new DefaultAzureCredential(
            new DefaultAzureCredentialOptions
            {
                ManagedIdentityClientId = clientId,
            });
        TokenCredential chain = new ChainedTokenCredential(
            user, new AzureCliCredential());
        this._client = new BlobServiceClient(new Uri(endpoint), chain);
    }

    public async Task RunAsync()
    {
        try
        {
            var account =
                (await this._client.GetAccountInfoAsync()).Value;
            Console.WriteLine(account.AccountKind);
            Console.WriteLine(account.SkuName);
        }
        catch (CredentialUnavailableException unavailable)
        {
            System.Console.Error.WriteLine(unavailable.Message);
        }
    }
}`,
    `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var system = new ManagedIdentityCredential(ManagedIdentityId.SystemAssigned);
var user = new ManagedIdentityCredential(clientId);
var dac = new DefaultAzureCredential(
    new DefaultAzureCredentialOptions {
        ManagedIdentityClientId = clientId
    });
var chain = new ChainedTokenCredential(user, new AzureCliCredential());
var holder = new ClientHolder();
holder.Client = new BlobServiceClient(new Uri(endpoint), chain);
try
{
    Console.WriteLine(
        (await holder.Client.GetAccountInfoAsync()).Value.AccountKind);
    Console.WriteLine(
        (await holder.Client.GetAccountInfoAsync()).Value.SkuName);
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}

sealed class ClientHolder
{
    public BlobServiceClient Client { get; set; }
}`,
  ];

  for (const source of sources) {
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, workspace(source)), true, rule);
    }
  }
});

test("member-client reassignment invalidates provenance in source order", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var holder = new ClientHolder();
holder.Client = new BlobServiceClient(new Uri(endpoint), credential);`;
  const overwritten = `${prefix}
holder.Client = new BlobServiceClient(new Uri(endpoint), otherCredential);
var response = await holder.Client.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`;
  const restored = `${prefix}
holder.Client = new BlobServiceClient(new Uri(endpoint), otherCredential);
holder.Client = new BlobServiceClient(new Uri(endpoint), credential);
var response = await holder.Client.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`;

  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(overwritten)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(restored)),
    true,
  );
});

test("all unrelated catches must propagate instead of swallowing failures", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try
{
    await client.GetAccountInfoAsync();
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}`;
  const swallowed = [
    `${prefix}
catch (RequestFailedException) { }`,
    `${prefix}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(failure.Message);
}`,
    `${prefix}
try { DoOtherWork(); }
catch (InvalidOperationException) { }`,
  ];

  for (const source of swallowed) {
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      false,
    );
  }

  const rethrown = `${prefix}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(failure.Message);
    throw;
}`;
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", workspace(rethrown)),
    true,
  );
});

test("catch handling accepts diagnostic and causal propagation only", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try
{
    await client.GetAccountInfoAsync();
}`;
  const accepted = [
    `${prefix}
catch (CredentialUnavailableException unavailable)
{
    throw;
}`,
    `${prefix}
catch (CredentialUnavailableException unavailable)
{
    throw new InvalidOperationException("Managed identity unavailable", unavailable);
}`,
    `${prefix}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}
catch (RequestFailedException failure)
{
    throw new InvalidOperationException("Storage request failed", failure);
}`,
  ];
  for (const source of accepted) {
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      true,
    );
  }

  const rejected = [
    `${prefix}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}
catch (RequestFailedException failure)
{
    throw new InvalidOperationException("Storage request failed");
}`,
    `${prefix}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}
catch (RequestFailedException failure)
{
    if (ShouldPropagate())
        throw;
}`,
  ];
  for (const source of rejected) {
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      false,
    );
  }
});

test("catch filters and every conditional path remain catch-safe", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try
{
    await client.GetAccountInfoAsync();
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}`;
  const unsafe = [
    `${prefix}
try { OtherWork(); }
catch (Exception failure) when (failure is RequestFailedException)
{
    Console.Error.WriteLine(failure.Message);
}`,
    `${prefix}
catch (RequestFailedException failure)
{
    if (ShouldPropagate())
        throw;
}`,
    `${prefix}
catch (RequestFailedException failure)
{
    throw new InvalidOperationException("replacement");
}`,
    `${prefix}
try { OtherWork(); }
catch (RequestFailedException failure)
{
    return;
}`,
    `${prefix}
try { OtherWork(); }
catch (RequestFailedException failure)
{
    try { Recover(); }
    catch (InvalidOperationException nested)
    {
        Console.Error.WriteLine(nested.Message);
    }
    throw failure;
}`,
  ];
  for (const source of unsafe) {
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      false,
      source,
    );
  }

  const safe = [
    `${prefix}
catch (RequestFailedException)
{
    throw;
}`,
    `${prefix}
catch (RequestFailedException failure)
{
    if (ShouldWrap())
        throw new InvalidOperationException("wrapped", failure);
    else
        throw failure;
}`,
    `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try
{
    await client.GetAccountInfoAsync();
}
catch (Exception failure)
    when (failure is CredentialUnavailableException)
{
    throw failure;
}`,
  ];
  for (const source of safe) {
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      true,
      source,
    );
  }
});

test("C# loop paths cannot hide unsafe catch terminals", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try
{
    await client.GetAccountInfoAsync();
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}
try { OtherWork(); }
catch (RequestFailedException failure)
`;
  const unsafe = [
    `{ while (ShouldRetry()) { return; } throw failure; }`,
    `{ for (var i = 0; i < count; i++) {
         if (ShouldReturn(i)) return;
       }
       throw failure;
     }`,
    `{ for (var i = 0; i < count; i++) {
         if (IsBad(i)) throw new InvalidOperationException("replacement");
       }
       throw failure;
     }`,
    `{ foreach (var item in items)
         if (ShouldReturn(item)) return;
       throw failure;
     }`,
    `{ do { return; } while (false); throw failure; }`,
    `{ while (ShouldRetry()) {
         if (ShouldReturn()) { return; }
         break;
       }
       throw failure;
     }`,
    `{ retry: while (ShouldRetry()) { break retry; } throw failure; }`,
    `{ retry: while (ShouldRetry()) { continue retry; } throw failure; }`,
    `{ retry: while (ShouldRetry()) { goto retry; } throw failure; }`,
    `{ marker: if (ShouldRetry()) throw failure; throw failure; }`,
    `{ while (true) continue; }`,
  ];
  for (const handler of unsafe) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        workspace(`${prefix}${handler}`),
      ),
      false,
      handler,
    );
  }

  const safe = [
    `{ retry: while (ShouldRetry()) { break; } throw failure; }`,
    `{ outer: inner: while (ShouldRetry()) {
         break;
       }
       throw failure;
     }`,
    `{ while (ShouldRetry()) break; throw failure; }`,
    `{ for (var i = 0; i < count; i++) {
         if (ShouldStop(i)) throw failure;
       }
       throw failure;
     }`,
    `{ while (ShouldRetry()) {
         break;
         return;
       }
       throw failure;
     }`,
    `{ while (ShouldRetry()) {
         continue;
         throw new InvalidOperationException("replacement");
       }
       throw failure;
     }`,
    `{ while (false) return; throw failure; }`,
    `{ foreach (var item in items) break; throw failure; }`,
    `{ for (;;) { throw failure; } }`,
  ];
  for (const handler of safe) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        workspace(`${prefix}${handler}`),
      ),
      true,
      handler,
    );
  }
});

test("C# labels obey lexical block scopes regardless of source order", () => {
  const prefix = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try
{
    await client.GetAccountInfoAsync();
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}
try { OtherWork(); }
catch (RequestFailedException failure)
`;
  const rejected = [
    `{ retry: while (ShouldRetry()) {
         retry: while (ShouldRetry()) break;
         break;
       }
       throw failure;
     }`,
    `{ retry: while (ShouldRetry()) break;
       retry: while (ShouldRetry()) break;
       throw failure;
     }`,
    `{ {
         retry: while (ShouldRetry()) break;
       }
       retry: while (ShouldRetry()) break;
       throw failure;
     }`,
    `{ retry: while (ShouldRetry())
         if (ShouldNest())
           retry: while (ShouldRetry()) break;
       throw failure;
     }`,
    `{ throw failure; goto retry; }`,
  ];
  for (const handler of rejected) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        workspace(`${prefix}${handler}`),
      ),
      false,
      handler,
    );
  }

  const accepted = [
    `{ outer: while (ShouldRetry()) {
         inner: while (ShouldRetry()) break;
         break;
       }
       throw failure;
     }`,
    `{ {
         retry: while (ShouldRetry()) break;
       }
       {
         retry: while (ShouldRetry()) break;
       }
       throw failure;
     }`,
    `{ retry: while (ShouldRetry()) { break; } throw failure; }`,
  ];
  for (const handler of accepted) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        workspace(`${prefix}${handler}`),
      ),
      true,
      handler,
    );
  }
});

test("C# label scopes do not cross catch handlers in separate methods", () => {
  const source = `
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var credential = new ManagedIdentityCredential(clientId);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try
{
    await client.GetAccountInfoAsync();
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}

void First()
{
    try { OtherWork(); }
    catch (RequestFailedException first)
    {
        retry: while (ShouldRetry()) break;
        throw first;
    }
}

void Second()
{
    try { OtherWork(); }
    catch (RequestFailedException second)
    {
        retry: while (ShouldRetry()) break;
        throw second;
    }
}`;

  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", workspace(source)),
    true,
  );
});

test("comments, strings, and missing source cannot satisfy criteria", () => {
  const source = `
// var system = new ManagedIdentityCredential();
string prose = """
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var system = new ManagedIdentityCredential();
var user = new ManagedIdentityCredential(clientId);
var dac = new DefaultAzureCredential(
    new DefaultAzureCredentialOptions { ManagedIdentityClientId = clientId });
var chain = new ChainedTokenCredential(user, new AzureCliCredential());
var client = new BlobServiceClient(endpoint, chain);
try {
    var response = await client.GetAccountInfoAsync();
    Console.WriteLine(response.Value.AccountKind);
    Console.WriteLine(response.Value.SkuName);
} catch (CredentialUnavailableException unavailable) {
    Console.Error.WriteLine(unavailable.Message);
}
""";`;

  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
  }
});
