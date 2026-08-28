import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateTypeScriptCheck,
  typeScriptCheckNames,
} from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/storage-typescript-rules.mjs";
import {
  activeDependencies,
  loadSourceManifest,
  sourceDocuments,
} from "./tools/source-manifest.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadSourceManifest(goldenPath);
const scenarioPath = dirname(fileURLToPath(import.meta.url));
let workspaceNumber = 0;

function loadFixtureWorkspace(t, files, tsconfig) {
  workspaceNumber += 1;
  const root = join(
    scenarioPath,
    `.storage-ts-rules-${process.pid}-${workspaceNumber}`,
  );
  rmSync(root, { force: true, recursive: true });
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(join(root, "package.json"), golden.packageJson);
  if (tsconfig !== undefined) {
    writeFileSync(
      join(root, "tsconfig.json"),
      typeof tsconfig === "string"
        ? tsconfig
        : JSON.stringify(tsconfig),
    );
  }
  for (const [path, source] of Object.entries(files)) {
    const absolutePath = join(root, ...path.split("/"));
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, source);
  }
  return loadSourceManifest(root);
}

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
import { StorageManagementClient } from "@azure/arm-storage";
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";`;

const lifecycle = `
    const created = await client.storageAccounts.beginCreateAndWait(
      resourceGroupName,
      accountName,
      {
        location,
        sku: { name: "Standard_LRS" },
        kind: "StorageV2",
      },
    );
    console.log("Created:", created.name);
    for await (
      const account of client.storageAccounts.listByResourceGroup(
        resourceGroupName,
      )
    ) {
      console.log("Account:", account.name);
    }
    const properties = await client.storageAccounts.getProperties(
      resourceGroupName,
      accountName,
    );
    console.log("Location:", properties.primaryLocation);
    const blobProperties = await client.blobServices.setServiceProperties(
      resourceGroupName,
      accountName,
      { isVersioningEnabled: true },
    );
    console.log("Versioning:", blobProperties.isVersioningEnabled);
    await client.storageAccounts.delete(resourceGroupName, accountName);
    console.log(\`Deleted storage account \${accountName}\`);`;

function program(body = lifecycle, selectedImports = imports) {
  return withSource(`${selectedImports}
async function main() {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
  const resourceGroupName = process.env.AZURE_RESOURCE_GROUP_NAME!;
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
  const location = "eastus";
  const credential = new DefaultAzureCredential();
  const client = new StorageManagementClient(credential, subscriptionId);
  try {
${body}
  } catch (error: unknown) {
    if (error instanceof RestError) {
      console.error(error.statusCode, error.message);
    }
    throw error;
  }
}
await main();
`);
}

const manifestApp = `
import { StorageManagementClient } from "@azure/arm-storage";
import { DefaultAzureCredential } from "@azure/identity";
import { runLifecycle } from "./worker.js";
const client = new StorageManagementClient(
  new DefaultAzureCredential(),
  process.env.AZURE_SUBSCRIPTION_ID!,
);
await runLifecycle(
  client,
  process.env.AZURE_RESOURCE_GROUP_NAME!,
  process.env.AZURE_STORAGE_ACCOUNT_NAME!,
  "eastus",
);`;

const manifestWorker = `
import { RestError } from "@azure/core-rest-pipeline";
export async function runLifecycle(
  client,
  resourceGroupName,
  accountName,
  location,
) {
  try {
${lifecycle}
  } catch (error) {
    if (error instanceof RestError) console.error(error.message);
    throw error;
  }
}`;

function replaceSource(workspace, from, to) {
  const source = workspace.source.replace(from, to);
  return withSource(source, workspace.packageJson);
}

test("reference has exactly nine passing prompt criteria", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/packages",
    "prompt/environment",
    "prompt/authenticated-client",
    "prompt/create-and-output",
    "prompt/list-and-output",
    "prompt/get-and-output",
    "prompt/versioning-and-output",
    "prompt/delete-and-confirm",
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

test("reference pins the requested toolchain and SDK versions", () => {
  const manifest = JSON.parse(golden.packageJson);
  assert.deepEqual(manifest.dependencies, {
    "@azure/arm-storage": "20.1.0",
    "@azure/core-rest-pipeline": "1.25.0",
    "@azure/identity": "4.13.2",
  });
  assert.deepEqual(manifest.devDependencies, { typescript: "5.9.2" });
  assert.equal(manifest.packageManager, "pnpm@10.26.0");
  const lockfile = readFileSync(
    new URL("./golden/pnpm-lock.yaml", import.meta.url),
    "utf8",
  );
  for (const expected of [
    "'@azure/arm-storage@20.1.0'",
    "'@azure/core-rest-pipeline@1.25.0'",
    "'@azure/identity@4.13.2'",
    "typescript@5.9.2",
  ]) {
    assert.match(lockfile, new RegExp(expected.replaceAll(".", "\\.")));
  }
});

test("source manifest orders paths and uses runtime dependencies only", () => {
  assert.deepEqual(
    sourceDocuments({
      documents: [
        { path: "z.ts", source: "const z = 1;" },
        { path: "a.ts", source: "const a = 1;" },
      ],
    }).map(({ path }) => path),
    ["a.ts", "z.ts"],
  );
  assert.deepEqual(activeDependencies('{"devDependencies":{"fake":"1"}}'), {});
  assert.deepEqual(activeDependencies("{broken"), {});
});

test("active tsconfig includes imported production helpers", (t) => {
  const workspace = loadFixtureWorkspace(
    t,
    {
      "src/app.ts": manifestApp,
      "src/worker.ts": manifestWorker,
      "tests/complete-lifecycle.ts": manifestWorker,
    },
    `{
      // TypeScript accepts comments and trailing commas.
      "compilerOptions": { "rootDir": "src", },
      "include": ["src/**/*.ts",],
    }`,
  );
  assert.deepEqual(workspace.sourceFiles, ["src/app.ts", "src/worker.ts"]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test("test-only lifecycle is ineligible even when explicitly included", (t) => {
  const workspace = loadFixtureWorkspace(
    t,
    {
      "src/app.ts": manifestApp.replace("./worker.js", "../tests/worker.js"),
      "tests/worker.ts": manifestWorker,
    },
    {
      include: ["src/**/*.ts", "tests/**/*.ts"],
    },
  );
  assert.deepEqual(workspace.sourceFiles, ["src/app.ts"]);
  for (const rule of [
    "prompt/environment",
    "prompt/create-and-output",
    "prompt/list-and-output",
    "prompt/get-and-output",
    "prompt/versioning-and-output",
    "prompt/delete-and-confirm",
    "prompt/error-handling",
  ]) {
    assert.equal(evaluateRule(rule, workspace), false, rule);
  }
});

test("rootDir and exclude prevent decoy lifecycle traversal", (t) => {
  for (const [name, tsconfig, workerPath, importPath] of [
    [
      "rootDir",
      { compilerOptions: { rootDir: "src" }, include: ["**/*.ts"] },
      "outside/worker.ts",
      "../outside/worker.js",
    ],
    [
      "exclude",
      {
        include: ["src/**/*.ts"],
        exclude: ["src/excluded/**"],
      },
      "src/excluded/worker.ts",
      "./excluded/worker.js",
    ],
  ]) {
    const workspace = loadFixtureWorkspace(
      t,
      {
        "src/app.ts": manifestApp.replace("./worker.js", importPath),
        [workerPath]: manifestWorker,
      },
      tsconfig,
    );
    assert.deepEqual(workspace.sourceFiles, ["src/app.ts"], name);
    assert.equal(
      evaluateRule("prompt/create-and-output", workspace),
      false,
      name,
    );
  }
});

test("files is an exact eligible source set with exclusion taking precedence", (t) => {
  const workspace = loadFixtureWorkspace(
    t,
    {
      "src/app.ts": manifestApp,
      "src/ignored.ts": manifestWorker,
      "src/worker.ts": manifestWorker,
    },
    {
      exclude: ["src/ignored.ts"],
      files: ["src/app.ts", "src/worker.ts", "src/ignored.ts"],
      include: [],
    },
  );
  assert.deepEqual(workspace.sourceFiles, ["src/app.ts", "src/worker.ts"]);
  assert.equal(evaluateRule("prompt/delete-and-confirm", workspace), true);
});

test("default collection keeps production source and drops test artifacts", (t) => {
  const workspace = loadFixtureWorkspace(
    t,
    {
      "build/built.js": manifestWorker,
      "lib/helper.js": "export const helper = true;",
      "src/app.ts": "export const app = true;",
      "src/app.spec.ts": manifestWorker,
      "src/types.d.ts": manifestWorker,
      "test/lifecycle.ts": manifestWorker,
    },
    undefined,
  );
  assert.deepEqual(workspace.sourceFiles, ["lib/helper.js", "src/app.ts"]);
});

test("malformed and ambiguous tsconfigs fail closed", (t) => {
  for (const [name, tsconfig] of [
    ["malformed", '{"include":["src/**/*.ts"],'],
    ["invalid include", '{"include":"src/**/*.ts"}'],
    ["external root", '{"compilerOptions":{"rootDir":"../src"}}'],
    ["extends", '{"extends":"./base.json","include":["src/**/*.ts"]}'],
  ]) {
    const workspace = loadFixtureWorkspace(
      t,
      { "src/app.ts": manifestWorker },
      tsconfig,
    );
    assert.deepEqual(workspace.sourceFiles, [], name);
    assert.equal(
      evaluateRule("prompt/create-and-output", workspace),
      false,
      name,
    );
  }
});

test("source documents cannot reintroduce ineligible or ambiguous modules", () => {
  const documents = [
    { path: "src/app.ts", source: "export const app = true;" },
    { path: "src/worker.ts", source: manifestWorker },
    { path: "tests/worker.ts", source: manifestWorker },
  ];
  assert.deepEqual(
    sourceDocuments({
      documents,
      sourceFiles: ["src/app.ts"],
    }).map(({ path }) => path),
    ["src/app.ts"],
  );
  assert.deepEqual(
    sourceDocuments({
      documents: [
        { path: "src/app.ts", source: "one" },
        { path: "./src/app.ts", source: "two" },
      ],
    }),
    [],
  );
});

test("every criterion rejects missing generated source", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource("")), false, rule);
  }
});

test("SDK packages must be active dependencies", () => {
  for (const packageName of ["@azure/identity", "@azure/arm-storage"]) {
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

test("core-rest-pipeline is conditional on a real RestError import", () => {
  const manifest = JSON.parse(golden.packageJson);
  delete manifest.dependencies["@azure/core-rest-pipeline"];
  assert.equal(
    evaluateRule(
      "prompt/packages",
      withSource(program().source, JSON.stringify(manifest)),
    ),
    false,
  );

  const structural = program(
    lifecycle,
    imports.replace(
      'import { RestError } from "@azure/core-rest-pipeline";',
      "",
    ),
  ).source
    .replace(
      "if (error instanceof RestError)",
      "if (error instanceof Error)",
    );
  assert.equal(
    evaluateRule(
      "prompt/packages",
      withSource(structural, JSON.stringify(manifest)),
    ),
    true,
  );
  assert.equal(
    evaluateRule("prompt/error-handling", withSource(structural)),
    true,
  );
});

test("namespace and named aliases retain SDK provenance", () => {
  const aliasedImports = `
import * as storage from "@azure/arm-storage";
import * as pipeline from "@azure/core-rest-pipeline";
import { DefaultAzureCredential as Credential } from "@azure/identity";`;
  const source = program(lifecycle, aliasedImports).source
    .replaceAll(
      "new StorageManagementClient",
      "new storage.StorageManagementClient",
    )
    .replaceAll("new DefaultAzureCredential", "new Credential")
    .replaceAll("instanceof RestError", "instanceof pipeline.RestError");
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource(source)), true, rule);
  }
});

test("type-only and shadowed constructors do not authenticate clients", () => {
  for (const imported of [
    "DefaultAzureCredential",
    "StorageManagementClient",
  ]) {
    const source = program().source.replace(
      `import { ${imported} }`,
      `import type { ${imported} }`,
    );
    assert.equal(
      evaluateRule("prompt/authenticated-client", withSource(source)),
      false,
      imported,
    );
  }
  const shadowed = program().source.replace(
    "async function main() {",
    "async function main(StorageManagementClient) {",
  );
  assert.equal(
    evaluateRule("prompt/authenticated-client", withSource(shadowed)),
    false,
  );
});

test("environment values and client mutations are followed", () => {
  const wrongValues = [
    ["AZURE_SUBSCRIPTION_ID", "SUBSCRIPTION_ID", "prompt/authenticated-client"],
    ["AZURE_RESOURCE_GROUP_NAME", "RESOURCE_GROUP", "prompt/environment"],
    ["AZURE_STORAGE_ACCOUNT_NAME", "STORAGE_ACCOUNT", "prompt/environment"],
    ['const location = "eastus";', 'const location = "westus";', "prompt/environment"],
  ];
  for (const [from, to, rule] of wrongValues) {
    assert.equal(
      evaluateRule(rule, withSource(program().source.replace(from, to))),
      false,
      `${from} -> ${to}`,
    );
  }
  const mutation = program().source.replace(
    "const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;",
    "let accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;\n" +
      '  accountName = "different";',
  );
  assert.equal(evaluateRule("prompt/environment", withSource(mutation)), false);
});

test("creation requires exact options and forbids access tiers", () => {
  const mutations = [
    ['name: "Standard_LRS"', 'name: "Standard_GRS"'],
    ['kind: "StorageV2"', 'kind: "BlobStorage"'],
    [
      'kind: "StorageV2",',
      'kind: "StorageV2", accessTier: "Hot",',
    ],
    [
      "resourceGroupName,\n      accountName,\n      {",
      "resourceGroupName,\n      otherAccount,\n      {",
    ],
  ];
  for (const [from, to] of mutations) {
    const source = program().source.replace(from, to);
    assert.equal(
      evaluateRule("prompt/create-and-output", withSource(source)),
      false,
      `${from} -> ${to}`,
    );
  }
});

test("creation supports exact explicit pollUntilDone completion", () => {
  const explicit = program(lifecycle.replace(
    `const created = await client.storageAccounts.beginCreateAndWait(
      resourceGroupName,
      accountName,
      {
        location,
        sku: { name: "Standard_LRS" },
        kind: "StorageV2",
      },
    );`,
    `const poller = await client.storageAccounts.beginCreate(
      resourceGroupName,
      accountName,
      {
        location,
        sku: { name: "Standard_LRS" },
        kind: "StorageV2",
      },
    );
    const created = await poller.pollUntilDone();`,
  ));
  assert.equal(evaluateRule("prompt/create-and-output", explicit), true);
  for (const bad of [
    explicit.source.replace(
      "const created = await poller.pollUntilDone();",
      "const created = poller.pollUntilDone();",
    ),
    explicit.source.replace(
      "const created = await poller.pollUntilDone();",
      "const created = await unrelatedPoller.pollUntilDone();",
    ),
    program().source.replace(
      "await client.storageAccounts.beginCreateAndWait",
      "client.storageAccounts.beginCreateAndWait",
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/create-and-output", withSource(bad)),
      false,
    );
  }
});

test("outputs must be observed from exact SDK results", () => {
  const mutations = [
    [
      'console.log("Created:", created.name);',
      'console.log("Created:", accountName);',
      "prompt/create-and-output",
    ],
    [
      'console.log("Location:", properties.primaryLocation);',
      'console.log("Location:", "eastus");',
      "prompt/get-and-output",
    ],
    [
      'console.log("Versioning:", blobProperties.isVersioningEnabled);',
      'console.log("Versioning:", true);',
      "prompt/versioning-and-output",
    ],
  ];
  for (const [from, to, rule] of mutations) {
    assert.equal(
      evaluateRule(rule, withSource(program().source.replace(from, to))),
      false,
      rule,
    );
  }
});

test("list uses async iteration in the same group and prints each name", () => {
  const alias = program().source.replace(
    'console.log("Account:", account.name);',
    'const listedName = account.name;\n      console.log("Account:", listedName);',
  );
  assert.equal(evaluateRule("prompt/list-and-output", withSource(alias)), true);

  const mutations = [
    ["for await (", "for ("],
    [
      "listByResourceGroup(\n        resourceGroupName,",
      "listByResourceGroup(\n        otherGroup,",
    ],
    [
      'console.log("Account:", account.name);',
      'console.log("Account:", account);',
    ],
    [
      'console.log("Account:", account.name);',
      'console.log("Account:", "hardcoded");',
    ],
  ];
  for (const [from, to] of mutations) {
    assert.equal(
      evaluateRule(
        "prompt/list-and-output",
        withSource(program().source.replace(from, to)),
      ),
      false,
      `${from} -> ${to}`,
    );
  }
});

test("getProperties targets the same account and never permits listKeys", () => {
  const mutations = [
    [
      "resourceGroupName,\n      accountName,\n    );\n    console.log(\"Location:\", properties.primaryLocation);",
      "resourceGroupName,\n      otherAccount,\n    );\n    console.log(\"Location:\", properties.primaryLocation);",
    ],
    [
      "const properties = await client.storageAccounts.getProperties(",
      "const properties = client.storageAccounts.getProperties(",
    ],
  ];
  for (const [from, to] of mutations) {
    assert.equal(
      evaluateRule(
        "prompt/get-and-output",
        withSource(program().source.replace(from, to)),
      ),
      false,
      `${from} -> ${to}`,
    );
  }
  const withKeys = program().source.replace(
    "const properties = await client.storageAccounts.getProperties(",
    "const keys = await client.storageAccounts.listKeys(" +
      "resourceGroupName, accountName);\n" +
      "    console.log(keys.keys);\n" +
      "    const properties = await client.storageAccounts.getProperties(",
  );
  assert.equal(
    evaluateRule("prompt/get-and-output", withSource(withKeys)),
    false,
  );
});

test("versioning uses the same default service, exact option, and output", () => {
  const mutations = [
    ["{ isVersioningEnabled: true }", "{ isVersioningEnabled: false }"],
    [
      "resourceGroupName,\n      accountName,\n      { isVersioningEnabled: true },",
      "resourceGroupName,\n      otherAccount,\n      { isVersioningEnabled: true },",
    ],
    [
      "await client.blobServices.setServiceProperties",
      "client.blobServices.setServiceProperties",
    ],
  ];
  for (const [from, to] of mutations) {
    assert.equal(
      evaluateRule(
        "prompt/versioning-and-output",
        withSource(program().source.replace(from, to)),
      ),
      false,
      `${from} -> ${to}`,
    );
  }
});

test("delete awaits the same account before a real confirmation", () => {
  const mutations = [
    [
      "await client.storageAccounts.delete(resourceGroupName, accountName);",
      "client.storageAccounts.delete(resourceGroupName, accountName);",
    ],
    [
      "await client.storageAccounts.delete(resourceGroupName, accountName);",
      "await client.storageAccounts.delete(resourceGroupName, otherAccount);",
    ],
    [
      "console.log(`Deleted storage account ${accountName}`);",
      'console.log("Deleted storage account");',
    ],
  ];
  for (const [from, to] of mutations) {
    assert.equal(
      evaluateRule(
        "prompt/delete-and-confirm",
        withSource(program().source.replace(from, to)),
      ),
      false,
      `${from} -> ${to}`,
    );
  }
  const premature = program().source
    .replace("    console.log(`Deleted storage account ${accountName}`);\n", "")
    .replace(
      "    await client.storageAccounts.delete",
      "    console.log(`Deleted storage account ${accountName}`);\n" +
        "    await client.storageAccounts.delete",
    );
  assert.equal(
    evaluateRule("prompt/delete-and-confirm", withSource(premature)),
    false,
  );
});

test("unreachable and disconnected lifecycle fakes do not count", () => {
  for (const body of [
    `    if (false) {\n${lifecycle}\n    }`,
    `    return;\n${lifecycle}`,
    `    false && (await runLifecycle(client));`,
  ]) {
    assert.equal(
      evaluateRule("prompt/create-and-output", program(body)),
      false,
      body,
    );
  }
});

test("reachable helpers and class fields preserve one lifecycle", () => {
  const helper = program(
    "    await runLifecycle(client, resourceGroupName, accountName, location);",
  );
  helper.source += `
async function runLifecycle(
  client,
  resourceGroupName,
  accountName,
  location,
) {
${lifecycle}
}`;
  helper.documents[0].source = helper.source;
  for (const rule of ruleNames().slice(1, 8)) {
    assert.equal(evaluateRule(rule, helper), true, rule);
  }

  const classSource = `${imports}
class Workflow {
  client = new StorageManagementClient(
    new DefaultAzureCredential(),
    process.env.AZURE_SUBSCRIPTION_ID!,
  );
  async run() {
    const resourceGroupName = process.env.AZURE_RESOURCE_GROUP_NAME!;
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME!;
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
});

test("module graph follows imported helper aliases, not workspace globals", () => {
  const app = `
import { execute as run } from "./bridge.js";
import { StorageManagementClient } from "@azure/arm-storage";
import { DefaultAzureCredential } from "@azure/identity";
const client = new StorageManagementClient(
  new DefaultAzureCredential(),
  process.env.AZURE_SUBSCRIPTION_ID!,
);
await run(
  client,
  process.env.AZURE_RESOURCE_GROUP_NAME!,
  process.env.AZURE_STORAGE_ACCOUNT_NAME!,
  "eastus",
);`;
  const worker = `
import { RestError } from "@azure/core-rest-pipeline";
export async function runLifecycle(
  client,
  resourceGroupName,
  accountName,
  location,
) {
  try {
${lifecycle}
  } catch (error) {
    if (error instanceof RestError) console.error(error.message);
    throw error;
  }
}`;
  const documents = [
    { path: "src/app.ts", source: app },
    {
      path: "src/bridge.ts",
      source: 'export { runLifecycle as execute } from "./worker.js";',
    },
    { path: "src/worker.ts", source: worker },
  ];
  const workspace = {
    ...golden,
    documents,
    source: documents.map(({ source }) => source).join("\n"),
    sourceFiles: documents.map(({ path }) => path),
  };
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
  workspace.documents[0].source = workspace.documents[0].source.replace(
    'import { execute as run } from "./bridge.js";',
    "",
  );
  assert.equal(evaluateRule("prompt/delete-and-confirm", workspace), false);
});

test("error handling narrows meaningfully and preserves unknown failures", () => {
  const bad = [
    program().source
      .replace("if (error instanceof RestError)", "if (error instanceof Error)")
      .replace(
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
