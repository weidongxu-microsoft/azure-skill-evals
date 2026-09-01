import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateTypeScriptCheck,
  typeScriptCheckNames,
} from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/secret-config-typescript-rules.mjs";
import { loadSourceManifest } from "./tools/source-manifest.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadSourceManifest(goldenPath);

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

test.skip("the pinned golden passes every scenario and shared TypeScript check", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, golden), true, rule);
  for (const rule of typeScriptCheckNames()) {
    assert.equal(evaluateTypeScriptCheck(rule, golden), true, rule);
  }
});

test.skip("all exact active package pins are mandatory", () => {
  for (const version of ["1.25.0", "4.13.2", "4.11.2", "5.9.2", "26.2.0"]) {
    const manifest = JSON.parse(golden.packageJson);
    for (const group of [manifest.dependencies, manifest.devDependencies]) {
      for (const [name, value] of Object.entries(group ?? {})) {
        if (value === version) group[name] = "0.0.1";
      }
    }
    assert.equal(evaluateRule("prompt/packages", {
      ...golden,
      packageJson: JSON.stringify(manifest),
    }), false, version);
  }
});

test.skip("fake, unreachable, and path-incompatible evidence is rejected", () => {
  const fake = {
    sourceFiles: ["main.ts"],
    documents: [{
      path: "main.ts",
      source: `
class SecretClient {}
async function unused() {
  if (false) {
    const poller = await client.beginDeleteSecret(name);
    await poller.pollUntilDone();
    await client.purgeDeletedSecret(name);
    await client.setSecret(name, value, { expiresOn });
  }
}
console.log("skip");
`,
    }],
    packageJson: golden.packageJson,
  };
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }

  const split = change(
    "src/rotation.ts",
    `  const poller = await client.beginDeleteSecret(name);
  await poller.pollUntilDone();
  await client.purgeDeletedSecret(name);
  await client.setSecret(name, value, { expiresOn });`,
    `  if (value) {
    const poller = await client.beginDeleteSecret(name);
    await poller.pollUntilDone();
    await client.purgeDeletedSecret(name);
  } else {
    await client.setSecret(name, value, { expiresOn });
  }`,
  );
  assert.equal(evaluateRule("prompt/safe-delete-purge-recreate", split), false);
  assert.equal(
    evaluateRule(
      "prompt/safe-delete-purge-recreate",
      change("src/rotation.ts", "await poller.pollUntilDone();", "await otherPoller.pollUntilDone();"),
    ),
    false,
  );
});

test.skip("focused mutations remove every required behavior", () => {
  const cases = [
    ["prompt/managed-identity-configuration", "src/config.ts", "process.env.AZURE_KEY_VAULT_URL", '"https://hardcoded.vault.azure.net"'],
    ["prompt/versioned-provider", "src/provider.ts", "version ? { version } : {}", "{}"],
    ["prompt/not-found-default", "src/provider.ts", "error.statusCode === 404", "error.statusCode === 500"],
    ["prompt/expiry-aware-cache", "src/cache.ts", "Date.now() + this.warningWindowMs", "Date.now()"],
    ["prompt/version-based-rotation", "src/rotation.ts", "await client.setSecret(name, value, { expiresOn });", "await client.setSecret(name, value);"],
    ["prompt/safe-delete-purge-recreate", "src/rotation.ts", "await poller.pollUntilDone();", "void poller;"],
    ["prompt/connected-demo", "src/main.ts", "await cache.refreshExpiring();", ""],
  ];
  for (const [rule, path, from, to] of cases) {
    assert.equal(evaluateRule(rule, change(path, from, to)), false, rule);
  }
});

test.skip("legitimate loader, object-cache, and helper forms are accepted", () => {
  const renamed = {
    ...golden,
    documents: golden.documents.map((document) => ({
      ...document,
      source: document.source
        .replaceAll("createSecretClient", "loadConfiguration")
        .replaceAll("bulkLoad", "warmCache")
        .replaceAll("refreshExpiring", "checkExpiring")
        .replaceAll("rotateVersion", "createVersion")
        .replaceAll("cleanupAndRecreate", "replaceAfterCleanup"),
    })),
  };
  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, renamed), true, rule);

  const objectCache = {
    ...golden,
    documents: golden.documents.map((document) => ({
      ...document,
      source: document.path === "src/cache.ts"
        ? document.source
          .replace("private readonly values = new Map<string, ConfigSecret>();", "private readonly values: Record<string, ConfigSecret> = {};")
          .replace("this.values.has(name)", "name in this.values")
          .replace("this.values.get(name)?.value", "this.values[name]?.value")
          .replace("this.values.set(name, secret)", "this.values[name] = secret")
          .replace("[...this.values]", "Object.entries(this.values)")
        : document.source,
    })),
  };
  assert.equal(evaluateRule("prompt/expiry-aware-cache", objectCache), true);
});
