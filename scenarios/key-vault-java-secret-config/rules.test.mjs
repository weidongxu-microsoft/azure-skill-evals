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
} from "./tools/secret-config-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);

function change(from, to) {
  return { ...golden, source: golden.source.replaceAll("\r\n", "\n").replaceAll(from, to) };
}

test.skip("the pinned golden passes every scenario and shared Java check", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, golden), true, rule);
  for (const rule of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(rule, golden), true, rule);
  }
});

test.skip("both exact active Maven pins are required", () => {
  for (const version of ["1.18.5", "4.11.2"]) {
    assert.equal(
      evaluateRule("prompt/sdk-dependencies", {
        ...golden,
        build: golden.build.replace(`<version>${version}</version>`, "<version>0.0.1</version>"),
      }),
      false,
    );
  }
});

test.skip("fake, unreachable, and path-incompatible evidence fails", () => {
  const fake = {
    sourceFiles: ["Main.java"],
    source: `class SecretClient {} class Main {
      static void unused() { if (false) { client.beginDeleteSecret(name); poller.waitForCompletion(); client.purgeDeletedSecret(name); client.setSecret(secret); } }
      public static void main(String[] args) { System.out.println("skip"); }
    }`,
    build: golden.build,
  };
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }

  const split = change(
    `        SyncPoller<DeletedSecret, Void> poller =
                client.beginDeleteSecret(name);
        poller.waitForCompletion();
        client.purgeDeletedSecret(name);
        client.setSecret(replacement(name, value, expiresOn));`,
    `        if (value.isBlank()) {
            SyncPoller<DeletedSecret, Void> poller =
                    client.beginDeleteSecret(name);
            poller.waitForCompletion();
            client.purgeDeletedSecret(name);
        } else {
            client.setSecret(replacement(name, value, expiresOn));
        }`,
  );
  assert.equal(evaluateRule("prompt/sync-safe-rotation", split), false);
  assert.equal(
    evaluateRule(
      "prompt/async-safe-rotation",
      change("client.purgeDeletedSecret(name)", "otherClient.purgeDeletedSecret(name)"),
    ),
    false,
  );
});

test.skip("focused mutations remove each required behavior", () => {
  const cases = [
    ["prompt/managed-identity-configuration", ".buildAsyncClient()", ".buildClient()"],
    ["prompt/sync-provider", "client.getSecret(name, version)", "client.getSecret(name)"],
    ["prompt/async-provider", ".onErrorResume(", ".doOnError("],
    ["prompt/expiry-aware-cache", "OffsetDateTime.now().plus(warningWindow)", "OffsetDateTime.now()"],
    ["prompt/sync-safe-rotation", "poller.waitForCompletion();", "System.out.println(poller);"],
    ["prompt/async-safe-rotation", "return poller.last()", "return Mono.empty()"],
    ["prompt/connected-demo", "runSyncDemo(clients);\n        runAsyncDemo(clients);", "runAsyncDemo(clients);\n        runSyncDemo(clients);"],
  ];
  for (const [rule, from, to] of cases) {
    assert.equal(evaluateRule(rule, change(from, to)), false, rule);
  }
});

test.skip("loader, cache, and helper names may vary", () => {
  const renamed = {
    ...golden,
    source: golden.source
      .replaceAll("loadConfiguration", "createClientsFromEnvironment")
      .replaceAll("bulkLoad", "warmCache")
      .replaceAll("refreshExpiring", "checkExpiring")
      .replaceAll("rotateSync", "replaceSync")
      .replaceAll("rotateAsync", "replaceAsync"),
  };
  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, renamed), true, rule);
});
