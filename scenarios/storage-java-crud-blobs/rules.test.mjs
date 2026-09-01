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

const imports = `
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.BlobContainerClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.BlobServiceClientBuilder;
import com.azure.storage.blob.models.BlobItem;
import com.azure.storage.blob.models.BlobStorageException;
`;

function workspace(source, build = golden.build) {
  return {
    sourceFiles: ["AnyName.java"],
    buildFiles: ["pom.xml"],
    source,
    build,
  };
}

function application(overrides = {}) {
  return `${imports}
class Application {
  public static void main(String[] args) {
    BlobServiceClient service = new BlobServiceClientBuilder()
        .endpoint(System.getenv("AZURE_STORAGE_ACCOUNT_URL"))
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    BlobContainerClient container =
        service.getBlobContainerClient("my-container");
    BlobClient blob = container.getBlobClient("uploads/data.txt");
    try {
      ${overrides.create ?? `
      if (!container.exists()) {
        container.create();
      }`}
      ${overrides.upload ?? 'blob.uploadFromFile("data.txt", true);'}
      ${overrides.list ?? `
      for (BlobItem item : container.listBlobs()) {
        System.out.println(item.getName());
        System.out.println(item.getProperties().getContentLength());
      }`}
      ${overrides.download ??
        'blob.downloadToFile("data-downloaded.txt", true);'}
      ${overrides.remove ?? `
      blob.delete();
      container.delete();`}
    } catch (BlobStorageException exception) {
      System.err.println(exception.getStatusCode());
      throw exception;
    }
  }
}`;
}

test.skip("the golden application passes prompt and shared Java checks", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, golden), true, check);
  }
});

test.skip("both exact active compile-and-runtime SDK dependency pins are required", () => {
  for (const [artifact, version] of [
    ["azure-identity", "1.18.5"],
    ["azure-storage-blob", "12.35.1"],
  ]) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", {
        ...golden,
        build: golden.build.replace(
          `<version>${version}</version>`,
          "<version>0.0.1</version>",
        ),
      }),
      false,
      artifact,
    );
  }

  const gradle = `plugins { java }
dependencies {
  implementation("com.azure:azure-identity:1.18.5")
  runtimeOnly("com.azure:azure-storage-blob:12.35.1")
}`;
  assert.equal(
    evaluateRule("prompt/sdk-dependencies", workspace(application(), gradle)),
    false,
  );
});

test.skip("equivalent Maven and Gradle compile-and-runtime declarations pass", () => {
  const gradleCases = [
    `plugins { java }
dependencies {
  implementation("com.azure:azure-identity:1.18.5")
  implementation("com.azure:azure-storage-blob:12.35.1")
}`,
    `plugins { id "java-library" }
dependencies {
  api "com.azure:azure-identity:1.18.5"
  api "com.azure:azure-storage-blob:12.35.1"
}`,
  ];
  for (const build of gradleCases) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", workspace(application(), build)),
      true,
    );
  }

  const maven = `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>example</groupId>
  <artifactId>storage</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>azure-identity</artifactId>
      <version>1.18.5</version>
      <scope>compile</scope>
    </dependency>
    <dependency>
      <groupId>com.azure</groupId>
      <artifactId>azure-storage-blob</artifactId>
      <version>12.35.1</version>
    </dependency>
  </dependencies>
</project>`;
  assert.equal(
    evaluateRule("prompt/sdk-dependencies", workspace(application(), maven)),
    true,
  );
});

test.skip("comments, strings, unreachable branches, and uncalled helpers do not count", () => {
  const source = `${imports}
class Decoy {
  static void unused() {
    BlobServiceClient service = new BlobServiceClientBuilder()
        .endpoint("https://example.blob.core.windows.net")
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildClient();
    service.getBlobContainerClient("my-container").createIfNotExists();
  }
  public static void main(String[] args) {
    String text = "new BlobServiceClientBuilder().credential().buildClient()";
    // unused();
    if (false) {
      unused();
    }
  }
}`;
  assert.equal(
    evaluateRule("prompt/client-authentication", workspace(source)),
    false,
  );
  assert.equal(evaluateRule("prompt/container-create", workspace(source)), false);
});

test.skip("local and wrong-package SDK shadows cannot satisfy authentication", () => {
  for (const source of [
    `
class DefaultAzureCredentialBuilder { Object build() { return this; } }
class BlobServiceClientBuilder {
  BlobServiceClientBuilder endpoint(String value) { return this; }
  BlobServiceClientBuilder credential(Object value) { return this; }
  Object buildClient() { return this; }
}
class Application {
  public static void main(String[] args) {
    new BlobServiceClientBuilder().endpoint("https://example")
        .credential(new DefaultAzureCredentialBuilder().build()).buildClient();
  }
}`,
    `
import example.fake.DefaultAzureCredentialBuilder;
import example.fake.BlobServiceClientBuilder;
class Application {
  public static void main(String[] args) {
    new BlobServiceClientBuilder().endpoint("https://example")
        .credential(new DefaultAzureCredentialBuilder().build()).buildClient();
  }
}`,
  ]) {
    assert.equal(
      evaluateRule("prompt/client-authentication", workspace(source)),
      false,
    );
  }
});

test.skip("exact names, paths, ordering, and connected clients are required", () => {
  const cases = [
    ["prompt/container-create", { create: "container.create();" }],
    ["prompt/upload-blob", { upload: 'blob.uploadFromFile("other.txt");' }],
    [
      "prompt/list-blobs",
      {
        list: `for (BlobItem item : container.listBlobs()) {
          System.out.println("uploads/data.txt");
          System.out.println(1);
        }`,
      },
    ],
    [
      "prompt/download-blob",
      { download: 'blob.downloadToFile("other.txt");' },
    ],
    [
      "prompt/delete-lifecycle",
      { remove: "container.delete(); blob.delete();" },
    ],
  ];
  for (const [rule, overrides] of cases) {
    assert.equal(evaluateRule(rule, workspace(application(overrides))), false);
  }

  const disconnected = application({
    upload: `
      BlobServiceClient otherService = new BlobServiceClientBuilder()
          .endpoint("https://other.blob.core.windows.net")
          .credential(new DefaultAzureCredentialBuilder().build())
          .buildClient();
      BlobClient otherBlob = otherService
          .getBlobContainerClient("my-container")
          .getBlobClient("uploads/data.txt");
      otherBlob.uploadFromFile("data.txt");`,
  });
  assert.equal(
    evaluateRule("prompt/upload-blob", workspace(disconnected)),
    false,
  );
});

test.skip("reachable helpers and blocking asynchronous forms are accepted", () => {
  const source = `
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.storage.blob.BlobAsyncClient;
import com.azure.storage.blob.BlobContainerAsyncClient;
import com.azure.storage.blob.BlobServiceAsyncClient;
import com.azure.storage.blob.BlobServiceClientBuilder;
import com.azure.storage.blob.models.BlobItem;
import com.azure.storage.blob.models.BlobStorageException;
class AsyncApplication {
  static void list(BlobContainerAsyncClient container) {
    for (BlobItem item : container.listBlobs().toIterable()) {
      System.out.printf("%s %d%n",
          item.getName(), item.getProperties().getContentLength());
    }
  }
  static void run(
      BlobContainerAsyncClient container, BlobAsyncClient blob) {
    container.createIfNotExists().block();
    blob.uploadFromFile("data.txt", true).block();
    list(container);
    blob.downloadToFile("data-downloaded.txt", true).block();
    blob.delete().block();
    container.delete().block();
  }
  public static void main(String[] args) {
    BlobServiceAsyncClient service = new BlobServiceClientBuilder()
        .endpoint(System.getenv("AZURE_STORAGE_ACCOUNT_URL"))
        .credential(new DefaultAzureCredentialBuilder().build())
        .buildAsyncClient();
    BlobContainerAsyncClient container =
        service.getBlobContainerAsyncClient("my-container");
    BlobAsyncClient blob = container.getBlobAsyncClient("uploads/data.txt");
    try {
      run(container, blob);
    } catch (BlobStorageException exception) {
      System.err.println(exception.getStatusCode());
      throw exception;
    }
  }
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/sdk-dependencies",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("BlobStorageException handling must inspect status and preserve failure", () => {
  const missingStatus = application().replace(
    "System.err.println(exception.getStatusCode());",
    "System.err.println(exception.getMessage());",
  );
  assert.equal(
    evaluateRule("prompt/blob-storage-exception", workspace(missingStatus)),
    false,
  );

  const swallowed = application().replace("throw exception;", "");
  assert.equal(
    evaluateRule("prompt/blob-storage-exception", workspace(swallowed)),
    false,
  );
});

test.skip("all graders reject a workspace without generated Java source", () => {
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
