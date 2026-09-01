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

test.skip("TypeScript reference application passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip("TypeScript reference application passes every language check", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, completeWorkspace),
      true,
      check,
    );
  }
});

test.skip("query without parameters fails the parameterized-query rule", () => {
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

test.skip("replacing an unchanged item fails the replace-delete rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("item.quantity = 2;", ""),
  };

  assert.equal(evaluateRule("prompt/replace-delete", workspace), false);
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
