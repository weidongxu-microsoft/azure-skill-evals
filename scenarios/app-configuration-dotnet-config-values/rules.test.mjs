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
} from "./tools/app-configuration-dotnet-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadDotnetWorkspace(goldenWorkspacePath);

test(".NET App Configuration reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test(".NET App Configuration reference passes every language check", () => {
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, completeWorkspace), true, check);
  }
});

test("disabled feature flag fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "isEnabled: true",
      "isEnabled: false",
    ),
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});

test("unfiltered listing fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      'KeyFilter = "app:Settings:*"',
      'KeyFilter = "*"',
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test("predeclared production settings are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
var production = new ConfigurationSetting("key", "24", "Production");
await client.SetConfigurationSettingAsync(production);
`,
  };

  assert.equal(evaluateRule("prompt/production-label", workspace), true);
});

test("retrieved values must be printed", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "Console.WriteLine(response.Value.Value);",
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test("unused feature flags fail their prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
var featureFlag = new FeatureFlagConfigurationSetting(
    "BetaFeature",
    isEnabled: true);
`,
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});
