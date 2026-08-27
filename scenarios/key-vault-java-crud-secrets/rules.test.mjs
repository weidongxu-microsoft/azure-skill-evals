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
} from "./tools/key-vault-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadJavaWorkspace(goldenPath);

const imports = `
import com.azure.core.exception.HttpResponseException;
import com.azure.core.util.polling.SyncPoller;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;
`;

function workspace(source, build = completeWorkspace.build) {
  return {
    sourceFiles: ["ArbitraryApplication.java"],
    buildFiles: ["pom.xml"],
    source,
    build,
  };
}

function basicFlow(overrides = {}) {
  const create =
    overrides.create ??
    'client.setSecret("my-secret", "my-secret-value");';
  const read =
    overrides.read ??
    'KeyVaultSecret secret = client.getSecret("my-secret");';
  const output =
    overrides.output ?? "System.out.println(secret.getValue());";
  const update =
    overrides.update ??
    'client.setSecret("my-secret", "updated-value");';
  const remove =
    overrides.remove ??
    `SyncPoller<?, ?> poller = client.beginDeleteSecret("my-secret");
     poller.waitForCompletion();
     client.purgeDeletedSecret("my-secret");`;
  return `${imports}
class Application {
  public static void main(String[] args) {
    SecretClient client = new SecretClientBuilder()
        .vaultUrl("https://example.vault.azure.net")
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    try {
      ${create}
      ${read}
      ${output}
      ${update}
      ${remove}
    } catch (HttpResponseException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    }
  }
}`;
}

test("the Java 17 golden application passes exactly eight graders", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("the golden application passes reusable Java conventions", () => {
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test("both exact active Maven dependencies are required", () => {
  for (const [artifact, version] of [
    ["azure-identity", "1.18.5"],
    ["azure-security-keyvault-secrets", "4.11.2"],
  ]) {
    const dependency = new RegExp(
      `<dependency>\\s*<groupId>com\\.azure</groupId>\\s*<artifactId>${artifact}</artifactId>\\s*<version>${version.replaceAll(".", "\\.")}</version>\\s*</dependency>`,
    );
    for (const replacement of [
      `<!-- com.azure:${artifact}:${version} -->`,
      completeWorkspace.build.match(dependency)?.[0].replace(
        version,
        "0.0.1",
      ) ?? "",
    ]) {
      assert.equal(
        evaluateRule("prompt/sdk-dependencies", {
          ...completeWorkspace,
          build: completeWorkspace.build.replace(dependency, replacement),
        }),
        false,
      );
    }
  }
});

test("property-pinned dependencies are active but managed or profiled decoys are not", () => {
  const dependencies = `
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>azure-identity</artifactId>
      <version>\${identity.version}</version>
    </dependency>
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>azure-security-keyvault-secrets</artifactId>
      <version>\${secrets.version}</version>
    </dependency>`;
  const active = `<project>
    <properties>
      <identity.version>1.18.5</identity.version>
      <secrets.version>4.11.2</secrets.version>
    </properties>
    <dependencies>${dependencies}</dependencies>
  </project>`;
  assert.equal(
    evaluateRule("prompt/sdk-dependencies", workspace(basicFlow(), active)),
    true,
  );

  for (const decoy of [
    `<project><dependencyManagement><dependencies>${dependencies}</dependencies></dependencyManagement></project>`,
    `<project><profiles><profile><dependencies>${dependencies}</dependencies></profile></profiles></project>`,
    `<project><dependencies>${dependencies.split("</dependency>")[0]}</dependency></dependencies></project>
     <project><dependencies>${dependencies.split("</dependency>")[1]}</dependency></dependencies></project>`,
    `plugins { id("java") }\n// ${dependencies}`,
  ]) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", workspace(basicFlow(), decoy)),
      false,
    );
  }
});

test("only application Maven runtime dependencies satisfy package pins", () => {
  const dependency = (artifact, version, scope = "") => `
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>${artifact}</artifactId>
      <version>${version}</version>
      ${scope ? `<scope>${scope}</scope>` : ""}
    </dependency>`;
  const both = `
    ${dependency("azure-identity", "1.18.5", "compile")}
    ${dependency("azure-security-keyvault-secrets", "4.11.2", "runtime")}`;
  const activeProfile = `<project>
    <packaging>jar</packaging>
    <profiles><profile>
      <activation><jdk>[17,18)</jdk></activation>
      <dependencies>${both}</dependencies>
    </profile></profiles>
  </project>`;
  assert.equal(
    evaluateRule("prompt/sdk-dependencies", workspace(basicFlow(), activeProfile)),
    true,
  );

  for (const decoy of [
    `<project><packaging>pom</packaging><dependencies>${both}</dependencies></project>`,
    `<project><build><plugins><plugin><dependencies>${both}</dependencies></plugin></plugins></build></project>`,
    `<project><dependencyManagement><dependencies>${both}</dependencies></dependencyManagement></project>`,
    `<project><profiles><profile><activation><jdk>21</jdk></activation><dependencies>${both}</dependencies></profile></profiles></project>`,
    `<project><dependencies>
       ${dependency("azure-identity", "1.18.5", "test")}
       ${dependency("azure-security-keyvault-secrets", "4.11.2")}
     </dependencies></project>`,
    `<project><dependencies>${dependency("azure-identity", "1.18.5")}</dependencies></project>
     <project><dependencies>${dependency("azure-security-keyvault-secrets", "4.11.2")}</dependencies></project>`,
    `<project><!-- <dependencies>${both}</dependencies> --></project>`,
  ]) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", workspace(basicFlow(), decoy)),
      false,
      decoy,
    );
  }
});

test("active Gradle runtime declarations preserve exact package pins", () => {
  const dependencies = `dependencies {
    implementation("com.azure:azure-identity:1.18.5")
    runtimeOnly 'com.azure:azure-security-keyvault-secrets:4.11.2'
  }`;
  for (const build of [
    dependencies,
    `if (featureEnabled) { ${dependencies} }`,
    `if (false) { dependencies {} } else { ${dependencies} }`,
  ]) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", workspace(basicFlow(), build)),
      true,
      build,
    );
  }
  for (const build of [
    `if (false) { ${dependencies} }`,
    `buildscript { ${dependencies} }`,
    `// ${dependencies}`,
    `dependencies {
       testImplementation("com.azure:azure-identity:1.18.5")
       compileOnly("com.azure:azure-security-keyvault-secrets:4.11.2")
     }`,
    dependencies.replace("4.11.2", "0.0.1"),
  ]) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", workspace(basicFlow(), build)),
      false,
      build,
    );
  }
});

test("qualified builders, aliases, reachable helpers, fields, loops, and multi-catches pass", () => {
  const source = `
import com.azure.core.exception.HttpResponseException;
import com.azure.core.util.polling.SyncPoller;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;
class AlternateApplication {
  private static final String NAME = "my-secret";
  private static final String INITIAL = "my-secret-value";

  static SecretClient buildClient() {
    com.azure.identity.DefaultAzureCredentialBuilder credentialBuilder =
        new com.azure.identity.DefaultAzureCredentialBuilder();
    var credential = credentialBuilder.build();
    SecretClientBuilder builder = new SecretClientBuilder();
    builder.vaultUrl("https://example.vault.azure.net");
    builder.credential(credential);
    SecretClient firstAlias = builder.buildClient();
    return firstAlias;
  }

  static void perform(SecretClient suppliedClient) {
    SecretClient client = suppliedClient;
    try {
      for (int attempt = 0; attempt < 1; attempt++) {
        client.setSecret(new KeyVaultSecret(NAME, INITIAL));
        var response =
            client.getSecretWithResponse(NAME, null, null);
        System.out.printf("value=%s%n", response.getValue().getValue());
        client.setSecret(new KeyVaultSecret(NAME, "updated-value"));
        var deleteOperation = client.beginDeleteSecret(NAME);
        deleteOperation.waitForCompletion();
        client.purgeDeletedSecret(NAME);
      }
    } catch (HttpResponseException | IllegalStateException exception) {
      System.err.println(exception);
      throw exception;
    } catch (IllegalArgumentException exception) {
      throw exception;
    }
  }

  public static void main(String[] args) {
    perform(buildClient());
  }
}`;

  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-dependencies")) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("real fully qualified SDK types remain valid when fake simple names exist", () => {
  const source = `
class DefaultAzureCredentialBuilder {}
class SecretClientBuilder {}
class SecretClient {}
class KeyVaultSecret {}
class SyncPoller {}
class HttpResponseException extends RuntimeException {}
class QualifiedApplication {
  public static void main(String[] args) {
    com.azure.security.keyvault.secrets.SecretClient client =
        new com.azure.security.keyvault.secrets.SecretClientBuilder()
            .vaultUrl("https://example.vault.azure.net")
            .credential(new com.azure.identity.DefaultAzureCredentialBuilder().build())
            .buildClient();
    try {
      client.setSecret("my-secret", "my-secret-value");
      var secret = client.getSecret("my-secret");
      System.out.println(secret.getValue());
      client.setSecret(
          new com.azure.security.keyvault.secrets.models.KeyVaultSecret(
              "my-secret", "updated-value"));
      var poller = client.beginDeleteSecret("my-secret");
      poller.waitForCompletion();
      client.purgeDeletedSecret("my-secret");
    } catch (com.azure.core.exception.HttpResponseException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    }
  }
}`;

  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-dependencies")) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("local and wrong-package SDK shadows cannot satisfy client authentication", () => {
  const fake = `
class DefaultAzureCredentialBuilder {
  DefaultAzureCredentialBuilder build() { return this; }
}
class SecretClientBuilder {
  SecretClientBuilder credential(Object value) { return this; }
  SecretClient buildClient() { return new SecretClient(); }
}
class SecretClient {}
class FakeApplication {
  public static void main(String[] args) {
    SecretClient client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
  }
}`;
  const wrongImports = `
import example.fake.DefaultAzureCredentialBuilder;
import example.fake.SecretClient;
import example.fake.SecretClientBuilder;
class WrongImportApplication {
  public static void main(String[] args) {
    SecretClient client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
  }
}`;
  for (const source of [fake, wrongImports]) {
    assert.equal(
      evaluateRule("prompt/client-authentication", workspace(source)),
      false,
    );
  }
});

test("valid code in comments, strings, false branches, and uncalled helpers is ignored", () => {
  const source = `${imports}
class DecoyApplication {
  static void neverCalled() {
    SecretClient client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    client.setSecret("my-secret", "my-secret-value");
  }
  public static void main(String[] args) {
    String decoy = "new SecretClientBuilder().credential()";
    // new SecretClientBuilder().credential(new DefaultAzureCredentialBuilder().build()).buildClient();
    if (false) {
      neverCalled();
    }
  }
}`;
  assert.equal(
    evaluateRule("prompt/client-authentication", workspace(source)),
    false,
  );
  assert.equal(evaluateRule("prompt/create-secret", workspace(source)), false);
});

test("client aliases work but reassignment and inner-scope shadowing invalidate operations", () => {
  const aliased = basicFlow().replace(
    "try {",
    "SecretClient alias = client;\n    client = null;\n    client = alias;\n    try {",
  );
  assert.equal(
    evaluateRule("prompt/wait-and-purge", workspace(aliased)),
    true,
  );

  const reassigned = basicFlow().replace(
    "try {",
    "client = unrelatedClient();\n    try {",
  );
  assert.equal(
    evaluateRule("prompt/client-authentication", workspace(reassigned)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(reassigned)),
    false,
  );

  const shadowed = basicFlow().replace(
    "try {",
    "try {\n      SecretClient client = unrelatedClient();",
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(shadowed)),
    false,
  );
});

test("constructor-initialized member clients remain associated in reachable methods", () => {
  const source = `${imports}
class MemberApplication {
  private SecretClient client;

  MemberApplication() {
    this.client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
  }

  void run() {
    try {
      client.setSecret("my-secret", "my-secret-value");
      KeyVaultSecret secret = client.getSecret("my-secret");
      System.out.println(secret.getValue());
      client.setSecret("my-secret", "updated-value");
      var poller = client.beginDeleteSecret("my-secret");
      poller.waitForCompletion();
      client.purgeDeletedSecret("my-secret");
    } catch (HttpResponseException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    }
  }

  public static void main(String[] args) {
    new MemberApplication().run();
  }
}`;
  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-dependencies")) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("every exact secret name and value must flow through the ordered lifecycle", () => {
  const cases = [
    ["create", { create: 'client.setSecret("other", "my-secret-value");' }],
    ["create", { create: 'client.setSecret("my-secret", "wrong");' }],
    ["read", { read: 'KeyVaultSecret secret = client.getSecret("other");' }],
    ["update", { update: 'client.setSecret("other", "updated-value");' }],
    ["update", { update: 'client.setSecret("my-secret", "wrong");' }],
    [
      "delete",
      {
        remove: `SyncPoller<?, ?> poller = client.beginDeleteSecret("other");
          poller.waitForCompletion();
          client.purgeDeletedSecret("other");`,
      },
    ],
  ];
  for (const [failedStage, overrides] of cases) {
    const source = basicFlow(overrides);
    const expectedFailure = {
      create: "prompt/create-secret",
      read: "prompt/read-and-print",
      update: "prompt/update-secret",
      delete: "prompt/delete-secret",
    }[failedStage];
    assert.equal(evaluateRule(expectedFailure, workspace(source)), false);
  }
});

test("only the retrieved value satisfies output and aliases preserve provenance", () => {
  const hardcoded = basicFlow({
    output: 'System.out.println("my-secret-value");',
  });
  assert.equal(
    evaluateRule("prompt/read-and-print", workspace(hardcoded)),
    false,
  );

  const overwritten = basicFlow({
    output: `String value = secret.getValue();
      value = "my-secret-value";
      System.out.println(value);`,
  });
  assert.equal(
    evaluateRule("prompt/read-and-print", workspace(overwritten)),
    false,
  );

  const alias = basicFlow({
    output: `KeyVaultSecret alias = secret;
      String value = alias.getValue();
      String outputValue = value;
      System.out.format("%s%n", outputValue);`,
  });
  assert.equal(evaluateRule("prompt/read-and-print", workspace(alias)), true);

  const decorated = basicFlow({
    output:
      'System.out.println("Retrieved value: " + secret.getValue());',
  });
  assert.equal(
    evaluateRule("prompt/read-and-print", workspace(decorated)),
    true,
  );
});

test("updates must follow retrieved output and deletes must follow the update", () => {
  const earlyUpdate = basicFlow({
    read: `client.setSecret("my-secret", "updated-value");
      KeyVaultSecret secret = client.getSecret("my-secret");`,
    update: "",
  });
  assert.equal(evaluateRule("prompt/update-secret", workspace(earlyUpdate)), false);

  const earlyDelete = basicFlow({
    update: `SyncPoller<?, ?> early = client.beginDeleteSecret("my-secret");
      client.setSecret("my-secret", "updated-value");`,
    remove: `early.waitForCompletion();
      client.purgeDeletedSecret("my-secret");`,
  });
  assert.equal(evaluateRule("prompt/delete-secret", workspace(earlyDelete)), false);
});

test("ordered lifecycle events must coexist on one reachable branch", () => {
  const split = basicFlow({
    create: `if (chooseCreate()) {
        client.setSecret("my-secret", "my-secret-value");
      } else {`,
    remove: `SyncPoller<?, ?> poller = client.beginDeleteSecret("my-secret");
      poller.waitForCompletion();
      client.purgeDeletedSecret("my-secret");
      }`,
  });
  assert.equal(evaluateRule("prompt/create-secret", workspace(split)), true);
  assert.equal(evaluateRule("prompt/read-and-print", workspace(split)), false);
  assert.equal(evaluateRule("prompt/wait-and-purge", workspace(split)), false);

  const unreachable = basicFlow({
    create: `if (false) {
      client.setSecret("my-secret", "my-secret-value");`,
    remove: `SyncPoller<?, ?> poller = client.beginDeleteSecret("my-secret");
      poller.waitForCompletion();
      client.purgeDeletedSecret("my-secret");
      }`,
  });
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(unreachable)),
    false,
  );
});

test("a complete branch and helper-decomposed lifecycle remain valid", () => {
  const branched = basicFlow({
    create: `if (shouldRun()) {
      client.setSecret("my-secret", "my-secret-value");`,
    remove: `SyncPoller<?, ?> poller = client.beginDeleteSecret("my-secret");
      poller.waitForCompletion();
      client.purgeDeletedSecret("my-secret");
      } else {
        skipRun();
      }`,
  });
  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-dependencies")) {
    assert.equal(evaluateRule(rule, workspace(branched)), true, rule);
  }

  const helpers = `${imports}
class HelperApplication {
  static void create(SecretClient client) {
    client.setSecret("my-secret", "my-secret-value");
  }
  static KeyVaultSecret read(SecretClient client) {
    return client.getSecret("my-secret");
  }
  static void print(KeyVaultSecret secret) {
    System.out.println(secret.getValue());
  }
  static void update(SecretClient client) {
    client.setSecret("my-secret", "updated-value");
  }
  static SyncPoller<?, ?> delete(SecretClient client) {
    return client.beginDeleteSecret("my-secret");
  }
  static void finish(SecretClient client, SyncPoller<?, ?> poller) {
    poller.waitForCompletion();
    client.purgeDeletedSecret("my-secret");
  }
  public static void main(String[] args) {
    SecretClient client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    try {
      create(client);
      KeyVaultSecret secret = read(client);
      print(secret);
      update(client);
      SyncPoller<?, ?> poller = delete(client);
      finish(client, poller);
    } catch (HttpResponseException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    }
  }
}`;
  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-dependencies")) {
    assert.equal(evaluateRule(rule, workspace(helpers)), true, rule);
  }
});

test("only completion of the poller returned by the matching delete permits purge", () => {
  const unrelated = basicFlow({
    remove: `SyncPoller<?, ?> deletePoller =
        client.beginDeleteSecret("my-secret");
      SyncPoller<?, ?> unrelated = otherPoller();
      unrelated.waitForCompletion();
      client.purgeDeletedSecret("my-secret");`,
  });
  assert.equal(
    evaluateRule("prompt/wait-and-purge", workspace(unrelated)),
    false,
  );

  const overwritten = basicFlow({
    remove: `SyncPoller<?, ?> poller =
        client.beginDeleteSecret("my-secret");
      poller = otherPoller();
      poller.waitForCompletion();
      client.purgeDeletedSecret("my-secret");`,
  });
  assert.equal(
    evaluateRule("prompt/wait-and-purge", workspace(overwritten)),
    false,
  );

  const earlyPurge = basicFlow({
    remove: `SyncPoller<?, ?> poller =
        client.beginDeleteSecret("my-secret");
      client.purgeDeletedSecret("my-secret");
      poller.waitForCompletion();`,
  });
  assert.equal(
    evaluateRule("prompt/wait-and-purge", workspace(earlyPurge)),
    false,
  );
});

test("HttpResponseException must protect a client operation and be meaningful", () => {
  const swallowed = basicFlow().replace(
    `System.err.println(exception.getMessage());
      throw exception;`,
    "",
  );
  assert.equal(
    evaluateRule("prompt/http-response-exception", workspace(swallowed)),
    false,
  );

  const generic = basicFlow()
    .replaceAll("HttpResponseException", "Exception")
    .replace("import com.azure.core.exception.Exception;", "");
  assert.equal(
    evaluateRule("prompt/http-response-exception", workspace(generic)),
    false,
  );

  const unrelated = `${imports}
class UnrelatedCatchApplication {
  public static void main(String[] args) {
    SecretClient client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    client.setSecret("my-secret", "my-secret-value");
    try {
      unrelatedWork();
    } catch (HttpResponseException exception) {
      throw exception;
    }
  }
}`;
  assert.equal(
    evaluateRule("prompt/http-response-exception", workspace(unrelated)),
    false,
  );

  const swallowedUnrelated = basicFlow().replace(
    `} catch (HttpResponseException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    }`,
    `} catch (HttpResponseException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    } catch (IllegalStateException exception) {
      System.err.println(exception.getMessage());
    }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/http-response-exception",
      workspace(swallowedUnrelated),
    ),
    false,
  );
});

test("every reachable catch path must preserve its exception", () => {
  const handledExactly = basicFlow().replace(
    `System.err.println(exception.getMessage());
      throw exception;`,
    "System.err.println(exception.getMessage());",
  );
  assert.equal(
    evaluateRule(
      "prompt/http-response-exception",
      workspace(handledExactly),
    ),
    true,
  );

  const conditional = basicFlow().replace(
    `System.err.println(exception.getMessage());
      throw exception;`,
    `System.err.println(exception.getMessage());
      if (shouldRethrow()) {
        throw exception;
      }`,
  );
  assert.equal(
    evaluateRule("prompt/http-response-exception", workspace(conditional)),
    false,
  );

  const exhaustive = basicFlow().replace(
    `throw exception;`,
    `if (wrapException()) {
        throw new IllegalStateException("Key Vault failed", exception);
      } else {
        throw exception;
      }`,
  );
  assert.equal(
    evaluateRule("prompt/http-response-exception", workspace(exhaustive)),
    true,
  );

  const reachableSwallow = basicFlow().replace(
    "try {",
    `try {
      try {
        unrelatedWork();
      } catch (IllegalArgumentException ignored) {
        System.err.println(ignored);
      }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/http-response-exception",
      workspace(reachableSwallow),
    ),
    false,
  );

  const unreachableSwallow = basicFlow().replace(
    "class Application {",
    `class Application {
  static void neverCalled() {
    try {
      unrelatedWork();
    } catch (IllegalArgumentException ignored) {
      System.err.println(ignored);
    }
  }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/http-response-exception",
      workspace(unreachableSwallow),
    ),
    true,
  );

  const constantFalseCatch = basicFlow().replace(
    "try {",
    `try {
      if (false) {
        try {
          unrelatedWork();
        } catch (IllegalArgumentException ignored) {
          System.err.println(ignored);
        }
      }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/http-response-exception",
      workspace(constantFalseCatch),
    ),
    true,
  );
});

test("missing source and arbitrary filenames are handled semantically", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, {
        sourceFiles: [],
        buildFiles: ["pom.xml"],
        source: "",
        build: completeWorkspace.build,
      }),
      false,
      rule,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/wait-and-purge",
      workspace(basicFlow()),
    ),
    true,
  );
});

test("tri-state Java guards follow aliases, reassignment, and operators", () => {
  const guarded = (setup, condition) => basicFlow()
    .replace("try {", `${setup}
    try {
      if (${condition}) {`)
    .replace(
      "} catch (HttpResponseException exception)",
      "      }\n    } catch (HttpResponseException exception)",
    );
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      workspace(guarded("boolean enabled = false;", "enabled")),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/wait-and-purge",
      workspace(guarded("boolean enabled = externalFlag();", "enabled")),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/wait-and-purge",
      workspace(guarded(
        `Boolean disabled = Boolean.TRUE;
    var alias = disabled;
    disabled = Boolean.FALSE;`,
        "!((disabled)) && (alias || externalFlag())",
      )),
    ),
    true,
  );
});

test("Java branch joins merge boolean environments", () => {
  const joined = (left, right) => basicFlow()
    .replace(
      "try {",
      `boolean enabled = false;
    if (externalFlag()) {
      enabled = ${left};
    } else {
      enabled = ${right};
    }
    try {
      if (enabled) {`,
    )
    .replace(
      "} catch (HttpResponseException exception)",
      "      }\n    } catch (HttpResponseException exception)",
    );
  assert.equal(
    evaluateRule("prompt/wait-and-purge", workspace(joined("true", "true"))),
    true,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(joined("false", "false"))),
    false,
  );
  assert.equal(
    evaluateRule("prompt/wait-and-purge", workspace(joined("true", "false"))),
    true,
  );
});

test("Java return and throw guards constrain continuation paths", () => {
  for (const abrupt of ["return", 'throw new IllegalStateException("stop")']) {
    const source = basicFlow().replace(
      "try {",
      `try {
      boolean stop = externalFlag();
      if (stop) ${abrupt};`,
    );
    assert.equal(
      evaluateRule("prompt/wait-and-purge", workspace(source)),
      true,
      abrupt,
    );
  }

  const terminated = basicFlow({
    create: `if (externalFlag()) {
        client.setSecret("my-secret", "my-secret-value");
        KeyVaultSecret secret = client.getSecret("my-secret");
        System.out.println(secret.getValue());
        client.setSecret("my-secret", "updated-value");
        return;
      }`,
    read: "",
    output: "",
    update: "",
  });
  assert.equal(
    evaluateRule("prompt/wait-and-purge", workspace(terminated)),
    false,
  );
});

test("Gradle conditions use precedence and source-order boolean bindings", () => {
  const dependencies = `dependencies {
    implementation("com.azure:azure-identity:1.18.5")
    runtimeOnly("com.azure:azure-security-keyvault-secrets:4.11.2")
  }`;
  const passing = [
    `def disabled = true
     val alias = disabled
     disabled = false
     if (!((disabled)) && (alias || externalFlag)) { ${dependencies} }`,
    `boolean enabled = true || false && false
     if (enabled) { ${dependencies} }`,
    `Boolean enabled = Boolean.FALSE
     enabled = Boolean.TRUE
     if (enabled) { ${dependencies} }`,
    `var enabled = externalFlag
     if (enabled) { ${dependencies} }`,
  ];
  for (const build of passing) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", workspace(basicFlow(), build)),
      true,
      build,
    );
  }

  for (const declaration of ["def", "boolean", "Boolean", "var", "val"]) {
    const build = `${declaration} enabled = true
      enabled = false
      if (enabled) { ${dependencies} }`;
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", workspace(basicFlow(), build)),
      false,
      declaration,
    );
  }
});

test("known helper guard arguments control lifecycle reachability", () => {
  const source = (argument) => `${imports}
class GuardedHelperApplication {
  static void lifecycle(boolean enabled, SecretClient client) {
    if (enabled) {
      client.setSecret("my-secret", "my-secret-value");
      KeyVaultSecret secret = client.getSecret("my-secret");
      System.out.println(secret.getValue());
      client.setSecret("my-secret", "updated-value");
      SyncPoller<?, ?> poller = client.beginDeleteSecret("my-secret");
      poller.waitForCompletion();
      client.purgeDeletedSecret("my-secret");
    }
  }

  public static void main(String[] args) {
    SecretClient client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    lifecycle(${argument}, client);
  }
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
          "    lifecycle(enabled, client);",
          "    boolean enabled = false;\n    lifecycle(enabled, client);",
        ),
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule("prompt/wait-and-purge", workspace(source("externalFlag()"))),
    true,
  );
  assert.equal(
    evaluateRule("prompt/wait-and-purge", workspace(source("true"))),
    true,
  );
});

test("for loops reject false and empty literal bodies but retain unknown paths", () => {
  const looped = (header) => basicFlow()
    .replace("try {", `try {\n      ${header} {`)
    .replace(
      "} catch (HttpResponseException exception)",
      "      }\n    } catch (HttpResponseException exception)",
    );
  for (const header of [
    "for (int index = 0; false; index++)",
    "for (var item : java.util.List.of())",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", workspace(looped(header))),
      false,
      header,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/wait-and-purge",
      workspace(looped("for (var item : externalItems())")),
    ),
    true,
  );
});

test("catch operations require a potentially throwing reachable try", () => {
  const caught = (tryBody) => `${imports}
class CatchApplication {
  static void harmless() {
    int value = 1;
  }
  public static void main(String[] args) {
    SecretClient client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    try {
      ${tryBody}
    } catch (HttpResponseException exception) {
      client.setSecret("my-secret", "my-secret-value");
      KeyVaultSecret secret = client.getSecret("my-secret");
      System.out.println(secret.getValue());
      client.setSecret("my-secret", "updated-value");
      SyncPoller<?, ?> poller = client.beginDeleteSecret("my-secret");
      poller.waitForCompletion();
      client.purgeDeletedSecret("my-secret");
      throw exception;
    }
  }
}`;
  for (const body of [
    "",
    "int value = 1;",
    "if (false) { unknownOperation(); }",
    "harmless();",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", workspace(caught(body))),
      false,
      body,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/wait-and-purge",
      workspace(caught("unknownOperation();")),
    ),
    true,
  );
});

test("ternary arms cannot combine and short-circuit helpers honor reachability", () => {
  const methods = `
  static boolean prefix(SecretClient client) {
    client.setSecret("my-secret", "my-secret-value");
    KeyVaultSecret secret = client.getSecret("my-secret");
    System.out.println(secret.getValue());
    client.setSecret("my-secret", "updated-value");
    return true;
  }
  static boolean suffix(SecretClient client) {
    SyncPoller<?, ?> poller = client.beginDeleteSecret("my-secret");
    poller.waitForCompletion();
    client.purgeDeletedSecret("my-secret");
    return true;
  }
  static boolean lifecycle(SecretClient client) {
    prefix(client);
    suffix(client);
    return true;
  }`;
  const application = (statement) => `${imports}
class ConditionalApplication {
${methods}
  public static void main(String[] args) {
    SecretClient client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    ${statement}
  }
}`;
  assert.equal(
    evaluateRule(
      "prompt/wait-and-purge",
      workspace(application(
        "boolean completed = externalFlag() ? prefix(client) : suffix(client);",
      )),
    ),
    false,
  );
  for (const expression of [
    "false && lifecycle(client)",
    "true || lifecycle(client)",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/create-secret",
        workspace(application(`boolean completed = ${expression};`)),
      ),
      false,
      expression,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/wait-and-purge",
      workspace(application(
        "boolean completed = externalFlag() && lifecycle(client);",
      )),
    ),
    true,
  );
});

test("Gradle tokenization keeps operators atomic and outside strings", () => {
  const dependencies = `dependencies {
    implementation("com.azure:azure-identity:1.18.5")
    implementation("com.azure:azure-security-keyvault-secrets:4.11.2")
  }`;
  assert.equal(
    evaluateRule(
      "prompt/sdk-dependencies",
      workspace(basicFlow(), `if (false && true) { ${dependencies} }`),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/sdk-dependencies",
      workspace(
        basicFlow(),
        `def label = "false && true || false"
         if (true || false) { ${dependencies} }`,
      ),
    ),
    true,
  );
});

test("Java iterable aliases use current values and branch joins", () => {
  const looped = (setup) => basicFlow()
    .replace("try {", `${setup}\n    try {\n      for (var item : selected) {`)
    .replace(
      "} catch (HttpResponseException exception)",
      "      }\n    } catch (HttpResponseException exception)",
    );
  for (const setup of [
    "var selected = java.util.List.of();",
    `var selected = java.util.List.of(1);
    var alias = selected;
    selected = java.util.List.of();
    selected = alias;
    selected = java.util.List.of();`,
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", workspace(looped(setup))),
      false,
      setup,
    );
  }
  for (const setup of [
    "var selected = java.util.List.of();\n    selected = java.util.List.of(1);",
    `var selected = java.util.List.of(1);
    var alias = selected;
    selected = java.util.List.of();
    selected = alias;`,
    "var selected = externalItems();",
  ]) {
    assert.equal(
      evaluateRule("prompt/wait-and-purge", workspace(looped(setup))),
      true,
      setup,
    );
  }
});

test("Java forwarding overloads and folded strings retain exact values", () => {
  const source = (forwardedName) => `${imports}
class ForwardingApplication {
  static void lifecycle(SecretClient client) {
    lifecycle(client, ${forwardedName}, "my-" + "secret-value",
        "updated-" + "value");
  }
  static void lifecycle(
      SecretClient client, String name, String initial, String updated) {
    client.setSecret(name, initial);
    KeyVaultSecret secret = client.getSecret(name);
    System.out.println(secret.getValue());
    client.setSecret(name, updated);
    SyncPoller<?, ?> poller = client.beginDeleteSecret(name);
    poller.waitForCompletion();
    client.purgeDeletedSecret(name);
  }
  public static void main(String[] args) {
    SecretClient client = new SecretClientBuilder()
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    try {
      lifecycle(client);
    } catch (HttpResponseException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    }
  }
}`;
  assert.equal(
    evaluateRule(
      "prompt/wait-and-purge",
      workspace(source('"""\nmy-secret"""')),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      workspace(source('"wrong-" + dynamicPart')),
    ),
    false,
  );
});
