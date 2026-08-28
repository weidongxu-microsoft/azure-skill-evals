import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateTypeScriptCheck,
  typeScriptCheckNames,
} from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/storage-typescript-rules.mjs";
import {
  activeDependencies,
  sourceDocuments,
} from "./tools/source-manifest.mjs";
import { loadSourceManifest } from "./tools/source-manifest.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadSourceManifest(goldenPath);

function withDocuments(documents, packageJson = golden.packageJson) {
  return {
    ...golden,
    documents,
    packageJson,
    source: documents.map(({ source }) => source).join("\n"),
    sourceFiles: documents.map(({ path }) => path),
  };
}

function withSource(source, packageJson = golden.packageJson) {
  return {
    ...golden,
    documents: source.trim() ? [{ path: "src/app.ts", source }] : [],
    packageJson,
    source,
    sourceFiles: source.trim() ? ["src/app.ts"] : [],
  };
}

const referenceFiles = Object.fromEntries(
  golden.documents.map((document) => [document.path, document.source]),
);

function scenarioWorkspace({
  configSource = referenceFiles["src/config.ts"],
  mainSource = referenceFiles["src/main.ts"],
  managerSource = referenceFiles["src/blobStorageManager.ts"],
} = {}) {
  return withDocuments([
    { path: "src/blobStorageManager.ts", source: managerSource },
    { path: "src/config.ts", source: configSource },
    { path: "src/main.ts", source: mainSource },
  ]);
}

function manifestWithoutRuntimeDependencies(...packageNames) {
  const manifest = JSON.parse(golden.packageJson);
  for (const packageName of packageNames) {
    delete manifest.dependencies[packageName];
    delete manifest.devDependencies[packageName];
  }
  return JSON.stringify(manifest);
}

const mainDeclaration = /async function main\(\): Promise<void> \{\r?\n/;
const lifecycleBlock =
  /  console\.log\(`Uploading \$\{blobName\} with blob index tags\.\.\.`\);\r?\n[\s\S]*?  console\.log\("Blob lifecycle complete\."\);\r?\n/;

test("reference passes exactly ten prompt rules", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/packages",
    "prompt/configuration",
    "prompt/retry-and-logging",
    "prompt/service-class",
    "prompt/upload-with-tags",
    "prompt/list-blobs",
    "prompt/download-stream",
    "prompt/lease-overwrite",
    "prompt/error-handling",
    "prompt/demo-lifecycle",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test("reference passes reusable TypeScript checks", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(evaluateTypeScriptCheck(check, golden), true, check);
  }
});

test("reference pins the current stable SDK and toolchain versions", () => {
  const manifest = JSON.parse(golden.packageJson);
  assert.deepEqual(manifest.dependencies, {
    "@azure/core-rest-pipeline": "1.25.0",
    "@azure/identity": "4.13.2",
    "@azure/logger": "1.4.0",
    "@azure/storage-blob": "12.33.0",
  });
  assert.deepEqual(manifest.devDependencies, {
    "@types/node": "26.2.0",
    "typescript": "5.9.2",
  });
  assert.equal(manifest.packageManager, "pnpm@10.26.0");

  const lockfile = readFileSync(
    new URL("./golden/pnpm-lock.yaml", import.meta.url),
    "utf8",
  );
  for (const expected of [
    "'@azure/core-rest-pipeline@1.25.0'",
    "'@azure/identity@4.13.2'",
    "'@azure/logger@1.4.0'",
    "'@azure/storage-blob@12.33.0'",
    "'@types/node@26.2.0'",
    "typescript@5.9.2",
  ]) {
    assert.match(lockfile, new RegExp(expected.replaceAll(".", "\\.")));
  }
});

test("source manifest keeps only runtime dependencies and eligible production files", () => {
  assert.deepEqual(activeDependencies('{"devDependencies":{"fake":"1"}}'), {});
  assert.deepEqual(
    sourceDocuments({
      documents: [
        { path: "src/main.ts", source: "export const main = true;" },
        { path: "tests/decoy.ts", source: "export const hidden = true;" },
      ],
      sourceFiles: ["src/main.ts", "tests/decoy.ts"],
    }).map(({ path }) => path),
    ["src/main.ts"],
  );
});

test("all rules reject missing generated source", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource("")), false, rule);
  }
});

test("mandatory Azure packages must be runtime dependencies", () => {
  for (const packageName of [
    "@azure/identity",
    "@azure/storage-blob",
  ]) {
    const manifest = JSON.parse(golden.packageJson);
    manifest.devDependencies[packageName] = manifest.dependencies[packageName];
    delete manifest.dependencies[packageName];
    assert.equal(
      evaluateRule(
        "prompt/packages",
        withSource(golden.source, JSON.stringify(manifest)),
      ),
      false,
      packageName,
    );
  }
});

test("@azure/logger is required only when generated code imports it", () => {
  const loggerManifest = manifestWithoutRuntimeDependencies("@azure/logger");
  assert.equal(
    evaluateRule("prompt/packages", withSource(golden.source, loggerManifest)),
    false,
  );

  const envOnlyConfigSource = `
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function ensureAzureSdkLogging() {
  const configuredLevel = process.env.AZURE_LOG_LEVEL ?? "info";
  process.env.AZURE_LOG_LEVEL = configuredLevel;
}

export function loadBlobStorageConfiguration() {
  ensureAzureSdkLogging();
  return {
    accountUrl: requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return serviceClient.getContainerClient(configuration.containerName);
}
`;

  const envOnlyWorkspace = scenarioWorkspace({ configSource: envOnlyConfigSource });
  assert.equal(
    evaluateRule("prompt/packages", {
      ...envOnlyWorkspace,
      packageJson: loggerManifest,
    }),
    true,
  );
  assert.equal(evaluateRule("prompt/retry-and-logging", envOnlyWorkspace), true);
  assert.equal(
    evaluateRule(
      "prompt/packages",
      {
        ...envOnlyWorkspace,
        packageJson: manifestWithoutRuntimeDependencies("@azure/storage-blob"),
      },
    ),
    false,
  );
});

test("comments and strings cannot satisfy behavior", () => {
  const source = `
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel } from "@azure/logger";
import { BlobLeaseClient, BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";
const documentation = \`
new DefaultAzureCredential();
new BlobServiceClient(process.env.AZURE_STORAGE_ACCOUNT_URL!, credential, {
  retryOptions: {
    maxTries: 5,
    retryDelayInMs: 1000,
    retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
  },
});
setLogLevel(process.env.AZURE_LOG_LEVEL ?? "info");
process.env.AZURE_LOG_LEVEL = "info";
class BlobStorageManager {
  async uploadFile() {
    await blockBlobClient.uploadStream(stream, undefined, undefined, { tags: { category: "sample" } });
  }
  async overwriteFileWithLease() {
    const leaseClient = new BlobLeaseClient(blockBlobClient);
    await leaseClient.acquireLease(60);
  }
}
\`;
`;
  for (const rule of ruleNames().filter((rule) => rule !== "prompt/packages")) {
    assert.equal(evaluateRule(rule, withSource(source)), false, rule);
  }
});

test("fake SDK types and disallowed connection strings are rejected", () => {
  const source = `
class DefaultAzureCredential {}
class BlobServiceClient {
  getContainerClient() {
    return {};
  }
}
function setLogLevel() {}
const connectionString = "UseDevelopmentStorage=true";
const client = BlobServiceClient.fromConnectionString(connectionString);
void client;
`;
  assert.equal(evaluateRule("prompt/configuration", withSource(source)), false);
  assert.equal(
    evaluateRule("prompt/retry-and-logging", withSource(source)),
    false,
  );
});

test("reachable AZURE_LOG_LEVEL configuration without @azure/logger is accepted", () => {
  const configSource = `
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function resolveLogLevel() {
  return process.env.AZURE_LOG_LEVEL ?? "warning";
}

function configureAzureSdkLogging() {
  process.env.AZURE_LOG_LEVEL = resolveLogLevel();
}

export function loadBlobStorageConfiguration() {
  configureAzureSdkLogging();
  return {
    accountUrl: requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const client = new BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return client.getContainerClient(configuration.containerName);
}
`;

  const workspace = scenarioWorkspace({ configSource });
  assert.equal(
    evaluateRule(
      "prompt/packages",
      {
        ...workspace,
        packageJson: manifestWithoutRuntimeDependencies("@azure/logger"),
      },
    ),
    true,
  );
  assert.equal(evaluateRule("prompt/configuration", workspace), true);
  assert.equal(evaluateRule("prompt/retry-and-logging", workspace), true);
});

test("reachable @azure/logger setup is accepted", () => {
  const configSource = `
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel as configureAzureLogging } from "@azure/logger";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function enableSdkLogging() {
  const logLevel = process.env.AZURE_LOG_LEVEL ?? "info";
  configureAzureLogging(logLevel);
}

export function loadBlobStorageConfiguration() {
  enableSdkLogging();
  return {
    accountUrl: requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return serviceClient.getContainerClient(configuration.containerName);
}
`;

  const workspace = scenarioWorkspace({ configSource });
  assert.equal(evaluateRule("prompt/configuration", workspace), true);
  assert.equal(evaluateRule("prompt/retry-and-logging", workspace), true);
});

test("reachable imported logger alias and namespace bindings are accepted", () => {
  const sources = [
    `
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel as configureAzureLogging } from "@azure/logger";
import * as storage from "@azure/storage-blob";

function configureLogging() {
  const logLevel = process.env.AZURE_LOG_LEVEL ?? "info";
  configureAzureLogging(logLevel);
}

export function loadBlobStorageConfiguration() {
  configureLogging();
  return {
    accountUrl: process.env.AZURE_STORAGE_ACCOUNT_URL!,
    containerName: process.env.AZURE_STORAGE_CONTAINER_NAME!,
    retryOptions: {
      maxTries: Number.parseInt(process.env.AZURE_STORAGE_MAX_RETRIES ?? "5", 10),
      retryDelayInMs: Number.parseInt(process.env.AZURE_STORAGE_RETRY_DELAY_MS ?? "1000", 10),
      maxRetryDelayInMs: Number.parseInt(process.env.AZURE_STORAGE_MAX_RETRY_DELAY_MS ?? "30000", 10),
      retryPolicyType: storage.StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const client = new storage.BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return client.getContainerClient(configuration.containerName);
}
`,
    `
import { DefaultAzureCredential } from "@azure/identity";
import * as azureLogger from "@azure/logger";
import * as storage from "@azure/storage-blob";

function configureLogging() {
  const logLevel = process.env.AZURE_LOG_LEVEL ?? "info";
  azureLogger.setLogLevel(logLevel);
}

export function loadBlobStorageConfiguration() {
  configureLogging();
  return {
    accountUrl: process.env.AZURE_STORAGE_ACCOUNT_URL!,
    containerName: process.env.AZURE_STORAGE_CONTAINER_NAME!,
    retryOptions: {
      maxTries: Number.parseInt(process.env.AZURE_STORAGE_MAX_RETRIES ?? "5", 10),
      retryDelayInMs: Number.parseInt(process.env.AZURE_STORAGE_RETRY_DELAY_MS ?? "1000", 10),
      maxRetryDelayInMs: Number.parseInt(process.env.AZURE_STORAGE_MAX_RETRY_DELAY_MS ?? "30000", 10),
      retryPolicyType: storage.StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const client = new storage.BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return client.getContainerClient(configuration.containerName);
}
`,
  ];

  for (const source of sources) {
    const workspace = scenarioWorkspace({ configSource: source });
    assert.equal(evaluateRule("prompt/configuration", workspace), true);
    assert.equal(evaluateRule("prompt/retry-and-logging", workspace), true);
  }
});

test("hardcoded service endpoint with an unused endpoint env read is rejected", () => {
  const configSource = `
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel } from "@azure/logger";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

export function loadBlobStorageConfiguration() {
  const endpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
  void endpoint;
  const logLevel = process.env.AZURE_LOG_LEVEL ?? "info";
  setLogLevel(logLevel);
  return {
    accountUrl: "https://hardcoded.blob.core.windows.net",
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return serviceClient.getContainerClient(configuration.containerName);
}
`;

  const workspace = scenarioWorkspace({ configSource });
  assert.equal(evaluateRule("prompt/configuration", workspace), false);
  assert.equal(evaluateRule("prompt/retry-and-logging", workspace), false);
});

test("helper-returned endpoint aliases are accepted", () => {
  const configSource = `
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel } from "@azure/logger";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function resolveStorageEndpoint() {
  const endpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
  return endpoint;
}

export function loadBlobStorageConfiguration() {
  const accountUrl = resolveStorageEndpoint();
  const serviceEndpoint = accountUrl;
  const logLevel = process.env.AZURE_LOG_LEVEL ?? "info";
  setLogLevel(logLevel);
  return {
    accountUrl: serviceEndpoint,
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const endpoint = configuration.accountUrl;
  const client = new BlobServiceClient(endpoint, credential, {
    retryOptions: configuration.retryOptions,
  });
  return client.getContainerClient(configuration.containerName);
}
`;

  const workspace = scenarioWorkspace({ configSource });
  assert.equal(evaluateRule("prompt/configuration", workspace), true);
  assert.equal(evaluateRule("prompt/retry-and-logging", workspace), true);
});

test("nested configuration objects can carry the endpoint binding", () => {
  const configSource = `
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel } from "@azure/logger";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

export function loadBlobStorageConfiguration() {
  const endpoint = requireEnvironment("AZURE_STORAGE_ACCOUNT_URL");
  const accountUrl = endpoint;
  const logLevel = process.env.AZURE_LOG_LEVEL ?? "info";
  setLogLevel(logLevel);
  return {
    storage: {
      accountUrl,
    },
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const client = new BlobServiceClient(configuration.storage.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return client.getContainerClient(configuration.containerName);
}
`;

  const workspace = scenarioWorkspace({ configSource });
  assert.equal(evaluateRule("prompt/configuration", workspace), true);
  assert.equal(evaluateRule("prompt/retry-and-logging", workspace), true);
});

test("test-only decoy files are ignored", () => {
  const workspace = withDocuments([
    { path: "src/main.ts", source: "export const ok = true;" },
    { path: "tests/decoy.ts", source: golden.source },
  ]);
  workspace.sourceFiles = ["src/main.ts", "tests/decoy.ts"];

  for (const rule of ruleNames().filter((rule) => rule !== "prompt/packages")) {
    assert.equal(evaluateRule(rule, workspace), false, rule);
  }
});

test("lifecycle operations must use the same reachable manager instance", () => {
  const mainSource = referenceFiles["src/main.ts"]
    .replace(
      "  await manager.deleteBlob(blobName);",
      "  const otherManager = new BlobStorageManager(containerClient);\n" +
        "  await otherManager.deleteBlob(blobName);\n",
    )
    .replace("Blob lifecycle complete.", "Blob lifecycle switched managers.");

  const workspace = withDocuments([
    { path: "src/blobStorageManager.ts", source: referenceFiles["src/blobStorageManager.ts"] },
    { path: "src/config.ts", source: referenceFiles["src/config.ts"] },
    { path: "src/main.ts", source: mainSource },
  ]);

  assert.equal(evaluateRule("prompt/demo-lifecycle", workspace), false);
});

test("constant-false lifecycle branches do not count", () => {
  const mainSource = referenceFiles["src/main.ts"].replace(
    /  await manager\.overwriteFileWithLease\([\s\S]*?  \}\);\r?\n/,
    "  if (false) {\n" +
      "    await manager.overwriteFileWithLease(overwritePath, blobName, {\n" +
      '      metadata: { source: "golden-overwrite" },\n' +
      '      tags: { category: "sample", workflow: "blob-manager-updated" },\n' +
      "    });\n" +
      "  }\n",
  );
  const workspace = withDocuments([
    { path: "src/blobStorageManager.ts", source: referenceFiles["src/blobStorageManager.ts"] },
    { path: "src/config.ts", source: referenceFiles["src/config.ts"] },
    { path: "src/main.ts", source: mainSource },
  ]);
  assert.equal(evaluateRule("prompt/demo-lifecycle", workspace), false);
});

test("lifecycle operations split across incompatible branches are rejected", () => {
  const mainSource = referenceFiles["src/main.ts"].replace(
    /  console\.log\(`Overwriting \$\{blobName\} with a lease\.\.\.`\);\r?\n[\s\S]*?  console\.log\("Blob lifecycle complete\."\);\r?\n/,
    "  if (process.env.BLOB_OVERWRITE_FIRST === \"true\") {\n" +
      "    console.log(`Overwriting ${blobName} with a lease...`);\n" +
      "    await manager.overwriteFileWithLease(overwritePath, blobName, {\n" +
      '      metadata: { source: "golden-overwrite" },\n' +
      '      tags: { category: "sample", workflow: "blob-manager-updated" },\n' +
      "    });\n" +
      "  } else {\n" +
      "    console.log(`Deleting ${blobName}...`);\n" +
      "    await manager.deleteBlob(blobName);\n" +
      "  }\n" +
      "  console.log(\"Blob lifecycle complete.\");\n",
  );

  assert.equal(
    evaluateRule("prompt/demo-lifecycle", scenarioWorkspace({ mainSource })),
    false,
  );
});

test("unreached lifecycle helpers do not count", () => {
  const mainSource = referenceFiles["src/main.ts"]
    .replace(
      mainDeclaration,
      "async function deadEndCleanup(manager: BlobStorageManager, blobName: string): Promise<void> {\n" +
        "  console.log(`Deleting ${blobName} from an unused helper...`);\n" +
        "  await manager.deleteBlob(blobName);\n" +
        "}\n\n" +
        "async function main(): Promise<void> {\n",
    )
    .replace(
      /  console\.log\(`Deleting \$\{blobName\}\.\.\.`\);\r?\n  await manager\.deleteBlob\(blobName\);\r?\n/,
      "  console.log(`Skipping ${blobName} cleanup in the reachable path...`);\n",
    );

  assert.equal(
    evaluateRule("prompt/demo-lifecycle", scenarioWorkspace({ mainSource })),
    false,
  );
});

test("reachable helper-based lifecycle flows are accepted", () => {
  const helper = `
async function runBlobLifecycle(
  manager: BlobStorageManager,
  blobName: string,
  uploadPath: string,
  overwritePath: string,
): Promise<void> {
  console.log(\`Uploading \${blobName} with blob index tags...\`);
  await manager.uploadFile(uploadPath, blobName, {
    metadata: { source: "golden" },
    tags: { category: "sample", workflow: "blob-manager" },
  });

  console.log("Listing blobs in the container...");
  for await (const listedBlobName of manager.listBlobNames()) {
    console.log(\`- \${listedBlobName}\`);
  }

  console.log(\`Downloading \${blobName}...\`);
  const downloadedText = await manager.downloadText(blobName);
  console.log(downloadedText);

  console.log(\`Overwriting \${blobName} with a lease...\`);
  await manager.overwriteFileWithLease(overwritePath, blobName, {
    metadata: { source: "golden-overwrite" },
    tags: { category: "sample", workflow: "blob-manager-updated" },
  });

  console.log(\`Deleting \${blobName}...\`);
  await manager.deleteBlob(blobName);
  console.log("Blob lifecycle complete.");
}

`;
  const mainSource = referenceFiles["src/main.ts"]
    .replace(mainDeclaration, helper + "async function main(): Promise<void> {\n")
    .replace(
      lifecycleBlock,
      "  await runBlobLifecycle(manager, blobName, uploadPath, overwritePath);\n",
    );

  assert.equal(
    evaluateRule("prompt/demo-lifecycle", scenarioWorkspace({ mainSource })),
    true,
  );
});

test("equivalent helper chains and console.info lifecycle flows are accepted", () => {
  const helper = `
async function uploadAndList(
  manager: BlobStorageManager,
  blobName: string,
  uploadPath: string,
): Promise<void> {
  console.info(\`Uploading \${blobName} with blob index tags...\`);
  await manager.uploadFile(uploadPath, blobName, {
    metadata: { source: "golden" },
    tags: { category: "sample", workflow: "blob-manager" },
  });

  console.info("Listing blobs in the container...");
  for await (const listedBlobName of manager.listBlobNames()) {
    console.info(\`- \${listedBlobName}\`);
  }
}

async function finishLifecycle(
  manager: BlobStorageManager,
  blobName: string,
  overwritePath: string,
): Promise<void> {
  console.info(\`Downloading \${blobName}...\`);
  const downloadedText = await manager.downloadText(blobName);
  console.info(downloadedText);
  console.info(\`Overwriting \${blobName} with a lease...\`);
  await manager.overwriteFileWithLease(overwritePath, blobName, {
    metadata: { source: "golden-overwrite" },
    tags: { category: "sample", workflow: "blob-manager-updated" },
  });
  console.info(\`Deleting \${blobName}...\`);
  await manager.deleteBlob(blobName);
  console.info("Blob lifecycle complete.");
}

async function runBlobLifecycle(
  manager: BlobStorageManager,
  blobName: string,
  uploadPath: string,
  overwritePath: string,
): Promise<void> {
  const activeManager = manager;
  await uploadAndList(activeManager, blobName, uploadPath);
  return finishLifecycle(activeManager, blobName, overwritePath);
}

`;
  const mainSource = referenceFiles["src/main.ts"]
    .replace(mainDeclaration, helper + "async function main(): Promise<void> {\n")
    .replace(
      lifecycleBlock,
      "  await runBlobLifecycle(manager, blobName, uploadPath, overwritePath);\n",
    );

  assert.equal(
    evaluateRule("prompt/demo-lifecycle", scenarioWorkspace({ mainSource })),
    true,
  );
});

test("streaming upload must use uploadStream with tags", () => {
  const managerSource = referenceFiles["src/blobStorageManager.ts"]
    .replace(".uploadStream(", ".uploadData(")
    .replace("      tags: options.tags,\n", "");
  const workspace = withDocuments([
    { path: "src/blobStorageManager.ts", source: managerSource },
    { path: "src/config.ts", source: referenceFiles["src/config.ts"] },
    { path: "src/main.ts", source: referenceFiles["src/main.ts"] },
  ]);

  assert.equal(evaluateRule("prompt/upload-with-tags", workspace), false);
});

test("download must consume readableStreamBody and lease overwrite must pass leaseId", () => {
  const noStream = referenceFiles["src/blobStorageManager.ts"].replace(
    /    return streamToString\(response\.readableStreamBody as Readable\);\r?\n/,
    '    return "Hello from memory";\n',
  );
  const noLeaseId = referenceFiles["src/blobStorageManager.ts"].replace(
    /          conditions: \{ leaseId \},\r?\n/,
    "",
  );

  assert.equal(
    evaluateRule(
      "prompt/download-stream",
      withDocuments([
        { path: "src/blobStorageManager.ts", source: noStream },
        { path: "src/config.ts", source: referenceFiles["src/config.ts"] },
        { path: "src/main.ts", source: referenceFiles["src/main.ts"] },
      ]),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/lease-overwrite",
      withDocuments([
        { path: "src/blobStorageManager.ts", source: noLeaseId },
        { path: "src/config.ts", source: referenceFiles["src/config.ts"] },
        { path: "src/main.ts", source: referenceFiles["src/main.ts"] },
      ]),
    ),
    false,
  );
});

test("404 and 409 handling are both required", () => {
  const managerSource = referenceFiles["src/blobStorageManager.ts"]
    .replace(/      if \(isStatusCode\(error, 404\)\) \{\r?\n/, "      if (false) {\n")
    .replace(/      if \(isStatusCode\(error, 409\)\) \{\r?\n/, "      if (false) {\n");
  const workspace = withDocuments([
    { path: "src/blobStorageManager.ts", source: managerSource },
    { path: "src/config.ts", source: referenceFiles["src/config.ts"] },
    { path: "src/main.ts", source: referenceFiles["src/main.ts"] },
  ]);
  assert.equal(evaluateRule("prompt/error-handling", workspace), false);
});

test("namespace logger setup and getBlobLeaseClient are accepted", () => {
  const configSource = `
import { DefaultAzureCredential } from "@azure/identity";
import * as azureLogger from "@azure/logger";
import * as storage from "@azure/storage-blob";

export function loadBlobStorageConfiguration() {
  const level = process.env.AZURE_LOG_LEVEL ?? "info";
  azureLogger.setLogLevel(level);
  return {
    accountUrl: process.env.AZURE_STORAGE_ACCOUNT_URL!,
    containerName: process.env.AZURE_STORAGE_CONTAINER_NAME!,
    retryOptions: {
      maxTries: Number.parseInt(process.env.AZURE_STORAGE_MAX_RETRIES ?? "5", 10),
      retryDelayInMs: Number.parseInt(process.env.AZURE_STORAGE_RETRY_DELAY_MS ?? "1000", 10),
      maxRetryDelayInMs: Number.parseInt(process.env.AZURE_STORAGE_MAX_RETRY_DELAY_MS ?? "30000", 10),
      retryPolicyType: storage.StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const client = new storage.BlobServiceClient(
    configuration.accountUrl,
    credential,
    { retryOptions: configuration.retryOptions },
  );
  return client.getContainerClient(configuration.containerName);
}
`;

  const managerSource = `
import { createReadStream } from "node:fs";
import { RestError } from "@azure/core-rest-pipeline";
import { type ContainerClient } from "@azure/storage-blob";

function isStatusCode(error, statusCode) {
  return error instanceof RestError && error.statusCode === statusCode;
}

async function toText(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class BlobStorageManager {
  constructor(containerClient) {
    this.containerClient = containerClient;
  }

  async ensureContainer() {
    await this.containerClient.createIfNotExists();
  }

  async uploadFile(filePath, blobName, options = {}) {
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadStream(createReadStream(filePath), undefined, undefined, {
      tags: options.tags,
      metadata: options.metadata,
    });
  }

  async *listBlobNames() {
    for await (const blob of this.containerClient.listBlobsFlat()) {
      yield blob.name;
    }
  }

  async downloadText(blobName) {
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    try {
      const response = await blockBlobClient.download();
      return await toText(response.readableStreamBody);
    } catch (error) {
      if (isStatusCode(error, 404)) {
        console.error(error.statusCode);
      }
      throw error;
    }
  }

  async overwriteFileWithLease(filePath, blobName, options = {}) {
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    const leaseClient = blockBlobClient.getBlobLeaseClient();
    try {
      const lease = await leaseClient.acquireLease(60);
      await blockBlobClient.uploadStream(createReadStream(filePath), undefined, undefined, {
        conditions: { leaseId: lease.leaseId },
        tags: options.tags,
      });
    } catch (error) {
      if (isStatusCode(error, 409)) {
        console.error(error.statusCode);
      }
      throw error;
    }
  }

  async deleteBlob(blobName) {
    const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
    try {
      await blockBlobClient.deleteIfExists();
    } catch (error) {
      if (isStatusCode(error, 404)) {
        console.error(error.statusCode);
      }
      throw error;
    }
  }
}
`;

  const workspace = withDocuments([
    { path: "src/blobStorageManager.ts", source: managerSource },
    { path: "src/config.ts", source: configSource },
    { path: "src/main.ts", source: referenceFiles["src/main.ts"] },
  ]);

  for (const rule of [
    "prompt/configuration",
    "prompt/retry-and-logging",
    "prompt/service-class",
    "prompt/upload-with-tags",
    "prompt/list-blobs",
    "prompt/download-stream",
    "prompt/lease-overwrite",
    "prompt/error-handling",
  ]) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test("shadowed logger helpers do not satisfy retry-and-logging", () => {
  const sources = [
    `
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel } from "@azure/logger";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function configureAzureSdkLogging() {
  function setLogLevel() {}
  setLogLevel(process.env.AZURE_LOG_LEVEL ?? "info");
}

export function loadBlobStorageConfiguration() {
  configureAzureSdkLogging();
  return {
    accountUrl: requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return serviceClient.getContainerClient(configuration.containerName);
}
`,
    `
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel as configureAzureLogging } from "@azure/logger";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function configureAzureSdkLogging() {
  const configureAzureLogging = () => {};
  configureAzureLogging(process.env.AZURE_LOG_LEVEL ?? "info");
}

export function loadBlobStorageConfiguration() {
  configureAzureSdkLogging();
  return {
    accountUrl: requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return serviceClient.getContainerClient(configuration.containerName);
}
`,
    `
import { DefaultAzureCredential } from "@azure/identity";
import * as azureLogger from "@azure/logger";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function configureAzureSdkLogging() {
  const azureLogger = { setLogLevel() {} };
  azureLogger.setLogLevel(process.env.AZURE_LOG_LEVEL ?? "info");
}

export function loadBlobStorageConfiguration() {
  configureAzureSdkLogging();
  return {
    accountUrl: requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return serviceClient.getContainerClient(configuration.containerName);
}
`,
  ];

  for (const source of sources) {
    const workspace = scenarioWorkspace({ configSource: source });
    assert.equal(evaluateRule("prompt/configuration", workspace), true);
    assert.equal(evaluateRule("prompt/retry-and-logging", workspace), false, source);
  }
});

test("unreachable logger configuration does not satisfy retry-and-logging", () => {
  const sources = [
    `
import { DefaultAzureCredential } from "@azure/identity";
import { setLogLevel } from "@azure/logger";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function configureAzureSdkLogging() {
  setLogLevel(process.env.AZURE_LOG_LEVEL ?? "info");
}

export function loadBlobStorageConfiguration() {
  return {
    accountUrl: requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return serviceClient.getContainerClient(configuration.containerName);
}
`,
    `
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, StorageRetryPolicyType } from "@azure/storage-blob";

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Set \${name} before running the application.\`);
  }
  return value;
}

function integerEnvironment(name, fallback) {
  const value = process.env[name];
  return value ? Number.parseInt(value, 10) : fallback;
}

function configureAzureSdkLogging() {
  process.env.AZURE_LOG_LEVEL = process.env.AZURE_LOG_LEVEL ?? "info";
}

export function loadBlobStorageConfiguration() {
  return {
    accountUrl: requireEnvironment("AZURE_STORAGE_ACCOUNT_URL"),
    containerName: requireEnvironment("AZURE_STORAGE_CONTAINER_NAME"),
    retryOptions: {
      maxTries: integerEnvironment("AZURE_STORAGE_MAX_RETRIES", 5),
      retryDelayInMs: integerEnvironment("AZURE_STORAGE_RETRY_DELAY_MS", 1000),
      maxRetryDelayInMs: integerEnvironment("AZURE_STORAGE_MAX_RETRY_DELAY_MS", 30000),
      retryPolicyType: StorageRetryPolicyType.EXPONENTIAL,
    },
  };
}

export function createContainerClient(configuration) {
  const credential = new DefaultAzureCredential();
  const serviceClient = new BlobServiceClient(configuration.accountUrl, credential, {
    retryOptions: configuration.retryOptions,
  });
  return serviceClient.getContainerClient(configuration.containerName);
}
`,
  ];

  for (const source of sources) {
    assert.equal(
      evaluateRule(
        "prompt/retry-and-logging",
        scenarioWorkspace({ configSource: source }),
      ),
      false,
      source,
    );
  }
});
