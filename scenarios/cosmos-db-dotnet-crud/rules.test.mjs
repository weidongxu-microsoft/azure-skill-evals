import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  dotnetCheckNames,
  evaluateDotnetCheck,
  loadDotnetWorkspace,
} from "../../languages/dotnet/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/cosmos-dotnet-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadDotnetWorkspace(goldenWorkspacePath);

test(".NET reference application passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test(".NET reference application passes every language check", () => {
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, completeWorkspace), true, check);
  }
});

test("incomplete item lifecycle fails the CRUD rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("ReplaceItemAsync", "UpdateAsync"),
  };

  assert.equal(evaluateRule("prompt/item-crud", workspace), false);
  assert.equal(evaluateRule("prompt/cosmos-client", workspace), true);
});

test("replacing an unchanged item fails the CRUD rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("item.quantity = 2;", ""),
  };

  assert.equal(evaluateRule("prompt/item-crud", workspace), false);
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
