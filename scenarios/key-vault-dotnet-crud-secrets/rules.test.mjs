import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadWorkspace,
  ruleNames,
} from "./tools/key-vault-dotnet-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadWorkspace(goldenRoot);
const baseline33374429826 = loadWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33374429826", import.meta.url),
  ),
);
const baseline33420505368 = loadWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33420505368", import.meta.url),
  ),
);

function workspace(source, project = completeWorkspace.project) {
  return { ...completeWorkspace, project, source };
}

function manifest({
  target = "<TargetFramework>net8.0</TargetFramework>",
  identityVersion = "1.21.0",
  secretsVersion = "4.11.0",
} = {}) {
  const reference = (name, version) =>
    version === null
      ? `<PackageReference Include="${name}" />`
      : `<PackageReference Include="${name}" Version="${version}" />`;
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>${target}</PropertyGroup>
  <ItemGroup>
    ${reference("Azure.Identity", identityVersion)}
    ${reference("Azure.Security.KeyVault.Secrets", secretsVersion)}
  </ItemGroup>
</Project>`;
}

const imports = `
using Azure;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;
`;

const client = `${imports}
var credential = new DefaultAzureCredential();
var client = new SecretClient(
    new Uri("https://example.vault.azure.net"), credential);
`;

const lifecycle = `
await client.SetSecretAsync("my-secret", "my-secret-value");
var response = await client.GetSecretAsync("my-secret");
Console.WriteLine(response.Value.Value);
await client.SetSecretAsync("my-secret", "updated-value");
var operation = await client.StartDeleteSecretAsync("my-secret");
await operation.WaitForCompletionAsync();
await client.PurgeDeletedSecretAsync("my-secret");
`;

function handled(body = lifecycle) {
  return `${client}
try
{
${body}
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(
        $"Key Vault failed ({failure.Status}): {failure.Message}");
}`;
}

test("golden passes exactly eight semantic criteria", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("baseline run 33374429826 exact output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
});

test("baseline run 33420505368 implicit secret conversion passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33420505368), true, rule);
  }
});

test("manifest accepts compatible runtime package versions and properties", () => {
  const manifests = [
    manifest(),
    manifest({
      target: "<TargetFramework>net6.0</TargetFramework>",
      identityVersion: "1.17.0",
      secretsVersion: "4.8.0",
    }),
    `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup>
        <BaseTarget>net8.0-windows10.0.19041.0</BaseTarget>
        <TargetFrameworks>net7.0;$(BaseTarget)</TargetFrameworks>
        <IdentityVersion>1.21.0</IdentityVersion>
        <SecretsVersion>4.11.0</SecretsVersion>
      </PropertyGroup>
      <ItemGroup Condition="'true' == 'true'">
        <PackageReference Version="[$(IdentityVersion)]"
                          Include="azure.identity" />
        <PackageReference Include="AZURE.SECURITY.KEYVAULT.SECRETS">
          <Version>[$(SecretsVersion)]</Version>
          <ExcludeAssets>build;analyzers</ExcludeAssets>
        </PackageReference>
      </ItemGroup>
    </Project>`,
    `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
      <Choose>
        <When Condition="false">
          <ItemGroup><PackageReference Include="Decoy" Version="1.0" /></ItemGroup>
        </When>
        <When Condition="true">
          <ItemGroup>
            <PackageReference Include="Azure.Identity" Version="1.21.0"
                              IncludeAssets="compile" />
            <PackageReference Include="Azure.Security.KeyVault.Secrets"
                              Version="4.11.0" PrivateAssets="all" />
          </ItemGroup>
        </When>
      </Choose>
    </Project>`,
  ];
  for (const project of manifests) {
    assert.equal(
      evaluateRule(
        "prompt/key-vault-manifest",
        workspace(completeWorkspace.source, project),
      ),
      true,
      project,
    );
  }
});

test("manifest rejects incompatible or ineffective package references", () => {
  const invalid = [
    manifest({ identityVersion: null }),
    manifest({ secretsVersion: null }),
    manifest({ identityVersion: "2.0.0" }),
    manifest({ secretsVersion: "5.0.0" }),
    manifest({ secretsVersion: "[4.11.0,)" }),
    manifest({ secretsVersion: "4.*" }),
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<!-- <PackageReference Include="Azure.Identity" Version="1.21.0" /> -->',
    ),
    `${manifest({ secretsVersion: null })}
     ${manifest({ identityVersion: null })}`,
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<PackageReference Include="Azure.Identity" Version="1.21.0" Condition="false" />',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.Security.KeyVault.Secrets" Version="4.11.0" />',
      '<PackageReference Include="Azure.Security.KeyVault.Secrets" Version="4.11.0" ExcludeAssets="compile" />',
    ),
    `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
      <Target Name="RestorePackages">
        <ItemGroup>
          <PackageReference Include="Azure.Identity" Version="1.21.0" />
          <PackageReference Include="Azure.Security.KeyVault.Secrets"
                            Version="4.11.0" />
        </ItemGroup>
      </Target>
    </Project>`,
    `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
      <PackageReference Include="Azure.Identity" Version="1.21.0" />
      <PackageReference Include="Azure.Security.KeyVault.Secrets"
                        Version="4.11.0" />
    </Project>`,
    `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
      <UsingTask TaskName="PackageDecoy" TaskFactory="RoslynCodeTaskFactory">
        <Task>
          <ItemGroup>
            <PackageReference Include="Azure.Identity" Version="1.21.0" />
            <PackageReference Include="Azure.Security.KeyVault.Secrets"
                              Version="4.11.0" />
          </ItemGroup>
        </Task>
      </UsingTask>
    </Project>`,
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

test("manifest ignores target decoys when active project items are valid", () => {
  const project = manifest().replace(
    "</Project>",
    `<Target Name="Unused">
       <ItemGroup Condition="true">
         <PackageReference Include="Azure.Identity" Version="999.0.0" />
         <PackageReference Include="Azure.Security.KeyVault.Secrets"
                           Version="999.0.0" />
       </ItemGroup>
     </Target>
     </Project>`,
  );
  assert.equal(
    evaluateRule(
      "prompt/key-vault-manifest",
      workspace(completeWorkspace.source, project),
    ),
    true,
  );
});

test("focused golden omissions fail their own criterion", () => {
  const cases = [
    {
      rule: "prompt/key-vault-manifest",
      source: completeWorkspace.source,
      project: completeWorkspace.project.replace(
        "Azure.Security.KeyVault.Secrets",
        "Contoso.Security.Secrets",
      ),
    },
    {
      rule: "prompt/default-azure-credential",
      source: completeWorkspace.source.replace(
        "new DefaultAzureCredential()",
        "otherCredential",
      ),
    },
    {
      rule: "prompt/secret-client",
      source: completeWorkspace.source.replace(
        "new(new Uri(vaultUrl), new DefaultAzureCredential())",
        "CreateClient()",
      ),
    },
    {
      rule: "prompt/create-secret",
      source: completeWorkspace.source.replace(
        '"my-secret-value"',
        '"wrong-value"',
      ),
    },
    {
      rule: "prompt/get-print-secret",
      source: completeWorkspace.source.replace(
        "Console.WriteLine(retrieved.Value.Value);",
        'Console.WriteLine("my-secret-value");',
      ),
    },
    {
      rule: "prompt/update-secret",
      source: completeWorkspace.source.replace(
        '"updated-value"',
        '"wrong-update"',
      ),
    },
    {
      rule: "prompt/delete-wait-purge",
      source: completeWorkspace.source.replace(
        "await deletion.WaitForCompletionAsync();",
        "",
      ),
    },
    {
      rule: "prompt/request-failed-error",
      source: completeWorkspace.source.replace(
        "catch (RequestFailedException exception)",
        "catch (Exception exception)",
      ),
    },
  ];
  for (const { rule, source, project = completeWorkspace.project } of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test("fully synchronous lifecycle is valid", () => {
  const source = handled(`
client.SetSecret("my-secret", "my-secret-value");
var response = client.GetSecret("my-secret");
Console.WriteLine(response.Value.Value);
client.SetSecret("my-secret", "updated-value");
DeleteSecretOperation operation = client.StartDeleteSecret("my-secret");
operation.WaitForCompletion();
client.PurgeDeletedSecret("my-secret");
`);
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/key-vault-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("inline response output and configured awaits are valid", () => {
  const source = handled(`
await client.SetSecretAsync(
    "my-secret", "my-secret-value").ConfigureAwait(false);
Console.WriteLine(
    (await client.GetSecretAsync("my-secret").ConfigureAwait(false))
        .Value.Value);
await client.SetSecretAsync(
    "my-secret", "updated-value").ConfigureAwait(false);
var operation = await client.StartDeleteSecretAsync(
    "my-secret").ConfigureAwait(false);
await operation.WaitForCompletionAsync().ConfigureAwait(false);
await client.PurgeDeletedSecretAsync(
    "my-secret").ConfigureAwait(false);
`);
  for (const rule of [
    "prompt/create-secret",
    "prompt/get-print-secret",
    "prompt/update-secret",
    "prompt/delete-wait-purge",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("qualified types, aliases, target typing, and named arguments pass", () => {
  const source = `
using Azure;
using Identity = Azure.Identity;
using KV = Azure.Security.KeyVault.Secrets;
using Client = Azure.Security.KeyVault.Secrets.SecretClient;
using DeleteOp = Azure.Security.KeyVault.Secrets.DeleteSecretOperation;

Identity.DefaultAzureCredential credential = new();
Client vault = new(
    credential: credential,
    vaultUri: new System.Uri("https://example.vault.azure.net"));
try
{
    await vault.SetSecretAsync(
        value: "my-secret-value", name: "my-secret");
    Azure.Response<KV.KeyVaultSecret> response =
        await vault.GetSecretAsync(name: "my-secret");
    KV.KeyVaultSecret secret = response.Value;
    string value = secret.Value;
    System.Console.WriteLine(value);
    await vault.SetSecretAsync(
        name: "my-secret", value: "updated-value");
    DeleteOp deletion =
        await vault.StartDeleteSecretAsync(name: "my-secret");
    await deletion.WaitForCompletionAsync();
    await vault.PurgeDeletedSecretAsync(name: "my-secret");
}
catch (Azure.RequestFailedException failure)
{
    throw new InvalidOperationException("Key Vault request failed", failure);
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/key-vault-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("absolute Uri.TryCreate keeps the vault endpoint connected", () => {
  const source = `${imports}
string? vaultUriValue = Environment.GetEnvironmentVariable("KEY_VAULT_URI");
if (!Uri.TryCreate(vaultUriValue, UriKind.Absolute, out Uri? vaultUri))
{
    throw new InvalidOperationException();
}
var client = new SecretClient(vaultUri, new DefaultAzureCredential());
try
{
${lifecycle}
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(failure.Message);
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/key-vault-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("relative and disconnected Uri.TryCreate outputs are rejected", () => {
  const sources = [
    `${imports}
var raw = Environment.GetEnvironmentVariable("KEY_VAULT_URI");
Uri.TryCreate(raw, UriKind.Relative, out Uri? vaultUri);
var client = new SecretClient(vaultUri, new DefaultAzureCredential());`,
    `${imports}
var raw = Environment.GetEnvironmentVariable("KEY_VAULT_URI");
Uri.TryCreate(raw, UriKind.Absolute, out Uri? parsedVaultUri);
var client = new SecretClient(vaultUri, new DefaultAzureCredential());`,
  ];
  for (const source of sources) {
    assert.equal(evaluateRule("prompt/secret-client", workspace(source)), false);
  }
});

test("interpolated retrieved secret values remain connected", () => {
  const source = handled(
    lifecycle.replace(
      "Console.WriteLine(response.Value.Value);",
      'Console.WriteLine($"Secret value: {response.Value.Value}");',
    ),
  );
  assert.equal(evaluateRule("prompt/get-print-secret", workspace(source)), true);
});

test("typed implicit response conversion preserves retrieved secret provenance", () => {
  const implicit = handled(
    lifecycle.replace(
      "var response = await client.GetSecretAsync(\"my-secret\");\nConsole.WriteLine(response.Value.Value);",
      `KeyVaultSecret secret = await client.GetSecretAsync("my-secret");
Console.WriteLine(secret.Value);`,
    ),
  );
  assert.equal(evaluateRule("prompt/get-print-secret", workspace(implicit)), true);
  assert.equal(evaluateRule("prompt/update-secret", workspace(implicit)), true);
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(implicit)),
    true,
  );

  const invalid = [
    implicit.replace(
      'client.GetSecretAsync("my-secret")',
      'client.GetSecretAsync("other-secret")',
    ),
    implicit.replace(
      'client.GetSecretAsync("my-secret")',
      'otherClient.GetSecretAsync("my-secret")',
    ),
    implicit.replace(
      "KeyVaultSecret secret = await client.GetSecretAsync",
      "KeyVaultSecret secret = client.GetSecretAsync",
    ),
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/get-print-secret", workspace(source)),
      false,
    );
  }
});

test("unqualified Azure symbols require real imports and reject local fakes", () => {
  const missingImports = handled()
    .replace("using Azure.Identity;", "")
    .replace("using Azure.Security.KeyVault.Secrets;", "");
  assert.equal(
    evaluateRule("prompt/default-azure-credential", workspace(missingImports)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/secret-client", workspace(missingImports)),
    false,
  );

  const fakeTypes = `${imports}
sealed class DefaultAzureCredential {}
sealed class SecretClient
{
    public SecretClient(Uri endpoint, object credential) {}
}
${handled().replace(imports, "")}`;
  assert.equal(
    evaluateRule("prompt/default-azure-credential", workspace(fakeTypes)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/secret-client", workspace(fakeTypes)),
    false,
  );

  const qualified = `
sealed class DefaultAzureCredential {}
sealed class SecretClient {}
sealed class RequestFailedException : Exception {}
var credential = new global::Azure.Identity.DefaultAzureCredential();
var client = new global::Azure.Security.KeyVault.Secrets.SecretClient(
    new System.Uri("https://example.vault.azure.net"), credential);
try
{
${lifecycle}
}
catch (global::Azure.RequestFailedException failure)
{
    Console.Error.WriteLine(failure.Message);
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/key-vault-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(qualified)), true, rule);
  }
});

test("lexical bindings and source-order reassignment preserve associations", () => {
  const overwritten = `${client}
client = new SecretClient(
    new Uri("https://example.vault.azure.net"), otherCredential);
${lifecycle}`;
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(overwritten)),
    false,
  );

  const restored = `${client}
var authenticated = client;
client = otherClient;
client = authenticated;
${lifecycle}`;
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(restored)),
    true,
  );

  const shadowed = `${client}
{
    var client = otherClient;
${lifecycle}
}`;
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(shadowed)),
    false,
  );
});

test("member clients and reachable helpers carry lifecycle provenance", () => {
  const source = `${imports}
sealed class VaultWorkflow
{
    private SecretClient _client;

    public VaultWorkflow()
    {
        var credential = new DefaultAzureCredential();
        _client = new SecretClient(
            new Uri("https://example.vault.azure.net"), credential);
    }

    public async Task RunAsync()
    {
        await CreateAsync(_client, "my-secret", "my-secret-value");
        var response = await ReadAsync(_client, "my-secret");
        Console.WriteLine(response.Value.Value);
        await CreateAsync(_client, "my-secret", "updated-value");
        var deletion = await _client.StartDeleteSecretAsync("my-secret");
        await WaitAsync(deletion);
        await _client.PurgeDeletedSecretAsync("my-secret");
    }

    private static async Task CreateAsync(
        SecretClient client, string name, string value)
    {
        await client.SetSecretAsync(name, value);
    }

    private static async Task<Response<KeyVaultSecret>> ReadAsync(
        SecretClient client, string name)
    {
        return await client.GetSecretAsync(name);
    }

    private static async Task WaitAsync(DeleteSecretOperation operation)
    {
        await operation.WaitForCompletionAsync();
    }
}

var workflow = new VaultWorkflow();
try
{
    await workflow.RunAsync();
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(failure);
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/key-vault-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("unreachable helpers and unawaited asynchronous decoys do not score", () => {
  const unreachable = `${client}
static async Task Decoy(SecretClient client)
{
${lifecycle}
}`;
  for (const rule of [
    "prompt/create-secret",
    "prompt/get-print-secret",
    "prompt/update-secret",
    "prompt/delete-wait-purge",
  ]) {
    assert.equal(evaluateRule(rule, workspace(unreachable)), false, rule);
  }

  const unawaited = `${client}
client.SetSecretAsync("my-secret", "my-secret-value");
var response = client.GetSecretAsync("my-secret");
Console.WriteLine("my-secret-value");
client.SetSecretAsync("my-secret", "updated-value");
var operation = client.StartDeleteSecretAsync("my-secret");
operation.WaitForCompletionAsync();
client.PurgeDeletedSecretAsync("my-secret");`;
  for (const rule of [
    "prompt/create-secret",
    "prompt/get-print-secret",
    "prompt/update-secret",
    "prompt/delete-wait-purge",
  ]) {
    assert.equal(evaluateRule(rule, workspace(unawaited)), false, rule);
  }

  const unawaitedHelper = `${client}
static async Task RunAsync(SecretClient client)
{
${lifecycle}
}
RunAsync(client);`;
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(unawaitedHelper)),
    false,
  );
});

test("secret names, clients, values, output, and operation must remain connected", () => {
  const invalid = [
    handled(lifecycle.replace(
      'GetSecretAsync("my-secret")',
      'GetSecretAsync("other-secret")',
    )),
    handled(lifecycle.replace(
      'SetSecretAsync("my-secret", "updated-value")',
      'SetSecretAsync("other-secret", "updated-value")',
    )),
    handled(lifecycle.replace(
      'StartDeleteSecretAsync("my-secret")',
      'StartDeleteSecretAsync("other-secret")',
    )),
    handled(lifecycle.replace(
      'PurgeDeletedSecretAsync("my-secret")',
      'PurgeDeletedSecretAsync("other-secret")',
    )),
    handled(lifecycle.replace(
      "Console.WriteLine(response.Value.Value);",
      'Console.WriteLine("my-secret-value");',
    )),
    handled(lifecycle.replace(
      "await operation.WaitForCompletionAsync();",
      `var unrelated = await otherClient.StartDeleteSecretAsync("my-secret");
await unrelated.WaitForCompletionAsync();`,
    )),
  ];
  const rules = [
    "prompt/get-print-secret",
    "prompt/update-secret",
    "prompt/delete-wait-purge",
    "prompt/delete-wait-purge",
    "prompt/get-print-secret",
    "prompt/delete-wait-purge",
  ];
  invalid.forEach((source, index) => {
    assert.equal(evaluateRule(rules[index], workspace(source)), false, rules[index]);
  });
});

test("lifecycle mutation and purge order are enforced", () => {
  const invalid = [
    `${client}
await client.SetSecretAsync("my-secret", "updated-value");
await client.SetSecretAsync("my-secret", "my-secret-value");
var response = await client.GetSecretAsync("my-secret");
Console.WriteLine(response.Value.Value);`,
    handled(lifecycle.replace(
      'await client.SetSecretAsync("my-secret", "updated-value");',
      "",
    )),
    handled(lifecycle.replace(
      `await operation.WaitForCompletionAsync();
await client.PurgeDeletedSecretAsync("my-secret");`,
      `await client.PurgeDeletedSecretAsync("my-secret");
await operation.WaitForCompletionAsync();`,
    )),
  ];
  assert.equal(
    evaluateRule("prompt/update-secret", workspace(invalid[0])),
    false,
  );
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(invalid[1])),
    false,
  );
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(invalid[2])),
    false,
  );
});

test("ordered lifecycle must exist on one compatible reachable path", () => {
  const splitAcrossBranches = handled(`
if (UseFirstPath())
{
    await client.SetSecretAsync("my-secret", "my-secret-value");
    var response = await client.GetSecretAsync("my-secret");
    Console.WriteLine(response.Value.Value);
}
else
{
    await client.SetSecretAsync("my-secret", "updated-value");
    var operation = await client.StartDeleteSecretAsync("my-secret");
    await operation.WaitForCompletionAsync();
    await client.PurgeDeletedSecretAsync("my-secret");
}`);
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(splitAcrossBranches)),
    false,
  );

  const constantFalseDecoy = handled(`
if (false)
{
    await client.SetSecretAsync("my-secret", "my-secret-value");
    var response = await client.GetSecretAsync("my-secret");
    Console.WriteLine(response.Value.Value);
    await client.SetSecretAsync("my-secret", "updated-value");
    var operation = await client.StartDeleteSecretAsync("my-secret");
    await operation.WaitForCompletionAsync();
    await client.PurgeDeletedSecretAsync("my-secret");
}`);
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(constantFalseDecoy)),
    false,
  );

  const sharedPrefixAndSuffix = handled(`
await client.SetSecretAsync("my-secret", "my-secret-value");
if (UseAsyncRead())
{
    var response = await client.GetSecretAsync("my-secret");
    Console.WriteLine(response.Value.Value);
    await client.SetSecretAsync("my-secret", "updated-value");
}
else
{
    var response = client.GetSecret("my-secret");
    Console.WriteLine(response.Value.Value);
    client.SetSecret("my-secret", "updated-value");
}
var operation = await client.StartDeleteSecretAsync("my-secret");
await operation.WaitForCompletionAsync();
await client.PurgeDeletedSecretAsync("my-secret");`);
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(sharedPrefixAndSuffix)),
    true,
  );

  const oneCompleteBranch = handled(`
if (UseCompletePath())
{
    await client.SetSecretAsync("my-secret", "my-secret-value");
    var response = await client.GetSecretAsync("my-secret");
    Console.WriteLine(response.Value.Value);
    await client.SetSecretAsync("my-secret", "updated-value");
    var operation = await client.StartDeleteSecretAsync("my-secret");
    await operation.WaitForCompletionAsync();
    await client.PurgeDeletedSecretAsync("my-secret");
}
else
{
    await client.SetSecretAsync("my-secret", "my-secret-value");
}`);
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(oneCompleteBranch)),
    true,
  );
});

test("associated status polling is accepted and unrelated polling is rejected", () => {
  const valid = handled(lifecycle.replace(
    "await operation.WaitForCompletionAsync();",
    `while (!operation.HasCompleted)
{
    await operation.UpdateStatusAsync();
}`,
  ));
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(valid)),
    true,
  );

  const invalid = handled(lifecycle.replace(
    "await operation.WaitForCompletionAsync();",
    `while (!otherOperation.HasCompleted)
{
    await operation.UpdateStatusAsync();
}`,
  ));
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(invalid)),
    false,
  );

  const incompleteLoops = [
    `while (!operation.HasCompleted)
{
    await operation.UpdateStatusAsync();
    break;
}`,
    `while (!operation.HasCompleted)
{
    if (ShouldPoll())
    {
        await operation.UpdateStatusAsync();
    }
}`,
    `while (!operation.HasCompleted)
{
    await otherOperation.UpdateStatusAsync();
}`,
  ];
  for (const loop of incompleteLoops) {
    const source = handled(lifecycle.replace(
      "await operation.WaitForCompletionAsync();",
      loop,
    ));
    assert.equal(
      evaluateRule("prompt/delete-wait-purge", workspace(source)),
      false,
      loop,
    );
  }

  const wrongDelete = handled(lifecycle.replace(
    "await operation.WaitForCompletionAsync();",
    `var unrelated = await client.StartDeleteSecretAsync("other-secret");
while (!unrelated.HasCompleted)
{
    await operation.UpdateStatusAsync();
}`,
  ));
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(wrongDelete)),
    false,
  );
});

test("RequestFailedException must protect reachable Key Vault work", () => {
  const invalid = [
    `${client}
try { await otherClient.GetSecretAsync("my-secret"); }
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(failure.Message);
}
${lifecycle}`,
    `${client}
try { ${lifecycle} }
catch (RequestFailedException failure) { }`,
    `${client}
try { ${lifecycle} }
catch (Exception failure)
{
    Console.Error.WriteLine(failure.Message);
}`,
    `${client}
try { ${lifecycle} }
catch (RequestFailedException failure)
{
    Console.Error.WriteLine("request failed");
}`,
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/request-failed-error", workspace(source)),
      false,
      source,
    );
  }

  const filtered = `${client}
try { ${lifecycle} }
catch (Exception failure) when (failure is RequestFailedException)
{
    throw failure;
}`;
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(filtered)),
    true,
  );
});

test("every unrelated catch path must preserve its exception", () => {
  const unsafeHandlers = [
    `catch (InvalidOperationException failure) { }`,
    `catch (InvalidOperationException failure)
     { Console.Error.WriteLine(failure.Message); }`,
    `catch (InvalidOperationException failure) { return; }`,
    `catch (InvalidOperationException failure)
     { throw new Exception("replacement"); }`,
    `catch (InvalidOperationException failure)
     { if (ShouldThrow()) throw; }`,
    `catch (Exception failure) when (failure is InvalidOperationException)
     { Console.Error.WriteLine(failure.Message); }`,
  ];
  for (const handler of unsafeHandlers) {
    const source = `${handled()}
try { OtherWork(); }
${handler}`;
    assert.equal(
      evaluateRule("prompt/request-failed-error", workspace(source)),
      false,
      handler,
    );
  }

  const safeHandlers = [
    `catch (InvalidOperationException) { throw; }`,
    `catch (InvalidOperationException failure) { throw failure; }`,
    `catch (InvalidOperationException failure)
     { throw new Exception("wrapped", failure); }`,
    `catch (InvalidOperationException failure)
     {
       if (ShouldWrap())
         throw new Exception("wrapped", failure);
       else
         throw failure;
     }`,
  ];
  for (const handler of safeHandlers) {
    const source = `${handled()}
try { OtherWork(); }
${handler}`;
    assert.equal(
      evaluateRule("prompt/request-failed-error", workspace(source)),
      true,
      handler,
    );
  }
});

test("loops and labels cannot conceal swallowed catch paths", () => {
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
    const source = `${handled()}
try { OtherWork(); }
catch (InvalidOperationException failure) ${body}`;
    assert.equal(
      evaluateRule("prompt/request-failed-error", workspace(source)),
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
         throw new Exception("wrapped", failure);
       else
         throw failure;
     }`,
  ];
  for (const body of safe) {
    const source = `${handled()}
try { OtherWork(); }
catch (InvalidOperationException failure) ${body}`;
    assert.equal(
      evaluateRule("prompt/request-failed-error", workspace(source)),
      true,
      body,
    );
  }
});

test("comments, strings, unreachable decoys, and missing source cannot pass", () => {
  const source = `
${imports}
/* ${handled()} */
string documentation = """
${handled()}
""";
static async Task Decoy()
{
${handled()}
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/key-vault-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/key-vault-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
  }
});

test("tri-state guards follow bindings, aliases, reassignment, and operators", () => {
  const guarded = (setup, condition) => handled(`
${setup}
if (${condition})
{
${lifecycle}
}`);

  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      workspace(guarded("bool enabled = false;", "enabled")),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-purge",
      workspace(guarded("bool enabled = IsEnabled();", "enabled")),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-purge",
      workspace(guarded(
        `bool disabled = true;
bool alias = disabled;
disabled = false;`,
        "!((disabled)) && (alias || IsEnabled())",
      )),
    ),
    true,
  );
});

test("branch joins merge boolean environments", () => {
  const joined = (left, right) => handled(`
bool enabled = false;
if (ChooseBranch())
{
    enabled = ${left};
}
else
{
    enabled = ${right};
}
if (enabled)
{
${lifecycle}
}`);
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(joined("true", "true"))),
    true,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(joined("false", "false"))),
    false,
  );
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(joined("true", "false"))),
    true,
  );
});

test("return and throw guards constrain continuation paths", () => {
  for (const abrupt of ["return", 'throw new InvalidOperationException("stop")']) {
    const source = handled(`
bool stop = ShouldStop();
if (stop) ${abrupt};
${lifecycle}`);
    assert.equal(
      evaluateRule("prompt/delete-wait-purge", workspace(source)),
      true,
      abrupt,
    );
  }

  const terminated = handled(`
if (UsePrefix())
{
    await client.SetSecretAsync("my-secret", "my-secret-value");
    var response = await client.GetSecretAsync("my-secret");
    Console.WriteLine(response.Value.Value);
    await client.SetSecretAsync("my-secret", "updated-value");
    return;
}
var operation = await client.StartDeleteSecretAsync("my-secret");
await operation.WaitForCompletionAsync();
await client.PurgeDeletedSecretAsync("my-secret");`);
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(terminated)),
    false,
  );
});

test("MSBuild properties expand in case-insensitive document order", () => {
  const project = `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
      <BaseVersion>1.21.0</BaseVersion>
      <IdentityVersion>$(baseversion)</IdentityVersion>
      <SecretsVersion>4.11.0</SecretsVersion>
      <TargetFramework>net8.0</TargetFramework>
      <BaseVersion>9.0.0</BaseVersion>
    </PropertyGroup>
    <ItemGroup Condition="'$(TargetFramework)' == 'net8.0'">
      <PackageReference Include="azure.identity"
                        Version="$(IDENTITYVERSION)" />
      <PackageReference Include="Azure.Security.KeyVault.Secrets"
                        Version="$(SecretsVersion)" />
    </ItemGroup>
    <PropertyGroup>
      <IdentityVersion>9.0.0</IdentityVersion>
      <SecretsVersion>9.0.0</SecretsVersion>
    </PropertyGroup>
  </Project>`;
  assert.equal(
    evaluateRule(
      "prompt/key-vault-manifest",
      workspace(completeWorkspace.source, project),
    ),
    true,
  );
});

test("MSBuild Choose uses first-match path semantics", () => {
  const references = `
    <ItemGroup>
      <PackageReference Include="Azure.Identity" Version="1.21.0" />
      <PackageReference Include="Azure.Security.KeyVault.Secrets"
                        Version="4.11.0" />
    </ItemGroup>`;
  const project = (choose) => `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
    ${choose}
  </Project>`;
  const unknownReachable = project(`<Choose>
    <When Condition="$(UnknownFlag)">${references}</When>
    <Otherwise><ItemGroup /></Otherwise>
  </Choose>`);
  assert.equal(
    evaluateRule(
      "prompt/key-vault-manifest",
      workspace(completeWorkspace.source, unknownReachable),
    ),
    true,
  );

  const incompatibleForks = project(`<Choose>
    <When Condition="$(UnknownFlag)">
      <ItemGroup>
        <PackageReference Include="Azure.Identity" Version="1.21.0" />
      </ItemGroup>
    </When>
    <Otherwise>
      <ItemGroup>
        <PackageReference Include="Azure.Security.KeyVault.Secrets"
                          Version="4.11.0" />
      </ItemGroup>
    </Otherwise>
  </Choose>`);
  assert.equal(
    evaluateRule(
      "prompt/key-vault-manifest",
      workspace(completeWorkspace.source, incompatibleForks),
    ),
    false,
  );

  const firstTrue = project(`<Choose>
    <When Condition="true">${references}</When>
    <When Condition="true"><ItemGroup /></When>
    <Otherwise><ItemGroup /></Otherwise>
  </Choose>`);
  assert.equal(
    evaluateRule(
      "prompt/key-vault-manifest",
      workspace(completeWorkspace.source, firstTrue),
    ),
    true,
  );
});

test("known helper guard arguments control lifecycle reachability", () => {
  const source = (argument) => `${imports}
static async Task LifecycleAsync(bool enabled, SecretClient client)
{
    if (enabled)
    {
${lifecycle}
    }
}

var credential = new DefaultAzureCredential();
var client = new SecretClient(
    new Uri("https://example.vault.azure.net"), credential);
try
{
    await LifecycleAsync(${argument}, client);
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(failure.Message);
}`;
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(source("false"))),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      workspace(
        source("enabled").replace(
          "try\n{",
          "bool enabled = false;\ntry\n{",
        ),
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-purge",
      workspace(source("ShouldRun()")),
    ),
    true,
  );
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(source("true"))),
    true,
  );
});

test("all eight rules require generated C# source, including the manifest", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source: "", sourceFiles: [] }),
      false,
      rule,
    );
  }
});

test("for and foreach loops suppress known-empty bodies but keep unknown paths", () => {
  const looped = (header) => handled(`
${header}
{
${lifecycle}
}`);
  for (const header of [
    "for (var index = 0; false; index++)",
    "foreach (var item in Array.Empty<int>())",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", workspace(looped(header))),
      false,
      header,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-purge",
      workspace(looped("for (var index = 0; ShouldRun(); index++)")),
    ),
    true,
  );
});

test("catch lifecycle paths require a potentially throwing try body", () => {
  const source = (tryBody) => `${client}
try
{
    ${tryBody}
}
catch (RequestFailedException failure)
{
${lifecycle}
}`;
  for (const body of [
    "",
    "int value = 1;",
    "if (false) { OtherWork(); }",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", workspace(source(body))),
      false,
      body,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      workspace(
        `${imports}
static void Harmless() { int value = 1; }
${source("Harmless();")}`,
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-purge",
      workspace(source("OtherWork();")),
    ),
    true,
  );
});

test("conditional arms cannot combine and short-circuit helpers are path-aware", () => {
  const syncPrefix = `
static bool Prefix(SecretClient client)
{
    client.SetSecret("my-secret", "my-secret-value");
    var response = client.GetSecret("my-secret");
    Console.WriteLine(response.Value.Value);
    client.SetSecret("my-secret", "updated-value");
    return true;
}
static bool Suffix(SecretClient client)
{
    var operation = client.StartDeleteSecret("my-secret");
    operation.WaitForCompletion();
    client.PurgeDeletedSecret("my-secret");
    return true;
}`;
  const conditional = `${imports}
${syncPrefix}
var credential = new DefaultAzureCredential();
var client = new SecretClient(
    new Uri("https://example.vault.azure.net"), credential);
try
{
    bool completed = ShouldRun() ? Prefix(client) : Suffix(client);
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(failure.Message);
}`;
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(conditional)),
    false,
  );

  const guarded = (expression) => `${imports}
static bool Lifecycle(SecretClient client)
{
    client.SetSecret("my-secret", "my-secret-value");
    var response = client.GetSecret("my-secret");
    Console.WriteLine(response.Value.Value);
    client.SetSecret("my-secret", "updated-value");
    var operation = client.StartDeleteSecret("my-secret");
    operation.WaitForCompletion();
    client.PurgeDeletedSecret("my-secret");
    return true;
}
var credential = new DefaultAzureCredential();
var client = new SecretClient(
    new Uri("https://example.vault.azure.net"), credential);
try
{
    bool completed = ${expression};
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(failure.Message);
}`;
  for (const expression of [
    "false && Lifecycle(client)",
    "true || Lifecycle(client)",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", workspace(guarded(expression))),
      false,
      expression,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-purge",
      workspace(guarded("ShouldRun() && Lifecycle(client)")),
    ),
    true,
  );
});

test("iterable aliases use their current source-order value", () => {
  const looped = (setup) => handled(`
${setup}
foreach (var item in selected)
{
${lifecycle}
}`);
  for (const setup of [
    "int[] selected = [];",
    "int[] selected = [1];\nint[] alias = selected;\nselected = [];\nselected = alias;\nselected = [];",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", workspace(looped(setup))),
      false,
      setup,
    );
  }
  for (const setup of [
    "int[] selected = [];\nselected = [1];",
    `int[] selected = [1];
int[] alias = selected;
selected = [];
selected = alias;`,
    "var selected = GetItems();",
  ]) {
    assert.equal(
      evaluateRule("prompt/delete-wait-purge", workspace(looped(setup))),
      true,
      setup,
    );
  }
});

test("C# helper defaults and folded strings require exact constants", () => {
  const helper = (call) => `${imports}
static void Lifecycle(
    SecretClient client,
    string name = "my-secret",
    string initial = "my-secret-value",
    string updated = "updated-value")
{
    client.SetSecret(name, initial);
    var response = client.GetSecret(name);
    Console.WriteLine(response.Value.Value);
    client.SetSecret(name, updated);
    var operation = client.StartDeleteSecret(name);
    operation.WaitForCompletion();
    client.PurgeDeletedSecret(name);
}
${handled(call).replace(imports, "")}`;
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-purge",
      workspace(helper("Lifecycle(client);")),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/update-secret",
      workspace(helper('Lifecycle(client, updated: "wrong");')),
    ),
    false,
  );

  const folded = handled(`
string prefix = "my-";
string name = $"{prefix}secret";
string initial = "my-" + ("secret-value");
string updated = "updated-" + "value";
client.SetSecret(name, initial);
var response = client.GetSecret(name);
Console.WriteLine(response.Value.Value);
client.SetSecret(name, updated);
var operation = client.StartDeleteSecret(name);
operation.WaitForCompletion();
client.PurgeDeletedSecret(name);`);
  assert.equal(
    evaluateRule("prompt/delete-wait-purge", workspace(folded)),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      workspace(folded.replace(
        'string name = $"{prefix}secret";',
        'prefix = GetPrefix();\nstring name = $"{prefix}secret";',
      )),
    ),
    false,
  );
});
