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
} from "../../languages/dotnet/checks.mjs";
import {
  evaluateRule,
  loadWorkspace,
  ruleNames,
} from "./tools/storage-dotnet-auth-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const scenarioPath = fileURLToPath(new URL(".", import.meta.url));
const completeWorkspace = loadWorkspace(goldenPath);

function manifest({
  target = "net8.0",
  identity = "1.21.0",
  storage = "12.29.2",
  output = "Exe",
  items = "",
} = {}) {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>${output}</OutputType>
    <TargetFramework>${target}</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="${identity}" />
    <PackageReference Include="Azure.Storage.Blobs" Version="${storage}" />
    ${items}
  </ItemGroup>
</Project>`;
}

function loadedWorkspace(files) {
  const root = mkdtempSync(join(scenarioPath, ".rules-test-"));
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

test("storage authentication golden passes all checks", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, completeWorkspace), true, check);
  }
});

test("focused omissions fail their scenario rules", () => {
  const cases = [
    [
      "prompt/storage-packages",
      completeWorkspace.source,
      completeWorkspace.project.replace("1.21.0", "1.20.0"),
    ],
    [
      "prompt/account-endpoint",
      completeWorkspace.source.replace(
        "Environment.GetEnvironmentVariable",
        "ReadSetting",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/default-azure-credential",
      completeWorkspace.source.replace(
        "new DefaultAzureCredential(",
        "CreateCredential(",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/credential-client-association",
      completeWorkspace.source.replace(
        "new BlobServiceClient(serviceUri, credential)",
        "new BlobServiceClient(serviceUri)",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/authenticated-operation",
      completeWorkspace.source.replace(
        "client.GetAccountInfoAsync()",
        "otherClient.GetAccountInfoAsync()",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/auth-errors",
      completeWorkspace.source.replace(
        "catch (CredentialUnavailableException exception)",
        "catch (Exception exception)",
      ),
      completeWorkspace.project,
    ],
  ];

  for (const [rule, source, project] of cases) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source, project }),
      false,
      rule,
    );
  }
});

test("qualified, target-typed, inline, and reachable helper forms pass", () => {
  const source = `
var endpointText = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT")
    ?? throw new InvalidOperationException();
var serviceUri = new Uri(endpointText, UriKind.Absolute);
await AuthenticateAsync(serviceUri);

static async Task AuthenticateAsync(Uri endpoint)
{
    Azure.Core.TokenCredential credential =
        new global::Azure.Identity.DefaultAzureCredential();
    Azure.Storage.Blobs.BlobServiceClient client = new(endpoint, credential);
    try
    {
        Console.WriteLine(
            (await client.GetAccountInfoAsync()).Value.AccountKind);
    }
    catch (global::Azure.Identity.CredentialUnavailableException unavailable)
    {
        Console.Error.WriteLine(unavailable.Message);
    }
    catch (global::Azure.Identity.AuthenticationFailedException failed)
    {
        Console.Error.WriteLine(failed);
    }
}
`;

  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/storage-packages",
  )) {
    assert.equal(evaluateRule(rule, { ...completeWorkspace, source }), true, rule);
  }
});

test("GetPropertiesAsync is accepted as the authenticated service operation", () => {
  const source = completeWorkspace.source
    .replace("client.GetAccountInfoAsync()", "client.GetPropertiesAsync()")
    .replace(
      'Console.WriteLine($"Account kind: {response.Value.AccountKind}");',
      'Console.WriteLine($"Logging version: {response.Value.Logging.Version}");',
    )
    .replace(
      'Console.WriteLine($"SKU: {response.Value.SkuName}");',
      'Console.WriteLine($"Hour metrics: {response.Value.HourMetrics.Enabled}");',
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, { ...completeWorkspace, source }), true, rule);
  }
});

test("null-forgiving endpoint values preserve setting provenance", () => {
  const source = completeWorkspace.source.replace(
    "new Uri(endpointText, UriKind.Absolute)",
    "new Uri(endpointText!, UriKind.Absolute)",
  );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, { ...completeWorkspace, source }), true, rule);
  }
});

test("real SDK aliases and TryCreate out-var forms pass", () => {
  const source = `
using IdentityCredential = Azure.Identity.DefaultAzureCredential;
using BlobClient = Azure.Storage.Blobs.BlobServiceClient;
using Azure.Identity;
var setting = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT")
    ?? throw new InvalidOperationException();
if (Uri.TryCreate(setting, UriKind.Absolute, out var endpoint))
{
    var credential = new IdentityCredential();
    BlobClient client = new(endpoint, credential);
    try
    {
        var account = await client.GetAccountInfoAsync();
        Console.WriteLine(account.Value.AccountKind);
    }
    catch (CredentialUnavailableException unavailable)
    {
        Console.Error.WriteLine(unavailable.Message);
    }
    catch (AuthenticationFailedException failed)
    {
        Console.Error.WriteLine(failed.Message);
    }
}`;

  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/storage-packages",
  )) {
    assert.equal(evaluateRule(rule, { ...completeWorkspace, source }), true, rule);
  }
});

test("comments, strings, fake SDK types, and unreachable helpers fail", () => {
  const decoys = [
    `
// var credential = new DefaultAzureCredential();
string example = """
var endpointText = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
var endpoint = new Uri(endpointText);
var client = new BlobServiceClient(endpoint, new DefaultAzureCredential());
Console.WriteLine((await client.GetAccountInfoAsync()).Value.AccountKind);
""";
`,
    `
class DefaultAzureCredential {}
class BlobServiceClient {}
var endpointText = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
var endpoint = new Uri(endpointText);
var client = new BlobServiceClient(endpoint, new DefaultAzureCredential());
`,
    `
Console.WriteLine("application started");
static async Task UnusedAsync()
{
    var endpointText = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
    var endpoint = new Uri(endpointText);
    var credential = new DefaultAzureCredential();
    var client = new BlobServiceClient(endpoint, credential);
    try { Console.WriteLine((await client.GetAccountInfoAsync()).Value.AccountKind); }
    catch (CredentialUnavailableException unavailable) { Console.WriteLine(unavailable); }
    catch (AuthenticationFailedException failed) { Console.WriteLine(failed); }
}
`,
  ];

  for (const source of decoys) {
    for (const rule of ruleNames().filter(
      (name) => name !== "prompt/storage-packages",
    )) {
      assert.equal(
        evaluateRule(rule, { ...completeWorkspace, source }),
        false,
        `${rule}\n${source}`,
      );
    }
  }
});

test("disconnected clients and path-incompatible constructors fail", () => {
  const disconnected = `
var endpointText = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
var endpoint = new Uri(endpointText);
var credential = new DefaultAzureCredential();
var authenticated = new BlobServiceClient(endpoint, credential);
var other = new BlobServiceClient(new Uri("https://example.test/container"));
Console.WriteLine((await other.GetAccountInfoAsync()).Value.AccountKind);
`;
  assert.equal(
    evaluateRule("prompt/credential-client-association", {
      ...completeWorkspace,
      source: disconnected,
    }),
    false,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", {
      ...completeWorkspace,
      source: disconnected,
    }),
    false,
  );

  const connectionString = `
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient("UseDevelopmentStorage=true");
`;
  assert.equal(
    evaluateRule("prompt/account-endpoint", {
      ...completeWorkspace,
      source: connectionString,
    }),
    false,
  );
  assert.equal(
    evaluateRule("prompt/credential-client-association", {
      ...completeWorkspace,
      source: connectionString,
    }),
    false,
  );

  const relativeEndpoint = `
var endpointText = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
var endpoint = new Uri(endpointText, UriKind.Relative);
var client = new BlobServiceClient(endpoint, new DefaultAzureCredential());
`;
  assert.equal(
    evaluateRule("prompt/account-endpoint", {
      ...completeWorkspace,
      source: relativeEndpoint,
    }),
    false,
  );
});

test("dead branches and statements after termination cannot satisfy rules", () => {
  const workflow = `
var endpointText = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
var endpoint = new Uri(endpointText, UriKind.Absolute);
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(endpoint, credential);
try
{
    var response = await client.GetAccountInfoAsync();
    Console.WriteLine(response.Value.AccountKind);
}
catch (CredentialUnavailableException unavailable)
{
    Console.WriteLine(unavailable.Message);
}
catch (AuthenticationFailedException failed)
{
    Console.WriteLine(failed.Message);
}`;
  for (const source of [
    `if (false) { ${workflow} }`,
    `return; ${workflow}`,
    `Environment.Exit(0); ${workflow}`,
  ]) {
    for (const rule of ruleNames().filter(
      (name) => name !== "prompt/storage-packages",
    )) {
      assert.equal(
        evaluateRule(rule, { ...completeWorkspace, source }),
        false,
        `${rule}\n${source}`,
      );
    }
  }
});

test("fully qualified locally declared Azure SDK types are rejected", () => {
  const source = `
namespace Azure.Identity
{
    public class DefaultAzureCredential {}
    public class CredentialUnavailableException : Exception {}
    public class AuthenticationFailedException : Exception {}
}
namespace Azure.Storage.Blobs
{
    public class BlobServiceClient
    {
        public BlobServiceClient(Uri endpoint, object credential) {}
        public Task<Response> GetAccountInfoAsync() => Task.FromResult(new Response());
    }
    public class Response
    {
        public Value Value { get; } = new();
    }
    public class Value
    {
        public string AccountKind { get; } = "fake";
    }
}
public class Program
{
    public static async Task Main()
    {
        var setting = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
        var endpoint = new Uri(setting!, UriKind.Absolute);
        var credential = new Azure.Identity.DefaultAzureCredential();
        var client = new Azure.Storage.Blobs.BlobServiceClient(endpoint, credential);
        try
        {
            Console.WriteLine(
                (await client.GetAccountInfoAsync()).Value.AccountKind);
        }
        catch (Azure.Identity.CredentialUnavailableException unavailable)
        {
            Console.WriteLine(unavailable.Message);
        }
        catch (Azure.Identity.AuthenticationFailedException failed)
        {
            Console.WriteLine(failed.Message);
        }
    }
}`;

  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/storage-packages",
  )) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source }),
      false,
      rule,
    );
  }
});

test("nested namespace declarations cannot fake Azure SDK types", () => {
  const source = `
namespace Azure
{
    namespace Identity
    {
        public class DefaultAzureCredential {}
        public class CredentialUnavailableException : Exception {}
        public class AuthenticationFailedException : Exception {}
    }
    namespace Storage
    {
        namespace Blobs
        {
            public class BlobServiceClient
            {
                public BlobServiceClient(Uri endpoint, object credential) {}
                public Task<Response> GetPropertiesAsync() =>
                    Task.FromResult(new Response());
            }
            public class Response
            {
                public Value Value { get; } = new();
            }
            public class Value
            {
                public string AccountKind { get; } = "fake";
            }
        }
    }
}
public class Program
{
    public static async Task Main()
    {
        var setting = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
        var endpoint = new Uri(setting!, UriKind.Absolute);
        var credential = new Azure.Identity.DefaultAzureCredential();
        var client = new Azure.Storage.Blobs.BlobServiceClient(endpoint, credential);
        try
        {
            Console.WriteLine(
                (await client.GetPropertiesAsync()).Value.AccountKind);
        }
        catch (Azure.Identity.CredentialUnavailableException unavailable)
        {
            Console.WriteLine(unavailable.Message);
        }
        catch (Azure.Identity.AuthenticationFailedException failed)
        {
            Console.WriteLine(failed.Message);
        }
    }
}`;

  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/storage-packages",
  )) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source }),
      false,
      rule,
    );
  }
});

test("endpoint and credential provenance must converge on operated client", () => {
  const base = `
using Azure.Identity;
using Azure.Storage.Blobs;
var setting = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
var endpoint = new Uri(setting, UriKind.Absolute);
var credential = new DefaultAzureCredential();
`;
  const cases = [
    `${base}
var authenticated = new BlobServiceClient(endpoint, credential);
var decoy = new BlobServiceClient(new Uri("https://example.test"), credential);
Console.WriteLine((await decoy.GetAccountInfoAsync()).Value.AccountKind);`,
    `${base}
var decoyEndpoint = new Uri("https://example.test");
var client = new BlobServiceClient(decoyEndpoint, credential);
Console.WriteLine((await client.GetAccountInfoAsync()).Value.AccountKind);`,
    `${base}
var client = new BlobServiceClient(endpoint, otherCredential);
Console.WriteLine((await client.GetAccountInfoAsync()).Value.AccountKind);`,
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", {
        ...completeWorkspace,
        source,
      }),
      false,
      source,
    );
  }
});

test("fake type aliases are rejected", () => {
  const source = `
using DefaultAzureCredential = Example.DefaultAzureCredential;
using BlobServiceClient = Example.BlobServiceClient;
var setting = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
var endpoint = new Uri(setting, UriKind.Absolute);
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(endpoint, credential);
Console.WriteLine((await client.GetAccountInfoAsync()).Value.AccountKind);
`;
  for (const rule of [
    "prompt/default-azure-credential",
    "prompt/credential-client-association",
    "prompt/authenticated-operation",
  ]) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source }),
      false,
      rule,
    );
  }
});

test("one application project must own source and both exact net8 pins", () => {
  const valid = loadedWorkspace({
    "app/App.csproj": manifest({
      target: "net8.0-windows10.0.19041.0",
    }),
    "app/Program.cs": completeWorkspace.source,
    "decoy/Other.csproj": manifest({ target: "net7.0" }),
    "decoy/Program.cs": "// unrelated",
  });
  assert.equal(evaluateRule("prompt/storage-packages", valid), true);
  const net8Conditioned = loadedWorkspace({
    "App.csproj": manifest().replaceAll(
      "<PackageReference ",
      `<PackageReference Condition="'$(TargetFramework)' == 'net8.0'" `,
    ),
    "Program.cs": completeWorkspace.source,
  });
  assert.equal(
    evaluateRule("prompt/storage-packages", net8Conditioned),
    true,
  );

  const invalid = [
    loadedWorkspace({
      "App.csproj": manifest({ target: "net7.0" }),
      "Program.cs": completeWorkspace.source,
    }),
    loadedWorkspace({
      "manifest/App.csproj": manifest(),
      "source/App.csproj": `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup>
      </Project>`,
      "source/Program.cs": completeWorkspace.source,
    }),
    loadedWorkspace({
      "identity/Identity.csproj": manifest({ storage: "0.0.0" }),
      "identity/Program.cs": completeWorkspace.source,
      "storage/Storage.csproj": manifest({ identity: "0.0.0" }),
      "storage/Program.cs": completeWorkspace.source,
    }),
    loadedWorkspace({
      "App.csproj": manifest({
        items:
          '<PackageReference Include="Azure.Identity" Version="1.21.0" Condition="false" />',
      }).replace(
        '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
        "",
      ),
      "Program.cs": completeWorkspace.source,
    }),
    loadedWorkspace({
      "App.csproj": manifest({
        items: '<Compile Remove="Program.cs" />',
      }),
      "Program.cs": completeWorkspace.source,
    }),
    loadedWorkspace({
      "App.csproj": manifest().replaceAll(
        "<PackageReference ",
        `<PackageReference Condition="'$(TargetFramework)' == 'net7.0'" `,
      ),
      "Program.cs": completeWorkspace.source,
    }),
    loadedWorkspace({
      "App.csproj": manifest().replace(
        "<ItemGroup>",
        `<ItemGroup Condition="'$(TargetFramework)' == 'net7.0'">`,
      ),
      "Program.cs": completeWorkspace.source,
    }),
  ];
  for (const workspace of invalid) {
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace), false, rule);
    }
  }
});

test("only valid static Main methods count as explicit entry points", () => {
  const workflow = `
        var setting = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
        var endpoint = new Uri(setting, UriKind.Absolute);
        var credential = new DefaultAzureCredential();
        var client = new BlobServiceClient(endpoint, credential);
        try
        {
            var response = await client.GetAccountInfoAsync();
            Console.WriteLine(response.Value.AccountKind);
        }
        catch (CredentialUnavailableException unavailable)
        {
            Console.WriteLine(unavailable.Message);
        }
        catch (AuthenticationFailedException failed)
        {
            Console.WriteLine(failed.Message);
        }`;
  const sourceFor = (declaration) => `
using Azure.Identity;
using Azure.Storage.Blobs;
public class Program
{
    ${declaration}
    {
${workflow}
    }
}`;
  for (const declaration of [
    "public static async Task Main()",
    "public static async global::System.Threading.Tasks.Task Main(string[] args)",
  ]) {
    const valid = loadedWorkspace({
      "App.csproj": manifest(),
      "Program.cs": sourceFor(declaration),
    });
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, valid), true, `${rule}: ${declaration}`);
    }
  }

  const invalid = loadedWorkspace({
    "App.csproj": manifest(),
    "Program.cs": sourceFor("public async Task Main()"),
  });
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, invalid), false, rule);
  }
});

test("entry-point reachability keeps overloads and local functions separate", () => {
  const workflow = `
        var setting = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
        var endpoint = new Uri(setting, UriKind.Absolute);
        var credential = new DefaultAzureCredential();
        var client = new BlobServiceClient(endpoint, credential);
        try
        {
            var response = await client.GetAccountInfoAsync();
            Console.WriteLine(response.Value.AccountKind);
        }
        catch (CredentialUnavailableException unavailable)
        {
            Console.WriteLine(unavailable.Message);
        }
        catch (AuthenticationFailedException failed)
        {
            Console.WriteLine(failed.Message);
        }`;
  const overloadedMain = `
using Azure.Identity;
using Azure.Storage.Blobs;
public class Program
{
    public static void Main() {}
    public async Task Main(int ignored)
    {
${workflow}
    }
}`;
  assert.equal(
    evaluateRule("prompt/storage-packages", {
      ...completeWorkspace,
      source: overloadedMain,
    }),
    true,
  );
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/storage-packages",
  )) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source: overloadedMain }),
      false,
      rule,
    );
  }

  const localMain = `
using Azure.Identity;
using Azure.Storage.Blobs;
public class Program
{
    public void Run()
    {
        async Task Main()
        {
${workflow}
        }
    }
}`;
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source: localMain }),
      false,
      rule,
    );
  }
});

test("alternate top-level and static entry points preserve both operations", () => {
  const workflow = (operation) => `
    var setting = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
    var endpoint = new Uri(setting, UriKind.Absolute);
    var credential = new DefaultAzureCredential();
    var client = new BlobServiceClient(endpoint, credential);
    try
    {
        var response = await client.${operation}();
        Console.WriteLine(response.Value);
    }
    catch (CredentialUnavailableException unavailable)
    {
        Console.WriteLine(unavailable.Message);
    }
    catch (AuthenticationFailedException failed)
    {
        Console.WriteLine(failed.Message);
    }`;
  const sources = [
    `
using Azure.Identity;
using Azure.Storage.Blobs;
await AuthenticateAsync();
static async Task AuthenticateAsync()
{
${workflow("GetAccountInfoAsync")}
}`,
    `
using Azure.Identity;
using Azure.Storage.Blobs;
public class Program
{
    public static async Task<int> Main(string[] args)
    {
${workflow("GetPropertiesAsync")}
        return 0;
    }
}`,
  ];

  for (const source of sources) {
    for (const rule of ruleNames()) {
      assert.equal(
        evaluateRule(rule, { ...completeWorkspace, source }),
        true,
        `${rule}\n${source}`,
      );
    }
  }
});

test("authentication handling must guard the connected awaited operation", () => {
  const source = `
var endpointText = Environment.GetEnvironmentVariable("AZURE_STORAGE_BLOB_ENDPOINT");
var endpoint = new Uri(endpointText);
var credential = new DefaultAzureCredential();
var client = new BlobServiceClient(endpoint, credential);
try { client.GetAccountInfoAsync(); }
catch (CredentialUnavailableException unavailable) { Console.WriteLine(unavailable); }
catch (AuthenticationFailedException failed) { Console.WriteLine(failed); }
await client.GetAccountInfoAsync();
`;
  assert.equal(
    evaluateRule("prompt/auth-errors", { ...completeWorkspace, source }),
    false,
  );
});
