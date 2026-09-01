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
} from "./tools/app-configuration-java-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadJavaWorkspace(goldenWorkspacePath);

test.skip("Java App Configuration reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip("Java App Configuration reference passes every language check", () => {
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test.skip("disabled feature flag fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      'new FeatureFlagConfigurationSetting("BetaFeature", true)',
      'new FeatureFlagConfigurationSetting("BetaFeature", false)',
    ),
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});

test.skip("unfiltered listing fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      '.setKeyFilter("app:Settings:*")',
      '.setKeyFilter("*")',
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test.skip("predeclared production settings are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
ConfigurationSetting production = new ConfigurationSetting()
        .setLabel("Production");
client.setConfigurationSetting(production);
`,
  };

  assert.equal(evaluateRule("prompt/production-label", workspace), true);
});

test.skip("retrieved values must be printed", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "System.out.println(setting.getValue());",
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test.skip("unused feature flags fail their prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source:
      'var featureFlag = new FeatureFlagConfigurationSetting("BetaFeature", true);',
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});
