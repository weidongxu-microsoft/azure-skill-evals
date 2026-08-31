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
} from "./tools/key-vault-dotnet-pagination-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadWorkspace(goldenRoot);
const sharedWorkspace = loadDotnetWorkspace(goldenRoot);
const baselineRoot = fileURLToPath(
  new URL("./fixtures/baseline-33374429826", import.meta.url),
);
const baseline33374429826 = loadWorkspace(baselineRoot);
const baselineShared33374429826 = loadDotnetWorkspace(baselineRoot);

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
  identity = "1.21.0",
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
    <PackageReference Include="Azure.Security.KeyVault.Secrets"
                      Version="${secrets}" />
  </ItemGroup>
</Project>`;
}

test("golden passes eight prompt rules and every shared .NET check", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, sharedWorkspace), true, check);
  }
});

test("baseline run 33374429826 exact output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(
      evaluateDotnetCheck(check, baselineShared33374429826),
      true,
      check,
    );
  }
});

test("manifest requires one runnable net8 project with exact stable pins", () => {
  const propertyManaged = manifest()
    .replace(
      "<TargetFramework>net8.0</TargetFramework>",
      "<BaseTarget>net8.0</BaseTarget><TargetFramework>$(BaseTarget)</TargetFramework>",
    )
    .replace('Version="1.21.0"', 'Version="[1.21.0]"');
  assert.equal(
    evaluateRule(
      "prompt/key-vault-manifest",
      workspace(completeWorkspace.source, propertyManaged),
    ),
    true,
  );

  const invalid = [
    manifest({ target: "net7.0" }),
    manifest({ target: "$(MissingTarget)" }),
    manifest({ identity: "1.22.0" }),
    manifest({ secrets: "4.*" }),
    manifest({ secrets: "[4.11.0,)" }),
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<!-- <PackageReference Include="Azure.Identity" Version="1.21.0" /> -->',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<PackageReference Include="Azure.Identity" Version="1.21.0" Condition="false" />',
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
      "prompt/key-vault-manifest",
      completeWorkspace.source,
      completeWorkspace.project.replace("4.11.0", "4.10.0"),
    ],
    [
      "prompt/configured-secret-client",
      completeWorkspace.source.replace(
        "new DefaultAzureCredential()",
        "credential",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/async-item-iteration",
      completeWorkspace.source.replace(
        "secrets.WithCancellation(cancellationToken)",
        "Array.Empty<SecretProperties>()",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/async-page-iteration",
      completeWorkspace.source.replace(
        "secrets.AsPages(pageSizeHint: 50)",
        "secrets.AsPages()",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/sync-iteration",
      completeWorkspace.source.replace(
        "client.GetPropertiesOfSecrets(cancellationToken: cancellationToken)",
        "Array.Empty<SecretProperties>()",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/secret-properties-output",
      completeWorkspace.source.replace("secret.CreatedOn", "secret.Name"),
      completeWorkspace.project,
    ],
    [
      "prompt/disabled-secret-handling",
      completeWorkspace.source.replace(
        'string state = secret.Enabled == false ? "disabled" : "enabled";',
        'string state = "unknown";',
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/pagination-error-handling",
      completeWorkspace.source.replace(
        "failure.Status",
        "failure.Message",
      ),
      completeWorkspace.project,
    ],
  ];

  for (const [rule, source, project] of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test("aliases, direct chains, branches, and reachable helpers pass", () => {
  const source = `
using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
using Kv = Azure.Security.KeyVault.Secrets;

var credential = new DefaultAzureCredential();
Kv.SecretClient vault = new(new Uri("https://example.vault.azure.net"), credential);
try
{
    await AsyncItems(vault);
    await AsyncPages(vault);
    SyncItems(vault);
}
catch (RequestFailedException error)
{
    Console.Error.WriteLine($"{error.Status}: {error.ErrorCode}");
}

static async Task AsyncItems(Kv.SecretClient client)
{
    await foreach (var value in client.GetPropertiesOfSecretsAsync())
    {
        Show(value);
    }
}

static async Task AsyncPages(Kv.SecretClient client)
{
    await foreach (var page in client.GetPropertiesOfSecretsAsync()
        .AsPages(null, 25))
    {
        foreach (var value in page.Values)
        {
            Show(value);
        }
    }
}

static void SyncItems(Kv.SecretClient client)
{
    foreach (var value in client.GetPropertiesOfSecrets())
    {
        Show(value);
    }
}

static void Show(SecretProperties item)
{
    if (item.Enabled != true)
    {
        Console.WriteLine("disabled");
    }
    Console.WriteLine($"{item.Name} {item.ContentType} {item.Enabled} {item.CreatedOn}");
}
`;

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("separate protected pagination paths and diagnostic helpers pass", () => {
  const source = `
using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

var client = new SecretClient(
    new Uri("https://example.vault.azure.net"),
    new DefaultAzureCredential());
try
{
    await foreach (var secret in client.GetPropertiesOfSecretsAsync())
    {
        Show(secret);
    }
}
catch (RequestFailedException failure)
{
    ReportFailure(failure);
}
try
{
    await foreach (var page in client.GetPropertiesOfSecretsAsync().AsPages(null, 50))
    {
        foreach (var secret in page.Values)
        {
            Show(secret);
        }
    }
}
catch (RequestFailedException failure)
{
    ReportFailure(failure);
}
try
{
    foreach (var secret in client.GetPropertiesOfSecrets())
    {
        Show(secret);
    }
}
catch (RequestFailedException failure)
{
    ReportFailure(failure);
}

static void Show(SecretProperties secret)
{
    string state = secret.Enabled == false ? "disabled" : "enabled";
    Console.WriteLine(
        $"{secret.Name} {secret.ContentType} {secret.Enabled} {secret.CreatedOn} {state}");
}

static void ReportFailure(RequestFailedException failure)
{
    Console.Error.WriteLine(
        $"Status={failure.Status}; Code={failure.ErrorCode}; Message={failure.Message}");
}`;
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("detached and partially protected pagination paths fail", () => {
  const source = `
using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
var client = new SecretClient(
    new Uri("https://example.vault.azure.net"),
    new DefaultAzureCredential());
try
{
    await foreach (var secret in client.GetPropertiesOfSecretsAsync())
    {
        Console.WriteLine(secret.Name);
    }
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine($"{failure.Status}: {failure.Message}");
}
await foreach (var page in client.GetPropertiesOfSecretsAsync().AsPages(null, 50))
{
    foreach (var secret in page.Values)
    {
        Console.WriteLine(secret.Name);
    }
}
foreach (var secret in client.GetPropertiesOfSecrets())
{
    Console.WriteLine(secret.Name);
}`;
  assert.equal(
    evaluateRule("prompt/pagination-error-handling", workspace(source)),
    false,
  );

  const detached = source.replace(
    "try\n{",
    "if (true)\n{",
  );
  assert.equal(
    evaluateRule("prompt/pagination-error-handling", workspace(detached)),
    false,
  );
});

test("comments, strings, local SDK fakes, and unreachable helpers fail", () => {
  const minimal = `
using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
var credential = new DefaultAzureCredential();
var client = new SecretClient(new Uri("https://example"), credential);
Console.WriteLine("started");
`;
  const decoys = [
    `${minimal}
string sample = """
${completeWorkspace.source}
""";
/* ${completeWorkspace.source} */`,
    `${completeWorkspace.source}
class SecretClient {}
class DefaultAzureCredential {}
class AsyncPageable<T> {}
class Pageable<T> {}
class Page<T> {}
class SecretProperties {}`,
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
      (name) =>
        ![
          "prompt/key-vault-manifest",
          "prompt/configured-secret-client",
        ].includes(name),
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
  const split = {
    ...completeWorkspace,
    projects: [
      {
        path: "App/App.csproj",
        project: manifest().replace(
          '<PackageReference Include="Azure.Security.KeyVault.Secrets"\n                      Version="4.11.0" />',
          "",
        ),
        source: completeWorkspace.source,
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

test("evidence from different clients or incompatible paths cannot combine", () => {
  const disconnectedClient = completeWorkspace.source
    .replace(
      "CancellationToken cancellationToken = CancellationToken.None;",
      `var other = new SecretClient(new Uri(vaultUrl), credential);
CancellationToken cancellationToken = CancellationToken.None;`,
    )
    .replaceAll("ListItemsAsync(client", "ListItemsAsync(other")
    .replaceAll("ListPagesAsync(client", "ListPagesAsync(other")
    .replaceAll("ListPages(client", "ListPages(other");
  assert.equal(
    evaluateRule(
      "prompt/configured-secret-client",
      workspace(disconnectedClient),
    ),
    true,
  );
  for (const rule of [
    "prompt/async-item-iteration",
    "prompt/async-page-iteration",
    "prompt/sync-iteration",
    "prompt/pagination-error-handling",
  ]) {
    assert.equal(evaluateRule(rule, workspace(disconnectedClient)), false, rule);
  }

  const splitOutput = completeWorkspace.source.replaceAll(
    "PrintSecret(secret);",
    "Console.WriteLine(secret.Name);",
  );
  assert.equal(
    evaluateRule("prompt/async-page-iteration", workspace(splitOutput)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/secret-properties-output", workspace(splitOutput)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/disabled-secret-handling", workspace(splitOutput)),
    false,
  );

  const detachedCatch = completeWorkspace.source
    .replace("try\n{", "if (true)\n{")
    .replace("catch (RequestFailedException failure)", "if (false)");
  assert.equal(
    evaluateRule(
      "prompt/pagination-error-handling",
      workspace(detachedCatch),
    ),
    false,
  );
});
