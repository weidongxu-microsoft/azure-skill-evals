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
} from "./tools/key-vault-dotnet-error-handling-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
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

test.skip("golden passes nine prompt rules and every shared .NET check", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, sharedWorkspace), true, check);
  }
});

test.skip("manifest requires one runnable net8 project with exact stable pins", () => {
  const propertyManaged = `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
      <OutputType>Exe</OutputType>
      <BaseTarget>net8.0</BaseTarget>
      <TargetFramework>$(BaseTarget)</TargetFramework>
      <IdentityVersion>1.21.0</IdentityVersion>
      <SecretsVersion>4.11.0</SecretsVersion>
    </PropertyGroup>
    <ItemGroup>
      <PackageReference Include="azure.identity"
                        Version="[$(IdentityVersion)]" />
      <PackageReference Include="AZURE.SECURITY.KEYVAULT.SECRETS">
        <Version>$(SecretsVersion)</Version>
      </PackageReference>
    </ItemGroup>
  </Project>`;
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

test.skip("manifest and source cannot be assembled from disconnected projects", () => {
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
        source: "Console.WriteLine(\"packages\");",
        sourceFiles: ["Packages/Program.cs"],
      },
    ],
  };
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, split), false, rule);
  }
});

test.skip("focused golden omissions fail their own criteria", () => {
  const withoutOperations = operationNames().reduce(
    (source, name) => source.replaceAll(name, `Missing${name}`),
    completeWorkspace.source,
  );
  const cases = [
    [
      "prompt/key-vault-manifest",
      completeWorkspace.source,
      completeWorkspace.project.replace("4.11.0", "4.10.0"),
    ],
    [
      "prompt/configured-secret-client",
      completeWorkspace.source.replace("MaxRetries = 5", "MaxRetries = 0"),
      completeWorkspace.project,
    ],
    [
      "prompt/key-vault-operation",
      withoutOperations,
      completeWorkspace.project,
    ],
    [
      "prompt/exception-details",
      completeWorkspace.source.replace(
        "failure.ErrorCode",
        "failure.Message",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/access-denied-diagnosis",
      completeWorkspace.source.replace(
        "Key Vault RBAC role assignment",
        "authorization setup",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/not-found-vs-deleted",
      completeWorkspace.source.replace(
        "GetDeletedSecretAsync",
        "InspectDeletedSecretAsync",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/version-conflict",
      completeWorkspace.source.replace(
        "A version conflict or concurrent change occurred.",
        "The write failed.",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/throttling-retry",
      completeWorkspace.source.replaceAll(
        "ReportThrottling();",
        'Console.Error.WriteLine("Request failed.");',
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/soft-delete-purge-protection",
      completeWorkspace.source.replace(
        "Purge protection prevents permanent deletion",
        "Permanent deletion is unavailable",
      ),
      completeWorkspace.project,
    ],
  ];

  for (const [rule, source, project] of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test.skip("qualified aliases, filtered catches, and reachable helpers pass", () => {
  const alternate = completeWorkspace.source
    .replace(
      "using Azure;",
      "using Azure;\nusing Failure = Azure.RequestFailedException;\n",
    )
    .replace(
      "using Azure.Identity;",
      "using Credential = Azure.Identity.DefaultAzureCredential;",
    )
    .replace(
      "using Azure.Security.KeyVault.Secrets;",
      "using Kv = Azure.Security.KeyVault.Secrets;",
    )
    .replaceAll("SecretClientOptions", "Kv.SecretClientOptions")
    .replaceAll("SecretClient client", "Kv.SecretClient client")
    .replaceAll("new SecretClient(", "new Kv.SecretClient(")
    .replaceAll("new DefaultAzureCredential()", "new Credential()")
    .replaceAll("Response<KeyVaultSecret>", "Response<Kv.KeyVaultSecret>")
    .replaceAll("Response<DeletedSecret>", "Response<Kv.DeletedSecret>")
    .replace(
      /catch \(RequestFailedException failure\)\s*\{/,
      "catch (Exception caught) when (caught is Failure failure)\n    {",
    )
    .replace(
      /catch \(RequestFailedException failure\)\s*\{/,
      "catch (Exception caught) when (caught is Failure failure)\n    {",
    )
    .replaceAll("catch (RequestFailedException failure)", "catch (Failure failure)")
    .replace(
      "static void ReportFailure(RequestFailedException failure)",
      "static void ReportFailure(Failure failure)",
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(alternate)), true, rule);
  }
});

test.skip("comments, strings, local SDK fakes, and unreachable helpers fail", () => {
  const minimal = `using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
Console.WriteLine("started");`;
  const decoys = [
    `${minimal}
string sample = """
${completeWorkspace.source}
""";
/* ${completeWorkspace.source} */`,
    `${completeWorkspace.source}
class SecretClient {}
class SecretClientOptions {}
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
      (name) => name !== "prompt/key-vault-manifest",
    )) {
      assert.equal(
        evaluateRule(rule, workspace(source)),
        false,
        `${index}:${rule}`,
      );
    }
  });
});

test.skip("handlers must protect operations from the configured client", () => {
  const disconnected = completeWorkspace.source
    .replace(
      "switch (args.FirstOrDefault()?.ToLowerInvariant())",
      `var other = new SecretClient(
    new Uri(vaultUrl),
    new DefaultAzureCredential());

switch (args.FirstOrDefault()?.ToLowerInvariant())`,
    )
    .replaceAll("await client.GetSecretAsync", "await other.GetSecretAsync")
    .replaceAll("await client.SetSecretAsync", "await other.SetSecretAsync")
    .replaceAll(
      "await client.GetDeletedSecretAsync",
      "await other.GetDeletedSecretAsync",
    )
    .replaceAll(
      "await client.PurgeDeletedSecretAsync",
      "await other.PurgeDeletedSecretAsync",
    );

  for (const rule of ruleNames().filter(
    (name) =>
      ![
        "prompt/key-vault-manifest",
        "prompt/configured-secret-client",
      ].includes(name),
  )) {
    assert.equal(evaluateRule(rule, workspace(disconnected)), false, rule);
  }
});

test.skip("diagnostic text on incompatible status paths cannot be combined", () => {
  const splitAccess = completeWorkspace.source
    .replaceAll(
      "DiagnoseAccessDenied();",
      'Console.Error.WriteLine("Denied.");',
    )
    .replace(
      "await DiagnoseMissingSecretAsync(client, secretName);",
      "DiagnoseAccessDenied();\n" +
        "                await DiagnoseMissingSecretAsync(client, secretName);",
    );
  assert.equal(
    evaluateRule(
      "prompt/access-denied-diagnosis",
      workspace(splitAccess),
    ),
    false,
  );

  const splitPurge = completeWorkspace.source.replace(
    "when (failure.Status is 403 or 409)",
    "when (failure.Status == 404)",
  );
  assert.equal(
    evaluateRule(
      "prompt/soft-delete-purge-protection",
      workspace(splitPurge),
    ),
    false,
  );
});

function operationNames() {
  return [
    "GetDeletedSecretAsync",
    "GetSecretAsync",
    "PurgeDeletedSecretAsync",
    "SetSecretAsync",
  ];
}
