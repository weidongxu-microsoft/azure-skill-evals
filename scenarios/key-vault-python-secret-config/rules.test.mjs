import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
  pythonCheckNames,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  loadWorkspace,
  ruleNames,
} from "./tools/secret-config-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadWorkspace(goldenPath);

function change(path, from, to) {
  return {
    ...golden,
    documents: golden.documents.map((document) => ({
      ...document,
      source: document.path === path
        ? document.source.replaceAll("\r\n", "\n").replaceAll(from, to)
        : document.source,
    })),
  };
}

test("the pinned golden passes every scenario and shared Python check", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-packages",
    "prompt/managed-identity-configuration",
    "prompt/sync-provider",
    "prompt/async-provider",
    "prompt/expiry-aware-cache",
    "prompt/sync-safe-rotation",
    "prompt/async-safe-rotation",
    "prompt/connected-demo",
  ]);
  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, golden), true, rule);
  const shared = loadPythonWorkspace(goldenPath);
  for (const rule of pythonCheckNames()) {
    assert.equal(evaluatePythonCheck(rule, shared), true, rule);
  }
});

test("exact active package pins are mandatory", () => {
  for (const [from, to] of [
    ["azure-identity==1.25.3", "azure-identity>=1.25.3"],
    ["azure-keyvault-secrets==4.11.2", "azure-keyvault-secrets==0.0.1"],
  ]) {
    const candidate = {
      ...golden,
      dependencyManifests: golden.dependencyManifests.map((manifest) => ({
        ...manifest,
        content: manifest.content.replace(from, to),
      })),
    };
    assert.equal(evaluateRule("prompt/sdk-packages", candidate), false);
  }
});

test("fake, unreachable, and disconnected evidence is rejected", () => {
  const fake = {
    documents: [{
      path: "main.py",
      source: `
class SecretClient:
    def get_secret(self, name, version=None): pass
def never_called(default="x"):
    if False:
        client = SecretClient()
        secret = client.get_secret("name", version="v1")
        return secret.properties.expires_on
print("skip")
`,
    }],
    dependencyManifests: golden.dependencyManifests,
  };
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }

  const splitRotation = change(
    "rotation.py",
    `    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)
    client.set_secret(name, value, expires_on=expires_on)`,
    `    if value:
        poller = client.begin_delete_secret(name)
        poller.wait()
        client.purge_deleted_secret(name)
    else:
        client.set_secret(name, value, expires_on=expires_on)`,
  );
  assert.equal(evaluateRule("prompt/sync-safe-rotation", splitRotation), false);
});

test("version, default, expiry, cache, and poller requirements have focused negatives", () => {
  const cases = [
    ["prompt/sync-provider", "provider.py", "version=version", ""],
    ["prompt/async-provider", "provider.py", "await self._client.get_secret", "self._client.get_secret"],
    ["prompt/expiry-aware-cache", "cache.py", "self.refresh(name)", "print(name)"],
    ["prompt/sync-safe-rotation", "rotation.py", "poller.wait()", "print(poller)"],
    ["prompt/async-safe-rotation", "rotation.py", "await poller.wait()", "poller.wait()"],
    ["prompt/connected-demo", "main.py", "run_sync_demo()\n    asyncio.run(run_async_demo())", "asyncio.run(run_async_demo())\n    run_sync_demo()"],
  ];
  for (const [rule, path, from, to] of cases) {
    assert.equal(evaluateRule(rule, change(path, from, to)), false, rule);
  }
});

test("legitimate loader and helper names are not overfit to the golden", () => {
  const renamed = {
    ...golden,
    documents: golden.documents.map((document) => ({
      ...document,
      source: document.source
        .replaceAll("create_sync_client", "load_sync_configuration")
        .replaceAll("create_async_client", "load_async_configuration")
        .replaceAll("bulk_load", "warm_cache")
        .replaceAll("refresh_expiring", "check_expiring"),
    })),
  };
  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, renamed), true, rule);
});
