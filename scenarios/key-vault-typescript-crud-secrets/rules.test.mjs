import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateTypeScriptCheck,
  loadTypeScriptWorkspace,
  typeScriptCheckNames,
} from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/key-vault-typescript-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadTypeScriptWorkspace(goldenPath);

function withSource(source, packageJson = golden.packageJson) {
  return { ...golden, packageJson, source };
}

function program(body, imports = `
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
`) {
  return withSource(`${imports}
async function main() {
  const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  const name = "my-secret";
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

const completeLifecycle = `
    await client.setSecret(name, "my-secret-value");
    const secret = await client.getSecret(name);
    console.log(secret.value);
    await client.setSecret(name, "updated-value");
    const poller = await client.beginDeleteSecret(name);
    await poller.pollUntilDone();
    await client.purgeDeletedSecret(name);`;

test.skip("reference has exactly eight passing criteria", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/packages",
    "prompt/authenticated-client",
    "prompt/create-secret",
    "prompt/read-and-print",
    "prompt/update-secret",
    "prompt/delete-and-wait",
    "prompt/purge-after-delete",
    "prompt/rest-error",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test.skip("reference passes reusable TypeScript checks", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(evaluateTypeScriptCheck(check, golden), true, check);
  }
});

test.skip("every rule rejects missing generated source", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, { ...golden, source: "" }), false, rule);
  }
});

test.skip("runtime packages must be active dependencies", () => {
  for (const packageName of [
    "@azure/identity",
    "@azure/keyvault-secrets",
    "@azure/core-rest-pipeline",
  ]) {
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

test.skip("core-rest-pipeline is conditional on a RestError import", () => {
  const manifest = JSON.parse(golden.packageJson);
  delete manifest.dependencies["@azure/core-rest-pipeline"];
  const source = golden.source
    .replace('import { RestError } from "@azure/core-rest-pipeline";', "")
    .replace(/if \(error instanceof RestError\) \{[\s\S]*?\n    \}/, "");
  assert.equal(
    evaluateRule(
      "prompt/packages",
      withSource(source, JSON.stringify(manifest)),
    ),
    true,
  );
});

test.skip("aliases and namespace imports retain real SDK provenance", () => {
  const imports = `
import * as pipeline from "@azure/core-rest-pipeline";
import { DefaultAzureCredential as Credential } from "@azure/identity";
import * as vault from "@azure/keyvault-secrets";`;
  const source = program(
    completeLifecycle,
    imports,
  ).source
    .replaceAll("new SecretClient", "new vault.SecretClient")
    .replaceAll("new DefaultAzureCredential", "new Credential")
    .replaceAll("instanceof RestError", "instanceof pipeline.RestError");
  const workspace = withSource(source);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test.skip("bound and inline credentials create authenticated clients", () => {
  const inline = program(completeLifecycle);
  const bound = withSource(inline.source.replace(
    "const client = new SecretClient(vaultUrl, new DefaultAzureCredential());",
    "const credential = new DefaultAzureCredential();\n" +
      "  const client = new SecretClient(vaultUrl, credential);",
  ));
  for (const workspace of [inline, bound]) {
    assert.equal(
      evaluateRule("prompt/authenticated-client", workspace),
      true,
    );
    assert.equal(evaluateRule("prompt/create-secret", workspace), true);
  }
});

test.skip("a locally shadowed SDK constructor is rejected", () => {
  const workspace = program(completeLifecycle).source.replace(
    "async function main() {",
    "async function main(SecretClient) {",
  );
  assert.equal(
    evaluateRule("prompt/authenticated-client", withSource(workspace)),
    false,
  );
  assert.equal(evaluateRule("prompt/create-secret", withSource(workspace)), false);
});

test.skip("type-only imports cannot masquerade as runtime SDK values", () => {
  for (const imported of [
    "DefaultAzureCredential",
    "SecretClient",
    "RestError",
  ]) {
    const source = program(completeLifecycle).source.replace(
      `import { ${imported} }`,
      `import type { ${imported} }`,
    );
    const rule = imported === "RestError"
      ? "prompt/rest-error"
      : "prompt/authenticated-client";
    assert.equal(evaluateRule(rule, withSource(source)), false, imported);
  }
});

test.skip("client and secret-name mutation follows lexical and var scopes", () => {
  const prefix =
    "const client = new SecretClient(vaultUrl, new DefaultAzureCredential());";
  const clientOverwrite = program(completeLifecycle).source.replace(
    prefix,
    "let client = new SecretClient(vaultUrl, new DefaultAzureCredential());\n" +
      "  client = disconnectedClient;",
  );
  const varOverwrite = program(completeLifecycle).source.replace(
    prefix,
    "var client = new SecretClient(vaultUrl, new DefaultAzureCredential());\n" +
      "  { var client = disconnectedClient; }",
  );
  const nameOverwrite = program(completeLifecycle).source
    .replace('const name = "my-secret";', 'let name = "my-secret";\n  name = "other";');
  for (const source of [clientOverwrite, varOverwrite, nameOverwrite]) {
    assert.equal(
      evaluateRule("prompt/create-secret", withSource(source)),
      false,
      source,
    );
  }

  const innerShadow = program(completeLifecycle).source.replace(
    "  try {",
    "  { const client = disconnectedClient; void client; }\n  try {",
  );
  assert.equal(
    evaluateRule("prompt/create-secret", withSource(innerShadow)),
    true,
  );
});

test.skip("all lifecycle operations must be awaited", () => {
  for (const operation of [
    "client.setSecret(name, \"my-secret-value\")",
    "client.getSecret(name)",
    "client.setSecret(name, \"updated-value\")",
    "client.beginDeleteSecret(name)",
    "poller.pollUntilDone()",
    "client.purgeDeletedSecret(name)",
  ]) {
    const source = program(completeLifecycle).source.replace(
      `await ${operation}`,
      operation,
    );
    const results = ruleNames().map((rule) => evaluateRule(rule, withSource(source)));
    assert.ok(results.includes(false), operation);
  }
});

test.skip("names, values, clients, and lifecycle order must match", () => {
  const mutations = [
    ['"my-secret-value"', '"decoy-value"'],
    ['"updated-value"', '"wrong-update"'],
    ["client.getSecret(name)", 'client.getSecret("other-secret")'],
    ["client.purgeDeletedSecret(name)", 'client.purgeDeletedSecret("other-secret")'],
    [
      "await client.setSecret(name, \"updated-value\");",
      "await client.setSecret(name, \"updated-value\");\n" +
        "    await client.setSecret(name, \"my-secret-value\");",
    ],
  ];
  for (const [from, to] of mutations) {
    const workspace = program(completeLifecycle);
    workspace.source = workspace.source.replace(from, to);
    const allPromptRulesPass = ruleNames()
      .slice(2, 7)
      .every((rule) => evaluateRule(rule, workspace));
    assert.equal(allPromptRulesPass, false, `${from} -> ${to}`);
  }
});

test.skip("printed output must originate from the awaited getSecret result", () => {
  const badBodies = [
    completeLifecycle.replace(
      "console.log(secret.value);",
      'console.log("my-secret-value");',
    ),
    completeLifecycle.replace(
      "console.log(secret.value);",
      'let output = secret.value;\n    output = "fake";\n    console.log(output);',
    ),
    completeLifecycle.replace(
      "console.log(secret.value);",
      'const secret = { value: "fake" };\n    console.log(secret.value);',
    ),
  ];
  for (const body of badBodies) {
    assert.equal(
      evaluateRule("prompt/read-and-print", program(body)),
      false,
      body,
    );
  }
});

test.skip("destructured, aliased, and template retrieved output is accepted", () => {
  const bodies = [
    completeLifecycle.replace(
      "const secret = await client.getSecret(name);\n    console.log(secret.value);",
      "const { value } = await client.getSecret(name);\n    console.info(value);",
    ),
    completeLifecycle.replace(
      "console.log(secret.value);",
      "const output = secret.value;\n    console.log(`value=${output}`);",
    ),
    completeLifecycle.replace(
      "const secret = await client.getSecret(name);\n    console.log(secret.value);",
      "console.log((await client.getSecret(name)).value);",
    ),
  ];
  for (const body of bodies) {
    assert.equal(
      evaluateRule("prompt/read-and-print", program(body)),
      true,
      body,
    );
  }
});

test.skip("polling must use the delete poller before purge", () => {
  const badBodies = [
    completeLifecycle.replace(
      "await poller.pollUntilDone();",
      "await unrelatedPoller.pollUntilDone();",
    ),
    completeLifecycle.replace(
      "await poller.pollUntilDone();",
      "await unrelatedWork();",
    ),
    completeLifecycle.replace(
      "await poller.pollUntilDone();",
      "poller = unrelatedPoller;\n    await poller.pollUntilDone();",
    ).replace("const poller =", "let poller ="),
    completeLifecycle
      .replace("    await poller.pollUntilDone();\n", "")
      .replace(
        "const poller = await client.beginDeleteSecret(name);",
        "await client.purgeDeletedSecret(name);\n" +
          "    const poller = await client.beginDeleteSecret(name);",
      ),
  ];
  for (const body of badBodies) {
    assert.equal(evaluateRule("prompt/delete-and-wait", program(body)), false);
    assert.equal(evaluateRule("prompt/purge-after-delete", program(body)), false);
  }
});

test.skip("genuine explicit polling is accepted", () => {
  const body = completeLifecycle.replace(
    "await poller.pollUntilDone();",
    "while (!poller.isDone()) {\n      await poller.poll();\n    }",
  );
  assert.equal(evaluateRule("prompt/delete-and-wait", program(body)), true);
  assert.equal(evaluateRule("prompt/purge-after-delete", program(body)), true);
});

test.skip("unreachable lifecycle operations do not count", () => {
  const bodies = [
    `    if (false) {
${completeLifecycle}
    }`,
    `    return;
${completeLifecycle}`,
  ];
  for (const body of bodies) {
    const workspace = program(body);
    for (const rule of ruleNames().slice(2, 7)) {
      assert.equal(evaluateRule(rule, workspace), false, `${rule}\n${body}`);
    }
  }
});

test.skip("mutually exclusive branches cannot assemble a lifecycle", () => {
  const body = `
    if (enabled) {
      await client.setSecret(name, "my-secret-value");
      const secret = await client.getSecret(name);
      console.log(secret.value);
      await client.setSecret(name, "updated-value");
    } else {
      const poller = await client.beginDeleteSecret(name);
      await poller.pollUntilDone();
      await client.purgeDeletedSecret(name);
    }`;
  const workspace = program(body);
  assert.equal(evaluateRule("prompt/update-secret", workspace), true);
  assert.equal(evaluateRule("prompt/delete-and-wait", workspace), false);
  assert.equal(evaluateRule("prompt/purge-after-delete", workspace), false);
});

test.skip("one coherent conditional path may implement the lifecycle", () => {
  const workspace = program(`    if (enabled) {
${completeLifecycle}
    }`);
  for (const rule of ruleNames().slice(2, 7)) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test.skip("delete completion is tied to one exact poller", () => {
  const separatePoller = completeLifecycle.replace(
    "await poller.pollUntilDone();",
    `const separate = await client.beginDeleteSecret(name);
    await separate.pollUntilDone();`,
  );
  const onePollAndBreak = completeLifecycle.replace(
    "await poller.pollUntilDone();",
    `while (!poller.isDone()) {
      await poller.poll();
      break;
    }`,
  );
  for (const body of [separatePoller, onePollAndBreak]) {
    assert.equal(evaluateRule("prompt/delete-and-wait", program(body)), false);
    assert.equal(evaluateRule("prompt/purge-after-delete", program(body)), false);
  }

  const alias = completeLifecycle.replace(
    "await poller.pollUntilDone();",
    "const deletion = poller;\n    await deletion.pollUntilDone();",
  );
  assert.equal(evaluateRule("prompt/delete-and-wait", program(alias)), true);
  assert.equal(evaluateRule("prompt/purge-after-delete", program(alias)), true);
});

test.skip("printed read must precede the update", () => {
  const postUpdateRead = completeLifecycle
    .replace("console.log(secret.value);\n", "")
    .replace(
      'await client.setSecret(name, "updated-value");',
      `await client.setSecret(name, "updated-value");
    const afterUpdate = await client.getSecret(name);
    console.log(afterUpdate.value);`,
    );
  assert.equal(
    evaluateRule("prompt/read-and-print", program(postUpdateRead)),
    false,
  );

  const helperImports = `
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
async function read(active, secretName) {
  return active.getSecret(secretName);
}`;
  const helperPostUpdate = `
    await client.setSecret(name, "my-secret-value");
    const before = await read(client, name);
    await client.setSecret(name, "updated-value");
    const after = await read(client, name);
    console.log(after.value);
    const poller = await client.beginDeleteSecret(name);
    await poller.pollUntilDone();
    await client.purgeDeletedSecret(name);`;
  assert.equal(
    evaluateRule(
      "prompt/read-and-print",
      program(helperPostUpdate, helperImports),
    ),
    false,
  );

  const bothReads = completeLifecycle.replace(
    'await client.setSecret(name, "updated-value");',
    `await client.setSecret(name, "updated-value");
    const afterUpdate = await client.getSecret(name);
    console.log(\`updated=\${afterUpdate.value}\`);`,
  );
  assert.equal(evaluateRule("prompt/read-and-print", program(bothReads)), true);

  const secondPreUpdateRead = completeLifecycle
    .replace("console.log(secret.value);", "")
    .replace(
      'await client.setSecret(name, "updated-value");',
      `const printable = await client.getSecret(name);
    console.info(\`created=\${printable.value}\`);
    await client.setSecret(name, "updated-value");`,
    );
  assert.equal(
    evaluateRule("prompt/read-and-print", program(secondPreUpdateRead)),
    true,
  );
});

test.skip("reachable awaited helpers may implement the lifecycle", () => {
  const source = `
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
async function create(active, name, value) {
  return active.setSecret(name, value);
}
async function run() {
  const name = "my-secret";
  try {
    await create(client, name, "my-secret-value");
    const result = await client.getSecret(name);
    console.log(result.value);
    await create(client, name, "updated-value");
    const poller = await client.beginDeleteSecret(name);
    await poller.pollUntilDone();
    await client.purgeDeletedSecret(name);
  } catch (error) {
    if (error instanceof RestError) console.error(error.message);
    throw error;
  }
}
await run();`;
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource(source)), true, rule);
  }
});

test.skip("awaited helpers may return read results and the delete poller", () => {
  const source = `
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
async function read(active, name) {
  return active.getSecret(name);
}
async function remove(active, name) {
  return active.beginDeleteSecret(name);
}
async function run() {
  const name = "my-secret";
  try {
    await client.setSecret(name, "my-secret-value");
    const secret = await read(client, name);
    console.info(\`value=\${secret.value}\`);
    await client.setSecret(name, "updated-value");
    const poller = await remove(client, name);
    await poller.pollUntilDone();
    await client.purgeDeletedSecret(name);
  } catch (error) {
    if (error instanceof RestError) console.error(error.statusCode);
    throw error;
  }
}
await run();`;
  const workspace = withSource(source);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test.skip("unreachable helper decoys cannot satisfy lifecycle criteria", () => {
  const source = program("    await unrelatedWork();").source + `
async function decoy() {
  ${completeLifecycle}
}`;
  for (const rule of ruleNames().slice(2, 7)) {
    assert.equal(evaluateRule(rule, withSource(source)), false, rule);
  }
});

test.skip("class and object methods with SDK-backed fields are accepted", () => {
  const variants = [
    `
class Workflow {
  client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  async run() {
    const name = "my-secret";
    try {
${completeLifecycle.replaceAll("client.", "this.client.")}
    } catch (error) {
      if (error instanceof RestError) console.error(error.message);
      throw error;
    }
  }
}
await new Workflow().run();`,
    `
const workflow = {
  client: new SecretClient(vaultUrl, new DefaultAzureCredential()),
  async run() {
    const name = "my-secret";
    try {
${completeLifecycle.replaceAll("client.", "this.client.")}
    } catch (error) {
      if (error instanceof RestError) console.error(error.message);
      throw error;
    }
  },
};
await workflow.run();`,
  ];
  const imports = `
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";`;
  for (const variant of variants) {
    const workspace = withSource(`${imports}\n${variant}`);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace), true, `${rule}\n${variant}`);
    }
  }
});

test.skip("RestError handling requires the real type, details, and unknown rethrow", () => {
  const badSources = [
    program(completeLifecycle).source.replace(
      "if (error instanceof RestError)",
      "if (error instanceof Error)",
    ),
    program(completeLifecycle).source.replace(
      "console.error(error.statusCode, error.message);",
      'console.error("request failed");',
    ),
    program(completeLifecycle).source.replace("    throw error;", ""),
    program(completeLifecycle).source.replace(
      "async function main() {",
      "async function main(RestError) {",
    ),
  ];
  for (const source of badSources) {
    assert.equal(
      evaluateRule("prompt/rest-error", withSource(source)),
      false,
      source,
    );
  }
});

test.skip("exhaustive else and negated RestError catches are accepted", () => {
  const catches = [
    `if (error instanceof RestError) {
      console.error(error.message);
    } else {
      throw error;
    }`,
    `if (!(error instanceof RestError)) {
      throw error;
    }
    console.warn(error.statusCode);`,
  ];
  for (const catchBody of catches) {
    const source = program(completeLifecycle).source.replace(
      /if \(error instanceof RestError\) \{[\s\S]*?\n    \}\n    throw error;/,
      catchBody,
    );
    assert.equal(evaluateRule("prompt/rest-error", withSource(source)), true);
  }
});

test.skip("all catches must preserve unknown failures", () => {
  const swallowed = program(completeLifecycle).source + `
try {
  await unrelatedWork();
} catch (unrelated) {
  console.warn(unrelated);
}`;
  assert.equal(
    evaluateRule("prompt/rest-error", withSource(swallowed)),
    false,
  );

  const propagated = swallowed.replace(
    "  console.warn(unrelated);",
    "  console.warn(unrelated);\n  throw unrelated;",
  );
  assert.equal(
    evaluateRule("prompt/rest-error", withSource(propagated)),
    true,
  );
});

test.skip("comments, strings, and local fakes cannot satisfy behavior", () => {
  const source = `
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
const text = \`
  await new SecretClient(url, new DefaultAzureCredential())
    .setSecret("my-secret", "my-secret-value");
  poller.pollUntilDone();
\`;
// await client.getSecret("my-secret");
function SecretClient() {}
`;
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, withSource(source)), false, rule);
  }
});

test.skip("tri-state guards follow bindings, aliases, reassignment, and operators", () => {
  const guarded = (setup, condition) => program(`
    ${setup}
    if (${condition}) {
${completeLifecycle}
    }`);
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      guarded("const enabled = false;", "enabled"),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete",
      guarded("const enabled = externalFlag;", "enabled"),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete",
      guarded(
        `let disabled = true;
    const alias = disabled;
    disabled = false;`,
        "!((disabled)) && (alias || externalFlag)",
      ),
    ),
    true,
  );
});

test.skip("TypeScript branch joins merge boolean environments", () => {
  const joined = (left, right) => program(`
    let enabled = false;
    if (externalFlag) {
      enabled = ${left};
    } else {
      enabled = ${right};
    }
    if (enabled) {
${completeLifecycle}
    }`);
  assert.equal(
    evaluateRule("prompt/purge-after-delete", joined("true", "true")),
    true,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", joined("false", "false")),
    false,
  );
  assert.equal(
    evaluateRule("prompt/purge-after-delete", joined("true", "false")),
    true,
  );
});

test.skip("TypeScript return and throw guards constrain continuation paths", () => {
  for (const abrupt of ["return", 'throw new Error("stop")']) {
    const workspace = program(`
    const stop = externalFlag;
    if (stop) ${abrupt};
${completeLifecycle}`);
    assert.equal(
      evaluateRule("prompt/purge-after-delete", workspace),
      true,
      abrupt,
    );
  }

  const terminated = program(`
    if (externalFlag) {
      await client.setSecret(name, "my-secret-value");
      const secret = await client.getSecret(name);
      console.log(secret.value);
      await client.setSecret(name, "updated-value");
      return;
    }
    const poller = await client.beginDeleteSecret(name);
    await poller.pollUntilDone();
    await client.purgeDeletedSecret(name);`);
  assert.equal(
    evaluateRule("prompt/purge-after-delete", terminated),
    false,
  );
});

test.skip("false guards suppress reachable helpers and catch-path decoys", () => {
  const helper = program(`
    const enabled = false;
    if (enabled) {
      await lifecycle(client, name);
    }`).source + `
async function lifecycle(client, name) {
${completeLifecycle}
}`;
  assert.equal(
    evaluateRule("prompt/create-secret", withSource(helper)),
    false,
  );

  const catchDecoy = program("    await unrelatedWork();").source.replace(
    "    throw error;",
    `    const enabled = false;
    if (enabled) {
${completeLifecycle}
    }
    throw error;`,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", withSource(catchDecoy)),
    false,
  );

  const guardedHelper = (argument) => withSource(`
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const disabled = false;
async function lifecycle(enabled, client) {
  const name = "my-secret";
  if (enabled) {
${completeLifecycle}
  }
}
await lifecycle(${argument}, client);
`);
  assert.equal(
    evaluateRule("prompt/create-secret", guardedHelper("false")),
    false,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", guardedHelper("disabled")),
    false,
  );
  for (const argument of ["true", "externalFlag"]) {
    assert.equal(
      evaluateRule("prompt/purge-after-delete", guardedHelper(argument)),
      true,
      argument,
    );
  }
});

test.skip("for loops suppress false and empty literal bodies but retain unknown paths", () => {
  const looped = (header) => program(`
    ${header} {
${completeLifecycle}
    }`);
  for (const header of [
    "for (let index = 0; false; index++)",
    "for (const item of [])",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", looped(header)),
      false,
      header,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete",
      looped("for (const item of externalItems)"),
    ),
    true,
  );
});

test.skip("catch lifecycle operations require a potentially throwing try", () => {
  const caught = (tryBody) => {
    const source = `${tryBody === "harmless();" ? "function harmless() { const value = 1; }\n" : ""}${program(`    ${tryBody}`).source}`.replace(
      "    if (error instanceof RestError) {",
      `${completeLifecycle}
    if (error instanceof RestError) {`,
    );
    return withSource(source);
  };
  for (const body of [
    "",
    "const value = 1;",
    "if (false) { unrelatedWork(); }",
    "harmless();",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", caught(body)),
      false,
      body,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete",
      caught("await unrelatedWork();"),
    ),
    true,
  );
});

test.skip("ternary arms cannot combine and short-circuit helpers honor reachability", () => {
  const split = withSource(`
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const name = "my-secret";
async function prefix(client, name) {
  await client.setSecret(name, "my-secret-value");
  const secret = await client.getSecret(name);
  console.log(secret.value);
  await client.setSecret(name, "updated-value");
}
async function suffix(client, name) {
  const poller = await client.beginDeleteSecret(name);
  await poller.pollUntilDone();
  await client.purgeDeletedSecret(name);
}
await (externalFlag ? prefix(client, name) : suffix(client, name));
`);
  assert.equal(
    evaluateRule("prompt/purge-after-delete", split),
    false,
  );

  const guarded = (expression) => withSource(`
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
async function lifecycle(client) {
  const name = "my-secret";
${completeLifecycle}
  return true;
}
${expression};
`);
  for (const expression of [
    "false && (await lifecycle(client))",
    "true || (await lifecycle(client))",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", guarded(expression)),
      false,
      expression,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete",
      guarded("externalFlag && (await lifecycle(client))"),
    ),
    true,
  );
});

test.skip("TypeScript iterable aliases use current values and branch joins", () => {
  const looped = (setup) => program(`
    ${setup}
    for (const item of selected) {
${completeLifecycle}
    }`);
  for (const setup of [
    "let selected = [];",
    "let selected = [1]; const alias = selected; selected = [];",
    `let selected = [];
    if (externalFlag) selected = [];
    else selected = [];`,
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", looped(setup)),
      false,
      setup,
    );
  }
  for (const setup of [
    "let selected = []; selected = [1];",
    "let selected = [1]; const alias = selected; selected = []; selected = alias;",
    "const selected = externalItems;",
    `let selected = [];
    if (externalFlag) selected = [];
    else selected = [1];`,
  ]) {
    assert.equal(
      evaluateRule("prompt/purge-after-delete", looped(setup)),
      true,
      setup,
    );
  }
});

test.skip("TypeScript helper defaults and folded strings require exact constants", () => {
  const helper = (argumentsList) => withSource(`
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
async function lifecycle(
  client,
  name = "my-" + "secret",
  initial = \`my-\${"secret-value"}\`,
  updated = "updated-" + "value"
) {
  await client.setSecret(name, initial);
  const secret = await client.getSecret(name);
  console.log(secret.value);
  await client.setSecret(name, updated);
  const poller = await client.beginDeleteSecret(name);
  await poller.pollUntilDone();
  await client.purgeDeletedSecret(name);
}
await lifecycle(${argumentsList});
`);
  assert.equal(
    evaluateRule("prompt/purge-after-delete", helper("client")),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      helper('client, "wrong-" + dynamicPart'),
    ),
    false,
  );

  const joined = (alternate) => program(`
    let name = "wrong";
    if (externalFlag) name = "my-" + "secret";
    else name = ${alternate};
${completeLifecycle}`);
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete",
      joined('`my-${"secret"}`'),
    ),
    true,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", joined('"wrong"')),
    false,
  );
});
