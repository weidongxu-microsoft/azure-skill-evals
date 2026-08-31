import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateTypeScriptCheck,
  loadTypeScriptWorkspace,
  typeScriptCheckNames,
} from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/storage-typescript-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadTypeScriptWorkspace(goldenPath);
const baseline = loadTypeScriptWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33420505368", import.meta.url),
  ),
);

function withSource(source, packageJson = golden.packageJson) {
  return { ...golden, packageJson, source };
}

function replace(from, to) {
  return withSource(golden.source.replace(from, to));
}

test("reference passes exactly eight prompt rules", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/packages",
    "prompt/authenticated-client",
    "prompt/container-create",
    "prompt/upload",
    "prompt/list-and-output",
    "prompt/download-and-output",
    "prompt/delete-lifecycle",
    "prompt/rest-error",
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
    "@azure/storage-blob": "12.33.0",
  });
  assert.deepEqual(manifest.devDependencies, {
    "@types/node": "26.2.0",
    "typescript": "7.0.2",
  });
  const lockfile = readFileSync(
    new URL("./golden/pnpm-lock.yaml", import.meta.url),
    "utf8",
  );
  for (const expected of [
    "'@azure/core-rest-pipeline@1.25.0'",
    "'@azure/identity@4.13.2'",
    "'@azure/storage-blob@12.33.0'",
    "'@types/node@26.2.0'",
    "typescript@7.0.2",
  ]) {
    assert.match(lockfile, new RegExp(expected.replaceAll(".", "\\.")));
  }
});

test("all rules reject missing generated source", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource("")), false, rule);
  }
});

test("required SDK packages must be runtime dependencies", () => {
  for (const packageName of [
    "@azure/core-rest-pipeline",
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

test("comments and strings cannot satisfy behavior", () => {
  const source = `
import { RestError } from "@azure/core-rest-pipeline";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
const documentation = \`
  const credential = new DefaultAzureCredential();
  const service = new BlobServiceClient(url, credential);
  const container = service.getContainerClient("my-container");
  const blob = container.getBlockBlobClient("greeting.txt");
  await container.createIfNotExists();
  await blob.upload("Hello Azure!", 12);
  await blob.delete();
  await container.delete();
\`;
// await container.createIfNotExists();
`;
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, withSource(source)), false, rule);
  }
});

test("fake and disconnected clients are rejected", () => {
  const fakeConstructor = golden.source.replace(
    'import { BlobServiceClient } from "@azure/storage-blob";',
    "class BlobServiceClient { getContainerClient() { return fake; } }",
  );
  assert.equal(
    evaluateRule("prompt/authenticated-client", withSource(fakeConstructor)),
    false,
  );

  const disconnected = golden.source
    .replace(
      "await blockBlobClient.upload(message, Buffer.byteLength(message));",
      "await unrelatedBlob.upload(message, Buffer.byteLength(message));",
    )
    .replace(
      "await blockBlobClient.delete();",
      "await unrelatedBlob.delete();",
    );
  assert.equal(evaluateRule("prompt/upload", withSource(disconnected)), false);
  assert.equal(
    evaluateRule("prompt/delete-lifecycle", withSource(disconnected)),
    false,
  );

  const shadowed = golden.source.replace(
    "async function main(): Promise<void> {",
    "async function main(BlobServiceClient): Promise<void> {",
  );
  assert.equal(
    evaluateRule("prompt/authenticated-client", withSource(shadowed)),
    false,
  );

  const overwritten = golden.source
    .replace("const serviceClient =", "let serviceClient =")
    .replace(
      "const containerName =",
      "serviceClient = unrelatedService;\n  const containerName =",
    );
  assert.equal(
    evaluateRule("prompt/authenticated-client", withSource(overwritten)),
    false,
  );

  const credentialOverwrite = golden.source
    .replace("const credential =", "let credential =")
    .replace(
      "const serviceClient =",
      "credential = unrelatedCredential;\n  const serviceClient =",
    );
  assert.equal(
    evaluateRule(
      "prompt/authenticated-client",
      withSource(credentialOverwrite),
    ),
    false,
  );
});

test("required asynchronous SDK operations must be awaited", () => {
  const cases = [
    ["await containerClient.createIfNotExists()", "containerClient.createIfNotExists()", "prompt/container-create"],
    ["await blockBlobClient.upload(message, Buffer.byteLength(message))", "blockBlobClient.upload(message, Buffer.byteLength(message))", "prompt/upload"],
    ["await blockBlobClient.download()", "blockBlobClient.download()", "prompt/download-and-output"],
    ["await blockBlobClient.delete()", "blockBlobClient.delete()", "prompt/delete-lifecycle"],
    ["await containerClient.delete()", "containerClient.delete()", "prompt/delete-lifecycle"],
  ];
  for (const [from, to, rule] of cases) {
    assert.equal(evaluateRule(rule, replace(from, to)), false, from);
  }
});

test("container existence checks must guard creation", () => {
  const disconnected = golden.source.replace(
    "await containerClient.createIfNotExists();",
    `const exists = await containerClient.exists();
    await containerClient.create();`,
  );
  assert.equal(
    evaluateRule("prompt/container-create", withSource(disconnected)),
    false,
  );
});

test("inline and inverse existence branches are accepted", () => {
  const cases = [
    `if (!(await containerClient.exists())) {
      await containerClient.create();
    }`,
    `const exists = await containerClient.exists();
    if (exists) {
      console.log("Container already exists");
    } else {
      await containerClient.create();
    }`,
  ];
  for (const replacement of cases) {
    assert.equal(
      evaluateRule(
        "prompt/container-create",
        replace("await containerClient.createIfNotExists();", replacement),
      ),
      true,
      replacement,
    );
  }
});

test("wrong container, blob, or content constants fail", () => {
  assert.equal(
    evaluateRule(
      "prompt/container-create",
      replace('"my-container"', '"other-container"'),
    ),
    false,
  );
  assert.equal(
    evaluateRule("prompt/upload", replace('"greeting.txt"', '"other.txt"')),
    false,
  );
  assert.equal(
    evaluateRule("prompt/upload", replace('"Hello Azure!"', '"Hello world!"')),
    false,
  );
});

test("listing must print names from the connected container iteration", () => {
  assert.equal(
    evaluateRule(
      "prompt/list-and-output",
      replace("console.log(blob.name);", 'console.log("greeting.txt");'),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/list-and-output",
      replace(
        "containerClient.listBlobsFlat()",
        "unrelatedContainer.listBlobsFlat()",
      ),
    ),
    false,
  );
});

test("download output must derive from the connected SDK response", () => {
  assert.equal(
    evaluateRule(
      "prompt/download-and-output",
      replace("console.log(downloadedText);", 'console.log("Hello Azure!");'),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/download-and-output",
      replace(
        "streamToString(download.readableStreamBody)",
        "streamToString(unrelated.readableStreamBody)",
      ),
    ),
    false,
  );
});

test("unreachable helpers and constant-false branches do not count", () => {
  const unreachable = golden.source
    .replace("await containerClient.createIfNotExists();", "")
    .replace(
      "async function main(): Promise<void> {",
      "async function hidden(containerClient: unknown) {\n" +
        "  await containerClient.createIfNotExists();\n" +
        "}\n\nasync function main(): Promise<void> {",
    );
  assert.equal(
    evaluateRule("prompt/container-create", withSource(unreachable)),
    false,
  );

  const falseBranch = golden.source.replace(
    "await blockBlobClient.upload(message, Buffer.byteLength(message));",
    "if (false) {\n" +
      "      await blockBlobClient.upload(message, Buffer.byteLength(message));\n" +
      "    }",
  );
  assert.equal(evaluateRule("prompt/upload", withSource(falseBranch)), false);
});

test("delete must target the connected blob before its container", () => {
  assert.equal(
    evaluateRule(
      "prompt/delete-lifecycle",
      withSource(
        golden.source
          .replace("    await blockBlobClient.delete();", "")
          .replace(
            "    await containerClient.delete();",
            "    await containerClient.delete();\n" +
              "    await blockBlobClient.delete();",
          ),
      ),
    ),
    false,
  );
});

test("namespace aliases and connected helpers are accepted", () => {
  const source = `
import { Buffer } from "node:buffer";
import * as pipeline from "@azure/core-rest-pipeline";
import * as identity from "@azure/identity";
import * as storage from "@azure/storage-blob";

async function uploadGreeting(activeBlob, text) {
  return activeBlob.uploadData(Buffer.from(text));
}
async function listNames(activeContainer) {
  for await (const item of activeContainer.listBlobsFlat()) {
    console.info(item.name);
  }
}
async function readText(activeBlob) {
  const response = await activeBlob.downloadToBuffer();
  console.log(response.toString("utf8"));
}
async function remove(activeBlob, activeContainer) {
  await activeBlob.deleteIfExists();
  await activeContainer.deleteIfExists();
}
async function main() {
  const service = new storage.BlobServiceClient(
    accountUrl,
    new identity.DefaultAzureCredential(),
  );
  const containerName = "my-container";
  const blobName = "greeting.txt";
  const content = "Hello Azure!";
  const container = service.getContainerClient(containerName);
  const blob = container.getBlockBlobClient(blobName);
  try {
    const exists = await container.exists();
    if (!exists) await container.create();
    await uploadGreeting(blob, content);
    await listNames(container);
    await readText(blob);
    await remove(blob, container);
  } catch (error) {
    if (error instanceof pipeline.RestError) {
      console.error(error.statusCode, error.message);
    }
    throw error;
  }
}
await main();
`;
  const workspace = withSource(source);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test("audited baseline Storage workspace passes every rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline), true, rule);
  }
});

test("inline stream accumulation must derive output from the download", () => {
  const cases = [
    baseline.source.replaceAll(
      "downloadResponse.readableStreamBody",
      "unrelated.readableStreamBody",
    ),
    baseline.source.replace(
      'console.log(Buffer.concat(chunks).toString("utf8"));',
      'console.log("Hello Azure!");',
    ),
    baseline.source.replace(
      "const downloadResponse = await blockBlobClient.download();",
      "const downloadResponse = blockBlobClient.download();",
    ),
    baseline.source.replace(
      "chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));",
      "chunks.push(Buffer.from('Hello Azure!'));",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule(
        "prompt/download-and-output",
        withSource(source, baseline.packageJson),
      ),
      false,
    );
  }
});

test("reachable promise rejection handler requires genuine RestError details", () => {
  const cases = [
    baseline.source.replace(
      'import { RestError } from "@azure/core-rest-pipeline";',
      'import { RestError } from "fake-pipeline";',
    ),
    baseline.source.replace(
      'import { RestError } from "@azure/core-rest-pipeline";',
      'import type { RestError } from "@azure/core-rest-pipeline";',
    ),
    baseline.source.replace(
      "error instanceof RestError",
      "error instanceof Error",
    ),
    baseline.source.replaceAll("error.statusCode", "status"),
    baseline.source.replace(
      "main().catch((error: unknown) => {",
      "Promise.resolve().catch((error: unknown) => {",
    ),
    baseline.source
      .replaceAll("error.message", '"request failed"')
      .replaceAll("error.code", "undefined"),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/rest-error", withSource(source, baseline.packageJson)),
      false,
    );
  }
});
