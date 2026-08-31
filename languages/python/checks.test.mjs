import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePythonCheck } from "./checks.mjs";

test("shared checks accept an asynchronous Azure SDK implementation", () => {
  const workspace = {
    pythonFiles: ["app.py"],
    dependencies: "",
    python: `
from azure.core.exceptions import HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.storage.blob.aio import BlobServiceClient

async def main():
    try:
        async with BlobServiceClient(
            "https://example.blob.core.windows.net",
            DefaultAzureCredential(),
        ) as client:
            await client.get_account_information()
    except HttpResponseError:
        raise
`,
  };

  for (const check of [
    "language/correct-imports",
    "language/default-azure-credential",
    "language/client-lifecycle",
    "language/async-client",
    "language/exception-handling",
  ]) {
    assert.equal(evaluatePythonCheck(check, workspace), true, check);
  }
});

test("async Azure clients must be awaited and context managed", () => {
  const workspace = {
    pythonFiles: ["app.py"],
    dependencies: "",
    python: `
from azure.storage.blob.aio import BlobServiceClient

client = BlobServiceClient("https://example.blob.core.windows.net")
client.get_account_information()
`,
  };

  assert.equal(evaluatePythonCheck("language/async-client", workspace), false);
  assert.equal(
    evaluatePythonCheck("language/client-lifecycle", workspace),
    false,
  );
});

test("async Azure clients may use explicitly awaited cleanup", () => {
  const workspace = {
    pythonFiles: ["app.py"],
    dependencies: "",
    python: `
from azure.storage.blob.aio import BlobServiceClient

async def main():
    client = BlobServiceClient("https://example.blob.core.windows.net")
    try:
        await client.get_account_information()
    finally:
        await client.close()
`,
  };

  assert.equal(evaluatePythonCheck("language/async-client", workspace), true);
  assert.equal(
    evaluatePythonCheck("language/client-lifecycle", workspace),
    true,
  );
});

test("async Azure client cleanup must be awaited", () => {
  const workspace = {
    pythonFiles: ["app.py"],
    dependencies: "",
    python: `
from azure.storage.blob.aio import BlobServiceClient

async def main():
    client = BlobServiceClient("https://example.blob.core.windows.net")
    try:
        await client.get_account_information()
    finally:
        client.close()
`,
  };

  assert.equal(evaluatePythonCheck("language/async-client", workspace), false);
});

test("key authentication does not satisfy the credential check", () => {
  const workspace = {
    pythonFiles: ["app.py"],
    dependencies: "",
    python: `
from azure.cosmos import CosmosClient

client = CosmosClient("https://example.documents.azure.com", "secret")
`,
  };

  assert.equal(
    evaluatePythonCheck("language/default-azure-credential", workspace),
    false,
  );
});
