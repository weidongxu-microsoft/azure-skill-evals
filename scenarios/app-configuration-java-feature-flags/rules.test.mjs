import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
} from "./tools/app-configuration-feature-flags-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);
const evalSpec = readFileSync(
  fileURLToPath(new URL("./eval.yaml", import.meta.url)),
  "utf8",
);

function workspace(source, build = golden.build) {
  return {
    sourceFiles: ["src/main/java/example/Application.java"],
    buildFiles: ["pom.xml"],
    source,
    build,
  };
}

test.skip("the Java 17 golden passes prompt and shared Java checks", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/source-manifest",
    "prompt/managed-identity-clients",
    "prompt/configuration-reads",
    "prompt/conditional-etag-reads",
    "prompt/feature-flag-json",
    "prompt/deterministic-rollout",
    "prompt/sentinel-refresh",
    "prompt/connected-sync-async-demo",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, golden), true, check);
  }
});

test.skip("the Maven manifest requires Java 17 and both exact active pins", () => {
  for (const [from, to] of [
    ["<maven.compiler.release>17", "<maven.compiler.release>21"],
    ["<version>1.10.1</version>", "<version>1.10.0</version>"],
    ["<version>1.18.5</version>", "<version>1.18.4</version>"],
  ]) {
    assert.equal(
      evaluateRule("prompt/source-manifest", {
        ...golden,
        build: golden.build.replace(from, to),
      }),
      false,
      `${from} -> ${to}`,
    );
  }

  const duplicate = golden.build.replace(
    "</dependencies>",
    `<dependency>
       <groupId>com.azure</groupId>
       <artifactId>azure-identity</artifactId>
       <version>1.18.4</version>
     </dependency>
   </dependencies>`,
  );
  assert.equal(
    evaluateRule("prompt/source-manifest", { ...golden, build: duplicate }),
    false,
  );
});

test.skip("the eval stimulus preserves the Hyoka task without solution recipes", () => {
  assert.match(
    evalSpec,
    /A \*\*configuration service class\*\* \(both sync and async versions\)/,
  );
  assert.match(
    evalSpec,
    /Feature flags in App Configuration use a special key prefix/,
  );
  assert.match(
    evalSpec,
    /Run the full demo with the sync implementation first, then repeat with the async implementation/,
  );
  assert.match(evalSpec, /azure-data-appconfiguration` to `1\.10\.1/);
  assert.match(evalSpec, /azure-identity` to `1\.18\.5/);
  assert.doesNotMatch(evalSpec, /getConfigurationSettingWithResponse/);
  assert.doesNotMatch(evalSpec, /setIfNoneMatch|Context\.NONE/);
});

test.skip("comments, strings, fake SDK types, and unreachable helpers do not count", () => {
  const decoy = `
class ManagedIdentityCredentialBuilder {
  ManagedIdentityCredentialBuilder build() { return this; }
}
class ConfigurationClientBuilder {
  ConfigurationClientBuilder endpoint(String value) { return this; }
  ConfigurationClientBuilder credential(Object value) { return this; }
  ConfigurationClient buildClient() { return null; }
  ConfigurationAsyncClient buildAsyncClient() { return null; }
}
class ConfigurationClient {}
class ConfigurationAsyncClient {}
class Decoy {
  static void unused() {
    String prose = "getConfigurationSettingWithResponse(setting, null, true, Context.NONE)";
    // new ConfigurationClientBuilder().endpoint(System.getenv("AZURE_APPCONFIG_ENDPOINT"));
    if (false) {
      new ConfigurationClientBuilder().buildClient();
    }
  }
  public static void main(String[] args) {
  }
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(decoy)), false, rule);
  }

  const helpersDisconnected = golden.source
    .replace("        runSyncDemo(syncService);", "")
    .replace("        runAsyncDemo(asyncService).block();", "");
  for (const rule of [
    "prompt/configuration-reads",
    "prompt/conditional-etag-reads",
    "prompt/feature-flag-json",
    "prompt/sentinel-refresh",
    "prompt/connected-sync-async-demo",
  ]) {
    assert.equal(
      evaluateRule(rule, workspace(helpersDisconnected)),
      false,
      rule,
    );
  }
});

test.skip("operations after return and disconnected decoys do not count", () => {
  const deadMain = golden.source.replace(
    "public static void main(String[] args) {",
    `public static void main(String[] args) {
        return;`,
  );
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(deadMain)), false, rule);
  }

  const without304 = golden.source.replaceAll(
    "response.getStatusCode() == 304",
    "response.getStatusCode() == 200",
  );
  const disconnected304 = `${without304}
class StatusDecoy {
    static boolean unused(com.azure.core.http.rest.Response<?> response) {
        if (response.getStatusCode() == 304) {
            return false;
        }
        throw new IllegalStateException();
    }
}`;
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(disconnected304),
    ),
    false,
  );

  const deadConditionalCall = golden.source.replace(
    /Response<ConfigurationSetting> response =\s*client\.getConfigurationSettingWithResponse\(/,
    `        return new ConditionalResult(false, cached);
        Response<ConfigurationSetting> response =
                client.getConfigurationSettingWithResponse(`,
  );
  assert.notEqual(deadConditionalCall, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(deadConditionalCall),
    ),
    false,
  );
});

test.skip("workspace definitions in exact Azure SDK packages are rejected", () => {
  const shadow = `${golden.source}
package com.azure.data.appconfiguration;
public class ConfigurationClientBuilder {}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(shadow)), false, rule);
  }

  const missingSdkImport = golden.source.replace(
    "import com.azure.data.appconfiguration.ConfigurationClientBuilder;",
    'String importDecoy = "import com.azure.data.appconfiguration.ConfigurationClientBuilder;";',
  );
  assert.equal(
    evaluateRule(
      "prompt/managed-identity-clients",
      workspace(missingSdkImport),
    ),
    false,
  );
});

test.skip("managed identity clients reject hardcoded endpoints and wrong credentials", () => {
  const hardcodedWithDecoy = golden.source
    .replace(
      'String endpoint = requireEnvironment("AZURE_APPCONFIG_ENDPOINT");',
      `String ignored = System.getenv("AZURE_APPCONFIG_ENDPOINT");
        String endpoint = "https://fixed.azconfig.io";`,
    );
  assert.equal(
    evaluateRule(
      "prompt/managed-identity-clients",
      workspace(hardcodedWithDecoy),
    ),
    false,
  );

  const lateDecoy = golden.source
    .replace(
      'String endpoint = requireEnvironment("AZURE_APPCONFIG_ENDPOINT");',
      'String endpoint = "https://fixed.azconfig.io";',
    )
    .replace(
      "ConfigurationAsyncClient asyncClient = builder.buildAsyncClient();",
      `ConfigurationAsyncClient asyncClient = builder.buildAsyncClient();
        endpoint = System.getenv("AZURE_APPCONFIG_ENDPOINT");`,
    );
  assert.equal(
    evaluateRule("prompt/managed-identity-clients", workspace(lateDecoy)),
    false,
  );

  const defaultCredential = golden.source
    .replace(
      "import com.azure.identity.ManagedIdentityCredentialBuilder;",
      "import com.azure.identity.DefaultAzureCredentialBuilder;",
    )
    .replaceAll(
      "ManagedIdentityCredentialBuilder",
      "DefaultAzureCredentialBuilder",
    );
  assert.equal(
    evaluateRule(
      "prompt/managed-identity-clients",
      workspace(defaultCredential),
    ),
    false,
  );

  const renamedSourceHelper = golden.source.replaceAll(
    "requireEnvironment",
    "readConfiguredEndpoint",
  );
  assert.equal(
    evaluateRule(
      "prompt/managed-identity-clients",
      workspace(renamedSourceHelper),
    ),
    true,
  );
});

test.skip("real 1.10.1 conditional overloads and both outcomes are required", () => {
  const wrongSync = golden.source.replace(
    "request, null, true, Context.NONE",
    "request, null, true",
  );
  assert.equal(
    evaluateRule("prompt/conditional-etag-reads", workspace(wrongSync)),
    false,
  );

  const nonexistentAsync = golden.source.replace(
    /request, null, true\)\s*\.map\(response/,
    "request, null, true, Context.NONE).map(response",
  );
  assert.notEqual(nonexistentAsync, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(nonexistentAsync),
    ),
    false,
  );

  const noNotModified = golden.source.replaceAll(
    "response.getStatusCode() == 304",
    "response.getStatusCode() == 200",
  );
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(noNotModified),
    ),
    false,
  );
});

test.skip("conditional reads preserve baseline, 304, replacement, and error semantics", () => {
  const firstReadChanged = golden.source
    .replace(
      "new ConditionalResult(false, getDirect(key, label))",
      "new ConditionalResult(true, getDirect(key, label))",
    )
    .replace(
      "new ConditionalResult(false, setting));",
      "new ConditionalResult(true, setting));",
    );
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(firstReadChanged),
    ),
    false,
  );

  const modified304 = golden.source.replaceAll(
    "new ConditionalResult(false, cached)",
    "new ConditionalResult(true, response.getValue())",
  );
  assert.equal(
    evaluateRule("prompt/conditional-etag-reads", workspace(modified304)),
    false,
  );

  const noReplacement = golden.source.replaceAll(
    "cache.put(cacheKey(key, label), changed);",
    "",
  );
  assert.equal(
    evaluateRule("prompt/conditional-etag-reads", workspace(noReplacement)),
    false,
  );

  const swallowedErrors = golden.source.replaceAll(
    /if \(response\.getStatusCode\(\) < 200 \|\| response\.getStatusCode\(\) >= 300\) \{\s*throw new IllegalStateException\(\s*"Unexpected App Configuration status: "\s*\+ response\.getStatusCode\(\)\);\s*\}/g,
    "",
  );
  assert.notEqual(swallowedErrors, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/conditional-etag-reads",
      workspace(swallowedErrors),
    ),
    false,
  );
});

test.skip("feature flags require the official prefix and parsed JSON payload", () => {
  const wrongPrefix = golden.source.replace(
    '".appconfig.featureflag/"',
    '"features/"',
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(wrongPrefix)),
    false,
  );

  const noParsing = golden.source.replace(
    "BinaryData.fromString(json).toObject(Map.class)",
    "Map.of(\"enabled\", true)",
  );
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(noParsing)),
    false,
  );
});

test.skip("the feature flag enabled state controls the result", () => {
  const ignoredEnabled = golden.source.replace(
    /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
    'document.get("enabled");',
  );
  assert.notEqual(ignoredEnabled, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(ignoredEnabled)),
    false,
  );

  const alternateControl = golden.source.replace(
    /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
    `boolean active = Boolean.TRUE.equals(document.get("enabled"));
        if (active) {
        } else {
            return false;
        }`,
  );
  assert.notEqual(alternateControl, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(alternateControl)),
    true,
  );

  const directGuard = golden.source.replace(
    /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
    'if (!Boolean.TRUE.equals(document.get("enabled"))) return false;',
  );
  assert.notEqual(directGuard, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(directGuard)),
    true,
  );

  const fixedRegardlessOfEnabled = golden.source
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      'boolean active = Boolean.TRUE.equals(document.get("enabled"));',
    )
    .replace(
      "return rolloutBucket(flagId, userId) < percentage;",
      `return active
                    ? rolloutBucket(flagId, userId) < 50
                    : rolloutBucket(flagId, userId) < 50;`,
    );
  assert.notEqual(fixedRegardlessOfEnabled, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/feature-flag-json",
      workspace(fixedRegardlessOfEnabled),
    ),
    false,
  );

  const meaningfulTernary = golden.source
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      'boolean active = Boolean.TRUE.equals(document.get("enabled"));',
    )
    .replace(
      "return rolloutBucket(flagId, userId) < percentage;",
      `return active
                    ? rolloutBucket(flagId, userId) < percentage
                    : false;`,
    );
  assert.notEqual(meaningfulTernary, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(meaningfulTernary)),
    true,
  );
});

test.skip("enabled tautologies do not control Java feature results", () => {
  const tautology = golden.source
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      'boolean active = Boolean.TRUE.equals(document.get("enabled"));',
    )
    .replace(
      "return rolloutBucket(flagId, userId) < percentage;",
      "return (active || !active) && rolloutBucket(flagId, userId) < percentage;",
    );
  assert.notEqual(tautology, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(tautology)),
    false,
  );

  const enabledOrCheck = golden.source
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      'boolean active = Boolean.TRUE.equals(document.get("enabled"));',
    )
    .replace(
      "return rolloutBucket(flagId, userId) < percentage;",
      `boolean check1 = rolloutBucket(flagId, userId) < percentage;
            boolean check2 = percentage >= 0;
            return (active || check1) && check2;`,
    );
  assert.notEqual(enabledOrCheck, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(enabledOrCheck)),
    false,
  );
});

test.skip("enabled helper guards remain valid in Java", () => {
  const helperGuard = golden.source
    .replace(
      '    @SuppressWarnings("unchecked")',
      `    static boolean flagIsActive(Map<String, Object> document) {
        return Boolean.TRUE.equals(document.get("enabled"));
    }

    @SuppressWarnings("unchecked")`,
    )
    .replace(
      /if \(!Boolean\.TRUE\.equals\(document\.get\("enabled"\)\)\) \{\s*return false;\s*\}/,
      `if (!flagIsActive(document)) {
            return false;
        }`,
    );
  assert.notEqual(helperGuard, golden.source);
  assert.equal(
    evaluateRule("prompt/feature-flag-json", workspace(helperGuard)),
    true,
  );
});

test.skip("percentage rollout depends on both flag and user with a stable digest", () => {
  const random = golden.source.replace(
    /try \{\s*MessageDigest digest[\s\S]*?\} catch \(NoSuchAlgorithmException exception\) \{[\s\S]*?\}/,
    "return (int) (Math.random() * 100);",
  );
  assert.equal(
    evaluateRule("prompt/deterministic-rollout", workspace(random)),
    false,
  );

  const alternateHash = golden.source.replace(
    /try \{\s*MessageDigest digest[\s\S]*?\} catch \(NoSuchAlgorithmException exception\) \{[\s\S]*?\}/,
    `return Math.floorMod(
            (flagId + ":" + userId).hashCode(), 100);`,
  );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-rollout",
      workspace(alternateHash),
    ),
    false,
  );

  const constant = golden.source.replace(
    /try \{\s*MessageDigest digest[\s\S]*?\} catch \(NoSuchAlgorithmException exception\) \{[\s\S]*?\}/,
    "return 17;",
  );
  assert.equal(
    evaluateRule("prompt/deterministic-rollout", workspace(constant)),
    false,
  );

  for (const input of ["flagId", "userId"]) {
    const independent = golden.source.replace(
      '(flagId + ":" + userId).getBytes(StandardCharsets.UTF_8)',
      `${input}.getBytes(StandardCharsets.UTF_8)`,
    );
    assert.equal(
      evaluateRule(
        "prompt/deterministic-rollout",
        workspace(independent),
      ),
      false,
      input,
    );
  }

  const renamedHelper = golden.source
    .replaceAll("rolloutBucket", "stableCohort")
    .replace(
      "static int stableCohort(String flagId, String userId)",
      "static int stableCohort(String featureName, String subjectId)",
    )
    .replace(
      '(flagId + ":" + userId).getBytes(StandardCharsets.UTF_8)',
      '(featureName + ":" + subjectId).getBytes(StandardCharsets.UTF_8)',
    );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-rollout",
      workspace(renamedHelper),
    ),
    true,
  );

  const combinedInputHelper = golden.source
    .replace(
      "rolloutBucket(flagId, userId)",
      'stableDigest(flagId + ":" + userId)',
    )
    .replace(
      "static int rolloutBucket(String flagId, String userId)",
      "static int stableDigest(String cohortKey)",
    )
    .replace(
      '(flagId + ":" + userId).getBytes(StandardCharsets.UTF_8)',
      "cohortKey.getBytes(StandardCharsets.UTF_8)",
    );
  assert.equal(
    evaluateRule(
      "prompt/deterministic-rollout",
      workspace(combinedInputHelper),
    ),
    true,
  );
});

test.skip("sentinel refresh requires interval polling and change-gated refresh", () => {
  const noInterval = golden.source.replaceAll(
    "pollingInterval.toMillis()",
    "1000L",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(noInterval)),
    false,
  );

  const noConditionalRefresh = golden.source
    .replace(
      /if \(changed\) \{\s*syncService\.refreshPrefix\(refreshPrefix\);\s*\}/,
      "syncService.refreshPrefix(refreshPrefix);",
    )
    .replace(
      /changed\s*\?\s*asyncService\.refreshPrefixAsync\(refreshPrefix\)\s*:\s*Mono\.empty\(\)/,
      "asyncService.refreshPrefixAsync(refreshPrefix)",
    );
  assert.notEqual(noConditionalRefresh, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/sentinel-refresh",
      workspace(noConditionalRefresh),
    ),
    false,
  );
});

test.skip("fixed-rate scheduling and renamed watcher helpers are accepted", () => {
  const fixedRate = golden.source.replaceAll(
    "scheduleWithFixedDelay",
    "scheduleAtFixedRate",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(fixedRate)),
    true,
  );

  const renamed = golden.source
    .replaceAll("checkOnceAsync", "pollSentinelsReactive")
    .replaceAll("checkOnce", "pollSentinels")
    .replaceAll("sentinelChangedAsync", "hasSentinelMovedReactive")
    .replaceAll("sentinelChanged", "hasSentinelMoved")
    .replaceAll("refreshPrefixAsync", "reloadCachedPrefixReactive")
    .replaceAll("refreshPrefix", "reloadCachedPrefix")
    .replaceAll("startAsync", "beginReactivePolling")
    .replaceAll("start", "beginPolling");
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(renamed)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/connected-sync-async-demo", workspace(renamed)),
    true,
  );
});

test.skip("watcher lifecycle guards duplicate starts and cancels scheduled work", () => {
  const duplicateStarts = golden.source.replaceAll(
    /if \(isRunning\(\)\) \{\s*return;\s*\}/g,
    "",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(duplicateStarts)),
    false,
  );

  const leakedTask = golden.source.replace(
    "pollingTask.cancel(true);",
    "pollingTask.isCancelled();",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(leakedTask)),
    false,
  );

  const leakedSubscription = golden.source.replace(
    "asyncPoll.dispose();",
    "asyncPoll.isDisposed();",
  );
  assert.equal(
    evaluateRule("prompt/sentinel-refresh", workspace(leakedSubscription)),
    false,
  );

  const immediateClose = golden.source
    .replace(/\s*watcher\.awaitFirstPoll\(\);/, "")
    .replace(/\.then\(watcher\.awaitFirstPollAsync\(\)\)/, "");
  assert.notEqual(immediateClose, golden.source);
  assert.equal(
    evaluateRule(
      "prompt/connected-sync-async-demo",
      workspace(immediateClose),
    ),
    false,
  );
});

test.skip("sync and async demos must be connected, ordered, and consumed", () => {
  const unblocked = golden.source.replace(
    "runAsyncDemo(asyncService).block();",
    "runAsyncDemo(asyncService);",
  );
  assert.equal(
    evaluateRule("prompt/connected-sync-async-demo", workspace(unblocked)),
    false,
  );

  const asyncFirst = golden.source
    .replace("runSyncDemo(syncService);", "__SYNC_DEMO__")
    .replace(
      "runAsyncDemo(asyncService).block();",
      `runSyncDemo(syncService);
        __ASYNC_DEMO__`,
    )
    .replace("__SYNC_DEMO__", "runAsyncDemo(asyncService).block();")
    .replace("__ASYNC_DEMO__", "");
  assert.equal(
    evaluateRule("prompt/connected-sync-async-demo", workspace(asyncFirst)),
    false,
  );

  const incompatible = golden.source
    .replace("runAsyncDemo(asyncService).block();", "")
    .replace(
      "runSyncDemo(syncService);",
      `if (System.nanoTime() > 0) {
            runSyncDemo(syncService);
        } else {
            runAsyncDemo(asyncService).block();
        }`,
    );
  assert.equal(
    evaluateRule(
      "prompt/connected-sync-async-demo",
      workspace(incompatible),
    ),
    false,
  );
});

test.skip("legitimate direct label reads and equivalent condition polarity pass", () => {
  const directLabels = golden.source
    .replace(
      /SettingSelector selector = new SettingSelector\(\)\s*\.setKeyFilter\(key\)\s*\.setLabelFilter\(label\);\s*ConfigurationSetting setting = client\.listConfigurationSettings\(selector\)[\s\S]*?cache\.put\(cacheKey\(key, label\), setting\);/,
      `ConfigurationSetting setting =
                client.getConfigurationSetting(key, label);
        cache.put(cacheKey(key, label), setting);`,
    )
    .replace(
      /SettingSelector selector = new SettingSelector\(\)\s*\.setKeyFilter\(key\)\s*\.setLabelFilter\(label\);\s*return client\.listConfigurationSettings\(selector\)[\s\S]*?\.doOnNext\(setting ->\s*cache\.put\(cacheKey\(setting\.getKey\(\), setting\.getLabel\(\)\), setting\)\);/,
      `return client.getConfigurationSetting(key, label)
                .doOnNext(setting ->
                        cache.put(cacheKey(setting.getKey(), setting.getLabel()), setting));`,
    )
    .replaceAll(
      "response.getStatusCode() == 304",
      "304 == response.getStatusCode()",
    );
  assert.equal(
    evaluateRule("prompt/configuration-reads", workspace(directLabels)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/conditional-etag-reads", workspace(directLabels)),
    true,
  );
});

test.skip("all prompt graders reject an empty generated workspace", () => {
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
