import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  ruleNames,
} from "./tools/managed-identity-java-rules.mjs";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));

function collectJavaFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "target") {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".java")) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

const goldenFiles = collectJavaFiles(goldenRoot);
const completeWorkspace = {
  sourceFiles: goldenFiles,
  buildFiles: [join(goldenRoot, "pom.xml")],
  source: goldenFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
  build: readFileSync(join(goldenRoot, "pom.xml"), "utf8"),
};

const workspace = (source, build = completeWorkspace.build) => ({
  ...completeWorkspace,
  sourceFiles: ["Main.java"],
  source,
  build,
});

const environment = `
String vaultUrl = System.getenv("AZURE_KEY_VAULT_URL");
String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
String clientId = System.getenv("AZURE_CLIENT_ID");
`;

const systemAndUser = `
ManagedIdentityCredential system =
    new ManagedIdentityCredentialBuilder().build();
ManagedIdentityCredential user =
    new ManagedIdentityCredentialBuilder().clientId(clientId).build();
`;

const associatedClient = `
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(user)
    .buildClient();
`;

test.skip("golden reference passes exactly the eight prompt criteria", () => {
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

test.skip("golden pins the requested SDK versions and Java 17", () => {
  assert.match(
    completeWorkspace.build,
    /<artifactId>azure-identity<\/artifactId>\s*<version>1\.18\.5<\/version>/,
  );
  assert.match(
    completeWorkspace.build,
    /<artifactId>azure-security-keyvault-secrets<\/artifactId>\s*<version>4\.11\.2<\/version>/,
  );
  assert.match(
    completeWorkspace.build,
    /<maven\.compiler\.release>17<\/maven\.compiler\.release>/,
  );
});

test.skip("package grading requires both real com.azure dependencies", () => {
  for (const artifact of [
    "azure-identity",
    "azure-security-keyvault-secrets",
  ]) {
    const removed = completeWorkspace.build.replace(
      new RegExp(
        `<dependency>[\\s\\S]*?<artifactId>${artifact}<\\/artifactId>[\\s\\S]*?<\\/dependency>`,
      ),
      "",
    );
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace(completeWorkspace.source, removed),
      ),
      false,
      artifact,
    );
  }
});

test.skip("fake package groups and XML comments do not count", () => {
  const fake = `
<dependencies>
  <dependency>
    <groupId>example.fake</groupId>
    <artifactId>azure-identity</artifactId>
  </dependency>
  <!--
  <dependency>
    <groupId>com.azure</groupId>
    <artifactId>azure-security-keyvault-secrets</artifactId>
  </dependency>
  -->
</dependencies>`;
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace("class Main {}", fake),
    ),
    false,
  );
});

test.skip("exact Gradle coordinates are accepted", () => {
  const gradle = `
dependencies {
  implementation("com.azure:azure-identity:1.18.5")
  implementation 'com.azure:azure-security-keyvault-secrets:4.11.2'
}`;
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace("class Main {}", gradle),
    ),
    true,
  );
});

test.skip("system and user assigned builders are distinguished", () => {
  const source = `${environment}${systemAndUser}`;
  assert.equal(
    evaluateRule("prompt/system-assigned-credential", workspace(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", workspace(source)),
    true,
  );

  assert.equal(
    evaluateRule(
      "prompt/system-assigned-credential",
      workspace(`
${environment}
ManagedIdentityCredential onlyUser =
    new ManagedIdentityCredentialBuilder().clientId(clientId).build();
`),
    ),
    false,
  );
});

test.skip("user-assigned identity requires AZURE_CLIENT_ID provenance", () => {
  const invalidSources = [
    `ManagedIdentityCredential user =
       new ManagedIdentityCredentialBuilder().clientId("literal-id").build();`,
    `String clientId = System.getenv("SOME_OTHER_ENV");
     ManagedIdentityCredential user =
       new ManagedIdentityCredentialBuilder().clientId(clientId).build();`,
    `String clientId = System.getenv("AZURE_CLIENT_ID");
     clientId = fallbackClientId;
     ManagedIdentityCredential user =
       new ManagedIdentityCredentialBuilder().clientId(clientId).build();`,
  ];
  for (const source of invalidSources) {
    assert.equal(
      evaluateRule("prompt/user-assigned-credential", workspace(source)),
      false,
    );
  }
});

test.skip("direct and aliased environment provenance remains accepted", () => {
  const direct = `
ManagedIdentityCredential user = new ManagedIdentityCredentialBuilder()
    .clientId(System.getenv("AZURE_CLIENT_ID"))
    .build();
TokenCredential credential = new DefaultAzureCredentialBuilder()
    .managedIdentityClientId(System.getenv("AZURE_CLIENT_ID"))
    .build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(System.getenv("AZURE_KEY_VAULT_URL"))
    .credential(user)
    .buildClient();
System.out.println(client.getSecret(
    System.getenv("AZURE_KEY_VAULT_SECRET_NAME")).getValue());
`;
  const aliases = `
String clientId = System.getenv("AZURE_CLIENT_ID");
String clientIdAlias = clientId;
String vaultUrl = System.getenv("AZURE_KEY_VAULT_URL");
String vaultUrlAlias = vaultUrl;
String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
String secretNameAlias = secretName;
ManagedIdentityCredential user = new ManagedIdentityCredentialBuilder()
    .clientId(clientIdAlias)
    .build();
TokenCredential credential = new DefaultAzureCredentialBuilder()
    .managedIdentityClientId(clientIdAlias)
    .build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrlAlias)
    .credential(user)
    .buildClient();
System.out.println(client.getSecret(secretNameAlias).getValue());
`;
  for (const source of [direct, aliases]) {
    for (const rule of [
      "prompt/user-assigned-credential",
      "prompt/default-azure-credential",
      "prompt/credential-client-association",
      "prompt/authenticated-operation",
    ]) {
      assert.equal(evaluateRule(rule, workspace(source)), true, rule);
    }
  }
});

test.skip("qualified, aliased, and bound managed identity builders are accepted", () => {
  const source = `
String id = java.lang.System.getenv("AZURE_CLIENT_ID");
com.azure.identity.ManagedIdentityCredentialBuilder original =
    new com.azure.identity.ManagedIdentityCredentialBuilder();
com.azure.identity.ManagedIdentityCredentialBuilder alias = original;
com.azure.identity.ManagedIdentityCredential system = original.build();
alias.clientId(id);
com.azure.core.credential.TokenCredential user = alias.build();
`;
  assert.equal(
    evaluateRule("prompt/system-assigned-credential", workspace(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", workspace(source)),
    true,
  );
});

test.skip("shadowed client IDs do not satisfy the user-assigned rule", () => {
  const source = `
String clientId = System.getenv("AZURE_CLIENT_ID");
{
    String clientId = fallbackClientId;
    ManagedIdentityCredential user =
        new ManagedIdentityCredentialBuilder().clientId(clientId).build();
}
`;
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", workspace(source)),
    false,
  );
});

test.skip("managed-identity-enabled DefaultAzureCredential accepts inline and bound forms", () => {
  const inline = `${environment}
TokenCredential credential = new DefaultAzureCredentialBuilder()
    .managedIdentityClientId(clientId)
    .build();`;
  const bound = `${environment}
DefaultAzureCredentialBuilder builder = new DefaultAzureCredentialBuilder();
builder.managedIdentityClientId(clientId);
DefaultAzureCredentialBuilder alias = builder;
TokenCredential credential = alias.build();`;
  for (const source of [inline, bound]) {
    assert.equal(
      evaluateRule("prompt/default-azure-credential", workspace(source)),
      true,
    );
  }
});

test.skip("DefaultAzureCredential must configure and retain managed identity", () => {
  const invalidSources = [
    `${environment}
     TokenCredential credential = new DefaultAzureCredentialBuilder().build();`,
    `${environment}
     TokenCredential credential = new DefaultAzureCredentialBuilder()
       .managedIdentityClientId(clientId)
       .excludeManagedIdentityCredential()
       .build();`,
    `${environment}
     clientId = replacement;
     TokenCredential credential = new DefaultAzureCredentialBuilder()
       .managedIdentityClientId(clientId)
       .build();`,
  ];
  for (const source of invalidSources) {
    assert.equal(
      evaluateRule("prompt/default-azure-credential", workspace(source)),
      false,
    );
  }
});

test.skip("fallback chain accepts bound and inline builders in MI then CLI order", () => {
  const bound = `
${environment}${systemAndUser}
AzureCliCredential cli = new AzureCliCredentialBuilder().build();
ChainedTokenCredentialBuilder chainBuilder =
    new ChainedTokenCredentialBuilder();
chainBuilder.addFirst(user);
chainBuilder.addLast(cli);
TokenCredential fallback = chainBuilder.build();
`;
  const inline = `
ManagedIdentityCredential managed =
    new ManagedIdentityCredentialBuilder().build();
TokenCredential fallback = new ChainedTokenCredentialBuilder()
    .addFirst(managed)
    .addLast(new AzureCliCredentialBuilder().build())
    .build();
`;
  for (const source of [bound, inline]) {
    assert.equal(
      evaluateRule("prompt/local-fallback-chain", workspace(source)),
      true,
    );
  }
});

test.skip("fallback chain rejects reversed, missing, and unrelated credentials", () => {
  const managed = `
ManagedIdentityCredential managed =
    new ManagedIdentityCredentialBuilder().build();
AzureCliCredential cli = new AzureCliCredentialBuilder().build();
`;
  const invalidSources = [
    `${managed}
     TokenCredential chain = new ChainedTokenCredentialBuilder()
       .addFirst(cli).addLast(managed).build();`,
    `${managed}
     TokenCredential chain = new ChainedTokenCredentialBuilder()
       .addFirst(managed).build();`,
    `${managed}
     TokenCredential other = customCredential();
     TokenCredential chain = new ChainedTokenCredentialBuilder()
       .addFirst(other).addLast(cli).build();`,
    `${managed}
     managed = otherManagedCredential();
     TokenCredential chain = new ChainedTokenCredentialBuilder()
       .addFirst(managed).addLast(cli).build();`,
  ];
  for (const source of invalidSources) {
    assert.equal(
      evaluateRule("prompt/local-fallback-chain", workspace(source)),
      false,
    );
  }
});

test.skip("client association follows bound builders, aliases, env URL, and credential", () => {
  const source = `
${environment}${systemAndUser}
SecretClientBuilder original = new SecretClientBuilder();
original.vaultUrl(vaultUrl);
SecretClientBuilder alias = original;
alias.credential(user);
SecretClient client = alias.buildClient();
`;
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(source)),
    true,
  );
});

test.skip("client association rejects wrong URL and disconnected credentials", () => {
  const invalidSources = [
    `${environment}${systemAndUser}
     SecretClient client = new SecretClientBuilder()
       .vaultUrl(otherUrl).credential(user).buildClient();`,
    `${environment}${systemAndUser}
     TokenCredential other = customCredential();
     SecretClient client = new SecretClientBuilder()
       .vaultUrl(vaultUrl).credential(other).buildClient();`,
    `${environment}${systemAndUser}
     SecretClient client = new SecretClientBuilder()
       .vaultUrl(vaultUrl).buildClient();`,
    `${environment}${systemAndUser}
     user = customCredential();
     SecretClient client = new SecretClientBuilder()
       .vaultUrl(vaultUrl).credential(user).buildClient();`,
  ];
  for (const source of invalidSources) {
    assert.equal(
      evaluateRule("prompt/credential-client-association", workspace(source)),
      false,
    );
  }
});

test.skip("authenticated operation accepts direct and typed alias output", () => {
  const direct = `${environment}${systemAndUser}${associatedClient}
System.out.printf("%s%n", client.getSecret(secretName).getValue());`;
  const aliases = `${environment}${systemAndUser}${associatedClient}
KeyVaultSecret secret = client.getSecret(secretName);
KeyVaultSecret secretAlias = secret;
String value = secretAlias.getValue();
String output = value;
System.err.println(output);`;
  for (const source of [direct, aliases]) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      true,
    );
  }
});

test.skip("authenticated operation follows a typed instance field and local alias", () => {
  const source = (operation) => `
class VaultReader {
  private SecretClient client;

  void configure() {
    ${environment}
    ${systemAndUser}
    SecretClientBuilder builder = new SecretClientBuilder();
    builder.vaultUrl(vaultUrl);
    SecretClientBuilder alias = builder;
    alias.credential(user);
    this.client = alias.buildClient();
  }

  void printSecret() {
    String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
    ${operation}
  }
}`;
  const operations = [
    `System.out.println(this.client.getSecret(secretName).getValue());`,
    `SecretClient local = this.client;
    KeyVaultSecret secret = local.getSecret(secretName);
    System.out.println(secret.getValue());`,
  ];
  for (const operation of operations) {
    const candidate = source(operation);
    assert.equal(
      evaluateRule(
        "prompt/credential-client-association",
        workspace(candidate),
      ),
      true,
    );
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(candidate)),
      true,
    );
  }
});

test.skip("authenticated operation requires getSecret name provenance and value output", () => {
  const invalidSources = [
    `${environment}${systemAndUser}${associatedClient}
     client.getSecret(secretName);`,
    `${environment}${systemAndUser}${associatedClient}
     System.out.println("secret retrieved");`,
    `${environment}${systemAndUser}${associatedClient}
     System.out.println(client.getSecret(otherName).getValue());`,
    `${environment}${systemAndUser}${associatedClient}
     client.getSecretWithResponse(secretName, null, null);`,
  ];
  for (const source of invalidSources) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
    );
  }
});

test.skip("disconnected, overwritten, and shadowed operation bindings fail", () => {
  const invalidSources = [
    `${environment}${systemAndUser}${associatedClient}
     SecretClient disconnected = otherClient();
     System.out.println(disconnected.getSecret(secretName).getValue());`,
    `${environment}${systemAndUser}${associatedClient}
     client = otherClient();
     System.out.println(client.getSecret(secretName).getValue());`,
    `${environment}${systemAndUser}${associatedClient}
     KeyVaultSecret secret = client.getSecret(secretName);
     secret = otherClient().getSecret(secretName);
     System.out.println(secret.getValue());`,
    `${environment}${systemAndUser}${associatedClient}
     String value = client.getSecret(secretName).getValue();
     value += "-redacted";
     System.out.println(value);`,
    `${environment}${systemAndUser}${associatedClient}
     KeyVaultSecret secret = client.getSecret(secretName);
     {
       KeyVaultSecret secret = otherSecret;
       System.out.println(secret.getValue());
     }`,
  ];
  for (const source of invalidSources) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
    );
  }
});

test.skip("field and local client reassignments invalidate later operations", () => {
  const validField = `
class VaultReader {
  private SecretClient client;

  void configure() {
    ${environment}
    ${systemAndUser}
    this.client = new SecretClientBuilder()
        .vaultUrl(vaultUrl)
        .credential(user)
        .buildClient();
  }

  void printSecret() {
    String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
    this.client = otherClient();
    System.out.println(this.client.getSecret(secretName).getValue());
  }
}`;
  const reassignedLocal = validField.replace(
    `this.client = otherClient();
    System.out.println(this.client.getSecret(secretName).getValue());`,
    `SecretClient local = this.client;
    local = otherClient();
    System.out.println(local.getSecret(secretName).getValue());`,
  );
  for (const source of [validField, reassignedLocal]) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
    );
  }
});

test.skip("operation provenance is lexical and source ordered", () => {
  const before = `
System.out.println(secret.getValue());
${environment}${systemAndUser}${associatedClient}
KeyVaultSecret secret = client.getSecret(secretName);
`;
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(before)),
    false,
  );
});

test.skip("meaningful CredentialUnavailableException handling is accepted", () => {
  const sources = [
    `${environment}${systemAndUser}${associatedClient}
     try {
       System.out.println(client.getSecret(secretName).getValue());
     } catch (CredentialUnavailableException exception) {
       System.err.println(exception.getMessage());
     }`,
    `${environment}${systemAndUser}${associatedClient}
     try {
       client.getSecret(secretName);
     } catch (com.azure.identity.CredentialUnavailableException failure) {
       throw new IllegalStateException("Credential unavailable", failure);
     }`,
  ];
  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      true,
    );
  }
});

test.skip("empty, static-message, and wrong exception catches fail", () => {
  const catches = [
    `catch (CredentialUnavailableException exception) {}`,
    `catch (CredentialUnavailableException exception) {
       System.err.println("credential unavailable");
     }`,
    `catch (RuntimeException exception) {
       System.err.println(exception.getMessage());
     }`,
    `catch (ClientAuthenticationException exception) {
       throw new IllegalStateException(exception);
     }`,
  ];
  for (const catchBlock of catches) {
    const source = `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} ${catchBlock}`;
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      false,
    );
  }
});

test.skip("broad catches may not swallow unrelated failures", () => {
  const swallowed = `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException unavailable) {
  System.err.println(unavailable.getMessage());
} catch (RuntimeException unrelated) {
  System.err.println(unrelated.getMessage());
}`;
  assert.equal(
    evaluateRule(
      "prompt/credential-unavailable-error",
      workspace(swallowed),
    ),
    false,
  );

  const preserved = swallowed.replace(
    "System.err.println(unrelated.getMessage());",
    "throw unrelated;",
  );
  assert.equal(
    evaluateRule(
      "prompt/credential-unavailable-error",
      workspace(preserved),
    ),
    true,
  );
});

test.skip("arbitrary unrelated catches must preserve their failures", () => {
  const catches = [
    `catch (IllegalStateException unrelated) {}`,
    `catch (IllegalArgumentException unrelated) {
       System.err.println(unrelated.getMessage());
     }`,
    `catch (CustomFailure unrelated) {
       recordFailure(unrelated);
     }`,
  ];
  for (const unrelatedCatch of catches) {
    const source = `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException unavailable) {
  System.err.println(unavailable.getMessage());
} ${unrelatedCatch}`;
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      false,
    );
  }
});

test.skip("unrelated typed catches may rethrow while credential handling stays useful", () => {
  const source = `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException unavailable) {
  logger.warn("Credential unavailable", unavailable);
} catch (IllegalStateException unrelated) {
  throw unrelated;
}`;
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", workspace(source)),
    true,
  );
});

test.skip("separate catches cannot drop failures beside valid credential handling", () => {
  const unsafeCatches = [
    `catch (IllegalStateException dropped) {}`,
    `catch (IllegalStateException dropped) {
       logger.error("unrelated failure", dropped);
     }`,
    `catch (IllegalStateException dropped) {
       handleFailure("unrelated failure");
     }`,
    `catch (IllegalStateException dropped) {
       recordFailure(dropped);
     }`,
    `catch (IllegalStateException dropped) {
       return;
     }`,
    `catch (IllegalStateException dropped) {
       throw new RuntimeException("replacement");
     }`,
    `catch (IllegalStateException dropped) {
       throw new RuntimeException(dropped.getMessage());
     }`,
    `catch (IllegalStateException dropped) {
       String message = dropped.getMessage();
       throw new RuntimeException(message);
     }`,
    `catch (CredentialUnavailableException dropped) {
       System.err.println(dropped.getMessage());
     }`,
  ];
  for (const unsafeCatch of unsafeCatches) {
    const source = `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException unavailable) {
  logger.warn("Credential unavailable", unavailable);
}
try {
  unrelatedWork();
} ${unsafeCatch}`;
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      false,
      unsafeCatch,
    );
  }
});

test.skip("separate catches may diagnose and preserve failures through valid flows", () => {
  const safeCatches = [
    `catch (IllegalStateException exception) {
       throw exception;
     }`,
    `catch (IllegalStateException failure) {
       logger.error("unrelated failure", failure);
       throw failure;
     }`,
    `catch (IllegalStateException failure) {
       RuntimeException alias = failure;
       throw alias;
     }`,
    `catch (IllegalStateException failure) {
       holder.failure = failure;
       throw holder.failure;
     }`,
    `catch (IllegalStateException failure) {
       RuntimeException wrapped = new RuntimeException(failure);
       throw wrapped;
     }`,
  ];
  for (const safeCatch of safeCatches) {
    const source = `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException unavailable) {
  System.err.println(unavailable.getMessage());
}
try {
  unrelatedWork();
} ${safeCatch}`;
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      true,
      safeCatch,
    );
  }
});

test.skip("Java catch safety is exhaustive across nesting and conditionals", () => {
  const prefix = `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException unavailable) {
  System.err.println(unavailable.getMessage());
}`;
  const unsafe = [
    `${prefix}
try { unrelatedWork(); }
catch (IllegalStateException failure) {
  return;
}`,
    `${prefix}
try { unrelatedWork(); }
catch (IllegalStateException failure) {
  if (shouldPropagate()) {
    throw failure;
  }
}`,
    `${prefix}
try { unrelatedWork(); }
catch (IllegalStateException failure) {
  throw new RuntimeException(failure.getMessage());
}`,
    `${prefix}
try { unrelatedWork(); }
catch (IllegalStateException failure) {
  try { recover(); }
  catch (IllegalArgumentException nested) {
    logger.error("nested", nested);
  }
  throw failure;
}`,
    `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException | java.io.IOException failure) {
  throw new RuntimeException(failure);
}`,
  ];
  for (const source of unsafe) {
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      false,
      source,
    );
  }

  const safe = [
    `${prefix}
try { unrelatedWork(); }
catch (IllegalStateException failure) {
  if (shouldWrap()) {
    throw new RuntimeException("wrapped", failure);
  } else {
    throw failure;
  }
}`,
    `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException |
         ClientAuthenticationException failure) {
  throw new RuntimeException("authentication failed", failure);
}`,
  ];
  for (const source of safe) {
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", workspace(source)),
      true,
      source,
    );
  }
});

test.skip("Java loop paths cannot hide unsafe catch terminals", () => {
  const prefix = `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException unavailable) {
  System.err.println(unavailable.getMessage());
}
try { unrelatedWork(); }
catch (IllegalStateException failure) `;
  const unsafe = [
    `{ while (shouldRetry()) { return; } throw failure; }`,
    `{ for (int i = 0; i < count; i++) {
         if (shouldReturn(i)) return;
       }
       throw failure;
     }`,
    `{ for (Object item : items) {
         if (isBad(item)) throw new RuntimeException("replacement");
       }
       throw failure;
     }`,
    `{ for (Object item : items)
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
        workspace(`${prefix}${handler}`),
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
    `{ for (int i = 0; i < count; i++) {
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
         throw new RuntimeException("replacement");
       }
       throw failure;
     }`,
    `{ while (false) return; throw failure; }`,
    `{ for (Object item : items) break; throw failure; }`,
    `{ for (;;) { throw failure; } }`,
  ];
  for (const handler of safe) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        workspace(`${prefix}${handler}`),
      ),
      true,
      handler,
    );
  }
});

test.skip("credential handling accepts a connected instance-field operation", () => {
  const source = `
class VaultReader {
  private SecretClient client;

  void configure() {
    ${environment}
    ${systemAndUser}
    SecretClientBuilder builder = new SecretClientBuilder()
        .vaultUrl(vaultUrl);
    SecretClientBuilder alias = builder;
    alias.credential(user);
    this.client = alias.buildClient();
  }

  void printSecret() {
    String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
    try {
      System.out.println(this.client.getSecret(secretName).getValue());
    } catch (CredentialUnavailableException unavailable) {
      throw new IllegalStateException("Credential unavailable", unavailable);
    }
  }
}`;
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", workspace(source)),
    true,
  );
});

test.skip("passing credential unavailability to an arbitrary sink is not useful", () => {
  const source = `${environment}${systemAndUser}${associatedClient}
try {
  client.getSecret(secretName);
} catch (CredentialUnavailableException unavailable) {
  ignore(unavailable);
}`;
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", workspace(source)),
    false,
  );
});

test.skip("error handling must wrap the associated getSecret operation", () => {
  const source = `${environment}${systemAndUser}${associatedClient}
client.getSecret(secretName);
try {
  unrelatedWork();
} catch (CredentialUnavailableException exception) {
  throw new IllegalStateException(exception);
}`;
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", workspace(source)),
    false,
  );
});

test.skip("comments and strings cannot satisfy any source criterion", () => {
  const source = `
// ManagedIdentityCredential system = new ManagedIdentityCredentialBuilder().build();
/*
DefaultAzureCredential credential = new DefaultAzureCredentialBuilder()
  .managedIdentityClientId(clientId).build();
*/
String fake = "new ChainedTokenCredentialBuilder().addFirst(mi).addLast(cli).build();";
String fakeClient = "new SecretClientBuilder().vaultUrl(url).credential(mi).buildClient();";
String fakeOperation = "client.getSecret(secretName).getValue()";
String fakeCatch = "catch (CredentialUnavailableException e) { throw e; }";
`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-packages",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test.skip("all criteria reject a workspace with no generated Java source", () => {
  const empty = {
    ...completeWorkspace,
    sourceFiles: [],
    source: "",
  };
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, empty), false, rule);
  }
});

test.skip("wrongly typed aliases cannot carry secret value provenance", () => {
  const source = `${environment}${systemAndUser}${associatedClient}
String secret = client.getSecret(secretName);
System.out.println(secret);`;
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(source)),
    false,
  );
});

test.skip("overwriting a client builder disconnects its earlier configuration", () => {
  const source = `${environment}${systemAndUser}
SecretClientBuilder builder = new SecretClientBuilder();
builder.vaultUrl(vaultUrl);
builder.credential(user);
builder = new SecretClientBuilder();
SecretClient client = builder.buildClient();`;
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(source)),
    false,
  );
});

test.skip("shadowed clients cannot borrow association from an outer binding", () => {
  const source = `${environment}${systemAndUser}${associatedClient}
{
  SecretClient client = otherClient();
  System.out.println(client.getSecret(secretName).getValue());
}`;
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(source)),
    false,
  );
});

test.skip("bound chain mutation order is significant", () => {
  const source = `
ManagedIdentityCredential managed =
    new ManagedIdentityCredentialBuilder().build();
AzureCliCredential cli = new AzureCliCredentialBuilder().build();
ChainedTokenCredentialBuilder builder = new ChainedTokenCredentialBuilder();
builder.addLast(cli);
builder.addLast(managed);
TokenCredential chain = builder.build();
`;
  assert.equal(
    evaluateRule("prompt/local-fallback-chain", workspace(source)),
    false,
  );
});
