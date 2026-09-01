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

function workspace(source, build = golden.build) {
  return {
    sourceFiles: ["Main.java"],
    buildFiles: ["pom.xml"],
    source,
    build,
  };
}

test.skip("the golden application passes prompt and shared Java checks", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-dependencies",
    "prompt/secure-configuration",
    "prompt/retry-timeout-logging",
    "prompt/sync-service-operations",
    "prompt/async-service-operations",
    "prompt/parallel-upload-and-tags",
    "prompt/lease-overwrite",
    "prompt/reactive-demo-flow",
  ]);

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, golden), true, check);
  }
});

test.skip("the golden Maven app pins the exact Java SDK versions", () => {
  assert.match(
    golden.build,
    /<artifactId>azure-identity<\/artifactId>\s*<version>1\.18\.5<\/version>/,
  );
  assert.match(
    golden.build,
    /<artifactId>azure-storage-blob<\/artifactId>\s*<version>12\.35\.1<\/version>/,
  );
});

test.skip("both exact active runtime dependency pins are required", () => {
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
});

test.skip("secure configuration ignores comments, strings, unreachable branches, and fake SDK types", () => {
  const fakeSource = `
class DefaultAzureCredentialBuilder {
  DefaultAzureCredentialBuilder build() { return this; }
}
class BlobServiceClientBuilder {
  BlobServiceClientBuilder endpoint(String value) { return this; }
  BlobServiceClientBuilder credential(Object value) { return this; }
  BlobServiceClientBuilder retryOptions(Object value) { return this; }
  BlobServiceClientBuilder httpLogOptions(Object value) { return this; }
  Object buildClient() { return this; }
  Object buildAsyncClient() { return this; }
}
class Main {
  public static void main(String[] args) {
    String prose = "new BlobServiceClientBuilder().endpoint(System.getenv(\\\"AZURE_STORAGE_ACCOUNT_URL\\\"))";
    // new BlobServiceClientBuilder().endpoint(System.getenv("AZURE_STORAGE_ACCOUNT_URL"));
    if (false) {
      new BlobServiceClientBuilder()
          .endpoint(System.getenv("AZURE_STORAGE_ACCOUNT_URL"))
          .credential(new DefaultAzureCredentialBuilder().build())
          .buildClient();
    }
  }
}`;
  assert.equal(
    evaluateRule("prompt/secure-configuration", workspace(fakeSource)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/retry-timeout-logging", workspace(fakeSource)),
    false,
  );
});

test.skip("connection strings and account-key forms fail secure configuration", () => {
  const connectionStringSource = golden.source
    .replaceAll(".endpoint(endpoint)", ".connectionString(endpoint)")
    .replaceAll(".endpoint(accountUrl)", ".connectionString(accountUrl)");
  assert.equal(
    evaluateRule(
      "prompt/secure-configuration",
      workspace(connectionStringSource),
    ),
    false,
  );

  const sharedKeySource = golden.source.replace(
    "new DefaultAzureCredentialBuilder().build()",
    "new StorageSharedKeyCredential(\"account\", \"key\")",
  );
  assert.equal(
    evaluateRule("prompt/secure-configuration", workspace(sharedKeySource)),
    false,
  );
});

test.skip("stepwise builder configuration remains accepted", () => {
  const stepwise = golden.source.replace(
    /return new BlobServiceClientBuilder\(\)[\s\S]*?\.httpLogOptions\(logOptions\);/,
    `BlobServiceClientBuilder builder = new BlobServiceClientBuilder();
        builder.endpoint(endpoint);
        builder.credential(new DefaultAzureCredentialBuilder().build());
        builder.retryOptions(retryOptions);
        builder.httpLogOptions(logOptions);
        return builder;`,
  );

  assert.equal(
    evaluateRule("prompt/secure-configuration", workspace(stepwise)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/retry-timeout-logging", workspace(stepwise)),
    true,
  );
});

test.skip("retry, timeout, and HttpLogOptions are all required", () => {
  for (const source of [
    golden.source.replace("RetryPolicyType.EXPONENTIAL", "RetryPolicyType.FIXED"),
    golden.source.replace("Duration.ofSeconds(30)", "null"),
    golden.source.replace(
      "new HttpLogOptions().setLogLevel(logLevel)",
      "new HttpLogOptions()",
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/retry-timeout-logging", workspace(source)),
      false,
    );
  }
});

test.skip("sync and async lifecycle rules require one connected blob lifecycle each", () => {
  const wrongSyncBlob = golden.source.replace(
    "syncManager.downloadBlob(containerName, blobName, syncDownloadPath);",
    'syncManager.downloadBlob(containerName, "other-blob.txt", syncDownloadPath);',
  );
  assert.equal(
    evaluateRule("prompt/sync-service-operations", workspace(wrongSyncBlob)),
    false,
  );

  const wrongAsyncBlobDelete = golden.source.replace(
    "Mono<Void> deleteBlobStep = asyncManager.deleteBlobAsync(containerName, blobName);",
    'Mono<Void> deleteBlobStep = asyncManager.deleteBlobAsync(containerName, "other-blob.txt");',
  );
  assert.equal(
    evaluateRule("prompt/async-service-operations", workspace(wrongAsyncBlobDelete)),
    false,
  );
});

test.skip("blob lifecycle rules accept valid implementations without optional container helpers", () => {
  const blobOnlyLifecycle = golden.source
    .replace('        syncManager.ensureContainer(containerName);\n', "")
    .replace('        syncManager.deleteContainer(containerName);\n', "")
    .replace('        Mono<Void> createStep = asyncManager.ensureContainerAsync(containerName);\n', "")
    .replace('        Mono<Void> deleteContainerStep = asyncManager.deleteContainerAsync(containerName);\n', "")
    .replace('        createStep\n', "        uploadStep\n")
    .replace('                .then(deleteBlobStep)\n                .then(deleteContainerStep)\n', "                .then(deleteBlobStep)\n");

  assert.equal(
    evaluateRule("prompt/sync-service-operations", workspace(blobOnlyLifecycle)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/async-service-operations", workspace(blobOnlyLifecycle)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/reactive-demo-flow", workspace(blobOnlyLifecycle)),
    true,
  );
});

test.skip("blob lifecycle rules still require each prompt-mandated blob operation", () => {
  for (const [rule, source] of [
    [
      "prompt/sync-service-operations",
      golden.source.replace(
        "syncManager.listBlobs(containerName);",
        '// syncManager.listBlobs(containerName);',
      ),
    ],
    [
      "prompt/async-service-operations",
      golden.source.replace(
        /Mono<Void> overwriteStep = asyncManager\.overwriteWithLeaseAsync\([\s\S]*?"async-demo-lease"\);/,
        "Mono<Void> overwriteStep = Mono.empty();",
      ),
    ],
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test.skip("parallel upload grading requires tags instead of metadata-only uploads", () => {
  const missingTags = golden.source.replaceAll(
    ".setTags(indexTags)",
    ".setMetadata(indexTags)",
  ).replaceAll(
    ".setTags(overwriteTags)",
    ".setMetadata(overwriteTags)",
  );
  assert.equal(
    evaluateRule("prompt/parallel-upload-and-tags", workspace(missingTags)),
    false,
  );
});

test.skip("lease overwrite requires both acquisition and matching request conditions", () => {
  const missingAcquire = golden.source.replaceAll("leaseClient.acquireLease(30)", "leaseClient.releaseLease()");
  assert.equal(
    evaluateRule("prompt/lease-overwrite", workspace(missingAcquire)),
    false,
  );

  const wrongLeaseId = golden.source.replaceAll(
    ".setLeaseId(leaseId)",
    '.setLeaseId("different-lease")',
  );
  assert.equal(
    evaluateRule("prompt/lease-overwrite", workspace(wrongLeaseId)),
    false,
  );
});

test.skip("the async demo must use a blocked reactive chain after the sync demo", () => {
  const asyncFirst = golden.source.replace(
    "syncManager.deleteBlob(containerName, blobName);",
    `Mono<Void> eagerAsync = asyncManager.uploadBlobAsync(
                containerName,
                blobName,
                uploadPath,
                metadata,
                indexTags);
        syncManager.deleteBlob(containerName, blobName);`,
  );
  assert.equal(
    evaluateRule("prompt/reactive-demo-flow", workspace(asyncFirst)),
    false,
  );

  const unblocked = golden.source.replace(".block();", ";");
  assert.equal(
    evaluateRule("prompt/reactive-demo-flow", workspace(unblocked)),
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
