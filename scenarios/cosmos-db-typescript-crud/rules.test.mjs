import assert from "node:assert/strict";
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
} from "./tools/cosmos-typescript-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadTypeScriptWorkspace(goldenWorkspacePath);
const baselineWorkspace = loadTypeScriptWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33420505368", import.meta.url),
  ),
);

test("TypeScript reference application passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("TypeScript reference application passes every language check", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, completeWorkspace),
      true,
      check,
    );
  }
});

test("query without parameters fails the parameterized-query rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      'parameters: [{ name: "@category", value: "electronics" }],',
      "parameters: [],",
    ),
  };

  assert.equal(evaluateRule("prompt/parameterized-query", workspace), false);
  assert.equal(evaluateRule("prompt/cosmos-client", workspace), true);
});

test("replacing an unchanged item fails the replace-delete rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("item.quantity = 2;", ""),
  };

  assert.equal(evaluateRule("prompt/replace-delete", workspace), false);
});

test("unused query parameter fails the parameterized-query rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "SELECT * FROM c WHERE c.category = @category",
      "SELECT * FROM c",
    ),
  };

  assert.equal(evaluateRule("prompt/parameterized-query", workspace), false);
});

test("audited baseline Cosmos workspace passes every rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baselineWorkspace), true, rule);
  }
});

test("query alias and parameter identity must agree", () => {
  const cases = [
    baselineWorkspace.source.replace(
      "items.category = @category",
      "other.category = @category",
    ),
    baselineWorkspace.source.replace(
      'name: "@category"',
      'name: "@other"',
    ),
    baselineWorkspace.source.replace(
      'value: "electronics"',
      'value: "furniture"',
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/parameterized-query", {
        ...baselineWorkspace,
        source,
      }),
      false,
    );
  }
});

test("Cosmos client shorthand retains real import and binding provenance", () => {
  const cases = [
    baselineWorkspace.source.replace(
      'from "@azure/cosmos"',
      'from "fake-cosmos"',
    ),
    baselineWorkspace.source.replace(
      "const client = new CosmosClient({ endpoint, key });",
      'const client = new CosmosClient({ endpoint: "https://example", key: "fake" });',
    ),
    baselineWorkspace.source.replace(
      "const client = new CosmosClient({ endpoint, key });",
      "class CosmosClient {}\n  const client = new CosmosClient({ endpoint, key });",
    ),
    baselineWorkspace.source.replace(
      "async function main(): Promise<void> {",
      "async function main(CosmosClient): Promise<void> {",
    ),
    baselineWorkspace.source.replace(
      "const value = process.env[name];",
      'const value = "fake";',
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/cosmos-client", {
        ...baselineWorkspace,
        source,
      }),
      false,
    );
  }
});

test("immutable replace and delete preserve item reference identity and order", () => {
  const cases = [
    baselineWorkspace.source.replace(
      "{ ...item, quantity: 10 }",
      "{ ...item }",
    ),
    baselineWorkspace.source.replace(
      "{ ...item, quantity: 10 }",
      "{ ...item, quantity: 5 }",
    ),
    baselineWorkspace.source.replace(
      "container.item(item.id, item.category)",
      "container.item(other.id, item.category)",
    ),
    baselineWorkspace.source.replace(
      "container.item(item.id, item.category)",
      "container.item(item.id, item.name)",
    ),
    baselineWorkspace.source.replace(
      "await itemReference.delete();",
      "await otherReference.delete();",
    ),
    baselineWorkspace.source.replace(
      "await itemReference.replace<InventoryItem>(updatedItem);",
      "await itemReference.delete();\n  await itemReference.replace<InventoryItem>(updatedItem);",
    ),
    baselineWorkspace.source.replace(
      "const replaceResponse =",
      "itemReference = otherReference;\n  const replaceResponse =",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/replace-delete", {
        ...baselineWorkspace,
        source,
      }),
      false,
    );
  }
});
