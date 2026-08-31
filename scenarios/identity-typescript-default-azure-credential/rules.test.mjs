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
} from "./tools/identity-typescript-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadTypeScriptWorkspace(goldenWorkspacePath);
const baseline33374429826 = loadTypeScriptWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33374429826", import.meta.url),
  ),
);

function withSource(source) {
  return { ...completeWorkspace, source };
}

function withIdentitySource(source) {
  return withSource(`
import {
  AuthenticationError,
  DefaultAzureCredential,
} from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
${source}
`);
}

test("TypeScript Identity reference passes every prompt rule", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/identity-packages",
    "prompt/default-azure-credential",
    "prompt/credential-client-association",
    "prompt/authenticated-operation",
    "prompt/authentication-errors",
    "prompt/identity-diagnostics",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("TypeScript Identity reference passes every language check", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, completeWorkspace),
      true,
      check,
    );
  }
});

test("baseline run 33374429826 exact output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, baseline33374429826),
      true,
      check,
    );
  }
});

test("module-scoped authenticated clients retain operation provenance", () => {
  const source = `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
async function read(name: string): Promise<void> {
  const secret = await client.getSecret(name);
  console.info(\`secret=\${secret.value}\`);
}
await read(secretName);
`;
  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    true,
  );
});

test("module-scoped client provenance is invalidated by credential mutation", () => {
  const source = `
let credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
credential = anotherCredential;
async function read(name: string): Promise<void> {
  const secret = await client.getSecret(name);
  console.info(\`secret=\${secret.value}\`);
}
await read(secretName);
`;
  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    false,
  );
});

test("all three runtime packages are required", () => {
  for (const packageName of [
    "@azure/identity",
    "@azure/keyvault-secrets",
    "@azure/logger",
  ]) {
    const manifest = JSON.parse(completeWorkspace.packageJson);
    delete manifest.dependencies[packageName];
    assert.equal(
      evaluateRule("prompt/identity-packages", {
        ...completeWorkspace,
        packageJson: JSON.stringify(manifest),
      }),
      false,
      packageName,
    );
  }
});

test("every rule rejects a workspace without generated source", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source: "" }),
      false,
      rule,
    );
  }
});

test("credential construction accepts valid options, aliases, and qualified forms", () => {
  const sources = [
    `
import { DefaultAzureCredential as Credential } from "@azure/identity";
const credential = new Credential({ excludeAzureCliCredential: false });
`,
    `
import * as identity from "@azure/identity";
const credential = new identity.DefaultAzureCredential();
`,
    `
const credential = new DefaultAzureCredential({
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
});
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/default-azure-credential",
        withIdentitySource(source),
      ),
      true,
      source,
    );
  }
});

test("bound and inline credentials supplied to SecretClient are accepted", () => {
  const bound = `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
`;
  const inline = `
import * as identity from "@azure/identity";
import * as keyVault from "@azure/keyvault-secrets";
const client = new keyVault.SecretClient(
  vaultUrl,
  new identity.DefaultAzureCredential({ excludeEnvironmentCredential: false }),
);
`;

  for (const source of [bound, inline]) {
    assert.equal(
      evaluateRule(
        "prompt/credential-client-association",
        withIdentitySource(source),
      ),
      true,
      source,
    );
  }
});

test("unused credentials and clients using a different credential fail association", () => {
  const sources = [
    `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, anotherCredential);
`,
    `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, anotherCredential, { credential });
`,
    `
const credential = new DefaultAzureCredential();
console.log("credential prepared");
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/credential-client-association",
        withIdentitySource(source),
      ),
      false,
      source,
    );
  }
});

test("the secret operation must run on the credential-backed client", () => {
  const source = `
const credential = new DefaultAzureCredential();
const authenticatedClient = new SecretClient(vaultUrl, credential);
const disconnectedClient = new SecretClient(vaultUrl, anotherCredential);
const secret = await disconnectedClient.getSecret(secretName);
console.log(secret.value);
`;

  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      withIdentitySource(source),
    ),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    false,
  );
});

test("client and credential overwrites invalidate authentication provenance", () => {
  const clientOverwrite = `
let credential = new DefaultAzureCredential();
let client = new SecretClient(vaultUrl, credential);
client = disconnectedClient;
const secret = await client.getSecret(secretName);
console.log(secret.value);
`;
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      withIdentitySource(clientOverwrite),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/authenticated-operation",
      withIdentitySource(clientOverwrite),
    ),
    false,
  );

  const credentialOverwriteBeforeAssociation = `
let credential = new DefaultAzureCredential();
credential = anotherCredential;
const client = new SecretClient(vaultUrl, credential);
`;
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      withIdentitySource(credentialOverwriteBeforeAssociation),
    ),
    false,
  );

  const credentialOverwriteBeforeOperation = `
let credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
credential = anotherCredential;
const secret = await client.getSecret(secretName);
console.log(secret.value);
`;
  assert.equal(
    evaluateRule(
      "prompt/authenticated-operation",
      withIdentitySource(credentialOverwriteBeforeOperation),
    ),
    false,
  );
});

test("credential and client binding state respects lexical scope", () => {
  const source = `
const credential = new DefaultAzureCredential();
{
  const credential = anotherCredential;
  const disconnectedClient = new SecretClient(vaultUrl, credential);
}
const client = new SecretClient(vaultUrl, credential);
const secret = await client.getSecret(secretName);
console.log(secret.value);
`;

  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      withIdentitySource(source),
    ),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    true,
  );
});

test("bound, destructured, direct, and Promise secret operations are accepted", () => {
  const operations = [
    `
const secret = await client.getSecret(secretName);
console.log(secret.value);
`,
    `
const { value: secretValue } = await client.getSecret(secretName);
console.info(secretValue);
`,
    `
console.log((await client.getSecret(secretName)).value);
`,
    `
return client.getSecret(secretName).then((secret) => console.log(secret.value));
`,
  ];

  for (const operation of operations) {
    const source = `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
${operation}
`;
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        withIdentitySource(source),
      ),
      true,
      operation,
    );
  }
});

test("extracted secret-value aliases and template output are accepted", () => {
  const sources = [
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const secret = await client.getSecret(secretName);
const secretValue = secret.value;
console.log(secretValue);
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const secret = await client.getSecret(secretName);
const secretValue = secret.value;
console.info(\`Retrieved secret: \${secretValue}\`);
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const secretValue = (await client.getSecret(secretName)).value;
console.log(\`Retrieved secret: \${secretValue}\`);
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const secret = await client.getSecret(secretName);
console.log(\`Retrieved secret: \${secret.value}\`);
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        withIdentitySource(source),
      ),
      true,
      source,
    );
  }
});

test("secret output must retain credential-backed value provenance", () => {
  const sources = [
    `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
const disconnectedClient = new SecretClient(vaultUrl, anotherCredential);
let secret = await client.getSecret(secretName);
secret = await disconnectedClient.getSecret(secretName);
console.log(secret.value);
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
let secret = await client.getSecret(secretName);
secret = fallbackSecret;
console.info(secret.value);
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const secret = await client.getSecret(secretName);
secret.value = "not the retrieved value";
console.log(secret.value);
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
let { value: secretValue } = await client.getSecret(secretName);
secretValue = fallbackValue;
console.log(secretValue);
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        withIdentitySource(source),
      ),
      false,
      source,
    );
  }
});

test("credential-backed values may be consumed before or after valid reassignment", () => {
  const operations = [
    `
let secret;
secret = await client.getSecret(secretName);
console.log(secret.value);
`,
    `
let secret = await client.getSecret(firstSecretName);
secret = await client.getSecret(secondSecretName);
console.info(secret.value);
`,
    `
const secret = await client.getSecret(secretName);
console.log(secret.value);
secret = fallbackSecret;
`,
  ];

  for (const operation of operations) {
    const source = `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
${operation}
`;
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        withIdentitySource(source),
      ),
      true,
      operation,
    );
  }
});

test("an inner shadow assignment does not overwrite the retrieved value", () => {
  const source = `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const secret = await client.getSecret(secretName);
{
  let secret = fallbackSecret;
  secret = anotherFallbackSecret;
}
console.log(secret.value);
`;

  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    true,
  );
});

test("a block var redeclaration overwrites the function-scoped retrieved value", () => {
  const source = `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
var secret = await client.getSecret(secretName);
{
  var secret = fallbackSecret;
}
console.log(secret.value);
`;

  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    false,
  );
});

test("output before a block var redeclaration retains retrieved provenance", () => {
  const source = `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
var secret = await client.getSecret(secretName);
console.log(secret.value);
{
  var secret = fallbackSecret;
}
`;

  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    true,
  );
});

test("inner let and const declarations shadow the retrieved value lexically", () => {
  for (const declaration of ["let", "const"]) {
    const source = `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
var secret = await client.getSecret(secretName);
{
  ${declaration} secret = fallbackSecret;
}
console.log(secret.value);
`;

    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        withIdentitySource(source),
      ),
      true,
      declaration,
    );
  }
});

test("a nested function var declaration does not overwrite the outer value", () => {
  const source = `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
var secret = await client.getSecret(secretName);
function replaceSecret() {
  var secret = fallbackSecret;
  return secret;
}
console.log(secret.value);
`;

  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    true,
  );
});

test("method-local var declarations preserve outer value provenance", () => {
  const methodDeclarations = [
    `class Reader {
  replaceSecret() {
    var secret = fallbackSecret;
  }
}`,
    `const reader = {
  replaceSecret() {
    var secret = fallbackSecret;
  },
};`,
    `class Reader {
  async replaceSecret() {
    var secret = fallbackSecret;
  }
}`,
    `const reader = {
  async replaceSecret() {
    var secret = fallbackSecret;
  },
};`,
    `const reader = {
  get currentSecret() {
    var secret = fallbackSecret;
    return secret;
  },
};`,
    `const reader = {
  set currentSecret(secret) {
    secret = fallbackSecret;
  },
};`,
  ];

  for (const methodDeclaration of methodDeclarations) {
    const source = `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
var secret = await client.getSecret(secretName);
${methodDeclaration}
console.log(secret.value);
`;

    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        withIdentitySource(source),
      ),
      true,
      methodDeclaration,
    );
  }
});

test("a nested block var overwrite invalidates its method binding", () => {
  const source = `
class Reader {
  async readSecret() {
    const client = new SecretClient(
      vaultUrl,
      new DefaultAzureCredential(),
    );
    var secret = await client.getSecret(secretName);
    {
      var secret = fallbackSecret;
    }
    console.log(secret.value);
  }
}
`;

  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    false,
  );
});

test("control-flow blocks do not create callable scopes", () => {
  const source = `
async function readSecrets(stream) {
  const client = new SecretClient(
    vaultUrl,
    new DefaultAzureCredential(),
  );
  var secret = await client.getSecret(secretName);
  for await (const item of stream) {
    var secret = fallbackSecret;
  }
  console.log(secret.value);
}
`;

  assert.equal(
    evaluateRule("prompt/authenticated-operation", withIdentitySource(source)),
    false,
  );
});

test("nested mutation and shadowed output do not retain outer provenance", () => {
  const sources = [`
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
let secret = await client.getSecret(secretName);
{
  secret = fallbackSecret;
}
console.log(secret.value);
`, `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const secret = await client.getSecret(secretName);
{
  const secret = fallbackSecret;
  console.log(secret.value);
}
`];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        withIdentitySource(source),
      ),
      false,
      source,
    );
  }
});

test("retrieved values remain available to legitimate nested output", () => {
  const sources = [
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const secret = await client.getSecret(secretName);
{
  console.log(secret.value);
}
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
const secret = await client.getSecret(secretName);
{
  const displayedValue = secret.value;
  console.info(displayedValue);
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        withIdentitySource(source),
      ),
      true,
      source,
    );
  }
});

test("missing secret arguments or value output fail the operation rule", () => {
  const sources = [
    `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
const secret = await client.getSecret();
console.log(secret.value);
`,
    `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
const secret = await client.getSecret(secretName);
console.log("retrieved");
`,
    `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
const secret = client.getSecret(secretName);
console.log(secret.value);
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
await client.getSecret(secretName);
const secret = await client.getSecret();
console.log(secret.value);
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        withIdentitySource(source),
      ),
      false,
      source,
    );
  }
});

test("AuthenticationError aliases and qualified forms are accepted", () => {
  const sources = [
    `
import { AuthenticationError as CredentialError } from "@azure/identity";
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
try {
  await client.getSecret(secretName);
} catch (problem: unknown) {
  if (problem instanceof CredentialError) {
    console.error(problem.message);
  }
  throw problem;
}
`,
    `
import * as identity from "@azure/identity";
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try {
  return await client.getSecret(secretName);
} catch (error) {
  if (error instanceof identity.AuthenticationError) {
    console.warn("Authentication failed", error);
  }
  throw error;
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        withIdentitySource(source),
      ),
      true,
      source,
    );
  }
});

test("authentication handling must wrap the credential-backed operation", () => {
  const sources = [
    `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
await client.getSecret(secretName);

try {
  await unrelatedWork();
} catch (error: unknown) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
  }
  throw error;
}
`,
    `
const credential = new DefaultAzureCredential();
const authenticatedClient = new SecretClient(vaultUrl, credential);
const disconnectedClient = new SecretClient(vaultUrl, anotherCredential);
try {
  await disconnectedClient.getSecret(secretName);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
  }
  throw error;
}
`,
    `
const client = new SecretClient(
  vaultUrl,
  new DefaultAzureCredential(),
);
try {
  client.getSecret(secretName);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
  }
  throw error;
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        withIdentitySource(source),
      ),
      false,
      source,
    );
  }
});

test("authentication handling accepts bound and inline credential clients", () => {
  const sources = [
    `
const credential = new DefaultAzureCredential();
const client = new SecretClient(vaultUrl, credential);
try {
  const secret = await client.getSecret(secretName);
  console.log(secret.value);
} catch (error: unknown) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
  }
  throw error;
}
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try {
  return await client.getSecret(secretName);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.warn(error.name);
  }
  throw error;
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        withIdentitySource(source),
      ),
      true,
      source,
    );
  }
});

test("template-interpolated authentication diagnostics are accepted", () => {
  const source = `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try {
  await client.getSecret(secretName);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(\`Azure credential authentication failed: \${error.message}\`);
  } else {
    throw error;
  }
}
`;
  assert.equal(
    evaluateRule("prompt/authentication-errors", withIdentitySource(source)),
    true,
  );
});

test("non-authentication errors must be rethrown outside the auth branch", () => {
  const source = `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try {
  await client.getSecret(secretName);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
    throw error;
  }
}
`;

  assert.equal(
    evaluateRule("prompt/authentication-errors", withIdentitySource(source)),
    false,
  );
});

test("else rethrows and negated guards preserve non-authentication errors", () => {
  const sources = [
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try {
  await client.getSecret(secretName);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
  } else {
    throw error;
  }
}
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try {
  await client.getSecret(secretName);
} catch (error) {
  if (!(error instanceof AuthenticationError)) {
    throw error;
  }
  console.warn(error);
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        withIdentitySource(source),
      ),
      true,
      source,
    );
  }
});

test("generic, wrong, and static-message catches fail authentication handling", () => {
  const sources = [
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try { await client.getSecret(secretName); } catch (error) {
  console.error(error);
}
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try { await client.getSecret(secretName); } catch (error) {
  if (error instanceof RestError) console.error(error);
}
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try { await client.getSecret(secretName); } catch (error) {
  if (error instanceof AuthenticationError) {
    console.error("Authentication failed");
  }
}
`,
    `
const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
try { await client.getSecret(secretName); } catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(error);
  }
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        withIdentitySource(source),
      ),
      false,
      source,
    );
  }
});

test("logger aliases, namespaces, and bound valid levels enable diagnostics", () => {
  const sources = [
    `
import { setLogLevel as configureAzureLogging } from "@azure/logger";
configureAzureLogging("verbose");
`,
    `
import * as azureLogger from "@azure/logger";
const diagnosticLevel = "warning";
azureLogger.setLogLevel(diagnosticLevel);
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/identity-diagnostics", withSource(source)),
      true,
      source,
    );
  }
});

test("fake diagnostics and unsupported log levels fail", () => {
  const sources = [
    `console.log("Identity diagnostics enabled with setLogLevel(info)");`,
    `
import { setLogLevel } from "@azure/logger";
setLogLevel("debug");
`,
    `
function setLogLevel(level) {}
setLogLevel("info");
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/identity-diagnostics", withSource(source)),
      false,
      source,
    );
  }
});

test("comments and strings cannot satisfy behavior rules", () => {
  const source = `
// const credential = new DefaultAzureCredential();
/*
const client = new SecretClient(vaultUrl, credential);
const secret = await client.getSecret(secretName);
console.log(secret.value);
*/
const documentation = \`
  new DefaultAzureCredential();
  if (error instanceof AuthenticationError) console.error(error);
  setLogLevel("info");
\`;
`;

  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, withIdentitySource(source)), false, rule);
  }
});
