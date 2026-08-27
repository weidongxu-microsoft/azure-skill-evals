import assert from "node:assert/strict";
import test from "node:test";

import { evaluateJavaCheck } from "./checks.mjs";

const completeWorkspace = {
  sourceFiles: ["Main.java"],
  buildFiles: ["pom.xml"],
  build: `
<dependency>
  <groupId>com.azure</groupId>
  <artifactId>azure-storage-blob</artifactId>
</dependency>
`,
  source: `
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.BlobServiceClientBuilder;

class Main {
    void run() {
        BlobServiceClient client = new BlobServiceClientBuilder()
            .endpoint("https://example")
            .buildClient();
        client.getProperties();
    }
}
`,
};

test("shared Java checks accept a current SDK application", () => {
  for (const check of [
    "language/build-manifest",
    "language/current-azure-dependencies",
    "language/current-imports",
    "language/client-builder",
  ]) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test("legacy dependencies and internal imports fail", () => {
  const workspace = {
    ...completeWorkspace,
    build: completeWorkspace.build.replace("com.azure", "com.microsoft.azure"),
    source: completeWorkspace.source.replace(
      "com.azure.storage.blob",
      "com.azure.storage.blob.implementation",
    ),
  };

  assert.equal(
    evaluateJavaCheck("language/current-azure-dependencies", workspace),
    false,
  );
  assert.equal(
    evaluateJavaCheck("language/current-imports", workspace),
    false,
  );
});

test("constructing a client without its builder fails", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source
      .replace("new BlobServiceClientBuilder()", "legacyFactory()")
      .replace(".buildClient()", ""),
  };

  assert.equal(evaluateJavaCheck("language/client-builder", workspace), false);
});
