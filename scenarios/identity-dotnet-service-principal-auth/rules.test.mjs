import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadDotnetWorkspace } from "../../languages/dotnet/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/identity-dotnet-service-principal-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadDotnetWorkspace(goldenRoot);
const baseline33403910898 = loadDotnetWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33403910898", import.meta.url),
  ),
);
const sourceRules = ruleNames().filter(
  (name) => name !== "prompt/identity-packages",
);

function workspace(source, project = completeWorkspace.project) {
  return { ...completeWorkspace, source, project };
}

const environment = `
using Azure.Identity;
using Azure.Storage.Blobs;

var tenantId = Environment.GetEnvironmentVariable("AZURE_TENANT_ID");
var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var clientSecret = Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET");
var endpoint = Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");`;

const authenticatedClient = `${environment}
var credential =
    new ClientSecretCredential(tenantId, clientId, clientSecret);
var client = new BlobServiceClient(new Uri(endpoint), credential);`;

const handledOperation = `${authenticatedClient}
try
{
    var response = await client.GetAccountInfoAsync();
    Console.WriteLine(response.Value.AccountKind);
    Console.WriteLine(response.Value.SkuName);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed.Message);
}`;

test("service principal golden passes all six criteria", () => {
  assert.equal(ruleNames().length, 6);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("baseline run 33403910898 exact output passes every criterion", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33403910898), true, rule);
  }
});

test("environment accessor helpers are summarized by dataflow", () => {
  const accessor = `
using Azure.Identity;
using Azure.Storage.Blobs;

static string ReadRequired(string key)
{
    string? candidate = Environment.GetEnvironmentVariable(key);
    if (string.IsNullOrWhiteSpace(candidate))
    {
        throw new InvalidOperationException(key);
    }
    return candidate;
}
var tenantId = ReadRequired("AZURE_TENANT_ID");
var clientId = ReadRequired("AZURE_CLIENT_ID");
var clientSecret = ReadRequired("AZURE_CLIENT_SECRET");
var endpoint = ReadRequired("AZURE_STORAGE_BLOB_ENDPOINT");`;
  const source = `${accessor}
var credential =
    new ClientSecretCredential(tenantId, clientId, clientSecret);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try
{
    var result = await client.GetAccountInfoAsync();
    Console.WriteLine(result.Value.AccountKind);
    Console.WriteLine(result.Value.SkuName);
}
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed.Message);
}`;
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("environment accessor helpers reject invalid provenance and secret output", () => {
  const application = (helper, calls) => `${helper}
${calls}
var credential =
    new ClientSecretCredential(tenantId, clientId, clientSecret);
var client = new BlobServiceClient(new Uri(endpoint), credential);`;
  const calls = `
var tenantId = ReadRequired("AZURE_TENANT_ID");
var clientId = ReadRequired("AZURE_CLIENT_ID");
var clientSecret = ReadRequired("AZURE_CLIENT_SECRET");
var endpoint = ReadRequired("AZURE_STORAGE_BLOB_ENDPOINT");`;
  const invalidHelpers = [
    `static string ReadRequired(string key)
      => Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET")!;`,
    `static string ReadRequired(string key)
      => Environment.GetEnvironmentVariable(key) ?? "fallback";`,
    `static string ReadRequired(string key)
    {
        var value = Environment.GetEnvironmentVariable(key);
        Console.WriteLine(value);
        return value!;
    }`,
  ];
  for (const helper of invalidHelpers) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(application(helper, calls)),
      ),
      false,
      helper,
    );
  }

  const helper = `static string ReadRequired(string key)
  => Environment.GetEnvironmentVariable(key)
      ?? throw new InvalidOperationException(key);`;
  const wrongKey = calls.replace(
    '"AZURE_CLIENT_SECRET"',
    '"OTHER_CLIENT_SECRET"',
  );
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(application(helper, wrongKey)),
    ),
    false,
  );

  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(`${application(helper, calls)}
Console.WriteLine(clientSecret);`),
    ),
    false,
  );

  const swapped = calls
    .replace(
      'var tenantId = ReadRequired("AZURE_TENANT_ID");',
      'var tenantId = ReadRequired("AZURE_CLIENT_ID");',
    )
    .replace(
      'var clientId = ReadRequired("AZURE_CLIENT_ID");',
      'var clientId = ReadRequired("AZURE_TENANT_ID");',
    );
  assert.equal(
    evaluateRule(
      "prompt/client-secret-credential",
      workspace(application(helper, swapped)),
    ),
    false,
  );
});

test("package grading accepts compatible active manifest forms", () => {
  const manifests = [
    `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Azure.Identity" />
    <PackageReference Include="Azure.Storage.Blobs" />
  </ItemGroup>
</Project>`,
    `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Version="$(IdentityVersion)"
                      Include='azure.identity' />
    <PackageReference Include="AZURE.STORAGE.BLOBS">
      <Version>12.30.0</Version>
    </PackageReference>
  </ItemGroup>
</Project>`,
  ];
  for (const project of manifests) {
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class App {}", project)),
      true,
      project,
    );
  }
});

test("package grading ignores comments and does not combine projects", () => {
  const invalid = [
    `
<Project>
  <!-- <PackageReference Include="Azure.Identity" /> -->
  <PackageReference Include="Azure.Storage.Blobs" />
</Project>`,
    `
<Project><PackageReference Include="Azure.Identity" /></Project>
<Project><PackageReference Include="Azure.Storage.Blobs" /></Project>`,
    `<Project></Project>`,
  ];
  for (const project of invalid) {
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class App {}", project)),
      false,
      project,
    );
  }
});

test("package grading requires active references with usable assets", () => {
  const valid = `
<Project>
  <ItemGroup Condition="'true' == 'true'">
    <PackageReference Condition="true" Aliases="IdentitySdk">
      <Include>Azure.Identity</Include>
    </PackageReference>
    <PackageReference Include="Azure.Storage.Blobs">
      <Condition>1</Condition>
      <ExcludeAssets>build; analyzers</ExcludeAssets>
      <Aliases>BlobSdk</Aliases>
    </PackageReference>
  </ItemGroup>
</Project>`;
  assert.equal(
    evaluateRule("prompt/identity-packages", workspace("class App {}", valid)),
    true,
  );

  const invalid = [
    `<Project><ItemGroup>
       <PackageReference Include="Azure.Identity" Condition="false" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup>
       <PackageReference Include="Azure.Identity"><Condition>'false'</Condition></PackageReference>
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup Condition="'false' == 'true'">
       <PackageReference Include="Azure.Identity" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup>
       <PackageReference Include="Azure.Identity" ExcludeAssets="all" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup>
       <PackageReference Include="Azure.Identity" />
       <PackageReference Include="Azure.Storage.Blobs"><ExcludeAssets>compile;ALL</ExcludeAssets></PackageReference>
     </ItemGroup></Project>`,
  ];
  for (const project of invalid) {
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class App {}", project)),
      false,
      project,
    );
  }
});

test("package grading evaluates static conditions and compile assets", () => {
  const valid = [
    `<Project><ItemGroup Condition="'$(TargetFramework)' == 'net8.0'">
       <PackageReference Include="Azure.Identity" IncludeAssets="compile"
                         PrivateAssets="all" />
       <PackageReference Include="Azure.Storage.Blobs"
                         PrivateAssets="all" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup Condition="false Or $(UseAzurePackages)">
       <PackageReference Include="Azure.Identity" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
  ];
  for (const project of valid) {
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class App {}", project)),
      true,
      project,
    );
  }

  const invalid = [
    `<Project><ItemGroup Condition="false And true">
       <PackageReference Include="Azure.Identity" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup Condition="(true And false) Or (false And true)">
       <PackageReference Include="Azure.Identity" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup Condition="!true">
       <PackageReference Include="Azure.Identity" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup>
       <PackageReference Include="Azure.Identity" IncludeAssets="none" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup>
       <PackageReference Include="Azure.Identity" IncludeAssets="runtime" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
    `<Project><ItemGroup>
       <PackageReference Include="Azure.Identity" ExcludeAssets="compile" />
       <PackageReference Include="Azure.Storage.Blobs" />
     </ItemGroup></Project>`,
  ];
  for (const project of invalid) {
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class App {}", project)),
      false,
      project,
    );
  }
});

test("package grading selects static MSBuild Choose branches", () => {
  const packages = `
    <ItemGroup>
      <PackageReference Include="Azure.Identity" />
      <PackageReference Include="Azure.Storage.Blobs" />
    </ItemGroup>`;
  const valid = `<Project><Choose>
    <When Condition="false"><ItemGroup>
      <PackageReference Include="Decoy.Package" />
    </ItemGroup></When>
    <When Condition="true">${packages}</When>
    <Otherwise><ItemGroup>
      <PackageReference Include="Other.Decoy" />
    </ItemGroup></Otherwise>
  </Choose></Project>`;
  const invalid = [
    `<Project><Choose>
       <When Condition="false">${packages}</When>
       <Otherwise><ItemGroup /></Otherwise>
     </Choose></Project>`,
    `<Project><Choose>
       <When Condition="true"><ItemGroup /></When>
       <Otherwise>${packages}</Otherwise>
     </Choose></Project>`,
  ];
  assert.equal(
    evaluateRule("prompt/identity-packages", workspace("class App {}", valid)),
    true,
  );
  for (const project of invalid) {
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class App {}", project)),
      false,
      project,
    );
  }
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
      rule: "prompt/environment-secret-management",
      source: completeWorkspace.source.replace(
        '"AZURE_TENANT_ID"',
        '"OTHER_TENANT_ID"',
      ),
    },
    {
      rule: "prompt/client-secret-credential",
      source: completeWorkspace.source.replace(
        "new(tenantId, clientId, clientSecret)",
        "new(clientId, tenantId, clientSecret)",
      ),
    },
    {
      rule: "prompt/credential-client-association",
      source: completeWorkspace.source.replace(
        "new(new Uri(endpoint), credential)",
        "new(new Uri(endpoint))",
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
      rule: "prompt/authentication-errors",
      source: completeWorkspace.source.replace(
        "catch (AuthenticationFailedException exception)",
        "catch (Exception exception)",
      ),
    },
  ];
  for (const { rule, source, project = completeWorkspace.project } of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test("qualified aliases, target typing, named arguments, and bound values pass", () => {
  const source = `
using Env = System.Environment;
using Identity = Azure.Identity;
using CSC = Azure.Identity.ClientSecretCredential;
using Blobs = Azure.Storage.Blobs;
using BSC = Azure.Storage.Blobs.BlobServiceClient;

var rawTenant = Env.GetEnvironmentVariable("AZURE_TENANT_ID")
    ?? throw new InvalidOperationException();
var tenant = rawTenant;
var client = System.Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
var rawSecret = Env.GetEnvironmentVariable("AZURE_CLIENT_SECRET");
var secret = rawSecret;
var rawEndpoint = Env.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT");
var endpoint = rawEndpoint;
CSC credential = new(
    clientSecret: secret,
    tenantId: tenant,
    clientId: client);
BSC storage = new(new System.Uri(endpoint), credential);
try
{
    Azure.Response<Azure.Storage.Blobs.Models.AccountInfo> result =
        await storage.GetAccountInfoAsync();
    var account = result.Value;
    var kind = account.AccountKind;
    var sku = account.SkuName;
    System.Console.WriteLine(kind);
    System.Console.WriteLine(sku);
}
catch (Identity.AuthenticationFailedException failed)
{
    System.Console.Error.WriteLine(failed.ToString());
}`;
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("inline credential and operation forms are accepted", () => {
  const source = `${environment}
var client = new global::Azure.Storage.Blobs.BlobServiceClient(
    endpoint,
    new global::Azure.Identity.ClientSecretCredential(
        tenantId, clientId, clientSecret));
try
{
    Console.WriteLine(
        (await (client.GetAccountInfoAsync())).Value.AccountKind);
    Console.WriteLine(
        (await client.GetAccountInfoAsync()).Value.SkuName);
}
catch (global::Azure.Identity.AuthenticationFailedException failed)
{
    throw new InvalidOperationException("Authentication failed", failed);
}`;
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("SDK symbols require genuine Azure namespace provenance", () => {
  const missingCredentialImport = environment
    .replace("using Azure.Identity;", "")
    .concat(`
var credential =
    new ClientSecretCredential(tenantId, clientId, clientSecret);`);
  assert.equal(
    evaluateRule(
      "prompt/client-secret-credential",
      workspace(missingCredentialImport),
    ),
    false,
  );

  const missingClientImport = environment
    .replace("using Azure.Storage.Blobs;", "")
    .concat(`
var credential =
    new global::Azure.Identity.ClientSecretCredential(
        tenantId, clientId, clientSecret);
var client = new BlobServiceClient(new Uri(endpoint), credential);`);
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      workspace(missingClientImport),
    ),
    false,
  );

  const missingExceptionImport = environment
    .replace("using Azure.Identity;", "")
    .concat(`
var credential =
    new global::Azure.Identity.ClientSecretCredential(
        tenantId, clientId, clientSecret);
var client = new BlobServiceClient(new Uri(endpoint), credential);
try { await client.GetAccountInfoAsync(); }
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed.Message);
}`);
  assert.equal(
    evaluateRule(
      "prompt/authentication-errors",
      workspace(missingExceptionImport),
    ),
    false,
  );

  const fakeCredential = `
using Azure.Identity;
sealed class App
{
    private sealed class ClientSecretCredential
    {
        public ClientSecretCredential(
            string tenant, string client, string secret) {}
    }
    void Run()
    {
        var tenantId = Environment.GetEnvironmentVariable("AZURE_TENANT_ID");
        var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
        var clientSecret =
            Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET");
        var credential =
            new ClientSecretCredential(tenantId, clientId, clientSecret);
    }
}`;
  assert.equal(
    evaluateRule("prompt/client-secret-credential", workspace(fakeCredential)),
    false,
  );

  const fakeClient = `
using Azure.Identity;
using Azure.Storage.Blobs;
sealed class App
{
    private sealed class BlobServiceClient
    {
        public BlobServiceClient(Uri endpoint, object credential) {}
    }
    void Run()
    {
        var tenantId = Environment.GetEnvironmentVariable("AZURE_TENANT_ID");
        var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
        var clientSecret =
            Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET");
        var endpoint = Environment.GetEnvironmentVariable(
            "AZURE_STORAGE_BLOB_ENDPOINT");
        var credential =
            new global::Azure.Identity.ClientSecretCredential(
                tenantId, clientId, clientSecret);
        var client = new BlobServiceClient(new Uri(endpoint), credential);
    }
}`;
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(fakeClient)),
    false,
  );

  const fakeException = `
using Azure.Identity;
using Azure.Storage.Blobs;
sealed class App
{
    private sealed class AuthenticationFailedException : Exception {}
    async Task Run()
    {
        var tenantId = Environment.GetEnvironmentVariable("AZURE_TENANT_ID");
        var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
        var clientSecret =
            Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET");
        var endpoint = Environment.GetEnvironmentVariable(
            "AZURE_STORAGE_BLOB_ENDPOINT");
        var credential =
            new global::Azure.Identity.ClientSecretCredential(
                tenantId, clientId, clientSecret);
        var client =
            new global::Azure.Storage.Blobs.BlobServiceClient(
                new Uri(endpoint), credential);
        try
        {
            await client.GetAccountInfoAsync();
        }
        catch (AuthenticationFailedException failed)
        {
            Console.Error.WriteLine(failed.Message);
        }
    }
}`;
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(fakeException)),
    false,
  );
});

test("qualified SDK symbols bypass unrelated local name collisions", () => {
  const source = `
using Azure.Identity;
using Azure.Storage.Blobs;
sealed class App
{
    private sealed class ClientSecretCredential {}
    private sealed class BlobServiceClient {}
    private sealed class AuthenticationFailedException : Exception {}

    async Task Run()
    {
        var tenantId = Environment.GetEnvironmentVariable("AZURE_TENANT_ID");
        var clientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
        var clientSecret =
            Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET");
        var endpoint = Environment.GetEnvironmentVariable(
            "AZURE_STORAGE_BLOB_ENDPOINT");
        var credential =
            new global::Azure.Identity.ClientSecretCredential(
                tenantId, clientId, clientSecret);
        var client =
            new global::Azure.Storage.Blobs.BlobServiceClient(
                new Uri(endpoint), credential);
        try
        {
            var response = await client.GetAccountInfoAsync();
            Console.WriteLine(response.Value.AccountKind);
            Console.WriteLine(response.Value.SkuName);
        }
        catch (global::Azure.Identity.AuthenticationFailedException failed)
        {
            Console.Error.WriteLine(failed.Message);
        }
    }
}`;
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("instance fields and properties preserve end-to-end provenance", () => {
  const source = `
using Azure.Identity;
using Azure.Storage.Blobs;

sealed class StorageProbe
{
    private string TenantId { get; set; }
    private string ClientId { get; set; }
    private string ClientSecret { get; set; }
    private string Endpoint { get; set; }
    private ClientSecretCredential _credential;
    private BlobServiceClient _client;

    public StorageProbe()
    {
        TenantId = Environment.GetEnvironmentVariable("AZURE_TENANT_ID");
        ClientId = Environment.GetEnvironmentVariable("AZURE_CLIENT_ID");
        ClientSecret =
            Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET");
        Endpoint = Environment.GetEnvironmentVariable(
            "AZURE_STORAGE_BLOB_ENDPOINT");
        this._credential = new(TenantId, ClientId, ClientSecret);
        this._client = new(new Uri(Endpoint), this._credential);
    }

    public async Task RunAsync()
    {
        try
        {
            var account = (await this._client.GetAccountInfoAsync()).Value;
            Console.WriteLine(account.AccountKind);
            Console.WriteLine(account.SkuName);
        }
        catch (AuthenticationFailedException failed)
        {
            Console.Error.WriteLine(failed.Message);
        }
    }
}`;
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("environment provenance requires exact names without value fallbacks", () => {
  const invalid = [
    environment.replace("AZURE_CLIENT_SECRET", "CLIENT_SECRET"),
    environment.replace(
      'Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET")',
      'Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET") ?? "secret"',
    ),
    environment.replace(
      `Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT")`,
      `Environment.GetEnvironmentVariable(
    "AZURE_STORAGE_BLOB_ENDPOINT") ?? GetFallback()`,
    ),
    environment.replace(
      'Environment.GetEnvironmentVariable("AZURE_TENANT_ID")',
      'configuration["AZURE_TENANT_ID"]',
    ),
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }

  const throwingReads = environment
    .replace(
      'Environment.GetEnvironmentVariable("AZURE_TENANT_ID")',
      'Environment.GetEnvironmentVariable("AZURE_TENANT_ID") ?? throw new InvalidOperationException()',
    )
    .replace(
      'Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET")',
      'Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET")!',
    );
  assert.equal(
    evaluateRule("prompt/environment-secret-management", workspace(throwingReads)),
    true,
  );
});

test("client secret must never reach output, diagnostics, or logging", () => {
  const sinks = [
    "Console.WriteLine(clientSecret);",
    'Console.Error.WriteLine($"secret: {clientSecret}");',
    "System.Diagnostics.Debug.WriteLine(clientSecret);",
    "Trace.TraceError(clientSecret);",
    "logger.LogInformation(clientSecret);",
    'logger.LogError("secret {Secret}", clientSecret);',
  ];
  for (const sink of sinks) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${environment}\n${sink}`),
      ),
      false,
      sink,
    );
  }

  const safe = `${environment}
Console.WriteLine("AZURE_CLIENT_SECRET is configured.");
Console.WriteLine(clientId);`;
  assert.equal(
    evaluateRule("prompt/environment-secret-management", workspace(safe)),
    true,
  );
});

test("secret aliases, member bindings, and source-order mutations are tracked", () => {
  const exposedAlias = `${environment}
var copy = clientSecret;
logger.LogWarning("credential: {Credential}", copy);`;
  const exposedMember = `${environment}
var holder = new Holder();
holder.Secret = clientSecret;
Console.WriteLine(holder.Secret);`;
  const overwrittenBeforeOutput = `${environment}
var value = clientSecret;
value = clientId;
Console.WriteLine(value);`;
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(exposedAlias),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(exposedMember),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(overwrittenBeforeOutput),
    ),
    true,
  );
});

test("secret taint crosses up to three helper calls and return aliases", () => {
  const returningLeak = `${environment}
static string Third(string value) { return value; }
static string Second(string value) { return Third(value); }
static string First(string value) { return Second(value); }
var relay = First;
var leaked = relay(clientSecret);
logger.LogDebug("secret: {Secret}", leaked);`;
  const sinkLeak = `${environment}
sealed class SecretWriter
{
    public void Third(string value)
    {
        if (DiagnosticsEnabled) Trace.TraceError(value);
    }
    public void Second(string value) { Third(value); }
    public void First(string value) { Second(value); }
}
var writer = new SecretWriter();
writer.First(clientSecret);`;
  const capturedReturn = `${environment}
static string ReadSecret()
{
    return Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET");
}
Console.WriteLine(ReadSecret());`;
  for (const source of [returningLeak, sinkLeak, capturedReturn]) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test("secret taint reaches a fixed point at arbitrary helper depth", () => {
  for (const depth of [4, 16, 64]) {
    const returnHelpers = Array.from(
      { length: depth },
      (_, index) =>
        `static string Relay${index}(string value) => ${
          index + 1 === depth ? "value" : `Relay${index + 1}(value)`
        };`,
    ).join("\n");
    const sinkHelpers = Array.from(
      { length: depth },
      (_, index) =>
        `static void Write${index}(string value) { ${
          index + 1 === depth
            ? "logger.LogError(value);"
            : `Write${index + 1}(value);`
        } }`,
    ).join("\n");
    const returnLeak = `${environment}
${returnHelpers}
var relay = Relay0;
var leaked = relay(clientSecret);
logger.LogInformation("secret: {Secret}", leaked);`;
    const sinkLeak = `${environment}
${sinkHelpers}
Write0(clientSecret);`;
    for (const source of [returnLeak, sinkLeak]) {
      assert.equal(
        evaluateRule("prompt/environment-secret-management", workspace(source)),
        false,
        `depth ${depth}`,
      );
    }
  }
});

test("aggregate and collection additions preserve secret taint", () => {
  const leaks = [
    `${environment}
var values = new List<string>();
values.Add(clientSecret);
logger.LogInformation("values: {Values}", values);`,
    `${environment}
var values = new List<string> { clientId, clientSecret };
Console.WriteLine($"values: {values}");`,
    `${environment}
var payload = new { Name = "credential", Value = clientSecret };
logger.LogWarning("payload: {Payload}", payload);`,
    `${environment}
var payload = new CredentialPayload();
payload.Value = clientSecret;
logger.LogWarning("payload: {Payload}", payload);`,
    `${environment}
sealed class SecretBag
{
    private readonly List<string> _values = new();
    public void Add(string value) { _values.Add(value); }
    public void Write() { Console.WriteLine(_values); }
}
var bag = new SecretBag();
bag.Add(clientSecret);
bag.Write();`,
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test("nested helper side effects preserve receiver and formal taint", () => {
  const leaks = [
    `${environment}
static void Inner(Dictionary<string, string> target, string value)
{
    target["secret"] = value;
}
static void Outer(Dictionary<string, string> target, string value)
{
    Inner(target, value);
}
var payload = new Dictionary<string, string>();
Outer(payload, clientSecret);
Console.WriteLine(payload);`,
    `${environment}
static void Store(
    Dictionary<string, string> target,
    string key,
    string value)
{
    target[key] = value;
}
var payload = new Dictionary<string, string>();
Store(payload, "secret", clientSecret);
logger.LogWarning("payload: {Payload}", payload);`,
    `${environment}
sealed class Envelope
{
    public Payload Details { get; } = new();
    public void Store(string value) { Details.Values.Add(value); }
}
sealed class Payload
{
    public List<string> Values { get; } = new();
}
var envelope = new Envelope();
envelope.Store(clientSecret);
logger.LogError("payload: {Payload}", envelope.Details);`,
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test("side effects remain instance-specific and allow safe redaction", () => {
  const source = `${environment}
sealed class SecretBag
{
    public List<string> Values { get; } = new();
    public void Store(string value) { Values.Add(value); }
    public void Write() { Console.WriteLine(Values); }
}
var privateBag = new SecretBag();
var diagnosticBag = new SecretBag();
privateBag.Store(clientSecret);
diagnosticBag.Store("[REDACTED]");
diagnosticBag.Write();`;
  assert.equal(
    evaluateRule("prompt/environment-secret-management", workspace(source)),
    true,
  );
});

test("allocation identity preserves aliases, nested edges, and cycles", () => {
  const leaks = [
    `${environment}
var original = new SecretNode();
var alias = original;
alias.Value = clientSecret;
Console.WriteLine(original);`,
    `${environment}
static void Store(SecretNode target, string value)
{
    target.Value = value;
}
static void Relay(SecretNode target, string value)
{
    Store(target, value);
}
var original = new SecretNode();
var alias = original;
Relay(alias, clientSecret);
logger.LogError("node: {Node}", original);`,
    `${environment}
sealed class SecretNode
{
    public string Value { get; set; }
    public void Store(string value) { Value = value; }
}
var original = new SecretNode();
var alias = original;
alias.Store(clientSecret);
Console.WriteLine(original);`,
    `${environment}
var root = new SecretNode();
root.Child = new SecretNode();
root.Child.Values = new List<string>();
root.Child.Values[0] = clientSecret;
logger.LogWarning("root: {Root}", root);`,
    `${environment}
var first = new SecretNode();
var second = new SecretNode();
first.Child = second;
second.Child = first;
first.Value = clientSecret;
Console.WriteLine(second);`,
    `${environment}
var root = new SecretNode();
root.Child = new SecretNode();
var retained = root.Child;
retained.Value = clientSecret;
root.Child = new SecretNode();
Console.WriteLine(retained);`,
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test("allocation identity isolates objects and rebinding or replacement", () => {
  const safe = [
    `${environment}
var tainted = new SecretNode();
var clean = new SecretNode();
tainted.Value = clientSecret;
Console.WriteLine(clean);`,
    `${environment}
var original = new SecretNode();
var alias = original;
alias = new SecretNode();
alias.Value = clientSecret;
Console.WriteLine(original);`,
    `${environment}
var root = new SecretNode();
root.Child = new SecretNode();
root.Child.Value = clientSecret;
root.Child = new SecretNode();
Console.WriteLine(root);`,
    `${environment}
static void Rebind(SecretNode target, string value)
{
    target = new SecretNode();
    target.Value = value;
}
var original = new SecretNode();
Rebind(original, clientSecret);
Console.WriteLine(original);`,
  ];
  for (const source of safe) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      true,
      source,
    );
  }
});

test("only constant redactors remove secret taint", () => {
  const unsafe = [
    `static string Redact(string value) => value;`,
    `static string Redact(string value) =>
        UseRedaction ? "[REDACTED]" : value;`,
  ];
  for (const redactor of unsafe) {
    const source = `${environment}
${redactor}
Console.WriteLine(Redact(clientSecret));`;
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }

  const safe = `${environment}
static string Redact(string value) => "[REDACTED]";
static ClientSecretCredential Wrap(
    string tenant, string client, string secret) =>
    new ClientSecretCredential(tenant, client, secret);
var credential = Wrap(tenantId, clientId, clientSecret);
Console.WriteLine(Redact(clientSecret));`;
  assert.equal(
    evaluateRule("prompt/environment-secret-management", workspace(safe)),
    true,
  );
});

test("secret taint follows instance and static helper members", () => {
  const instanceLeak = `${environment}
sealed class SecretCache
{
    private string _value;
    public void Store(string value) { this._value = value; }
    public void Write() { Console.WriteLine(this._value); }
}
var cache = new SecretCache();
cache.Store(clientSecret);
cache.Write();`;
  const staticLeak = `${environment}
static string SharedSecret;
static void Capture(string value) { SharedSecret = value; }
static void WriteCaptured() { logger.LogTrace(SharedSecret); }
Capture(clientSecret);
WriteCaptured();`;
  for (const source of [instanceLeak, staticLeak]) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test("credential helpers and explicitly redacted helper output are safe", () => {
  const source = `${environment}
using CSC = global::Azure.Identity.ClientSecretCredential;

static CSC BuildCredential(
    string tenant, string client, string secret)
{
    return new CSC(tenant, client, secret);
}
static string Redact(string secret) { return "[REDACTED]"; }

var credential = BuildCredential(tenantId, clientId, clientSecret);
logger.LogInformation("secret: {Secret}", Redact(clientSecret));
Console.WriteLine("credential configured");`;
  assert.equal(
    evaluateRule("prompt/environment-secret-management", workspace(source)),
    true,
  );
});

test("ClientSecretCredential requires correct environment-derived arguments", () => {
  const valid = [
    `${environment}
var credential =
    new ClientSecretCredential(tenantId, clientId, clientSecret);`,
    `${environment}
ClientSecretCredential credential = new(
    tenantId: tenantId,
    clientId: clientId,
    clientSecret: clientSecret);`,
    `${environment}
var credential = new ClientSecretCredential(
    clientSecret: clientSecret,
    tenantId: tenantId,
    clientId: clientId);`,
    `${environment}
var credential = new ClientSecretCredential(
    tenantId, clientId, clientSecret, new ClientSecretCredentialOptions());`,
  ];
  for (const source of valid) {
    assert.equal(
      evaluateRule("prompt/client-secret-credential", workspace(source)),
      true,
      source,
    );
  }

  const invalid = [
    `${environment}
var credential =
    new ClientSecretCredential(clientId, tenantId, clientSecret);`,
    `${environment}
clientSecret = "hard-coded";
var credential =
    new ClientSecretCredential(tenantId, clientId, clientSecret);`,
    `${environment}
var credential =
    new ClientSecretCredential(tenantId, clientId, otherSecret);`,
    `${environment}
var credential = new ClientSecretCredential(
    tenantId: tenantId,
    clientId: clientId,
    clientSecret: "hard-coded");`,
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/client-secret-credential", workspace(source)),
      false,
      source,
    );
  }
});

test("lexical and method scopes prevent unrelated binding combinations", () => {
  const invalid = [
    `${environment}
{
    var tenantId = otherTenant;
    var credential =
        new ClientSecretCredential(tenantId, clientId, clientSecret);
}`,
    `
void ReadValues()
{
    ${environment}
}
void CreateCredential()
{
    var credential =
        new ClientSecretCredential(tenantId, clientId, clientSecret);
}`,
    `${environment}
var secret = clientSecret;
{
    var secret = otherSecret;
    var credential = new ClientSecretCredential(tenantId, clientId, secret);
}`,
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/client-secret-credential", workspace(source)),
      false,
      source,
    );
  }
});

test("credential to endpoint client association follows current bindings", () => {
  const invalid = [
    `${authenticatedClient}
credential = otherCredential;
var other = new BlobServiceClient(new Uri(endpoint), credential);`,
    `${authenticatedClient}
var other = new BlobServiceClient(new Uri(endpoint), unrelatedCredential);`,
    `${authenticatedClient.replace(
      '"AZURE_STORAGE_BLOB_ENDPOINT"',
      '"OTHER_ENDPOINT"',
    )}`,
    `${authenticatedClient}
{
    var credential = unrelatedCredential;
    var other = new BlobServiceClient(new Uri(endpoint), credential);
}`,
  ];
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      workspace(invalid[0].replace(authenticatedClient, environment + `
var credential =
    new ClientSecretCredential(tenantId, clientId, clientSecret);`)),
    ),
    false,
  );
  for (const source of invalid.slice(1)) {
    const onlyInvalidAssociation = source.replace(
      "var client = new BlobServiceClient(new Uri(endpoint), credential);",
      "",
    );
    assert.equal(
      evaluateRule(
        "prompt/credential-client-association",
        workspace(onlyInvalidAssociation),
      ),
      false,
      onlyInvalidAssociation,
    );
  }
});

test("client member reassignment controls authenticated operation provenance", () => {
  const overwritten = `${authenticatedClient}
client = new BlobServiceClient(new Uri(endpoint), otherCredential);
var response = await client.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`;
  const restored = `${authenticatedClient}
client = new BlobServiceClient(new Uri(endpoint), otherCredential);
client = new BlobServiceClient(new Uri(endpoint), credential);
var response = await client.GetAccountInfoAsync();
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

test("authenticated operation requires associated await and both result outputs", () => {
  const invalid = [
    `${authenticatedClient}
var response = client.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`,
    `${authenticatedClient}
var response = await otherClient.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`,
    `${authenticatedClient}
var response = await client.GetAccountInfoAsync();
response = await otherClient.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);
Console.WriteLine(response.Value.SkuName);`,
    `${authenticatedClient}
await client.GetAccountInfoAsync();
Console.WriteLine("AccountKind and SkuName");`,
    `${authenticatedClient}
var response = await client.GetAccountInfoAsync();
Console.WriteLine(response.Value.AccountKind);`,
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
      source,
    );
  }
});

test("bound response, account, and field aliases are accepted", () => {
  const sources = [
    `${authenticatedClient}
var response = await client.GetAccountInfoAsync();
var account = response.Value;
var kind = account.AccountKind;
var sku = account.SkuName;
Console.WriteLine(kind);
Console.WriteLine(sku);`,
    `${authenticatedClient}
var response = await client.GetAccountInfoAsync();
var alias = response;
Console.WriteLine(alias.Value.AccountKind);
Console.WriteLine(alias.Value.SkuName);`,
  ];
  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      true,
      source,
    );
  }
});

test("authentication handling must be useful and protect the authenticated await", () => {
  const invalid = [
    `${authenticatedClient}
try { client.GetAccountInfoAsync(); }
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed.Message);
}`,
    `${authenticatedClient}
try { await otherClient.GetAccountInfoAsync(); }
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine(failed.Message);
}`,
    `${authenticatedClient}
try { await client.GetAccountInfoAsync(); }
catch (AuthenticationFailedException failed) { }`,
    `${authenticatedClient}
try { await client.GetAccountInfoAsync(); }
catch (AuthenticationFailedException failed)
{
    Console.Error.WriteLine("authentication failed");
}`,
    `${authenticatedClient}
try { await client.GetAccountInfoAsync(); }
catch (Exception failed)
{
    Console.Error.WriteLine(failed.Message);
}`,
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      false,
      source,
    );
  }
});

test("qualified authentication catches and exact filters are accepted", () => {
  const sources = [
    handledOperation,
    `${authenticatedClient}
try
{
    await (client.GetAccountInfoAsync());
}
catch (Azure.Identity.AuthenticationFailedException failed)
{
    throw;
}`,
    `${authenticatedClient}
try
{
    (await client.GetAccountInfoAsync()).Value;
}
catch (Exception failed)
    when (failed is AuthenticationFailedException)
{
    throw failed;
}`,
  ];
  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      true,
      source,
    );
  }
});

test("every unrelated catch must causally preserve its exception", () => {
  const unsafeHandlers = [
    `catch (RequestFailedException failure) { }`,
    `catch (RequestFailedException failure)
     { Console.Error.WriteLine(failure.Message); }`,
    `catch (RequestFailedException failure) { return; }`,
    `catch (RequestFailedException failure)
     { throw new InvalidOperationException("replacement"); }`,
    `catch (RequestFailedException failure)
     { if (ShouldThrow()) throw; }`,
    `catch (Exception failure) when (failure is RequestFailedException)
     { Console.Error.WriteLine(failure.Message); }`,
  ];
  for (const handler of unsafeHandlers) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        workspace(`${handledOperation}
try { OtherWork(); }
${handler}`),
      ),
      false,
      handler,
    );
  }

  const safeHandlers = [
    `catch (RequestFailedException) { throw; }`,
    `catch (RequestFailedException failure) { throw failure; }`,
    `catch (RequestFailedException failure)
     { throw new InvalidOperationException("storage failed", failure); }`,
    `catch (RequestFailedException failure)
     {
       if (ShouldWrap())
         throw new InvalidOperationException("storage failed", failure);
       else
         throw failure;
     }`,
  ];
  for (const handler of safeHandlers) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        workspace(`${handledOperation}
try { OtherWork(); }
${handler}`),
      ),
      true,
      handler,
    );
  }
});

test("loops, branches, and labels cannot hide swallowed catch paths", () => {
  const unsafe = [
    `{ while (ShouldRetry()) { return; } throw failure; }`,
    `{ for (var i = 0; i < count; i++) {
         if (ShouldReturn(i)) return;
       }
       throw failure;
     }`,
    `{ foreach (var item in items)
         if (ShouldReturn(item)) return;
       throw failure;
     }`,
    `{ do { return; } while (false); throw failure; }`,
    `{ retry: while (ShouldRetry()) { break retry; } throw failure; }`,
    `{ goto retry; retry: throw failure; }`,
    `{ while (true) continue; }`,
  ];
  for (const body of unsafe) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        workspace(`${handledOperation}
try { OtherWork(); }
catch (RequestFailedException failure) ${body}`),
      ),
      false,
      body,
    );
  }

  const safe = [
    `{ while (ShouldRetry()) break; throw failure; }`,
    `{ for (;;) { throw failure; } }`,
    `{ retry: while (ShouldRetry()) { break; } throw failure; }`,
    `{ while (false) return; throw failure; }`,
    `{ if (ShouldWrap())
         throw new InvalidOperationException("wrapped", failure);
       else
         throw failure;
     }`,
  ];
  for (const body of safe) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        workspace(`${handledOperation}
try { OtherWork(); }
catch (RequestFailedException failure) ${body}`),
      ),
      true,
      body,
    );
  }
});

test("duplicate labels are rejected but separate method label scopes pass", () => {
  const duplicate = `${handledOperation}
try { OtherWork(); }
catch (RequestFailedException failure)
{
    retry: while (ShouldRetry()) break;
    retry: while (ShouldRetry()) break;
    throw failure;
}`;
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(duplicate)),
    false,
  );

  const separateMethods = `${handledOperation}
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
    evaluateRule("prompt/authentication-errors", workspace(separateMethods)),
    true,
  );
});

test("comments, strings, decoy awaits, and missing source cannot pass", () => {
  const source = `
/* ${handledOperation} */
string example = """
${handledOperation}
""";
client.GetAccountInfoAsync();
Console.WriteLine("AuthenticationFailedException");
`;
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
  }
});
