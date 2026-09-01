import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateTypeScriptCheck,
  typeScriptCheckNames,
} from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/resource-manager-typescript-rules.mjs";
import {
  activeDependencies,
  loadSourceManifest,
  sourceDocuments,
} from "./tools/source-manifest.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadSourceManifest(goldenPath);
const baseline33441637671 = loadSourceManifest(
  fileURLToPath(
    new URL("./fixtures/baseline-33441637671", import.meta.url),
  ),
);

function withSource(source, packageJson = golden.packageJson, path = "src/app.ts") {
  return {
    ...golden,
    documents: source.trim() ? [{ path, source }] : [],
    packageJson,
    source,
    sourceFiles: source.trim() ? [path] : [],
  };
}

const imports = `
import { ResourceManagementClient } from "@azure/arm-resources";
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";`;

const lifecycle = `
    const created = await client.resourceGroups.createOrUpdate(name, { location });
    console.log("Created:", created);
    for await (const group of client.resourceGroups.list()) {
      console.log("Resource group:", group);
    }
    const retrieved = await client.resourceGroups.get(name);
    console.log("Retrieved:", retrieved);
    const updated = await client.resourceGroups.update(name, {
      tags: { environment: "development" },
    });
    console.log("Updated:", updated);
    await client.resourceGroups.beginDeleteAndWait(name);
    console.log(\`Deleted resource group \${name}\`);`;

function program(body = lifecycle, selectedImports = imports) {
  return withSource(`${selectedImports}
async function main() {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
  const name = process.env.AZURE_RESOURCE_GROUP_NAME!;
  const location = "eastus";
  const credential = new DefaultAzureCredential();
  const client = new ResourceManagementClient(credential, subscriptionId);
  try {
${body}
  } catch (error) {
    if (error instanceof RestError) {
      console.error(error.statusCode, error.message);
    }
    throw error;
  }
}
await main();
`);
}

test("reference has exactly nine passing prompt criteria", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/packages",
    "prompt/environment",
    "prompt/authenticated-client",
    "prompt/create-and-output",
    "prompt/list-and-output",
    "prompt/get-and-output",
    "prompt/update-and-output",
    "prompt/delete-wait-confirm",
    "prompt/error-handling",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test("reference passes reusable TypeScript checks", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(evaluateTypeScriptCheck(check, golden), true, check);
  }
});

test("baseline run 33441637671 retains only its genuine environment failure", () => {
  const expected = new Map([
    ["prompt/packages", true],
    ["prompt/environment", false],
    ["prompt/authenticated-client", true],
    ["prompt/create-and-output", true],
    ["prompt/list-and-output", true],
    ["prompt/get-and-output", true],
    ["prompt/update-and-output", true],
    ["prompt/delete-wait-confirm", true],
    ["prompt/error-handling", true],
  ]);
  for (const [rule, result] of expected) {
    assert.equal(evaluateRule(rule, baseline33441637671), result, rule);
  }
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, baseline33441637671),
      true,
      check,
    );
  }
});

test("corrected baseline environment name passes all nine prompt criteria", () => {
  const corrected = {
    ...baseline33441637671,
    documents: baseline33441637671.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        '"RESOURCE_GROUP_NAME"',
        '"AZURE_RESOURCE_GROUP_NAME"',
      ),
    })),
  };
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, corrected), true, rule);
  }
});

test("reachable output helpers preserve exact operation-result provenance", () => {
  const source = baseline33441637671.documents[0].source;
  const changed = (replacement) =>
    withSource(replacement, baseline33441637671.packageJson, "index.ts");
  for (const [label, mutation] of [
    [
      "ignored",
      source.replace(
        'printResource("Created resource group", created);',
        "void created;",
      ),
    ],
    [
      "hardcoded",
      source.replace(
        'printResource("Created resource group", created);',
        'printResource("Created resource group", { name: "fixed" });',
      ),
    ],
    [
      "overwritten helper parameter",
      source.replace(
        "function printResource(label: string, resource: unknown): void {",
        `function printResource(label: string, resource: unknown): void {
  resource = { name: "fixed" };`,
      ),
    ],
    [
      "unreachable helper call",
      source.replace(
        'printResource("Created resource group", created);',
        'if (false) printResource("Created resource group", created);',
      ),
    ],
  ]) {
    assert.equal(
      evaluateRule("prompt/create-and-output", changed(mutation)),
      false,
      label,
    );
  }

  const wrongList = source.replace(
    'printResource("Resource group", resourceGroup);',
    'printResource("Resource group", { name: "fixed" });',
  );
  assert.equal(
    evaluateRule("prompt/list-and-output", changed(wrongList)),
    false,
  );
});

test("terminal promise catch requires guarded details, failure exit, and causal rethrow", () => {
  const source = baseline33441637671.documents[0].source;
  const changed = (replacement) =>
    withSource(replacement, baseline33441637671.packageJson, "index.ts");
  const causal = source.replace(
    "  throw error;",
    '  throw new Error("Resource group lifecycle failed", { cause: error });',
  );
  assert.equal(evaluateRule("prompt/error-handling", changed(causal)), true);

  const terminalStart = source.indexOf("void main().catch");
  for (const [label, mutation] of [
    [
      "console shortcut",
      source.slice(0, terminalStart) + "main().catch(console.error);",
    ],
    [
      "fixed diagnostics",
      source
        .replace(
          "console.error(`Azure authentication failed: ${error.message}`);",
          'console.error("Authentication failed");',
        )
        .replace(
          "console.error(`Azure resource request failed${status}${code}: ${error.message}`);",
          'console.error("Resource request failed");',
        ),
    ],
    [
      "missing failure status",
      source.replace(/\s*process\.exitCode = 1;\r?\n/g, "\n"),
    ],
    ["swallowed unknown", source.replace("  throw error;", "  return;")],
  ]) {
    assert.equal(
      evaluateRule("prompt/error-handling", changed(mutation)),
      false,
      label,
    );
  }
});

test("source manifest is path ordered and dependencies are runtime-only", () => {
  const workspace = {
    documents: [
      { path: "z.ts", source: "const z = 1;" },
      { path: "a.ts", source: "const a = 1;" },
    ],
  };
  assert.deepEqual(
    sourceDocuments(workspace).map(({ path }) => path),
    ["a.ts", "z.ts"],
  );
  assert.deepEqual(activeDependencies('{"devDependencies":{"fake":"1"}}'), {});
  assert.deepEqual(activeDependencies("{broken"), {});
});

test("every criterion rejects missing generated source", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource("")), false, rule);
  }
});

test("SDK packages must be active dependencies", () => {
  for (const packageName of ["@azure/identity", "@azure/arm-resources"]) {
    const manifest = JSON.parse(golden.packageJson);
    manifest.devDependencies[packageName] = manifest.dependencies[packageName];
    delete manifest.dependencies[packageName];
    assert.equal(
      evaluateRule(
        "prompt/packages",
        withSource(golden.source, JSON.stringify(manifest)),
      ),
      false,
      packageName,
    );
  }
});

test("core-rest-pipeline is required only for a real RestError import", () => {
  const manifest = JSON.parse(golden.packageJson);
  delete manifest.dependencies["@azure/core-rest-pipeline"];
  const restWorkspace = program();
  restWorkspace.packageJson = JSON.stringify(manifest);
  assert.equal(
    evaluateRule("prompt/packages", restWorkspace),
    false,
  );

  const structural = program(
    lifecycle,
    imports.replace(
      'import { RestError } from "@azure/core-rest-pipeline";',
      "",
    ),
  );
  structural.source = structural.source
    .replace(
      /if \(error instanceof RestError\) \{[\s\S]*?\n    \}/,
      "if (error instanceof Error) {\n      console.error(error.message);\n    }",
    );
  structural.documents[0].source = structural.source;
  structural.packageJson = JSON.stringify(manifest);
  assert.equal(evaluateRule("prompt/packages", structural), true);
  assert.equal(evaluateRule("prompt/error-handling", structural), true);
});

test("aliases and namespace imports retain SDK provenance", () => {
  const aliasedImports = `
import * as resources from "@azure/arm-resources";
import * as pipeline from "@azure/core-rest-pipeline";
import { DefaultAzureCredential as Credential } from "@azure/identity";`;
  const workspace = program(lifecycle, aliasedImports);
  workspace.source = workspace.source
    .replaceAll("new ResourceManagementClient", "new resources.ResourceManagementClient")
    .replaceAll("new DefaultAzureCredential", "new Credential")
    .replaceAll("instanceof RestError", "instanceof pipeline.RestError");
  workspace.documents[0].source = workspace.source;
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test("inline and bound credentials authenticate the subscription client", () => {
  const inline = program().source.replace(
    "const credential = new DefaultAzureCredential();\n  " +
      "const client = new ResourceManagementClient(credential, subscriptionId);",
    "const client = new ResourceManagementClient(" +
      "new DefaultAzureCredential(), subscriptionId);",
  );
  for (const source of [program().source, inline]) {
    assert.equal(
      evaluateRule("prompt/authenticated-client", withSource(source)),
      true,
    );
  }
});

test("type-only imports and locally shadowed constructors are rejected", () => {
  for (const imported of [
    "DefaultAzureCredential",
    "ResourceManagementClient",
    "RestError",
  ]) {
    const source = program().source.replace(
      `import { ${imported} }`,
      `import type { ${imported} }`,
    );
    const rule = imported === "RestError"
      ? "prompt/error-handling"
      : "prompt/authenticated-client";
    assert.equal(evaluateRule(rule, withSource(source)), false, imported);
  }
  const shadowed = program().source.replace(
    "async function main() {",
    "async function main(ResourceManagementClient) {",
  );
  assert.equal(
    evaluateRule("prompt/authenticated-client", withSource(shadowed)),
    false,
  );
});

test("client, environment name, and location mutations are followed", () => {
  const clientMutation = program().source.replace(
    "const client = new ResourceManagementClient(credential, subscriptionId);",
    "let client = new ResourceManagementClient(credential, subscriptionId);\n" +
      "  client = disconnectedClient;",
  );
  const nameMutation = program().source.replace(
    "const name = process.env.AZURE_RESOURCE_GROUP_NAME!;",
    "let name = process.env.AZURE_RESOURCE_GROUP_NAME!;\n  name = \"other\";",
  );
  const wrongSubscription = program().source.replace(
    "AZURE_SUBSCRIPTION_ID",
    "SUBSCRIPTION_ID",
  );
  const wrongLocation = program().source.replace(
    'const location = "eastus";',
    'const location = "westus";',
  );
  assert.equal(
    evaluateRule("prompt/create-and-output", withSource(clientMutation)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/environment", withSource(nameMutation)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-client", withSource(wrongSubscription)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/environment", withSource(wrongLocation)),
    false,
  );

  const varMutation = program().source.replace(
    "const client = new ResourceManagementClient(credential, subscriptionId);",
    "var client = new ResourceManagementClient(credential, subscriptionId);\n" +
      "  { var client = disconnectedClient; }",
  );
  const lexicalShadow = program().source.replace(
    "  try {",
    "  { const client = disconnectedClient; void client; }\n  try {",
  );
  assert.equal(
    evaluateRule("prompt/create-and-output", withSource(varMutation)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/create-and-output", withSource(lexicalShadow)),
    true,
  );
});

test("all lifecycle promises except listing must be awaited", () => {
  for (const call of [
    "client.resourceGroups.createOrUpdate(name, { location })",
    "client.resourceGroups.get(name)",
    "client.resourceGroups.update(name, {",
    "client.resourceGroups.beginDeleteAndWait(name)",
  ]) {
    const source = program().source.replace(`await ${call}`, call);
    const relevant = call.includes("get(")
      ? "prompt/get-and-output"
      : call.includes("beginDelete")
        ? "prompt/delete-wait-confirm"
        : call.endsWith("{")
          ? "prompt/update-and-output"
          : "prompt/create-and-output";
    assert.equal(evaluateRule(relevant, withSource(source)), false, call);
  }
});

test("outputs must originate from their exact SDK results", () => {
  const mutations = [
    ["console.log(\"Created:\", created);", 'console.log("Created");'],
    ["console.log(\"Retrieved:\", retrieved);", 'console.log("Retrieved");'],
    ["console.log(\"Updated:\", updated);", 'console.log("Updated");'],
    [
      'console.log("Resource group:", group);',
      'console.log("Resource group");',
    ],
  ];
  const rules = [
    "prompt/create-and-output",
    "prompt/get-and-output",
    "prompt/update-and-output",
    "prompt/list-and-output",
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const [from, to] = mutations[index];
    const source = program().source.replace(from, to);
    assert.equal(evaluateRule(rules[index], withSource(source)), false, from);
  }

  const lateCreateOutput = program().source
    .replace('    console.log("Created:", created);\n', "")
    .replace(
      "    const retrieved =",
      '    console.log("Created:", created);\n    const retrieved =',
    );
  const lateUpdateOutput = program().source
    .replace('    console.log("Updated:", updated);\n', "")
    .replace(
      "    console.log(`Deleted",
      '    console.log("Updated:", updated);\n    console.log(`Deleted',
    );
  assert.equal(
    evaluateRule("prompt/create-and-output", withSource(lateCreateOutput)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/update-and-output", withSource(lateUpdateOutput)),
    false,
  );
});

test("list requires reachable asynchronous iteration and observed items", () => {
  const sources = [
    program().source.replace("for await", "for"),
    program().source.replace(
      "for await (const group of client.resourceGroups.list())",
      "const groups = client.resourceGroups.list();\n    if (false) " +
        "for await (const group of groups)",
    ),
    program().source.replace(
      'console.log("Resource group:", group);',
      'console.log("Resource group:", "hardcoded");',
    ),
  ];
  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/list-and-output", withSource(source)),
      false,
      source,
    );
  }
});

test("update must target the same group with the exact development tag", () => {
  const mutations = [
    ['environment: "development"', 'environment: "production"'],
    [
      "client.resourceGroups.update(name, {\n      tags:",
      "client.resourceGroups.update(otherName, {\n      tags:",
    ],
    [
      'console.log("Updated:", updated);',
      'console.log("Updated:", retrieved);',
    ],
  ];
  for (const [from, to] of mutations) {
    const source = program().source.replace(from, to);
    assert.equal(
      evaluateRule("prompt/update-and-output", withSource(source)),
      false,
      `${from} -> ${to}`,
    );
  }
});

test("delete supports beginDeleteAndWait and an exact pollUntilDone poller", () => {
  const explicit = program(lifecycle.replace(
    "await client.resourceGroups.beginDeleteAndWait(name);",
    "const poller = await client.resourceGroups.beginDelete(name);\n" +
      "    await poller.pollUntilDone();",
  ));
  assert.equal(evaluateRule("prompt/delete-wait-confirm", explicit), true);

  const bad = [
    explicit.source.replace(
      "await poller.pollUntilDone();",
      "poller.pollUntilDone();",
    ),
    explicit.source.replace(
      "await poller.pollUntilDone();",
      "await unrelatedPoller.pollUntilDone();",
    ),
    program().source.replace(
      "await client.resourceGroups.beginDeleteAndWait(name);",
      "client.resourceGroups.beginDeleteAndWait(name);",
    ),
    program().source.replace(
      "console.log(`Deleted resource group ${name}`);",
      'console.log("Deleted resource group");',
    ),
  ];
  for (const source of bad) {
    assert.equal(
      evaluateRule("prompt/delete-wait-confirm", withSource(source)),
      false,
      source,
    );
  }
});

test("source order and compatible paths must form one lifecycle", () => {
  const reversed = program().source
    .replace(
      "    await client.resourceGroups.beginDeleteAndWait(name);\n",
      "",
    )
    .replace(
      "    const created =",
      "    await client.resourceGroups.beginDeleteAndWait(name);\n" +
        "    const created =",
    );
  assert.equal(
    evaluateRule("prompt/delete-wait-confirm", withSource(reversed)),
    false,
  );

  const split = program(`
    if (enabled) {
${lifecycle.split("    await client.resourceGroups.beginDeleteAndWait")[0]}
    } else {
      await client.resourceGroups.beginDeleteAndWait(name);
      console.log(\`Deleted resource group \${name}\`);
    }`);
  assert.equal(evaluateRule("prompt/delete-wait-confirm", split), false);
});

test("unreachable, short-circuited, and empty-loop decoys do not count", () => {
  for (const body of [
    `    if (false) {\n${lifecycle}\n    }`,
    `    return;\n${lifecycle}`,
    `    false && (await runLifecycle(client, name));`,
    `    for (const item of []) {\n${lifecycle}\n    }`,
  ]) {
    const workspace = program(body);
    assert.equal(
      evaluateRule("prompt/create-and-output", workspace),
      false,
      body,
    );
  }
});

test("reachable helpers and SDK-backed class/object fields are accepted", () => {
  const helperBody = `
    await runLifecycle(client, name, location);`;
  const helper = program(helperBody);
  helper.source += `
async function runLifecycle(client, name, location) {
${lifecycle}
}`;
  helper.documents[0].source = helper.source;
  for (const rule of ruleNames().slice(1, 8)) {
    assert.equal(evaluateRule(rule, helper), true, rule);
  }

  const classSource = `${imports}
class Workflow {
  client = new ResourceManagementClient(
    new DefaultAzureCredential(),
    process.env.AZURE_SUBSCRIPTION_ID!,
  );
  async run() {
    const name = process.env.AZURE_RESOURCE_GROUP_NAME!;
    const location = "eastus";
    try {
${lifecycle.replaceAll("client.", "this.client.")}
    } catch (error) {
      if (error instanceof RestError) console.error(error.message);
      throw error;
    }
  }
}
await new Workflow().run();`;
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource(classSource)), true, rule);
  }

  const objectSource = `${imports}
const workflow = {
  client: new ResourceManagementClient(
    new DefaultAzureCredential(),
    process.env.AZURE_SUBSCRIPTION_ID!,
  ),
  async run() {
    const name = process.env.AZURE_RESOURCE_GROUP_NAME!;
    const location = "eastus";
    try {
${lifecycle.replaceAll("client.", "this.client.")}
    } catch (error) {
      if (error instanceof RestError) console.error(error.statusCode);
      throw error;
    }
  },
};
await workflow.run();`;
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource(objectSource)), true, rule);
  }
});

test("RestError handling requires provenance, details, and unknown rethrow", () => {
  const bad = [
    program().source.replace(
      "if (error instanceof RestError)",
      "if (error instanceof Error)",
    ).replace(
      "console.error(error.statusCode, error.message);",
      'console.error("request failed");',
    ),
    program().source.replace("    throw error;", ""),
    program().source.replace(
      "async function main() {",
      "async function main(RestError) {",
    ),
  ];
  for (const source of bad) {
    assert.equal(
      evaluateRule("prompt/error-handling", withSource(source)),
      false,
      source,
    );
  }
});

test("every reachable helper catch is causal while unreachable catches are ignored", () => {
  const helperProgram = (handler) => {
    const workspace = program(
      "    await runLifecycle(client, name, location);",
    );
    workspace.source += `
async function runLifecycle(client, name, location) {
  try {
${lifecycle}
  } catch (failure) {
${handler}
  }
}`;
    workspace.documents[0].source = workspace.source;
    return workspace;
  };

  for (const handler of [
    "",
    '    console.error("ARM request failed");',
    "    return;",
    `    if (failure instanceof RestError) {
      console.error(failure.message);
    }`,
  ]) {
    assert.equal(
      evaluateRule("prompt/error-handling", helperProgram(handler)),
      false,
      handler,
    );
  }

  const safe = helperProgram(`    const requestFailure = failure;
    if (requestFailure instanceof RestError) {
      reportFailure(requestFailure);
    }
    propagate(requestFailure);`);
  safe.source += `
function reportFailure(problem) {
  logger.error("ARM request failed", problem.statusCode, problem.message);
}
function propagate(problem) {
  throw new Error("Resource group lifecycle failed", { cause: problem });
}`;
  safe.documents[0].source = safe.source;
  assert.equal(evaluateRule("prompt/error-handling", safe), true);

  const nested = helperProgram(`    try {
      logger.error("ARM request failed", failure.message);
    } catch (loggingFailure) {
      throw loggingFailure;
    }
    throw failure;`);
  assert.equal(evaluateRule("prompt/error-handling", nested), true);

  const unreachable = program();
  unreachable.source += `
async function unused(client, name, location) {
  try {
${lifecycle}
  } catch {
    return;
  }
}`;
  unreachable.documents[0].source = unreachable.source;
  assert.equal(evaluateRule("prompt/error-handling", unreachable), true);
});

test("optional catch bindings and non-causal replacements fail globally", () => {
  const unsafe = [
    `try { await unrelated(); } catch { throw new Error("lost failure"); }`,
    `try { await unrelated(); } catch ({ message }) {
      throw new Error(message);
    }`,
    `try { await unrelated(); } catch (failure) {
      throw new Error(String(failure));
    }`,
    `try { await unrelated(); } catch (failure) {
      if (retryable) throw failure;
      return;
    }`,
  ];
  for (const extra of unsafe) {
    const source = `${program().source}\n${extra}`;
    assert.equal(
      evaluateRule("prompt/error-handling", withSource(source)),
      false,
      extra,
    );
  }
});

test("error handling aggregates reachable catches across documents", () => {
  const complete = program();
  const documents = (second) => ({
    ...complete,
    documents: [
      { path: "src/lifecycle.ts", source: complete.source },
      { path: "src/support.ts", source: second },
    ],
  });
  assert.equal(
    evaluateRule(
      "prompt/error-handling",
      documents(`
try {
  await unrelated();
} catch (failure) {
  console.error("lost failure");
}`),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/error-handling",
      documents(`
try {
  await unrelated();
} catch (failure) {
  throw failure;
}`),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/error-handling",
      documents(`
async function unused() {
  try {
    await unrelated();
  } catch {
    return;
  }
}`),
    ),
    true,
  );

  const calledHelper = documents(`
export async function audit() {
  try {
    await unrelated();
  } catch (failure) {
    console.error("lost failure");
  }
}`);
  calledHelper.documents[0].source += "\nawait audit();";
  assert.equal(
    evaluateRule("prompt/error-handling", calledHelper),
    true,
  );
  calledHelper.documents[0].source =
    'import { audit } from "./support.js";\n' +
    calledHelper.documents[0].source;
  assert.equal(
    evaluateRule("prompt/error-handling", calledHelper),
    false,
  );

  const delegated = program(
    "    await runLifecycle(client, name, location);",
  );
  delegated.documents = [
    {
      path: "src/app.ts",
      source: 'import { runLifecycle } from "./lifecycle.js";\n' +
        delegated.source,
    },
    {
      path: "src/lifecycle.ts",
      source: `
import { RestError } from "@azure/core-rest-pipeline";
export async function runLifecycle(client, name, location) {
  try {
${lifecycle}
  } catch (failure) {
    if (failure instanceof RestError) {
      console.error(failure.statusCode, failure.message);
    }
    throw failure;
  }
}`,
    },
  ];
  assert.equal(
    evaluateRule("prompt/error-handling", delegated),
    true,
  );
});

test("an unrelated useful catch cannot replace a lifecycle diagnostic", () => {
  const complete = program();
  const lifecycleWithoutDiagnostic = complete.source.replace(
    "      console.error(error.statusCode, error.message);",
    "",
  );
  const workspace = {
    ...complete,
    documents: [
      { path: "src/lifecycle.ts", source: lifecycleWithoutDiagnostic },
      {
        path: "src/support.ts",
        source: `
import { RestError } from "@azure/core-rest-pipeline";
try {
  await unrelated();
} catch (failure) {
  if (failure instanceof RestError) {
    console.error(failure.message);
  }
  throw failure;
}`,
      },
    ],
  };
  assert.equal(evaluateRule("prompt/error-handling", workspace), false);
});

test("separate source files cannot assemble a disconnected lifecycle", () => {
  const complete = program();
  const splitPoint = complete.source.indexOf(
    "    const retrieved = await client.resourceGroups.get(name);",
  );
  const workspace = {
    ...complete,
    documents: [
      { path: "src/a.ts", source: complete.source.slice(0, splitPoint) + "\n}" },
      { path: "src/b.ts", source: complete.source.slice(splitPoint) },
    ],
  };
  assert.equal(evaluateRule("prompt/delete-wait-confirm", workspace), false);
});

function documentWorkspace(documents) {
  return {
    ...golden,
    documents,
    source: documents.map(({ source }) => source).join("\n"),
    sourceFiles: documents.map(({ path }) => path),
  };
}

function moduleGraphFixture(
  importLine,
  invocation,
  declaration = "export async function runLifecycle",
) {
  return {
    app: `
${importLine}
import { ResourceManagementClient } from "@azure/arm-resources";
import { DefaultAzureCredential } from "@azure/identity";
const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
const name = process.env.AZURE_RESOURCE_GROUP_NAME!;
const location = "eastus";
const client = new ResourceManagementClient(
  new DefaultAzureCredential(),
  subscriptionId,
);
await ${invocation}(client, name, location);`,
    worker: `
import { RestError } from "@azure/core-rest-pipeline";
${declaration}(client, name, location) {
  try {
${lifecycle}
  } catch (error) {
    if (error instanceof RestError) {
      console.error(error.statusCode, error.message);
    }
    throw error;
  }
}`,
  };
}

test("module graph is local, deterministic, and resolves re-export aliases", () => {
  const fixture = moduleGraphFixture(
    'import { execute as run } from "./bridge.js";',
    "run",
  );
  const documents = [
    { path: "src/app.ts", source: fixture.app },
    {
      path: "src/bridge.ts",
      source: 'export { runLifecycle as execute } from "./worker.js";',
    },
    {
      path: "src/decoy.ts",
      source: "export function runLifecycle() { return false; }",
    },
    { path: "src/worker.ts", source: fixture.worker },
  ];
  for (const ordered of [documents, [...documents].reverse()]) {
    const workspace = documentWorkspace(ordered);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace), true, rule);
    }
  }
});

test("module graph resolves namespace and default imports", () => {
  const namespace = moduleGraphFixture(
    'import * as workflow from "./worker.js";',
    "workflow.runLifecycle",
  );
  const defaulted = moduleGraphFixture(
    'import run from "./worker.js";',
    "run",
    "export default async function runLifecycle",
  );
  for (const fixture of [namespace, defaulted]) {
    const documents = [
      { path: "src/app.ts", source: fixture.app },
      { path: "src/worker.ts", source: fixture.worker },
    ];
    for (const ordered of [documents, [...documents].reverse()]) {
      const workspace = documentWorkspace(ordered);
      assert.equal(evaluateRule("prompt/delete-wait-confirm", workspace), true);
      assert.equal(evaluateRule("prompt/error-handling", workspace), true);
    }
  }
});

test("missing and path-alias imports do not create workspace globals", () => {
  const worker = moduleGraphFixture("", "runLifecycle").worker;
  for (const specifier of [
    "./missing.js",
    "./worker",
    "@/worker",
    "workflow-package",
  ]) {
    const fixture = moduleGraphFixture(
      `import { runLifecycle } from "${specifier}";`,
      "runLifecycle",
    );
    const workspace = documentWorkspace([
      { path: "src/app.ts", source: fixture.app },
      { path: "src/worker.ts", source: worker },
    ]);
    assert.equal(
      evaluateRule("prompt/delete-wait-confirm", workspace),
      false,
      specifier,
    );
  }
});

test("separate top-level roots cannot assemble one lifecycle", () => {
  const splitAt = lifecycle.indexOf(
    "    const retrieved = await client.resourceGroups.get(name);",
  );
  const workspace = documentWorkspace([
    { path: "src/first.ts", source: program(lifecycle.slice(0, splitAt)).source },
    { path: "src/second.ts", source: program(lifecycle.slice(splitAt)).source },
  ]);
  assert.equal(evaluateRule("prompt/delete-wait-confirm", workspace), false);
});

test("only reachable unsafe catches affect workspace safety", () => {
  const fixture = moduleGraphFixture(
    'import { runLifecycle } from "./worker.js";',
    "runLifecycle",
  );
  const unsafe = `
export async function audit() {
  try {
    await unrelated();
  } catch {
    return;
  }
}`;
  const documents = [
    { path: "src/app.ts", source: fixture.app },
    { path: "src/audit.ts", source: unsafe },
    { path: "src/worker.ts", source: fixture.worker },
  ];
  assert.equal(
    evaluateRule("prompt/error-handling", documentWorkspace(documents)),
    true,
  );
  const reachable = documents.map((document) => document.path === "src/app.ts"
    ? {
        ...document,
        source: 'import { audit } from "./audit.js";\n' +
          document.source + "\nawait audit();",
      }
    : document);
  assert.equal(
    evaluateRule("prompt/error-handling", documentWorkspace(reachable)),
    false,
  );
});

test("receiver classes disambiguate methods and call cycles terminate", () => {
  const classSource = `${imports}
class Decoy {
  async run() {
    return;
  }
}
class Workflow {
  client = new ResourceManagementClient(
    new DefaultAzureCredential(),
    process.env.AZURE_SUBSCRIPTION_ID!,
  );
  async run() {
    const name = process.env.AZURE_RESOURCE_GROUP_NAME!;
    const location = "eastus";
    try {
${lifecycle.replaceAll("client.", "this.client.")}
    } catch (error) {
      if (error instanceof RestError) console.error(error.message);
      throw error;
    }
  }
}
function cycleA() { cycleB(); }
function cycleB() { cycleA(); }
cycleA();
await new Workflow().run();`;
  const workspace = documentWorkspace([
    { path: "src/app.ts", source: classSource },
  ]);
  assert.equal(evaluateRule("prompt/delete-wait-confirm", workspace), true);
  assert.equal(evaluateRule("prompt/error-handling", workspace), true);

  const cycleStart = classSource.indexOf("function cycleA");
  const imported = documentWorkspace([
    {
      path: "src/app.ts",
      source: `import { Workflow as ImportedWorkflow } from "./worker.js";
function cycleA() { cycleB(); }
function cycleB() { cycleA(); }
cycleA();
await new ImportedWorkflow().run();`,
    },
    {
      path: "src/worker.ts",
      source: classSource.slice(0, cycleStart)
        .replace("class Workflow", "export class Workflow"),
    },
  ]);
  assert.equal(evaluateRule("prompt/delete-wait-confirm", imported), true);
  assert.equal(evaluateRule("prompt/error-handling", imported), true);
});

test("NodeNext runtime extensions map only to exact source modules", () => {
  const cases = [
    ["./worker.js", "src/worker.ts"],
    ["./worker.js", "src/worker.tsx"],
    ["./worker.mjs", "src/worker.mts"],
    ["./worker.cjs", "src/worker.cts"],
    ["./worker.jsx", "src/worker.tsx"],
    ["./worker/index.js", "src/worker/index.ts"],
  ];
  for (const [specifier, workerPath] of cases) {
    const fixture = moduleGraphFixture(
      `import { runLifecycle } from "${specifier}";`,
      "runLifecycle",
    );
    const documents = [
      { path: "src/app.ts", source: fixture.app },
      { path: workerPath, source: fixture.worker },
    ];
    for (const ordered of [documents, [...documents].reverse()]) {
      assert.equal(
        evaluateRule(
          "prompt/delete-wait-confirm",
          documentWorkspace(ordered),
        ),
        true,
        `${specifier} -> ${workerPath}`,
      );
    }
  }

  const fixture = moduleGraphFixture(
    'import { runLifecycle } from "./worker.js";',
    "runLifecycle",
  );
  for (const workerPaths of [
    ["src/worker/index.ts"],
    ["src/worker.js"],
    ["src/worker.ts", "src/worker.tsx"],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/delete-wait-confirm",
        documentWorkspace([
          { path: "src/app.ts", source: fixture.app },
          ...workerPaths.map((path) => ({ path, source: fixture.worker })),
        ]),
      ),
      false,
      workerPaths.join(", "),
    );
  }
});

test("re-export identity is preserved and star collisions are ambiguous", () => {
  const fixture = moduleGraphFixture(
    'import { runLifecycle } from "./barrel.js";',
    "runLifecycle",
  );
  const worker = {
    path: "src/worker.ts",
    source: fixture.worker.replace(
      "export async function runLifecycle",
      "export default async function runLifecycle",
    ),
  };
  const documents = [
    { path: "src/app.ts", source: fixture.app },
    {
      path: "src/barrel.ts",
      source: 'export { default as runLifecycle } from "./worker.js";',
    },
    worker,
  ];
  for (const ordered of [documents, [...documents].reverse()]) {
    assert.equal(
      evaluateRule("prompt/delete-wait-confirm", documentWorkspace(ordered)),
      true,
    );
  }

  const collision = [
    { path: "src/app.ts", source: fixture.app },
    {
      path: "src/barrel.ts",
      source: 'export * from "./first.js";\nexport * from "./second.js";',
    },
    {
      path: "src/first.ts",
      source: fixture.worker,
    },
    {
      path: "src/second.ts",
      source: fixture.worker,
    },
  ];
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      documentWorkspace(collision),
    ),
    false,
  );
});

function classWorkflow(method, invocation, extraClasses = "") {
  return documentWorkspace([{
    path: "src/app.ts",
    source: `${imports}
${extraClasses}
${method}
${invocation}`,
  }]);
}

const validWorkflowMethod = `
  async run() {
    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
    const name = process.env.AZURE_RESOURCE_GROUP_NAME!;
    const location = "eastus";
    const client = new ResourceManagementClient(
      new DefaultAzureCredential(),
      subscriptionId,
    );
    try {
${lifecycle}
    } catch (error) {
      if (error instanceof RestError) console.error(error.message);
      throw error;
    }
  }`;

test("instance and static receivers reach only matching Workflow methods", () => {
  const instanceClass = `class Workflow {
  static async run() { return; }
${validWorkflowMethod}
}`;
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      classWorkflow(instanceClass, "await new Workflow().run();"),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      classWorkflow(instanceClass, "await Workflow.run();"),
    ),
    false,
  );

  const staticClass = `class Workflow {
  async run() { return; }
${validWorkflowMethod.replace("async run()", "static async run()")}
}`;
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      classWorkflow(staticClass, "await Workflow.run();"),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      classWorkflow(staticClass, "await new Workflow().run();"),
    ),
    false,
  );
});

test("decoy methods require a call and construction alone is not a call", () => {
  const decoyClass = `class Decoy {
${validWorkflowMethod}
}
class Workflow {
  async run() { return; }
}`;
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      classWorkflow(
        decoyClass,
        "new Decoy();\nawait new Workflow().run();",
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      classWorkflow(decoyClass, "await new Decoy().run();"),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      program(),
    ),
    true,
  );
});

test("immutable aliases and inheritance resolve without receiver guessing", () => {
  const classes = `class BaseWorkflow {
${validWorkflowMethod}
}
class Workflow extends BaseWorkflow {}`;
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      classWorkflow(
        classes,
        `const workflow = new Workflow();
const alias = workflow;
await alias.run();`,
      ),
    ),
    true,
  );

  for (const invocation of [
    "let workflow = new Workflow();\nworkflow = new Workflow();\nawait workflow.run();",
    "const workflow = createWorkflow();\nawait workflow.run();",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/delete-wait-confirm",
        classWorkflow(classes, invocation),
      ),
      false,
      invocation,
    );
  }

  const competing = `class BaseWorkflow {
${validWorkflowMethod}
}
class Workflow extends BaseWorkflow {
  async run() { return; }
  async run() { return; }
}`;
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      classWorkflow(competing, "await new Workflow().run();"),
    ),
    false,
  );

  const mixed = `class BaseWorkflow {
${validWorkflowMethod}
}
class Workflow extends withAudit(BaseWorkflow) {}`;
  assert.equal(
    evaluateRule(
      "prompt/delete-wait-confirm",
      classWorkflow(mixed, "await new Workflow().run();"),
    ),
    false,
  );
});
