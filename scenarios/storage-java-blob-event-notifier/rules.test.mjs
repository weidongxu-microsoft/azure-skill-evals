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
} from "./tools/storage-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);

const eventGridSample = JSON.stringify([
  {
    id: "created",
    eventType: "Microsoft.Storage.BlobCreated",
    subject: "/blobServices/default/containers/invoices/blobs/new.pdf",
    eventTime: "2026-08-29T01:00:00Z",
    data: { api: "PutBlob" },
    dataVersion: "",
    metadataVersion: "1",
    topic: "/subscriptions/example",
  },
  {
    id: "deleted",
    eventType: "Microsoft.Storage.BlobDeleted",
    subject: "/blobServices/default/containers/invoices/blobs/old.pdf",
    eventTime: "2026-08-29T01:01:00Z",
    data: { api: "DeleteBlob" },
    dataVersion: "",
    metadataVersion: "1",
    topic: "/subscriptions/example",
  },
]);
const cloudEventSample = JSON.stringify([
  {
    specversion: "1.0",
    id: "cloud-created",
    source: "/subscriptions/example",
    type: "Microsoft.Storage.BlobCreated",
    subject: "/blobServices/default/containers/invoices/blobs/new.pdf",
    time: "2026-08-29T01:02:00Z",
    datacontenttype: "application/json",
    data: { api: "PutBlob" },
  },
  {
    specversion: "1.0",
    id: "cloud-deleted",
    source: "/subscriptions/example",
    type: "Microsoft.Storage.BlobDeleted",
    subject: "/blobServices/default/containers/invoices/blobs/old.pdf",
    time: "2026-08-29T01:03:00Z",
    datacontenttype: "application/json",
    data: { api: "DeleteBlob" },
  },
]);

function workspace(
  source,
  build = golden.build,
  resources = [],
  sourceDocuments = [{ path: "src/main/java/com/example/Application.java", source }],
) {
  return {
    sourceFiles: ["src/main/java/com/example/Application.java"],
    buildFiles: ["pom.xml"],
    source,
    build,
    resources,
    sourceDocuments,
  };
}

function sourceWithDemoSamples(eventGridExpression, cloudExpression) {
  return golden.source
    .replace(
      '        String notificationSubject = "/documents/invoices/processed";',
      `        String notificationSubject = "/documents/invoices/processed";
        String eventGridSample = ${eventGridExpression};
        String cloudEventSample = ${cloudExpression};`,
    )
    .replaceAll(
      "receiveEventGrid(EVENT_GRID_PAYLOAD)",
      "receiveEventGrid(eventGridSample)",
    )
    .replaceAll(
      "receiveCloudEvents(CLOUD_EVENT_PAYLOAD)",
      "receiveCloudEvents(cloudEventSample)",
    )
    .replaceAll(
      "receiveEventGridAsync(EVENT_GRID_PAYLOAD)",
      "receiveEventGridAsync(eventGridSample)",
    )
    .replaceAll(
      "receiveCloudEventsAsync(CLOUD_EVENT_PAYLOAD)",
      "receiveCloudEventsAsync(cloudEventSample)",
    );
}

test.skip("the real golden application passes prompt and shared Java checks", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/source-manifest",
    "prompt/secure-client-configuration",
    "prompt/dual-schema-receivers",
    "prompt/event-routing",
    "prompt/blob-subject-parsing",
    "prompt/blob-created-summary",
    "prompt/blob-race-handling",
    "prompt/custom-event-publishing",
    "prompt/publish-error-handling",
    "prompt/connected-demo",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, golden), true, check);
  }
});

test.skip("the golden Maven manifest pins the verified stable SDK versions", () => {
  for (const [artifact, version] of [
    ["azure-identity", "1.18.5"],
    ["azure-storage-blob", "12.35.1"],
    ["azure-messaging-eventgrid", "4.31.8"],
  ]) {
    assert.match(
      golden.build,
      new RegExp(
        `<artifactId>${artifact}<\\/artifactId>\\s*<version>${version.replaceAll(".", "\\.")}<\\/version>`,
      ),
      artifact,
    );
  }
});

test.skip("the source manifest requires Java 17 and all exact active runtime pins", () => {
  for (const replacement of [
    ["<maven.compiler.release>17", "<maven.compiler.release>21"],
    ["<version>1.18.5</version>", "<version>1.18.4</version>"],
    ["<version>12.35.1</version>", "<version>12.36.0-beta.1</version>"],
    ["<version>4.31.8</version>", "<version>4.31.7</version>"],
  ]) {
    assert.equal(
      evaluateRule("prompt/source-manifest", {
        ...golden,
        build: golden.build.replace(...replacement),
      }),
      false,
      replacement.join(" -> "),
    );
  }

  const inactive = golden.build.replace(
    /<dependency>\s*<groupId>com\.azure<\/groupId>\s*<artifactId>azure-messaging-eventgrid<\/artifactId>[\s\S]*?<\/dependency>/,
    `<!--
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>azure-messaging-eventgrid</artifactId>
      <version>4.31.8</version>
    </dependency>
    -->`,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", { ...golden, build: inactive }),
    false,
  );
});

test.skip("required Maven pins reject active duplicates and malformed declarations", () => {
  const identityDependency = `
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>azure-identity</artifactId>
      <version>1.18.5</version>
    </dependency>`;
  for (const build of [
    golden.build.replace(
      "</dependencies>",
      `${identityDependency}\n  </dependencies>`,
    ),
    golden.build.replace(
      "</dependencies>",
      `${identityDependency.replace("1.18.5", "1.18.4")}\n  </dependencies>`,
    ),
    golden.build.replace(
      "<version>1.18.5</version>",
      "<version>1.18.5</version><version>1.18.4</version>",
    ),
    golden.build.replace("</dependency>", ""),
  ]) {
    assert.equal(
      evaluateRule("prompt/source-manifest", { ...golden, build }),
      false,
    );
  }
});

test.skip("one effective exact Maven pin may come from dependency management", () => {
  const managedBuild = `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>sample</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <identity.version>1.18.5</identity.version>
    <storage.version>12.35.1</storage.version>
    <eventgrid.version>4.31.8</eventgrid.version>
  </properties>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-identity</artifactId>
        <version>\${identity.version}</version>
      </dependency>
      <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-storage-blob</artifactId>
        <version>\${storage.version}</version>
      </dependency>
      <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-messaging-eventgrid</artifactId>
        <version>\${eventgrid.version}</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>azure-identity</artifactId>
    </dependency>
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>azure-storage-blob</artifactId>
    </dependency>
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>azure-messaging-eventgrid</artifactId>
    </dependency>
  </dependencies>
</project>`;
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: managedBuild,
    }),
    true,
  );
});

test.skip("direct and managed Maven pins must be conflict-free after property resolution", () => {
  const managedIdentity = (version) => `
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-identity</artifactId>
        <version>${version}</version>
      </dependency>
    </dependencies>
  </dependencyManagement>`;
  const directCorrectManagedWrong = golden.build.replace(
    "  <dependencies>",
    `${managedIdentity("1.18.4")}\n  <dependencies>`,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: directCorrectManagedWrong,
    }),
    false,
  );

  const directWrongManagedCorrect = golden.build
    .replace("<version>1.18.5</version>", "<version>1.18.4</version>")
    .replace(
      "  <dependencies>",
      `${managedIdentity("1.18.5")}\n  <dependencies>`,
    );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: directWrongManagedCorrect,
    }),
    false,
  );

  const propertyConflict = golden.build
    .replace(
      "    <maven.compiler.release>17</maven.compiler.release>",
      `    <maven.compiler.release>17</maven.compiler.release>
    <identity.direct>1.18.5</identity.direct>
    <identity.managed>1.18.4</identity.managed>`,
    )
    .replace("<version>1.18.5</version>", "<version>${identity.direct}</version>")
    .replace(
      "  <dependencies>",
      `${managedIdentity("${identity.managed}")}\n  <dependencies>`,
    );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: propertyConflict,
    }),
    false,
  );

  const consistentAliases = golden.build
    .replace(
      "    <maven.compiler.release>17</maven.compiler.release>",
      `    <maven.compiler.release>17</maven.compiler.release>
    <identity.pin>1.18.5</identity.pin>
    <identity.alias>\${identity.pin}</identity.alias>`,
    )
    .replace("<version>1.18.5</version>", "<version>${identity.alias}</version>")
    .replace(
      "  <dependencies>",
      `${managedIdentity("${identity.pin}")}\n  <dependencies>`,
    );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: consistentAliases,
    }),
    true,
  );

  const duplicateManagedConflict = directCorrectManagedWrong.replace(
    "    </dependencies>\n  </dependencyManagement>",
    `      <dependency>
        <groupId>com.azure</groupId>
        <artifactId>azure-identity</artifactId>
        <version>1.18.5</version>
      </dependency>
    </dependencies>
  </dependencyManagement>`,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: duplicateManagedConflict,
    }),
    false,
  );
});

test.skip("active Maven profiles participate in effective pin conflict checks", () => {
  const profile = (activation, body) => `
  <profiles>
    <profile>
      <id>alternate-pins</id>
      ${activation}
      ${body}
    </profile>
  </profiles>`;
  const inactiveConflict = golden.build.replace(
    "</project>",
    `${profile(
      "",
      `<dependencyManagement>
        <dependencies>
          <dependency>
            <groupId>com.azure</groupId>
            <artifactId>azure-identity</artifactId>
            <version>1.18.4</version>
          </dependency>
        </dependencies>
      </dependencyManagement>`,
    )}
</project>`,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: inactiveConflict,
    }),
    true,
  );

  const activeConflict = inactiveConflict.replace(
    "<id>alternate-pins</id>",
    `<id>alternate-pins</id>
      <activation><activeByDefault>true</activeByDefault></activation>`,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: activeConflict,
    }),
    false,
  );

  const propertyConflict = golden.build
    .replace(
      "    <maven.compiler.release>17</maven.compiler.release>",
      `    <maven.compiler.release>17</maven.compiler.release>
    <identity.version>1.18.5</identity.version>`,
    )
    .replace("<version>1.18.5</version>", "<version>${identity.version}</version>")
    .replace(
      "</project>",
      `${profile(
        "<activation><activeByDefault>true</activeByDefault></activation>",
        `<properties>
        <identity.version>1.18.4</identity.version>
      </properties>`,
      )}
</project>`,
    );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: propertyConflict,
    }),
    false,
  );
});

test.skip("Java 17 Maven activation controls the complete effective model", () => {
  const conflictingProfile = (jdk) => `
  <profiles>
    <profile>
      <id>java-specific-pins</id>
      <activation><jdk>${jdk}</jdk></activation>
      <properties>
        <identity.version>1.18.4</identity.version>
      </properties>
      <dependencyManagement>
        <dependencies>
          <dependency>
            <groupId>com.azure</groupId>
            <artifactId>azure-identity</artifactId>
            <version>\${identity.version}</version>
          </dependency>
        </dependencies>
      </dependencyManagement>
    </profile>
  </profiles>`;
  for (const activation of [
    "17",
    "17.0",
    "[17]",
    "[17,18)",
    "(16,17]",
    "!21",
  ]) {
    const build = golden.build.replace(
      "</project>",
      `${conflictingProfile(activation)}\n</project>`,
    );
    assert.equal(
      evaluateRule("prompt/source-manifest", { ...golden, build }),
      false,
      activation,
    );
  }
  for (const activation of [
    "21",
    "[18,)",
    "(17,18)",
    "!17",
  ]) {
    const build = golden.build.replace(
      "</project>",
      `${conflictingProfile(activation)}\n</project>`,
    );
    assert.equal(
      evaluateRule("prompt/source-manifest", { ...golden, build }),
      true,
      activation,
    );
  }

  const profileOnlyBuild = `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>sample</artifactId>
  <version>1.0.0</version>
  <profiles>
    <profile>
      <id>java-17-runtime</id>
      <activation><jdk>[17,18)</jdk></activation>
      <properties>
        <maven.compiler.release>17</maven.compiler.release>
        <identity.version>1.18.5</identity.version>
        <storage.version>12.35.1</storage.version>
        <eventgrid.version>4.31.8</eventgrid.version>
      </properties>
      <dependencyManagement>
        <dependencies>
          <dependency>
            <groupId>com.azure</groupId>
            <artifactId>azure-identity</artifactId>
            <version>\${identity.version}</version>
          </dependency>
          <dependency>
            <groupId>com.azure</groupId>
            <artifactId>azure-storage-blob</artifactId>
            <version>\${storage.version}</version>
          </dependency>
          <dependency>
            <groupId>com.azure</groupId>
            <artifactId>azure-messaging-eventgrid</artifactId>
            <version>\${eventgrid.version}</version>
          </dependency>
        </dependencies>
      </dependencyManagement>
      <dependencies>
        <dependency>
          <groupId>com.azure</groupId>
          <artifactId>azure-identity</artifactId>
        </dependency>
        <dependency>
          <groupId>com.azure</groupId>
          <artifactId>azure-storage-blob</artifactId>
        </dependency>
        <dependency>
          <groupId>com.azure</groupId>
          <artifactId>azure-messaging-eventgrid</artifactId>
        </dependency>
      </dependencies>
    </profile>
  </profiles>
</project>`;
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: profileOnlyBuild,
    }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: profileOnlyBuild.replace("[17,18)", "[18,)"),
    }),
    false,
  );
});

test.skip("conditionally active Maven profiles suppress active-by-default profiles", () => {
  const defaultConflict = `
    <profile>
      <id>default-conflict</id>
      <activation><activeByDefault>true</activeByDefault></activation>
      <dependencies>
        <dependency>
          <groupId>com.azure</groupId>
          <artifactId>azure-identity</artifactId>
          <version>1.18.4</version>
        </dependency>
      </dependencies>
    </profile>`;
  const conditional = (jdk) => `
    <profile>
      <id>java-runtime</id>
      <activation><jdk>${jdk}</jdk></activation>
      <properties><runtime.profile>selected</runtime.profile></properties>
    </profile>`;
  const withProfiles = (jdk) => golden.build.replace(
    "</project>",
    `  <profiles>${defaultConflict}${conditional(jdk)}
  </profiles>
</project>`,
  );

  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: withProfiles("[17,18)"),
    }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: withProfiles("[18,)"),
    }),
    false,
  );
});

test.skip("activeByDefault false does not veto deterministic Maven activation", () => {
  const conflictingProfile = (jdk) => `
  <profiles>
    <profile>
      <id>explicitly-not-default</id>
      <activation>
        <activeByDefault>false</activeByDefault>
        <jdk>${jdk}</jdk>
      </activation>
      <dependencies>
        <dependency>
          <groupId>com.azure</groupId>
          <artifactId>azure-identity</artifactId>
          <version>1.18.4</version>
        </dependency>
      </dependencies>
    </profile>
  </profiles>`;
  const buildWith = (activation) => golden.build.replace(
    "</project>",
    `${activation}\n</project>`,
  );

  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: buildWith(conflictingProfile("[17,18)")),
    }),
    false,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: buildWith(conflictingProfile("[18,)")),
    }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: buildWith(
        conflictingProfile("[17,18)").replace(
          "<activeByDefault>false</activeByDefault>",
          "<activeByDefault>true</activeByDefault>",
        ),
      ),
    }),
    false,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: buildWith(
        conflictingProfile("[18,)").replace(
          "<activeByDefault>false</activeByDefault>",
          "<activeByDefault>true</activeByDefault>",
        ),
      ),
    }),
    true,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", {
      ...golden,
      build: buildWith(
        conflictingProfile("[17,18)").replace(
          "\n        <jdk>[17,18)</jdk>",
          "",
        ),
      ),
    }),
    true,
  );
});

test.skip("comments, strings, false branches, and uncalled helpers do not count", () => {
  const decoy = `
import com.azure.core.exception.HttpResponseException;
import com.azure.core.models.CloudEvent;
import com.azure.core.util.BinaryData;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.messaging.eventgrid.EventGridEvent;
import com.azure.messaging.eventgrid.EventGridPublisherClientBuilder;
import com.azure.storage.blob.BlobServiceClientBuilder;
import com.azure.storage.blob.models.BlobProperties;
import com.azure.storage.blob.models.BlobStorageException;
class Decoy {
  static void unused() {
    EventGridEvent.fromString(payload);
    CloudEvent.fromString(payload);
    new BlobServiceClientBuilder().endpoint(System.getenv("AZURE_STORAGE_ACCOUNT_URL"))
        .credential(new DefaultAzureCredentialBuilder().build()).buildClient();
  }
  public static void main(String[] args) {
    String prose = "CloudEvent.fromString(payload); client.sendEvents(events);";
    // EventGridEvent.fromString(payload);
    if (false) {
      unused();
    }
  }
}`;
  for (const rule of ruleNames().filter((name) => name !== "prompt/source-manifest")) {
    assert.equal(evaluateRule(rule, workspace(decoy)), false, rule);
  }
});

test.skip("secure builders require endpoint and credential values to flow into every build", () => {
  const hardcodedEndpoints = golden.source
    .replaceAll(
      ".endpoint(storageEndpoint)",
      '.endpoint("https://fixed.blob.core.windows.net")',
    )
    .replaceAll(
      ".endpoint(eventGridEndpoint)",
      '.endpoint("https://fixed.eventgrid.azure.net")',
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(hardcodedEndpoints),
    ),
    false,
  );

  const swappedEndpoints = golden.source
    .replaceAll(".endpoint(storageEndpoint)", ".endpoint(swappedEndpoint)")
    .replaceAll(".endpoint(eventGridEndpoint)", ".endpoint(storageEndpoint)")
    .replaceAll(".endpoint(swappedEndpoint)", ".endpoint(eventGridEndpoint)");
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(swappedEndpoints),
    ),
    false,
  );

  const nullCredential = golden.source.replaceAll(
    ".credential(credential)",
    ".credential((TokenCredential) null)",
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(nullCredential),
    ),
    false,
  );

  const unusedCredential = golden.source
    .replace(
      "TokenCredential credential = new DefaultAzureCredentialBuilder().build();",
      `TokenCredential credential = new DefaultAzureCredentialBuilder().build();
        TokenCredential unrelatedCredential = (TokenCredential) null;`,
    )
    .replaceAll(
      ".credential(credential)",
      ".credential(unrelatedCredential)",
    );
  assert.match(
    unusedCredential,
    /new DefaultAzureCredentialBuilder\(\)\.build\(\)/,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(unusedCredential),
    ),
    false,
  );
});

test.skip("secure endpoint and credential helper flows remain accepted", () => {
  const helperBuilt = golden.source
    .replace(
      "TokenCredential credential = new DefaultAzureCredentialBuilder().build();",
      "TokenCredential credential = buildCredential();",
    )
    .replace(
      "    private static String requireEnvironment(String name) {",
      `    private static TokenCredential buildCredential() {
        return new DefaultAzureCredentialBuilder().build();
    }

    private static String requireEnvironment(String name) {`,
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(helperBuilt),
    ),
    true,
  );

  const equivalentCredential = golden.source
    .replace(
      "import com.azure.identity.DefaultAzureCredentialBuilder;",
      "import com.azure.identity.ManagedIdentityCredentialBuilder;",
    )
    .replace(
      "new DefaultAzureCredentialBuilder().build()",
      "new ManagedIdentityCredentialBuilder().build()",
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(equivalentCredential),
    ),
    true,
  );

  const separateBuilder = golden.source.replace(
    "TokenCredential credential = new DefaultAzureCredentialBuilder().build();",
    `DefaultAzureCredentialBuilder credentialBuilder =
                new DefaultAzureCredentialBuilder();
        TokenCredential credential = credentialBuilder.build();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(separateBuilder),
    ),
    true,
  );
});

test.skip("endpoint and credential reassignments affect each builder call", () => {
  for (const source of [
    golden.source.replace(
      'String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");',
      `String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
        storageEndpoint = "https://fixed.blob.core.windows.net";`,
    ),
    golden.source.replace(
      "TokenCredential credential = new DefaultAzureCredentialBuilder().build();",
      `TokenCredential credential = new DefaultAzureCredentialBuilder().build();
        credential = null;`,
    ),
    golden.source.replace(
      'String eventGridEndpoint = requireEnvironment("AZURE_EVENT_GRID_TOPIC_ENDPOINT");',
      `String eventGridEndpoint = requireEnvironment("AZURE_EVENT_GRID_TOPIC_ENDPOINT");
        if (System.getenv("REPLACE_EVENT_GRID_ENDPOINT") != null)
            eventGridEndpoint = "https://fixed.eventgrid.azure.net";`,
    ),
    golden.source.replace(
      'String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");',
      `String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
        storageEndpoint = System.getenv("KEEP_STORAGE_ENDPOINT") != null
                ? storageEndpoint
                : "https://fixed.blob.core.windows.net";`,
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", workspace(source)),
      false,
    );
  }

  const secureReassignments = golden.source
    .replace(
      'String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");',
      `String storageEndpoint = "unused";
        storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");`,
    )
    .replace(
      "TokenCredential credential = new DefaultAzureCredentialBuilder().build();",
      `TokenCredential credential = null;
        credential = new DefaultAzureCredentialBuilder().build();`,
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(secureReassignments),
    ),
    true,
  );

  const impossibleReassignment = golden.source.replace(
    'String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");',
    `String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
        if (1 == 2)
            storageEndpoint = "https://fixed.blob.core.windows.net";`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(impossibleReassignment),
    ),
    true,
  );

  const blobBuilder =
    /BlobServiceClient blobClient = new BlobServiceClientBuilder\(\)\s*\.endpoint\(storageEndpoint\)\s*\.credential\(credential\)\s*\.buildClient\(\);/;
  const insecureAtEndpointCall = golden.source.replace(
    blobBuilder,
    `String selectedStorageEndpoint = "https://fixed.blob.core.windows.net";
        BlobServiceClientBuilder syncBuilder = new BlobServiceClientBuilder();
        syncBuilder.endpoint(selectedStorageEndpoint);
        selectedStorageEndpoint = storageEndpoint;
        syncBuilder.credential(credential);
        BlobServiceClient blobClient = syncBuilder.buildClient();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(insecureAtEndpointCall),
    ),
    false,
  );

  const secureAtEndpointCall = golden.source.replace(
    blobBuilder,
    `String selectedStorageEndpoint = storageEndpoint;
        BlobServiceClientBuilder syncBuilder = new BlobServiceClientBuilder();
        syncBuilder.endpoint(selectedStorageEndpoint);
        selectedStorageEndpoint = "https://fixed.blob.core.windows.net";
        syncBuilder.credential(credential);
        BlobServiceClient blobClient = syncBuilder.buildClient();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(secureAtEndpointCall),
    ),
    true,
  );

  for (const conditionalBuilder of [
    `BlobServiceClientBuilder syncBuilder = new BlobServiceClientBuilder();
        if (System.getenv("CONFIGURE_ENDPOINT") != null)
            syncBuilder.endpoint(storageEndpoint);
        syncBuilder.credential(credential);
        BlobServiceClient blobClient = syncBuilder.buildClient();`,
    `BlobServiceClientBuilder syncBuilder = new BlobServiceClientBuilder();
        syncBuilder.endpoint(storageEndpoint);
        if (System.getenv("CONFIGURE_CREDENTIAL") != null)
            syncBuilder.credential(credential);
        BlobServiceClient blobClient = syncBuilder.buildClient();`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/secure-client-configuration",
        workspace(golden.source.replace(blobBuilder, conditionalBuilder)),
      ),
      false,
      conditionalBuilder,
    );
  }

  const validConditionalBuilder = golden.source.replace(
    blobBuilder,
    `BlobServiceClientBuilder syncBuilder = new BlobServiceClientBuilder();
        syncBuilder.endpoint(storageEndpoint);
        if (System.getenv("CONFIGURE_ENDPOINT_AGAIN") != null)
            syncBuilder.endpoint(storageEndpoint);
        syncBuilder.credential(credential);
        BlobServiceClient blobClient = syncBuilder.buildClient();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(validConditionalBuilder),
    ),
    true,
  );
});

test.skip("endpoint, credential, and client loops preserve zero-or-more paths", () => {
  const zeroTripEndpoint = golden.source.replace(
    'String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");',
    `String storageEndpoint = "https://fixed.blob.core.windows.net";
        for (String ignored : java.util.List.of()) {
            storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(zeroTripEndpoint),
    ),
    false,
  );

  const unknownCredentialLoop = golden.source.replace(
    "TokenCredential credential = new DefaultAzureCredentialBuilder().build();",
    `TokenCredential credential = null;
        for (String ignored : System.getenv().keySet()) {
            credential = new DefaultAzureCredentialBuilder().build();
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(unknownCredentialLoop),
    ),
    false,
  );

  const clientDeclaration =
    /BlobServiceClient blobClient = new BlobServiceClientBuilder\(\)\s*\.endpoint\(storageEndpoint\)\s*\.credential\(credential\)\s*\.buildClient\(\);/;
  const zeroTripClient = golden.source.replace(
    clientDeclaration,
    (declaration) => `${declaration}
        BlobServiceClient secureBlobClient = blobClient;
        blobClient = null;
        for (String ignored : java.util.List.of()) {
            blobClient = secureBlobClient;
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(zeroTripClient),
    ),
    false,
  );

  const guaranteedLoops = golden.source
    .replace(
      'String storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");',
      `String storageEndpoint = "unused";
        for (String ignored : java.util.List.of("once")) {
            storageEndpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
        }`,
    )
    .replace(
      "TokenCredential credential = new DefaultAzureCredentialBuilder().build();",
      `TokenCredential credential = null;
        do {
            credential = new DefaultAzureCredentialBuilder().build();
        } while (false);`,
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(guaranteedLoops),
    ),
    true,
  );

  const credentialRestoredByCondition = golden.source.replace(
    "TokenCredential credential = new DefaultAzureCredentialBuilder().build();",
    `TokenCredential credential = null;
        credentialAttempt:
        do {
            if (System.nanoTime() > 0) {
                continue credentialAttempt;
            }
            credential = null;
        } while ((credential = new DefaultAzureCredentialBuilder().build()) == null);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(credentialRestoredByCondition),
    ),
    true,
  );

  const credentialInvalidatedByCondition = golden.source.replace(
    "TokenCredential credential = new DefaultAzureCredentialBuilder().build();",
    `TokenCredential credential = new DefaultAzureCredentialBuilder().build();
        do {
            if (System.nanoTime() > 0) {
                continue;
            }
            credential = new DefaultAzureCredentialBuilder().build();
        } while ((credential = null) != null);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(credentialInvalidatedByCondition),
    ),
    false,
  );
});

test.skip("secure builder products must reach every operated client and publisher", () => {
  const disconnectedConsumers = golden.source
    .replace(
      "new BlobEventHandler(clients.blobClient())",
      "new BlobEventHandler(null)",
    )
    .replace(
      "new AsyncBlobEventHandler(clients.blobAsyncClient())",
      "new AsyncBlobEventHandler(null)",
    )
    .replace(
      "new EventPublisher(clients.eventPublisher())",
      "new EventPublisher(null)",
    )
    .replace(
      "new AsyncEventPublisher(clients.eventAsyncPublisher())",
      "new AsyncEventPublisher(null)",
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(disconnectedConsumers),
    ),
    false,
  );

  const reboundLocals = golden.source.replace(
    "        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);",
    `        blobClient = null;
        blobAsyncClient = null;
        publisher = null;
        asyncPublisher = null;
        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(reboundLocals),
    ),
    false,
  );

  const reboundRecord = golden.source.replace(
    "        List<DownstreamNotification> notifications =",
    `        clients = null;
        List<DownstreamNotification> notifications =`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(reboundRecord),
    ),
    false,
  );

  const reboundFields = golden.source
    .replace(
      "private final BlobServiceClient serviceClient;",
      "private BlobServiceClient serviceClient;",
    )
    .replace(
      "private final BlobServiceAsyncClient serviceClient;",
      "private BlobServiceAsyncClient serviceClient;",
    )
    .replace(
      "private final EventGridPublisherAsyncClient<EventGridEvent> client;",
      "private EventGridPublisherAsyncClient<EventGridEvent> client;",
    )
    .replace(
      "private final EventGridPublisherClient<EventGridEvent> client;",
      "private EventGridPublisherClient<EventGridEvent> client;",
    )
    .replaceAll(
      "this.serviceClient = serviceClient;",
      `this.serviceClient = serviceClient;
        this.serviceClient = null;`,
    )
    .replaceAll(
      "this.client = client;",
      `this.client = client;
        this.client = null;`,
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(reboundFields),
    ),
    false,
  );
});

test.skip("braceless conditional client rebindings merge provenance conservatively", () => {
  const reboundFields = golden.source
    .replace(
      "private final EventGridPublisherAsyncClient<EventGridEvent> client;",
      "private EventGridPublisherAsyncClient<EventGridEvent> client;",
    )
    .replace(
      "private final EventGridPublisherClient<EventGridEvent> client;",
      "private EventGridPublisherClient<EventGridEvent> client;",
    )
    .replaceAll(
      "this.client = client;",
      `this.client = client;
        if (1 == 1)
            this.client = null;`,
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(reboundFields),
    ),
    false,
  );

  const reboundLocal = golden.source.replace(
    "        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);",
    `        if (System.getenv("REPLACE_BLOB_CLIENT") != null)
            blobClient = null;
        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(reboundLocal),
    ),
    false,
  );
});

test.skip("impossible and secure conditional client assignments remain valid", () => {
  const impossibleRebinding = golden.source
    .replace(
      "private final EventGridPublisherAsyncClient<EventGridEvent> client;",
      "private EventGridPublisherAsyncClient<EventGridEvent> client;",
    )
    .replace(
      "private final EventGridPublisherClient<EventGridEvent> client;",
      "private EventGridPublisherClient<EventGridEvent> client;",
    )
    .replaceAll(
      "this.client = client;",
      `this.client = client;
        if (1 == 2)
            this.client = null;`,
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(impossibleRebinding),
    ),
    true,
  );

  const secureConditional = golden.source.replace(
    "        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);",
    `        BlobServiceClient originalBlobClient = blobClient;
        if (System.getenv("KEEP_BLOB_CLIENT") != null)
            blobClient = originalBlobClient;
        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(secureConditional),
    ),
    true,
  );
});

test.skip("secure operated clients may flow through typed helper parameters", () => {
  const helperMethods = `
    private static com.azure.storage.blob.BlobServiceClient passBlobClient(
            com.azure.storage.blob.BlobServiceClient client) {
        return client;
    }

    private static com.azure.storage.blob.BlobServiceAsyncClient passAsyncBlobClient(
            com.azure.storage.blob.BlobServiceAsyncClient client) {
        return client;
    }

    private static com.azure.messaging.eventgrid.EventGridPublisherClient<
            com.azure.messaging.eventgrid.EventGridEvent> passPublisher(
                    com.azure.messaging.eventgrid.EventGridPublisherClient<
                            com.azure.messaging.eventgrid.EventGridEvent> client) {
        return client;
    }

    private static com.azure.messaging.eventgrid.EventGridPublisherAsyncClient<
            com.azure.messaging.eventgrid.EventGridEvent> passAsyncPublisher(
                    com.azure.messaging.eventgrid.EventGridPublisherAsyncClient<
                            com.azure.messaging.eventgrid.EventGridEvent> client) {
        return client;
    }

`;
  const helperFlow = golden.source
    .replace(
      "    private Main() {",
      `${helperMethods}    private Main() {`,
    )
    .replace(
      "new BlobEventHandler(clients.blobClient())",
      "new BlobEventHandler(passBlobClient(clients.blobClient()))",
    )
    .replace(
      "new AsyncBlobEventHandler(clients.blobAsyncClient())",
      "new AsyncBlobEventHandler(passAsyncBlobClient(clients.blobAsyncClient()))",
    )
    .replace(
      "new EventPublisher(clients.eventPublisher())",
      "new EventPublisher(passPublisher(clients.eventPublisher()))",
    )
    .replace(
      "new AsyncEventPublisher(clients.eventAsyncPublisher())",
      "new AsyncEventPublisher(passAsyncPublisher(clients.eventAsyncPublisher()))",
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(helperFlow),
    ),
    true,
  );
});

test.skip("client provenance rejects conditional and unresolved rebindings", () => {
  const localConditional = golden.source.replace(
    "        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);",
    `        blobClient = System.getenv("KEEP_BLOB_CLIENT") != null
                ? blobClient
                : null;
        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(localConditional),
    ),
    false,
  );

  const recordConditional = golden.source.replace(
    "        List<DownstreamNotification> notifications =",
    `        clients = System.getenv("KEEP_CLIENTS") != null ? clients : null;
        List<DownstreamNotification> notifications =`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(recordConditional),
    ),
    false,
  );

  const fieldConditional = golden.source
    .replace(
      "private final BlobServiceClient serviceClient;",
      "private BlobServiceClient serviceClient;",
    )
    .replace(
      "this.serviceClient = serviceClient;",
      `this.serviceClient = serviceClient;
        this.serviceClient = System.getenv("KEEP_SERVICE_CLIENT") != null
                ? serviceClient
                : unresolvedClient();`,
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(fieldConditional),
    ),
    false,
  );

  const helperConditional = golden.source
    .replace(
      "    private Main() {",
      `    private static com.azure.storage.blob.BlobServiceClient chooseBlobClient(
            com.azure.storage.blob.BlobServiceClient client) {
        return System.getenv("KEEP_BLOB_CLIENT") != null ? client : null;
    }

    private Main() {`,
    )
    .replace(
      "new BlobEventHandler(clients.blobClient())",
      "new BlobEventHandler(chooseBlobClient(clients.blobClient()))",
    );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(helperConditional),
    ),
    false,
  );

  for (const unresolvedOperation of [
    golden.source.replaceAll(
      /serviceClient\s*\.\s*getBlobContainerClient\(/g,
      "unresolvedClient(serviceClient).getBlobContainerClient(",
    ),
    golden.source.replace(
      /client\s*\.\s*sendEvents\(/,
      "unresolvedPublisher(client).sendEvents(",
    ),
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/secure-client-configuration",
        workspace(unresolvedOperation),
      ),
      false,
    );
  }
});

test.skip("client provenance preserves secure conditional aliases and wrappers", () => {
  const secureConditional = golden.source.replace(
    "        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);",
    `        BlobServiceClient originalBlobClient = blobClient;
        blobClient = System.getenv("SELECT_BLOB_CLIENT") != null
                ? blobClient
                : originalBlobClient;
        return new AzureClients(blobClient, blobAsyncClient, publisher, asyncPublisher);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(secureConditional),
    ),
    true,
  );

  const nonNullWrapper = golden.source.replace(
    "new BlobEventHandler(clients.blobClient())",
    "new BlobEventHandler(java.util.Objects.requireNonNull(clients.blobClient()))",
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      workspace(nonNullWrapper),
    ),
    true,
  );
});

test.skip("only executable Java main signatures root reachability", () => {
  for (const signature of [
    "private void main()",
    "public void main(String[] args)",
    "public static int main(String[] args)",
    "static void main(String[] args)",
    "public static void main(String arg)",
    "public static void main(Object[] args)",
  ]) {
    const source = golden.source.replace(
      "public static void main(String[] args)",
      signature,
    );
    for (const rule of ruleNames().filter((name) => name !== "prompt/source-manifest")) {
      assert.equal(evaluateRule(rule, workspace(source)), false, `${signature}: ${rule}`);
    }
  }

  for (const signature of [
    "public static void main(String... args)",
    "public static void main(java.lang.String args[])",
  ]) {
    const source = golden.source.replace(
      "public static void main(String[] args)",
      signature,
    );
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace(source)), true, `${signature}: ${rule}`);
    }
  }
});

test.skip("local shadows and wrong-package SDK lookalikes cannot satisfy rules", () => {
  const fake = golden.source
    .replaceAll(
      "import com.azure.messaging.eventgrid.EventGridEvent;",
      "import example.fake.EventGridEvent;",
    )
    .replace(
      "package com.example;",
      `package com.example;
class EventGridEvent {
  static java.util.List<EventGridEvent> fromString(String value) {
    return java.util.List.of();
  }
}`,
    );
  assert.equal(
    evaluateRule("prompt/dual-schema-receivers", workspace(fake)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(fake)),
    false,
  );
});

test.skip("workspace sources cannot redefine exact Azure SDK packages", () => {
  const exactPackageTypes = [
    ["com.azure.core.credential", "TokenCredential", "prompt/secure-client-configuration"],
    ["com.azure.core.exception", "HttpResponseException", "prompt/publish-error-handling"],
    ["com.azure.core.models", "CloudEvent", "prompt/dual-schema-receivers"],
    ["com.azure.core.util", "BinaryData", "prompt/custom-event-publishing"],
    ["com.azure.identity", "AzureCliCredentialBuilder", "prompt/secure-client-configuration"],
    ["com.azure.identity", "DefaultAzureCredentialBuilder", "prompt/secure-client-configuration"],
    ["com.azure.identity", "EnvironmentCredentialBuilder", "prompt/secure-client-configuration"],
    ["com.azure.identity", "ManagedIdentityCredentialBuilder", "prompt/secure-client-configuration"],
    ["com.azure.identity", "WorkloadIdentityCredentialBuilder", "prompt/secure-client-configuration"],
    ["com.azure.messaging.eventgrid", "EventGridEvent", "prompt/dual-schema-receivers"],
    ["com.azure.messaging.eventgrid", "EventGridPublisherAsyncClient", "prompt/custom-event-publishing"],
    ["com.azure.messaging.eventgrid", "EventGridPublisherClient", "prompt/custom-event-publishing"],
    ["com.azure.messaging.eventgrid", "EventGridPublisherClientBuilder", "prompt/secure-client-configuration"],
    ["com.azure.storage.blob", "BlobAsyncClient", "prompt/blob-subject-parsing"],
    ["com.azure.storage.blob", "BlobClient", "prompt/blob-subject-parsing"],
    ["com.azure.storage.blob", "BlobServiceAsyncClient", "prompt/secure-client-configuration"],
    ["com.azure.storage.blob", "BlobServiceClient", "prompt/secure-client-configuration"],
    ["com.azure.storage.blob", "BlobServiceClientBuilder", "prompt/secure-client-configuration"],
    ["com.azure.storage.blob.models", "BlobProperties", "prompt/blob-created-summary"],
    ["com.azure.storage.blob.models", "BlobStorageException", "prompt/blob-race-handling"],
  ];
  for (const [packageName, typeName, rule] of exactPackageTypes) {
    const shadowed = workspace(
      golden.source,
      golden.build,
      [],
      [
        {
          path: "src/main/java/com/example/Application.java",
          source: golden.source,
        },
        {
          path: `src/main/java/${packageName.replaceAll(".", "/")}/${typeName}.java`,
          source: `package ${packageName}; public class ${typeName} {}`,
        },
      ],
    );
    assert.equal(evaluateRule(rule, shadowed), false, `${packageName}.${typeName}`);
    assert.equal(
      evaluateRule("prompt/connected-demo", shadowed),
      false,
      `${packageName}.${typeName}: connected demo`,
    );
  }

  const eventGridShadow = workspace(
    golden.source,
    golden.build,
    [],
    [
      {
        path: "src/main/java/com/example/Application.java",
        source: golden.source,
      },
      {
        path: "src/main/java/com/azure/messaging/eventgrid/EventGridEvent.java",
        source: "package com.azure.messaging.eventgrid; public class EventGridEvent {}",
      },
    ],
  );
  for (const rule of ruleNames().filter((name) => name !== "prompt/source-manifest")) {
    assert.equal(evaluateRule(rule, eventGridShadow), false, rule);
  }
});

test.skip("manual JSON parsing cannot replace either SDK deserializer", () => {
  for (const source of [
    golden.source.replaceAll(
      "EventGridEvent.fromString(payload)",
      "parseEventGridJson(payload)",
    ),
    golden.source.replaceAll(
      "CloudEvent.fromString(payload)",
      "parseCloudEventJson(payload)",
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/dual-schema-receivers", workspace(source)),
      false,
    );
  }
});

test.skip("deserialized events must flow into reachable routing methods", () => {
  const discarded = golden.source
    .replace(
      /for \(EventGridEvent event : EventGridEvent\.fromString\(payload\)\) \{\s*route\(event\.getEventType\(\), event\.getSubject\(\)\);\s*\}/,
      `EventGridEvent.fromString(payload);
        route(BLOB_CREATED, payload);`,
    )
    .replace(
      /for \(CloudEvent event : CloudEvent\.fromString\(payload\)\) \{\s*route\(event\.getType\(\), event\.getSubject\(\)\);\s*\}/,
      `CloudEvent.fromString(payload);
        route(BLOB_DELETED, payload);`,
    )
    .replace(
      /return Flux\.fromIterable\(EventGridEvent\.fromString\(payload\)\)\s*\.concatMap\(event -> routeAsync\(event\.getEventType\(\), event\.getSubject\(\)\)\)\s*\.then\(\);/,
      `EventGridEvent.fromString(payload);
        return routeAsync(BLOB_CREATED, payload);`,
    )
    .replace(
      /return Flux\.fromIterable\(CloudEvent\.fromString\(payload\)\)\s*\.concatMap\(event -> routeAsync\(event\.getType\(\), event\.getSubject\(\)\)\)\s*\.then\(\);/,
      `CloudEvent.fromString(payload);
        return routeAsync(BLOB_DELETED, payload);`,
    );
  assert.doesNotMatch(discarded, /event\.get(?:EventType|Type)\(\)/);
  assert.equal(
    evaluateRule("prompt/dual-schema-receivers", workspace(discarded)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(discarded)),
    false,
  );

  const swappedRoutingInputs = golden.source
    .replaceAll(
      "route(event.getEventType(), event.getSubject())",
      "route(event.getSubject(), event.getEventType())",
    )
    .replaceAll(
      "route(event.getType(), event.getSubject())",
      "route(event.getSubject(), event.getType())",
    )
    .replaceAll(
      "routeAsync(event.getEventType(), event.getSubject())",
      "routeAsync(event.getSubject(), event.getEventType())",
    )
    .replaceAll(
      "routeAsync(event.getType(), event.getSubject())",
      "routeAsync(event.getSubject(), event.getType())",
    );
  assert.equal(
    evaluateRule(
      "prompt/dual-schema-receivers",
      workspace(swappedRoutingInputs),
    ),
    false,
  );

  const unreachableOverloads = golden.source
    .replace(
      /private void route\(String eventType, String subject\) \{\s*if \(BLOB_CREATED\.equals\(eventType\)\) \{\s*handler\.handleCreated\(subject\);\s*\} else if \(BLOB_DELETED\.equals\(eventType\)\) \{\s*handler\.handleDeleted\(subject\);\s*\} else \{\s*LOGGER\.warning\("Ignoring unsupported Event Grid event type: " \+ eventType\);\s*\}\s*\}/,
      `private void route(String eventType, String subject) {
    }

    private void route(String ignored, String eventType, String subject) {
        if (BLOB_CREATED.equals(eventType)) {
            handler.handleCreated(subject);
        } else if (BLOB_DELETED.equals(eventType)) {
            handler.handleDeleted(subject);
        } else {
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }
    }`,
    )
    .replace(
      /private Mono<Void> routeAsync\(String eventType, String subject\) \{\s*if \(BLOB_CREATED\.equals\(eventType\)\) \{\s*return handler\.handleCreatedAsync\(subject\);\s*\}\s*if \(BLOB_DELETED\.equals\(eventType\)\) \{\s*return handler\.handleDeletedAsync\(subject\);\s*\}\s*LOGGER\.warning\("Ignoring unsupported Event Grid event type: " \+ eventType\);\s*return Mono\.empty\(\);\s*\}/,
      `private Mono<Void> routeAsync(String eventType, String subject) {
        return Mono.empty();
    }

    private Mono<Void> routeAsync(String ignored, String eventType, String subject) {
        if (BLOB_CREATED.equals(eventType)) {
            return handler.handleCreatedAsync(subject);
        }
        if (BLOB_DELETED.equals(eventType)) {
            return handler.handleDeletedAsync(subject);
        }
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        return Mono.empty();
    }`,
    );
  assert.match(unreachableOverloads, /route\(String ignored,/);
  assert.match(unreachableOverloads, /routeAsync\(String ignored,/);
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(unreachableOverloads)),
    false,
  );
});

test.skip("same-arity routing overloads select the Java-invoked parameter types", () => {
  const syncRoute =
    /private void route\(String eventType, String subject\) \{\s*if \(BLOB_CREATED\.equals\(eventType\)\) \{\s*handler\.handleCreated\(subject\);\s*\} else if \(BLOB_DELETED\.equals\(eventType\)\) \{\s*handler\.handleDeleted\(subject\);\s*\} else \{\s*LOGGER\.warning\("Ignoring unsupported Event Grid event type: " \+ eventType\);\s*\}\s*\}/;
  const asyncRoute =
    /private Mono<Void> routeAsync\(String eventType, String subject\) \{\s*if \(BLOB_CREATED\.equals\(eventType\)\) \{\s*return handler\.handleCreatedAsync\(subject\);\s*\}\s*if \(BLOB_DELETED\.equals\(eventType\)\) \{\s*return handler\.handleDeletedAsync\(subject\);\s*\}\s*LOGGER\.warning\("Ignoring unsupported Event Grid event type: " \+ eventType\);\s*return Mono\.empty\(\);\s*\}/;

  const unreachableCorrectOverloads = golden.source
    .replace(
      syncRoute,
      `private void route(String eventType, String subject) {
    }

    private void route(Object eventType, Object subject) {
        if (BLOB_CREATED.equals(eventType)) {
            handler.handleCreated(String.valueOf(subject));
        } else if (BLOB_DELETED.equals(eventType)) {
            handler.handleDeleted(String.valueOf(subject));
        } else {
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }
    }`,
    )
    .replace(
      asyncRoute,
      `private Mono<Void> routeAsync(String eventType, String subject) {
        return Mono.empty();
    }

    private Mono<Void> routeAsync(Object eventType, Object subject) {
        if (BLOB_CREATED.equals(eventType)) {
            return handler.handleCreatedAsync(String.valueOf(subject));
        }
        if (BLOB_DELETED.equals(eventType)) {
            return handler.handleDeletedAsync(String.valueOf(subject));
        }
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        return Mono.empty();
    }`,
    );
  assert.equal(
    evaluateRule(
      "prompt/dual-schema-receivers",
      workspace(unreachableCorrectOverloads),
    ),
    false,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(unreachableCorrectOverloads)),
    false,
  );

  const unresolvedArguments = unreachableCorrectOverloads
    .replaceAll(
      "route(event.getEventType(), event.getSubject())",
      "route(event.getEventType().substring(0), event.getSubject().substring(0))",
    )
    .replaceAll(
      "routeAsync(event.getEventType(), event.getSubject())",
      "routeAsync(event.getEventType().substring(0), event.getSubject().substring(0))",
    );
  assert.match(unresolvedArguments, /\.substring\(0\)/);
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(unresolvedArguments)),
    false,
  );

  const validOverloads = golden.source
    .replace(
      syncRoute,
      (route) => `${route}

    private void route(Object eventType, Object subject) {
        throw new IllegalArgumentException("wrong overload");
    }`,
    )
    .replace(
      asyncRoute,
      (route) => `${route}

    private Mono<Void> routeAsync(Object eventType, Object subject) {
        return Mono.error(new IllegalArgumentException("wrong overload"));
    }`,
    );
  assert.equal(
    evaluateRule("prompt/dual-schema-receivers", workspace(validOverloads)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(validOverloads)),
    true,
  );
});

test.skip("static-member argument positions govern routing overload selection", () => {
  const syncRoute =
    /private void route\(String eventType, String subject\) \{\s*if \(BLOB_CREATED\.equals\(eventType\)\) \{\s*handler\.handleCreated\(subject\);\s*\} else if \(BLOB_DELETED\.equals\(eventType\)\) \{\s*handler\.handleDeleted\(subject\);\s*\} else \{\s*LOGGER\.warning\("Ignoring unsupported Event Grid event type: " \+ eventType\);\s*\}\s*\}/;
  const asyncRoute =
    /private Mono<Void> routeAsync\(String eventType, String subject\) \{\s*if \(BLOB_CREATED\.equals\(eventType\)\) \{\s*return handler\.handleCreatedAsync\(subject\);\s*\}\s*if \(BLOB_DELETED\.equals\(eventType\)\) \{\s*return handler\.handleDeletedAsync\(subject\);\s*\}\s*LOGGER\.warning\("Ignoring unsupported Event Grid event type: " \+ eventType\);\s*return Mono\.empty\(\);\s*\}/;
  const withStaticMemberOverloads = golden.source
    .replace(
      syncRoute,
      (route) => `${route.replace(
        "route(String eventType, String subject)",
        "route(String eventType, String subject, java.time.Instant marker)",
      )}

    private void route(
            String eventType, String subject, Object marker) {
        throw new IllegalArgumentException("wrong overload");
    }`,
    )
    .replace(
      asyncRoute,
      (route) => `${route.replace(
        "routeAsync(String eventType, String subject)",
        "routeAsync(String eventType, String subject, java.time.Instant marker)",
      )}

    private Mono<Void> routeAsync(
            String eventType, String subject, Object marker) {
        return Mono.error(new IllegalArgumentException("wrong overload"));
    }`,
    )
    .replaceAll(
      "route(event.getEventType(), event.getSubject())",
      "route(event.getEventType(), event.getSubject(), java.time.Instant.EPOCH)",
    )
    .replaceAll(
      "route(event.getType(), event.getSubject())",
      "route(event.getType(), event.getSubject(), java.time.Instant.EPOCH)",
    )
    .replaceAll(
      "routeAsync(event.getEventType(), event.getSubject())",
      "routeAsync(event.getEventType(), event.getSubject(), java.time.Instant.EPOCH)",
    )
    .replaceAll(
      "routeAsync(event.getType(), event.getSubject())",
      "routeAsync(event.getType(), event.getSubject(), java.time.Instant.EPOCH)",
    );

  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(withStaticMemberOverloads),
    ),
    true,
    "an unshadowed static member selects the precise overload",
  );

  const precedingShadow = withStaticMemberOverloads
    .replaceAll(
      "for (EventGridEvent event :",
      "Object java = null;\n        for (EventGridEvent event :",
    )
    .replaceAll(
      "for (CloudEvent event :",
      "Object java = null;\n        for (CloudEvent event :",
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(precedingShadow)),
    false,
    "a preceding local package-root shadow makes the overload ambiguous",
  );

  const laterShadow = withStaticMemberOverloads
    .replaceAll(
      "java.time.Instant.EPOCH);",
      "java.time.Instant.EPOCH);\n            Object java = null;",
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(laterShadow)),
    true,
    "a later local package-root declaration does not affect the call",
  );
});

test.skip("routing behavior remains attached to the precisely selected overload", () => {
  const addOverloads = (stringBody, objectBody) => golden.source
    .replace(
      "    private void route(String eventType, String subject) {",
      `    private void routeCreated(String subject) {
        ${stringBody}
    }

    private void routeCreated(Object subject) {
        ${objectBody}
    }

    private void route(String eventType, String subject) {`,
    )
    .replace(
      "            handler.handleCreated(subject);",
      "            routeCreated(subject);",
    );

  const behaviorOnWrongOverload = addOverloads(
    'System.out.println("created");',
    "handler.handleCreated(String.valueOf(subject));",
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(behaviorOnWrongOverload),
    ),
    false,
  );

  const behaviorOnSelectedOverload = addOverloads(
    "handler.handleCreated(subject);",
    'throw new IllegalArgumentException("wrong overload");',
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(behaviorOnSelectedOverload),
    ),
    true,
  );
});

test.skip("same-arity receiver overloads cannot lend unreachable deserialization", () => {
  const receiver =
    /    public void receiveEventGrid\(String payload\) \{\r?\n        for \(EventGridEvent event : EventGridEvent\.fromString\(payload\)\) \{\r?\n            route\(event\.getEventType\(\), event\.getSubject\(\)\);\r?\n        \}\r?\n    \}/;
  const unreachableDeserializer = golden.source.replace(
    receiver,
    `    public void receiveEventGrid(String payload) {
    }

    public void receiveEventGrid(Object payload) {
        for (EventGridEvent event : EventGridEvent.fromString(String.valueOf(payload))) {
            route(event.getEventType(), event.getSubject());
        }
    }`,
  );
  assert.match(unreachableDeserializer, /receiveEventGrid\(Object payload\)/);
  assert.equal(
    evaluateRule(
      "prompt/dual-schema-receivers",
      workspace(unreachableDeserializer),
    ),
    false,
  );

  const validReceiverOverload = golden.source.replace(
    receiver,
    (method) => `${method}

    public void receiveEventGrid(Object payload) {
        throw new IllegalArgumentException("wrong overload");
    }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/dual-schema-receivers",
      workspace(validReceiverOverload),
    ),
    true,
  );
});

test.skip("StringBuilder calls select CharSequence overloads over Object", () => {
  const receiver =
    /    public void receiveEventGrid\(String payload\) \{\r?\n        for \(EventGridEvent event : EventGridEvent\.fromString\(payload\)\) \{\r?\n            route\(event\.getEventType\(\), event\.getSubject\(\)\);\r?\n        \}\r?\n    \}/;
  const call = "receiver.receiveEventGrid(EVENT_GRID_PAYLOAD);";

  const unreachableObjectOverload = golden.source
    .replace(
      receiver,
      `    public void receiveEventGrid(CharSequence payload) {
    }

    public void receiveEventGrid(Object payload) {
        for (EventGridEvent event : EventGridEvent.fromString(String.valueOf(payload))) {
            route(event.getEventType(), event.getSubject());
        }
    }`,
    )
    .replace(
      call,
      "receiver.receiveEventGrid(new StringBuilder(EVENT_GRID_PAYLOAD));",
    );
  assert.equal(
    evaluateRule(
      "prompt/dual-schema-receivers",
      workspace(unreachableObjectOverload),
    ),
    false,
  );

  const validInterfaceOverload = golden.source
    .replace(
      receiver,
      `    public void receiveEventGrid(CharSequence payload) {
        for (EventGridEvent event : EventGridEvent.fromString(payload.toString())) {
            route(event.getEventType(), event.getSubject());
        }
    }

    public void receiveEventGrid(Object payload) {
        throw new IllegalArgumentException("wrong overload");
    }`,
    )
    .replace(
      call,
      "receiver.receiveEventGrid(new StringBuilder(EVENT_GRID_PAYLOAD));",
    );
  assert.equal(
    evaluateRule(
      "prompt/dual-schema-receivers",
      workspace(validInterfaceOverload),
    ),
    true,
  );
});

test.skip("local interface implementations resolve precise overload reachability", () => {
  const types = `interface PayloadView {
    String value();
}

record RoutedPayload(String value) implements PayloadView {
}

`;
  const call = "receiver.receiveEventGrid(EVENT_GRID_PAYLOAD);";
  const dispatchedCall =
    "dispatchPayload(new RoutedPayload(EVENT_GRID_PAYLOAD), receiver);";

  const unreachableObjectOverload = golden.source
    .replace(call, dispatchedCall)
    .replace("public final class Main {", `${types}public final class Main {`)
    .replace(
      "    private Main() {",
      `    private static void dispatchPayload(
            PayloadView payload, EventReceiver receiver) {
    }

    private static void dispatchPayload(
            Object payload, EventReceiver receiver) {
        receiver.receiveEventGrid(EVENT_GRID_PAYLOAD);
    }

    private Main() {`,
    );
  assert.equal(
    evaluateRule(
      "prompt/dual-schema-receivers",
      workspace(unreachableObjectOverload),
    ),
    false,
  );

  const validInterfaceOverload = golden.source
    .replace(call, dispatchedCall)
    .replace("public final class Main {", `${types}public final class Main {`)
    .replace(
      "    private Main() {",
      `    private static void dispatchPayload(
            PayloadView payload, EventReceiver receiver) {
        receiver.receiveEventGrid(payload.value());
    }

    private static void dispatchPayload(
            Object payload, EventReceiver receiver) {
        throw new IllegalArgumentException("wrong overload");
    }

    private Main() {`,
    );
  assert.equal(
    evaluateRule(
      "prompt/dual-schema-receivers",
      workspace(validInterfaceOverload),
    ),
    true,
  );
});

test.skip("transitive interface subtyping selects the unique most-specific overload", () => {
  const types = `interface ParentPayload {
    String value();
}

interface ChildPayload extends ParentPayload {
}

record RoutedPayload(String value) implements ChildPayload {
}

`;
  const call = "receiver.receiveEventGrid(EVENT_GRID_PAYLOAD);";
  const dispatchedCall =
    "dispatchPayload(new RoutedPayload(EVENT_GRID_PAYLOAD), receiver);";
  const addDispatch = (parentBody, objectBody) => golden.source
    .replace(call, dispatchedCall)
    .replace("public final class Main {", `${types}public final class Main {`)
    .replace(
      "    private Main() {",
      `    private static void dispatchPayload(
            ParentPayload payload, EventReceiver receiver) {
        ${parentBody}
    }

    private static void dispatchPayload(
            Object payload, EventReceiver receiver) {
        ${objectBody}
    }

    private Main() {`,
    );

  const objectDecoy = addDispatch(
    'throw new IllegalArgumentException("selected parent");',
    "receiver.receiveEventGrid(EVENT_GRID_PAYLOAD);",
  );
  assert.equal(
    evaluateRule("prompt/dual-schema-receivers", workspace(objectDecoy)),
    false,
  );

  const validParent = addDispatch(
    "receiver.receiveEventGrid(payload.value());",
    'throw new IllegalArgumentException("wrong overload");',
  );
  assert.equal(
    evaluateRule("prompt/dual-schema-receivers", workspace(validParent)),
    true,
  );

  const ambiguousTypes = types.replace(
    "interface ChildPayload extends ParentPayload",
    `interface AlternatePayload {
    String value();
}

interface ChildPayload extends ParentPayload, AlternatePayload`,
  );
  const ambiguous = golden.source
    .replace(call, dispatchedCall)
    .replace(
      "public final class Main {",
      `${ambiguousTypes}public final class Main {`,
    )
    .replace(
      "    private Main() {",
      `    private static void dispatchPayload(
            ParentPayload payload, EventReceiver receiver) {
        receiver.receiveEventGrid(payload.value());
    }

    private static void dispatchPayload(
            AlternatePayload payload, EventReceiver receiver) {
        receiver.receiveEventGrid(payload.value());
    }

    private Main() {`,
    );
  assert.equal(
    evaluateRule("prompt/dual-schema-receivers", workspace(ambiguous)),
    false,
  );
});

test.skip("both receiver implementations must route created, deleted, and unknown events", () => {
  const missingDelete = golden.source.replaceAll(
    'BLOB_DELETED.equals(eventType)',
    'BLOB_CREATED.equals(eventType)',
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(missingDelete)),
    false,
  );

  const noWarning = golden.source.replaceAll(
    'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
    "return;",
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(noWarning)),
    false,
  );

  const identicalHandlers = golden.source
    .replaceAll(
      "handler.handleDeleted(subject)",
      "handler.handleCreated(subject)",
    )
    .replaceAll(
      "handler.handleDeletedAsync(subject)",
      "handler.handleCreatedAsync(subject)",
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(identicalHandlers)),
    false,
  );

  const reversedHandlers = golden.source
    .replaceAll("handler.handleCreated(subject)", "handler.__created(subject)")
    .replaceAll("handler.handleDeleted(subject)", "handler.handleCreated(subject)")
    .replaceAll("handler.__created(subject)", "handler.handleDeleted(subject)")
    .replaceAll(
      "handler.handleCreatedAsync(subject)",
      "handler.__createdAsync(subject)",
    )
    .replaceAll(
      "handler.handleDeletedAsync(subject)",
      "handler.handleCreatedAsync(subject)",
    )
    .replaceAll(
      "handler.__createdAsync(subject)",
      "handler.handleDeletedAsync(subject)",
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(reversedHandlers)),
    false,
  );

  for (const source of [
    golden.source.replaceAll(
      "BLOB_CREATED.equals(eventType)",
      "!BLOB_CREATED.equals(eventType)",
    ),
    golden.source.replaceAll(
      "BLOB_DELETED.equals(eventType)",
      "BLOB_DELETED.equals(eventType) == false",
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(source)),
      false,
    );
    assert.equal(
      evaluateRule("prompt/connected-demo", workspace(source)),
      false,
    );
  }
});

test.skip("routing selector provenance follows sequential assignments and merges", () => {
  const withSelector = (setup) => golden.source
    .replace(
      "    private void route(String eventType, String subject) {",
      `    private void route(String eventType, String subject) {
        ${setup}`,
    )
    .replace(
      "    private Mono<Void> routeAsync(String eventType, String subject) {",
      `    private Mono<Void> routeAsync(String eventType, String subject) {
        ${setup}`,
    )
    .replaceAll(
      "BLOB_CREATED.equals(eventType)",
      "BLOB_CREATED.equals(selector)",
    )
    .replaceAll(
      "BLOB_DELETED.equals(eventType)",
      "BLOB_DELETED.equals(selector)",
    );

  for (const setup of [
    `String selector = eventType;
        selector = BLOB_CREATED;`,
    `String selector = eventType;
        selector = subject;`,
    `String selector = eventType;
        if (System.nanoTime() > 0) {
            selector = BLOB_CREATED;
        }`,
    `String selector = eventType;
        for (String ignored : System.getenv().keySet()) {
            selector = BLOB_DELETED;
        }`,
  ]) {
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(withSelector(setup))),
      false,
      setup,
    );
  }

  for (const setup of [
    `String selector = eventType;
        selector = eventType;`,
    `String selector;
        if (System.nanoTime() > 0) {
            selector = eventType;
        } else {
            selector = eventType;
        }`,
    `String selector = BLOB_CREATED;
        for (String ignored : java.util.List.of("once")) {
            selector = eventType;
        }`,
  ]) {
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(withSelector(setup))),
      true,
      setup,
    );
  }

  for (const operator of [
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "&=",
    "|=",
    "^=",
    "<<=",
    ">>=",
    ">>>=",
  ]) {
    const mutated = `String selector = eventType;
        selector ${operator} eventType;`;
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withSelector(mutated)),
      ),
      false,
      operator,
    );
  }

  for (const mutations of [
    "selector++;",
    "++selector;",
    "selector--;",
    "--selector;",
  ]) {
    const mutated = `String selector = eventType;
        ${mutations}`;
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withSelector(mutated)),
      ),
      false,
      mutations,
    );
  }
});

test.skip("routing predicates require a positive selector-to-event equality", () => {
  const replacePredicates = (created, deleted) => golden.source
    .replaceAll("BLOB_CREATED.equals(eventType)", created)
    .replaceAll("BLOB_DELETED.equals(eventType)", deleted);
  for (const [created, deleted] of [
    [
      "BLOB_CREATED.equals(BLOB_CREATED) && eventType != null",
      "BLOB_DELETED.equals(BLOB_DELETED) && eventType != null",
    ],
    [
      `"Microsoft.Storage.BlobCreated".equals("Microsoft.Storage.BlobCreated")
              && eventType.length() > 0`,
      `"Microsoft.Storage.BlobDeleted".equals("Microsoft.Storage.BlobDeleted")
              && eventType.length() > 0`,
    ],
    [
      "eventType != BLOB_CREATED",
      "eventType != BLOB_DELETED",
    ],
    [
      "!eventType.equals(BLOB_CREATED)",
      "!eventType.equals(BLOB_DELETED)",
    ],
    [
      "eventType.equals(BLOB_CREATED) || subject != null",
      "eventType.equals(BLOB_DELETED) || subject != null",
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(replacePredicates(created, deleted)),
      ),
      false,
      created,
    );
  }

  for (const [created, deleted] of [
    [
      "eventType != null && BLOB_CREATED.equals(eventType)",
      "eventType != null && BLOB_DELETED.equals(eventType)",
    ],
    [
      "eventType.equals(BLOB_CREATED)",
      "eventType.equals(BLOB_DELETED)",
    ],
    [
      "eventType == BLOB_CREATED",
      "eventType == BLOB_DELETED",
    ],
    [
      "BLOB_CREATED.equals(eventType) || eventType.equals(BLOB_CREATED)",
      "BLOB_DELETED.equals(eventType) || eventType.equals(BLOB_DELETED)",
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(replacePredicates(created, deleted)),
      ),
      true,
      created,
    );
  }
});

test.skip("routing predicate constants follow source order on every path", () => {
  const withExpectedValues = (setup, created, deleted) => golden.source
    .replace(
      "    private void route(String eventType, String subject) {",
      `    private void route(String eventType, String subject) {
        ${setup}`,
    )
    .replace(
      "    private Mono<Void> routeAsync(String eventType, String subject) {",
      `    private Mono<Void> routeAsync(String eventType, String subject) {
        ${setup}`,
    )
    .replaceAll("BLOB_CREATED.equals(eventType)", created)
    .replaceAll("BLOB_DELETED.equals(eventType)", deleted);

  for (const setup of [
    `String expectedCreated = "Microsoft.Storage.BlobCreated";
        String expectedDeleted = "Microsoft.Storage.BlobDeleted";
        expectedCreated = subject;
        expectedDeleted = subject;`,
    `String expectedCreated = "Microsoft.Storage.BlobCreated";
        String expectedDeleted = "Microsoft.Storage.BlobDeleted";
        if (System.nanoTime() > 0) {
            expectedCreated = subject;
            expectedDeleted = subject;
        }`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withExpectedValues(
          setup,
          "expectedCreated.equals(eventType)",
          "expectedDeleted.equals(eventType)",
        )),
      ),
      false,
      setup,
    );
  }
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(withExpectedValues(
        `String BLOB_CREATED;
        String BLOB_DELETED;`,
        "BLOB_CREATED.equals(eventType)",
        "BLOB_DELETED.equals(eventType)",
      )),
    ),
    false,
  );

  for (const setup of [
    `String expectedCreated = BLOB_CREATED;
        String expectedDeleted = BLOB_DELETED;`,
    `String expectedCreated = "Microsoft.Storage." + "BlobCreated";
        String expectedDeleted = "Microsoft.Storage." + "BlobDeleted";`,
    `String expectedCreated;
        String expectedDeleted;
        if (System.nanoTime() > 0) {
            expectedCreated = BLOB_CREATED;
            expectedDeleted = BLOB_DELETED;
        } else {
            expectedCreated = "Microsoft.Storage.BlobCreated";
            expectedDeleted = "Microsoft.Storage.BlobDeleted";
        }`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withExpectedValues(
          setup,
          "expectedCreated.equals(eventType)",
          "expectedDeleted.equals(eventType)",
        )),
      ),
      true,
      setup,
    );
  }
});

test.skip("routing predicates reject side effects before selector equality", () => {
  const withPredicates = (setup, created, deleted) => golden.source
    .replace(
      "    private void route(String eventType, String subject) {",
      `    private void route(String eventType, String subject) {
        ${setup}`,
    )
    .replace(
      "    private Mono<Void> routeAsync(String eventType, String subject) {",
      `    private Mono<Void> routeAsync(String eventType, String subject) {
        ${setup}`,
    )
    .replaceAll("BLOB_CREATED.equals(eventType)", created)
    .replaceAll("BLOB_DELETED.equals(eventType)", deleted);

  const expectedValues = `String expectedCreated = BLOB_CREATED;
        String expectedDeleted = BLOB_DELETED;`;
  const assignment = withPredicates(
    expectedValues,
    "(expectedCreated = subject) != null && expectedCreated.equals(eventType)",
    "(expectedDeleted = subject) != null && expectedDeleted.equals(eventType)",
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(assignment)),
    false,
  );

  const increments = withPredicates(
    `${expectedValues}
        int checks = 0;`,
    "checks++ >= 0 && expectedCreated.equals(eventType)",
    "++checks > 0 && expectedDeleted.equals(eventType)",
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(increments)),
    false,
  );

  const mutatingCall = withPredicates(
    expectedValues,
    "mutateSelector(subject) && expectedCreated.equals(eventType)",
    "mutateSelector(subject) && expectedDeleted.equals(eventType)",
  )
    .replace(
      "public final class EventReceiver {",
      `public final class EventReceiver {
    private static String observedSelector;

    private static boolean mutateSelector(String value) {
        observedSelector = value;
        return value != null;
    }`,
    )
    .replace(
      "public final class AsyncEventReceiver {",
      `public final class AsyncEventReceiver {
    private static String observedSelector;

    private static boolean mutateSelector(String value) {
        observedSelector = value;
        return value != null;
    }`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(mutatingCall)),
    false,
  );

  const pure = withPredicates(
    expectedValues,
    "eventType != null && eventType.length() > 0 && expectedCreated.equals(eventType)",
    "eventType != null && eventType.length() > 0 && expectedDeleted.equals(eventType)",
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(pure)),
    true,
  );
});

test.skip("routing predicates require trusted calls and satisfiable conjunctions", () => {
  const withPredicates = (setup, created, deleted) => golden.source
    .replace(
      "public final class EventReceiver {",
      `final class PredicateProbe {
    boolean contains(String value) { return true; }
          @Override
          public boolean equals(Object value) { return true; }
    int length() { return 1; }
}

public final class EventReceiver {`,
    )
    .replace(
      "    private void route(String eventType, String subject) {",
      `    private void route(String eventType, String subject) {
        ${setup}`,
    )
    .replace(
      "    private Mono<Void> routeAsync(String eventType, String subject) {",
      `    private Mono<Void> routeAsync(String eventType, String subject) {
        ${setup}`,
    )
    .replaceAll("BLOB_CREATED.equals(eventType)", created)
    .replaceAll("BLOB_DELETED.equals(eventType)", deleted);

  for (const [created, deleted] of [
    [
      "eventType.isEmpty() && BLOB_CREATED.equals(eventType)",
      "eventType.isEmpty() && BLOB_DELETED.equals(eventType)",
    ],
    [
      "eventType.length() == 0 && BLOB_CREATED.equals(eventType)",
      "eventType.length() == 0 && BLOB_DELETED.equals(eventType)",
    ],
    [
      'eventType.startsWith("Contoso.") && BLOB_CREATED.equals(eventType)',
      'eventType.startsWith("Contoso.") && BLOB_DELETED.equals(eventType)',
    ],
    [
      "subject != null && BLOB_CREATED.equals(eventType)",
      "subject != null && BLOB_DELETED.equals(eventType)",
    ],
    [
      "probe.contains(eventType) && BLOB_CREATED.equals(eventType)",
      "probe.contains(eventType) && BLOB_DELETED.equals(eventType)",
    ],
    [
      "probe.length() > 0 && BLOB_CREATED.equals(eventType)",
      "probe.length() > 0 && BLOB_DELETED.equals(eventType)",
    ],
    [
      "probe.equals(subject) && BLOB_CREATED.equals(eventType)",
      "probe.equals(subject) && BLOB_DELETED.equals(eventType)",
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withPredicates(
          "PredicateProbe probe = new PredicateProbe();",
          created,
          deleted,
        )),
      ),
      false,
      created,
    );
  }

  for (const [created, deleted] of [
    [
      `eventType.length() > 0
              && eventType.startsWith("Microsoft.Storage.")
              && eventType.endsWith("BlobCreated")
              && BLOB_CREATED.equals(eventType)`,
      `eventType.length() > 0
              && eventType.startsWith("Microsoft.Storage.")
              && eventType.endsWith("BlobDeleted")
              && BLOB_DELETED.equals(eventType)`,
    ],
    [
      `eventType.contains("Storage")
              && eventType.length() == BLOB_CREATED.length()
              && BLOB_CREATED.equals(eventType)`,
      `eventType.contains("Storage")
              && eventType.length() == BLOB_DELETED.length()
              && BLOB_DELETED.equals(eventType)`,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withPredicates("", created, deleted)),
      ),
      true,
      created,
    );
  }
});

test.skip("trusted JDK static receivers honor source-ordered value shadows", () => {
  const withFakeReceiver = golden.source.replace(
    "public final class EventReceiver {",
    `final class PredicateProbe {
    boolean nonNull(Object value) {
        return true;
    }
}

public final class EventReceiver {`,
  );
  const withObjectsPredicates = (source) => source
    .replaceAll(
      "import java.util.logging.Logger;",
      "import java.util.Objects;\nimport java.util.logging.Logger;",
    )
    .replaceAll(
      "BLOB_CREATED.equals(eventType)",
      "Objects.nonNull(eventType) && BLOB_CREATED.equals(eventType)",
    )
    .replaceAll(
      "BLOB_DELETED.equals(eventType)",
      "Objects.nonNull(eventType) && BLOB_DELETED.equals(eventType)",
    );

  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(withObjectsPredicates(golden.source)),
    ),
    true,
  );

  const localShadow = withObjectsPredicates(withFakeReceiver)
    .replace(
      "private void route(String eventType, String subject) {",
      `private void route(String eventType, String subject) {
        PredicateProbe Objects = new PredicateProbe();`,
    )
    .replace(
      "private Mono<Void> routeAsync(String eventType, String subject) {",
      `private Mono<Void> routeAsync(String eventType, String subject) {
        PredicateProbe Objects = new PredicateProbe();`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(localShadow)),
    false,
  );

  const fieldShadow = withObjectsPredicates(withFakeReceiver)
    .replace(
      "public final class EventReceiver {",
      `public final class EventReceiver {
    private final PredicateProbe Objects = new PredicateProbe();`,
    )
    .replace(
      "public final class AsyncEventReceiver {",
      `public final class AsyncEventReceiver {
    private final PredicateProbe Objects = new PredicateProbe();`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(fieldShadow)),
    false,
  );

  const parameterShadow = withObjectsPredicates(withFakeReceiver)
    .replaceAll(
      "route(event.getEventType(), event.getSubject())",
      "route(event.getEventType(), event.getSubject(), new PredicateProbe())",
    )
    .replaceAll(
      "route(event.getType(), event.getSubject())",
      "route(event.getType(), event.getSubject(), new PredicateProbe())",
    )
    .replaceAll(
      "routeAsync(event.getEventType(), event.getSubject())",
      "routeAsync(event.getEventType(), event.getSubject(), new PredicateProbe())",
    )
    .replaceAll(
      "routeAsync(event.getType(), event.getSubject())",
      "routeAsync(event.getType(), event.getSubject(), new PredicateProbe())",
    )
    .replace(
      "private void route(String eventType, String subject) {",
      "private void route(String eventType, String subject, PredicateProbe Objects) {",
    )
    .replace(
      "private Mono<Void> routeAsync(String eventType, String subject) {",
      "private Mono<Void> routeAsync(String eventType, String subject, PredicateProbe Objects) {",
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(parameterShadow)),
    false,
  );

  const lateLocalShadow = withObjectsPredicates(withFakeReceiver)
    .replace(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      `PredicateProbe Objects = new PredicateProbe();
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);`,
    )
    .replace(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      `PredicateProbe Objects = new PredicateProbe();
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(lateLocalShadow)),
    true,
  );

  const qualifiedWithFields = fieldShadow.replaceAll(
    "Objects.nonNull(eventType)",
    "java.util.Objects.nonNull(eventType)",
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(qualifiedWithFields),
    ),
    true,
  );
});

test.skip("fully qualified JDK receivers honor leading package value shadows", () => {
  const withFakeReceiver = golden.source.replace(
    "public final class EventReceiver {",
    `final class PredicateProbe {
    boolean nonNull(Object value) {
        return true;
    }
}

public final class EventReceiver {`,
  );
  const qualifiedPredicates = (source) => source
    .replaceAll(
      "BLOB_CREATED.equals(eventType)",
      "java.util.Objects.nonNull(eventType) && BLOB_CREATED.equals(eventType)",
    )
    .replaceAll(
      "BLOB_DELETED.equals(eventType)",
      "java.util.Objects.nonNull(eventType) && BLOB_DELETED.equals(eventType)",
    );

  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(qualifiedPredicates(golden.source)),
    ),
    true,
  );

  const localShadow = qualifiedPredicates(withFakeReceiver)
    .replace(
      "private void route(String eventType, String subject) {",
      `private void route(String eventType, String subject) {
        PredicateProbe java = new PredicateProbe();`,
    )
    .replace(
      "private Mono<Void> routeAsync(String eventType, String subject) {",
      `private Mono<Void> routeAsync(String eventType, String subject) {
        PredicateProbe java = new PredicateProbe();`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(localShadow)),
    false,
    "a local java value shadows the package root",
  );

  const fieldShadow = qualifiedPredicates(withFakeReceiver)
    .replace(
      "public final class EventReceiver {",
      `public final class EventReceiver {
    private final PredicateProbe java = new PredicateProbe();`,
    )
    .replace(
      "public final class AsyncEventReceiver {",
      `public final class AsyncEventReceiver {
    private final PredicateProbe java = new PredicateProbe();`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(fieldShadow)),
    false,
    "a java field shadows the package root",
  );

  const parameterShadow = qualifiedPredicates(withFakeReceiver)
    .replaceAll(
      "route(event.getEventType(), event.getSubject())",
      "route(event.getEventType(), event.getSubject(), new PredicateProbe())",
    )
    .replaceAll(
      "route(event.getType(), event.getSubject())",
      "route(event.getType(), event.getSubject(), new PredicateProbe())",
    )
    .replaceAll(
      "routeAsync(event.getEventType(), event.getSubject())",
      "routeAsync(event.getEventType(), event.getSubject(), new PredicateProbe())",
    )
    .replaceAll(
      "routeAsync(event.getType(), event.getSubject())",
      "routeAsync(event.getType(), event.getSubject(), new PredicateProbe())",
    )
    .replace(
      "private void route(String eventType, String subject) {",
      "private void route(String eventType, String subject, PredicateProbe java) {",
    )
    .replace(
      "private Mono<Void> routeAsync(String eventType, String subject) {",
      "private Mono<Void> routeAsync(String eventType, String subject, PredicateProbe java) {",
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(parameterShadow)),
    false,
    "a java parameter shadows the package root",
  );

  const lateLocalShadow = qualifiedPredicates(withFakeReceiver)
    .replace(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      `PredicateProbe java = new PredicateProbe();
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);`,
    )
    .replace(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      `PredicateProbe java = new PredicateProbe();
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(lateLocalShadow)),
    true,
    "a later java local does not shadow an earlier package-root call",
  );
});

test.skip("trusted JDK receivers detect every comma-separated shadow declarator", () => {
  const withFakeReceiver = golden.source.replace(
    "public final class EventReceiver {",
    `final class PredicateProbe {
    boolean nonNull(Object value) {
        return true;
    }
}

public final class EventReceiver {`,
  );
  const withObjectsPredicates = (source) => source
    .replaceAll(
      "import java.util.logging.Logger;",
      "import java.util.Objects;\nimport java.util.logging.Logger;",
    )
    .replaceAll(
      "BLOB_CREATED.equals(eventType)",
      "Objects.nonNull(eventType) && BLOB_CREATED.equals(eventType)",
    )
    .replaceAll(
      "BLOB_DELETED.equals(eventType)",
      "Objects.nonNull(eventType) && BLOB_DELETED.equals(eventType)",
    );

  const localShadow = withObjectsPredicates(withFakeReceiver)
    .replace(
      "private void route(String eventType, String subject) {",
      `private void route(String eventType, String subject) {
        PredicateProbe first = new PredicateProbe(), Objects;`,
    )
    .replace(
      "private Mono<Void> routeAsync(String eventType, String subject) {",
      `private Mono<Void> routeAsync(String eventType, String subject) {
        PredicateProbe first, Objects = new PredicateProbe();`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(localShadow)),
    false,
  );

  const fieldShadow = withObjectsPredicates(withFakeReceiver)
    .replace(
      "public final class EventReceiver {",
      `public final class EventReceiver {
    private final PredicateProbe first = new PredicateProbe(), Objects = first;`,
    )
    .replace(
      "public final class AsyncEventReceiver {",
      `public final class AsyncEventReceiver {
    private PredicateProbe first, Objects = new PredicateProbe();`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(fieldShadow)),
    false,
  );

  const qualified = fieldShadow.replaceAll(
    "Objects.nonNull(eventType)",
    "java.util.Objects.nonNull(eventType)",
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(qualified)),
    true,
  );

  const lateLocalShadow = withObjectsPredicates(withFakeReceiver)
    .replace(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      `PredicateProbe first = new PredicateProbe(), Objects;
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);`,
    )
    .replace(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      `PredicateProbe first, Objects = new PredicateProbe();
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(lateLocalShadow)),
    true,
  );

  const directCollections = golden.source.replaceAll(
    /        List<EventGridEvent> events = notifications\.stream\(\)[\s\S]*?                \.toList\(\);/g,
    `        List<EventGridEvent> events = java.util.Collections.singletonList(
                new EventGridEvent(
                        subject,
                        "Contoso.Documents.Processed",
                        BinaryData.fromObject(notifications.get(0)),
                        "1.0"));`,
  );
  const collectionShadow = directCollections
    .replace(
      "public final class EventPublisher {",
      `final class FakeCollections {
    java.util.List<EventGridEvent> singletonList(EventGridEvent event) {
        return java.util.List.of();
    }
}

public final class EventPublisher {
    private FakeCollections first = new FakeCollections(), Collections = first;`,
    )
    .replace(
      "public final class AsyncEventPublisher {",
      `public final class AsyncEventPublisher {
    private FakeCollections first, Collections = new FakeCollections();`,
    )
    .replaceAll(
      "java.util.Collections.singletonList(",
      "Collections.singletonList(",
    );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(collectionShadow),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(directCollections),
    ),
    true,
  );
});

test.skip("routing targets require created operations and authentic deletion logging", () => {
  const namedCreatedOnly = golden.source.replace(
    /public void handleCreated\(String subject\) \{[\s\S]*?\r?\n    \}\r?\n\r?\n    public void handleDeleted/,
    `    public void handleCreated(String subject) {
        System.out.println("name only");
    }

    public void handleDeleted`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(namedCreatedOnly)),
    false,
  );

  const namedDeletedOnly = golden.source.replace(
    /public void handleDeleted\(String subject\) \{[\s\S]*?\r?\n    \}\r?\n\}/,
    `    public void handleDeleted(String subject) {
        LOGGER.info("unrelated lifecycle message");
    }
}`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(namedDeletedOnly)),
    false,
  );
});

test.skip("deletion routing requires one authentic identity-bearing deletion log", () => {
  const replaceDeletionHandlers = (syncBody, asyncBody) => golden.source
    .replace(
      /    public void handleDeleted\(String subject\) \{\s*BlobSubject blobSubject = BlobSubject\.parse\(subject\);\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\);\s*\}/,
      `    public void handleDeleted(String subject) {
${syncBody}
    }`,
    )
    .replace(
      /    public Mono<Void> handleDeletedAsync\(String subject\) \{\s*BlobSubject blobSubject = BlobSubject\.parse\(subject\);\s*return Mono\.fromRunnable\(\(\) ->\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\)\);\s*\}/,
      `    public Mono<Void> handleDeletedAsync(String subject) {
${asyncBody}
    }`,
    );

  for (const [label, source] of [
    ["separate marker", replaceDeletionHandlers(
      `        BlobSubject blobSubject = BlobSubject.parse(subject);
        LOGGER.info("Processed lifecycle event: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        String deletionMarker = "deleted";`,
      `        BlobSubject blobSubject = BlobSubject.parse(subject);
        String deletionMarker = "removed";
        return Mono.fromRunnable(() -> LOGGER.info(
                "Processed lifecycle event: "
                        + blobSubject.containerName() + "/" + blobSubject.blobName()));`,
    )],
    ["split calls", replaceDeletionHandlers(
      `        BlobSubject blobSubject = BlobSubject.parse(subject);
        LOGGER.info("Blob deleted");
        LOGGER.info("Blob identity: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());`,
      `        BlobSubject blobSubject = BlobSubject.parse(subject);
        return Mono.fromRunnable(() -> {
            LOGGER.info("Blob removed");
            LOGGER.info("Blob identity: "
                    + blobSubject.containerName() + "/" + blobSubject.blobName());
        });`,
    )],
  ]) {
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(source)),
      false,
      label,
    );
  }

  const systemLogging = replaceDeletionHandlers(
    '        System.err.println("Blob removed: " + subject);',
    `        return Mono.fromRunnable(() ->
                System.out.println("Blob deleted: " + subject));`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(systemLogging)),
    true,
  );

  const helperLogging = golden.source
    .replace(
      "    public void handleDeleted(String subject) {",
      `    private static void logRemoval(BlobSubject parsed) {
        LOGGER.info("Blob removed: "
                + parsed.containerName() + "/" + parsed.blobName());
    }

    public void handleDeleted(String subject) {`,
    )
    .replace(
      '        LOGGER.info("Blob deleted: " + blobSubject.containerName() + "/" + blobSubject.blobName());',
      "        logRemoval(blobSubject);",
    )
    .replace(
      "    public Mono<Void> handleDeletedAsync(String subject) {",
      `    private static void logRemoval(BlobSubject parsed) {
        LOGGER.info("Blob removed: "
                + parsed.containerName() + "/" + parsed.blobName());
    }

    public Mono<Void> handleDeletedAsync(String subject) {`,
    )
    .replace(
      /        return Mono\.fromRunnable\(\(\) ->\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\)\);/,
      "        return Mono.fromRunnable(() -> logRemoval(blobSubject));",
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(helperLogging)),
    true,
  );
});

test.skip("deletion logger receivers follow authentic source-ordered provenance", () => {
  const replaceDeletionHandlers = (
    syncBody,
    asyncBody,
    base = golden.source,
  ) => base
    .replace(
      /    public void handleDeleted\(String subject\) \{\s*BlobSubject blobSubject = BlobSubject\.parse\(subject\);\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\);\s*\}/,
      `    public void handleDeleted(String subject) {
${syncBody}
    }`,
    )
    .replace(
      /    public Mono<Void> handleDeletedAsync\(String subject\) \{\s*BlobSubject blobSubject = BlobSubject\.parse\(subject\);\s*return Mono\.fromRunnable\(\(\) ->\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\)\);\s*\}/,
      `    public Mono<Void> handleDeletedAsync(String subject) {
${asyncBody}
    }`,
    );
  const handlers = (declaration, call, base = golden.source) =>
    replaceDeletionHandlers(
    `        ${declaration}
        ${call}`,
    `        return Mono.fromRunnable(() -> {
            ${declaration}
            ${call}
        });`,
      base,
    );
  const fakeLoggerFactory = golden.source
    .replace(
      "public final class BlobEventHandler {",
      `public final class BlobEventHandler {
    private static Logger fakeLogger() {
        return null;
    }`,
    )
    .replace(
      "public final class AsyncBlobEventHandler {",
      `public final class AsyncBlobEventHandler {
    private static Logger fakeLogger() {
        return null;
    }`,
    );
  const constructorAssigned = golden.source
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(BlobEventHandler.class.getName());",
      "private final Logger LOGGER;",
    )
    .replace(
      /(public BlobEventHandler\(BlobServiceClient serviceClient\) \{\s*this\.serviceClient = serviceClient;)/,
      `$1
        this.LOGGER = Logger.getLogger(BlobEventHandler.class.getName());`,
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(AsyncBlobEventHandler.class.getName());",
      "private final Logger LOGGER;",
    )
    .replace(
      /(public AsyncBlobEventHandler\(BlobServiceAsyncClient serviceClient\) \{\s*this\.serviceClient = serviceClient;)/,
      `$1
        this.LOGGER = Logger.getLogger(AsyncBlobEventHandler.class.getName());`,
    );

  for (const source of [
    handlers(
      "Logger deletionLogger = null;",
      'deletionLogger.info("Blob deleted: " + subject);',
    ),
    handlers(
      "Logger deletionLogger;",
      'deletionLogger.info("Blob deleted: " + subject);',
    ),
    handlers(
      "Logger deletionLogger = fakeLogger();",
      'deletionLogger.info("Blob deleted: " + subject);',
      fakeLoggerFactory,
    ),
    handlers(
      `Logger deletionLogger = LOGGER;
        deletionLogger = null;`,
      'deletionLogger.info("Blob deleted: " + subject);',
    ),
    handlers(
      `Logger deletionLogger = LOGGER;
        if (System.nanoTime() > 0) {
            deletionLogger = null;
        }`,
      'deletionLogger.info("Blob deleted: " + subject);',
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(source)),
      false,
    );
  }

  for (const source of [
    constructorAssigned,
    handlers(
      "Logger deletionLogger = LOGGER;",
      'deletionLogger.info("Blob deleted: " + subject);',
    ),
    handlers(
      "Logger deletionLogger = this.LOGGER;",
      'deletionLogger.info("Blob deleted: " + subject);',
    ),
    handlers(
      `Logger deletionLogger;
        if (System.nanoTime() > 0) {
            deletionLogger = LOGGER;
        } else {
            deletionLogger = Logger.getLogger("deletions");
        }`,
      'deletionLogger.info("Blob deleted: " + subject);',
    ),
    handlers(
      "var deletionLogger = System.err;",
      'deletionLogger.println("Blob deleted: " + subject);',
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(source)),
      true,
    );
  }
});

test.skip("warnings outside the unsupported-event fallback do not satisfy routing", () => {
  const knownBranchWarnings = golden.source
    .replaceAll(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      "",
    )
    .replace(
      "handler.handleCreated(subject);",
      `LOGGER.warning("Created event received");
            handler.handleCreated(subject);`,
    )
    .replace(
      "return handler.handleCreatedAsync(subject);",
      `LOGGER.warning("Created event received");
            return handler.handleCreatedAsync(subject);`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(knownBranchWarnings)),
    false,
  );

  const nearbyWarnings = golden.source
    .replaceAll(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      "",
    )
    .replaceAll(
      "if (BLOB_CREATED.equals(eventType)) {",
      `LOGGER.warning("Routing event: " + eventType);
        if (BLOB_CREATED.equals(eventType)) {`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(nearbyWarnings)),
    false,
  );
});

test.skip("unknown-event fallbacks reject fake logger lookalikes", () => {
  const fakeLogger = golden.source
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(EventReceiver.class.getName());",
      `private static final FakeLogger LOGGER = new FakeLogger();

    private static final class FakeLogger {
        void warning(String message) {
        }
    }`,
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(AsyncEventReceiver.class.getName());",
      `private static final FakeLogger LOGGER = new FakeLogger();

    private static final class FakeLogger {
        void warning(String message) {
        }
    }`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(fakeLogger)),
    false,
  );

  const arbitraryWarn = golden.source
    .replaceAll(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      "new WarningSink().warn(eventType);",
    )
    .replace(
      "public final class EventReceiver {",
      `public final class EventReceiver {
    private static final class WarningSink {
        void warn(String message) {
        }
    }`,
    )
    .replace(
      "public final class AsyncEventReceiver {",
      `public final class AsyncEventReceiver {
    private static final class WarningSink {
        void warn(String message) {
        }
    }`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(arbitraryWarn)),
    false,
  );

  const standardError = golden.source.replaceAll(
    'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
    'System.err.println("Ignoring unsupported Event Grid event type: " + eventType);',
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(standardError)),
    true,
  );

  const slf4j = golden.source
    .replace(
      "public final class EventReceiver {",
      `public final class EventReceiver {
    private static final org.slf4j.Logger ROUTING_LOGGER =
            org.slf4j.LoggerFactory.getLogger(EventReceiver.class);`,
    )
    .replace(
      "public final class AsyncEventReceiver {",
      `public final class AsyncEventReceiver {
    private static final org.slf4j.Logger ROUTING_LOGGER =
            org.slf4j.LoggerFactory.getLogger(AsyncEventReceiver.class);`,
    )
    .replaceAll(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      'ROUTING_LOGGER.warn("Ignoring unsupported Event Grid event type: {}", eventType);',
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(slf4j)),
    true,
  );

  const localFactory = golden.source.replace(
    "public final class EventReceiver {",
    `final class LoggerFactory {
    private LoggerFactory() {
    }
}

public final class EventReceiver {`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(localFactory)),
    false,
  );

  for (const [path, source] of [
    [
      "src/main/java/java/util/logging/Logger.java",
      "package java.util.logging; public class Logger {}",
    ],
    [
      "src/main/java/org/slf4j/Logger.java",
      "package org.slf4j; public interface Logger { void warn(String value); }",
    ],
    [
      "src/main/java/org/slf4j/LoggerFactory.java",
      "package org.slf4j; public final class LoggerFactory {}",
    ],
  ]) {
    const candidate = path.includes("org/slf4j")
      ? slf4j
      : golden.source;
    const shadowed = workspace(
      candidate,
      golden.build,
      [],
      [
        {
          path: "src/main/java/com/example/Application.java",
          source: candidate,
        },
        { path, source },
      ],
    );
    assert.equal(
      evaluateRule("prompt/event-routing", shadowed),
      false,
      path,
    );
  }
});

test.skip("trusted logger helper, imported SLF4J, and System.Logger forms are accepted", () => {
  const helperLogger = golden.source
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(EventReceiver.class.getName());",
      `private static final Logger LOGGER = createLogger(EventReceiver.class);

    private static Logger createLogger(Class<?> type) {
        return Logger.getLogger(type.getName());
    }`,
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(AsyncEventReceiver.class.getName());",
      `private static final Logger LOGGER = createLogger(AsyncEventReceiver.class);

    private static Logger createLogger(Class<?> type) {
        return Logger.getLogger(type.getName());
    }`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(helperLogger)),
    true,
  );

  const importedSlf4j = golden.source
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(BlobEventHandler.class.getName());",
      "private static final java.util.logging.Logger LOGGER = java.util.logging.Logger.getLogger(BlobEventHandler.class.getName());",
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(AsyncBlobEventHandler.class.getName());",
      "private static final java.util.logging.Logger LOGGER = java.util.logging.Logger.getLogger(AsyncBlobEventHandler.class.getName());",
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(EventPublisher.class.getName());",
      "private static final java.util.logging.Logger LOGGER = java.util.logging.Logger.getLogger(EventPublisher.class.getName());",
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(AsyncEventPublisher.class.getName());",
      "private static final java.util.logging.Logger LOGGER = java.util.logging.Logger.getLogger(AsyncEventPublisher.class.getName());",
    )
    .replaceAll("import java.util.logging.Logger;", "")
    .replace(
      "package com.example;",
      `package com.example;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;`,
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(EventReceiver.class.getName());",
      "private static final Logger ROUTING_LOGGER = LoggerFactory.getLogger(EventReceiver.class);",
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(AsyncEventReceiver.class.getName());",
      "private static final Logger ROUTING_LOGGER = LoggerFactory.getLogger(AsyncEventReceiver.class);",
    )
    .replaceAll(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      'ROUTING_LOGGER.warn("Ignoring unsupported Event Grid event type: {}", eventType);',
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(importedSlf4j)),
    true,
  );

  const systemLogger = golden.source
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(EventReceiver.class.getName());",
      "private static final System.Logger ROUTING_LOGGER = System.getLogger(EventReceiver.class.getName());",
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(AsyncEventReceiver.class.getName());",
      "private static final System.Logger ROUTING_LOGGER = System.getLogger(AsyncEventReceiver.class.getName());",
    )
    .replaceAll(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      'ROUTING_LOGGER.log(System.Logger.Level.WARNING, "Ignoring unsupported Event Grid event type: " + eventType);',
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(systemLogger)),
    true,
  );
});

test.skip("terminating known branches with a warning fallthrough are accepted", () => {
  const fallthrough = golden.source.replace(
    `if (BLOB_CREATED.equals(eventType)) {
            handler.handleCreated(subject);
        } else if (BLOB_DELETED.equals(eventType)) {
            handler.handleDeleted(subject);
        } else {
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }`,
    `if (BLOB_CREATED.equals(eventType)) {
            handler.handleCreated(subject);
            return;
        }
        if (BLOB_DELETED.equals(eventType)) {
            handler.handleDeleted(subject);
            return;
        }
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(fallthrough)),
    true,
  );

  const helperWarning = fallthrough
    .replaceAll(
      'LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);',
      "warnUnsupported(eventType);",
    )
    .replace(
      "    private void route(String eventType, String subject) {",
      `    private static void warnUnsupported(String eventType) {
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
    }

    private void route(String eventType, String subject) {`,
    )
    .replace(
      "    private Mono<Void> routeAsync(String eventType, String subject) {",
      `    private static void warnUnsupported(String eventType) {
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
    }

    private Mono<Void> routeAsync(String eventType, String subject) {`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(helperWarning)),
    true,
  );
});

test.skip("braceless if chains and classic switch routing are accepted", () => {
  const braceless = golden.source
    .replace(
      `if (BLOB_CREATED.equals(eventType)) {
            handler.handleCreated(subject);
        } else if (BLOB_DELETED.equals(eventType)) {
            handler.handleDeleted(subject);
        } else {
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }`,
      `if (BLOB_CREATED.equals(eventType))
            handler.handleCreated(subject);
        else if (BLOB_DELETED.equals(eventType))
            handler.handleDeleted(subject);
        else
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);`,
    )
    .replace(
      `if (BLOB_CREATED.equals(eventType)) {
            return handler.handleCreatedAsync(subject);
        }
        if (BLOB_DELETED.equals(eventType)) {
            return handler.handleDeletedAsync(subject);
        }
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        return Mono.empty();`,
      `if (BLOB_CREATED.equals(eventType))
            return handler.handleCreatedAsync(subject);
        else if (BLOB_DELETED.equals(eventType))
            return handler.handleDeletedAsync(subject);
        else {
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
            return Mono.empty();
        }`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(braceless)),
    true,
  );

  const classicSwitch = golden.source
    .replace(
      `if (BLOB_CREATED.equals(eventType)) {
            handler.handleCreated(subject);
        } else if (BLOB_DELETED.equals(eventType)) {
            handler.handleDeleted(subject);
        } else {
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }`,
      `switch (eventType) {
            case BLOB_CREATED:
                handler.handleCreated(subject);
                break;
            case BLOB_DELETED:
                handler.handleDeleted(subject);
                break;
            default:
                LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }`,
    )
    .replace(
      `if (BLOB_CREATED.equals(eventType)) {
            return handler.handleCreatedAsync(subject);
        }
        if (BLOB_DELETED.equals(eventType)) {
            return handler.handleDeletedAsync(subject);
        }
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        return Mono.empty();`,
      `switch (eventType) {
            case BLOB_CREATED:
                return handler.handleCreatedAsync(subject);
            case BLOB_DELETED:
                return handler.handleDeletedAsync(subject);
            default:
                LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
                return Mono.empty();
        }`,
    );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(classicSwitch)),
    true,
  );
});

test.skip("classic switch cases stop at default unless they genuinely fall through", () => {
  const original =
    /if \(BLOB_CREATED\.equals\(eventType\)\) \{\s*handler\.handleCreated\(subject\);\s*\} else if \(BLOB_DELETED\.equals\(eventType\)\) \{\s*handler\.handleDeleted\(subject\);\s*\} else \{\s*LOGGER\.warning\("Ignoring unsupported Event Grid event type: " \+ eventType\);\s*\}/;
  for (const replacement of [
    `switch (eventType) {
            case BLOB_CREATED:
                handler.handleCreated(subject);
                break;
            case BLOB_DELETED:
                break;
            default:
                handler.handleDeleted(subject);
                LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }`,
    `switch (eventType) {
            case BLOB_CREATED:
                break;
            case BLOB_DELETED:
                handler.handleDeleted(subject);
                return;
            default:
                handler.handleCreated(subject);
                LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(golden.source.replace(original, replacement)),
      ),
      false,
      replacement,
    );
  }

  const validFallthrough = golden.source.replace(
    original,
    `switch (eventType) {
            case BLOB_CREATED:
                handler.handleCreated(subject);
            default:
                LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
                break;
            case BLOB_DELETED:
                handler.handleDeleted(subject);
                break;
        }`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(validFallthrough)),
    true,
  );
});

test.skip("routing wrappers must preserve distinct semantic handler targets", () => {
  const wrapRouting = (source, sameTarget) => source
    .replace("handler.handleCreated(subject);", "forwardCreated(subject);")
    .replace("handler.handleDeleted(subject);", "forwardDeleted(subject);")
    .replace(
      "    private void route(String eventType, String subject) {",
      `    private void forwardCreated(String subject) {
        handler.handleCreated(subject);
    }

    private void forwardDeleted(String subject) {
        handler.${sameTarget ? "handleCreated" : "handleDeleted"}(subject);
    }

    private void route(String eventType, String subject) {`,
    )
    .replace(
      "return handler.handleCreatedAsync(subject);",
      "return forwardCreatedAsync(subject);",
    )
    .replace(
      "return handler.handleDeletedAsync(subject);",
      "return forwardDeletedAsync(subject);",
    )
    .replace(
      "    private Mono<Void> routeAsync(String eventType, String subject) {",
      `    private Mono<Void> forwardCreatedAsync(String subject) {
        return handler.handleCreatedAsync(subject);
    }

    private Mono<Void> forwardDeletedAsync(String subject) {
        return handler.${sameTarget ? "handleCreatedAsync" : "handleDeletedAsync"}(subject);
    }

    private Mono<Void> routeAsync(String eventType, String subject) {`,
    );

  assert.equal(
    evaluateRule("prompt/event-routing", workspace(wrapRouting(golden.source, false))),
    true,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(wrapRouting(golden.source, true))),
    false,
  );
});

test.skip("subject parsing preserves nested blob names and rejects fixed path indexes", () => {
  const splitParser = golden.source.replace(
    /public static BlobSubject parse\(String subject\) \{[\s\S]*?return new BlobSubject\([\s\S]*?\);\s*\}/,
    `public static BlobSubject parse(String subject) {
        String[] pieces = subject.split("/");
        return new BlobSubject(
                URLDecoder.decode(pieces[4], StandardCharsets.UTF_8),
                URLDecoder.decode(pieces[6], StandardCharsets.UTF_8));
    }`,
  );
  assert.equal(
    evaluateRule("prompt/blob-subject-parsing", workspace(splitParser)),
    false,
  );

  const constantParser = golden.source.replace(
    /return new BlobSubject\(\s*URLDecoder\.decode\(container,[\s\S]*?URLDecoder\.decode\(blob,[\s\S]*?\);/,
    'return new BlobSubject("fixed-container", "fixed/blob.txt");',
  );
  assert.equal(
    evaluateRule("prompt/blob-subject-parsing", workspace(constantParser)),
    false,
  );
});

test.skip("subject parsing removes exact markers before returning values", () => {
  const parserBody = (containerStart, blobStart) => `public static BlobSubject parse(String subject) {
        int containerMarker = subject.indexOf(CONTAINER_MARKER);
        int blobMarker = subject.indexOf(BLOB_MARKER, containerMarker + CONTAINER_MARKER.length());
        if (containerMarker < 0 || blobMarker < 0) {
            throw new IllegalArgumentException(subject);
        }
        String container = subject.substring(${containerStart}, blobMarker);
        String blob = subject.substring(${blobStart});
        return new BlobSubject(
                URLDecoder.decode(container, StandardCharsets.UTF_8),
                URLDecoder.decode(blob, StandardCharsets.UTF_8));
    }`;
  const replaceParser = (body) => golden.source.replace(
    /public static BlobSubject parse\(String subject\) \{[\s\S]*?return new BlobSubject\([\s\S]*?\);\s*\}/,
    body,
  );

  for (const invalid of [
    parserBody("containerMarker", "blobMarker + BLOB_MARKER.length()"),
    parserBody(
      "containerMarker + CONTAINER_MARKER.length()",
      "blobMarker",
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/blob-subject-parsing", workspace(replaceParser(invalid))),
      false,
    );
  }

  const exactOffsets = parserBody(
    'containerMarker + "/containers/".length()',
    'blobMarker + "/blobs/".length()',
  );
  assert.equal(
    evaluateRule(
      "prompt/blob-subject-parsing",
      workspace(replaceParser(exactOffsets)),
    ),
    true,
  );
});

test.skip("created-event operations must be connected on one executable path", () => {
  const incompatible = golden.source.replace(
    /BlobProperties properties = blob\.getProperties\(\);\r?\n\s*blob\.downloadContent\(\);/,
    `BlobProperties properties;
            if (System.nanoTime() > 0) {
                properties = blob.getProperties();
            } else {
                blob.downloadContent();
                properties = null;
            }`,
  );
  assert.equal(
    evaluateRule("prompt/blob-created-summary", workspace(incompatible)),
    false,
  );

  const uncalledDownload = golden.source
    .replace("blob.downloadContent();", "downloadUnused(blob);")
    .replace(
      "public void handleDeleted(String subject) {",
      `private static void downloadUnused(BlobClient blob) {
        blob.downloadContent();
    }

    public void handleDeleted(String subject) {`,
    )
    .replace("downloadUnused(blob);", "");
  assert.equal(
    evaluateRule("prompt/blob-created-summary", workspace(uncalledDownload)),
    false,
  );

  const differentBlob = golden.source.replace(
    "blob.downloadContent();",
    `BlobClient otherBlob = serviceClient
                    .getBlobContainerClient("other-container")
                    .getBlobClient("unrelated.txt");
            otherBlob.downloadContent();`,
  );
  assert.equal(
    evaluateRule("prompt/blob-created-summary", workspace(differentBlob)),
    false,
  );
});

test.skip("same-blob identity is preserved through helper parameters", () => {
  const helperSource = (downloadTarget) => golden.source
    .replace(
      /BlobProperties properties = blob\.getProperties\(\);\r?\n\s*blob\.downloadContent\(\);/,
      `BlobProperties properties = readProperties(blob);
            BlobClient otherBlob = serviceClient
                    .getBlobContainerClient("other-container")
                    .getBlobClient("same-name.txt");
            downloadBlob(${downloadTarget});`,
    )
    .replace(
      "    public void handleDeleted(String subject) {",
      `    private static BlobProperties readProperties(BlobClient blob) {
        return blob.getProperties();
    }

    private static void downloadBlob(BlobClient blob) {
        blob.downloadContent();
    }

    public void handleDeleted(String subject) {`,
    );

  assert.equal(
    evaluateRule("prompt/blob-created-summary", workspace(helperSource("otherBlob"))),
    false,
  );
  assert.equal(
    evaluateRule("prompt/blob-created-summary", workspace(helperSource("blob"))),
    true,
  );
});

test.skip("parsed identities must build the BlobClient used by operations", () => {
  const unrelatedParsedClient = golden.source
    .replace(
      /BlobClient blob = serviceClient\s*\.getBlobContainerClient\(blobSubject\.containerName\(\)\)\s*\.getBlobClient\(blobSubject\.blobName\(\)\);/,
      `BlobClient parsedButUnused = serviceClient
                .getBlobContainerClient(blobSubject.containerName())
                .getBlobClient(blobSubject.blobName());
        BlobClient blob = serviceClient
                .getBlobContainerClient("fixed-container")
                .getBlobClient("fixed/blob.txt");`,
    )
    .replace(
      /BlobAsyncClient blob = serviceClient\s*\.getBlobContainerAsyncClient\(blobSubject\.containerName\(\)\)\s*\.getBlobAsyncClient\(blobSubject\.blobName\(\)\);/,
      `BlobAsyncClient parsedButUnused = serviceClient
                .getBlobContainerAsyncClient(blobSubject.containerName())
                .getBlobAsyncClient(blobSubject.blobName());
        BlobAsyncClient blob = serviceClient
                .getBlobContainerAsyncClient("fixed-container")
                .getBlobAsyncClient("fixed/blob.txt");`,
    );
  assert.match(unrelatedParsedClient, /parsedButUnused/);
  assert.equal(
    evaluateRule(
      "prompt/blob-subject-parsing",
      workspace(unrelatedParsedClient),
    ),
    false,
  );
});

test.skip("subject and BlobSubject assignments invalidate stale parsed provenance", () => {
  const replacedBlobSubject = golden.source.replace(
    "BlobSubject blobSubject = BlobSubject.parse(subject);",
    `BlobSubject blobSubject = BlobSubject.parse(subject);
        blobSubject = new BlobSubject("fixed-container", "fixed/blob.txt");`,
  );
  assert.equal(
    evaluateRule(
      "prompt/blob-subject-parsing",
      workspace(replacedBlobSubject),
    ),
    false,
  );

  for (const iterable of [
    "java.util.List.of()",
    "System.getenv().keySet()",
  ]) {
    const loopReplacement = golden.source.replace(
      "BlobSubject blobSubject = BlobSubject.parse(subject);",
      `BlobSubject blobSubject = new BlobSubject("fixed", "fixed");
        for (String ignored : ${iterable}) {
            blobSubject = BlobSubject.parse(subject);
        }`,
    );
    assert.equal(
      evaluateRule(
        "prompt/blob-subject-parsing",
        workspace(loopReplacement),
      ),
      false,
      iterable,
    );
  }

  const validSubjectLoop = golden.source.replace(
    "BlobSubject blobSubject = BlobSubject.parse(subject);",
    `BlobSubject blobSubject = new BlobSubject("unused", "unused");
        for (String ignored : java.util.List.of("once")) {
            blobSubject = BlobSubject.parse(subject);
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/blob-subject-parsing",
      workspace(validSubjectLoop),
    ),
    true,
  );

  const staleRoutingSubject = golden.source
    .replace(
      "    private void route(String eventType, String subject) {",
      `    private void route(String eventType, String subject) {
        String routedSubject = subject;
        routedSubject = "/fixed";`,
    )
    .replace("handler.handleCreated(subject)", "handler.handleCreated(routedSubject)")
    .replace("handler.handleDeleted(subject)", "handler.handleDeleted(routedSubject)");
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(staleRoutingSubject)),
    false,
  );

  const validRoutingMerge = golden.source
    .replace(
      "    private void route(String eventType, String subject) {",
      `    private void route(String eventType, String subject) {
        String routedSubject;
        if (System.nanoTime() > 0) {
            routedSubject = subject;
        } else {
            routedSubject = subject;
        }`,
    )
    .replace("handler.handleCreated(subject)", "handler.handleCreated(routedSubject)")
    .replace("handler.handleDeleted(subject)", "handler.handleDeleted(routedSubject)");
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(validRoutingMerge)),
    true,
  );

  const validAliasReassignment = golden.source.replace(
    "BlobSubject blobSubject = BlobSubject.parse(subject);",
    `BlobSubject parsedSubject = BlobSubject.parse(subject);
        BlobSubject blobSubject = new BlobSubject("unused", "unused");
        blobSubject = parsedSubject;`,
  );
  assert.equal(
    evaluateRule(
      "prompt/blob-subject-parsing",
      workspace(validAliasReassignment),
    ),
    true,
  );

  const validBranchMerge = golden.source.replace(
    "BlobSubject blobSubject = BlobSubject.parse(subject);",
    `BlobSubject blobSubject;
        if (System.nanoTime() > 0) {
            blobSubject = BlobSubject.parse(subject);
        } else {
            blobSubject = BlobSubject.parse(subject);
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/blob-subject-parsing",
      workspace(validBranchMerge),
    ),
    true,
  );
});

test.skip("404 handling must be selective and preserve non-404 failures", () => {
  const swallowAll = golden.source
    .replaceAll("if (exception.getStatusCode() == 404) {", "if (true) {")
    .replaceAll("throw exception;", "return;");
  assert.equal(
    evaluateRule("prompt/blob-race-handling", workspace(swallowAll)),
    false,
  );

  const asyncSwallow = golden.source.replaceAll(
    "return Mono.error(exception);",
    "return Mono.empty();",
  );
  assert.equal(
    evaluateRule("prompt/blob-race-handling", workspace(asyncSwallow)),
    false,
  );

  const reversedSync = golden.source.replace(
    /if \(exception\.getStatusCode\(\) == 404\) \{\r?\n\s*LOGGER\.warning\("Blob disappeared before it could be read: " \+ blobSubject\.blobName\(\)\);\r?\n\s*return;\r?\n\s*\}\r?\n\s*throw exception;/,
    `if (exception.getStatusCode() == 404) {
                throw exception;
            }
            LOGGER.warning("Blob disappeared before it could be read: " + blobSubject.blobName());
            return;`,
  );
  assert.equal(
    evaluateRule("prompt/blob-race-handling", workspace(reversedSync)),
    false,
  );

  const reversedAsync = golden.source.replace(
    /if \(exception\.getStatusCode\(\) == 404\) \{\r?\n\s*LOGGER\.warning\("Blob disappeared before it could be read: " \+ blobSubject\.blobName\(\)\);\r?\n\s*return Mono\.empty\(\);\r?\n\s*\}\r?\n\s*return Mono\.error\(exception\);/,
    `if (exception.getStatusCode() == 404) {
                        return Mono.error(exception);
                    }
                    LOGGER.warning("Blob disappeared before it could be read: " + blobSubject.blobName());
                    return Mono.empty();`,
  );
  assert.equal(
    evaluateRule("prompt/blob-race-handling", workspace(reversedAsync)),
    false,
  );

  const equivalentPolarity = golden.source
    .replace(
      /if \(exception\.getStatusCode\(\) == 404\) \{\r?\n\s*LOGGER\.warning\("Blob disappeared before it could be read: " \+ blobSubject\.blobName\(\)\);\r?\n\s*return;\r?\n\s*\}\r?\n\s*throw exception;/,
      `if (exception.getStatusCode() != 404) {
                throw exception;
            }
            LOGGER.warning("Blob disappeared before it could be read: " + blobSubject.blobName());
            return;`,
    )
    .replace(
      /if \(exception\.getStatusCode\(\) == 404\) \{\r?\n\s*LOGGER\.warning\("Blob disappeared before it could be read: " \+ blobSubject\.blobName\(\)\);\r?\n\s*return Mono\.empty\(\);\r?\n\s*\}\r?\n\s*return Mono\.error\(exception\);/,
      `if (exception.getStatusCode() != 404) {
                        return Mono.error(exception);
                    }
                    LOGGER.warning("Blob disappeared before it could be read: " + blobSubject.blobName());
                    return Mono.empty();`,
    );
  assert.equal(
    evaluateRule(
      "prompt/blob-race-handling",
      workspace(equivalentPolarity),
    ),
    true,
  );

  const helperHandler = golden.source
    .replace(
      /if \(exception\.getStatusCode\(\) == 404\) \{\r?\n\s*LOGGER\.warning\("Blob disappeared before it could be read: " \+ blobSubject\.blobName\(\)\);\r?\n\s*return;\r?\n\s*\}\r?\n\s*throw exception;/,
      "handleReadFailure(exception);",
    )
    .replace(
      "    public void handleDeleted(String subject) {",
      `    private static void handleReadFailure(BlobStorageException exception) {
        if (exception.getStatusCode() == 404) {
            LOGGER.warning("Blob disappeared before it could be read");
            return;
        }
        throw exception;
    }

    public void handleDeleted(String subject) {`,
    );
  assert.equal(
    evaluateRule("prompt/blob-race-handling", workspace(helperHandler)),
    true,
  );
});

test.skip("custom events require connected EventGridEvent creation, subject hierarchy, and sends", () => {
  const noSend = golden.source
    .replace("client.sendEvents(events);", "System.out.println(events);")
    .replace("return client.sendEvents(events)", "return Mono.empty()");
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(noSend)),
    false,
  );

  const wrongSubject = golden.source.replaceAll(
    "/documents/invoices/processed",
    "processed",
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(wrongSubject)),
    false,
  );

  const unsentEvents = golden.source.replaceAll(
    "client.sendEvents(events)",
    "client.sendEvents(List.of())",
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(unsentEvents)),
    false,
  );

  const disconnectedSubject = golden.source.replaceAll(
    "                        subject,",
    '                        "processed",',
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(disconnectedSubject),
    ),
    false,
  );
});

test.skip("custom events must derive subject and notification data from publisher inputs", () => {
  const fixedSubject = golden.source.replaceAll(
    "                        subject,",
    '                        "/documents/fixed/processed",',
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(fixedSubject)),
    false,
  );

  const fixedNotification = golden.source.replaceAll(
    "BinaryData.fromObject(notification)",
    'BinaryData.fromObject(new DownstreamNotification("fixed", "processed"))',
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(fixedNotification)),
    false,
  );

  const subjectAsData = golden.source.replaceAll(
    "BinaryData.fromObject(notification)",
    "BinaryData.fromObject(subject)",
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(subjectAsData)),
    false,
  );

  const dataAsSubject = golden.source
    .replace(
      "public void publish(String subject, List<DownstreamNotification> notifications)",
      "public void publish(String subject, String dataPath, List<DownstreamNotification> notifications)",
    )
    .replace(
      "public Mono<Void> publishAsync(String subject, List<DownstreamNotification> notifications)",
      "public Mono<Void> publishAsync(String subject, String dataPath, List<DownstreamNotification> notifications)",
    )
    .replaceAll("                        subject,", "                        dataPath,")
    .replace(
      "publisher.publish(notificationSubject, notifications)",
      'publisher.publish(notificationSubject, "/documents/data/processed", notifications)',
    )
    .replace(
      "asyncPublisher.publishAsync(notificationSubject, notifications)",
      'asyncPublisher.publishAsync(notificationSubject, "/documents/data/processed", notifications)',
    );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(dataAsSubject)),
    false,
  );

  const aliases = golden.source
    .replaceAll(
      "        List<EventGridEvent> events = notifications.stream()",
      `        String derivedSubject = subject;
        List<DownstreamNotification> suppliedNotifications = notifications;
        List<EventGridEvent> events = suppliedNotifications.stream()`,
    )
    .replaceAll(
      "                        subject,",
      "                        derivedSubject,",
    );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(aliases)),
    true,
  );
});

test.skip("renamed Java publisher inputs preserve subject and payload roles", () => {
  const renamed = golden.source
    .replace(
      "public void publish(String subject, List<DownstreamNotification> notifications)",
      "public void publish(String subjectPath, List<DownstreamNotification> payloads)",
    )
    .replace(
      "public Mono<Void> publishAsync(String subject, List<DownstreamNotification> notifications)",
      "public Mono<Void> publishAsync(String subjectPath, List<DownstreamNotification> payloads)",
    )
    .replaceAll("notifications.stream()", "payloads.stream()")
    .replaceAll("                        subject,", "                        subjectPath,");
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(renamed)),
    true,
  );
});

test.skip("trusted JDK collection factories reject source-ordered value shadows", () => {
  const directCollections = golden.source.replaceAll(
    /        List<EventGridEvent> events = notifications\.stream\(\)[\s\S]*?                \.toList\(\);/g,
    `        List<EventGridEvent> events = List.of(
                new EventGridEvent(
                        subject,
                        "Contoso.Documents.Processed",
                        BinaryData.fromObject(notifications.get(0)),
                        "1.0"));`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(directCollections),
    ),
    true,
  );

  const shadowed = directCollections
    .replace(
      "public final class EventPublisher {",
      `final class FakeListFactory {
    java.util.List<EventGridEvent> of(EventGridEvent event) {
        return java.util.List.of();
    }
}

public final class EventPublisher {`,
    )
    .replaceAll(
      "        List<EventGridEvent> events = List.of(",
      `        FakeListFactory List = new FakeListFactory();
        List<EventGridEvent> events = List.of(`,
    );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(shadowed)),
    false,
  );

  const lateShadow = directCollections.replaceAll(
    "        client.sendEvents(events);",
    `        client.sendEvents(events);
        FakeListFactory List = new FakeListFactory();`,
  )
    .replace(
      "public final class EventPublisher {",
      `final class FakeListFactory {
    java.util.List<EventGridEvent> of(EventGridEvent event) {
        return java.util.List.of();
    }
}

public final class EventPublisher {`,
    );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(lateShadow),
    ),
    true,
  );
});

test.skip("Java publisher helpers map caller arguments to fields and sent payloads", () => {
  const withPublisherHelpers = (source, fixed) => source
    .replace(
      "    public void publish(String subject, List<DownstreamNotification> notifications) {",
      `    private List<EventGridEvent> buildEvents(
            String subjectPath,
            List<DownstreamNotification> payloads) {
        return payloads.stream()
                .map(payload -> new EventGridEvent(
                        subjectPath,
                        "Contoso.Documents.Processed",
                        BinaryData.fromObject(payload),
                        "1.0"))
                .toList();
    }

    private void sendBatch(List<EventGridEvent> batch) {
        client.sendEvents(batch);
    }

    public void publish(String subject, List<DownstreamNotification> notifications) {`,
    )
    .replace(
      /        List<EventGridEvent> events = notifications\.stream\(\)[\s\S]*?                \.toList\(\);/,
      fixed
        ? `        List<EventGridEvent> events = buildEvents(
                "/documents/fixed/processed",
                List.of(new DownstreamNotification("fixed", "processed")));`
        : "        List<EventGridEvent> events = buildEvents(subject, notifications);",
    )
    .replace("            client.sendEvents(events);", "            sendBatch(events);")
    .replace(
      "    public Mono<Void> publishAsync(String subject, List<DownstreamNotification> notifications) {",
      `    private List<EventGridEvent> buildEvents(
            String subjectPath,
            List<DownstreamNotification> payloads) {
        return payloads.stream()
                .map(payload -> new EventGridEvent(
                        subjectPath,
                        "Contoso.Documents.Processed",
                        BinaryData.fromObject(payload),
                        "1.0"))
                .toList();
    }

    private Mono<Void> sendBatch(List<EventGridEvent> batch) {
        return client.sendEvents(batch);
    }

    public Mono<Void> publishAsync(String subject, List<DownstreamNotification> notifications) {`,
    )
    .replace(
      /        List<EventGridEvent> events = notifications\.stream\(\)[\s\S]*?                \.toList\(\);/,
      fixed
        ? `        List<EventGridEvent> events = buildEvents(
                "/documents/fixed/processed",
                List.of(new DownstreamNotification("fixed", "processed")));`
        : "        List<EventGridEvent> events = buildEvents(subject, notifications);",
    )
    .replace("        return client.sendEvents(events)", "        return sendBatch(events)");

  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(withPublisherHelpers(golden.source, true)),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(withPublisherHelpers(golden.source, false)),
    ),
    true,
  );
});

test.skip("publisher provenance follows reassignments, branches, and loops", () => {
  const reassignEvents = (source, statement) => source.replaceAll(
    "                .toList();",
    `                .toList();
        ${statement}`,
  );
  const withEmptyHelpers = golden.source
    .replace(
      "    public void publish(String subject, List<DownstreamNotification> notifications) {",
      `    private List<EventGridEvent> replacementEvents() {
        return List.of();
    }

    public void publish(String subject, List<DownstreamNotification> notifications) {`,
    )
    .replace(
      "    public Mono<Void> publishAsync(String subject, List<DownstreamNotification> notifications) {",
      `    private List<EventGridEvent> replacementEvents() {
        return List.of();
    }

    public Mono<Void> publishAsync(String subject, List<DownstreamNotification> notifications) {`,
    );

  for (const source of [
    reassignEvents(golden.source, "events = List.of();"),
    reassignEvents(golden.source, "events = null;"),
    reassignEvents(withEmptyHelpers, "events = replacementEvents();"),
    reassignEvents(
      golden.source,
      `if (System.nanoTime() > 0) {
            events = List.of();
        }`,
    ),
    reassignEvents(
      golden.source,
      `for (String ignored : System.getenv().keySet()) {
            events = List.of();
        }`,
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/custom-event-publishing", workspace(source)),
      false,
    );
  }

  for (const statement of [
    `List<EventGridEvent> suppliedEvents = events;
        events = suppliedEvents;`,
    `List<EventGridEvent> suppliedEvents = events;
        if (System.nanoTime() > 0) {
            events = suppliedEvents;
        } else {
            events = suppliedEvents;
        }`,
    `List<EventGridEvent> suppliedEvents = events;
        for (String ignored : java.util.List.of("once")) {
            events = suppliedEvents;
        }`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/custom-event-publishing",
        workspace(reassignEvents(golden.source, statement)),
      ),
      true,
      statement,
    );
  }
});

test.skip("publisher switch paths preserve provenance through termination and fallthrough", () => {
  const reassignBoth = (statement) => golden.source.replaceAll(
    "                .toList();",
    `                .toList();
        ${statement}`,
  );
  const invalidCase = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        switch ((int) (System.nanoTime() % 2)) {
            case 0:
                events = List.of();
                break;
            default:
                events = suppliedEvents;
                break;
        }`,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(invalidCase)),
    false,
  );

  const invalidDefault = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        switch ((int) (System.nanoTime() % 2)) {
            case 0:
                events = suppliedEvents;
                break;
            default:
                events = List.of();
        }`,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(invalidDefault)),
    false,
  );

  for (const statement of [
    `List<EventGridEvent> suppliedEvents = events;
        switch ((int) (System.nanoTime() % 2)) {
            case 0:
                events = suppliedEvents;
                break;
            default:
                events = suppliedEvents;
                break;
        }`,
    `List<EventGridEvent> suppliedEvents = events;
        switch ((int) (System.nanoTime() % 2)) {
            case 0:
                events = List.of();
            default:
                events = suppliedEvents;
                break;
        }`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/custom-event-publishing",
        workspace(reassignBoth(statement)),
      ),
      true,
      statement,
    );
  }

  const syncTerminating = golden.source.replace(
    "                .toList();",
    `                .toList();
        List<EventGridEvent> suppliedEvents = events;
        switch ((int) (System.nanoTime() % 3)) {
            case 0:
                return;
            case 1:
                throw new IllegalStateException("not publishing");
            default:
                events = suppliedEvents;
                break;
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(syncTerminating),
    ),
    true,
  );

  const asyncMarker =
    "        return client.sendEvents(events)\n" +
    "                .onErrorResume(HttpResponseException.class, exception -> {";
  const asyncTerminating = golden.source.replace(
    asyncMarker,
    `        List<EventGridEvent> suppliedEvents = events;
        switch ((int) (System.nanoTime() % 3)) {
            case 0:
                return Mono.empty();
            case 1:
                throw new IllegalStateException("not publishing");
            default:
                events = suppliedEvents;
                break;
        }
${asyncMarker}`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(asyncTerminating),
    ),
    true,
  );
});

test.skip("publisher switch continues stop the targeted loop iteration", () => {
  const reassignBoth = (statement) => golden.source.replaceAll(
    "                .toList();",
    `                .toList();
        ${statement}`,
  );
  for (const continuation of ["continue;", "continue publishAttempt;"]) {
    const invalid = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        for (int attempt = 0; attempt < 1; attempt++) {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    events = List.of();
                    ${continuation}
                default:
                    events = suppliedEvents;
                    break;
            }
            events = suppliedEvents;
        }`,
    );
    assert.equal(
      evaluateRule("prompt/custom-event-publishing", workspace(invalid)),
      false,
      continuation,
    );
  }

  const valid = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        for (int attempt = 0; attempt < 1; attempt++) {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    continue publishAttempt;
                default:
                    events = suppliedEvents;
                    break;
            }
            events = suppliedEvents;
        }`,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(valid)),
    true,
  );

  for (const continuation of ["continue;", "continue publishAttempt;"]) {
    const updateRestoresAfterFinally = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        for (int attempt = 0;
                attempt < 1;
                events = suppliedEvents, attempt++) {
            try {
                events = suppliedEvents;
                ${continuation}
            } finally {
                events = List.of();
            }
        }`,
    );
    assert.equal(
      evaluateRule(
        "prompt/custom-event-publishing",
        workspace(updateRestoresAfterFinally),
      ),
      true,
      `for update restores after finally before ${continuation}`,
    );

    const updateInvalidatesAfterFinally = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        for (int attempt = 0;
                attempt < 1;
                events = List.of(), attempt++) {
            try {
                events = List.of();
                ${continuation}
            } finally {
                events = suppliedEvents;
            }
        }`,
    );
    assert.equal(
      evaluateRule(
        "prompt/custom-event-publishing",
        workspace(updateInvalidatesAfterFinally),
      ),
      false,
      `for update invalidates after finally before ${continuation}`,
    );

  }

  const terminatingConditionRestores = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        for (int attempt = 0;
                (events = suppliedEvents) != null && attempt < 1;
                events = List.of(), attempt++) {
            try {
                events = List.of();
                continue;
            } finally {
                events = List.of();
            }
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(terminatingConditionRestores),
    ),
    true,
    "terminating for condition restores after finally and update",
  );

  const terminatingConditionInvalidates = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        for (int attempt = 0;
                (events = List.of()) != null && attempt < 1;
                events = suppliedEvents, attempt++) {
            try {
                events = suppliedEvents;
                continue;
            } finally {
                events = suppliedEvents;
            }
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(terminatingConditionInvalidates),
    ),
    false,
    "terminating for condition invalidates after finally and update",
  );

  const emptyUpdateConditionRestores = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        for (int attempt = 0;
                (events = suppliedEvents) != null && attempt++ < 1;
                ) {
            try {
                events = suppliedEvents;
                continue;
            } finally {
                events = List.of();
            }
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(emptyUpdateConditionRestores),
    ),
    true,
    "empty-update for condition restores after continue and finally",
  );

  const emptyUpdateConditionInvalidates = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        for (int attempt = 0;
                (events = List.of()) != null && attempt++ < 1;
                ) {
            try {
                events = List.of();
                continue;
            } finally {
                events = suppliedEvents;
            }
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(emptyUpdateConditionInvalidates),
    ),
    false,
    "empty-update for condition invalidates after continue and finally",
  );

  const breakSkipsTerminatingCondition = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        for (int attempt = 0;
                (events = suppliedEvents) != null && attempt < 1;
                events = List.of(), attempt++) {
            events = List.of();
            break;
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(breakSkipsTerminatingCondition),
    ),
    false,
    "break skips the update and terminating for condition",
  );

  const nestedContinueKeepsOuterUpdateDeferred = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        for (int attempt = 0;
                attempt < 1;
                events = List.of(), attempt++) {
            for (int inner = 0; inner < 1; inner++) {
                events = suppliedEvents;
                continue;
            }
            events = suppliedEvents;
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(nestedContinueKeepsOuterUpdateDeferred),
    ),
    false,
    "unlabeled inner continue runs only the inner update",
  );

  for (const [label, condition, expected] of [
    [
      "zero-iteration for loop ignores updates",
      "int attempt = 0; attempt < 0; events = List.of(), attempt++",
      true,
    ],
    [
      "multi-iteration for loop carries invalid update state",
      "int attempt = 0; attempt < 2; events = List.of(), attempt++",
      false,
    ],
  ]) {
    const source = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        for (${condition}) {
            events = suppliedEvents;
        }`,
    );
    assert.equal(
      evaluateRule("prompt/custom-event-publishing", workspace(source)),
      expected,
      label,
    );
  }

  for (const continuation of ["continue;", "continue publishAttempt;"]) {
    const invalidDoWhile = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        do {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    events = List.of();
                    ${continuation}
                default:
                    events = suppliedEvents;
                    break;
            }
            events = suppliedEvents;
        } while (false);`,
    );
    assert.equal(
      evaluateRule(
        "prompt/custom-event-publishing",
        workspace(invalidDoWhile),
      ),
      false,
      `do-while ${continuation}`,
    );
  }

  const validDoWhile = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        do {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    continue publishAttempt;
                default:
                    events = suppliedEvents;
                    break;
            }
            events = suppliedEvents;
        } while (false);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(validDoWhile),
    ),
    true,
  );

  for (const continuation of ["continue;", "continue publishAttempt;"]) {
    const restoredByCondition = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        do {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    events = List.of();
                    ${continuation}
                default:
                    events = suppliedEvents;
                    break;
            }
            events = suppliedEvents;
        } while ((events = suppliedEvents) == null);`,
    );
    assert.equal(
      evaluateRule(
        "prompt/custom-event-publishing",
        workspace(restoredByCondition),
      ),
      true,
      `do-while condition restores after ${continuation}`,
    );

    const invalidatedByCondition = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        do {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    events = suppliedEvents;
                    ${continuation}
                default:
                    events = suppliedEvents;
                    break;
            }
            events = suppliedEvents;
        } while ((events = List.of()) != null && false);`,
    );
    assert.equal(
      evaluateRule(
        "prompt/custom-event-publishing",
        workspace(invalidatedByCondition),
      ),
      false,
      `do-while condition invalidates after ${continuation}`,
    );
  }

  const invalidBlockContinue = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        publishBlock: {
            events = List.of();
            continue publishBlock;
        }
        events = suppliedEvents;`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(invalidBlockContinue),
    ),
    false,
  );
});

test.skip("publisher abrupt controls execute enclosing finally blocks", () => {
  const reassignBoth = (statement) => golden.source.replaceAll(
    "                .toList();",
    `                .toList();
        ${statement}`,
  );

  for (const control of ["continue;", "break;"]) {
    const restored = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        for (int attempt = 0; attempt < 1; attempt++) {
            try {
                events = List.of();
                ${control}
            } finally {
                events = suppliedEvents;
            }
        }`,
    );
    assert.equal(
      evaluateRule("prompt/custom-event-publishing", workspace(restored)),
      true,
      `finally restores before ${control}`,
    );

    const invalidated = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        for (int attempt = 0; attempt < 1; attempt++) {
            try {
                events = suppliedEvents;
                ${control}
            } finally {
                events = List.of();
            }
        }`,
    );
    assert.equal(
      evaluateRule("prompt/custom-event-publishing", workspace(invalidated)),
      false,
      `finally invalidates before ${control}`,
    );
  }

  for (const [label, finalAssignment, expected] of [
    ["restores", "events = suppliedEvents;", true],
    ["invalidates", "events = List.of();", false],
  ]) {
    const switchBreak = reassignBoth(
      `List<EventGridEvent> suppliedEvents = events;
        switch ((int) (System.nanoTime() % 2)) {
            case 0:
                try {
                    events = List.of();
                    break;
                } finally {
                    ${finalAssignment}
                }
            default:
                events = suppliedEvents;
                break;
        }`,
    );
    assert.equal(
      evaluateRule("prompt/custom-event-publishing", workspace(switchBreak)),
      expected,
      `finally ${label} before the switch break target`,
    );
  }

  const labeledContinue = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        for (int attempt = 0; attempt < 1; attempt++) {
            try {
                events = List.of();
                continue publishAttempt;
            } finally {
                events = suppliedEvents;
            }
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(labeledContinue),
    ),
    true,
    "labeled continue executes the exited try finally block",
  );

  const restoredDoWhile = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        do {
            try {
                events = List.of();
                continue;
            } finally {
                events = suppliedEvents;
            }
        } while (false);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(restoredDoWhile),
    ),
    true,
    "do-while continue executes its finally block",
  );

  const invalidatedDoWhile = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        do {
            try {
                events = suppliedEvents;
                continue;
            } finally {
                events = List.of();
            }
        } while (false);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(invalidatedDoWhile),
    ),
    false,
    "do-while continue retains mandatory finally invalidation",
  );

  const conditionAfterFinally = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        do {
            try {
                events = suppliedEvents;
                continue;
            } finally {
                events = List.of();
            }
        } while ((events = suppliedEvents) == null);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(conditionAfterFinally),
    ),
    true,
    "do-while condition runs after the finally block",
  );

  const nestedRestore = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        for (int attempt = 0; attempt < 1; attempt++) {
            try {
                try {
                    events = List.of();
                    continue;
                } finally {
                    events = List.of();
                }
            } finally {
                events = suppliedEvents;
            }
        }`,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(nestedRestore)),
    true,
    "all nested finally blocks execute from inner to outer",
  );

  const nestedInvalidation = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        for (int attempt = 0; attempt < 1; attempt++) {
            try {
                try {
                    events = suppliedEvents;
                    continue;
                } finally {
                    events = suppliedEvents;
                }
            } finally {
                events = List.of();
            }
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(nestedInvalidation),
    ),
    false,
    "outer finally invalidation cannot be skipped",
  );

  const replacePublisherBodies = (syncBody, asyncBody) => golden.source
    .replace(
      /        try \{\s*client\.sendEvents\(events\);\s*\} catch \(HttpResponseException exception\) \{\s*LOGGER\.log\(Level\.SEVERE, "Event Grid publishing failed", exception\);\s*throw exception;\s*\}/,
      syncBody,
    )
    .replace(
      /        return client\.sendEvents\(events\)\s*\.onErrorResume\(HttpResponseException\.class, exception -> \{\s*LOGGER\.log\(Level\.SEVERE, "Event Grid publishing failed", exception\);\s*return Mono\.error\(exception\);\s*\}\);/,
      asyncBody,
    );

  for (const [label, syncControl, asyncControl] of [
    ["return", "return;", "return Mono.empty();"],
    [
      "throw",
      'throw new IllegalStateException("stop");',
      'throw new IllegalStateException("stop");',
    ],
  ]) {
    const sendsFromFinally = replacePublisherBodies(
      `        try {
            ${syncControl}
        } finally {
            client.sendEvents(events);
        }`,
      `        try {
            ${asyncControl}
        } finally {
            client.sendEvents(events).subscribe();
        }`,
    );
    assert.equal(
      evaluateRule(
        "prompt/custom-event-publishing",
        workspace(sendsFromFinally),
      ),
      true,
      `${label} executes the publishing finally block`,
    );
  }

  const invalidFinallySend = replacePublisherBodies(
    `        client.sendEvents(events);
        try {
            return;
        } finally {
            client.sendEvents(List.of());
        }`,
    `        client.sendEvents(events).subscribe();
        try {
            return Mono.empty();
        } finally {
            client.sendEvents(List.of()).subscribe();
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(invalidFinallySend),
    ),
    false,
    "return cannot skip an invalid publishing finally block",
  );

  const nestedReturnFinally = replacePublisherBodies(
    `        try {
            try {
                return;
            } finally {
                return;
            }
        } finally {
            client.sendEvents(events);
        }`,
    `        try {
            try {
                return Mono.empty();
            } finally {
                return Mono.empty();
            }
        } finally {
            client.sendEvents(events).subscribe();
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(nestedReturnFinally),
    ),
    true,
    "an abrupt inner finally still executes the outer finally",
  );
});

test.skip("publisher switch resolves labeled break targets", () => {
  const reassignBoth = (statement) => golden.source.replaceAll(
    "                .toList();",
    `                .toList();
        ${statement}`,
  );
  const exitsLoopWithInvalidEvents = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        for (int attempt = 0; attempt < 1; attempt++) {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    events = List.of();
                    break publishAttempt;
                default:
                    events = suppliedEvents;
                    break;
            }
            events = suppliedEvents;
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(exitsLoopWithInvalidEvents),
    ),
    false,
  );

  const exitsLoopWithValidEvents = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        publishAttempt:
        for (int attempt = 0; attempt < 1; attempt++) {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    events = suppliedEvents;
                    break publishAttempt;
                default:
                    events = List.of();
                    break;
            }
            events = suppliedEvents;
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(exitsLoopWithValidEvents),
    ),
    true,
  );

  const exitsLabeledBlockBeforeRestoration = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        publishBlock: {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    events = List.of();
                    break publishBlock;
                default:
                    events = suppliedEvents;
                    break;
            }
            events = suppliedEvents;
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(exitsLabeledBlockBeforeRestoration),
    ),
    false,
  );

  const validLabeledBlock = reassignBoth(
    `List<EventGridEvent> suppliedEvents = events;
        publishBlock: {
            switch ((int) (System.nanoTime() % 2)) {
                case 0:
                    events = suppliedEvents;
                    break publishBlock;
                default:
                    events = List.of();
                    break;
            }
            events = suppliedEvents;
        }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      workspace(validLabeledBlock),
    ),
    true,
  );
});

test.skip("publisher failure handling must log and rethrow or re-emit", () => {
  const swallowedSync = golden.source.replace(
    /LOGGER\.log\(Level\.SEVERE, "Event Grid publishing failed", exception\);\r?\n\s*throw exception;/,
    `LOGGER.log(Level.SEVERE, "Event Grid publishing failed", exception);
            return;`,
  );
  assert.equal(
    evaluateRule("prompt/publish-error-handling", workspace(swallowedSync)),
    false,
  );

  const swallowedAsync = golden.source.replaceAll(
    "return Mono.error(exception);",
    "return Mono.empty();",
  );
  assert.equal(
    evaluateRule("prompt/publish-error-handling", workspace(swallowedAsync)),
    false,
  );

  const fakeFacade = golden.source
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(EventPublisher.class.getName());",
      `private static final PublishLog LOGGER = new PublishLog();

    private static final class PublishLog {
        void log(Object... ignored) {
        }
    }`,
    )
    .replace(
      "private static final Logger LOGGER = Logger.getLogger(AsyncEventPublisher.class.getName());",
      `private static final PublishLog LOGGER = new PublishLog();

    private static final class PublishLog {
        void log(Object... ignored) {
        }
    }`,
    );
  assert.equal(
    evaluateRule("prompt/publish-error-handling", workspace(fakeFacade)),
    false,
  );

  const exactPackageLogger = workspace(
    golden.source,
    golden.build,
    [],
    [
      {
        path: "src/main/java/com/example/Application.java",
        source: golden.source,
      },
      {
        path: "src/main/java/java/util/logging/Logger.java",
        source: "package java.util.logging; public class Logger {}",
      },
    ],
  );
  assert.equal(
    evaluateRule("prompt/publish-error-handling", exactPackageLogger),
    false,
  );

  const standardError = golden.source.replaceAll(
    'LOGGER.log(Level.SEVERE, "Event Grid publishing failed", exception);',
    'System.err.println("Event Grid publishing failed: " + exception.getMessage());',
  );
  assert.equal(
    evaluateRule("prompt/publish-error-handling", workspace(standardError)),
    true,
  );
});

test.skip("deferred Java functional bodies count only when executed", () => {
  const replaceDeletionHandlers = (
    syncBody,
    asyncBody,
    base = golden.source,
  ) => base
    .replace(
      /    public void handleDeleted\(String subject\) \{\s*BlobSubject blobSubject = BlobSubject\.parse\(subject\);\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\);\s*\}/,
      `    public void handleDeleted(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
${syncBody}
    }`,
    )
    .replace(
      /    public Mono<Void> handleDeletedAsync\(String subject\) \{\s*BlobSubject blobSubject = BlobSubject\.parse\(subject\);\s*return Mono\.fromRunnable\(\(\) ->\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\)\);\s*\}/,
      `    public Mono<Void> handleDeletedAsync(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
${asyncBody}
    }`,
    );

  const deferredDeletion = replaceDeletionHandlers(
    `        Runnable ignored = new Runnable() {
            @Override
            public void run() {
                LOGGER.info("Blob deleted: "
                        + blobSubject.containerName() + "/" + blobSubject.blobName());
            }
        };`,
    `        Runnable ignored = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(deferredDeletion)),
    false,
  );

  const calledDeletion = replaceDeletionHandlers(
    `        Runnable action = new Runnable() {
            @Override
            public void run() {
                LOGGER.info("Blob deleted: "
                        + blobSubject.containerName() + "/" + blobSubject.blobName());
            }
        };
        action.run();`,
    `        Runnable action = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        action.run();
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(calledDeletion)),
    true,
  );

  const nestedDeferredDeletion = replaceDeletionHandlers(
    `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable ignored = () -> warning.run();`,
    `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable ignored = () -> warning.run();
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(nestedDeferredDeletion),
    ),
    false,
  );

  const nestedCalledDeletion = replaceDeletionHandlers(
    `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable action = () -> warning.run();
        action.run();`,
    `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable action = () -> warning.run();
        action.run();
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(nestedCalledDeletion),
    ),
    true,
  );

  const reassignedDeletion = replaceDeletionHandlers(
    `        Runnable action = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        action = () -> { };
        action.run();`,
    `        Runnable action = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        action = () -> { };
        action.run();
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(reassignedDeletion)),
    false,
  );

  const reachingDeletion = replaceDeletionHandlers(
    `        Runnable action = () -> { };
        action = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        action.run();`,
    `        Runnable action = () -> { };
        action = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        action.run();
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(reachingDeletion)),
    true,
  );

  const aliasedDeletion = replaceDeletionHandlers(
    `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable action = warning;
        action.run();`,
    `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable action = warning;
        action.run();
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(aliasedDeletion)),
    true,
  );

  const snapshottedAlias = replaceDeletionHandlers(
    `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable action = warning;
        warning = () -> { };
        action.run();`,
    `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable action = warning;
        warning = () -> { };
        action.run();
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(snapshottedAlias)),
    true,
  );

  for (const [label, syncBody, asyncBody] of [
    [
      "alias overwritten",
      `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable action = warning;
        action = () -> { };
        action.run();`,
      `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        Runnable action = warning;
        action = () -> { };
        action.run();
        return Mono.empty();`,
    ],
    [
      "alias captures reaching reassignment",
      `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        warning = () -> { };
        Runnable action = warning;
        action.run();`,
      `        Runnable warning = () -> LOGGER.info("Blob deleted: "
                + blobSubject.containerName() + "/" + blobSubject.blobName());
        warning = () -> { };
        Runnable action = warning;
        action.run();
        return Mono.empty();`,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(replaceDeletionHandlers(syncBody, asyncBody)),
      ),
      false,
      label,
    );
  }

  const methodReferenceBase = golden.source
    .replace(
      "public final class BlobEventHandler {",
      `public final class BlobEventHandler {
    private void logDeleted(BlobSubject parsed) {
        System.err.println("Blob deleted: "
                + parsed.containerName() + "/" + parsed.blobName());
    }

    private void ignoreDeleted(BlobSubject parsed) {
    }`,
    )
    .replace(
      "public final class AsyncBlobEventHandler {",
      `public final class AsyncBlobEventHandler {
    private void logDeleted(BlobSubject parsed) {
        System.err.println("Blob deleted: "
                + parsed.containerName() + "/" + parsed.blobName());
    }

    private void ignoreDeleted(BlobSubject parsed) {
    }`,
    );
  const replacedByMethodReference = replaceDeletionHandlers(
    `        java.util.function.Consumer<BlobSubject> action = parsed ->
                LOGGER.info("Blob deleted: "
                        + parsed.containerName() + "/" + parsed.blobName());
        action = this::ignoreDeleted;
        action.accept(blobSubject);`,
    `        java.util.function.Consumer<BlobSubject> action = parsed ->
                LOGGER.info("Blob deleted: "
                        + parsed.containerName() + "/" + parsed.blobName());
        action = this::ignoreDeleted;
        action.accept(blobSubject);
        return Mono.empty();`,
    methodReferenceBase,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(replacedByMethodReference),
    ),
    false,
  );

  const reachingMethodReference = replaceDeletionHandlers(
    `        java.util.function.Consumer<BlobSubject> action = parsed -> { };
        action = this::logDeleted;
        action.accept(blobSubject);`,
    `        java.util.function.Consumer<BlobSubject> action = parsed -> { };
        action = this::logDeleted;
        action.accept(blobSubject);
        return Mono.empty();`,
    methodReferenceBase,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(reachingMethodReference),
    ),
    true,
  );

  const deferredSends = golden.source
    .replace(
      "            client.sendEvents(events);",
      `            Runnable ignored = new Runnable() {
                @Override
                public void run() {
                    client.sendEvents(events);
                }
            };`,
    )
    .replace(
      /        return client\.sendEvents\(events\)\s*\.onErrorResume\(HttpResponseException\.class, exception -> \{\s*LOGGER\.log\(Level\.SEVERE, "Event Grid publishing failed", exception\);\s*return Mono\.error\(exception\);\s*\}\);/,
      `        Runnable ignored = () -> client.sendEvents(events).block();
        return Mono.empty();`,
    );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(deferredSends)),
    false,
  );

  const calledSends = golden.source
    .replace(
      "            client.sendEvents(events);",
      `            Runnable action = () -> client.sendEvents(events);
            action.run();`,
    )
    .replace(
      /        return client\.sendEvents\(events\)\s*\.onErrorResume\(HttpResponseException\.class, exception -> \{\s*LOGGER\.log\(Level\.SEVERE, "Event Grid publishing failed", exception\);\s*return Mono\.error\(exception\);\s*\}\);/,
      `        Runnable action = () -> client.sendEvents(events).block();
        action.run();
        return Mono.empty();`,
    );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", workspace(calledSends)),
    true,
  );

  const deferredPublishLog = golden.source.replaceAll(
    'LOGGER.log(Level.SEVERE, "Event Grid publishing failed", exception);',
    `Runnable ignoredLog = () ->
                    LOGGER.log(Level.SEVERE, "Event Grid publishing failed", exception);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/publish-error-handling",
      workspace(deferredPublishLog),
    ),
    false,
  );

  const deferredPublishRethrow = golden.source
    .replaceAll(
      "            throw exception;",
      `            Runnable ignoredThrow = () -> {
                throw exception;
            };
            return;`,
    )
    .replaceAll(
      "                    return Mono.error(exception);",
      `                    java.util.function.Supplier<Mono<Void>> ignoredThrow =
                            () -> Mono.error(exception);
                    return Mono.empty();`,
    );
  assert.equal(
    evaluateRule(
      "prompt/publish-error-handling",
      workspace(deferredPublishRethrow),
    ),
    false,
  );

  const deferred404Log = golden.source.replaceAll(
    'LOGGER.warning("Blob disappeared before it could be read: " + blobSubject.blobName());',
    `Runnable ignoredLog = () -> LOGGER.warning(
                        "Blob disappeared before it could be read: " + blobSubject.blobName());`,
  );
  assert.equal(
    evaluateRule("prompt/blob-race-handling", workspace(deferred404Log)),
    false,
  );

  const deferred404Control = golden.source
    .replace(
      "            throw exception;",
      `            Runnable ignoredThrow = () -> {
                throw exception;
            };
            return;`,
    )
    .replace(
      "                    return Mono.error(exception);",
      `                    java.util.function.Supplier<Mono<Void>> ignoredThrow =
                            () -> Mono.error(exception);
                    return Mono.empty();`,
    );
  assert.equal(
    evaluateRule("prompt/blob-race-handling", workspace(deferred404Control)),
    false,
  );

  assert.equal(
    evaluateRule("prompt/blob-race-handling", golden),
    true,
  );
  assert.equal(
    evaluateRule("prompt/publish-error-handling", golden),
    true,
  );
});

test.skip("Reactor callbacks count only through the consumed publisher", () => {
  const withAsyncDeletion = (helpers, body) => golden.source.replace(
    /    public Mono<Void> handleDeletedAsync\(String subject\) \{\s*BlobSubject blobSubject = BlobSubject\.parse\(subject\);\s*return Mono\.fromRunnable\(\(\) ->\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\)\);\s*\}/,
    `${helpers}

    public Mono<Void> handleDeletedAsync(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
${body}
    }`,
  );
  const helper = `    private Mono<Void> deletionPublisher(BlobSubject parsed) {
        return Mono.fromRunnable(() -> LOGGER.info(
                "Blob deleted: " + parsed.containerName() + "/" + parsed.blobName()));
    }`;

  const discarded = withAsyncDeletion(
    helper,
    `        deletionPublisher(blobSubject);
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(discarded)),
    false,
  );

  const discardedAlias = withAsyncDeletion(
    helper,
    `        Mono<Void> ignored = deletionPublisher(blobSubject);
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(discardedAlias)),
    false,
  );

  const returnedAlias = withAsyncDeletion(
    helper,
    `        Mono<Void> deletion = deletionPublisher(blobSubject);
        return deletion;`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(returnedAlias)),
    true,
  );

  const returnedThroughCall = withAsyncDeletion(
    `${helper}

    private Mono<Void> passThrough(Mono<Void> publisher) {
        return publisher;
    }`,
    `        return passThrough(deletionPublisher(blobSubject));`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(returnedThroughCall)),
    true,
  );

  for (const [label, operator, callback, expected] of [
    [
      "transform identity preserves the source publisher",
      "transform",
      "publisher -> publisher",
      true,
    ],
    [
      "transform replacement discards the source publisher",
      "transform",
      "publisher -> Mono.empty()",
      false,
    ],
    [
      "deferred transform identity preserves the source publisher",
      "transformDeferred",
      "publisher -> publisher",
      true,
    ],
    [
      "deferred transform replacement discards the source publisher",
      "transformDeferred",
      "publisher -> Mono.empty()",
      false,
    ],
    [
      "contextual transform identity preserves the source publisher",
      "transformDeferredContextual",
      "(publisher, context) -> publisher",
      true,
    ],
    [
      "contextual transform replacement discards the source publisher",
      "transformDeferredContextual",
      "(publisher, context) -> Mono.empty()",
      false,
    ],
    [
      "as identity preserves the source publisher",
      "as",
      "publisher -> publisher",
      true,
    ],
    [
      "as replacement discards the source publisher",
      "as",
      "publisher -> Mono.empty()",
      false,
    ],
    [
      "publish identity preserves the source publisher",
      "publish",
      "publisher -> publisher",
      true,
    ],
    [
      "publish replacement discards the source publisher",
      "publish",
      "publisher -> Mono.empty()",
      false,
    ],
  ]) {
    const transformed = withAsyncDeletion(
      helper,
      `        return deletionPublisher(blobSubject)
                .${operator}(${callback});`,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(transformed)),
      expected,
      label,
    );
  }

  const discardedTransformedAlias = withAsyncDeletion(
    helper,
    `        Mono<Void> deletion = deletionPublisher(blobSubject);
        return deletion.transform(ignored -> Mono.empty());`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(discardedTransformedAlias),
    ),
    false,
    "replacement transform discards an aliased source publisher",
  );

  const callbackReplacement = withAsyncDeletion(
    helper,
    `        return Mono.<Void>empty()
                .transform(ignored -> deletionPublisher(blobSubject));`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(callbackReplacement)),
    true,
    "transform output follows the callback replacement publisher",
  );

  const conditionalTransform = withAsyncDeletion(
    helper,
    `        return deletionPublisher(blobSubject)
                .transform(publisher -> {
                    if (System.nanoTime() > 0) {
                        return publisher;
                    }
                    return Mono.empty();
                });`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(conditionalTransform)),
    false,
    "every reachable transform result must preserve the source publisher",
  );

  for (const [label, body] of [
    [
      "outer replacement transform discards an identity transform",
      `        return deletionPublisher(blobSubject)
                .transform(publisher -> publisher)
                .transformDeferred(ignored -> Mono.empty());`,
    ],
    [
      "outer identity cannot recover a discarded transform source",
      `        return deletionPublisher(blobSubject)
                .transform(ignored -> Mono.empty())
                .transformDeferred(publisher -> publisher);`,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(helper, body)),
      ),
      false,
      label,
    );
  }

  for (const [label, helperBody] of [
    [
      "static false return",
      `        if (false) {
            return publisher;
        }
        return Mono.empty();`,
    ],
    [
      "unreachable return",
      `        return Mono.empty();
        return publisher;`,
    ],
    [
      "conditional pass-through",
      `        if (System.nanoTime() > 0) {
            return publisher;
        }
        return Mono.empty();`,
    ],
  ]) {
    const invalidReturn = withAsyncDeletion(
      `${helper}

    private Mono<Void> passThrough(Mono<Void> publisher) {
${helperBody}
    }`,
      `        return passThrough(deletionPublisher(blobSubject));`,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(invalidReturn)),
      false,
      label,
    );
  }

  for (const [label, helperBody] of [
    [
      "both reachable returns",
      `        if (System.nanoTime() > 0) {
            return publisher;
        }
        return publisher;`,
    ],
    [
      "reaching return alias",
      `        Mono<Void> result = publisher;
        if (System.nanoTime() > 0) {
            return result;
        }
        return publisher;`,
    ],
  ]) {
    const validReturn = withAsyncDeletion(
      `${helper}

    private Mono<Void> passThrough(Mono<Void> publisher) {
${helperBody}
    }`,
      `        return passThrough(deletionPublisher(blobSubject));`,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(validReturn)),
      true,
      label,
    );
  }

  const localClassReturn = withAsyncDeletion(
    `${helper}

    private Mono<Void> passThrough(Mono<Void> publisher) {
        class DeferredReturn {
            Mono<Void> select() {
                return publisher;
            }
        }
        return Mono.empty();
    }`,
    `        return passThrough(deletionPublisher(blobSubject));`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(localClassReturn)),
    false,
    "named local class returns do not belong to the enclosing method",
  );

  const localClassDecoy = withAsyncDeletion(
    `${helper}

    private Mono<Void> passThrough(Mono<Void> publisher) {
        class DeferredReturn {
            Mono<Void> select() {
                return Mono.empty();
            }
        }
        return publisher;
    }`,
    `        return passThrough(deletionPublisher(blobSubject));`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(localClassDecoy)),
    true,
    "the enclosing method return remains authoritative",
  );

  const directlySubscribedAlias = withAsyncDeletion(
    helper,
    `        Mono<Void> deletion = deletionPublisher(blobSubject);
        deletion.subscribe();
        return Mono.empty();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(directlySubscribedAlias),
    ),
    true,
  );

  for (const [label, helpers, body] of [
    [
      "publisher wrapped as Mono data",
      helper,
      `        return Mono.just(deletionPublisher(blobSubject)).then();`,
    ],
    [
      "publisher passed as data through a helper",
      `${helper}

    private Mono<Void> discardPublisher(Mono<Void> publisher) {
        return Mono.just(publisher).then();
    }`,
      `        return discardPublisher(deletionPublisher(blobSubject));`,
    ],
    [
      "lookalike then method has no subscription semantics",
      `${helper}

    private static final class FakeOperators {
        private static Mono<Void> then(Mono<Void> publisher) {
            return Mono.empty();
        }
    }`,
      `        return FakeOperators.then(deletionPublisher(blobSubject));`,
    ],
    [
    "publisher mapped as data is never flattened",
    helper,
    `        return Mono.just(deletionPublisher(blobSubject))
              .map(publisher -> publisher)
              .then();`,
    ],
    [
    "publisher remains nested after an iterable is only emitted",
    helper,
    `        return Mono.just(List.of(deletionPublisher(blobSubject)))
              .flatMapMany(items -> Flux.fromIterable(items))
              .then();`,
    ],
    [
    "when subscribes only to the publisher wrapping embedded data",
    helper,
    `        return Mono.when(
              List.of(Mono.just(deletionPublisher(blobSubject))))
              .then();`,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(helpers, body)),
      ),
      false,
      label,
    );
  }

  for (const [label, body] of [
    [
      "then subscribes to its publisher argument",
      `        return Mono.empty().then(deletionPublisher(blobSubject));`,
    ],
    [
      "when subscribes to its publisher arguments",
      `        return Mono.when(
                Mono.empty(),
                deletionPublisher(blobSubject)).then();`,
    ],
    [
      "concat subscribes to its publisher arguments",
      `        return Mono.concat(
                Mono.empty(),
                deletionPublisher(blobSubject)).then();`,
    ],
    [
      "from subscribes to its publisher argument",
      `        return Mono.from(deletionPublisher(blobSubject)).then();`,
    ],
    [
      "flatMap subscribes to a publisher emitted as data",
      `        return Mono.just(deletionPublisher(blobSubject))
                .flatMap(publisher -> publisher);`,
    ],
    [
      "flatMapMany subscribes to a publisher emitted as data",
      `        return Mono.just(deletionPublisher(blobSubject))
                .flatMapMany(publisher -> publisher)
                .then();`,
    ],
    [
      "flatMap subscribes to publisher elements from an iterable",
      `        return Flux.fromIterable(
                        List.of(deletionPublisher(blobSubject)))
                .flatMap(publisher -> publisher)
                .then();`,
    ],
    [
      "nested iterable data is subscribed only after both flattening steps",
      `        return Mono.just(List.of(deletionPublisher(blobSubject)))
                .flatMapMany(items -> Flux.fromIterable(items))
                .flatMap(publisher -> publisher)
                .then();`,
    ],
    [
      "when subscribes to publisher elements from an iterable",
      `        return Mono.when(List.of(
                Mono.empty(),
                deletionPublisher(blobSubject))).then();`,
    ],
    [
      "whenDelayError subscribes to publisher elements from an iterable",
      `        return Mono.whenDelayError(List.of(
                Mono.empty(),
                deletionPublisher(blobSubject))).then();`,
    ],
    [
      "when subscribes to publisher elements from an explicit array",
      `        return Mono.when(new Mono<?>[] {
                Mono.empty(),
                deletionPublisher(blobSubject)}).then();`,
    ],
    [
      "concat subscribes to publisher elements from an iterable",
      `        return Flux.concat(List.of(
                Mono.empty(),
                deletionPublisher(blobSubject))).then();`,
    ],
    [
      "concatDelayError flattens a publisher of publisher values",
      `        return Flux.concatDelayError(Flux.fromIterable(List.of(
                Mono.empty(),
                deletionPublisher(blobSubject)))).then();`,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(helper, body)),
      ),
      true,
      label,
    );
  }

  for (const [label, helperBody] of [
    [
      "false branch callback return",
      `        if (false) {
            return Mono.fromRunnable(() -> LOGGER.info(
                    "Blob deleted: " + parsed.containerName() + "/" + parsed.blobName()));
        }
        return Mono.empty();`,
    ],
    [
      "always-true return dominates callback",
      `        if (true) {
            return Mono.empty();
        }
        return Mono.fromRunnable(() -> LOGGER.info(
                "Blob deleted: " + parsed.containerName() + "/" + parsed.blobName()));`,
    ],
    [
      "earlier unconditional return dominates callback",
      `        return Mono.empty();
        return Mono.fromRunnable(() -> LOGGER.info(
                "Blob deleted: " + parsed.containerName() + "/" + parsed.blobName()));`,
    ],
  ]) {
    const unreachableCallback = withAsyncDeletion(
      `    private Mono<Void> selectedDeletionPublisher(BlobSubject parsed) {
${helperBody}
    }`,
      "        return selectedDeletionPublisher(blobSubject);",
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(unreachableCallback),
      ),
      false,
      label,
    );
  }

  for (const [label, helperBody] of [
    [
      "false branch skips empty publisher",
      `        if (false) {
            return Mono.empty();
        }
        return Mono.fromRunnable(() -> LOGGER.info(
                "Blob deleted: " + parsed.containerName() + "/" + parsed.blobName()));`,
    ],
    [
      "always-true callback return",
      `        if (true) {
            return Mono.fromRunnable(() -> LOGGER.info(
                    "Blob deleted: " + parsed.containerName() + "/" + parsed.blobName()));
        }
        return Mono.empty();`,
    ],
  ]) {
    const reachableCallback = withAsyncDeletion(
      `    private Mono<Void> selectedDeletionPublisher(BlobSubject parsed) {
${helperBody}
    }`,
      "        return selectedDeletionPublisher(blobSubject);",
    );
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(reachableCallback)),
      true,
      label,
    );
  }
});

test.skip("Reactor transform block callbacks use reaching local publisher provenance", () => {
  const withAsyncDeletion = (body, helpers = "") => golden.source.replace(
    /    public Mono<Void> handleDeletedAsync\(String subject\) \{\s*BlobSubject blobSubject = BlobSubject\.parse\(subject\);\s*return Mono\.fromRunnable\(\(\) ->\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\)\);\s*\}/,
    `    private Mono<Void> deletionPublisher(BlobSubject parsed) {
        return Mono.fromRunnable(() -> LOGGER.info(
                "Blob deleted: " + parsed.containerName() + "/" + parsed.blobName()));
    }${helpers}

    public Mono<Void> handleDeletedAsync(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
${body}
    }`,
  );

  for (const [operator, parameters] of [
    ["transform", "publisher"],
    ["transformDeferred", "publisher"],
    ["transformDeferredContextual", "(publisher, context)"],
    ["as", "publisher"],
    ["publish", "publisher"],
  ]) {
    const valid = withAsyncDeletion(
      `        return deletionPublisher(blobSubject)
                .${operator}(${parameters} -> {
                    Mono<Void> selected = Mono.empty();
                    selected = publisher;
                    return selected;
                });`,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(valid)),
      true,
      `${operator} uses the reaching identity alias`,
    );

    const replaced = withAsyncDeletion(
      `        return deletionPublisher(blobSubject)
                .${operator}(${parameters} -> {
                    Mono<Void> selected = publisher;
                    selected = Mono.empty();
                    return selected;
                });`,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(replaced)),
      false,
      `${operator} discards a publisher replaced before return`,
    );
  }

  const mixedReturns = withAsyncDeletion(
    `        return deletionPublisher(blobSubject)
                .transform(publisher -> {
                    if (System.nanoTime() > 0) {
                        Mono<Void> selected = publisher;
                        return selected;
                    }
                    Mono<Void> selected = Mono.empty();
                    return selected;
                });`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(mixedReturns)),
    false,
    "each reachable return uses its own reaching alias provenance",
  );

  const identityReturns = withAsyncDeletion(
    `        return deletionPublisher(blobSubject)
                .transform(publisher -> {
                    if (System.nanoTime() > 0) {
                        Mono<Void> selected = publisher;
                        return selected;
                    }
                    Mono<Void> selected = publisher;
                    return selected;
                });`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(identityReturns)),
    true,
    "all reachable local aliases preserve the source publisher",
  );

  const replacementAlias = withAsyncDeletion(
    `        return Mono.<Void>empty()
                .transform(ignored -> {
                    Mono<Void> selected = Mono.empty();
                    selected = deletionPublisher(blobSubject);
                    return selected;
                });`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(replacementAlias)),
    true,
    "a reaching local replacement alias becomes the consumed publisher",
  );

  for (const [label, callbackBody, expected] of [
    [
      "a catch-only identity assignment is not unconditional",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        if (System.nanoTime() > 0) {
                            throw new IllegalStateException();
                        }
                    } catch (IllegalStateException exception) {
                        selected = publisher;
                    }
                    return selected;`,
      false,
    ],
    [
      "try and catch paths may independently preserve the publisher",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        selected = publisher;
                        System.nanoTime();
                    } catch (RuntimeException exception) {
                        selected = publisher;
                    }
                    return selected;`,
      true,
    ],
    [
      "a replacement on one catch path discards the publisher",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        selected = publisher;
                        System.nanoTime();
                    } catch (RuntimeException exception) {
                        selected = Mono.empty();
                    }
                    return selected;`,
      false,
    ],
    [
      "finally may establish publisher provenance on every path",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        selected = Mono.empty();
                    } catch (RuntimeException exception) {
                        selected = Mono.empty();
                    } finally {
                        selected = publisher;
                    }
                    return selected;`,
      true,
    ],
    [
      "finally replacement applies to every fallthrough path",
      `                    Mono<Void> selected = publisher;
                    try {
                        selected = publisher;
                    } catch (RuntimeException exception) {
                        selected = publisher;
                    } finally {
                        selected = Mono.empty();
                    }
                    return selected;`,
      false,
    ],
    [
      "every reachable try and catch return preserves the publisher",
      `                    try {
                        if (System.nanoTime() > 0) {
                            throw new IllegalStateException();
                        }
                        return publisher;
                    } catch (IllegalStateException exception) {
                        return publisher;
                    }`,
      true,
    ],
    [
      "assignments before a caught throw reach the catch return",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        selected = publisher;
                        throw new IllegalStateException();
                    } catch (IllegalStateException exception) {
                        return selected;
                    }`,
      true,
    ],
    [
      "assignments in nested blocks reach the catch return",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        {
                            selected = publisher;
                            throw new IllegalStateException();
                        }
                    } catch (IllegalStateException exception) {
                        return selected;
                    }`,
      true,
    ],
    [
      "nested block replacements reach the catch return",
      `                    Mono<Void> selected = publisher;
                    try {
                        {
                            selected = Mono.empty();
                            throw new IllegalStateException();
                        }
                    } catch (IllegalStateException exception) {
                        return selected;
                    }`,
      false,
    ],
    [
      "nested try assignments reach outer catches after finally",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        try {
                            selected = publisher;
                            throw new IllegalStateException();
                        } finally {
                            selected = publisher;
                        }
                    } catch (RuntimeException exception) {
                        return selected;
                    }`,
      true,
    ],
    [
      "nested catch assignments reach outer catches after rethrow",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        try {
                            throw new IllegalStateException();
                        } catch (RuntimeException inner) {
                            selected = publisher;
                            throw inner;
                        } finally {
                            selected = publisher;
                        }
                    } catch (RuntimeException outer) {
                        return selected;
                    }`,
      true,
    ],
    [
      "nested finally replacements reach outer catches",
      `                    Mono<Void> selected = publisher;
                    try {
                        try {
                            selected = publisher;
                            throw new IllegalStateException();
                        } catch (IllegalArgumentException ignored) {
                            selected = publisher;
                        } finally {
                            selected = Mono.empty();
                        }
                    } catch (RuntimeException exception) {
                        return selected;
                    }`,
      false,
    ],
    [
      "throws from nested finally blocks retain preceding assignments",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        try {
                            selected = Mono.empty();
                        } catch (RuntimeException ignored) {
                            selected = Mono.empty();
                        } finally {
                            selected = publisher;
                            throw new IllegalStateException();
                        }
                    } catch (RuntimeException exception) {
                        return selected;
                    }`,
      true,
    ],
    [
      "synchronized block mutations reach nested throws",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        synchronized (this) {
                            selected = publisher;
                            throw new IllegalStateException();
                        }
                    } catch (IllegalStateException exception) {
                        return selected;
                    }`,
      true,
    ],
    [
      "synchronized block replacements reach nested throws",
      `                    Mono<Void> selected = publisher;
                    try {
                        synchronized (this) {
                            selected = Mono.empty();
                            throw new IllegalStateException();
                        }
                    } catch (IllegalStateException exception) {
                        return selected;
                    }`,
      false,
    ],
    [
      "assignments before throws in guaranteed loops reach catches",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        while (true) {
                            selected = publisher;
                            throw new IllegalStateException();
                        }
                    } catch (IllegalStateException exception) {
                        return selected;
                    }`,
      true,
    ],
    [
      "loop replacements before nested throws reach catches",
      `                    Mono<Void> selected = publisher;
                    try {
                        for (;;) {
                            selected = Mono.empty();
                            throw new IllegalStateException();
                        }
                    } catch (IllegalStateException exception) {
                        return selected;
                    }`,
      false,
    ],
    [
      "branch mutations inside loops reach their nested throws",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        while (true) {
                            if (System.nanoTime() > 0) {
                                selected = publisher;
                                throw new IllegalStateException();
                            }
                            selected = publisher;
                            throw new IllegalArgumentException();
                        }
                    } catch (RuntimeException exception) {
                        return selected;
                    }`,
      true,
    ],
    [
      "throwing loop headers preserve the pre-loop environment",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        while (System.nanoTime() > 0) {
                            selected = publisher;
                            throw new IllegalStateException();
                        }
                    } catch (RuntimeException exception) {
                        return selected;
                    }
                    return publisher;`,
      false,
    ],
    [
      "one reachable catch return may not replace the publisher",
      `                    try {
                        if (System.nanoTime() > 0) {
                            throw new IllegalStateException();
                        }
                        return publisher;
                    } catch (IllegalStateException exception) {
                        return Mono.empty();
                    }`,
      false,
    ],
    [
      "return values are captured before finally reassignments",
      `                    Mono<Void> selected = publisher;
                    try {
                        return selected;
                    } finally {
                        selected = Mono.empty();
                    }`,
      true,
    ],
    [
      "exceptions raised by finally do not enter sibling catches",
      `                    try {
                        return publisher;
                    } catch (RuntimeException exception) {
                        return Mono.empty();
                    } finally {
                        Mono<Void> ignored = Mono.empty();
                    }`,
      true,
    ],
    [
      "finally cannot repair an already evaluated return value",
      `                    Mono<Void> selected = Mono.empty();
                    try {
                        return selected;
                    } finally {
                        selected = publisher;
                    }`,
      false,
    ],
  ]) {
    const transformed = withAsyncDeletion(
      `        return deletionPublisher(blobSubject)
                .transform(publisher -> {
${callbackBody}
                });`,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(transformed)),
      expected,
      label,
    );
  }

  const catchOnlyReplacement = withAsyncDeletion(
    `        return Mono.<Void>empty()
                .transform(ignored -> {
                    Mono<Void> selected = Mono.empty();
                    try {
                        if (System.nanoTime() > 0) {
                            throw new IllegalStateException();
                        }
                    } catch (IllegalStateException exception) {
                        selected = deletionPublisher(blobSubject);
                    }
                    return selected;
                });`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(catchOnlyReplacement)),
    false,
    "a catch-only replacement publisher is not consumed unconditionally",
  );

  for (const [label, callbackBody, expected] of [
    [
      "an assignment expression returns publisher provenance",
      `                    Mono<Void> selected = Mono.empty();
                    return selected = publisher;`,
      true,
    ],
    [
      "an assignment expression returns replacement provenance",
      `                    Mono<Void> selected = publisher;
                    return selected = Mono.empty();`,
      false,
    ],
    [
      "a chained assignment returns publisher provenance",
      `                    Mono<Void> first = Mono.empty();
                    Mono<Void> second = Mono.empty();
                    return first = second = publisher;`,
      true,
    ],
    [
      "a chained assignment returns replacement provenance",
      `                    Mono<Void> first = publisher;
                    Mono<Void> second = publisher;
                    return first = second = Mono.empty();`,
      false,
    ],
    [
      "nested declaration assignments update every local alias",
      `                    Mono<Void> first = Mono.empty();
                    Mono<Void> second = Mono.empty();
                    Mono<Void> result = first = second = publisher;
                    return second;`,
      true,
    ],
    [
      "assignment expressions in receivers return their assigned value",
      `                    Mono<Void> selected = Mono.empty();
                    return (selected = publisher).then();`,
      true,
    ],
    [
      "conditional branches cannot observe sibling chained assignments",
      `                    Mono<Void> first = Mono.empty();
                    Mono<Void> second = Mono.empty();
                    return System.nanoTime() > 0
                            ? (first = second = publisher)
                            : second;`,
      false,
    ],
    [
      "conditional chained assignments preserve the input on every branch",
      `                    Mono<Void> first = Mono.empty();
                    Mono<Void> second = Mono.empty();
                    return System.nanoTime() > 0
                            ? (first = second = publisher)
                            : (first = second = publisher);`,
      true,
    ],
    [
      "conditional side effects merge chained assignment state",
      `                    Mono<Void> first = Mono.empty();
                    Mono<Void> second = Mono.empty();
                    Mono<Void> ignored = System.nanoTime() > 0
                            ? (first = second = Mono.empty())
                            : (first = second = publisher);
                    return second;`,
      false,
    ],
    [
      "equivalent conditional side effects preserve chained state",
      `                    Mono<Void> first = Mono.empty();
                    Mono<Void> second = Mono.empty();
                    Mono<Void> ignored = System.nanoTime() > 0
                            ? (first = second = publisher)
                            : (first = second = publisher);
                    return second;`,
      true,
    ],
    [
      "ternary conditions apply assignment side effects before branching",
      `                    Mono<Void> selected = Mono.empty();
                    return ((selected = publisher) != null)
                            ? selected
                            : selected;`,
      true,
    ],
    [
      "short-circuited ternary condition assignments stay skipped",
      `                    Mono<Void> selected = Mono.empty();
                    return (true || ((selected = publisher) != null))
                            ? selected
                            : selected;`,
      false,
    ],
    [
      "conditional ternary condition assignments merge with skipped paths",
      `                    Mono<Void> selected = Mono.empty();
                    return (System.nanoTime() > 0
                                    || ((selected = publisher) != null))
                            ? selected
                            : selected;`,
      false,
    ],
  ]) {
    const transformed = withAsyncDeletion(
      `        return deletionPublisher(blobSubject)
                .transform(publisher -> {
${callbackBody}
                });`,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", workspace(transformed)),
      expected,
      label,
    );
  }

  const assignedReplacement = withAsyncDeletion(
    `        return Mono.<Void>empty()
                .transform(ignored -> {
                    Mono<Void> first = Mono.empty();
                    Mono<Void> second = Mono.empty();
                    return first = second = deletionPublisher(blobSubject);
                });`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(assignedReplacement)),
    true,
    "a chained assignment expression returns its replacement publisher",
  );

  const conditionAssignedCallback = withAsyncDeletion(
    `        return Mono.<Void>empty()
                .flatMap(ignored -> {
                    Mono<Void> selected = Mono.empty();
                    return ((selected = deletionPublisher(blobSubject)) != null)
                            ? selected
                            : selected;
                });`,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", workspace(conditionAssignedCallback)),
    true,
    "callback provenance includes assignments executed by ternary conditions",
  );

  const conditionAssignedPublisherData = withAsyncDeletion(
    `        List<Mono<Void>> selected = List.of(Mono.empty());
        return Mono.when(
                ((selected = List.of(deletionPublisher(blobSubject))) != null)
                        ? selected
                        : selected)
                .then();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(conditionAssignedPublisherData),
    ),
    true,
    "publisher data provenance includes ternary condition assignments",
  );

  const contaminatedConditionalReplacement = withAsyncDeletion(
    `        return Mono.<Void>empty()
                .transform(ignored -> {
                    Mono<Void> first = Mono.empty();
                    Mono<Void> second = Mono.empty();
                    Mono<Void> selected = System.nanoTime() > 0
                            ? (first = second = Mono.empty())
                            : (first = second = deletionPublisher(blobSubject));
                    return second;
                });`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(contaminatedConditionalReplacement),
    ),
    false,
    "replacement branches do not contaminate sibling environments",
  );

  const equivalentConditionalReplacement = withAsyncDeletion(
    `        return Mono.<Void>empty()
                .transform(ignored -> {
                    Mono<Void> first = Mono.empty();
                    Mono<Void> second = Mono.empty();
                    Mono<Void> selected = System.nanoTime() > 0
                            ? (first = second = deletionPublisher(blobSubject))
                            : (first = second = deletionPublisher(blobSubject));
                    return second;
                });`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(equivalentConditionalReplacement),
    ),
    true,
    "equivalent replacement branches merge chained state",
  );

  const equivalentReplacementPaths = withAsyncDeletion(
    `        return Mono.<Void>empty()
                .transform(ignored -> {
                    if (System.nanoTime() > 0) {
                        return deletionPublisher(blobSubject);
                    }
                    return passThrough(deletionPublisher(blobSubject));
                });`,
    `

    private Mono<Void> passThrough(Mono<Void> publisher) {
        return publisher;
    }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(equivalentReplacementPaths),
    ),
    true,
    "equivalent replacement expressions may differ across return paths",
  );
});

test.skip("condition evaluation preserves publisher state at Java exception points", () => {
  const withAsyncDeletion = (callbackBody, extraMethods = "") =>
    golden.source.replace(
    /    public Mono<Void> handleDeletedAsync\(String subject\) \{\s*BlobSubject blobSubject = BlobSubject\.parse\(subject\);\s*return Mono\.fromRunnable\(\(\) ->\s*LOGGER\.info\("Blob deleted: " \+ blobSubject\.containerName\(\) \+ "\/" \+ blobSubject\.blobName\(\)\)\);\s*\}/,
    `    private Mono<Void> deletionPublisher(BlobSubject parsed) {
        return Mono.fromRunnable(() -> LOGGER.info(
                "Blob deleted: " + parsed.containerName() + "/" + parsed.blobName()));
    }

    private boolean throwsCondition() {
        throw new IllegalStateException();
    }

    private void consumeInt(int value, Mono<Void> ignored) {
    }

${extraMethods}
    public Mono<Void> handleDeletedAsync(String subject) {
        BlobSubject blobSubject = BlobSubject.parse(subject);
        return deletionPublisher(blobSubject)
                .transform(publisher -> {
${callbackBody}
                });
    }`,
  );

  const nestedCatch = (initial, statement) =>
    `                    Mono<Void> selected = ${initial};
                    try {
                        try {
${statement}
                        } finally {
                        }
                    } catch (RuntimeException exception) {
                        return selected;
                    }
                    return publisher;`;

  for (const [label, statement] of [
    [
      "if condition",
      `                            if (((selected = VALUE) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
    ],
    [
      "while condition",
      `                            while (((selected = VALUE) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
    ],
    [
      "for condition",
      `                            for (int attempt = 0;
                                    ((selected = VALUE) != null)
                                            && throwsCondition();
                                    attempt++) {
                                return publisher;
                            }`,
    ],
    [
      "do-while condition",
      `                            do {
                            } while (((selected = VALUE) != null)
                                    && throwsCondition());`,
    ],
    [
      "ternary condition",
      `                            if ((true
                                    ? ((selected = VALUE) != null)
                                    : false) && throwsCondition()) {
                                return publisher;
                            }`,
    ],
    [
      "nested boolean condition",
      `                            if (false
                                    || (((selected = VALUE) != null)
                                            && throwsCondition())) {
                                return publisher;
                            }`,
    ],
  ]) {
    const replacement = nestedCatch(
      "publisher",
      statement.replace("VALUE", "Mono.empty()"),
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(replacement)),
      ),
      false,
      `${label} applies an empty assignment before the condition throws`,
    );

    const preserved = nestedCatch(
      "Mono.empty()",
      statement.replace("VALUE", "publisher"),
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(preserved)),
      ),
      true,
      `${label} applies a publisher assignment before the condition throws`,
    );
  }

  for (const [label, statement] of [
    [
      "if branch",
      `                            if ((selected = VALUE) != null) {
                                throw new IllegalStateException();
                            }`,
    ],
    [
      "while body",
      `                            while ((selected = VALUE) != null) {
                                throw new IllegalStateException();
                            }`,
    ],
    [
      "for body",
      `                            for (int attempt = 0;
                                    (selected = VALUE) != null;
                                    attempt++) {
                                throw new IllegalStateException();
                            }`,
    ],
  ]) {
    const replacement = nestedCatch(
      "publisher",
      statement.replace("VALUE", "Mono.empty()"),
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(replacement)),
      ),
      false,
      `${label} uses the empty post-condition state`,
    );

    const preserved = nestedCatch(
      "Mono.empty()",
      statement.replace("VALUE", "publisher"),
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(preserved)),
      ),
      true,
      `${label} uses the publisher post-condition state`,
    );
  }

  for (const [label, initial, assigned, expected] of [
    [
      "a throw before an empty assignment preserves the publisher",
      "publisher",
      "Mono.empty()",
      true,
    ],
    [
      "a throw before a publisher assignment preserves the empty state",
      "Mono.empty()",
      "publisher",
      false,
    ],
  ]) {
    const callbackBody = nestedCatch(
      initial,
      `                            if (throwsCondition()
                                    || ((selected = ${assigned}) != null)) {
                                return publisher;
                            }`,
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(callbackBody)),
      ),
      expected,
      label,
    );
  }

  for (const [label, initial, loop, expected] of [
    [
      "a later while condition observes an empty body assignment",
      "publisher",
      `                            while (throwsCondition()) {
                                selected = null;
                            }`,
      false,
    ],
    [
      "every while condition observes publisher provenance",
      "publisher",
      `                            while (throwsCondition()) {
                                selected = publisher;
                            }`,
      true,
    ],
    [
      "a later for condition observes an empty update assignment",
      "publisher",
      `                            for (int attempt = 0;
                                    throwsCondition();
                                    selected = null) {
                            }`,
      false,
    ],
    [
      "every for condition observes publisher update provenance",
      "publisher",
      `                            for (int attempt = 0;
                                    throwsCondition();
                                    selected = publisher) {
                            }`,
      true,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(nestedCatch(initial, loop))),
      ),
      expected,
      label,
    );
  }

  for (const [label, initial, statement, expected] of [
    [
      "a labeled conditional continue skips trailing do-body recovery",
      "publisher",
      `                            boolean skipRecovery = true;
                            retry: do {
                                try {
                                    selected = null;
                                    if (skipRecovery) {
                                        continue retry;
                                    }
                                } finally {
                                    int cleanup = 0;
                                }
                                selected = publisher;
                            } while (throwsCondition());`,
      false,
    ],
    [
      "every reachable do condition entry keeps publisher provenance",
      "null",
      `                            boolean repeat = true;
                            retry: do {
                                try {
                                    selected = publisher;
                                    if (repeat) {
                                        continue retry;
                                    }
                                } finally {
                                    selected = publisher;
                                }
                                selected = publisher;
                            } while (throwsCondition());`,
      true,
    ],
    [
      "a labeled do break skips the condition after finally",
      "publisher",
      `                            retry: do {
                                try {
                                    selected = null;
                                    break retry;
                                } finally {
                                    int cleanup = 0;
                                }
                            } while (throwsCondition());
                            selected = publisher;`,
      true,
    ],
    [
      "a conditional do return never reaches the condition on that path",
      "null",
      `                            boolean finish = true;
                            do {
                                if (finish) {
                                    return publisher;
                                }
                                selected = publisher;
                            } while (throwsCondition());`,
      true,
    ],
    [
      "an explicit do throw enters the catch without evaluating the condition",
      "null",
      `                            boolean fail = true;
                            do {
                                if (fail) {
                                    selected = publisher;
                                    throw new IllegalStateException();
                                }
                                selected = publisher;
                            } while (throwsCondition());`,
      true,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(nestedCatch(initial, statement))),
      ),
      expected,
      label,
    );
  }

  for (const [label, initial, statement, expected] of [
    [
      "a failing reference cast retains an earlier empty assignment",
      "publisher",
      `                            Object candidate = 1;
                            if (((selected = null) != null)
                                    && ((String) candidate != null)) {
                                return publisher;
                            }`,
      false,
    ],
    [
      "a provably safe Object cast does not create an early exception",
      "null",
      `                            Object candidate = "value";
                            if (((Object) candidate != null)
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
      true,
    ],
    [
      "implicit Boolean unboxing retains an earlier empty assignment",
      "publisher",
      `                            Boolean candidate = null;
                            if (((selected = null) != null) && candidate) {
                                return publisher;
                            }`,
      false,
    ],
    [
      "a primitive boolean condition cannot fail by unboxing",
      "null",
      `                            boolean candidate = true;
                            if (candidate
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
      true,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(nestedCatch(initial, statement))),
      ),
      expected,
      label,
    );
  }

  for (const [label, statement] of [
    [
      "primitive declaration conversion",
      `                            Integer candidate = null;
                            int converted = ((selected = Mono.empty()) != null)
                                    ? candidate
                                    : candidate;`,
    ],
    [
      "primitive assignment conversion",
      `                            Integer candidate = null;
                            int converted = 0;
                            converted = ((selected = Mono.empty()) != null)
                                    ? candidate
                                    : candidate;`,
    ],
    [
      "unary numeric conversion",
      `                            Integer candidate = null;
                            int converted = -(((selected = Mono.empty()) != null)
                                    ? candidate
                                    : candidate);`,
    ],
    [
      "left binary operand conversion",
      `                            Integer candidate = null;
                            int converted = (((selected = Mono.empty()) != null)
                                    ? candidate
                                    : candidate)
                                    + (((selected = publisher) != null) ? 1 : 1);`,
    ],
    [
      "left logical operand conversion",
      `                            Boolean candidate = null;
                            boolean converted =
                                    (((selected = Mono.empty()) != null)
                                            ? candidate
                                            : candidate)
                                    & (((selected = publisher) != null)
                                            ? true
                                            : true);`,
    ],
    [
      "method argument conversion",
      `                            Integer candidate = null;
                            consumeInt(
                                    ((selected = Mono.empty()) != null)
                                            ? candidate
                                            : candidate,
                                    ((selected = publisher) != null)
                                            ? publisher
                                            : publisher);`,
    ],
    [
      "primitive cast conversion",
      `                            Integer candidate = null;
                            int converted = (int) (
                                    ((selected = Mono.empty()) != null)
                                            ? candidate
                                            : candidate);`,
    ],
    [
      "return expression conversion",
      `                            Integer candidate = null;
                            return ((((selected = Mono.empty()) != null)
                                            ? candidate
                                            : candidate) + 1) > 0
                                    ? publisher
                                    : publisher;`,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(nestedCatch("publisher", statement))),
      ),
      false,
      `${label} enters the catch with pre-conversion state`,
    );
  }

  const safeUnboxing = nestedCatch(
    "Mono.empty()",
    `                            Integer candidate = 1;
                            int converted = candidate;
                            selected = publisher;
                            throwsCondition();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(withAsyncDeletion(safeUnboxing)),
    ),
    true,
    "a definitely non-null wrapper does not add an unboxing exception path",
  );

  const safeCastThenUnboxing = nestedCatch(
    "Mono.empty()",
    `                            Object candidate = 1;
                            int converted = (Integer) candidate;
                            selected = publisher;
                            throwsCondition();`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(withAsyncDeletion(safeCastThenUnboxing)),
    ),
    true,
    "a safe non-null reference cast does not add an impossible unboxing NPE",
  );

  for (const [label, declaration, condition] of [
    [
      "a definitely-null reference cast",
      "Object candidate = null;",
      "(String) candidate == null",
    ],
    [
      "a known String value through an Object reference",
      'Object candidate = "value";',
      "(String) candidate != null",
    ],
    [
      "a JDK interface upcast",
      "java.time.Instant candidate = java.time.Instant.EPOCH;",
      "(java.time.temporal.TemporalAccessor) candidate != null",
    ],
    [
      "a fully qualified JDK static member upcast",
      "Object candidate = java.time.Instant.EPOCH;",
      "(java.time.temporal.TemporalAccessor) candidate != null",
    ],
  ]) {
    const callbackBody = nestedCatch(
      "Mono.empty()",
      `                            ${declaration}
                            if ((${condition})
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(callbackBody)),
      ),
      true,
      label,
    );
  }

  const positionedStaticMember = (before, after = "") =>
    withAsyncDeletion(
      nestedCatch(
        "Mono.empty()",
        `                            ${before}
                            Object candidate = java.time.Instant.EPOCH;
                            ${after}
                            if (((java.time.temporal.TemporalAccessor) candidate != null)
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
      ),
    );

  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(positionedStaticMember("Object java = null;")),
    ),
    false,
    "a preceding local package-root shadow blocks JDK value typing",
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(positionedStaticMember("", "Object java = null;")),
    ),
    true,
    "a later local package-root declaration does not shadow the expression",
  );

  const longHarmlessCondition = Array.from(
    { length: 96 },
    () => "subject != null",
  ).join(" && ");
  const duplicateStaticMembers = (candidateBeforeShadow) =>
    withAsyncDeletion(
      nestedCatch(
        "Mono.empty()",
        `                            ${
          candidateBeforeShadow
            ? "Object candidate = java.time.Instant.EPOCH;"
            : "Object duplicate = java.time.Instant.EPOCH;"
        }
                            if (${longHarmlessCondition}) {
                            } else {
                            }
                            Object java = null;
                            ${
          candidateBeforeShadow
            ? "Object duplicate = java.time.Instant.EPOCH;"
            : "Object candidate = java.time.Instant.EPOCH;"
        }
                            if (((java.time.temporal.TemporalAccessor) candidate != null)
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
      ),
    );

  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(duplicateStaticMembers(false)),
    ),
    false,
    "an identical static member after a shadow keeps its own source offset",
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(duplicateStaticMembers(true)),
    ),
    true,
    "an identical static member before a shadow keeps its own source offset",
  );

  const lambdaShadow = (
    name,
    expression,
    importLine = "",
    declaration = name,
  ) => {
    const callback = nestedCatch(
      "Mono.empty()",
      `                            Object candidate = ${expression};
                            if (((java.time.temporal.TemporalAccessor) candidate != null)
                                    && ((selected = ${name}) != null)
                                    && throwsCondition()) {
                                return ${name};
                            }`,
    ).replaceAll("return publisher;", `return ${name};`);
    return withAsyncDeletion(callback)
      .replace(
        "import reactor.core.publisher.Mono;",
        `${importLine}import reactor.core.publisher.Mono;`,
      )
      .replace(
        ".transform(publisher -> {",
        `.transform(${declaration} -> {`,
      );
  };

  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(lambdaShadow("publisher", "java.time.Instant.EPOCH")),
    ),
    true,
    "an unshadowed callback retains a qualified JDK static type",
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(lambdaShadow("java", "java.time.Instant.EPOCH")),
    ),
    false,
    "a callback parameter shadows a JDK package root",
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(
        lambdaShadow(
          "publisher",
          "Instant.EPOCH",
          "import java.time.Instant;\n",
        ),
      ),
    ),
    true,
    "an unshadowed callback retains an imported JDK static type",
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(
        lambdaShadow(
          "Instant",
          "Instant.EPOCH",
          "import java.time.Instant;\n",
          "(Mono<Void> Instant)",
        ),
      ),
    ),
    false,
    "a callback parameter shadows a trusted simple JDK type",
  );

  const fieldShadowSelection = positionedStaticMember("").replace(
    "public final class AsyncBlobEventHandler {",
    `public final class AsyncBlobEventHandler {
    private Object java;`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(fieldShadowSelection),
    ),
    false,
    "a field package-root shadow blocks JDK value typing",
  );

  const workspaceUpcast = withAsyncDeletion(
    nestedCatch(
      "Mono.empty()",
      `                            MarkerValue candidate = MarkerValue.INSTANCE;
                            if (((Marker) candidate != null)
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
    ),
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(
        workspaceUpcast,
        golden.build,
        [],
        [
          {
            path: "src/main/java/com/example/Application.java",
            source: workspaceUpcast,
          },
          {
            path: "src/main/java/com/example/Marker.java",
            source: `package com.example;

interface Marker {
}`,
          },
          {
            path: "src/main/java/com/example/MarkerValue.java",
            source: `package com.example;

final class MarkerValue implements Marker {
    static final MarkerValue INSTANCE = new MarkerValue();
}`,
          },
        ],
      ),
    ),
    true,
    "a workspace interface upcast does not add an exception path",
  );

  const sameSimpleTypeSource = withAsyncDeletion(
    nestedCatch(
      "publisher",
      `                            selected = Mono.empty();
                            other.MarkerValue candidate = other.MarkerValue.INSTANCE;
                            if (((com.example.Marker) candidate != null)
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
    ),
  );
  const sameSimpleDocuments = [
    {
      path: "src/main/java/com/example/Application.java",
      source: sameSimpleTypeSource,
    },
    {
      path: "src/main/java/com/example/Marker.java",
      source: "package com.example; public interface Marker {}",
    },
    {
      path: "src/main/java/good/MarkerValue.java",
      source: `package good;
public class MarkerValue implements com.example.Marker {
    public static final MarkerValue INSTANCE = new MarkerValue();
}`,
    },
    {
      path: "src/main/java/other/MarkerValue.java",
      source: `package other;
public class MarkerValue {
    public static final MarkerValue INSTANCE = new MarkerValue();
}`,
    },
  ];
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(
        sameSimpleTypeSource,
        golden.build,
        [],
        sameSimpleDocuments,
      ),
    ),
    false,
    "same simple names in different packages do not merge hierarchy parents",
  );

  const qualifiedWorkspaceUpcast = sameSimpleTypeSource.replaceAll(
    "other.MarkerValue",
    "good.MarkerValue",
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(
        qualifiedWorkspaceUpcast,
        golden.build,
        [],
        sameSimpleDocuments.map((document, index) =>
          index === 0
            ? { ...document, source: qualifiedWorkspaceUpcast }
            : document
        ),
      ),
    ),
    true,
    "fully qualified workspace identities retain the matching hierarchy",
  );

  const nestedTypeDocuments = (source) => [
    {
      path: "src/main/java/com/example/Application.java",
      source,
    },
    {
      path: "src/main/java/com/example/Marker.java",
      source: "package com.example; public interface Marker {}",
    },
    {
      path: "src/main/java/probes/good/Outer.java",
      source: `package probes.good;
public final class Outer {
    public static final class TypeProbe implements com.example.Marker {
        public static final TypeProbe VALUE = new TypeProbe();

        public static TypeProbe value() {
            return VALUE;
        }
    }
}`,
    },
    {
      path: "src/main/java/probes/bad/Outer.java",
      source: `package probes.bad;
public final class Outer {
    public static final class TypeProbe {
        public static final TypeProbe VALUE = new TypeProbe();

        public static TypeProbe value() {
            return VALUE;
        }
    }
}`,
    },
  ];
  const nestedStaticMember = (expression, transform = (source) => source) => {
    const source = transform(withAsyncDeletion(
      nestedCatch(
        "Mono.empty()",
        `                            selected = publisher;
                            Object candidate = ${expression};
                            selected = Mono.empty();
                            if (((com.example.Marker) candidate != null)
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
      ),
    ));
    return workspace(
      source,
      golden.build,
      [],
      nestedTypeDocuments(source),
    );
  };

  for (const member of ["VALUE", "value()"]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        nestedStaticMember(`probes.good.Outer.TypeProbe.${member}`),
      ),
      true,
      `fully qualified nested static ${member} retains its owner chain`,
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        nestedStaticMember(`probes.bad.Outer.TypeProbe.${member}`),
      ),
      false,
      `same-named nested static ${member} identities do not collide`,
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        nestedStaticMember(
          `TypeProbe.${member}`,
          (source) => source.replace(
            "import reactor.core.publisher.Mono;",
            "import probes.good.Outer.TypeProbe;\nimport reactor.core.publisher.Mono;",
          ),
        ),
      ),
      true,
      `an imported nested static ${member} resolves precisely`,
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        nestedStaticMember(
          `TypeProbe.${member}`,
          (source) => source.replace(
            "public final class AsyncBlobEventHandler {",
            `public final class AsyncBlobEventHandler {
    private static final class TypeProbe implements com.example.Marker {
        private static final TypeProbe VALUE = new TypeProbe();

        private static TypeProbe value() {
            return VALUE;
        }
    }`,
          ),
        ),
      ),
      true,
      `an enclosing nested static ${member} wins over simple-name collisions`,
    );
  }

  const collectionFactory = nestedCatch(
    "publisher",
    `                            Object candidate = java.util.Collections.emptyList();
                            selected = Mono.empty();
                            if (((java.util.List<?>) candidate != null)
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(withAsyncDeletion(collectionFactory)),
    ),
    true,
    "Collections.emptyList has its declared List return type",
  );
  const importedCollectionFactory = withAsyncDeletion(
    collectionFactory.replace(
      "java.util.Collections.emptyList()",
      "Collections.emptyList()",
    ),
  ).replace(
    "import java.util.List;",
    "import java.util.Collections;\nimport java.util.List;",
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(importedCollectionFactory),
    ),
    true,
    "an imported Collections.emptyList has its declared List return type",
  );

  for (const [label, declaration, condition] of [
    [
      "an unknown static method",
      "Object candidate = java.util.Collections.unknownFactory();",
      "(java.util.Collections) candidate != null",
    ],
    [
      "an unknown static field",
      "Object candidate = java.time.Instant.UNKNOWN;",
      "(java.time.Instant) candidate != null",
    ],
  ]) {
    const unknownStaticMember = nestedCatch(
      "publisher",
      `                            ${declaration}
                            selected = Mono.empty();
                            if (((${condition})
                                    && ((selected = publisher) != null)
                                    && throwsCondition()) {
                                return publisher;
                            }`,
    );
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        workspace(withAsyncDeletion(unknownStaticMember)),
      ),
      false,
      `${label} has no inferred receiver value type`,
    );
  }

  const ambiguousWorkspaceType = sameSimpleTypeSource
    .replaceAll("other.MarkerValue", "MarkerValue");
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(
        ambiguousWorkspaceType,
        golden.build,
        [],
        sameSimpleDocuments.map((document, index) =>
          index === 0
            ? { ...document, source: ambiguousWorkspaceType }
            : document
        ),
      ),
    ),
    false,
    "ambiguous workspace simple names fail conservatively",
  );

  const failingDowncast = nestedCatch(
    "publisher",
    `                            Object candidate = 1;
                            if (((selected = Mono.empty()) != null)
                                    && ((String) candidate != null)) {
                                return publisher;
                            }`,
  );
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      workspace(withAsyncDeletion(failingDowncast)),
    ),
    false,
    "a known incompatible downcast enters the catch before later state",
  );
});

test.skip("local replacement exception types cannot mimic Azure SDK failures", () => {
  const fakePublishException = golden.source
    .replace(
      "import com.azure.core.exception.HttpResponseException;",
      "import example.HttpResponseException;",
    )
    .replace(
      "public final class Main {",
      `public final class Main {
    private static com.azure.core.exception.HttpResponseException officialPublishFailure;`,
    );
  assert.equal(
    evaluateRule(
      "prompt/publish-error-handling",
      workspace(
        fakePublishException,
        golden.build,
        [],
        [
          {
            path: "src/main/java/com/example/Application.java",
            source: fakePublishException,
          },
          {
            path: "src/main/java/example/HttpResponseException.java",
            source: "package example; public class HttpResponseException extends RuntimeException {}",
          },
        ],
      ),
    ),
    false,
  );

  const fakeBlobException = golden.source
    .replace(
      "import com.azure.storage.blob.models.BlobStorageException;",
      "import example.BlobStorageException;",
    )
    .replace(
      "public final class Main {",
      `public final class Main {
    private static com.azure.storage.blob.models.BlobStorageException officialBlobFailure;`,
    );
  assert.equal(
    evaluateRule(
      "prompt/blob-race-handling",
      workspace(
        fakeBlobException,
        golden.build,
        [],
        [
          {
            path: "src/main/java/com/example/Application.java",
            source: fakeBlobException,
          },
          {
            path: "src/main/java/example/BlobStorageException.java",
            source: `package example;
public class BlobStorageException extends RuntimeException {
  public int getStatusCode() { return 404; }
}`,
          },
        ],
      ),
    ),
    false,
  );
});

test.skip("the demo requires both realistic schemas, sync-first ordering, and a blocked async flow", () => {
  const missingCloudDelete = golden.source.replace(
    '"type": "Microsoft.Storage.BlobDeleted"',
    '"type": "Contoso.Unrelated"',
  );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(missingCloudDelete)),
    false,
  );

  const markerOnlyJson = golden.source.replace(
    /private static final String EVENT_GRID_PAYLOAD = """[\s\S]*?""";/,
    `private static final String EVENT_GRID_PAYLOAD = """
            not valid JSON
            "eventType": "Microsoft.Storage.BlobCreated"
            "eventType": "Microsoft.Storage.BlobDeleted"
            "subject": "/blobServices/default/containers/invoices/blobs/file.txt"
            "data": {}
            """;`,
  );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(markerOnlyJson)),
    false,
  );

  const missingSchemaField = golden.source.replace(
    '"topic": "/subscriptions/demo/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/example"',
    '"notTopic": "/subscriptions/demo/resourceGroups/demo/providers/Microsoft.Storage/storageAccounts/example"',
  );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(missingSchemaField)),
    false,
  );

  const asyncFirst = golden.source.replace(
    'System.out.println("Running synchronous Event Grid demo...");',
    `asyncReceiver.receiveEventGridAsync(EVENT_GRID_PAYLOAD).block();
        System.out.println("Running synchronous Event Grid demo...");`,
  );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(asyncFirst)),
    false,
  );

  const unblocked = golden.source.replace(".block();", ";");
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(unblocked)),
    false,
  );

  const unusedSamples = golden.source
    .replaceAll("receiveEventGrid(EVENT_GRID_PAYLOAD)", 'receiveEventGrid("[]")')
    .replaceAll("receiveCloudEvents(CLOUD_EVENT_PAYLOAD)", 'receiveCloudEvents("[]")')
    .replaceAll(
      "receiveEventGridAsync(EVENT_GRID_PAYLOAD)",
      'receiveEventGridAsync("[]")',
    )
    .replaceAll(
      "receiveCloudEventsAsync(CLOUD_EVENT_PAYLOAD)",
      'receiveCloudEventsAsync("[]")',
    );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(unusedSamples)),
    false,
  );

  const parsedElsewhere = golden.source
    .replace(
      "    public static void main(String[] args) {",
      `    private static void validateSyncSamples(
            String eventGridPayload,
            String cloudPayload) {
        EventGridEvent.fromString(eventGridPayload);
        CloudEvent.fromString(cloudPayload);
    }

    private static Mono<Void> validateAsyncSamples(
            String eventGridPayload,
            String cloudPayload) {
        EventGridEvent.fromString(eventGridPayload);
        CloudEvent.fromString(cloudPayload);
        return Mono.empty();
    }

    public static void main(String[] args) {`,
    )
    .replace(
      '        System.out.println("Running synchronous Event Grid demo...");',
      `        validateSyncSamples(EVENT_GRID_PAYLOAD, CLOUD_EVENT_PAYLOAD);
        System.out.println("Running synchronous Event Grid demo...");`,
    )
    .replace(
      '        System.out.println("Running asynchronous Event Grid demo...");',
      `        validateAsyncSamples(EVENT_GRID_PAYLOAD, CLOUD_EVENT_PAYLOAD);
        System.out.println("Running asynchronous Event Grid demo...");`,
    )
    .replaceAll("receiveEventGrid(EVENT_GRID_PAYLOAD)", 'receiveEventGrid("[]")')
    .replaceAll("receiveCloudEvents(CLOUD_EVENT_PAYLOAD)", 'receiveCloudEvents("[]")')
    .replaceAll(
      "receiveEventGridAsync(EVENT_GRID_PAYLOAD)",
      'receiveEventGridAsync("[]")',
    )
    .replaceAll(
      "receiveCloudEventsAsync(CLOUD_EVENT_PAYLOAD)",
      'receiveCloudEventsAsync("[]")',
    );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(parsedElsewhere)),
    false,
  );

  const sameReceiverNames = golden.source
    .replaceAll("receiveEventGridAsync", "receiveEventGrid")
    .replaceAll("receiveCloudEventsAsync", "receiveCloudEvents");
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(sameReceiverNames)),
    true,
  );
  const disconnectedAsyncSamples = sameReceiverNames
    .replace(
      "asyncReceiver.receiveEventGrid(EVENT_GRID_PAYLOAD)",
      'asyncReceiver.receiveEventGrid("[]")',
    )
    .replace(
      "asyncReceiver.receiveCloudEvents(CLOUD_EVENT_PAYLOAD)",
      'asyncReceiver.receiveCloudEvents("[]")',
    );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(disconnectedAsyncSamples)),
    false,
  );

  const aliasedSamples = golden.source
    .replace(
      "        String notificationSubject = \"/documents/invoices/processed\";",
      `        String notificationSubject = "/documents/invoices/processed";
        String eventGridSample = EVENT_GRID_PAYLOAD;
        String cloudEventSample = CLOUD_EVENT_PAYLOAD;`,
    )
    .replaceAll("receiveEventGrid(EVENT_GRID_PAYLOAD)", "receiveEventGrid(eventGridSample)")
    .replaceAll("receiveCloudEvents(CLOUD_EVENT_PAYLOAD)", "receiveCloudEvents(cloudEventSample)")
    .replaceAll(
      "receiveEventGridAsync(EVENT_GRID_PAYLOAD)",
      "receiveEventGridAsync(eventGridSample)",
    )
    .replaceAll(
      "receiveCloudEventsAsync(CLOUD_EVENT_PAYLOAD)",
      "receiveCloudEventsAsync(cloudEventSample)",
    );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(aliasedSamples)),
    true,
  );

  const exclusive = golden.source.replace(
    /        System\.out\.println\("Running synchronous Event Grid demo\.\.\."\);[\s\S]*?                \.block\(\);/,
    `        AsyncBlobEventHandler asyncHandler = new AsyncBlobEventHandler(clients.blobAsyncClient());
        AsyncEventReceiver asyncReceiver = new AsyncEventReceiver(asyncHandler);
        AsyncEventPublisher asyncPublisher = new AsyncEventPublisher(clients.eventAsyncPublisher());

        if (System.nanoTime() > 0) {
            receiver.receiveEventGrid(EVENT_GRID_PAYLOAD);
            receiver.receiveCloudEvents(CLOUD_EVENT_PAYLOAD);
            publisher.publish(notificationSubject, notifications);
        } else {
            Mono.when(
                            asyncReceiver.receiveEventGridAsync(EVENT_GRID_PAYLOAD),
                            asyncReceiver.receiveCloudEventsAsync(CLOUD_EVENT_PAYLOAD))
                    .then(asyncPublisher.publishAsync(notificationSubject, notifications))
                    .block();
        }`,
  );
  assert.match(exclusive, /if \(System\.nanoTime\(\) > 0\)/);
  assert.equal(evaluateRule("prompt/dual-schema-receivers", workspace(exclusive)), true);
  assert.equal(evaluateRule("prompt/connected-demo", workspace(exclusive)), false);

  const helperSequenced = golden.source.replace(
    /        System\.out\.println\("Running synchronous Event Grid demo\.\.\."\);[\s\S]*?                \.block\(\);\r?\n    }\r?\n}/,
    `        AsyncBlobEventHandler asyncHandler = new AsyncBlobEventHandler(clients.blobAsyncClient());
        AsyncEventReceiver asyncReceiver = new AsyncEventReceiver(asyncHandler);
        AsyncEventPublisher asyncPublisher = new AsyncEventPublisher(clients.eventAsyncPublisher());

        runSyncDemo(receiver, publisher, notificationSubject, notifications);
        runAsyncDemo(asyncReceiver, asyncPublisher, notificationSubject, notifications);
    }

    private static void runSyncDemo(
            EventReceiver receiver,
            EventPublisher publisher,
            String subject,
            List<DownstreamNotification> notifications) {
        receiver.receiveEventGrid(EVENT_GRID_PAYLOAD);
        receiver.receiveCloudEvents(CLOUD_EVENT_PAYLOAD);
        publisher.publish(subject, notifications);
    }

    private static void runAsyncDemo(
            AsyncEventReceiver receiver,
            AsyncEventPublisher publisher,
            String subject,
            List<DownstreamNotification> notifications) {
        Mono.when(
                        receiver.receiveEventGridAsync(EVENT_GRID_PAYLOAD),
                        receiver.receiveCloudEventsAsync(CLOUD_EVENT_PAYLOAD))
                .then(publisher.publishAsync(subject, notifications))
                .block();
    }
}`,
  );
  assert.match(helperSequenced, /private static void runSyncDemo/);
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(helperSequenced)),
    true,
  );

  const noBraceExclusive = helperSequenced.replace(
    /        runSyncDemo\(receiver, publisher, notificationSubject, notifications\);\r?\n        runAsyncDemo\(asyncReceiver, asyncPublisher, notificationSubject, notifications\);/,
    `        if (System.nanoTime() > 0)
            runSyncDemo(receiver, publisher, notificationSubject, notifications);
        else
            runAsyncDemo(asyncReceiver, asyncPublisher, notificationSubject, notifications);`,
  );
  assert.match(noBraceExclusive, /if \(System\.nanoTime\(\) > 0\)/);
  assert.equal(
    evaluateRule("prompt/dual-schema-receivers", workspace(noBraceExclusive)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(noBraceExclusive)),
    false,
  );
});

test.skip("escaped and resource-loaded parsed JSON demo samples are accepted", () => {
  const escaped = sourceWithDemoSamples(
    JSON.stringify(eventGridSample),
    JSON.stringify(cloudEventSample),
  );
  assert.equal(
    evaluateRule("prompt/connected-demo", workspace(escaped)),
    true,
  );

  const resourceLoaded = sourceWithDemoSamples(
    'java.nio.file.Files.readString(java.nio.file.Path.of("src/main/resources/event-grid.json"))',
    'java.nio.file.Files.readString(java.nio.file.Path.of("src/main/resources/cloud-events.json"))',
  );
  assert.equal(
    evaluateRule(
      "prompt/connected-demo",
      workspace(resourceLoaded, golden.build, [
        {
          path: "src/main/resources/event-grid.json",
          content: eventGridSample,
        },
        {
          path: "src/main/resources/cloud-events.json",
          content: cloudEventSample,
        },
      ]),
    ),
    true,
  );
});

test.skip("alternate switch routing, regex subject parsing, and helper flows are accepted", () => {
  const alternate = golden.source
    .replace(
      `if (BLOB_CREATED.equals(eventType)) {
            handler.handleCreated(subject);
        } else if (BLOB_DELETED.equals(eventType)) {
            handler.handleDeleted(subject);
        } else {
            LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }`,
      `switch (eventType) {
            case BLOB_CREATED -> handler.handleCreated(subject);
            case BLOB_DELETED -> handler.handleDeleted(subject);
            default -> LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        }`,
    )
    .replace(
      `if (BLOB_CREATED.equals(eventType)) {
            return handler.handleCreatedAsync(subject);
        }
        if (BLOB_DELETED.equals(eventType)) {
            return handler.handleDeletedAsync(subject);
        }
        LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
        return Mono.empty();`,
      `return switch (eventType) {
            case BLOB_CREATED -> handler.handleCreatedAsync(subject);
            case BLOB_DELETED -> handler.handleDeletedAsync(subject);
            default -> {
                LOGGER.warning("Ignoring unsupported Event Grid event type: " + eventType);
                yield Mono.empty();
            }
        };`,
    )
    .replace(
      /public static BlobSubject parse\(String subject\) \{[\s\S]*?return new BlobSubject\([\s\S]*?\);\s*\}/,
      `public static BlobSubject parse(String subject) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("^/blobServices/default/containers/([^/]+)/blobs/(.+)$")
                .matcher(subject);
        if (!matcher.matches()) {
            throw new IllegalArgumentException(subject);
        }
        return new BlobSubject(
                URLDecoder.decode(matcher.group(1), StandardCharsets.UTF_8),
                URLDecoder.decode(matcher.group(2), StandardCharsets.UTF_8));
    }`,
    );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(alternate)), true, rule);
  }
});

test.skip("subject regexes must preserve the container before nested blob paths", () => {
  const regexParser = (containerPattern) => golden.source.replace(
    /public static BlobSubject parse\(String subject\) \{[\s\S]*?return new BlobSubject\([\s\S]*?\);\s*\}/,
    `public static BlobSubject parse(String subject) {
        java.util.regex.Matcher matcher = java.util.regex.Pattern
                .compile("^/blobServices/default/containers/(${containerPattern})/blobs/(.*)$")
                .matcher(subject);
        if (!matcher.matches()) {
            throw new IllegalArgumentException(subject);
        }
        return new BlobSubject(
                URLDecoder.decode(matcher.group(1), StandardCharsets.UTF_8),
                URLDecoder.decode(matcher.group(2), StandardCharsets.UTF_8));
    }`,
  );

  assert.equal(
    evaluateRule("prompt/blob-subject-parsing", workspace(regexParser(".*"))),
    false,
  );
  assert.equal(
    evaluateRule("prompt/blob-subject-parsing", workspace(regexParser(".*?"))),
    true,
  );
  assert.equal(
    evaluateRule("prompt/blob-subject-parsing", workspace(regexParser("[^/]+"))),
    true,
  );
});

test.skip("two-stage delimiter splitting preserves nested blob names", () => {
  const alternate = golden.source.replace(
    /public static BlobSubject parse\(String subject\) \{[\s\S]*?return new BlobSubject\([\s\S]*?\);\s*\}/,
    `public static BlobSubject parse(String subject) {
        return parseDelimitedSubject(subject);
    }

    private static BlobSubject parseDelimitedSubject(String subject) {
        String[] serviceAndContainer = subject.split("/containers/", 2);
        if (serviceAndContainer.length != 2) {
            throw new IllegalArgumentException(subject);
        }
        String[] containerAndBlob = serviceAndContainer[1].split("/blobs/", 2);
        if (containerAndBlob.length != 2
                || containerAndBlob[0].isBlank()
                || containerAndBlob[1].isBlank()) {
            throw new IllegalArgumentException(subject);
        }
        return new BlobSubject(
                URLDecoder.decode(containerAndBlob[0], StandardCharsets.UTF_8),
                URLDecoder.decode(containerAndBlob[1], StandardCharsets.UTF_8));
    }`,
  );

  assert.equal(
    evaluateRule("prompt/blob-subject-parsing", workspace(alternate)),
    true,
  );

  const unbounded = alternate
    .replace('subject.split("/containers/", 2)', 'subject.split("/containers/")')
    .replace(
      'serviceAndContainer[1].split("/blobs/", 2)',
      'serviceAndContainer[1].split("/blobs/")',
    );
  assert.equal(
    evaluateRule("prompt/blob-subject-parsing", workspace(unbounded)),
    false,
  );
});

test.skip("all prompt graders reject a workspace without generated Java source", () => {
  for (const rule of ruleNames()) {
    assert.equal(
      evaluateRule(rule, {
        sourceFiles: [],
        buildFiles: ["pom.xml"],
        source: "",
        build: golden.build,
      }),
      false,
      rule,
    );
  }
});
