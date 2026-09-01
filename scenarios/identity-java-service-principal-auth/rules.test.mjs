import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  ruleNames,
} from "./tools/service-principal-java-rules.mjs";

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

const imports = `
import com.azure.core.credential.TokenCredential;
import com.azure.core.exception.ClientAuthenticationException;
import com.azure.identity.ClientSecretCredential;
import com.azure.identity.ClientSecretCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;
`;

const environment = `
String tenantId = System.getenv("AZURE_TENANT_ID");
String clientId = System.getenv("AZURE_CLIENT_ID");
String clientSecret = System.getenv("AZURE_CLIENT_SECRET");
String vaultUrl = System.getenv("AZURE_KEY_VAULT_URL");
String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
`;

const credential = `
ClientSecretCredential credential = new ClientSecretCredentialBuilder()
    .tenantId(tenantId)
    .clientId(clientId)
    .clientSecret(clientSecret)
    .build();
`;

const client = `
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl)
    .credential(credential)
    .buildClient();
`;

const validPrefix = `${imports}${environment}${credential}${client}`;

test.skip("golden passes exactly the six requested criteria", () => {
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

test.skip("golden pins Java 17 and current requested Azure SDK versions", () => {
  assert.match(
    completeWorkspace.build,
    /<maven\.compiler\.release>17<\/maven\.compiler\.release>/,
  );
  assert.match(
    completeWorkspace.build,
    /<artifactId>azure-identity<\/artifactId>\s*<version>1\.18\.5<\/version>/,
  );
  assert.match(
    completeWorkspace.build,
    /<artifactId>azure-security-keyvault-secrets<\/artifactId>\s*<version>4\.11\.2<\/version>/,
  );
});

test.skip("package rule requires both real com.azure dependencies", () => {
  for (const artifact of [
    "azure-identity",
    "azure-security-keyvault-secrets",
  ]) {
    const removed = completeWorkspace.build.replace(
      new RegExp(
        `<dependency>[\\s\\S]*?<artifactId>${artifact}<\\/artifactId>[\\s\\S]*?<\\/dependency>`,
      ),
      `<!-- com.azure:${artifact} -->`,
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

test.skip("package rule accepts exact Gradle coordinates but rejects fake groups", () => {
  const gradle = `
dependencies {
  implementation("com.azure:azure-identity:1.18.5")
  implementation 'com.azure:azure-security-keyvault-secrets:4.11.2'
}`;
  const fake = gradle.replaceAll("com.azure", "example.fake");
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace("class Main {}", gradle),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace("class Main {}", fake),
    ),
    false,
  );
});

test.skip("package rule only accepts active Maven runtime dependencies", () => {
  const dependency = (artifact, scope = "") => `
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>${artifact}</artifactId>
      ${scope ? `<scope>${scope}</scope>` : ""}
    </dependency>`;
  const accepted = `
<project><dependencies>
  ${dependency("azure-identity", "compile")}
  ${dependency("azure-security-keyvault-secrets", "runtime")}
</dependencies></project>`;
  const rejected = [
    `<project><!-- ${dependency("azure-identity")} -->
      <dependencies>${dependency("azure-security-keyvault-secrets")}</dependencies>
    </project>`,
    `<project><dependencyManagement><dependencies>
      ${dependency("azure-identity")}
      ${dependency("azure-security-keyvault-secrets")}
    </dependencies></dependencyManagement></project>`,
    `<project><dependencies>
      ${dependency("azure-identity", "test")}
      ${dependency("azure-security-keyvault-secrets")}
    </dependencies></project>`,
    `<project><dependencies>
      ${dependency("azure-identity")}
      ${dependency("azure-security-keyvault-secrets", "provided")}
    </dependencies></project>`,
    `<project><build><plugins><plugin><dependencies>
      ${dependency("azure-identity")}
      ${dependency("azure-security-keyvault-secrets")}
    </dependencies></plugin></plugins></build></project>`,
  ];
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace("class Main {}", accepted),
    ),
    true,
  );
  for (const build of rejected) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class Main {}", build),
      ),
      false,
      build,
    );
  }
});

test.skip("package rule only accepts active Gradle runtime configurations", () => {
  const accepted = [
    `dependencies {
       implementation("com.azure:azure-identity:1.18.5")
       api("com.azure:azure-security-keyvault-secrets:4.11.2")
     }`,
    `dependencies {
       runtimeOnly 'com.azure:azure-identity:1.18.5'
       implementation 'com.azure:azure-security-keyvault-secrets:4.11.2'
     }`,
  ];
  const rejected = [
    `// implementation("com.azure:azure-identity:1.18.5")
     /* runtimeOnly "com.azure:azure-security-keyvault-secrets:4.11.2" */`,
    `def prose = "implementation('com.azure:azure-identity:1.18.5')"
     def more = "api('com.azure:azure-security-keyvault-secrets:4.11.2')"`,
    `dependencies {
       testImplementation("com.azure:azure-identity:1.18.5")
       compileOnly("com.azure:azure-security-keyvault-secrets:4.11.2")
     }`,
  ];
  for (const build of accepted) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class Main {}", build),
      ),
      true,
      build,
    );
  }
  for (const build of rejected) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class Main {}", build),
      ),
      false,
      build,
    );
  }
});

test.skip("package rule respects statically active Gradle branches", () => {
  const dependencies = `
dependencies {
  implementation("com.azure:azure-identity:1.18.5")
  runtimeOnly("com.azure:azure-security-keyvault-secrets:4.11.2")
}`;
  const accepted = [
    `if (true) { ${dependencies} }`,
    `if (project.hasProperty("azure")) { ${dependencies} }`,
    `if (enabled || true) { ${dependencies} }`,
    `if (false) { dependencies {} } else { ${dependencies} }`,
  ];
  const rejected = [
    `if (false) { ${dependencies} }`,
    `if (!true) { ${dependencies} }`,
    `if (Boolean.FALSE) { ${dependencies} }`,
    `if (enabled && false) { ${dependencies} }`,
    `if (true) { dependencies {} } else { ${dependencies} }`,
  ];
  for (const build of accepted) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class Main {}", build),
      ),
      true,
      build,
    );
  }
  for (const build of rejected) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class Main {}", build),
      ),
      false,
      build,
    );
  }
});

test.skip("package rule accepts only active-by-default Maven profiles", () => {
  const dependencies = `
<dependencies>
  <dependency>
    <groupId>com.azure</groupId>
    <artifactId>azure-identity</artifactId>
  </dependency>
  <dependency>
    <groupId>com.azure</groupId>
    <artifactId>azure-security-keyvault-secrets</artifactId>
    <scope>runtime</scope>
  </dependency>
</dependencies>`;
  const profile = (activation) => `
<project><profiles><profile>
  <id>azure</id>
  ${activation}
  ${dependencies}
</profile></profiles></project>`;
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace(
        "class Main {}",
        profile(
          `<activation>
             <activeByDefault>true</activeByDefault>
             <jdk>[17,)</jdk>
           </activation>`,
        ),
      ),
    ),
    true,
  );
  for (const build of [
    profile(""),
    profile(
      "<activation><activeByDefault>false</activeByDefault></activation>",
    ),
    profile("<activation><property><name>azure</name></property></activation>"),
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("class Main {}", build),
      ),
      false,
      build,
    );
  }
});

test.skip("Maven profile activation is conjunctive for Java 17 ranges", () => {
  const dependencies = `
<dependencies>
  <dependency><groupId>com.azure</groupId><artifactId>azure-identity</artifactId></dependency>
  <dependency><groupId>com.azure</groupId><artifactId>azure-security-keyvault-secrets</artifactId></dependency>
</dependencies>`;
  const profile = (activation) =>
    `<project><profiles><profile><activation>${activation}</activation>${dependencies}</profile></profiles></project>`;
  for (const build of [
    profile("<jdk>[17,18)</jdk>"),
    profile("<activeByDefault>true</activeByDefault><jdk>[17,)</jdk>"),
  ]) {
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class Main {}", build)),
      true,
      build,
    );
  }
  for (const build of [
    profile("<activeByDefault>true</activeByDefault><jdk>[99,)</jdk>"),
    profile("<activeByDefault>false</activeByDefault><jdk>[17,18)</jdk>"),
    profile("<jdk>(17,18)</jdk>"),
  ]) {
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class Main {}", build)),
      false,
      build,
    );
  }
});

test.skip("Gradle static controls use numeric and string truthiness", () => {
  const dependencies = `dependencies {
    implementation("com.azure:azure-identity:1.18.5")
    runtimeOnly("com.azure:azure-security-keyvault-secrets:4.11.2")
  }`;
  for (const condition of ["1", "-1", "42", '"enabled"']) {
    const build = `if (${condition}) { ${dependencies} }`;
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class Main {}", build)),
      true,
      build,
    );
  }
  for (const condition of ["0", "0.0", '""']) {
    const build = `if (${condition}) { ${dependencies} }`;
    assert.equal(
      evaluateRule("prompt/identity-packages", workspace("class Main {}", build)),
      false,
      build,
    );
  }
  const inactiveElse = `if (-1) { dependencies {} } else { ${dependencies} }`;
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace("class Main {}", inactiveElse),
    ),
    false,
  );
});

test.skip("direct, aliased, and qualified environment-backed forms pass", () => {
  const direct = `
com.azure.identity.ClientSecretCredential credential =
    new com.azure.identity.ClientSecretCredentialBuilder()
        .tenantId(System.getenv("AZURE_TENANT_ID"))
        .clientId(System.getenv("AZURE_CLIENT_ID"))
        .clientSecret(System.getenv("AZURE_CLIENT_SECRET"))
        .build();
com.azure.security.keyvault.secrets.SecretClient client =
    new com.azure.security.keyvault.secrets.SecretClientBuilder()
        .vaultUrl(System.getenv("AZURE_KEY_VAULT_URL"))
        .credential(credential)
        .buildClient();
System.out.println(client.getSecret(
    System.getenv("AZURE_KEY_VAULT_SECRET_NAME")).getValue());
`;
  const aliases = `${imports}${environment}
String tenantAlias = tenantId;
String clientAlias = clientId;
String secretAlias = clientSecret;
String vaultAlias = vaultUrl;
String nameAlias = secretName;
ClientSecretCredential credential = new ClientSecretCredentialBuilder()
    .tenantId(tenantAlias)
    .clientId(clientAlias)
    .clientSecret(secretAlias)
    .build();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultAlias)
    .credential(credential)
    .buildClient();
System.err.printf("%s%n", client.getSecret(nameAlias).getValue());
`;
  for (const source of [direct, aliases]) {
    for (const rule of [
      "prompt/environment-secret-management",
      "prompt/client-secret-credential",
      "prompt/credential-client-association",
      "prompt/authenticated-operation",
    ]) {
      assert.equal(evaluateRule(rule, workspace(source)), true, rule);
    }
  }
});

test.skip("environment management rejects wrong keys, literals, defaults, and mutations", () => {
  const invalid = [
    validPrefix.replace(
      'System.getenv("AZURE_TENANT_ID")',
      'System.getenv("TENANT_ID")',
    ),
    validPrefix.replace(
      'System.getenv("AZURE_CLIENT_SECRET")',
      '"literal-secret"',
    ),
    validPrefix.replace(
      'System.getenv("AZURE_CLIENT_ID")',
      'Objects.requireNonNullElse(System.getenv("AZURE_CLIENT_ID"), "fallback")',
    ),
    validPrefix.replace(
      credential,
      `clientSecret = fallbackSecret;
${credential}`,
    ),
    validPrefix.replace(
      credential,
      `${credential}
new ClientSecretCredentialBuilder()
    .tenantId(tenantId)
    .clientId(clientId)
    .clientSecret("unsafe")
    .build();
`,
    ),
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("client secret may configure the credential but may never reach output or logs", () => {
  const safe = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());`;
  assert.equal(
    evaluateRule("prompt/environment-secret-management", workspace(safe)),
    true,
  );

  const leaks = [
    `${safe}\nSystem.out.println(clientSecret);`,
    `${safe}\nSystem.err.printf("secret=%s", clientSecret);`,
    `${safe}\nlogger.debug("secret {}", clientSecret);`,
    `${safe}\nlogger.atError().log(clientSecret);`,
    `${safe}\nLOG.log(Level.WARNING, clientSecret);`,
    `${safe}\nSystem.out.println(System.getenv("AZURE_CLIENT_SECRET"));`,
    safe.replace(
      credential,
      `String secretAlias = clientSecret;
${credential}`,
    ) + "\nlogger.info(secretAlias);",
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("client secret taint reaches sinks through one to three helpers", () => {
  const safeOperation = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());`;
  const leaks = [
    `${safeOperation}
static void expose(String value) {
  logger.debug(value);
}
expose(clientSecret);`,
    `${safeOperation}
static String first(String value) { return value; }
static String second(String value) { return first(value); }
logger.info(second(clientSecret));`,
    `${safeOperation}
static String first(String value) { return value; }
static String second(String value) { return first(value); }
static String third(String value) { return second(value); }
System.err.println(third(clientSecret));`,
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("client secret taint reaches sinks through fixed-point helper chains", () => {
  const safeOperation = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());`;
  for (const depth of [4, 16, 64]) {
    const helpers = Array.from(
      { length: depth },
      (_, index) =>
        `static String helper${index}(String value) {
           return ${index === 0 ? "value" : `helper${index - 1}(value)`};
         }`,
    ).join("\n");
    const source = `${safeOperation}
${helpers}
logger.info(helper${depth - 1}(clientSecret));`;
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      `helper depth ${depth}`,
    );
  }
});

test.skip("client secret taint follows aggregate writes and formatting", () => {
  const safeOperation = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());`;
  const leaks = [
    `${safeOperation}
var values = new java.util.ArrayList<String>();
var alias = values;
alias.add(clientSecret);
logger.info(values.toString());`,
    `${safeOperation}
static void addValue(java.util.List<String> values, String value) {
  values.add(value);
}
var values = new java.util.ArrayList<String>();
addValue(values, clientSecret);
logger.info(values);`,
    `${safeOperation}
var values = new java.util.HashMap<String, String>();
values.put("clientSecret", clientSecret);
System.err.println(values.get("clientSecret"));`,
    `${safeOperation}
String[] values = new String[1];
values[0] = clientSecret;
logger.warn(Arrays.toString(values));`,
    `${safeOperation}
String message = String.format("secret=%s", clientSecret);
logger.error(message);`,
    `${safeOperation}
String message = "secret=%s".formatted(clientSecret);
System.out.println(message);`,
    `${safeOperation}
String message = new StringBuilder().append(clientSecret).toString();
System.out.write(message.getBytes());`,
    `${safeOperation}
System.out.append(clientSecret.trim());`,
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("nested collection and field mutations propagate through helpers", () => {
  const safeOperation = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());`;
  const leaks = [
    `${safeOperation}
static void inner(State target, String value) {
  target.details.values.add(value);
}
static void outer(State target, String value) {
  inner(target, value);
}
State state = new State();
outer(state, clientSecret);
logger.error(state);`,
    `${safeOperation}
static void stash(java.util.Map<String, String> target, String value) {
  target.put("secret", value);
}
static void relay(java.util.Map<String, String> target, String value) {
  stash(target, value);
}
var payload = new java.util.HashMap<String, String>();
relay(payload, clientSecret);
System.err.println(payload);`,
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("identity and conditional pseudo-redaction remain tainted", () => {
  const safeOperation = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());`;
  const leaks = [
    `${safeOperation}
static String redact(String value) { return value; }
logger.info(redact(clientSecret));`,
    `${safeOperation}
static String redact(String value) {
  return isProduction() ? "[REDACTED]" : value;
}
logger.info(redact(clientSecret));`,
    `${safeOperation}
String output = isProduction() ? "[REDACTED]" : clientSecret;
System.err.println(output);`,
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("client secret taint follows aliases and instance or static members", () => {
  const safeOperation = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());`;
  const leaks = [
    `${safeOperation}
String firstAlias = clientSecret;
String secondAlias = firstAlias;
Secrets.value = secondAlias;
logger.debug(Secrets.value);`,
    `${safeOperation}
class Holder {
  String cached;
  void store(String value) { this.cached = value; }
  String reveal() { return this.cached; }
}
Holder holder = new Holder();
holder.store(clientSecret);
logger.info(holder.reveal());`,
    `${safeOperation}
class Secrets {
  static String cached;
  static void store(String value) { cached = value; }
  static String reveal() { return cached; }
}
Secrets.store(clientSecret);
System.out.println(Secrets.reveal());`,
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("credential wrappers and redacted or constant logging are safe", () => {
  const source = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());
static TokenCredential wrapCredential(TokenCredential value) {
  return value;
}
static String redact(String ignored) {
  return "[REDACTED]";
}
TokenCredential wrapped = wrapCredential(credential);
logger.debug(redact(clientSecret));
logger.info("credential configured");`;
  assert.equal(
    evaluateRule("prompt/environment-secret-management", workspace(source)),
    true,
  );

  const separateInstances = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());
class Holder {
  String cached;
  void store(String value) { this.cached = value; }
  String reveal() { return this.cached; }
}
Holder tainted = new Holder();
Holder clean = new Holder();
tainted.store(clientSecret);
clean.store("[REDACTED]");
logger.debug(clean.reveal());`;
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(separateInstances),
    ),
    true,
  );

  const builderWrapper = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());
static ClientSecretCredentialBuilder configureSecret(
    ClientSecretCredentialBuilder builder, String secret) {
  return builder.clientSecret(secret);
}
static String redact(String ignored) {
  return "[REDACTED]";
}
ClientSecretCredentialBuilder wrappedBuilder = configureSecret(
    new ClientSecretCredentialBuilder(), clientSecret);
logger.info(redact(clientSecret));`;
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(builderWrapper),
    ),
    true,
  );
});

test.skip("allocation identity preserves aliases, nested edges, and cycles", () => {
  const safeOperation = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());`;
  const leaks = [
    `${safeOperation}
Node original = new Node();
Node alias = original;
alias.value = clientSecret;
logger.error("{}", original);`,
    `${safeOperation}
static void store(Node target, String value) {
  target.value = value;
}
static void relay(Node target, String value) {
  store(target, value);
}
Node original = new Node();
Node alias = original;
relay(alias, clientSecret);
System.err.println(original);`,
    `${safeOperation}
class Node {
  String value;
  void store(String value) { this.value = value; }
}
Node original = new Node();
Node alias = original;
alias.store(clientSecret);
logger.warn("{}", original);`,
    `${safeOperation}
Node root = new Node();
root.child = new Node();
root.child.values = new java.util.ArrayList<String>();
root.child.values.add(clientSecret);
logger.info("{}", root);`,
    `${safeOperation}
Node first = new Node();
Node second = new Node();
first.child = second;
second.child = first;
first.value = clientSecret;
System.out.println(second);`,
    `${safeOperation}
Node root = new Node();
root.child = new Node();
Node retained = root.child;
retained.value = clientSecret;
root.child = new Node();
logger.debug("{}", retained);`,
  ];
  for (const source of leaks) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("allocation identity isolates objects and rebinding or replacement", () => {
  const safeOperation = `${validPrefix}
System.out.println(client.getSecret(secretName).getValue());`;
  const safe = [
    `${safeOperation}
Node tainted = new Node();
Node clean = new Node();
tainted.value = clientSecret;
logger.info("{}", clean);`,
    `${safeOperation}
Node original = new Node();
Node alias = original;
alias = new Node();
alias.value = clientSecret;
System.out.println(original);`,
    `${safeOperation}
Node root = new Node();
root.child = new Node();
root.child.value = clientSecret;
root.child = new Node();
logger.warn("{}", root);`,
    `${safeOperation}
static void rebind(Node target, String value) {
  target = new Node();
  target.value = value;
}
Node original = new Node();
rebind(original, clientSecret);
System.out.println(original);`,
  ];
  for (const source of safe) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      true,
      source,
    );
  }
});

test.skip("complete fluent, split, aliased, and var credential builders pass", () => {
  const candidates = [
    `${imports}${environment}${credential}`,
    `${imports}${environment}
ClientSecretCredentialBuilder builder = new ClientSecretCredentialBuilder();
builder.tenantId(tenantId);
builder.clientId(clientId);
builder.clientSecret(clientSecret);
ClientSecretCredential built = builder.build();`,
    `${imports}${environment}
ClientSecretCredentialBuilder original =
    new ClientSecretCredentialBuilder().tenantId(tenantId);
ClientSecretCredentialBuilder alias = original;
alias.clientId(clientId);
original.clientSecret(clientSecret);
TokenCredential built = alias.build();`,
    `${imports}${environment}
var builder = new ClientSecretCredentialBuilder();
builder.tenantId(tenantId).clientId(clientId);
var built = builder.clientSecret(clientSecret).build();`,
  ];
  for (const source of candidates) {
    assert.equal(
      evaluateRule("prompt/client-secret-credential", workspace(source)),
      true,
      source,
    );
  }
});

test.skip("incomplete, overwritten, and shadowed credential builders fail", () => {
  const invalid = [
    `${imports}${environment}
ClientSecretCredential credential = new ClientSecretCredentialBuilder()
    .tenantId(tenantId).clientId(clientId).build();`,
    `${imports}${environment}
ClientSecretCredentialBuilder builder = new ClientSecretCredentialBuilder()
    .tenantId(tenantId).clientId(clientId).clientSecret(clientSecret);
builder = new ClientSecretCredentialBuilder();
ClientSecretCredential credential = builder.build();`,
    `${imports}${environment}
ClientSecretCredentialBuilder builder = new ClientSecretCredentialBuilder()
    .tenantId(tenantId).clientId(clientId).clientSecret(clientSecret);
{
  ClientSecretCredentialBuilder builder = new ClientSecretCredentialBuilder();
  ClientSecretCredential credential = builder.build();
}`,
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/client-secret-credential", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("fake imports and qualified fake Azure-like types fail", () => {
  const fakeImport = validPrefix.replaceAll(
    "com.azure.identity",
    "example.fake.identity",
  );
  const fakeQualified = validPrefix
    .replace(
      "new ClientSecretCredentialBuilder()",
      "new example.fake.ClientSecretCredentialBuilder()",
    )
    .replace(
      "new SecretClientBuilder()",
      "new example.fake.SecretClientBuilder()",
    );
  for (const source of [fakeImport, fakeQualified]) {
    assert.equal(
      evaluateRule("prompt/client-secret-credential", workspace(source)),
      false,
    );
    assert.equal(
      evaluateRule("prompt/credential-client-association", workspace(source)),
      false,
    );
  }
});

test.skip("real imports cannot legitimize nested same-name Azure shadows", () => {
  const credentialShadow = `${imports}
class Main {
  static class ClientSecretCredentialBuilder {}
  void run() {
    ${environment}
    ${credential}
  }
}`;
  const builderShadow = `${imports}
class Main {
  static class SecretClientBuilder {}
  void run() {
    ${environment}
    ${credential}
    ${client}
  }
}`;
  const clientShadow = `${imports}
class Main {
  static class SecretClient {}
  void run() {
    ${environment}
    ${credential}
    ${client}
  }
}`;
  assert.equal(
    evaluateRule(
      "prompt/client-secret-credential",
      workspace(credentialShadow),
    ),
    false,
  );
  const localCredentialShadow = `${imports}
class Main {
  void run() {
    class ClientSecretCredentialBuilder {}
    ${environment}
    ${credential}
  }
}`;
  assert.equal(
    evaluateRule(
      "prompt/client-secret-credential",
      workspace(localCredentialShadow),
    ),
    false,
  );
  for (const source of [builderShadow, clientShadow]) {
    assert.equal(
      evaluateRule(
        "prompt/credential-client-association",
        workspace(source),
      ),
      false,
      source,
    );
  }

  const exceptionShadow = `${imports}
class Main {
  static class ClientAuthenticationException extends RuntimeException {}
  void run() {
    ${environment}
    ${credential}
    ${client}
    try {
      System.out.println(client.getSecret(secretName).getValue());
    } catch (ClientAuthenticationException failure) {
      throw failure;
    }
  }
}`;
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(exceptionShadow)),
    false,
  );

  const conflictingImport = validPrefix.replace(
    "import com.azure.identity.ClientSecretCredentialBuilder;",
    `import com.azure.identity.ClientSecretCredentialBuilder;
import example.fake.ClientSecretCredentialBuilder;`,
  );
  assert.equal(
    evaluateRule(
      "prompt/client-secret-credential",
      workspace(conflictingImport),
    ),
    false,
  );
});

test.skip("fully qualified Azure use sites survive unrelated same-name shadows", () => {
  const source = `${imports}
class Main {
  static class ClientSecretCredentialBuilder {}
  static class SecretClientBuilder {}
  static class SecretClient {}
  static class ClientAuthenticationException extends RuntimeException {}

  void run() {
    ${environment}
    com.azure.identity.ClientSecretCredential credential =
        new com.azure.identity.ClientSecretCredentialBuilder()
            .tenantId(tenantId)
            .clientId(clientId)
            .clientSecret(clientSecret)
            .build();
    com.azure.security.keyvault.secrets.SecretClient client =
        new com.azure.security.keyvault.secrets.SecretClientBuilder()
            .vaultUrl(vaultUrl)
            .credential(credential)
            .buildClient();
    try {
      System.out.println(client.getSecret(secretName).getValue());
    } catch (com.azure.core.exception.ClientAuthenticationException failure) {
      throw failure;
    }
  }
}`;
  for (const rule of [
    "prompt/client-secret-credential",
    "prompt/credential-client-association",
    "prompt/authenticated-operation",
    "prompt/authentication-errors",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("client association follows split builders and credential aliases", () => {
  const source = `${imports}${environment}${credential}
TokenCredential credentialAlias = credential;
SecretClientBuilder original = new SecretClientBuilder();
original.vaultUrl(vaultUrl);
SecretClientBuilder alias = original;
alias.credential(credentialAlias);
SecretClient associated = alias.buildClient();`;
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(source)),
    true,
  );
});

test.skip("client association rejects wrong URL, credential, and overwritten bindings", () => {
  const invalid = [
    `${imports}${environment}${credential}
SecretClient client = new SecretClientBuilder()
    .vaultUrl(otherUrl).credential(credential).buildClient();`,
    `${imports}${environment}${credential}
TokenCredential other = customCredential();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl).credential(other).buildClient();`,
    `${imports}${environment}${credential}
credential = customCredential();
SecretClient client = new SecretClientBuilder()
    .vaultUrl(vaultUrl).credential(credential).buildClient();`,
    `${imports}${environment}${credential}
SecretClientBuilder builder = new SecretClientBuilder()
    .vaultUrl(vaultUrl).credential(credential);
builder = new SecretClientBuilder();
SecretClient client = builder.buildClient();`,
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/credential-client-association", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("typed instance fields and local aliases preserve connected operations", () => {
  const source = `${imports}
class VaultReader {
  private SecretClient client;

  void configure() {
    ${environment}
    ${credential}
    SecretClientBuilder builder = new SecretClientBuilder();
    builder.vaultUrl(vaultUrl);
    SecretClientBuilder alias = builder;
    alias.credential(credential);
    this.client = alias.buildClient();
  }

  void print() {
    String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
    SecretClient local = this.client;
    KeyVaultSecret secret = local.getSecret(secretName);
    String value = secret.getValue();
    System.out.println(value);
  }
}`;
  assert.equal(
    evaluateRule("prompt/credential-client-association", workspace(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", workspace(source)),
    true,
  );
});

test.skip("credential and client builders may be configured through this fields", () => {
  const source = `${imports}
class VaultReader {
  private ClientSecretCredentialBuilder credentialBuilder;
  private ClientSecretCredential credential;
  private SecretClientBuilder clientBuilder;
  private SecretClient client;

  void configure() {
    ${environment}
    this.credentialBuilder = new ClientSecretCredentialBuilder();
    this.credentialBuilder.tenantId(tenantId);
    this.credentialBuilder.clientId(clientId);
    this.credentialBuilder.clientSecret(clientSecret);
    this.credential = this.credentialBuilder.build();
    this.clientBuilder = new SecretClientBuilder();
    this.clientBuilder.vaultUrl(vaultUrl);
    this.clientBuilder.credential(this.credential);
    this.client = this.clientBuilder.buildClient();
  }

  void print() {
    String secretName = System.getenv("AZURE_KEY_VAULT_SECRET_NAME");
    System.out.println(this.client.getSecret(secretName).getValue());
  }
}`;
  for (const rule of [
    "prompt/client-secret-credential",
    "prompt/credential-client-association",
    "prompt/authenticated-operation",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("operation must call associated getSecret and print its returned value", () => {
  const accepted = [
    `${validPrefix}
System.out.printf("%s%n", client.getSecret(secretName).getValue());`,
    `${validPrefix}
KeyVaultSecret secret = client.getSecret(secretName);
KeyVaultSecret alias = secret;
String value = alias.getValue();
String output = value;
System.err.println(output);`,
  ];
  for (const source of accepted) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      true,
    );
  }

  const rejected = [
    `${validPrefix}\nclient.getSecret(secretName);`,
    `${validPrefix}\nSystem.out.println("retrieved");`,
    `${validPrefix}\nSystem.out.println(client.getSecret(otherName).getValue());`,
    `${validPrefix}
SecretClient disconnected = otherClient();
System.out.println(disconnected.getSecret(secretName).getValue());`,
    `${validPrefix}
KeyVaultSecret secret = client.getSecret(secretName);
secret = otherClient().getSecret(secretName);
System.out.println(secret.getValue());`,
    `${validPrefix}
String value = client.getSecret(secretName).getValue();
value += "-changed";
System.out.println(value);`,
  ];
  for (const source of rejected) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("operation provenance is lexical, typed, and source ordered", () => {
  const rejected = [
    `${imports}
System.out.println(secret.getValue());
${environment}${credential}${client}
KeyVaultSecret secret = client.getSecret(secretName);`,
    `${validPrefix}
{
  SecretClient client = otherClient();
  System.out.println(client.getSecret(secretName).getValue());
}`,
    `${validPrefix}
client = otherClient();
System.out.println(client.getSecret(secretName).getValue());`,
    `${validPrefix}
String secret = client.getSecret(secretName);
System.out.println(secret);`,
  ];
  for (const source of rejected) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("connected useful ClientAuthenticationException handling passes", () => {
  const handlers = [
    `catch (ClientAuthenticationException failure) {
       System.err.println(failure.getMessage());
     }`,
    `catch (com.azure.core.exception.ClientAuthenticationException failure) {
       logger.error("authentication failed", failure);
     }`,
    `catch (ClientAuthenticationException failure) {
       throw new IllegalStateException("authentication failed", failure);
     }`,
  ];
  for (const handler of handlers) {
    const source = `${validPrefix}
try {
  System.out.println(client.getSecret(secretName).getValue());
} ${handler}`;
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      true,
      handler,
    );
  }
});

test.skip("authentication catch must be authentic, useful, and connected", () => {
  const rejected = [
    `${validPrefix}
try { client.getSecret(secretName); }
catch (ClientAuthenticationException failure) {}`,
    `${validPrefix}
try { client.getSecret(secretName); }
catch (ClientAuthenticationException failure) {
  System.err.println("authentication failed");
}`,
    `${validPrefix}
try { client.getSecret(secretName); }
catch (ClientAuthenticationException failure) {
  throw new IllegalStateException(failure.getMessage());
}`,
    `${validPrefix}
client.getSecret(secretName);
try { unrelatedWork(); }
catch (ClientAuthenticationException failure) { throw failure; }`,
    validPrefix.replace(
      "import com.azure.core.exception.ClientAuthenticationException;",
      "import example.fake.ClientAuthenticationException;",
    ) + `
try { client.getSecret(secretName); }
catch (ClientAuthenticationException failure) { throw failure; }`,
  ];
  for (const source of rejected) {
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("unrelated catches must preserve their failures on every branch", () => {
  const prefix = `${validPrefix}
try { client.getSecret(secretName); }
catch (ClientAuthenticationException failure) {
  System.err.println(failure.getMessage());
}`;
  const unsafe = [
    `catch (IllegalStateException failure) {}`,
    `catch (IllegalStateException failure) {
       logger.error("lost", failure);
     }`,
    `catch (IllegalStateException failure) {
       if (shouldPropagate()) throw failure;
     }`,
    `catch (IllegalStateException failure) {
       return;
     }`,
    `catch (IllegalStateException failure) {
       throw new RuntimeException(failure.getMessage());
     }`,
  ];
  for (const handler of unsafe) {
    const source = `${prefix}
try { unrelatedWork(); } ${handler}`;
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      false,
      handler,
    );
  }

  const safe = [
    `catch (IllegalStateException failure) { throw failure; }`,
    `catch (IllegalStateException failure) {
       if (shouldWrap()) {
         throw new RuntimeException("wrapped", failure);
       } else {
         throw failure;
       }
     }`,
    `catch (IllegalStateException failure) {
       RuntimeException alias = failure;
       throw alias;
     }`,
  ];
  for (const handler of safe) {
    const source = `${prefix}
try { unrelatedWork(); } ${handler}`;
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      true,
      handler,
    );
  }
});

test.skip("multi-catches containing unrelated failures must remain causal", () => {
  const unsafe = `${validPrefix}
try { client.getSecret(secretName); }
catch (ClientAuthenticationException | java.io.IOException failure) {
  System.err.println(failure.getMessage());
}`;
  const safe = unsafe.replace(
    "System.err.println(failure.getMessage());",
    'throw new RuntimeException("operation failed", failure);',
  );
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(unsafe)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(safe)),
    true,
  );
});

test.skip("loop and labeled control paths cannot hide swallowed catches", () => {
  const prefix = `${validPrefix}
try { client.getSecret(secretName); }
catch (ClientAuthenticationException auth) {
  throw new IllegalStateException("auth", auth);
}
try { unrelatedWork(); }
catch (IllegalStateException failure) `;
  const unsafe = [
    `{ while (retry()) { return; } throw failure; }`,
    `{ for (int i = 0; i < count; i++) {
         if (stop(i)) return;
       }
       throw failure;
     }`,
    `{ do { return; } while (false); throw failure; }`,
    `{ while (retry()) { break missing; } throw failure; }`,
    `{ while (true) continue; }`,
  ];
  for (const handler of unsafe) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        workspace(`${prefix}${handler}`),
      ),
      false,
      handler,
    );
  }

  const safe = [
    `{ retry: while (retry()) { break retry; } throw failure; }`,
    `{ block: { if (stop()) break block; } throw failure; }`,
    `{ while (false) return; throw failure; }`,
    `{ for (;;) { throw failure; } }`,
  ];
  for (const handler of safe) {
    assert.equal(
      evaluateRule(
        "prompt/authentication-errors",
        workspace(`${prefix}${handler}`),
      ),
      true,
      handler,
    );
  }
});

test.skip("comments, strings, and prose cannot satisfy source criteria", () => {
  const source = `
// ClientSecretCredential credential = new ClientSecretCredentialBuilder()
//   .tenantId(tenantId).clientId(clientId).clientSecret(secret).build();
String fake = "new SecretClientBuilder().credential(credential).buildClient();";
String operation = "client.getSecret(secretName).getValue()";
String handler = "catch (ClientAuthenticationException e) { throw e; }";
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
