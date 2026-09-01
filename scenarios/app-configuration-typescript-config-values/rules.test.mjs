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
} from "./tools/app-configuration-typescript-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadTypeScriptWorkspace(goldenWorkspacePath);

test.skip("TypeScript App Configuration reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip("TypeScript App Configuration reference passes every language check", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, completeWorkspace),
      true,
      check,
    );
  }
});

test.skip("disabled feature flag fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "enabled: true",
      "enabled: false",
    ),
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});

test.skip("unfiltered listing fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      'keyFilter: "app:Settings:*"',
      'keyFilter: "*"',
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test.skip("predeclared production settings are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
const production = { key: "key", value: "24", label: "Production" };
await client.setConfigurationSetting(production);
`,
  };

  assert.equal(evaluateRule("prompt/production-label", workspace), true);
});

test.skip("retrieved values must be printed", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("console.log(setting.value);", ""),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test.skip("unused feature flags fail their prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
const featureFlag = {
  contentType: featureFlagContentType,
  value: { id: "BetaFeature", enabled: true },
};
`,
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});
