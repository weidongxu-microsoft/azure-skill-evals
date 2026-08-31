import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/credential-chain-python-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadPythonWorkspace(goldenPath);
const sharedChecks = [
  "language/correct-imports",
  "language/async-client",
  "language/exception-handling",
];

function workspace(python, dependencies = "azure-identity==1.25.3") {
  return {
    python,
    dependencies,
    pythonFiles: python.trim() ? ["app.py"] : [],
  };
}

test("Python credential-chain golden passes prompt and shared checks", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  for (const check of sharedChecks) {
    assert.equal(evaluatePythonCheck(check, completeWorkspace), true, check);
  }
});

test("all prompt rules reject a missing application", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
  }
});

test("identity dependency must be active", () => {
  assert.equal(
    evaluateRule(
      "prompt/identity-package",
      workspace("print('generated')", "# azure-identity==1.25.3"),
    ),
    false,
  );
});

test("comments, strings, and unreachable code cannot fake behavior", () => {
  const fake = workspace(`
sample = """
def build(environment):
    if environment == "dev": return ChainedTokenCredential(AzureCliCredential())
    if environment == "ci": return ChainedTokenCredential(EnvironmentCredential())
    if environment == "production": return ChainedTokenCredential(ManagedIdentityCredential(), WorkloadIdentityCredential())
"""
if False:
    credential.get_token("https://management.azure.com/.default", enable_cae=True)
`);
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-package",
  )) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
});

test("factory paths must return the matching connected chains", () => {
  const disconnected = workspace(`
from azure.identity import *

def unused():
    return ChainedTokenCredential(ManagedIdentityCredential(), WorkloadIdentityCredential())

def build(environment):
    if environment == "dev":
        return ChainedTokenCredential(AzureCliCredential())
    if environment == "ci":
        return ChainedTokenCredential(EnvironmentCredential())
    if environment == "production":
        return ChainedTokenCredential(AzureCliCredential())
`);
  assert.equal(
    evaluateRule("prompt/sync-credential-chains", disconnected),
    false,
  );
});

test("production ordering and client ID source are required", () => {
  const wrongOrder = completeWorkspace.python.replace(
    /_managed_identity\(\),\s*\n\s*WorkloadIdentityCredential\(\),/,
    "WorkloadIdentityCredential(),\n        _managed_identity(),",
  );
  assert.equal(
    evaluateRule("prompt/sync-credential-chains", workspace(wrongOrder)),
    false,
  );

  const hardCoded = completeWorkspace.python.replace(
    'os.getenv("AZURE_CLIENT_ID")',
    '"hard-coded-client-id"',
  );
  assert.equal(
    evaluateRule("prompt/sync-credential-chains", workspace(hardCoded)),
    false,
  );
});

test("CI rejects DefaultAzureCredential even when another CI credential exists", () => {
  const invalid = completeWorkspace.python.replace(
    /EnvironmentCredential\(\),\s*\n\s*WorkloadIdentityCredential\(\),/,
    "EnvironmentCredential(),\n        DefaultAzureCredential(),",
  );
  assert.equal(
    evaluateRule("prompt/sync-credential-chains", workspace(invalid)),
    false,
  );
});

test("token tests require connected parameters, CAE, scope, expiry, and await", () => {
  for (const invalid of [
    completeWorkspace.python.replace("enable_cae=True", "enable_cae=False"),
    completeWorkspace.python.replace(
      "https://management.azure.com/.default",
      "https://vault.azure.net/.default",
    ),
    completeWorkspace.python.replace("token.expires_on", "token.token"),
    completeWorkspace.python.replace(
      "await credential.get_token",
      "credential.get_token",
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/cae-token-tests", workspace(invalid)),
      false,
    );
  }
});

test("authentication handlers must report the connected exception", () => {
  const generic = completeWorkspace.python.replace(
    "print(f\"Sync authentication failed: {error}\")",
    "print(\"Authentication failed\")",
  );
  assert.equal(
    evaluateRule("prompt/auth-failure-details", workspace(generic)),
    false,
  );
});

test("main flow rejects disconnected credentials and missing await", () => {
  const disconnected = completeWorkspace.python.replace(
    "test_sync(sync_credential)",
    "test_sync(other_credential)",
  );
  assert.equal(
    evaluateRule("prompt/application-flow", workspace(disconnected)),
    false,
  );

  const notAwaited = completeWorkspace.python.replace(
    "await test_async(async_credential)",
    "test_async(async_credential)",
  );
  assert.equal(
    evaluateRule("prompt/application-flow", workspace(notAwaited)),
    false,
  );
});

test("qualified constructors and helper-returned chains are accepted", () => {
  const alternate = workspace(`
import asyncio
import os
import azure.identity as identity
from azure.identity import aio
from azure.core.exceptions import ClientAuthenticationError

SCOPE = "https://management.azure.com/.default"

def detect():
    if os.getenv("TF_BUILD"):
        return "ci"
    if os.getenv("MSI_ENDPOINT"):
        return "production"
    return "dev"

def managed():
    return identity.ManagedIdentityCredential(client_id=os.getenv("AZURE_CLIENT_ID"))

def dev():
    values = [identity.AzureCliCredential()]
    return identity.ChainedTokenCredential(*values)

def ci():
    return identity.ChainedTokenCredential(identity.EnvironmentCredential())

def prod():
    return identity.ChainedTokenCredential(managed(), identity.WorkloadIdentityCredential())

def build(environment):
    if environment == "dev":
        return dev()
    elif environment == "ci":
        return ci()
    elif environment == "production":
        return prod()

def async_dev():
    return aio.ChainedTokenCredential(aio.AzureCliCredential())

def async_ci():
    return aio.ChainedTokenCredential(aio.EnvironmentCredential())

def async_prod():
    return aio.ChainedTokenCredential(
        aio.ManagedIdentityCredential(client_id=os.getenv("AZURE_CLIENT_ID")),
        aio.WorkloadIdentityCredential(),
    )

def build_async(environment):
    if environment == "dev":
        return async_dev()
    elif environment == "ci":
        return async_ci()
    elif environment == "production":
        return async_prod()

def sync_probe(credential):
    try:
        token = credential.get_token(SCOPE, enable_cae=True)
        print(token.expires_on)
    except ClientAuthenticationError as failure:
        print(failure)

async def async_probe(credential):
    try:
        token = await credential.get_token(SCOPE, enable_cae=True)
        print(token.expires_on)
    except ClientAuthenticationError as failure:
        print(failure)

async def run():
    environment = detect()
    print(f"environment={environment}")
    print("strategy selected")
    sync_credential = build(environment)
    async_credential = build_async(environment)
    sync_probe(sync_credential)
    await async_probe(async_credential)

asyncio.run(run())
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});
