import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePythonCheck } from "./checks.mjs";

test.skip("shared checks accept an asynchronous Azure SDK implementation", () => {
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

test.skip("async Azure clients must be awaited and context managed", () => {
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

test.skip("async Azure clients may use explicitly awaited cleanup", () => {
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

test.skip("async Azure client cleanup must be awaited", () => {
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

test.skip("key authentication does not satisfy the credential check", () => {
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

test.skip("qualified and aliased Azure SDK forms pass AST checks", () => {
  const workspace = {
    pythonFiles: ["app.py"],
    dependencies: "",
    python: `
import azure.identity as identity
from azure.cosmos import exceptions as cosmos_exceptions

credential = identity.DefaultAzureCredential()
try:
    run()
except cosmos_exceptions.CosmosHttpResponseError:
    raise
`,
  };

  assert.equal(evaluatePythonCheck("language/correct-imports", workspace), true);
  assert.equal(
    evaluatePythonCheck("language/default-azure-credential", workspace),
    true,
  );
  assert.equal(
    evaluatePythonCheck("language/exception-handling", workspace),
    true,
  );
});

test.skip("direct aliases pass AST checks", () => {
  const workspace = {
    pythonFiles: ["app.py"],
    dependencies: "",
    python: `
from azure.core.exceptions import HttpResponseError as AzureFailure
from azure.identity import DefaultAzureCredential as Credential

credential = Credential()
try:
    run()
except AzureFailure:
    raise
`,
  };

  assert.equal(
    evaluatePythonCheck("language/default-azure-credential", workspace),
    true,
  );
  assert.equal(
    evaluatePythonCheck("language/exception-handling", workspace),
    true,
  );
});

test.skip("comments and strings do not satisfy AST checks", () => {
  const workspace = {
    pythonFiles: ["app.py"],
    dependencies: "",
    python: `
# from azure.identity import DefaultAzureCredential
example = """
from azure.core.exceptions import HttpResponseError
except HttpResponseError:
    pass
"""
`,
  };

  for (const check of [
    "language/correct-imports",
    "language/default-azure-credential",
    "language/exception-handling",
  ]) {
    assert.equal(evaluatePythonCheck(check, workspace), false, check);
  }
});
