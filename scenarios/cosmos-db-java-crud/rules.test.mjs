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
} from "./tools/cosmos-java-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadJavaWorkspace(goldenWorkspacePath);

test.skip("Java reference application passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip("Java reference application passes every language check", () => {
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test.skip("literal SQL without a parameter fails the query rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      'List.of(new SqlParameter("@category", "electronics"))',
      "List.of()",
    ),
  };

  assert.equal(evaluateRule("prompt/parameterized-query", workspace), false);
  assert.equal(evaluateRule("prompt/query-iteration", workspace), true);
});

test.skip("replacing an unchanged item fails the CRUD rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("item.setQuantity(2);", ""),
  };

  assert.equal(evaluateRule("prompt/item-crud", workspace), false);
});

test.skip("unused query parameter fails the parameterized-query rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "SELECT * FROM c WHERE c.category = @category",
      "SELECT * FROM c",
    ),
  };

  assert.equal(evaluateRule("prompt/parameterized-query", workspace), false);
});
