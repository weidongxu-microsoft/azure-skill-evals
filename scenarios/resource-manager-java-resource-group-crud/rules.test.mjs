import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadJavaWorkspace } from "../../languages/java/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/resource-manager-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);

const run33358499457Build = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.example</groupId>
    <artifactId>azure-resource-group-manager</artifactId>
    <version>1.0.0</version>

    <properties>
        <maven.compiler.release>17</maven.compiler.release>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>com.azure.resourcemanager</groupId>
            <artifactId>azure-resourcemanager</artifactId>
            <version>2.63.0</version>
        </dependency>
        <dependency>
            <groupId>com.azure</groupId>
            <artifactId>azure-identity</artifactId>
            <version>1.18.5</version>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-compiler-plugin</artifactId>
                <version>3.13.0</version>
            </plugin>
            <plugin>
                <groupId>org.codehaus.mojo</groupId>
                <artifactId>exec-maven-plugin</artifactId>
                <version>3.5.0</version>
                <configuration>
                    <mainClass>com.example.ResourceGroupManager</mainClass>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>`;

const run33358499457Source = `package com.example;

import com.azure.core.exception.HttpResponseException;
import com.azure.core.management.AzureEnvironment;
import com.azure.core.management.exception.ManagementException;
import com.azure.core.management.profile.AzureProfile;
import com.azure.core.util.polling.SyncPoller;
import com.azure.identity.DefaultAzureCredential;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.resourcemanager.AzureResourceManager;
import com.azure.resourcemanager.resources.fluentcore.model.Accepted;
import com.azure.resourcemanager.resources.models.ResourceGroup;

public final class ResourceGroupManager {
    private ResourceGroupManager() {
    }

    public static void main(String[] args) {
        String subscriptionId = requiredEnvironmentVariable("AZURE_SUBSCRIPTION_ID");
        String resourceGroupName = requiredEnvironmentVariable("RESOURCE_GROUP_NAME");
        String location = requiredEnvironmentVariable("AZURE_LOCATION");

        AzureProfile profile = new AzureProfile(AzureEnvironment.AZURE);
        DefaultAzureCredential credential = new DefaultAzureCredentialBuilder().build();

        try {
            AzureResourceManager azure = AzureResourceManager
                    .authenticate(credential, profile)
                    .withSubscription(subscriptionId);

            ResourceGroup createdGroup = azure.resourceGroups()
                    .define(resourceGroupName)
                    .withRegion(location)
                    .create();
            System.out.println("Created resource group: " + createdGroup);

            System.out.println("Resource groups:");
            for (ResourceGroup resourceGroup : azure.resourceGroups().list()) {
                System.out.println(resourceGroup);
            }

            ResourceGroup retrievedGroup = azure.resourceGroups().getByName(resourceGroupName);
            if (retrievedGroup == null) {
                throw new IllegalStateException(
                        "Resource group was not found after creation: " + resourceGroupName);
            }
            System.out.println("Retrieved resource group: " + retrievedGroup);

            ResourceGroup updatedGroup = retrievedGroup.update()
                    .withTag("environment", "development")
                    .apply();
            System.out.println("Updated resource group: " + updatedGroup);

            Accepted<Void> deletionOperation =
                    azure.resourceGroups().beginDeleteByName(resourceGroupName);
            SyncPoller<Void, Void> deletionPoller = deletionOperation.getSyncPoller();
            deletionPoller.waitForCompletion();
            System.out.println("Deleted resource group: " + resourceGroupName);
        } catch (ManagementException exception) {
            System.err.printf(
                    "Azure resource management request failed (status %d): %s%n",
                    exception.getResponse() == null ? -1 : exception.getResponse().getStatusCode(),
                    exception.getMessage());
            throw exception;
        } catch (HttpResponseException exception) {
            System.err.printf(
                    "Azure HTTP request failed (status %d): %s%n",
                    exception.getResponse() == null ? -1 : exception.getResponse().getStatusCode(),
                    exception.getMessage());
            throw exception;
        }
    }

    private static String requiredEnvironmentVariable(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(
                    "Required environment variable is missing or blank: " + name);
        }
        return value;
    }
}`;

const imports = `
import com.azure.core.exception.HttpResponseException;
import com.azure.core.management.AzureEnvironment;
import com.azure.core.management.exception.ManagementException;
import com.azure.core.management.profile.AzureProfile;
import com.azure.core.util.polling.SyncPoller;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.resourcemanager.AzureResourceManager;
import com.azure.resourcemanager.resources.fluentcore.model.Accepted;
import com.azure.resourcemanager.resources.models.ResourceGroup;
`;

function workspace(source, build = golden.build, buildFile = "pom.xml") {
  return {
    sourceFiles: ["ArbitraryApplication.java"],
    buildFiles: [buildFile],
    source,
    build,
  };
}

function application(overrides = {}) {
  const environment = overrides.environment ?? `
    String subscription = System.getenv("AZURE_SUBSCRIPTION_ID");
    String name = System.getenv("RESOURCE_GROUP_NAME");
    String location = System.getenv("AZURE_LOCATION");`;
  const authentication = overrides.authentication ?? `
    var credential = new DefaultAzureCredentialBuilder().build();
    var profile = new AzureProfile(AzureEnvironment.AZURE);
    AzureResourceManager azure = AzureResourceManager
        .authenticate(credential, profile)
        .withSubscription(subscription);`;
  const create = overrides.create ?? `
      azure.resourceGroups().define(name).withRegion(location).create();`;
  const list = overrides.list ?? `
      for (ResourceGroup group : azure.resourceGroups().list()) {
        System.out.println(group.name());
      }`;
  const get = overrides.get ?? `
      ResourceGroup found = azure.resourceGroups().getByName(name);
      System.out.println(found.id());`;
  const update = overrides.update ?? `
      ResourceGroup updated = found.update()
          .withTag("environment", "development").apply();
      System.out.println(updated.tags());`;
  const remove = overrides.remove ?? `
      azure.resourceGroups().deleteByName(name);`;
  const confirmation = overrides.confirmation ?? `
      System.out.println("Deleted resource group " + name);`;
  const catches = overrides.catches ?? `
    } catch (ManagementException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    }`;
  return `${imports}
class Application {
  public static void main(String[] args) {
    ${environment}
    ${authentication}
    try {
      ${create}
      ${list}
      ${get}
      ${update}
      ${remove}
      ${confirmation}
    ${catches}
  }
}`;
}

test("the Java 17 golden application passes exactly nine graders", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test("Vally run 33358499457 final workspace passes every grader", () => {
  const run33358499457 = workspace(
    run33358499457Source,
    run33358499457Build,
  );
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, run33358499457), true, rule);
  }
});

test("all graders require generated Java source", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, { ...golden, sourceFiles: [], source: "" }),
      false,
      rule,
    );
  }
});

test("listing accepts direct output of only the SDK loop resource group", () => {
  const direct = application({
    list: `
      for (ResourceGroup group : azure.resourceGroups().list()) {
        System.out.println(group);
      }`,
  });
  assert.equal(
    evaluateRule("prompt/list-resource-groups", workspace(direct)),
    true,
  );

  const arbitrary = application({
    list: `
      Object unrelated = new Object();
      for (ResourceGroup group : azure.resourceGroups().list()) {
        System.out.println(unrelated);
      }`,
  });
  assert.equal(
    evaluateRule("prompt/list-resource-groups", workspace(arbitrary)),
    false,
  );
});

test("source manifest accepts active Java 17 Maven and Gradle runtime pins", () => {
  const maven = `<project>
    <packaging>jar</packaging>
    <properties>
      <maven.compiler.source>17</maven.compiler.source>
      <maven.compiler.target>17</maven.compiler.target>
      <identity.version>1.18.5</identity.version>
      <arm.version>2.63.0</arm.version>
    </properties>
    <dependencies>
      <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-identity</artifactId>
        <version>\${identity.version}</version>
      </dependency>
      <dependency>
        <groupId>com.azure.resourcemanager</groupId>
        <artifactId>azure-resourcemanager</artifactId>
        <version>\${arm.version}</version>
        <scope>runtime</scope>
      </dependency>
    </dependencies>
  </project>`;
  const gradle = `plugins { id("java") }
    java {
      toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
      }
    }
    dependencies {
      implementation("com.azure:azure-identity:1.18.5")
      runtimeOnly("com.azure.resourcemanager:azure-resourcemanager:2.63.0")
    }`;

  assert.equal(
    evaluateRule("prompt/source-manifest", workspace(application(), maven)),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/source-manifest",
      workspace(application(), gradle, "build.gradle.kts"),
    ),
    true,
  );
});

test("source manifest rejects inactive, nonruntime, split, wrong, and decoy pins", () => {
  const dependency = (group, artifact, version, scope = "") => `
    <dependency>
      <groupId>${group}</groupId><artifactId>${artifact}</artifactId>
      <version>${version}</version>${scope ? `<scope>${scope}</scope>` : ""}
    </dependency>`;
  const both = `
    ${dependency("com.azure", "azure-identity", "1.18.5")}
    ${dependency(
      "com.azure.resourcemanager",
      "azure-resourcemanager",
      "2.63.0",
    )}`;
  for (const build of [
    `<project><properties><maven.compiler.release>21</maven.compiler.release></properties><dependencies>${both}</dependencies></project>`,
    `<project><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencyManagement><dependencies>${both}</dependencies></dependencyManagement></project>`,
    `<project><packaging>pom</packaging><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies>${both}</dependencies></project>`,
    `<project><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies>
       ${dependency("com.azure", "azure-identity", "1.18.5", "test")}
       ${dependency("com.azure.resourcemanager", "azure-resourcemanager", "2.63.0")}
     </dependencies></project>`,
    `<project><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies>
       ${dependency("com.azure", "azure-identity", "1.18.5")}
     </dependencies></project>
     <project><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies>
       ${dependency("com.azure.resourcemanager", "azure-resourcemanager", "2.63.0")}
     </dependencies></project>`,
    `<project><properties><maven.compiler.release>17</maven.compiler.release></properties><!-- <dependencies>${both}</dependencies> --></project>`,
    `java { sourceCompatibility = JavaVersion.VERSION_17 }
     dependencies {
       testImplementation("com.azure:azure-identity:1.18.5")
       compileOnly("com.azure.resourcemanager:azure-resourcemanager:2.63.0")
     }`,
    `java { sourceCompatibility = JavaVersion.VERSION_17 }
     // implementation("com.azure:azure-identity:1.18.5")
     // implementation("com.azure.resourcemanager:azure-resourcemanager:2.63.0")`,
  ]) {
    assert.equal(
      evaluateRule("prompt/source-manifest", workspace(application(), build)),
      false,
      build,
    );
  }
});

test("delete rejects completion through a poller from another manager", () => {
  const unrelated = application({
    remove: `
      Accepted<Void> deletion =
          azure.resourceGroups().beginDeleteByName(name);
      AzureResourceManager otherAzure = AzureResourceManager
          .authenticate(credential, profile)
          .withSubscription(subscription);
      Accepted<Void> unrelatedDeletion =
          otherAzure.resourceGroups().beginDeleteByName(name);
      SyncPoller<Void, Void> poller =
          unrelatedDeletion.getSyncPoller();
      poller.waitForCompletion();`,
  });
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(unrelated)),
    false,
  );
});

test("qualified SDK types, aliases, fields, and reachable helpers pass", () => {
  const source = `
import com.azure.core.exception.HttpResponseException;
import com.azure.core.management.exception.ManagementException;
import com.azure.resourcemanager.resources.fluentcore.model.Accepted;
import com.azure.resourcemanager.resources.models.ResourceGroup;
class AlternateApplication {
  private static final String SUB =
      requireEnvironment("AZURE_SUBSCRIPTION_ID");
  private static final String NAME =
      requireEnvironment("RESOURCE_GROUP_NAME");
  private static final String REGION =
      requireEnvironment("AZURE_LOCATION");

  static String requireEnvironment(String key) {
    return System.getenv(key);
  }

  static com.azure.resourcemanager.AzureResourceManager manager() {
    var builder = new com.azure.identity.DefaultAzureCredentialBuilder();
    var credentialAlias = builder.build();
    var profileAlias = new com.azure.core.management.profile.AzureProfile(
        com.azure.core.management.AzureEnvironment.AZURE);
    var authenticated = com.azure.resourcemanager.AzureResourceManager
        .authenticate(credentialAlias, profileAlias);
    return authenticated.withSubscription(SUB);
  }

  static void lifecycle(
      com.azure.resourcemanager.AzureResourceManager supplied) {
    var azure = supplied;
    try {
      var definition = azure.resourceGroups().define(NAME);
      definition.withRegion(REGION);
      definition.create();
      var groups = azure.resourceGroups();
      for (ResourceGroup group : groups.list()) {
        System.out.printf("group=%s%n", group.name());
      }
      var found = groups.getByName(NAME);
      System.out.println(found.id());
      var update = found.update();
      update.withTag("environment", "development");
      var result = update.apply();
      System.out.println(result.tags());
      Accepted<Void> deletion = groups.beginDeleteByName(NAME);
      var poller = deletion.getSyncPoller();
      poller.waitForCompletion();
      System.out.println("Deletion completed for " + NAME);
    } catch (ManagementException | IllegalStateException exception) {
      System.err.println(exception);
      throw exception;
    } catch (HttpResponseException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    }
  }

  public static void main(String[] args) {
    lifecycle(manager());
  }
}`;
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("wrong imports and local SDK shadows cannot authenticate", () => {
  for (const source of [
    application().replace(
      "import com.azure.resourcemanager.AzureResourceManager;",
      "import example.AzureResourceManager;",
    ),
    application().replace(
      "class Application {",
      "class AzureResourceManager { static Object authenticate(Object a, Object b) { return null; } }\nclass Application {",
    ),
    application().replace(
      "new AzureProfile(AzureEnvironment.AZURE)",
      "new AzureProfile(null)",
    ),
    application().replace(
      '.withSubscription(subscription)',
      '.withDefaultSubscription()',
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/authentication", workspace(source)),
      false,
      source,
    );
  }
});

test("SDK result declarations reject conflicting and shadowed types", () => {
  const wrongCredentialType = application().replace(
    "var credential = new DefaultAzureCredentialBuilder().build();",
    "Object credential = new DefaultAzureCredentialBuilder().build();",
  );
  assert.equal(
    evaluateRule("prompt/authentication", workspace(wrongCredentialType)),
    false,
  );

  const wrongResultType = application().replace(
    "ResourceGroup found = azure.resourceGroups().getByName(name);",
    "Object found = azure.resourceGroups().getByName(name);",
  );
  assert.equal(
    evaluateRule("prompt/get-resource-group", workspace(wrongResultType)),
    false,
  );

  const shadowedLoopType = application().replace(
    "class Application {",
    "class ResourceGroup { String name() { return \"fake\"; } }\nclass Application {",
  );
  assert.equal(
    evaluateRule(
      "prompt/list-resource-groups",
      workspace(shadowedLoopType),
    ),
    false,
  );
});

test("wrong environment sources, name, subscription, and region fail", () => {
  const cases = [
    [
      "prompt/authentication",
      application().replace(
        'System.getenv("AZURE_SUBSCRIPTION_ID")',
        'System.getenv("OTHER_SUBSCRIPTION")',
      ),
    ],
    [
      "prompt/create-resource-group",
      application().replace(
        'System.getenv("RESOURCE_GROUP_NAME")',
        '"decoy-name"',
      ),
    ],
    [
      "prompt/create-resource-group",
      application().replace(
        'System.getenv("AZURE_LOCATION")',
        '"westus"',
      ),
    ],
  ];
  for (const [rule, source] of cases) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test("fake, unreachable, and disconnected create operations fail", () => {
  for (const source of [
    application({ create: "fake.define(name).withRegion(location).create();" }),
    application({
      create:
        "if (false) { azure.resourceGroups().define(name).withRegion(location).create(); }",
    }),
    application({
      create:
        'azure.resourceGroups().define(name).withRegion("westus").create();',
    }),
  ]) {
    assert.equal(
      evaluateRule("prompt/create-resource-group", workspace(source)),
      false,
    );
  }
});

test("listing must iterate and output the SDK result in lifecycle order", () => {
  for (const list of [
    "azure.resourceGroups().list();",
    "System.out.println(azure.resourceGroups().list());",
    "for (ResourceGroup group : java.util.List.of()) { System.out.println(group.name()); }",
    "for (ResourceGroup group : azure.resourceGroups().list()) { }",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/list-resource-groups",
        workspace(application({ list })),
      ),
      false,
      list,
    );
  }
});

test("get must use the same name and print the retrieved result", () => {
  for (const get of [
    'ResourceGroup found = azure.resourceGroups().getByName("other"); System.out.println(found.id());',
    "ResourceGroup found = azure.resourceGroups().getByName(name);",
    "ResourceGroup found = azure.resourceGroups().getByName(name); System.out.println(name);",
  ]) {
    assert.equal(
      evaluateRule("prompt/get-resource-group", workspace(application({ get }))),
      false,
      get,
    );
  }
});

test("update requires retrieved receiver, exact tag, apply, and result output", () => {
  for (const update of [
    'ResourceGroup updated = found.update().withTag("environment", "production").apply(); System.out.println(updated.tags());',
    'found.update().withTag("environment", "development"); System.out.println(found.tags());',
    'ResourceGroup updated = fake.update().withTag("environment", "development").apply(); System.out.println(updated.tags());',
    'ResourceGroup updated = found.update().withTag("environment", "development").apply(); System.out.println(found.tags());',
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/update-resource-group",
        workspace(application({ update })),
      ),
      false,
      update,
    );
  }
});

test("delete accepts blocking delete or completion of the exact accepted operation poller", () => {
  const poller = application({
    remove: `
      Accepted<Void> deletion =
          azure.resourceGroups().beginDeleteByName(name);
      SyncPoller<Void, Void> poller = deletion.getSyncPoller();
      poller.waitForCompletion();`,
  });
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(poller)),
    true,
  );

  const chained = application({
    remove: `
      azure.resourceGroups().beginDeleteByName(name)
          .getSyncPoller().waitForCompletion();`,
  });
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(chained)),
    true,
  );

  for (const remove of [
    "azure.resourceGroups().beginDeleteByName(name);",
    "Accepted<Void> deletion = azure.resourceGroups().beginDeleteByName(name); deletion.getSyncPoller();",
    "var deletion = azure.resourceGroups().beginDeleteByName(name); deletion.waitForCompletion();",
    "Object deletion = azure.resourceGroups().beginDeleteByName(name); var poller = deletion.getSyncPoller(); poller.waitForCompletion();",
    "Accepted<Void> deletion = azure.resourceGroups().beginDeleteByName(name); Object poller = deletion.getSyncPoller(); poller.waitForCompletion();",
    'azure.resourceGroups().deleteByName("other");',
    "fake.resourceGroups().deleteByName(name);",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/delete-resource-group",
        workspace(application({ remove })),
      ),
      false,
      remove,
    );
  }
});

test("deletion confirmation rejects split, premature, and unrelated output", () => {
  for (const source of [
    application({ confirmation: 'System.out.println("Deleted");' }),
    application({
      remove: 'System.out.println("Deleted resource group " + name); azure.resourceGroups().deleteByName(name);',
      confirmation: "",
    }),
    application({ confirmation: "System.out.println(name);" }),
    application({
      confirmation: `
        System.out.println("Deleted resource group");
        System.out.println(name);`,
    }),
    application({
      confirmation:
        'System.out.println("Deleted resource group unrelated-name");',
    }),
    application({
      confirmation: `
        String unrelatedResult = "unrelated-name";
        System.out.println("Deleted resource group " + unrelatedResult);`,
    }),
    application({
      confirmation:
        'System.out.printf("Deleted resource group%n", name);',
    }),
    application({
      confirmation:
        'logger.info("Deleted resource group", name);',
    }),
    application({
      confirmation:
        'System.out.printf("Deleted resource group %s%n", "unrelated-name", name);',
    }),
    application({
      confirmation:
        'logger.info("Deleted resource group {}", "unrelated-name", name);',
    }),
  ]) {
    assert.equal(
      evaluateRule("prompt/delete-confirmation", workspace(source)),
      false,
    );
  }
});

test("deletion confirmation accepts aliases, formats, loggers, and helpers", () => {
  const field = application({
    confirmation:
      'System.out.println("Deletion completed for " + DELETED_NAME);',
  }).replace(
    "class Application {",
    `class Application {
  private static final String DELETED_NAME =
      System.getenv("RESOURCE_GROUP_NAME");`,
  );
  const logger = application({
    confirmation:
      'LOGGER.log(java.util.logging.Level.INFO, "Deletion completed for {0}", name);',
  }).replace(
    "class Application {",
    `class Application {
  private static final java.util.logging.Logger LOGGER =
      java.util.logging.Logger.getLogger(Application.class.getName());`,
  );
  const helper = application({
    confirmation: "System.out.println(deletionMessage(name));",
  }).replace(
    "  public static void main(String[] args) {",
    `  static String deletionMessage(String deletedName) {
    return "Deletion completed for " + deletedName;
  }

  public static void main(String[] args) {`,
  );
  for (const source of [
    application({
      confirmation: `
        String deletedName = name;
        System.out.println("Deletion completed for " + deletedName);`,
    }),
    application({
      confirmation:
        'System.out.printf("Deletion completed for %s%n", name);',
    }),
    application({
      confirmation:
        'System.out.println(String.format("Deletion completed for %s", name));',
    }),
    application({
      confirmation:
        'System.out.println(String.format(java.util.Locale.ROOT, "Deletion completed for %s", name));',
    }),
    application({
      confirmation:
        'System.out.println("Deletion completed for %s".formatted(name));',
    }),
    field,
    logger,
    helper,
  ]) {
    assert.equal(
      evaluateRule("prompt/delete-confirmation", workspace(source)),
      true,
      source,
    );
  }
});

test("exception handling is meaningful and unrelated catches stay safe", () => {
  const safe = application({
    catches: `
    } catch (ManagementException exception) {
      System.err.println(exception.getMessage());
      throw exception;
    } catch (IllegalStateException exception) {
      throw exception;
    }`,
  });
  assert.equal(
    evaluateRule("prompt/exception-handling", workspace(safe)),
    true,
  );

  for (const catches of [
    "} catch (ManagementException exception) { }",
    `} catch (ManagementException exception) {
       System.err.println(exception.getMessage());
     }`,
    "} catch (ManagementException exception) { return; }",
    "} catch (ManagementException exception) { throw exception; }",
    `} catch (ManagementException exception) {
       System.err.println(exception.getMessage());
       throw exception;
     } catch (IllegalStateException exception) { }`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/exception-handling",
        workspace(application({ catches })),
      ),
      false,
      catches,
    );
  }
});

test("source order and mutually exclusive paths cannot assemble a lifecycle", () => {
  const reordered = application({
    create: `
      for (ResourceGroup group : azure.resourceGroups().list()) {
        System.out.println(group.name());
      }
      azure.resourceGroups().define(name).withRegion(location).create();`,
    list: "",
  });
  assert.equal(
    evaluateRule("prompt/list-resource-groups", workspace(reordered)),
    false,
  );

  const split = application({
    create: `
      if (args.length > 0) {
        azure.resourceGroups().define(name).withRegion(location).create();
      } else {
        for (ResourceGroup group : azure.resourceGroups().list()) {
          System.out.println(group.name());
        }
      }`,
    list: "",
  });
  assert.equal(
    evaluateRule("prompt/list-resource-groups", workspace(split)),
    false,
  );
});
