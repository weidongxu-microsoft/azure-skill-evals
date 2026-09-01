import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateJavaCheck,
  javaCheckNames,
  loadJavaWorkspace,
} from "../../languages/java/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/identity-java-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadJavaWorkspace(goldenWorkspacePath);

test.skip("Java Identity reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip("Java Identity reference passes every language check", () => {
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test.skip("both Azure packages are required and build comments do not count", () => {
  for (const artifact of [
    "azure-identity",
    "azure-security-keyvault-secrets",
  ]) {
    const dependency = new RegExp(
      `<dependency>\\s*<groupId>com\\.azure</groupId>\\s*<artifactId>${artifact}</artifactId>[\\s\\S]*?</dependency>`,
    );
    const workspace = {
      ...completeWorkspace,
      build: completeWorkspace.build.replace(
        dependency,
        `<!-- com.azure:${artifact} -->`,
      ),
    };
    assert.equal(evaluateRule("prompt/identity-packages", workspace), false);
  }
});

test.skip("configured and qualified credential builders are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
com.azure.identity.DefaultAzureCredentialBuilder credentialBuilder =
    new com.azure.identity.DefaultAzureCredentialBuilder();
credentialBuilder.managedIdentityClientId(clientId);
com.azure.core.credential.TokenCredential credential =
    credentialBuilder.build();
com.azure.security.keyvault.secrets.SecretClient secretClient =
    new com.azure.security.keyvault.secrets.SecretClientBuilder()
        .vaultUrl(vaultUrl)
        .credential(credential)
        .buildClient();
System.out.println(secretClient.getSecret(secretName).getValue());
`,
  };

  assert.equal(evaluateRule("prompt/default-azure-credential", workspace), true);
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace),
    true,
  );
  assert.equal(evaluateRule("prompt/authenticated-operation", workspace), true);
});

test.skip("an inline credential and a separately configured client builder are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
SecretClientBuilder clientBuilder = new SecretClientBuilder();
clientBuilder.vaultUrl(vaultUrl);
clientBuilder.credential(new DefaultAzureCredentialBuilder()
    .excludeEnvironmentCredential()
    .build());
SecretClient client = clientBuilder.buildClient();
System.out.println(
    client.getSecretWithResponse(secretName, null, Context.NONE)
        .getValue()
        .getValue());
`,
  };

  assert.equal(evaluateRule("prompt/default-azure-credential", workspace), true);
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace),
    true,
  );
  assert.equal(evaluateRule("prompt/authenticated-operation", workspace), true);
});

test.skip("unused credentials and credentials passed to another client fail association", () => {
  const unused = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .buildClient();
client.getSecret(secretName);
`,
  };
  const wrongCredential = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
TokenCredential otherCredential = customCredential();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(otherCredential)
    .buildClient();
client.getSecret(secretName);
`,
  };

  for (const workspace of [unused, wrongCredential]) {
    assert.equal(evaluateRule("prompt/default-azure-credential", workspace), true);
    assert.equal(
      evaluateRule("prompt/credential-client-association", workspace),
      false,
    );
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace),
      false,
    );
  }
});

test.skip("the authenticated operation must be invoked on the associated client", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient authenticated = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
SecretClient disconnected = otherClient();
disconnected.getSecret(secretName);
`,
  };

  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace),
    true,
  );
  assert.equal(evaluateRule("prompt/authenticated-operation", workspace), false);
});

test.skip("retrieving a secret without outputting its value fails", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "System.out.println(secret.getValue());",
      'System.out.println("Secret retrieved");',
    ),
  };

  assert.equal(evaluateRule("prompt/authenticated-operation", workspace), false);
});

test.skip("output from a disconnected client does not satisfy the operation", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient authenticated = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
SecretClient disconnected = otherClient();
authenticated.getSecret(secretName);
KeyVaultSecret secret = disconnected.getSecret(secretName);
System.out.println(secret.getValue());
`,
  };

  assert.equal(evaluateRule("prompt/authenticated-operation", workspace), false);
});

test.skip("secret output before the associated client declaration fails", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
System.out.println(client.getSecret(secretName).getValue());
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
`,
  };

  assert.equal(evaluateRule("prompt/authenticated-operation", workspace), false);
});

test.skip("direct and response-based secret value output are accepted", () => {
  const direct = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
System.out.printf("%s%n", client.getSecret(secretName).getValue());
`,
  };
  const response = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
Response<KeyVaultSecret> response =
    client.getSecretWithResponse(secretName, null, Context.NONE);
System.out.print(response.getValue().getValue());
`,
  };

  for (const workspace of [direct, response]) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace),
      true,
    );
  }
});

test.skip("overwriting retrieved values before output fails", () => {
  const prefix = `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
SecretClient disconnected = otherClient();
`;
  const sources = [
    `${prefix}
KeyVaultSecret secret = client.getSecret(secretName);
secret = disconnected.getSecret(secretName);
System.out.println(secret.getValue());
`,
    `${prefix}
Response<KeyVaultSecret> response =
    client.getSecretWithResponse(secretName, null, Context.NONE);
response = disconnected.getSecretWithResponse(secretName, null, Context.NONE);
System.out.println(response.getValue().getValue());
`,
    `${prefix}
String value = client.getSecret(secretName).getValue();
value = fallbackValue;
System.err.printf("%s%n", value);
`,
    `${prefix}
String value = client.getSecret(secretName).getValue();
value += "-redacted";
System.out.println(value);
`,
    `${prefix}
var value = client.getSecret(secretName).getValue();
value = client.getSecret(secretName);
System.out.println(value.getValue());
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", {
        ...completeWorkspace,
        source,
      }),
      false,
    );
  }
});

test.skip("unchanged retrieval aliases and alternate output are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
SecretClient disconnected = otherClient();
Response<KeyVaultSecret> response =
    client.getSecretWithResponse(secretName, null, Context.NONE);
KeyVaultSecret secret = response.getValue();
String value = secret.getValue();
String outputValue = value;
value = disconnected.getSecret(secretName).getValue();
System.err.format("Secret: %s%n", outputValue);
`,
  };

  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace),
    true,
  );
});

test.skip("aliases overwritten from disconnected retrievals fail", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
SecretClient disconnected = otherClient();
KeyVaultSecret secret = client.getSecret(secretName);
KeyVaultSecret alias = secret;
alias = disconnected.getSecret(secretName);
System.out.print(alias.getValue());
`,
  };

  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace),
    false,
  );
});

test.skip("client reassignment invalidates a later authenticated operation", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
client = otherClient();
System.out.println(client.getSecret(secretName).getValue());
`,
  };

  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace),
    true,
  );
  assert.equal(evaluateRule("prompt/authenticated-operation", workspace), false);
});

test.skip("credential reassignment invalidates association and later operation", () => {
  const beforeConstruction = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
credential = customCredential();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
System.out.println(client.getSecret(secretName).getValue());
`,
  };
  const beforeOperation = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
credential = null;
System.out.println(client.getSecret(secretName).getValue());
`,
  };

  assert.equal(
    evaluateRule("prompt/credential-client-association", beforeConstruction),
    false,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", beforeConstruction),
    false,
  );
  assert.equal(
    evaluateRule("prompt/credential-client-association", beforeOperation),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", beforeOperation),
    false,
  );
});

test.skip("valid typed reassignment recovery restores the operation binding", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
var credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
credential = null;
credential = new DefaultAzureCredentialBuilder().build();
client = null;
client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
System.out.println(client.getSecret(secretName).getValue());
`,
  };

  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace),
    true,
  );
  assert.equal(evaluateRule("prompt/authenticated-operation", workspace), true);
});

test.skip("same-named bindings are resolved in lexical scope", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
{
    TokenCredential credential = null;
    SecretClient client = new SecretClientBuilder()
        .vaultUrl(vaultUrl)
        .credential(credential)
        .buildClient();
    System.out.println(client.getSecret(secretName).getValue());
}
`,
  };

  assert.equal(evaluateRule("prompt/authenticated-operation", workspace), false);
});

test.skip("qualified and multi-catch authentication exceptions are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
try {
    client.getSecret(secretName);
} catch (com.azure.identity.CredentialUnavailableException |
         com.azure.core.exception.ClientAuthenticationException exception) {
    handle(exception);
}
`,
  };

  assert.equal(evaluateRule("prompt/auth-errors", workspace), true);
});

test.skip("empty authentication catches fail", () => {
  for (const source of [
    `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
try {
    client.getSecret(secretName);
} catch (CredentialUnavailableException exception) {
} catch (ClientAuthenticationException exception) {
}
`,
    `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
try {
    client.getSecret(secretName);
} catch (CredentialUnavailableException exception) {
    // Ignored.
} catch (ClientAuthenticationException exception) {
    handle(exception);
}
`,
  ]) {
    assert.equal(
      evaluateRule("prompt/auth-errors", {
        ...completeWorkspace,
        source,
      }),
      false,
    );
  }
});

test.skip("rethrowing authentication failures is meaningful handling", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
try {
    client.getSecret(secretName);
} catch (CredentialUnavailableException |
         ClientAuthenticationException exception) {
    throw new IllegalStateException("Authentication failed", exception);
}
`,
  };

  assert.equal(evaluateRule("prompt/auth-errors", workspace), true);
});

test.skip("generic and foreign authentication exceptions fail", () => {
  for (const source of [
    completeWorkspace.source
      .replaceAll("CredentialUnavailableException", "Exception")
      .replaceAll("ClientAuthenticationException", "AuthenticationFailedException"),
    completeWorkspace.source.replace(
      "} catch (ClientAuthenticationException exception) {",
      "} catch (RuntimeException exception) {",
    ),
    completeWorkspace.source.replace(
      "} catch (CredentialUnavailableException exception) {",
      "} catch (RuntimeException exception) {",
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/auth-errors", {
        ...completeWorkspace,
        source,
      }),
      false,
    );
  }
});

test.skip("authentication catches disconnected from the client operation fail", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
TokenCredential credential = new DefaultAzureCredentialBuilder().build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
client.getSecret(secretName);
try {
    unrelatedWork();
} catch (CredentialUnavailableException |
         ClientAuthenticationException exception) {
    handle(exception);
}
`,
  };

  assert.equal(evaluateRule("prompt/auth-errors", workspace), false);
});

test.skip("identity diagnostics require a real provider and early logger configuration", () => {
  const property =
    'System.setProperty("org.slf4j.simpleLogger.log.com.azure.identity", "trace");';
  assert.equal(
    evaluateRule("prompt/identity-diagnostics", {
      ...completeWorkspace,
      source: `${property}
        TokenCredential credential = new DefaultAzureCredentialBuilder().build();`,
    }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/identity-diagnostics", {
      ...completeWorkspace,
      build: completeWorkspace.build.replace("slf4j-simple", "slf4j-api"),
      source: property,
    }),
    false,
  );
  assert.equal(
    evaluateRule("prompt/identity-diagnostics", {
      ...completeWorkspace,
      source: `new DefaultAzureCredentialBuilder().build();
        ${property}`,
    }),
    false,
  );
});

test.skip("fake diagnostics, comments, and strings do not satisfy source rules", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
// new DefaultAzureCredentialBuilder().build();
// catch (CredentialUnavailableException | ClientAuthenticationException e) {}
String sample = "new SecretClientBuilder().credential(credential).buildClient();";
String logging = "System.setProperty(\\"org.slf4j.simpleLogger.log.com.azure.identity\\", \\"debug\\")";
System.out.println("identity diagnostics enabled");
`,
  };

  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-packages",
  )) {
    assert.equal(evaluateRule(rule, workspace), false, rule);
  }
});

test.skip("all rules reject a workspace with no generated Java source", () => {
  const workspace = {
    ...completeWorkspace,
    sourceFiles: [],
    source: "",
  };

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace), false, rule);
  }
});
