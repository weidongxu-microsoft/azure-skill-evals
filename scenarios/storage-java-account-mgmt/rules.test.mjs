import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadJavaWorkspace } from "../../languages/java/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/storage-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);

const imports = `
import com.azure.core.exception.HttpResponseException;
import com.azure.core.management.AzureEnvironment;
import com.azure.core.management.exception.ManagementException;
import com.azure.core.management.profile.AzureProfile;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.resourcemanager.storage.StorageManager;
import com.azure.resourcemanager.storage.models.BlobServiceProperties;
import com.azure.resourcemanager.storage.models.StorageAccount;
import com.azure.resourcemanager.storage.models.StorageAccountSkuType;
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
    String resourceGroup = System.getenv("RESOURCE_GROUP_NAME");
    String accountName = System.getenv("AZURE_STORAGE_ACCOUNT_NAME");
    String location = System.getenv("AZURE_LOCATION");`;
  const authentication = overrides.authentication ?? `
    var credential = new DefaultAzureCredentialBuilder().build();
    var profile = new AzureProfile(
        null, subscription, AzureEnvironment.AZURE);
    StorageManager manager =
        StorageManager.authenticate(credential, profile);`;
  const create = overrides.create ?? `
      manager.storageAccounts().define(accountName)
          .withRegion(location)
          .withExistingResourceGroup(resourceGroup)
          .withSku(StorageAccountSkuType.STANDARD_LRS)
          .withGeneralPurposeAccountKindV2()
          .create();`;
  const list = overrides.list ?? `
      for (StorageAccount account :
          manager.storageAccounts().listByResourceGroup(resourceGroup)) {
        System.out.println(account.name());
      }`;
  const get = overrides.get ?? `
      StorageAccount found = manager.storageAccounts()
          .getByResourceGroup(resourceGroup, accountName);
      System.out.println(found.id());`;
  const update = overrides.update ?? `
      BlobServiceProperties blob = manager.blobServices()
          .getServicePropertiesAsync(resourceGroup, accountName).block();
      BlobServiceProperties updated = blob.update()
          .withBlobVersioningEnabled().apply();
      System.out.println(updated.isBlobVersioningEnabled());`;
  const remove = overrides.remove ?? `
      manager.storageAccounts()
          .deleteByResourceGroup(resourceGroup, accountName);`;
  const confirmation = overrides.confirmation ?? `
      System.out.println("Deleted storage account " + accountName);`;
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

test.skip("the Java 17 golden application passes exactly nine graders", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test.skip("all graders require generated Java source", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, { ...golden, sourceFiles: [], source: "" }),
      false,
      rule,
    );
  }
});

test.skip("source manifest accepts active Java 17 Maven and Gradle pins", () => {
  const maven = `<project>
    <packaging>jar</packaging>
    <properties>
      <maven.compiler.source>17</maven.compiler.source>
      <maven.compiler.target>17</maven.compiler.target>
      <identity.version>1.18.5</identity.version>
      <storage.version>2.57.2</storage.version>
    </properties>
    <dependencies>
      <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-identity</artifactId>
        <version>\${identity.version}</version>
      </dependency>
      <dependency>
        <groupId>com.azure.resourcemanager</groupId>
        <artifactId>azure-resourcemanager-storage</artifactId>
        <version>\${storage.version}</version>
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
      runtimeOnly("com.azure.resourcemanager:azure-resourcemanager-storage:2.57.2")
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

test.skip("source manifest rejects inactive, nonruntime, split, and wrong pins", () => {
  const dependency = (group, artifact, version, scope = "") => `
    <dependency>
      <groupId>${group}</groupId><artifactId>${artifact}</artifactId>
      <version>${version}</version>${scope ? `<scope>${scope}</scope>` : ""}
    </dependency>`;
  const both = `
    ${dependency("com.azure", "azure-identity", "1.18.5")}
    ${dependency(
      "com.azure.resourcemanager",
      "azure-resourcemanager-storage",
      "2.57.2",
    )}`;
  for (const build of [
    `<project><properties><maven.compiler.release>21</maven.compiler.release></properties><dependencies>${both}</dependencies></project>`,
    `<project><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencyManagement><dependencies>${both}</dependencies></dependencyManagement></project>`,
    `<project><packaging>pom</packaging><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies>${both}</dependencies></project>`,
    `<project><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies>
       ${dependency("com.azure", "azure-identity", "1.18.5", "test")}
       ${dependency(
         "com.azure.resourcemanager",
         "azure-resourcemanager-storage",
         "2.57.2",
       )}
     </dependencies></project>`,
    `<project><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies>
       ${dependency("com.azure", "azure-identity", "1.18.5")}
     </dependencies></project>
     <project><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies>
       ${dependency(
         "com.azure.resourcemanager",
         "azure-resourcemanager-storage",
         "2.57.2",
       )}
     </dependencies></project>`,
    `<project><properties><maven.compiler.release>17</maven.compiler.release></properties><!-- <dependencies>${both}</dependencies> --></project>`,
    `java { sourceCompatibility = JavaVersion.VERSION_17 }
     dependencies {
       testImplementation("com.azure:azure-identity:1.18.5")
       compileOnly(
         "com.azure.resourcemanager:azure-resourcemanager-storage:2.57.2"
       )
     }`,
    `java { sourceCompatibility = JavaVersion.VERSION_17 }
     dependencies {
       implementation("com.azure:azure-identity:1.18.5")
       implementation(
         "com.azure.resourcemanager:azure-resourcemanager-storage:2.57.1"
       )
     }`,
  ]) {
    assert.equal(
      evaluateRule("prompt/source-manifest", workspace(application(), build)),
      false,
      build,
    );
  }
});

test.skip("qualified SDK types, aliases, fields, and reachable helpers pass", () => {
  const source = `
import com.azure.core.exception.HttpResponseException;
import com.azure.core.management.exception.ManagementException;
import com.azure.resourcemanager.storage.models.BlobServiceProperties;
import com.azure.resourcemanager.storage.models.StorageAccount;
class AlternateApplication {
  private static final String SUB = env("AZURE_SUBSCRIPTION_ID");
  private static final String RG = env("RESOURCE_GROUP_NAME");
  private static final String ACCOUNT = env("AZURE_STORAGE_ACCOUNT_NAME");
  private static final String REGION = env("AZURE_LOCATION");

  static String env(String key) {
    return System.getenv(key);
  }

  static com.azure.resourcemanager.storage.StorageManager manager() {
    var builder = new com.azure.identity.DefaultAzureCredentialBuilder();
    var credentialAlias = builder.build();
    var profileAlias = new com.azure.core.management.profile.AzureProfile(
        null, SUB, com.azure.core.management.AzureEnvironment.AZURE);
    return com.azure.resourcemanager.storage.StorageManager
        .authenticate(credentialAlias, profileAlias);
  }

  static void lifecycle(
      com.azure.resourcemanager.storage.StorageManager supplied) {
    var managerAlias = supplied;
    try {
      var accounts = managerAlias.storageAccounts();
      var definition = accounts.define(ACCOUNT);
      definition.withRegion(REGION);
      definition.withExistingResourceGroup(RG);
      definition.withSku(
          com.azure.resourcemanager.storage.models.StorageAccountSkuType
              .STANDARD_LRS);
      definition.withGeneralPurposeAccountKindV2();
      definition.create();
      var listed = accounts.listByResourceGroup(RG);
      for (StorageAccount account : listed) {
        System.out.printf("account=%s%n", account.name());
      }
      StorageAccount found = accounts.getByResourceGroup(RG, ACCOUNT);
      System.out.println(found.id());
      var serviceRequest = managerAlias.blobServices()
          .getServicePropertiesAsync(RG, ACCOUNT);
      BlobServiceProperties service = serviceRequest.block();
      var serviceUpdate = service.update();
      serviceUpdate.withBlobVersioningEnabled();
      BlobServiceProperties result = serviceUpdate.apply();
      System.out.println(result.isBlobVersioningEnabled());
      accounts.deleteByResourceGroup(RG, ACCOUNT);
      System.out.printf("Deletion completed for %s%n", ACCOUNT);
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

test.skip("wrong imports, local SDK shadows, profile, and subscription fail", () => {
  for (const source of [
    application().replace(
      "import com.azure.resourcemanager.storage.StorageManager;",
      "import example.StorageManager;",
    ),
    application().replace(
      "class Application {",
      "class StorageManager { static Object authenticate(Object a, Object b) { return null; } }\nclass Application {",
    ),
    application().replace(
      "new AzureProfile(\n        null, subscription, AzureEnvironment.AZURE)",
      "new AzureProfile(null, subscription, null)",
    ),
    application().replace(
      "null, subscription, AzureEnvironment.AZURE",
      "null, System.getenv(\"OTHER_SUBSCRIPTION\"), AzureEnvironment.AZURE",
    ),
    application().replace(
      'System.getenv("AZURE_SUBSCRIPTION_ID")',
      'System.getenv("OTHER_SUBSCRIPTION")',
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/authentication", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("conflicting and shadowed SDK result declarations fail", () => {
  const wrongCredential = application().replace(
    "var credential = new DefaultAzureCredentialBuilder().build();",
    "Object credential = new DefaultAzureCredentialBuilder().build();",
  );
  assert.equal(
    evaluateRule("prompt/authentication", workspace(wrongCredential)),
    false,
  );

  const wrongAccount = application().replace(
    "StorageAccount found = manager.storageAccounts()",
    "Object found = manager.storageAccounts()",
  );
  assert.equal(
    evaluateRule("prompt/get-storage-account", workspace(wrongAccount)),
    false,
  );

  const shadowedLoop = application().replace(
    "class Application {",
    "class StorageAccount { String id() { return \"fake\"; } }\nclass Application {",
  );
  assert.equal(
    evaluateRule("prompt/list-storage-accounts", workspace(shadowedLoop)),
    false,
  );

  const wrongDefinition = application({
    create: `
      Object definition =
          manager.storageAccounts().define(accountName);
      definition.withRegion(location);
      definition.withExistingResourceGroup(resourceGroup);
      definition.withSku(StorageAccountSkuType.STANDARD_LRS);
      definition.withGeneralPurposeAccountKindV2();
      definition.create();`,
  });
  assert.equal(
    evaluateRule("prompt/create-storage-account", workspace(wrongDefinition)),
    false,
  );
});

test.skip("create requires account, region, existing group, LRS, V2, and create", () => {
  const valid = application();
  for (const source of [
    valid.replace(
      'System.getenv("AZURE_STORAGE_ACCOUNT_NAME")',
      'System.getenv("OTHER_ACCOUNT")',
    ),
    valid.replace(
      'System.getenv("RESOURCE_GROUP_NAME")',
      'System.getenv("OTHER_GROUP")',
    ),
    valid.replace(
      'System.getenv("AZURE_LOCATION")',
      '"eastus"',
    ),
    valid.replace(".withExistingResourceGroup(resourceGroup)", ""),
    valid.replace(
      ".withSku(StorageAccountSkuType.STANDARD_LRS)",
      ".withSku(StorageAccountSkuType.PREMIUM_LRS)",
    ),
    valid.replace(
      ".withGeneralPurposeAccountKindV2()",
      ".withBlobStorageAccountKind().withAccessTier(AccessTier.HOT)",
    ),
    valid.replace(".create();", ";"),
    valid.replace(
      "manager.storageAccounts().define(accountName)",
      "fake.storageAccounts().define(accountName)",
    ),
    valid.replace(
      "manager.storageAccounts().define(accountName)",
      "if (false) { manager.storageAccounts().define(accountName)",
    ).replace(".create();", ".create(); }"),
  ]) {
    assert.equal(
      evaluateRule("prompt/create-storage-account", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("listByResourceGroup must iterate and output each account name", () => {
  for (const list of [
    "manager.storageAccounts().listByResourceGroup(resourceGroup);",
    "System.out.println(manager.storageAccounts().listByResourceGroup(resourceGroup));",
    "for (StorageAccount account : java.util.List.of()) { System.out.println(account.id()); }",
    "for (StorageAccount account : manager.storageAccounts().listByResourceGroup(resourceGroup)) { }",
    "for (StorageAccount account : manager.storageAccounts().listByResourceGroup(\"other\")) { System.out.println(account.id()); }",
    "for (StorageAccount account : manager.storageAccounts().list()) { System.out.println(account.id()); }",
    "for (StorageAccount account : manager.storageAccounts().listByResourceGroup(resourceGroup)) { System.out.println(account.id()); }",
    "for (StorageAccount account : manager.storageAccounts().listByResourceGroup(resourceGroup)) { System.out.println(\"storage account\"); }",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/list-storage-accounts",
        workspace(application({ list })),
      ),
      false,
      list,
    );
  }
});

test.skip("list output accepts aliases, formatting, loggers, and helpers consuming name", () => {
  for (const list of [
    `for (StorageAccount account :
        manager.storageAccounts().listByResourceGroup(resourceGroup)) {
      String name = account.name();
      System.out.println(name);
    }`,
    `for (StorageAccount account :
        manager.storageAccounts().listByResourceGroup(resourceGroup)) {
      System.out.printf("Storage account: %s%n", account.name());
    }`,
    `for (StorageAccount account :
        manager.storageAccounts().listByResourceGroup(resourceGroup)) {
      logger.info("Storage account {}", account.name());
    }`,
    `for (StorageAccount account :
        manager.storageAccounts().listByResourceGroup(resourceGroup)) {
      System.out.println(accountName(account));
    }`,
  ]) {
    const helpers = `
      static String accountName(StorageAccount account) {
        return account.name();
      }`;
    const source = application({ list }).replace(
      "\n  public static void main",
      `${helpers}\n  public static void main`,
    );
    assert.equal(
      evaluateRule("prompt/list-storage-accounts", workspace(source)),
      true,
      list,
    );
  }
});

test.skip("get must use the same group and account and output its result", () => {
  for (const get of [
    'StorageAccount found = manager.storageAccounts().getByResourceGroup(resourceGroup, "other"); System.out.println(found.id());',
    'StorageAccount found = manager.storageAccounts().getByResourceGroup("other", accountName); System.out.println(found.id());',
    "StorageAccount found = manager.storageAccounts().getByResourceGroup(resourceGroup, accountName);",
    "StorageAccount found = manager.storageAccounts().getByResourceGroup(resourceGroup, accountName); System.out.println(accountName);",
  ]) {
    assert.equal(
      evaluateRule("prompt/get-storage-account", workspace(application({ get }))),
      false,
      get,
    );
  }
});

test.skip("blob update requires associated service, enable, apply, and observation", () => {
  for (const update of [
    'BlobServiceProperties blob = manager.blobServices().getServicePropertiesAsync(resourceGroup, "other").block(); BlobServiceProperties updated = blob.update().withBlobVersioningEnabled().apply(); System.out.println(updated.isBlobVersioningEnabled());',
    'BlobServiceProperties blob = manager.blobServices().getServicePropertiesAsync("other", accountName).block(); BlobServiceProperties updated = blob.update().withBlobVersioningEnabled().apply(); System.out.println(updated.isBlobVersioningEnabled());',
    "BlobServiceProperties blob = manager.blobServices().getServicePropertiesAsync(resourceGroup, accountName).block(); blob.update().withBlobVersioningEnabled(); System.out.println(blob.isBlobVersioningEnabled());",
    "BlobServiceProperties blob = manager.blobServices().getServicePropertiesAsync(resourceGroup, accountName).block(); BlobServiceProperties updated = blob.update().withBlobVersioningDisabled().apply(); System.out.println(updated.isBlobVersioningEnabled());",
    "BlobServiceProperties blob = fake.blobServices().getServicePropertiesAsync(resourceGroup, accountName).block(); BlobServiceProperties updated = blob.update().withBlobVersioningEnabled().apply(); System.out.println(updated.isBlobVersioningEnabled());",
    "BlobServiceProperties blob = manager.blobServices().getServicePropertiesAsync(resourceGroup, accountName).block(); BlobServiceProperties updated = blob.update().withBlobVersioningEnabled().apply(); System.out.println(blob.isBlobVersioningEnabled());",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/update-blob-versioning",
        workspace(application({ update })),
      ),
      false,
      update,
    );
  }
});

test.skip("delete requires the same group and account after the applied update", () => {
  for (const remove of [
    'manager.storageAccounts().deleteByResourceGroup(resourceGroup, "other");',
    'manager.storageAccounts().deleteByResourceGroup("other", accountName);',
    "manager.storageAccounts().deleteById(accountName);",
    "fake.storageAccounts().deleteByResourceGroup(resourceGroup, accountName);",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/delete-storage-account",
        workspace(application({ remove })),
      ),
      false,
      remove,
    );
  }
});

test.skip("deletion confirmation rejects premature, split, and unrelated output", () => {
  for (const source of [
    application({ confirmation: 'System.out.println("Deleted");' }),
    application({
      remove:
        'System.out.println("Deleted storage account " + accountName); manager.storageAccounts().deleteByResourceGroup(resourceGroup, accountName);',
      confirmation: "",
    }),
    application({ confirmation: "System.out.println(accountName);" }),
    application({
      confirmation:
        'System.out.println("Deleted storage account"); System.out.println(accountName);',
    }),
    application({
      confirmation:
        'System.out.println("Deleted storage account unrelated-name");',
    }),
  ]) {
    assert.equal(
      evaluateRule("prompt/delete-confirmation", workspace(source)),
      false,
      source,
    );
  }
});

test.skip("deletion confirmation accepts aliases, formats, and helpers", () => {
  const helper = application({
    confirmation: "System.out.println(deletionMessage(accountName));",
  }).replace(
    "  public static void main(String[] args) {",
    `  static String deletionMessage(String deletedName) {
    return "Deletion completed for " + deletedName;
  }

  public static void main(String[] args) {`,
  );
  for (const source of [
    application({
      confirmation:
        'String deleted = accountName; System.out.println("Deletion completed for " + deleted);',
    }),
    application({
      confirmation:
        'System.out.printf("Deletion completed for %s%n", accountName);',
    }),
    application({
      confirmation:
        'System.out.println("Deletion completed for %s".formatted(accountName));',
    }),
    helper,
  ]) {
    assert.equal(
      evaluateRule("prompt/delete-confirmation", workspace(source)),
      true,
      source,
    );
  }
});

test.skip("exception handling is meaningful and unrelated catches remain safe", () => {
  const safe = application({
    catches: `
    } catch (HttpResponseException exception) {
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
  const partiallyProtected = application({
    authentication: `
    var credential = new DefaultAzureCredentialBuilder().build();
    var profile = new AzureProfile(
        null, subscription, AzureEnvironment.AZURE);
    StorageManager manager =
        StorageManager.authenticate(credential, profile);
    manager.storageAccounts().define(accountName)
        .withRegion(location)
        .withExistingResourceGroup(resourceGroup)
        .withSku(StorageAccountSkuType.STANDARD_LRS)
        .withGeneralPurposeAccountKindV2().create();`,
    create: "",
  });
  assert.equal(
    evaluateRule(
      "prompt/exception-handling",
      workspace(partiallyProtected),
    ),
    false,
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

test.skip("source order and mutually exclusive paths cannot assemble lifecycle", () => {
  const reordered = application({
    create: `
      for (StorageAccount account :
          manager.storageAccounts().listByResourceGroup(resourceGroup)) {
        System.out.println(account.name());
      }
      manager.storageAccounts().define(accountName)
          .withRegion(location)
          .withExistingResourceGroup(resourceGroup)
          .withSku(StorageAccountSkuType.STANDARD_LRS)
          .withGeneralPurposeAccountKindV2().create();`,
    list: "",
  });
  assert.equal(
    evaluateRule("prompt/list-storage-accounts", workspace(reordered)),
    false,
  );

  const split = application({
    create: `
      if (args.length > 0) {
        manager.storageAccounts().define(accountName)
            .withRegion(location)
            .withExistingResourceGroup(resourceGroup)
            .withSku(StorageAccountSkuType.STANDARD_LRS)
            .withGeneralPurposeAccountKindV2().create();
      } else {
        for (StorageAccount account :
            manager.storageAccounts().listByResourceGroup(resourceGroup)) {
          System.out.println(account.name());
        }
      }`,
    list: "",
  });
  assert.equal(
    evaluateRule("prompt/list-storage-accounts", workspace(split)),
    false,
  );
});

test.skip("key retrieval and resource-group lifecycle invalidate every criterion", () => {
  for (const forbidden of [
    "manager.storageAccounts().getByResourceGroup(resourceGroup, accountName).getKeys();",
    "manager.storageAccounts().listKeys(resourceGroup, accountName);",
    "manager.resourceGroups().define(resourceGroup).withRegion(location).create();",
  ]) {
    const source = application({
      confirmation: `${forbidden}
        System.out.println("Deleted storage account " + accountName);`,
    });
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace(source)), false, rule);
    }
  }
});
