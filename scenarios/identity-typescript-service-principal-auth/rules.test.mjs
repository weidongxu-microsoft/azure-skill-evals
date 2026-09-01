import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadTypeScriptWorkspace } from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/service-principal-typescript-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadTypeScriptWorkspace(goldenPath);

const imports = `
import "dotenv/config";
import {
  AuthenticationError,
  ClientSecretCredential,
} from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
`;

function workspace(source, customImports = imports) {
  return {
    ...completeWorkspace,
    source: `${customImports}
declare const process: { env: Record<string, string | undefined> };
${source}`,
  };
}

function setup(operation = "") {
  return `
const tenantId = process.env.AZURE_TENANT_ID!;
const clientId = process.env.AZURE_CLIENT_ID!;
const clientSecret = process.env.AZURE_CLIENT_SECRET!;
const vaultUrl = process.env.AZURE_KEY_VAULT_URL!;
const secretName = process.env.AZURE_KEY_VAULT_SECRET_NAME!;
const credential = new ClientSecretCredential(
  tenantId,
  clientId,
  clientSecret,
);
const client = new SecretClient(vaultUrl, credential);
${operation}`;
}

test.skip("golden passes exactly the six service-principal criteria", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/identity-packages",
    "prompt/environment-secret-management",
    "prompt/client-secret-credential",
    "prompt/credential-client-association",
    "prompt/authenticated-operation",
    "prompt/authentication-errors",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip("every criterion requires generated source", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, { ...completeWorkspace, source: "" }),
      false,
      rule,
    );
  }
});

test.skip("identity packages must be direct runtime dependencies and active imports", () => {
  for (const packageName of [
    "@azure/identity",
    "@azure/keyvault-secrets",
    "dotenv",
  ]) {
    const manifest = JSON.parse(completeWorkspace.packageJson);
    const version = manifest.dependencies[packageName];
    delete manifest.dependencies[packageName];
    manifest.devDependencies[packageName] = version;
    assert.equal(
      evaluateRule("prompt/identity-packages", {
        ...completeWorkspace,
        packageJson: JSON.stringify(manifest),
      }),
      false,
      packageName,
    );
  }

  const missingImports = [
    `import "dotenv/config";
import { SecretClient } from "@azure/keyvault-secrets";`,
    `import "dotenv/config";
import { ClientSecretCredential } from "@azure/identity";`,
    `import { ClientSecretCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";`,
  ];
  for (const sourceImports of missingImports) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace(setup(), sourceImports),
      ),
      false,
      sourceImports,
    );
  }
});

test.skip("identity package declarations reject empty, null, comments, and prose", () => {
  const invalid = [
    "",
    "   ",
    null,
    false,
    {},
    "// installed by the platform",
    "/* use current */",
    "latest stable version",
    "TODO",
  ];
  for (const packageName of [
    "@azure/identity",
    "@azure/keyvault-secrets",
    "dotenv",
  ]) {
    for (const declaration of invalid) {
      const manifest = JSON.parse(completeWorkspace.packageJson);
      manifest.dependencies[packageName] = declaration;
      assert.equal(
        evaluateRule("prompt/identity-packages", {
          ...completeWorkspace,
          packageJson: JSON.stringify(manifest),
        }),
        false,
        `${packageName}: ${JSON.stringify(declaration)}`,
      );
    }
  }
});

test.skip("identity packages accept valid runtime declaration forms", () => {
  for (const declaration of [
    "^4.0.0",
    ">=4.0.0 <5.0.0",
    "^4 || ^5",
    "latest",
    "workspace:*",
  ]) {
    const manifest = JSON.parse(completeWorkspace.packageJson);
    for (const packageName of [
      "@azure/identity",
      "@azure/keyvault-secrets",
      "dotenv",
    ]) {
      manifest.dependencies[packageName] = declaration;
    }
    assert.equal(
      evaluateRule("prompt/identity-packages", {
        ...completeWorkspace,
        packageJson: JSON.stringify(manifest),
      }),
      true,
      declaration,
    );
  }
});

test.skip("dotenv side-effect, named, namespace, and default initialization are accepted", () => {
  const forms = [
    imports,
    `import { config as initializeEnvironment } from "dotenv";
import { ClientSecretCredential, AuthenticationError } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
initializeEnvironment();`,
    `import * as environment from "dotenv";
import * as identity from "@azure/identity";
import * as keyVault from "@azure/keyvault-secrets";
environment.config();`,
    `import dotenv from "dotenv";
import { ClientSecretCredential, AuthenticationError } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
dotenv.config({ quiet: true });`,
  ];
  const bodies = [
    setup("await client.getSecret(secretName);"),
    setup("await client.getSecret(secretName);"),
    `
const tenantId = process.env.AZURE_TENANT_ID!;
const clientId = process.env.AZURE_CLIENT_ID!;
const clientSecret = process.env.AZURE_CLIENT_SECRET!;
const vaultUrl = process.env.AZURE_KEY_VAULT_URL!;
const secretName = process.env.AZURE_KEY_VAULT_SECRET_NAME!;
const credential = new identity.ClientSecretCredential(
  tenantId, clientId, clientSecret, { authorityHost: "https://login.microsoftonline.com" },
);
const client = new keyVault.SecretClient(vaultUrl, credential, {});
await client.getSecret(secretName);`,
    setup("await client.getSecret(secretName);"),
  ];

  for (let index = 0; index < forms.length; index += 1) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(bodies[index], forms[index]),
      ),
      true,
      forms[index],
    );
  }
});

test.skip("dotenv import without initialization and late initialization fail", () => {
  const noCall = `import * as dotenv from "dotenv";
import { ClientSecretCredential, AuthenticationError } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";`;
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(setup("await client.getSecret(secretName);"), noCall),
    ),
    false,
  );

  const late = `import { config } from "dotenv";
import { ClientSecretCredential, AuthenticationError } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";`;
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(`${setup("await client.getSecret(secretName);")}
config();`, late),
    ),
    false,
  );
});

test.skip("exact environment values support bracket access, helpers, and aliases", () => {
  const source = `
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`Set \${name}\`);
  return value;
}
const tenant = required("AZURE_TENANT_ID");
const application = process.env["AZURE_CLIENT_ID"]!;
const password = required("AZURE_CLIENT_SECRET");
const vault = required("AZURE_KEY_VAULT_URL");
const name = process.env["AZURE_KEY_VAULT_SECRET_NAME"]!;
const tenantAlias = tenant;
const credential = new ClientSecretCredential(
  tenantAlias,
  application,
  password,
  { additionallyAllowedTenants: ["*"] },
);
const client = new SecretClient(vault, credential, {});
await client.getSecret(name);
`;
  for (const rule of [
    "prompt/environment-secret-management",
    "prompt/client-secret-credential",
    "prompt/credential-client-association",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("fallbacks, wrong keys, wrong order, and missing arguments fail provenance", () => {
  const invalidCredentials = [
    `new ClientSecretCredential(
      process.env.AZURE_TENANT_ID || "tenant",
      process.env.AZURE_CLIENT_ID!,
      process.env.AZURE_CLIENT_SECRET!,
    )`,
    `new ClientSecretCredential(
      process.env.TENANT_ID!,
      process.env.AZURE_CLIENT_ID!,
      process.env.AZURE_CLIENT_SECRET!,
    )`,
    `new ClientSecretCredential(
      process.env.AZURE_CLIENT_ID!,
      process.env.AZURE_TENANT_ID!,
      process.env.AZURE_CLIENT_SECRET!,
    )`,
    `new ClientSecretCredential(
      process.env.AZURE_TENANT_ID!,
      process.env.AZURE_CLIENT_ID!,
    )`,
    `new ClientSecretCredential(
      process.env.AZURE_TENANT_ID!,
      process.env.AZURE_CLIENT_ID!,
      "hard-coded-secret",
    )`,
  ];
  for (const expression of invalidCredentials) {
    assert.equal(
      evaluateRule(
        "prompt/client-secret-credential",
        workspace(`const credential = ${expression};`),
      ),
      false,
      expression,
    );
  }
});

test.skip("one valid credential cannot hide another literal credential", () => {
  const source = `${setup("await client.getSecret(secretName);")}
const unsafe = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID!,
  process.env.AZURE_CLIENT_ID!,
  "literal",
);`;
  assert.equal(
    evaluateRule("prompt/client-secret-credential", workspace(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/environment-secret-management", workspace(source)),
    false,
  );
});

test.skip("direct, aliased, template, and diagnostic client-secret logging fails", () => {
  const outputs = [
    `console.log(clientSecret);`,
    `const copy = clientSecret; console.info(copy);`,
    "console.warn(`credential: ${clientSecret}`);",
    `console.error(process.env.AZURE_CLIENT_SECRET);`,
    `console.debug("secret", clientSecret);`,
  ];
  for (const output of outputs) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${output}`),
      ),
      false,
      output,
    );
  }
});

test.skip("client-secret taint reaches sinks through three helpers and returns", () => {
  const leaks = [
    `
function emit(value: string): void {
  console.log(value);
}
emit(clientSecret);`,
    `
function first(value: string): void { second(value); }
function second(value: string): void { third(value); }
function third(value: string): void { logger.debug(value); }
first(clientSecret);`,
    `
function relay(value: string): string {
  return value;
}
const returned = relay(clientSecret);
logger.warn(returned);`,
    `
function expose(value: string): void {
  console.error(value);
}
const exposeAlias = expose;
exposeAlias(clientSecret);`,
  ];
  for (const leak of leaks) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${leak}`),
      ),
      false,
      leak,
    );
  }
});

test.skip("client-secret taint reaches object, class, and static member sinks", () => {
  const leaks = [
    `
const details = { secret: clientSecret };
logger.info(details.secret);`,
    `
const details = {};
details.secret = clientSecret;
console.debug(details.secret);`,
    `
class Details {
  secret = clientSecret;
  reveal(): void {
    logger.error(this.secret);
  }
}
new Details().reveal();`,
    `
class SharedDetails {
  static secret = clientSecret;
}
debug(SharedDetails.secret);`,
  ];
  for (const leak of leaks) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${leak}`),
      ),
      false,
      leak,
    );
  }
});

test.skip("credential wrappers, redaction, and constant diagnostics are safe", () => {
  const diagnostics = [
    `
function inspectCredential(value: unknown): unknown {
  logger.debug("credential configured");
  return value;
}
inspectCredential(credential);`,
    `
function redact(_value: string): string {
  return "[REDACTED]";
}
console.info(redact(clientSecret));`,
    `console.log(clientSecret ? "[configured]" : "[missing]");`,
    `logger.info("service principal initialized");`,
  ];
  for (const diagnostic of diagnostics) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${diagnostic}`),
      ),
      true,
      diagnostic,
    );
  }
});

test.skip("client-secret taint crosses 4, 16, and 64 helper calls", () => {
  for (const length of [4, 16, 64]) {
    const prefix = `chain${length}`;
    const helpers = Array.from({ length }, (_, index) => {
      const name = `${prefix}Step${index}`;
      if (index === length - 1) {
        return `function ${name}(value: string): void {
  console.log(\`secret=\${value}\`);
}`;
      }
      return `function ${name}(value: string): void {
  ${prefix}Step${index + 1}(value);
}`;
    }).join("\n");
    const leak = `${helpers}
${prefix}Step0(clientSecret);`;
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${leak}`),
      ),
      false,
      `${length}-helper chain`,
    );
  }
});

test.skip("returns remain tainted across a 64-helper fixed point", () => {
  const length = 64;
  const helpers = Array.from({ length }, (_, index) => {
    const name = `returnStep${index}`;
    if (index === length - 1) {
      return `function ${name}(value: string): string {
  return value;
}`;
    }
    return `function ${name}(value: string): string {
  return returnStep${index + 1}(value);
}`;
  }).join("\n");
  const leak = `${helpers}
const relayed = returnStep0(clientSecret);
process.stdout.write(relayed);`;
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(`${setup("await client.getSecret(secretName);")}
${leak}`),
    ),
    false,
  );
});

test.skip("arrays, objects, mutation, and member writes retain taint", () => {
  const leaks = [
    `const values: string[] = [];
values.push(clientSecret);
console.log(values);`,
    `const values: string[] = [];
values.unshift(clientSecret);
logger.info(values[0]);`,
    `const values = ["constant", ...[clientSecret]];
output(values);`,
    `const details = { safe: "constant", ...{ clientSecret } };
console.dir(details);`,
    `const details: Record<string, string> = {};
details["secret"] = clientSecret;
logger.debug(details);`,
    `class Details {
  secret = clientSecret;
}
const details = new Details();
console.table([details.secret]);`,
    `class SharedDetails {
  static secret = "constant";
}
SharedDetails.secret = clientSecret;
printf("%s", SharedDetails.secret);`,
    `const details: Record<string, string> = {};
function stash(
  target: Record<string, string>,
  value: string,
): void {
  target.secret = value;
}
stash(details, clientSecret);
console.log(JSON.stringify(details));`,
    `const formatted = format(
  "service-principal secret: %s",
  clientSecret,
);
logger.log(formatted);`,
  ];
  for (const leak of leaks) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${leak}`),
      ),
      false,
      leak,
    );
  }
});

test.skip("identity and conditional pseudo-redactors do not clear taint", () => {
  const pseudoRedactors = [
    `function redact(value: string): string {
  return value;
}
console.info(redact(clientSecret));`,
    `function redact(value: string, hide: boolean): string {
  return hide ? "[REDACTED]" : value;
}
logger.warn(redact(clientSecret, condition));`,
    `function redact(value: string): string {
  const result = value;
  return result;
}
write(redact(clientSecret));`,
  ];
  for (const pseudoRedactor of pseudoRedactors) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${pseudoRedactor}`),
      ),
      false,
      pseudoRedactor,
    );
  }
});

test.skip("constant redaction and credential wrappers remain safe", () => {
  const safe = [
    `function redact(_value: string): string {
  return "[REDACTED]";
}
console.log(\`secret=\${redact(clientSecret)}\`);`,
    `function wrapCredential(secret: string) {
  return {
    credential: new ClientSecretCredential(
      tenantId,
      clientId,
      secret,
    ),
  };
}
const wrapper = wrapCredential(clientSecret);
await wrapper.credential.getToken(
  "https://vault.azure.net/.default",
);
logger.info("credential ready");`,
    `const diagnostics = {
  status: "configured",
  secret: "[REDACTED]",
};
console.log(JSON.stringify(diagnostics));`,
  ];
  for (const diagnostic of safe) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${diagnostic}`),
      ),
      true,
      diagnostic,
    );
  }
});

test.skip("unconditional clean overwrites clear only the exact tainted path", () => {
  const safe = [
    `let diagnostic = clientSecret;
diagnostic = "[REDACTED]";
console.log(diagnostic);`,
    `const details: Record<string, string> = {
  primary: clientSecret,
  status: "configured",
};
details.primary = "[REDACTED]";
logger.info(details.primary);`,
    `function redact(_value: string): string {
  return "[REDACTED]";
}
let diagnostic = clientSecret;
diagnostic = redact(diagnostic);
console.info(diagnostic);`,
    `let diagnostic = clientSecret;
diagnostic = "[REDACTED]";
const safeAlias = diagnostic;
console.info(safeAlias);`,
    `const details: { secret: { raw: string } } = {
  secret: { raw: "configured" },
};
details.secret.raw = clientSecret;
details.secret = { raw: "[REDACTED]" };
console.log(details);`,
  ];
  for (const diagnostic of safe) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${diagnostic}`),
      ),
      true,
      diagnostic,
    );
  }
});

test.skip("unsound or inexact overwrites do not clear secret taint", () => {
  const unsafe = [
    `let diagnostic = clientSecret;
console.log(diagnostic);
diagnostic = "[REDACTED]";`,
    `let diagnostic = clientSecret;
if (shouldRedact) {
  diagnostic = "[REDACTED]";
}
console.log(diagnostic);`,
    `let diagnostic = clientSecret;
if (shouldRedact) diagnostic = "[REDACTED]";
console.log(diagnostic);`,
    `let diagnostic = clientSecret;
const alias = diagnostic;
diagnostic = "[REDACTED]";
console.log(alias);`,
    `const details = {
  primary: clientSecret,
  sibling: clientSecret,
};
details.primary = "[REDACTED]";
console.log(details.sibling);`,
  ];
  for (const diagnostic of unsafe) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${diagnostic}`),
      ),
      false,
      diagnostic,
    );
  }
});

test.skip("allocation identity preserves aliases, nested edges, and cycles", () => {
  const leaks = [
    `const original: any = {};
const alias = original;
alias.value = clientSecret;
console.log(original);`,
    `function store(target: any, value: string): void {
  target.value = value;
}
    function relay(target: any, value: string): void {
      store(target, value);
    }
    const original: any = {};
    const alias = original;
    relay(alias, clientSecret);
    logger.error(original);`,
    `class Node {
  value = "";
  store(value: string): void {
    this.value = value;
  }
}
const original = new Node();
const alias = original;
alias.store(clientSecret);
console.warn(original);`,
    `const root: any = { child: { values: [] } };
root.child.values[0] = clientSecret;
console.dir(root);`,
    `const first: any = {};
const second: any = {};
first.child = second;
second.child = first;
first.value = clientSecret;
console.log(second);`,
    `const root: any = { child: {} };
const retained = root.child;
retained.value = clientSecret;
root.child = {};
console.table([retained]);`,
  ];
  for (const leak of leaks) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${leak}`),
      ),
      false,
      leak,
    );
  }
});

test.skip("allocation identity isolates objects and rebinding or replacement", () => {
  const safe = [
    `const tainted: any = {};
const clean: any = {};
tainted.value = clientSecret;
console.log(clean);`,
    `const original: any = {};
let alias = original;
alias = {};
alias.value = clientSecret;
logger.info(original);`,
    `const root: any = { child: {} };
root.child.value = clientSecret;
root.child = {};
console.log(root);`,
    `function rebind(target: any, value: string): void {
  target = {};
  target.value = value;
}
const original: any = {};
rebind(original, clientSecret);
console.log(original);`,
  ];
  for (const diagnostic of safe) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${diagnostic}`),
      ),
      true,
      diagnostic,
    );
  }
});

test.skip("control flow joins preserve only definite allocation writes", () => {
  const definiteLeak = `const root: any = {};
do {
  root.value = clientSecret;
} while (false);
console.log(root);`;
  const maybeLeaks = [
    `const root: any = {};
if (condition) {
  root.value = clientSecret;
}
console.log(root);`,
    `const root: any = { value: clientSecret };
if (condition) {
  root.value = "[REDACTED]";
}
console.log(root);`,
    `const root: any = { value: clientSecret };
while (condition) {
  root.value = "[REDACTED]";
}
console.log(root);`,
  ];
  const noWrite = `const root: any = {};
while (false) {
  root.value = clientSecret;
}
console.log(root);`;
  for (const leak of [definiteLeak, ...maybeLeaks]) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${leak}`),
      ),
      false,
      leak,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(`${setup("await client.getSecret(secretName);")}
${noWrite}`),
    ),
    true,
  );
});

test.skip("Object.assign preserves target identity through calls and receivers", () => {
  const leaks = [
    `const target: any = {};
Object.assign(target, { value: clientSecret });
console.log(target);`,
    `const target: any = {};
const returned = Object.assign(target, { value: clientSecret });
console.log(returned);`,
    `function merge(target: any, source: any): any {
  return Object.assign(target, source);
}
const target: any = {};
const returned = merge(target, { value: clientSecret });
console.log(returned);`,
    `function apply(
  assign: typeof Object.assign,
  target: any,
  source: any,
): any {
  return assign(target, source);
}
const target: any = {};
apply(Object.assign, target, { value: clientSecret });
console.log(target);`,
    `class Merger {
  target: any = {};

  add(source: any): any {
    return Object.assign(this.target, source);
  }
}
const merger = new Merger();
const returned = merger.add({ value: clientSecret });
console.log(returned);`,
    `class Receiver {
  add(source: any): void {
    Object.assign(this, source);
  }
}
const receiver = new Receiver();
receiver.add({ value: clientSecret });
console.log(receiver);`,
    `const assign = Object.assign;
const target: any = {};
assign(target, { value: clientSecret });
console.log(target);`,
    `function builtInAssign(): typeof Object.assign {
  return Object.assign;
}
const assign = builtInAssign();
const target: any = {};
assign(target, { value: clientSecret });
console.log(target);`,
    `function localFake(): any {
  const Object = { assign: () => ({}) };
  return Object.assign({}, { value: clientSecret });
}
localFake();
const target: any = {};
Object.assign(target, { value: clientSecret });
console.log(target);`,
  ];
  for (const leak of leaks) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${leak}`),
      ),
      false,
      leak,
    );
  }
});

test.skip("Object.assign shallow copies ordered exact and weak spread edges", () => {
  const leaks = [
    `const target: any = {};
Object.assign(
  target,
  { value: "[REDACTED]" },
  { value: clientSecret },
);
console.log(target);`,
    `const nested: any = { value: clientSecret };
const target: any = {};
Object.assign(target, { nested });
console.log(target);`,
    `const nested: any = {};
const source: any = { nested };
const target: any = {};
Object.assign(target, source);
target.nested.value = clientSecret;
console.log(source);`,
    `const source: any = { value: clientSecret };
const target: any = {};
Object.assign(target, { ...source });
console.log(target);`,
    `const source: any = {};
source[dynamicKey] = clientSecret;
const target: any = { value: "[REDACTED]" };
    Object.assign(target, source, { value: "[REDACTED]" });
console.log(target);`,
        `const tainted: any = { value: clientSecret };
    const clean: any = { value: "[REDACTED]" };
    const source = condition ? tainted : clean;
    const target: any = {};
    Object.assign(target, source);
    console.log(target);`,
    `const target: any = { value: clientSecret };
if (shouldRedact) {
  Object.assign(target, { value: "[REDACTED]" });
}
console.log(target);`,
  ];
  for (const leak of leaks) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${leak}`),
      ),
      false,
      leak,
    );
  }

  const safe = [
    `const target: any = {};
Object.assign(
  target,
  { value: clientSecret },
  { value: "[REDACTED]" },
);
console.log(target);`,
    `const tainted: any = {};
const clean: any = {};
Object.assign(tainted, { value: clientSecret });
console.log(clean);`,
  ];
  for (const diagnostic of safe) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${diagnostic}`),
      ),
      true,
      diagnostic,
    );
  }
});

test.skip("shadowed Object.assign implementations are not treated as intrinsic", () => {
  const shadows = [
    `const Object = {
  assign(_target: any, ..._sources: any[]): any {
    return {};
  },
};
const clean = Object.assign({}, { value: clientSecret });
console.log(clean);`,
    `function useFake(Object: any): any {
  return Object.assign({}, { value: clientSecret });
}
const clean = useFake({ assign: () => ({}) });
console.log(clean);`,
    `function Object(): void {}
Object.assign = () => ({});
const clean = Object.assign({}, { value: clientSecret });
console.log(clean);`,
    `class Object {
  static assign(): any {
    return {};
  }
}
const clean = Object.assign({}, { value: clientSecret });
console.log(clean);`,
  ];
  for (const shadow of shadows) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${setup("await client.getSecret(secretName);")}
${shadow}`),
      ),
      true,
      shadow,
    );
  }

  const importedObject = `import Object from "fake-object";
import "dotenv/config";
import {
  AuthenticationError,
  ClientSecretCredential,
} from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";`;
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(
        `${setup("await client.getSecret(secretName);")}
const clean = Object.assign({}, { value: clientSecret });
console.log(clean);`,
        importedObject,
      ),
    ),
    true,
  );
});

test.skip("credential factories preserve bounded environment provenance", () => {
  const source = `
function createCredential(
  tenant: string,
  application: string,
  secret: string,
) {
  return new ClientSecretCredential(tenant, application, secret);
}
const tenantId = process.env.AZURE_TENANT_ID!;
const clientId = process.env.AZURE_CLIENT_ID!;
const clientSecret = process.env.AZURE_CLIENT_SECRET!;
const vaultUrl = process.env.AZURE_KEY_VAULT_URL!;
const secretName = process.env.AZURE_KEY_VAULT_SECRET_NAME!;
const credential = createCredential(tenantId, clientId, clientSecret);
const client = new SecretClient(vaultUrl, credential);
await client.getSecret(secretName);`;
  for (const rule of [
    "prompt/environment-secret-management",
    "prompt/client-secret-credential",
    "prompt/credential-client-association",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("credential imports accept aliases and namespace qualification", () => {
  const cases = [
    {
      sourceImports: `import "dotenv/config";
import { ClientSecretCredential as ServicePrincipalCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";`,
      constructor: "ServicePrincipalCredential",
      client: "SecretClient",
    },
    {
      sourceImports: `import "dotenv/config";
import * as identity from "@azure/identity";
import * as keyVault from "@azure/keyvault-secrets";`,
      constructor: "identity.ClientSecretCredential",
      client: "keyVault.SecretClient",
    },
  ];
  for (const item of cases) {
    const source = `
const credential = new ${item.constructor}(
  process.env.AZURE_TENANT_ID!,
  process.env.AZURE_CLIENT_ID!,
  process.env.AZURE_CLIENT_SECRET!,
  {},
);
const client = new ${item.client}(
  process.env.AZURE_KEY_VAULT_URL!,
  credential,
  {},
);`;
    assert.equal(
      evaluateRule(
        "prompt/credential-client-association",
        workspace(source, item.sourceImports),
      ),
      true,
      source,
    );
  }
});

test.skip("bound and inline credentials associate only with their SecretClient", () => {
  const positive = [
    setup(),
    `
const client = new SecretClient(
  process.env.AZURE_KEY_VAULT_URL!,
  new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!,
  ),
  {},
);`,
  ];
  for (const source of positive) {
    assert.equal(
      evaluateRule("prompt/credential-client-association", workspace(source)),
      true,
      source,
    );
  }

  const disconnected = `${setup()}
const other = new SecretClient(
  process.env.AZURE_KEY_VAULT_URL!,
  anotherCredential,
  { credential },
);`;
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      workspace(disconnected.replace(
        "const client = new SecretClient(vaultUrl, credential);",
        "",
      )),
    ),
    false,
  );
});

test.skip("credential and client overwrites invalidate source-order provenance", () => {
  const sources = [
    `
let credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID!,
  process.env.AZURE_CLIENT_ID!,
  process.env.AZURE_CLIENT_SECRET!,
);
credential = anotherCredential;
const client = new SecretClient(process.env.AZURE_KEY_VAULT_URL!, credential);`,
    `
const credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID!,
  process.env.AZURE_CLIENT_ID!,
  process.env.AZURE_CLIENT_SECRET!,
);
let client = new SecretClient(process.env.AZURE_KEY_VAULT_URL!, credential);
client = disconnectedClient;
const secret = await client.getSecret(
  process.env.AZURE_KEY_VAULT_SECRET_NAME!,
);
console.log(secret.value);`,
  ];
  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("conditional and loop-only assignments do not establish provenance", () => {
  const sources = [
    `
let credential;
if (condition) {
  credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!,
  );
}
const client = new SecretClient(
  process.env.AZURE_KEY_VAULT_URL!,
  credential,
);`,
    `
let credential;
for (const candidate of candidates) {
  credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!,
  );
}
const client = new SecretClient(
  process.env.AZURE_KEY_VAULT_URL!,
  credential,
);`,
  ];
  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/credential-client-association", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("lexical, function, var, loop, and catch scopes preserve real bindings", () => {
  const positive = `${setup(`
{
  const client = disconnectedClient;
  void client;
}
const secret = await client.getSecret(secretName);
try {
  console.log(secret.value);
} catch (client) {
  throw client;
}`)}`;
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(positive)),
    true,
  );

  const invalid = `${setup(`
var secret = await client.getSecret(secretName);
for (const item of items) {
  var secret = item;
}
console.log(secret.value);`)}`;
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(invalid)),
    false,
  );
});

test.skip("class fields and methods retain credential-to-operation provenance", () => {
  const source = `
class Reader {
  private credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!,
  );
  private client = new SecretClient(
    process.env.AZURE_KEY_VAULT_URL!,
    this.credential,
  );

  async read(): Promise<void> {
    const secret = await this.client.getSecret(
      process.env.AZURE_KEY_VAULT_SECRET_NAME!,
    );
    console.log(secret.value);
  }
}
const reader = new Reader();
await reader.read();`;
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(source)),
    true,
  );
});

test.skip("plain object fields and methods retain credential-to-operation provenance", () => {
  const source = `
const service = {};
service.credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID!,
  process.env.AZURE_CLIENT_ID!,
  process.env.AZURE_CLIENT_SECRET!,
);
service.client = new SecretClient(
  process.env.AZURE_KEY_VAULT_URL!,
  service.credential,
);
service.read = async function (): Promise<void> {
  const secret = await service.client.getSecret(
    process.env.AZURE_KEY_VAULT_SECRET_NAME!,
  );
  console.log(secret.value);
};
await service.read();`;
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(source)),
    true,
  );

  const literal = `
const credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID!,
  process.env.AZURE_CLIENT_ID!,
  process.env.AZURE_CLIENT_SECRET!,
);
const service = {
  credential,
  client: new SecretClient(
    process.env.AZURE_KEY_VAULT_URL!,
    credential,
  ),
  read: async function () {
    const secret = await service.client.getSecret(
      process.env.AZURE_KEY_VAULT_SECRET_NAME!,
    );
    console.log(secret.value);
  },
};
await service.read();`;
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(literal)),
    true,
  );
});

test.skip("awaited getSecret value output supports bindings, destructuring, and inline forms", () => {
  const operations = [
    `const secret = await client.getSecret(secretName);
console.log(secret.value);`,
    `const { value: secretValue } = await client.getSecret(secretName);
console.info(secretValue);`,
    `console.log((await client.getSecret(secretName)).value);`,
    `const secretValue = (await client.getSecret(secretName)).value;
console.log(\`value: \${secretValue}\`);`,
  ];
  for (const operation of operations) {
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        workspace(setup(operation)),
      ),
      true,
      operation,
    );
  }
});

test.skip("unawaited, unnamed, disconnected, and non-value operation decoys fail", () => {
  const operations = [
    `const secret = client.getSecret(secretName);
console.log(secret.value);`,
    `client.getSecret(secretName).then((secret) => console.log(secret.value));`,
    `const secret = await client.getSecret("literal-name");
console.log(secret.value);`,
    `const secret = await client.getSecret(secretName);
console.log("retrieved");`,
    `await client.getSecret(secretName);
const secret = await client.getSecret();
console.log(secret.value);`,
    `if (false) {
  const secret = await client.getSecret(secretName);
  console.log(secret.value);
}`,
    `while (false) {
  const secret = await client.getSecret(secretName);
  console.log(secret.value);
}`,
  ];
  for (const operation of operations) {
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        workspace(setup(operation)),
      ),
      false,
      operation,
    );
  }
});

test.skip("operation result overwrites and inner mutations invalidate value provenance", () => {
  const operations = [
    `let secret = await client.getSecret(secretName);
secret = fallbackSecret;
console.log(secret.value);`,
    `const secret = await client.getSecret(secretName);
secret.value = "replacement";
console.log(secret.value);`,
    `let { value } = await client.getSecret(secretName);
value = fallbackValue;
console.log(value);`,
    `let secret = await client.getSecret(secretName);
if (condition) {
  secret = fallbackSecret;
}
console.log(secret.value);`,
  ];
  for (const operation of operations) {
    assert.equal(
      evaluateRule(
        "prompt/authenticated-operation",
        workspace(setup(operation)),
      ),
      false,
      operation,
    );
  }
});

test.skip("AuthenticationError aliases and namespace qualification are connected", () => {
  const cases = [
    {
      sourceImports: imports,
      type: "AuthenticationError",
    },
    {
      sourceImports: `import "dotenv/config";
import * as identity from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";`,
      type: "identity.AuthenticationError",
      credentialType: "identity.ClientSecretCredential",
    },
    {
      sourceImports: `import "dotenv/config";
import {
  AuthenticationError as InvalidCredential,
  ClientSecretCredential,
} from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";`,
      type: "InvalidCredential",
    },
  ];
  for (const item of cases) {
    const source = setup(`
try {
  await client.getSecret(secretName);
} catch (problem: unknown) {
  if (problem instanceof ${item.type}) {
    console.error("Authentication failed", problem.message);
  } else {
    throw problem;
  }
}`).replaceAll(
      "new ClientSecretCredential",
      `new ${item.credentialType ?? "ClientSecretCredential"}`,
    );
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        workspace(source, item.sourceImports),
      ),
      true,
      item.type,
    );
  }
});

test.skip("local type shadowing invalidates SDK constructor provenance", () => {
  const namedCredentialShadow = `
function create(ClientSecretCredential: new (...args: unknown[]) => unknown) {
  const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!,
  );
  return new SecretClient(
    process.env.AZURE_KEY_VAULT_URL!,
    credential,
  );
}
create(class FakeCredential {});`;
  assert.equal(
    evaluateRule(
      "prompt/client-secret-credential",
      workspace(namedCredentialShadow),
    ),
    false,
  );

  const namedClientShadow = `
function create(SecretClient: new (...args: unknown[]) => unknown) {
  const credential = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!,
  );
  return new SecretClient(
    process.env.AZURE_KEY_VAULT_URL!,
    credential,
  );
}
create(class FakeClient {});`;
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      workspace(namedClientShadow),
    ),
    false,
  );

  const namespaceShadow = `
function create(identity: { ClientSecretCredential: new (...args: unknown[]) => unknown }) {
  return new identity.ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!,
  );
}
create({ ClientSecretCredential: class FakeCredential {} });`;
  const namespaceImports = `import "dotenv/config";
import * as identity from "@azure/identity";
import * as keyVault from "@azure/keyvault-secrets";`;
  assert.equal(
    evaluateRule(
      "prompt/client-secret-credential",
      workspace(namespaceShadow, namespaceImports),
    ),
    false,
  );
});

test.skip("local AuthenticationError classes and functions invalidate instanceof", () => {
  const shadows = [
    `class AuthenticationError extends Error {}`,
    `function AuthenticationError() {}`,
  ];
  for (const shadow of shadows) {
    const source = `${shadow}
${setup(`
try {
  await client.getSecret(secretName);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
  } else {
    throw error;
  }
}`)}`;
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      false,
      shadow,
    );
  }
});

test.skip("negated guards and causal wrapped rethrows preserve unrelated errors", () => {
  const handlers = [
    `
if (!(error instanceof AuthenticationError)) {
  throw error;
}
console.warn(error.message);`,
    `
if (error instanceof AuthenticationError) {
  console.error(error);
} else {
  throw new Error("Key Vault request failed", { cause: error });
}`,
  ];
  for (const handler of handlers) {
    const source = setup(`
try {
  await client.getSecret(secretName);
} catch (error: unknown) {
  ${handler}
}`);
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      true,
      handler,
    );
  }
});

test.skip("all unrelated catches must rethrow causally", () => {
  const safe = `${setup(`
try {
  await unrelated();
} catch (unrelatedError) {
  throw unrelatedError;
}
try {
  await client.getSecret(secretName);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
  } else {
    throw error;
  }
}`)}`;
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(safe)),
    true,
  );

  const unsafe = safe.replace(
    "throw unrelatedError;",
    "console.warn(unrelatedError);",
  );
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(unsafe)),
    false,
  );
});

test.skip("generic, static, disconnected, and unawaited catches fail error handling", () => {
  const bodies = [
    `try { await client.getSecret(secretName); }
catch (error) { console.error(error); }`,
    `try { await client.getSecret(secretName); }
catch (error) {
  if (error instanceof AuthenticationError) {
    console.error("Authentication failed");
  } else {
    throw error;
  }
}`,
    `try { await unrelated(); }
catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
  } else {
    throw error;
  }
}`,
    `try { client.getSecret(secretName); }
catch (error) {
  if (error instanceof AuthenticationError) {
    console.error(error.message);
  } else {
    throw error;
  }
}`,
  ];
  for (const body of bodies) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        workspace(setup(body)),
      ),
      false,
      body,
    );
  }
});

test.skip("branch, loop, return, and catch paths cannot swallow non-authentication errors", () => {
  const handlers = [
    `if (error instanceof AuthenticationError) {
  console.error(error.message);
} else if (condition) {
  throw error;
}`,
    `if (error instanceof AuthenticationError) {
  console.error(error.message);
} else {
  while (condition) {
    throw error;
  }
}`,
    `if (error instanceof AuthenticationError) {
  console.error(error.message);
} else {
  return;
}`,
    `if (error instanceof AuthenticationError) {
  console.error(error.message);
} else {
  try {
    throw error;
  } catch {
    return;
  }
}`,
  ];
  for (const handler of handlers) {
    const source = setup(`
try {
  await client.getSecret(secretName);
} catch (error) {
  ${handler}
}`);
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      false,
      handler,
    );
  }
});

test.skip("comments, strings, prose, and fake local types satisfy no behavior", () => {
  const source = `
class ClientSecretCredential {}
class SecretClient {}
const prose = \`
  new ClientSecretCredential(AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET);
  await client.getSecret(AZURE_KEY_VAULT_SECRET_NAME);
  if (error instanceof AuthenticationError) console.error(error.message);
\`;
// import "dotenv/config";
/* console.log(secret.value); */
`;
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, workspace(source, "")), false, rule);
  }
});
