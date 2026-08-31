import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadWorkspace,
  ruleNames,
} from "./tools/resource-group-dotnet-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadWorkspace(goldenRoot);
const baseline33374429826 = loadWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33374429826", import.meta.url),
  ),
);

function workspace(source, project = completeWorkspace.project) {
  return { ...completeWorkspace, project, source };
}

function sourceForms(source) {
  return [
    ["LF", source.replace(/\r?\n/g, "\n")],
    ["CRLF", source.replace(/\r?\n/g, "\r\n")],
  ];
}

function manifest({
  target = "net8.0",
  identity = "1.21.0",
  resourceManager = "1.14.0",
} = {}) {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>${target}</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="${identity}" />
    <PackageReference Include="Azure.ResourceManager" Version="${resourceManager}" />
  </ItemGroup>
</Project>`;
}

const imports = `
using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.Resources;
using Azure.ResourceManager.Resources.Models;
`;

const setup = `${imports}
string subscriptionId =
    Environment.GetEnvironmentVariable("AZURE_SUBSCRIPTION_ID")
    ?? throw new InvalidOperationException();
string resourceGroupName =
    Environment.GetEnvironmentVariable("AZURE_RESOURCE_GROUP_NAME")
    ?? throw new InvalidOperationException();
string location =
    Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus";
var client = new ArmClient(new DefaultAzureCredential(), subscriptionId);
var subscription = await client.GetDefaultSubscriptionAsync();
var groups = subscription.GetResourceGroups();
`;

const lifecycle = `
var create = await groups.CreateOrUpdateAsync(
    WaitUntil.Completed,
    resourceGroupName,
    new ResourceGroupData(location));
var created = create.Value;
await foreach (var item in groups.GetAllAsync())
{
    Console.WriteLine(item.Data.Name);
}
var group = (await groups.GetAsync(resourceGroupName)).Value;
Console.WriteLine(group.Data.Name);
var patch = new ResourceGroupPatch();
patch.Tags.Add("environment", "development");
var updated = (await group.UpdateAsync(patch)).Value;
var applied = updated.Data.Tags["environment"];
Console.WriteLine(applied);
await updated.DeleteAsync(WaitUntil.Completed);
Console.WriteLine(resourceGroupName);
`;

function handled(body = lifecycle) {
  return `${setup}
try
{
${body}
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(
        $"ARM failed ({failure.Status}, {failure.ErrorCode}): {failure.Message}");
}`;
}

test("golden passes exactly the nine-criterion contract", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("baseline run 33374429826 exact output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
});

test("source manifest accepts active pinned net8 forms", () => {
  const projects = [
    manifest(),
    `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup>
        <NetVersion>net8.0</NetVersion>
        <TargetFrameworks>net7.0;$(NetVersion)</TargetFrameworks>
        <IdentityVersion>1.21.0</IdentityVersion>
        <ArmVersion>1.14.0</ArmVersion>
      </PropertyGroup>
      <Choose>
        <When Condition="true">
          <ItemGroup>
            <PackageReference Include="azure.identity"
                              Version="[$(IdentityVersion)]" />
            <PackageReference Include="AZURE.RESOURCEMANAGER">
              <Version>[$(ArmVersion)]</Version>
            </PackageReference>
          </ItemGroup>
        </When>
      </Choose>
    </Project>`,
  ];
  for (const project of projects) {
    assert.equal(
      evaluateRule("prompt/source-manifest", workspace(setup, project)),
      true,
      project,
    );
  }
});

test("source manifest rejects inactive, wrong, floating, and split pins", () => {
  const projects = [
    manifest({ target: "net7.0" }),
    manifest({ identity: "1.22.0" }),
    manifest({ resourceManager: "1.15.0" }),
    manifest({ resourceManager: "1.*" }),
    manifest().replace(
      '<PackageReference Include="Azure.Identity" Version="1.21.0" />',
      '<PackageReference Include="Azure.Identity" Version="1.21.0" Condition="false" />',
    ),
    `${manifest({ identity: "0.0.0" })}
     ${manifest({ resourceManager: "0.0.0" })}`,
    manifest().replace(
      '<PackageReference Include="Azure.ResourceManager" Version="1.14.0" />',
      '<!-- <PackageReference Include="Azure.ResourceManager" Version="1.14.0" /> -->',
    ),
  ];
  for (const project of projects) {
    assert.equal(
      evaluateRule("prompt/source-manifest", workspace(setup, project)),
      false,
      project,
    );
  }
});

test("focused golden omissions fail their own criterion", () => {
  const cases = (source) => [
    [
      "prompt/credential-arm-client",
      source.replace(
        "new DefaultAzureCredential()",
        "otherCredential",
      ),
    ],
    [
      "prompt/default-subscription-groups",
      source.replace(
        "subscription.GetResourceGroups()",
        "otherSubscription.GetResourceGroups()",
      ),
    ],
    [
      "prompt/create-resource-group",
      source.replace(
        /WaitUntil\.Completed,(\r?\n\s+resourceGroupName)/,
        "WaitUntil.Started,$1",
      ),
    ],
    [
      "prompt/create-resource-group",
      source.replace(
        'Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus"',
        'Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "westus"',
      ),
    ],
    [
      "prompt/list-resource-groups",
      source.replace(
        'Console.WriteLine($"Resource group: {item.Data.Name}");',
        'Console.WriteLine("resource group");',
      ),
    ],
    [
      "prompt/get-resource-group",
      source.replace(
        "resourceGroup.Data.Name",
        "created.Data.Name",
      ),
    ],
    [
      "prompt/update-resource-group",
      source.replace(
        '"development"',
        '"production"',
      ),
    ],
    [
      "prompt/delete-resource-group",
      source.replace(
        /WaitUntil\.Completed\);(\r?\n\s+Console\.WriteLine\(\$"Deleted)/,
        "WaitUntil.Started);$1",
      ),
    ],
    [
      "prompt/request-failed-error",
      source.replace(
        "catch (RequestFailedException exception)",
        "catch (Exception exception)",
      ),
    ],
  ];

  for (const [lineEnding, source] of sourceForms(completeWorkspace.source)) {
    for (const [rule, mutated] of cases(source)) {
      assert.notEqual(mutated, source, `${lineEnding}:${rule}: mutation`);
      assert.equal(
        evaluateRule(rule, workspace(mutated)),
        false,
        `${lineEnding}:${rule}`,
      );
    }
  }
});

test("fully synchronous current SDK lifecycle is accepted", () => {
  const source = `${imports}
var subscriptionId = Environment.GetEnvironmentVariable(
    "AZURE_SUBSCRIPTION_ID");
var resourceGroupName = Environment.GetEnvironmentVariable(
    "AZURE_RESOURCE_GROUP_NAME");
var location = "eastus";
var client = new ArmClient(new DefaultAzureCredential(), subscriptionId);
var subscription = client.GetDefaultSubscription();
var groups = subscription.GetResourceGroups();
try
{
    var create = groups.CreateOrUpdate(
        WaitUntil.Completed, resourceGroupName, new ResourceGroupData(location));
    foreach (var item in groups.GetAll())
    {
        Console.WriteLine(item.Data.Name);
    }
    var group = groups.Get(resourceGroupName).Value;
    Console.WriteLine(group.Data.Location);
    var patch = new ResourceGroupPatch();
    patch.Tags["environment"] = "development";
    var updated = group.Update(patch).Value;
    var applied = updated.Data.Tags["environment"];
    Console.WriteLine(applied);
    updated.Delete(WaitUntil.Completed);
    Console.WriteLine(resourceGroupName);
}
catch (RequestFailedException failure)
{
    Console.Error.WriteLine(
        $"ARM failed ({failure.Status}): {failure.Message}");
    throw new InvalidOperationException("ARM lifecycle failed", failure);
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("Started operations require an exact reachable completion wait", () => {
  const started = handled(
    lifecycle
      .replace(
        "WaitUntil.Completed,\n    resourceGroupName",
        "WaitUntil.Started,\n    resourceGroupName",
      )
      .replace(
        "var created = create.Value;",
        "await create.WaitForCompletionAsync();\nvar created = create.Value;",
      )
      .replace(
        "await updated.DeleteAsync(WaitUntil.Completed);",
        `var deletion = await updated.DeleteAsync(WaitUntil.Started);
await deletion.WaitForCompletionAsync();`,
      ),
  );
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(started)),
    true,
  );

  const missingCreateWait = started.replace(
    "await create.WaitForCompletionAsync();",
    "",
  );
  assert.equal(
    evaluateRule("prompt/create-resource-group", workspace(missingCreateWait)),
    false,
  );

  const missingDeleteWait = started.replace(
    "await deletion.WaitForCompletionAsync();",
    "",
  );
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(missingDeleteWait)),
    false,
  );

  const wrongWait = started.replace(
    "await deletion.WaitForCompletionAsync();",
    "await create.WaitForCompletionAsync();",
  );
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(wrongWait)),
    false,
  );
});

test("hardcoded and premature delete confirmations are rejected", () => {
  const hardcoded = handled(
    lifecycle.replace(
      "Console.WriteLine(resourceGroupName);",
      'Console.WriteLine("Deleted resource group.");',
    ),
  );
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(hardcoded)),
    false,
  );

  const premature = handled(
    lifecycle.replace(
      `await updated.DeleteAsync(WaitUntil.Completed);
Console.WriteLine(resourceGroupName);`,
      `Console.WriteLine(resourceGroupName);
await updated.DeleteAsync(WaitUntil.Completed);`,
    ),
  );
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(premature)),
    false,
  );
});

test("resource names, collections, clients, and update results stay connected", () => {
  const cases = [
    [
      "prompt/get-resource-group",
      lifecycle.replace(
        "groups.GetAsync(resourceGroupName)",
        "groups.GetAsync(otherName)",
      ),
    ],
    [
      "prompt/update-resource-group",
      lifecycle.replace(
        "group.UpdateAsync(patch)",
        "otherGroup.UpdateAsync(patch)",
      ),
    ],
    [
      "prompt/delete-resource-group",
      lifecycle.replace(
        "updated.DeleteAsync",
        "otherGroup.DeleteAsync",
      ),
    ],
    [
      "prompt/list-resource-groups",
      lifecycle.replace(
        "groups.GetAllAsync()",
        "otherGroups.GetAllAsync()",
      ),
    ],
  ];
  for (const [rule, body] of cases) {
    assert.equal(
      evaluateRule(rule, workspace(handled(body))),
      false,
      rule,
    );
  }
});

test("ordered lifecycle must share one reachable branch", () => {
  const split = handled(`
if (ChooseFirst())
{
${lifecycle.slice(0, lifecycle.indexOf("var group"))}
}
else
{
${lifecycle.slice(lifecycle.indexOf("var group"))}
}`);
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(split)),
    false,
  );

  const unreachable = handled(`if (false) { ${lifecycle} }`);
  assert.equal(
    evaluateRule("prompt/create-resource-group", workspace(unreachable)),
    false,
  );
});

test("qualified types, aliases, named arguments, and target typing pass", () => {
  const source = `
using Azure;
using Identity = Azure.Identity;
using ARM = Azure.ResourceManager;
using Resources = Azure.ResourceManager.Resources;
using Models = Azure.ResourceManager.Resources.Models;
using W = Azure.WaitUntil;
var subscriptionId = System.Environment.GetEnvironmentVariable(
    "AZURE_SUBSCRIPTION_ID");
var resourceGroupName = System.Environment.GetEnvironmentVariable(
    "AZURE_RESOURCE_GROUP_NAME");
var location = System.Environment.GetEnvironmentVariable("AZURE_LOCATION")
    ?? "eastus";
Identity.DefaultAzureCredential credential = new();
ARM.ArmClient client = new(
    defaultSubscriptionId: subscriptionId,
    credential: credential);
Resources.SubscriptionResource subscription =
    await client.GetDefaultSubscriptionAsync();
Resources.ResourceGroupCollection groups = subscription.GetResourceGroups();
try
{
    Resources.ResourceGroupData data = new(location);
    Azure.ArmOperation<Resources.ResourceGroupResource> creation =
        await groups.CreateOrUpdateAsync(
            data: data, name: resourceGroupName, waitUntil: W.Completed);
    await foreach (Resources.ResourceGroupResource item in groups.GetAllAsync())
    {
        System.Console.WriteLine(item.Data.Name);
    }
    Resources.ResourceGroupResource group =
        (await groups.GetAsync(name: resourceGroupName)).Value;
    System.Console.WriteLine(group.Data.Name);
    Models.ResourceGroupPatch patch = new();
    patch.Tags.Add("environment", "development");
    Resources.ResourceGroupResource updated =
        (await group.UpdateAsync(patch: patch)).Value;
    string tag = updated.Data.Tags["environment"];
    System.Console.WriteLine(tag);
    await updated.DeleteAsync(waitUntil: W.Completed);
    System.Console.WriteLine(resourceGroupName);
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

test("non-empty location fallback and explicit AzureLocation are accepted", () => {
  const source = handled(
    lifecycle
      .replace(
        "new ResourceGroupData(location)",
        "new ResourceGroupData(new AzureLocation(location))",
      ),
  ).replace(
    `string location =
    Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus";`,
    `string location =
    Environment.GetEnvironmentVariable("AZURE_LOCATION") is { Length: > 0 } configured
        ? configured
        : "eastus";`,
  );

  assert.equal(
    evaluateRule("prompt/create-resource-group", workspace(source)),
    true,
  );
});

test("interpolated updated tag output remains connected", () => {
  const source = handled(
    lifecycle.replace(
      `var applied = updated.Data.Tags["environment"];
Console.WriteLine(applied);`,
      `Console.WriteLine(
    $"Applied tag: {updated.Data.Tags["environment"]}");`,
    ),
  );

  assert.equal(
    evaluateRule("prompt/update-resource-group", workspace(source)),
    true,
  );
});

test("unqualified SDK symbols reject missing imports and local fakes", () => {
  const missingImports = handled()
    .replace("using Azure.Identity;", "")
    .replace("using Azure.ResourceManager;", "")
    .replace("using Azure.ResourceManager.Resources;", "");
  assert.equal(
    evaluateRule("prompt/credential-arm-client", workspace(missingImports)),
    false,
  );

  const fake = `${imports}
sealed class ArmClient
{
    public ArmClient(object credential, string subscriptionId) {}
}
sealed class DefaultAzureCredential {}
${handled().replace(imports, "")}`;
  assert.equal(
    evaluateRule("prompt/credential-arm-client", workspace(fake)),
    false,
  );
});

test("reachable helpers preserve lifecycle associations; decoys do not", () => {
  const reachable = handled(
    lifecycle
      .replace(
        `var group = (await groups.GetAsync(resourceGroupName)).Value;
Console.WriteLine(group.Data.Name);`,
        `var group = await ReadAsync(groups, resourceGroupName);
Console.WriteLine(group.Data.Name);`,
      )
      .replace(
        "await updated.DeleteAsync(WaitUntil.Completed);",
        "await DeleteAsync(updated);",
      ) +
      `
static async Task<ResourceGroupResource> ReadAsync(
    ResourceGroupCollection groups, string name)
{
    return (await groups.GetAsync(name)).Value;
}
static async Task DeleteAsync(ResourceGroupResource group)
{
    await group.DeleteAsync(WaitUntil.Completed);
}`,
  );
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(reachable)),
    true,
  );

  const decoy = `${setup}
static async Task Decoy(
    ResourceGroupCollection groups, string resourceGroupName, string location)
{
${lifecycle}
}`;
  assert.equal(
    evaluateRule("prompt/create-resource-group", workspace(decoy)),
    false,
  );
});

test("RequestFailedException handling is meaningful and all other catches are causal", () => {
  const swallowed = handled().replace(
    "catch (RequestFailedException failure)",
    `catch (Exception)
{
}
catch (RequestFailedException failure)`,
  );
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(swallowed)),
    false,
  );

  const causal = handled().replace(
    "catch (RequestFailedException failure)",
    `catch (Exception exception) when (exception is not RequestFailedException)
{
    throw new InvalidOperationException("Unexpected ARM failure", exception);
}
catch (RequestFailedException failure)`,
  );
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(causal)),
    true,
  );

  const hardcoded = handled().replace(
    `Console.Error.WriteLine(
        $"ARM failed ({failure.Status}, {failure.ErrorCode}): {failure.Message}");`,
    'Console.Error.WriteLine("ARM failed");',
  );
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(hardcoded)),
    false,
  );

  const reportedButSwallowed = handled().replace(
    "catch (RequestFailedException failure)",
    `catch (InvalidOperationException exception)
{
    Console.Error.WriteLine(exception.Message);
}
catch (RequestFailedException failure)`,
  );
  assert.equal(
    evaluateRule(
      "prompt/request-failed-error",
      workspace(reportedButSwallowed),
    ),
    false,
  );

  const reportedAndFailed = handled().replace(
    "catch (RequestFailedException failure)",
    `catch (InvalidOperationException exception)
{
    Console.Error.WriteLine($"Configuration failed: {exception}");
    return 1;
}
catch (RequestFailedException failure)`,
  );
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(reportedAndFailed)),
    true,
  );

  const successfulExit = reportedAndFailed.replace("return 1;", "return 0;");
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(successfulExit)),
    false,
  );
});

test("request failure diagnostics reject propagation-only and unused details", () => {
  const diagnostic = `Console.Error.WriteLine(
        $"ARM failed ({failure.Status}, {failure.ErrorCode}): {failure.Message}");`;
  const invalidBodies = [
    "throw;",
    "throw failure;",
    'throw new InvalidOperationException("ARM failed", failure);',
    `Console.Error.WriteLine("ARM failed", failure.Message);
    throw;`,
    `Console.Error.WriteLine("ARM failed");
    _ = failure.Message;`,
    `throw;
    Console.Error.WriteLine(failure.Message);`,
    `if (false)
        Console.Error.WriteLine(failure.Message);
    throw;`,
    "",
  ];
  for (const body of invalidBodies) {
    const source = handled().replace(diagnostic, body);
    assert.equal(
      evaluateRule("prompt/request-failed-error", workspace(source)),
      false,
      body,
    );
  }

  const noOpHelper = handled().replace(
    diagnostic,
    `IgnoreFailure(failure);
    throw;`,
  ) + `
static void IgnoreFailure(RequestFailedException failure)
{
    Console.Error.WriteLine("ARM failed");
}`;
  assert.equal(
    evaluateRule("prompt/request-failed-error", workspace(noOpHelper)),
    false,
  );
});

test("request failure diagnostics accept aliases, loggers, and helpers", () => {
  const diagnostic = `Console.Error.WriteLine(
        $"ARM failed ({failure.Status}, {failure.ErrorCode}): {failure.Message}");`;
  const positives = [
    handled().replace(
      diagnostic,
      `var current = failure;
    System.Diagnostics.Trace.TraceError(
        $"ARM status {current.Status}: {current.Message}");
    throw;`,
    ),
    handled().replace(
      diagnostic,
      `logger.LogError(failure, "ARM lifecycle failed");
    throw new InvalidOperationException("ARM lifecycle failed", failure);`,
    ),
    handled().replace(
      diagnostic,
      `ReportFailure(
        failure.Status, failure.Message);
    return;`,
    ) + `
static void ReportFailure(int status, string message)
{
    Console.Error.WriteLine($"ARM status {status}: {message}");
}`,
    handled()
      .replace(
        "catch (RequestFailedException failure)",
        `catch (Exception exception)
    when (exception is global::Azure.RequestFailedException failure)`,
      )
      .replace(
        diagnostic,
        `Console.Error.WriteLine(failure.ToString());
    throw exception;`,
      ),
    handled()
      .replace(imports, `${imports}
using RequestFailure = global::Azure.RequestFailedException;`)
      .replace(
        "catch (RequestFailedException failure)",
        "catch (RequestFailure failure)",
      ),
  ];
  for (const source of positives) {
    assert.equal(
      evaluateRule("prompt/request-failed-error", workspace(source)),
      true,
      source,
    );
  }
});

test("request diagnostics consume composite and structured placeholders", () => {
  const diagnostic = `Console.Error.WriteLine(
        $"ARM failed ({failure.Status}, {failure.ErrorCode}): {failure.Message}");`;
  const helper = handled().replace(
    diagnostic,
    `ReportFailure(failure.Status, failure.Message);
    throw;`,
  ) + `
static void ReportFailure(int status, string message)
{
    Console.Error.WriteLine("ARM {0,6:X}: {1}", status, message);
}`;
  const positives = [
    handled().replace(
      diagnostic,
      `Console.Error.WriteLine(
        format: "ARM {0,6}: {1}", arg0: failure.Status,
        arg1: failure.Message);
    throw;`,
    ),
    handled().replace(
      diagnostic,
      `logger.LogError(
        failure, "ARM {Status}: {Message}",
        failure.Status, failure.Message);
    throw;`,
    ),
    handled().replace(
      diagnostic,
      `logger.LogError(
        exception: failure,
        message: $"ARM {failure.Message}");
    throw;`,
    ),
    helper,
  ];
  for (const source of positives) {
    assert.equal(
      evaluateRule("prompt/request-failed-error", workspace(source)),
      true,
      source,
    );
  }
});

test("request diagnostics reject escaped, wrong, and unused slots", () => {
  const diagnostic = `Console.Error.WriteLine(
        $"ARM failed ({failure.Status}, {failure.ErrorCode}): {failure.Message}");`;
  const bodies = [
    `Console.Error.WriteLine("ARM {{0}}", failure.Message);
    throw;`,
    `Console.Error.WriteLine("ARM {1}", failure.Message);
    throw;`,
    `Console.Error.WriteLine(
        format: "ARM {0}", arg1: failure.Message);
    throw;`,
    `Console.Error.WriteLine(
        "ARM {0}", "fixed", failure.Message);
    throw;`,
    `logger.LogError(
        "ARM {Status}", "fixed", failure.Message);
    throw;`,
    `logger.LogError("ARM {{Status}}", failure.Message);
    throw;`,
  ];
  for (const body of bodies) {
    const source = handled().replace(diagnostic, body);
    assert.equal(
      evaluateRule("prompt/request-failed-error", workspace(source)),
      false,
      body,
    );
  }
});
