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
} from "./tools/identity-dotnet-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadDotnetWorkspace(goldenWorkspacePath);

test.skip(".NET Identity reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip(".NET Identity reference passes every language check", () => {
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, completeWorkspace), true, check);
  }
});

test.skip("active required package references pass package grading", () => {
  const project = `
<Project>
  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="1.21.0" />
    <PackageReference Include="Azure.Storage.Blobs" Version="12.29.2" />
  </ItemGroup>
</Project>
`;

  assert.equal(
    evaluateRule("prompt/identity-packages", {
      ...completeWorkspace,
      project,
    }),
    true,
  );
});

test.skip("commented-out package references do not satisfy package grading", () => {
  for (const packageName of ["Azure.Identity", "Azure.Storage.Blobs"]) {
    const project = completeWorkspace.project.replace(
      new RegExp(
        String.raw`(\s*)(<PackageReference\b[^>]*\bInclude="${packageName}"[^>]*/>)`,
      ),
      "$1<!-- $2 -->",
    );

    assert.equal(
      evaluateRule("prompt/identity-packages", {
        ...completeWorkspace,
        project,
      }),
      false,
      packageName,
    );
  }
});

test.skip("focused omissions fail each prompt rule", () => {
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
      rule: "prompt/default-azure-credential",
      source: completeWorkspace.source.replace(
        "new DefaultAzureCredential(",
        "CreateCredential(",
      ),
    },
    {
      rule: "prompt/credential-client-association",
      source: completeWorkspace.source.replace(
        "new BlobServiceClient(serviceUri, credential)",
        "new BlobServiceClient(serviceUri)",
      ),
    },
    {
      rule: "prompt/authenticated-operation",
      source: completeWorkspace.source.replace(
        "client.GetAccountInfoAsync()",
        "otherClient.GetAccountInfoAsync()",
      ),
    },
    {
      rule: "prompt/auth-errors",
      source: completeWorkspace.source.replace(
        "catch (AuthenticationFailedException exception)",
        "catch (Exception exception)",
      ),
    },
    {
      rule: "prompt/identity-diagnostics",
      source: completeWorkspace.source.replace(
        "AzureEventSourceListener.CreateConsoleLogger",
        "FakeDiagnostics.CreateConsoleLogger",
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

test.skip("qualified target-typed clients and credential options are accepted", () => {
  const source = `
using var listener =
    Azure.Core.Diagnostics.AzureEventSourceListener.CreateConsoleLogger(
        System.Diagnostics.Tracing.EventLevel.Verbose);
Azure.Identity.DefaultAzureCredential credential = new(
    new Azure.Identity.DefaultAzureCredentialOptions
    {
        ExcludeEnvironmentCredential = true,
    });
Azure.Storage.Blobs.BlobServiceClient client = new(serviceUri, credential);
try
{
    Azure.Response<Azure.Storage.Blobs.Models.AccountInfo> response =
        await client.GetAccountInfoAsync();
    Console.WriteLine(response.Value.AccountKind);
}
catch (Azure.Identity.CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable.Message);
}
catch (Azure.Identity.AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
`;

  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-packages",
  )) {
    assert.equal(evaluateRule(rule, { ...completeWorkspace, source }), true, rule);
  }
});

test.skip("inline credentials and direct async output are accepted", () => {
  const source = `
var client = new global::Azure.Storage.Blobs.BlobServiceClient(
    serviceUri,
    new global::Azure.Identity.DefaultAzureCredential());
Console.WriteLine((await client.GetAccountInfoAsync()).Value.SkuName);
`;

  assert.equal(
    evaluateRule("prompt/default-azure-credential", {
      ...completeWorkspace,
      source,
    }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/credential-client-association", {
      ...completeWorkspace,
      source,
    }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", {
      ...completeWorkspace,
      source,
    }),
    true,
  );
});

test.skip("an AccountInfo value may be extracted before printing", () => {
  const source = `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
AccountInfo account = (await client.GetAccountInfoAsync()).Value;
Console.WriteLine(account.SkuName);
`;

  assert.equal(
    evaluateRule("prompt/authenticated-operation", {
      ...completeWorkspace,
      source,
    }),
    true,
  );
});

test.skip("unused and wrongly associated credentials are rejected", () => {
  const sources = [
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri);
`,
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, unrelatedCredential);
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/default-azure-credential", {
        ...completeWorkspace,
        source,
      }),
      true,
    );
    assert.equal(
      evaluateRule("prompt/credential-client-association", {
        ...completeWorkspace,
        source,
      }),
      false,
    );
  }
});

test.skip("operations must use the client associated with the credential", () => {
  const source = `
var credential = new DefaultAzureCredential();
var authenticatedClient = new BlobServiceClient(serviceUri, credential);
var otherClient = new BlobServiceClient(otherUri);
var response = await otherClient.GetAccountInfoAsync();
Console.WriteLine(response.Value.SkuName);
`;

  assert.equal(
    evaluateRule("prompt/credential-client-association", {
      ...completeWorkspace,
      source,
    }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", {
      ...completeWorkspace,
      source,
    }),
    false,
  );
});

test.skip("authenticated results reject reassignment and aliases from other clients", () => {
  const sources = [
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
var otherClient = new BlobServiceClient(otherUri);
var response = await client.GetAccountInfoAsync();
response = await otherClient.GetAccountInfoAsync();
Console.WriteLine(response.Value.SkuName);
`,
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
var otherClient = new BlobServiceClient(otherUri);
var response = await client.GetAccountInfoAsync();
var otherResponse = await otherClient.GetAccountInfoAsync();
response = otherResponse;
Console.WriteLine(response.Value.AccountKind);
`,
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
var otherClient = new BlobServiceClient(otherUri);
var response = await client.GetAccountInfoAsync();
{
    var response = await otherClient.GetAccountInfoAsync();
    Console.WriteLine(response.Value.SkuName);
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", {
        ...completeWorkspace,
        source,
      }),
      false,
    );
  }
});

test.skip("authenticated result provenance follows unchanged aliases", () => {
  const sources = [
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
var response = await client.GetAccountInfoAsync();
var account = response.Value;
Console.WriteLine(account.SkuName);
`,
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
var otherClient = new BlobServiceClient(otherUri);
var response = await otherClient.GetAccountInfoAsync();
response = await client.GetAccountInfoAsync();
var output = response;
Console.WriteLine(output.Value.AccountKind);
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", {
        ...completeWorkspace,
        source,
      }),
      true,
    );
  }
});

test.skip("reviewer reassignment and interpolation regressions", () => {
  const overwrittenClient = `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
client = new BlobServiceClient(otherUri);
var response = await client.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
`;
  const overwrittenCredential = `
var credential = new DefaultAzureCredential();
credential = unrelatedCredential;
var client = new BlobServiceClient(serviceUri, credential);
var response = await client.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
`;
  const interpolatedOutput = `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
var response = await client.GetAccountInfoAsync();
Console.WriteLine($"Account kind: {response.Value.AccountKind}");
`;

  assert.deepEqual(
    {
      dotnetClientOverwrite: evaluateRule(
        "prompt/authenticated-operation",
        { ...completeWorkspace, source: overwrittenClient },
      ),
      dotnetCredentialOverwriteAssociation: evaluateRule(
        "prompt/credential-client-association",
        { ...completeWorkspace, source: overwrittenCredential },
      ),
      dotnetCredentialOverwriteOperation: evaluateRule(
        "prompt/authenticated-operation",
        { ...completeWorkspace, source: overwrittenCredential },
      ),
      dotnetInterpolation: evaluateRule(
        "prompt/authenticated-operation",
        { ...completeWorkspace, source: interpolatedOutput },
      ),
    },
    {
      dotnetClientOverwrite: false,
      dotnetCredentialOverwriteAssociation: false,
      dotnetCredentialOverwriteOperation: false,
      dotnetInterpolation: true,
    },
  );
});

test.skip("authentication catches must be specific, ordered, and connected", () => {
  const cases = [
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
try { await client.GetAccountInfoAsync(); }
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}
`,
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
try { await otherClient.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
`,
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
try { await client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine("credential unavailable");
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine("authentication failed");
}
`,
  ];

  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/auth-errors", { ...completeWorkspace, source }),
      false,
    );
  }
});

test.skip("authentication catches reject a client reassigned without credentials", () => {
  const source = `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
client = new BlobServiceClient(otherUri);
try { await client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
`;

  assert.equal(
    evaluateRule("prompt/auth-errors", { ...completeWorkspace, source }),
    false,
  );
});

test.skip("authentication catches do not protect an awaited operation outside the try", () => {
  const source = `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
try
{
    client.GetAccountInfoAsync();
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
await client.GetAccountInfoAsync();
`;

  assert.equal(
    evaluateRule("prompt/auth-errors", { ...completeWorkspace, source }),
    false,
  );
});

test.skip("authentication catches protect direct and parenthesized awaits", () => {
  const operations = [
    "await client.GetAccountInfoAsync();",
    "(await client.GetAccountInfoAsync()).Value;",
    "await (client.GetAccountInfoAsync());",
    "await(client.GetAccountInfoAsync());",
  ];

  for (const operation of operations) {
    const source = `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
try
{
    ${operation}
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
`;

    assert.equal(
      evaluateRule("prompt/auth-errors", { ...completeWorkspace, source }),
      true,
      operation,
    );
  }
});

test.skip("authentication catches reject a tuple Item2 receiver decoy", () => {
  const source = `
var credential = new DefaultAzureCredential();
var Item2 = new BlobServiceClient(serviceUri, credential);
var otherClient = new BlobServiceClient(otherUri);
var clients = (otherClient, otherClient);
try
{
    await clients.Item2.GetAccountInfoAsync();
}
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
`;

  assert.equal(
    evaluateRule("prompt/auth-errors", { ...completeWorkspace, source }),
    false,
  );
});

test.skip("authentication catches accept recovered and lexically current clients", () => {
  const sources = [
    `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(otherUri);
client = new BlobServiceClient(serviceUri, credential);
try { await client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
`,
    `
var credential = new DefaultAzureCredential();
var authenticatedClient = new BlobServiceClient(serviceUri, credential);
var client = new BlobServiceClient(otherUri);
client = authenticatedClient;
try { await client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
`,
    `
var credential = new DefaultAzureCredential();
Azure.Storage.Blobs.BlobServiceClient client = new(serviceUri, credential);
try { await client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable)
{
    Console.Error.WriteLine(unavailable);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed);
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/auth-errors", { ...completeWorkspace, source }),
      true,
      source,
    );
  }
});

test.skip("comments, strings, and fake logging cannot satisfy source rules", () => {
  const source = `
// var credential = new DefaultAzureCredential();
string example = """
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(serviceUri, credential);
var response = await client.GetAccountInfoAsync();
Console.WriteLine(response.Value.SkuName);
using var listener =
    AzureEventSourceListener.CreateConsoleLogger(EventLevel.Verbose);
""";
Console.WriteLine("Azure Identity diagnostics enabled");
`;

  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-packages",
  )) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source }),
      false,
      rule,
    );
  }
});

test.skip("missing generated source fails every source criterion", () => {
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-packages",
  )) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source: "" }),
      false,
      rule,
    );
  }
});
