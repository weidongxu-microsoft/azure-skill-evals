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
} from "./tools/todo-repository-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadJavaWorkspace(goldenPath);
const evalSpec = readFileSync(
  fileURLToPath(new URL("./eval.yaml", import.meta.url)),
  "utf8",
);

function workspace(source, build = golden.build) {
  return {
    sourceFiles: ["src/main/java/com/example/Application.java"],
    buildFiles: ["pom.xml"],
    buildManifests: [{ name: "pom.xml", content: build }],
    source,
    build,
  };
}

test("Java golden passes every prompt rule and shared check", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/source-manifest",
    "prompt/todo-model",
    "prompt/secure-container-factory",
    "prompt/sync-crud-request-charges",
    "prompt/async-crud-request-charges",
    "prompt/etag-conflict-handling",
    "prompt/sync-parameterized-pagination",
    "prompt/async-parameterized-pagination",
    "prompt/connected-sync-then-async-demo",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, golden), true, check);
  }
});

test("Java 17 and exact active SDK pins are required and stated", () => {
  assert.match(evalSpec, /`com\.azure:azure-cosmos` to `4\.82\.0`/);
  assert.match(evalSpec, /`com\.azure:azure-identity` to `1\.18\.5`/);
  for (const [from, to] of [
    ["<maven.compiler.release>17", "<maven.compiler.release>21"],
    ["<version>4.82.0</version>", "<version>4.81.0</version>"],
    ["<version>1.18.5</version>", "<version>1.18.4</version>"],
  ]) {
    assert.equal(
      evaluateRule("prompt/source-manifest", {
        ...golden,
        build: golden.build.replace(from, to),
        buildManifests: [{
          name: "pom.xml",
          content: golden.build.replace(from, to),
        }],
      }),
      false,
      `${from} -> ${to}`,
    );
  }
});

test("focused Java omissions fail their own criteria", () => {
  const cases = [
    ["prompt/todo-model", golden.source.replaceAll("description", "details")],
    [
      "prompt/secure-container-factory",
      golden.source.replace("90 * 24 * 60 * 60", "89 * 24 * 60 * 60"),
    ],
    [
      "prompt/sync-crud-request-charges",
      golden.source.replace(
        '            logCharge("sync create", response.getRequestCharge());',
        "",
      ),
    ],
    [
      "prompt/async-crud-request-charges",
      golden.source.replace(
        '                        logCharge("async create", response.getRequestCharge()))',
        '                        logCharge("async create", 0.0))',
      ),
    ],
    [
      "prompt/etag-conflict-handling",
      golden.source.replaceAll(
        "setIfMatchETag(item.getEtag())",
        "setIfMatchETag(null)",
      ),
    ],
    [
      "prompt/sync-parameterized-pagination",
      golden.source.replaceAll(
        'new SqlParameter("@category", category)',
        'new SqlParameter("@other", category)',
      ),
    ],
    [
      "prompt/async-parameterized-pagination",
      golden.source.replace(
        ".byPage(null, pageSize)",
        ".byPage()",
      ),
    ],
    [
      "prompt/connected-sync-then-async-demo",
      golden.source.replace("        runSyncDemo();", ""),
    ],
  ];
  for (const [rule, source] of cases) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test("valid Java page-size and helper-name alternatives pass", () => {
  const alternate = golden.source
    .replace(
      "results.iterableByPage(null, pageSize)",
      "results.iterableByPage(pageSize)",
    )
    .replace(".byPage(null, pageSize)", ".byPage(pageSize)")
    .replaceAll("requireEnvironment", "readConfiguredEndpoint");
  assert.equal(
    evaluateRule("prompt/sync-parameterized-pagination", workspace(alternate)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/secure-container-factory", workspace(alternate)),
    true,
  );
});

test("comments, strings, and fake Java SDK types do not score", () => {
  const decoy = `
class CosmosClientBuilder {
    CosmosClientBuilder endpoint(String value) { return this; }
    CosmosClientBuilder credential(Object value) { return this; }
    CosmosClientBuilder buildClient() { return this; }
}
class ManagedIdentityCredentialBuilder {
    Object build() { return this; }
}
class Application {
    public static void main(String[] args) {
        String notes = "createItem readItem replaceItem deleteItem getRequestCharge";
        // new CosmosClientBuilder().endpoint(System.getenv("AZURE_COSMOS_ENDPOINT"));
        System.out.println(notes);
    }
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/source-manifest",
  )) {
    assert.equal(evaluateRule(rule, workspace(decoy)), false, rule);
  }
});

test("unreachable and disconnected Java behavior does not score", () => {
  const dead = golden.source.replace(
    "public static void main(String[] args) {",
    `public static void main(String[] args) {
        return;`,
  );
  for (const rule of ruleNames().filter(
    (name) => !["prompt/source-manifest", "prompt/todo-model"].includes(name),
  )) {
    assert.equal(evaluateRule(rule, workspace(dead)), false, rule);
  }

  const disconnected = golden.source
    .replace("        runSyncDemo();", "")
    .replace("        runAsyncDemo();", "");
  assert.equal(
    evaluateRule("prompt/connected-sync-then-async-demo", workspace(disconnected)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/sync-crud-request-charges", workspace(disconnected)),
    false,
  );
});

test("Java pagination evidence must remain on one result path", () => {
  const incompatible = golden.source.replace(
    "results.iterableByPage(null, pageSize)",
    "otherResults.iterableByPage(null, pageSize)",
  );
  assert.equal(
    evaluateRule("prompt/sync-parameterized-pagination", workspace(incompatible)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/async-parameterized-pagination", workspace(incompatible)),
    true,
  );
});
