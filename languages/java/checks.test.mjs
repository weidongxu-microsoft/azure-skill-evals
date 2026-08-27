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

class Main {
    void run() {
        BlobServiceClient client = null;
        try {
            client.getProperties();
        } finally {
            client.close();
        }
    }
}
`,
};

test("shared Java checks accept a current SDK application", () => {
  for (const check of [
    "language/build-manifest",
    "language/current-azure-dependencies",
    "language/current-imports",
    "language/client-lifecycle",
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
