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
} from "./tools/managed-identity-typescript-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadTypeScriptWorkspace(goldenPath);

function withSource(source) {
  return { ...completeWorkspace, source };
}

function identitySource(source) {
  return withSource(`
import {
  AzureCliCredential,
  ChainedTokenCredential,
  CredentialUnavailableError,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
const vaultUrl = process.env.AZURE_KEY_VAULT_URL!;
const secretName = process.env.AZURE_KEY_VAULT_SECRET_NAME!;
${source}
`);
}

test("reference passes all eight deterministic rules", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/identity-packages",
    "prompt/system-assigned-credential",
    "prompt/user-assigned-credential",
    "prompt/default-azure-credential",
    "prompt/local-fallback-chain",
    "prompt/credential-client-association",
    "prompt/authenticated-operation",
    "prompt/credential-unavailable-error",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("reference passes shared TypeScript static checks", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, completeWorkspace),
      true,
      check,
    );
  }
});

test("every rule rejects missing generated source", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source: "" }),
      false,
      rule,
    );
  }
});

test("package rule requires real dependencies and imports", () => {
  for (const packageName of [
    "@azure/identity",
    "@azure/keyvault-secrets",
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

  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      withSource(`
import { ManagedIdentityCredential } from "@fake/identity";
import { SecretClient } from "@fake/keyvault-secrets";
`),
    ),
    false,
  );
});

test("system-assigned credentials accept aliases, namespaces, and options", () => {
  const sources = [
    `
import { ManagedIdentityCredential as ManagedCredential } from "@azure/identity";
const credential = new ManagedCredential();
`,
    `
import * as identity from "@azure/identity";
const credential = new identity.ManagedIdentityCredential({});
`,
    `
const options = { retryOptions: { maxRetries: 3 } };
const credential = new ManagedIdentityCredential(options);
`,
  ];
  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/system-assigned-credential",
        identitySource(source),
      ),
      true,
      source,
    );
  }
});

test("user-assigned credentials require AZURE_CLIENT_ID provenance", () => {
  const positive = [
    `
const clientId = process.env.AZURE_CLIENT_ID;
const credential = new ManagedIdentityCredential(clientId!);
`,
    `
const clientId = process.env["AZURE_CLIENT_ID"];
const options = { clientId };
const credential = new ManagedIdentityCredential(options);
`,
    `
import * as identity from "@azure/identity";
const credential = new identity.ManagedIdentityCredential({
  clientId: process.env.AZURE_CLIENT_ID!,
});
`,
  ];
  for (const source of positive) {
    assert.equal(
      evaluateRule(
        "prompt/user-assigned-credential",
        identitySource(source),
      ),
      true,
      source,
    );
  }

  const negative = [
    `const credential = new ManagedIdentityCredential("hard-coded-id");`,
    `const credential = new ManagedIdentityCredential({ clientId: otherId });`,
    `const credential = new ManagedIdentityCredential({ resourceId });`,
    `const credential = new ManagedIdentityCredential({ objectId });`,
  ];
  for (const source of negative) {
    assert.equal(
      evaluateRule(
        "prompt/user-assigned-credential",
        identitySource(source),
      ),
      false,
      source,
    );
  }
});

test("DefaultAzureCredential must configure managed identity from the env ID", () => {
  const positive = [
    `
const clientId = process.env.AZURE_CLIENT_ID;
const credential = new DefaultAzureCredential({
  managedIdentityClientId: clientId,
});
`,
    `
const clientId = process.env["AZURE_CLIENT_ID"];
const options = { managedIdentityClientId: clientId };
const credential = new DefaultAzureCredential(options);
`,
    `
import { DefaultAzureCredential as DefaultCredential } from "@azure/identity";
const credential = new DefaultCredential({
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
});
`,
  ];
  for (const source of positive) {
    assert.equal(
      evaluateRule(
        "prompt/default-azure-credential",
        identitySource(source),
      ),
      true,
      source,
    );
  }

  for (const source of [
    `const credential = new DefaultAzureCredential();`,
    `const credential = new DefaultAzureCredential({});`,
    `const credential = new DefaultAzureCredential({
       managedIdentityClientId: unrelatedClientId,
     });`,
    `const credential = new DefaultAzureCredential({
       managedIdentityClientId: process.env.AZURE_CLIENT_ID,
       excludeManagedIdentityCredential: true,
     });`,
    `
const disableManagedIdentity = true;
const credential = new DefaultAzureCredential({
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  excludeManagedIdentityCredential: disableManagedIdentity,
});
`,
    `
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
};
options.excludeManagedIdentityCredential = true;
const credential = new DefaultAzureCredential(options);
`,
    `
const disabled = { excludeManagedIdentityCredential: true };
const credential = new DefaultAzureCredential({
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  ...disabled,
});
`,
    `const credential = new DefaultAzureCredential({
       managedIdentityClientId: process.env.AZURE_CLIENT_ID,
       ["excludeManagedIdentityCredential"]: true,
     });`,
    `const credential = new DefaultAzureCredential({
       clientId: process.env.AZURE_CLIENT_ID,
     });`,
    `const credential = new DefaultAzureCredential({
       excludeManagedIdentityCredential: false,
     });`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/default-azure-credential",
        identitySource(source),
      ),
      false,
      source,
    );
  }
});

test("option property writes preserve state, aliases, and source order", () => {
  const defaultCredentialSources = [
    `
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
};
options.excludeManagedIdentityCredential = false;
const credential = new DefaultAzureCredential(options);
`,
    `
const enabled = false;
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
};
options.excludeManagedIdentityCredential = enabled;
const credential = new DefaultAzureCredential(options);
`,
    `
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  excludeManagedIdentityCredential: true,
};
options.excludeManagedIdentityCredential = false;
const credential = new DefaultAzureCredential(options);
`,
    `
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  excludeManagedIdentityCredential: true,
};
const alias = options;
alias.excludeManagedIdentityCredential = false;
const credential = new DefaultAzureCredential(options);
`,
    `
const options = { excludeManagedIdentityCredential: false };
options.managedIdentityClientId = process.env.AZURE_CLIENT_ID;
const credential = new DefaultAzureCredential(options);
`,
    `
class CredentialFactory {
  private options = {
    managedIdentityClientId: process.env.AZURE_CLIENT_ID,
    excludeManagedIdentityCredential: true,
  };

  create(): DefaultAzureCredential {
    this.options.excludeManagedIdentityCredential = false;
    const credential = new DefaultAzureCredential(this.options);
    return credential;
  }
}
`,
  ];
  for (const source of defaultCredentialSources) {
    assert.equal(
      evaluateRule(
        "prompt/default-azure-credential",
        identitySource(source),
      ),
      true,
      source,
    );
  }

  const managedOptions = `
const options = {};
const alias = options;
alias.clientId = process.env.AZURE_CLIENT_ID;
const credential = new ManagedIdentityCredential(options);
`;
  assert.equal(
    evaluateRule(
      "prompt/user-assigned-credential",
      identitySource(managedOptions),
    ),
    true,
  );

  const laterMutation = `
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  excludeManagedIdentityCredential: false,
};
const credential = new DefaultAzureCredential(options);
options.excludeManagedIdentityCredential = true;
const client = new SecretClient(vaultUrl, credential);
`;
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      identitySource(laterMutation),
    ),
    true,
  );
});

test("unsafe option writes, reassignment, and env fallbacks fail", () => {
  const sources = [
    `
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  excludeManagedIdentityCredential: false,
};
options.excludeManagedIdentityCredential = true;
const credential = new DefaultAzureCredential(options);
`,
    `
const disabled = true;
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
};
options.excludeManagedIdentityCredential = disabled;
const credential = new DefaultAzureCredential(options);
`,
    `
let disabled: boolean;
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
};
options.excludeManagedIdentityCredential = disabled;
const credential = new DefaultAzureCredential(options);
`,
    `
let options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
};
options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  excludeManagedIdentityCredential: false,
};
const credential = new DefaultAzureCredential(options);
`,
    `
const clientId = process.env.AZURE_CLIENT_ID ?? "fallback-client-id";
const options = { managedIdentityClientId: clientId };
const credential = new DefaultAzureCredential(options);
`,
    `
const options = { excludeManagedIdentityCredential: false };
options.managedIdentityClientId =
  process.env.AZURE_CLIENT_ID || "fallback-client-id";
const credential = new DefaultAzureCredential(options);
`,
    `
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
};
options["excludeManagedIdentityCredential"] = false;
const credential = new DefaultAzureCredential(options);
`,
    `
const options = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
};
Object.assign(options, { excludeManagedIdentityCredential: false });
const credential = new DefaultAzureCredential(options);
`,
    `
class CredentialFactory {
  private options = {
    managedIdentityClientId: process.env.AZURE_CLIENT_ID,
  };

  create(): DefaultAzureCredential {
    this.options = {
      managedIdentityClientId: process.env.AZURE_CLIENT_ID,
      excludeManagedIdentityCredential: false,
    };
    const credential = new DefaultAzureCredential(this.options);
    return credential;
  }
}
`,
    `
const base = {
  managedIdentityClientId: process.env.AZURE_CLIENT_ID,
};
const options = {
  ...base,
  excludeManagedIdentityCredential: false,
};
const credential = new DefaultAzureCredential(options);
`,
    `
function readEnvironment(name: string): string {
  const value = process.env[name] ?? "fallback-client-id";
  return value;
}
const options = {
  managedIdentityClientId: readEnvironment("AZURE_CLIENT_ID"),
};
const credential = new DefaultAzureCredential(options);
`,
  ];
  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/default-azure-credential",
        identitySource(source),
      ),
      false,
      source,
    );
  }

  const alternativeSelectorWrite = `
const options = {};
options.resourceId = managedIdentityResourceId;
const credential = new ManagedIdentityCredential(options);
`;
  assert.equal(
    evaluateRule(
      "prompt/system-assigned-credential",
      identitySource(alternativeSelectorWrite),
    ),
    false,
  );
});

test("fallback chain accepts bound and inline credentials in required order", () => {
  const positive = [
    `
const managed = new ManagedIdentityCredential();
const cli = new AzureCliCredential();
const credential = new ChainedTokenCredential(managed, cli);
`,
    `
const clientId = process.env.AZURE_CLIENT_ID;
const credential = new ChainedTokenCredential(
  new ManagedIdentityCredential({ clientId }),
  new AzureCliCredential(),
);
`,
    `
import * as identity from "@azure/identity";
const managed = new identity.ManagedIdentityCredential();
const credential = new identity.ChainedTokenCredential(
  managed,
  new identity.AzureCliCredential(),
);
`,
  ];
  for (const source of positive) {
    assert.equal(
      evaluateRule("prompt/local-fallback-chain", identitySource(source)),
      true,
      source,
    );
  }

  const negative = [
    `
const managed = new ManagedIdentityCredential();
const cli = new AzureCliCredential();
const credential = new ChainedTokenCredential(cli, managed);
`,
    `
const managed = new ManagedIdentityCredential();
const credential = new ChainedTokenCredential(managed, anotherCredential);
`,
    `const credential = new ChainedTokenCredential(new AzureCliCredential());`,
    `
const managed = new ManagedIdentityCredential();
const credential = new ChainedTokenCredential(managed, new AzureCliCredential());
credential = anotherCredential;
`,
  ];
  for (const source of negative) {
    assert.equal(
      evaluateRule("prompt/local-fallback-chain", identitySource(source)),
      false,
      source,
    );
  }
});

test("credential association accepts bound and inline valid forms", () => {
  const sources = [
    `
const managed = new ManagedIdentityCredential();
const credential = new ChainedTokenCredential(
  managed,
  new AzureCliCredential(),
);
const client = new SecretClient(vaultUrl, credential);
`,
    `
const clientId = process.env.AZURE_CLIENT_ID;
const client = new SecretClient(
  vaultUrl,
  new DefaultAzureCredential({ managedIdentityClientId: clientId }),
);
`,
    `
const client = new SecretClient(
  vaultUrl,
  new ChainedTokenCredential(
    new ManagedIdentityCredential(),
    new AzureCliCredential(),
  ),
);
`,
  ];
  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/credential-client-association",
        identitySource(source),
      ),
      true,
      source,
    );
  }
});

test("Key Vault URL and secret name require environment provenance", () => {
  for (const source of [
    `
const client = new SecretClient(
  "https://literal.vault.azure.net",
  new ManagedIdentityCredential(),
);
`,
    `
const unrelatedUrl = process.env.UNRELATED_URL;
const client = new SecretClient(
  unrelatedUrl,
  new ManagedIdentityCredential(),
);
`,
    `
function readEnvironment(name: string): string | undefined {
  let value = process.env[name];
  value = "https://literal.vault.azure.net";
  return value;
}
const client = new SecretClient(
  readEnvironment("AZURE_KEY_VAULT_URL"),
  new ManagedIdentityCredential(),
);
`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/credential-client-association",
        identitySource(source),
      ),
      false,
      source,
    );
  }

  for (const source of [
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
const secret = await client.getSecret("literal-secret");
console.log(secret.value);
`,
    `
const unrelatedName = process.env.UNRELATED_SECRET_NAME;
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
const secret = await client.getSecret(unrelatedName);
console.log(secret.value);
`,
  ]) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", identitySource(source)),
      false,
      source,
    );
  }
});

test("class and instance fields preserve proven SecretClient state", () => {
  const methodClient = identitySource(`
class SecretReader {
  private client = new SecretClient(
    vaultUrl,
    new ManagedIdentityCredential(),
  );

  async read(): Promise<void> {
    const secret = await this.client.getSecret(secretName);
    console.log(secret.value);
  }
}
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", methodClient),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", methodClient),
    true,
  );

  const constructorClient = identitySource(`
class SecretReader {
  private client: SecretClient;

  constructor() {
    const credential = new ManagedIdentityCredential();
    this.client = new SecretClient(vaultUrl, credential);
  }

  async read(): Promise<void> {
    const secret = await this.client.getSecret(secretName);
    console.log(secret.value);
  }
}
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", constructorClient),
    true,
  );

  const instanceClient = identitySource(`
class SecretReader {
  readonly client = new SecretClient(
    vaultUrl,
    new ManagedIdentityCredential(),
  );
}
const reader = new SecretReader();
const secret = await reader.client.getSecret(secretName);
console.log(secret.value);
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", instanceClient),
    true,
  );
});

test("class field reassignment invalidates SecretClient provenance", () => {
  const source = identitySource(`
class SecretReader {
  private client = new SecretClient(
    vaultUrl,
    new ManagedIdentityCredential(),
  );

  async read(): Promise<void> {
    this.client = disconnectedClient;
    const secret = await this.client.getSecret(secretName);
    console.log(secret.value);
  }
}
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", source),
    false,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", source),
    false,
  );

  const instanceOverwrite = identitySource(`
class SecretReader {
  client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
}
const reader = new SecretReader();
reader.client = disconnectedClient;
const secret = await reader.client.getSecret(secretName);
console.log(secret.value);
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", instanceOverwrite),
    false,
  );
});

test("wrong, overwritten, and shadowed client state fails provenance", () => {
  const overwrittenCredential = identitySource(`
let credential = new ManagedIdentityCredential();
credential = otherCredential;
const client = new SecretClient(vaultUrl, credential);
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", overwrittenCredential),
    false,
  );

  const overwrittenClient = identitySource(`
const credential = new ManagedIdentityCredential();
let client = new SecretClient(vaultUrl, credential);
client = disconnectedClient;
const secret = await client.getSecret(secretName);
console.log(secret.value);
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", overwrittenClient),
    false,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", overwrittenClient),
    false,
  );

  const shadowed = identitySource(`
const credential = new ManagedIdentityCredential();
{
  const credential = otherCredential;
  const ignored = new SecretClient(vaultUrl, credential);
}
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", shadowed),
    false,
  );
});

test("function, method, and block scopes preserve source-order provenance", () => {
  const methodSource = identitySource(`
class Reader {
  async read(): Promise<void> {
    const credential = new ManagedIdentityCredential();
    const client = new SecretClient(vaultUrl, credential);
    const secret = await client.getSecret(secretName);
    {
      const client = disconnectedClient;
      void client;
    }
    console.log(secret.value);
  }
}
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", methodSource),
    true,
  );

  const functionOverwrite = identitySource(`
async function read(): Promise<void> {
  let credential = new ManagedIdentityCredential();
  credential = disconnectedCredential;
  const client = new SecretClient(vaultUrl, credential);
  const secret = await client.getSecret(secretName);
  console.log(secret.value);
}
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", functionOverwrite),
    false,
  );

  const shadowedOutput = identitySource(`
async function read(): Promise<void> {
  const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
  const secret = await client.getSecret(secretName);
  {
    const secret = fakeSecret;
    console.log(secret.value);
  }
}
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", shadowedOutput),
    false,
  );
});

test("operation requires awaited connected getSecret and value output", () => {
  const positive = [
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
const secret = await client.getSecret(secretName);
console.log(secret.value);
`,
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
const { value: secretValue } = await client.getSecret(secretName);
console.info(\`value: \${secretValue}\`);
`,
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
console.log((await client.getSecret(secretName)).value);
`,
  ];
  for (const source of positive) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", identitySource(source)),
      true,
      source,
    );
  }

  const negative = [
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
const secret = client.getSecret(secretName);
console.log(secret.value);
`,
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
const secret = await client.getSecret();
console.log(secret.value);
`,
    `
const connected = new SecretClient(vaultUrl, new ManagedIdentityCredential());
const disconnected = new SecretClient(vaultUrl, otherCredential);
const secret = await disconnected.getSecret(secretName);
console.log(secret.value);
`,
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
let secret = await client.getSecret(secretName);
secret = fakeSecret;
console.log(secret.value);
`,
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
await client.getSecret(secretName);
console.log("secret.value");
`,
  ];
  for (const source of negative) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", identitySource(source)),
      false,
      source,
    );
  }
});

test("CredentialUnavailableError handling accepts aliases and both branches", () => {
  const positive = [
    `
const managed = new ManagedIdentityCredential();
try {
  await managed.getToken(scope);
} catch (problem: unknown) {
  if (problem instanceof CredentialUnavailableError) {
    console.warn(problem.message);
  } else {
    throw problem;
  }
}
`,
    `
import {
  CredentialUnavailableError as Unavailable,
} from "@azure/identity";
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
try {
  await client.getSecret(secretName);
} catch (error) {
  if (!(error instanceof Unavailable)) {
    throw error;
  }
  console.error(error.message);
}
`,
    `
import * as identity from "@azure/identity";
const managed = new identity.ManagedIdentityCredential();
try {
  await managed.getToken(scope);
} catch (error) {
  if (error instanceof identity.CredentialUnavailableError) {
    console.log(error.name);
  }
  throw error;
}
`,
  ];
  for (const source of positive) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        identitySource(source),
      ),
      true,
      source,
    );
  }
});

test("empty, broad, swallowed, wrong, and disconnected catches fail", () => {
  const negative = [
    `
const managed = new ManagedIdentityCredential();
try { await managed.getToken(scope); } catch (error) {}
`,
    `
const managed = new ManagedIdentityCredential();
try { await managed.getToken(scope); } catch (error) {
  console.error(error);
}
`,
    `
const managed = new ManagedIdentityCredential();
try { await managed.getToken(scope); } catch (error) {
  if (error instanceof CredentialUnavailableError) {
    console.warn("unavailable");
  }
}
`,
    `
const managed = new ManagedIdentityCredential();
try { await managed.getToken(scope); } catch (error) {
  if (error instanceof AuthenticationError) console.warn(error.message);
  throw error;
}
`,
    `
const managed = new ManagedIdentityCredential();
await managed.getToken(scope);
try { await unrelated(); } catch (error) {
  if (error instanceof CredentialUnavailableError) console.warn(error.message);
  throw error;
}
`,
    `
const managed = new ManagedIdentityCredential();
try { managed.getToken(scope); } catch (error) {
  if (error instanceof CredentialUnavailableError) console.warn(error.message);
  throw error;
}
`,
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
try {
  await client.getSecret(secretName);
} catch (operationError) {
}
try {
  await unrelated();
} catch (error) {
  if (error instanceof CredentialUnavailableError) {
    console.warn(error.message);
  } else {
    throw error;
  }
}
`,
  ];
  for (const source of negative) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        identitySource(source),
      ),
      false,
      source,
    );
  }
});

test("all TypeScript catch paths discriminate or causally rethrow", () => {
  const safeBase = `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
try {
  await client.getSecret(secretName);
} catch (error) {
  if (error instanceof CredentialUnavailableError) {
    console.warn(error.message);
  } else {
    throw error;
  }
}
`;
  const unsafe = [
    `${safeBase}
try { await unrelated(); }
catch (failure) { console.error(failure); }`,
    `${safeBase}
try { await unrelated(); }
catch (failure) {
  if (shouldPropagate) {
    throw failure;
  }
}`,
    `${safeBase}
try { await unrelated(); }
catch (failure) {
  throw new Error(String(failure));
}`,
    `${safeBase}
try { await unrelated(); }
catch (failure) { return; }`,
    `${safeBase}
try { await unrelated(); }
catch { throw new Error("unknown failure"); }`,
    `${safeBase}
try { await unrelated(); }
catch (failure) {
  try { await recover(); }
  catch (nested) { console.error(nested); }
  throw failure;
}`,
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
try {
  await client.getSecret(secretName);
} catch (error) {
  if (error instanceof CredentialUnavailableError) {
    console.warn(error.message);
  } else if (shouldPropagate) {
    throw error;
  }
}`,
  ];
  for (const source of unsafe) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        identitySource(source),
      ),
      false,
      source,
    );
  }

  const safe = [
    `${safeBase}
try { await unrelated(); }
catch (failure) {
  if (shouldWrap) {
    throw new Error("wrapped", { cause: failure });
  } else {
    throw failure;
  }
}`,
    `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
try {
  await client.getSecret(secretName);
} catch (error) {
  if (!(error instanceof CredentialUnavailableError)) {
    throw new Error("wrapped", { cause: error });
  }
  console.error(error.message);
}`,
  ];
  for (const source of safe) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        identitySource(source),
      ),
      true,
      source,
    );
  }
});

test("TypeScript loop paths cannot hide unsafe catch terminals", () => {
  const prefix = `
const client = new SecretClient(vaultUrl, new ManagedIdentityCredential());
try {
  await client.getSecret(secretName);
} catch (error) {
  if (error instanceof CredentialUnavailableError) {
    console.warn(error.message);
  } else {
    throw error;
  }
}
try { await unrelated(); }
catch (failure) `;
  const unsafe = [
    `{ while (shouldRetry()) { return; } throw failure; }`,
    `{ for (let i = 0; i < count; i++) {
         if (shouldReturn(i)) return;
       }
       throw failure;
     }`,
    `{ for (const item of items) {
         if (isBad(item)) throw new Error("replacement");
       }
       throw failure;
     }`,
    `{ for (const item of items)
         if (shouldReturn(item)) return;
       throw failure;
     }`,
    `{ do { return; } while (false); throw failure; }`,
    `{ while (shouldRetry()) {
         if (shouldReturn()) { return; }
         break;
       }
       throw failure;
     }`,
    `{ while (shouldRetry()) { break missing; } throw failure; }`,
    `{ while (shouldRetry()) { continue missing; } throw failure; }`,
    `{ block: { continue block; } throw failure; }`,
    `{ outer: while (shouldRetry()) {
         outer: while (shouldRetry()) break;
       }
       throw failure;
     }`,
    `{ while (true) continue; }`,
  ];
  for (const handler of unsafe) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        identitySource(`${prefix}${handler}`),
      ),
      false,
      handler,
    );
  }

  const safe = [
    `{ retry: while (shouldRetry()) {
         break retry;
       }
       throw failure;
     }`,
    `{ outer: inner: while (shouldRetry()) {
         break outer;
       }
       throw failure;
     }`,
    `{ block: {
         if (shouldStop()) break block;
       }
       throw failure;
     }`,
    `{ outer: while (shouldRetry()) {
         while (hasMore()) break outer;
       }
       throw failure;
     }`,
    `{ outer: while (shouldRetry()) {
         while (hasMore()) continue outer;
       }
       throw failure;
     }`,
    `{ while (shouldRetry()) break; throw failure; }`,
    `{ for (let i = 0; i < count; i++) {
         if (shouldStop(i)) throw failure;
       }
       throw failure;
     }`,
    `{ while (shouldRetry()) {
         break;
         return;
       }
       throw failure;
     }`,
    `{ while (shouldRetry()) {
         continue;
         throw new Error("replacement");
       }
       throw failure;
     }`,
    `{ while (false) return; throw failure; }`,
    `{ for (const item of items) break; throw failure; }`,
    `{ for (;;) { throw failure; } }`,
  ];
  for (const handler of safe) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        identitySource(`${prefix}${handler}`),
      ),
      true,
      handler,
    );
  }
});

test("comments, strings, and decoys cannot satisfy behavior", () => {
  const source = identitySource(`
/*
const system = new ManagedIdentityCredential();
const user = new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID);
const chain = new ChainedTokenCredential(user, new AzureCliCredential());
const client = new SecretClient(vaultUrl, chain);
const secret = await client.getSecret(secretName);
console.log(secret.value);
*/
const prose = \`
new DefaultAzureCredential({ managedIdentityClientId });
CredentialUnavailableError
\`;
`);
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, source), false, rule);
  }
});
