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
const baselineWorkspace = loadJavaWorkspace(
  fileURLToPath(new URL("./fixtures/baseline-33403910898", import.meta.url)),
);

test("Java App Configuration reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("Java App Configuration reference passes every language check", () => {
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test("baseline 33403910898 workspace passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baselineWorkspace), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, baselineWorkspace), true, check);
  }
});

test("disabled feature flag fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      'new FeatureFlagConfigurationSetting("BetaFeature", true)',
      'new FeatureFlagConfigurationSetting("BetaFeature", false)',
    ),
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});

test("unfiltered listing fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      '.setKeyFilter("app:Settings:*")',
      '.setKeyFilter("*")',
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test("predeclared production settings are accepted", () => {
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

test("retrieved values must be printed", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "System.out.println(setting.getValue());",
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test("unused feature flags fail their prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    source:
      'var featureFlag = new FeatureFlagConfigurationSetting("BetaFeature", true);',
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});

test("assigned enabled feature flags accept supported declaration types", () => {
  for (const declaration of [
    "final FeatureFlagConfigurationSetting betaFeature",
    "var betaFeature",
    "ConfigurationSetting betaFeature",
  ]) {
    const workspace = {
      ...completeWorkspace,
      source: `
${declaration} =
    new FeatureFlagConfigurationSetting("BetaFeature", true);
client.setConfigurationSetting(betaFeature);
`,
    };
    assert.equal(
      evaluateRule("prompt/enabled-feature-flag", workspace),
      true,
      declaration,
    );
  }
});

test("feature flag assignment resolution has no proximity limit", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
ConfigurationSetting betaFeature =
    new FeatureFlagConfigurationSetting("BetaFeature", true);
${"// intentionally distant formatting\n".repeat(30)}
client.setConfigurationSetting(
    betaFeature
);
`,
  };
  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), true);
});

test("feature flag calls use the nearest assignment to the passed variable", () => {
  for (const source of [
    `
var betaFeature =
    new FeatureFlagConfigurationSetting("BetaFeature", false);
client.setConfigurationSetting(betaFeature);
`,
    `
var betaFeature =
    new FeatureFlagConfigurationSetting("BetaFeature", true);
var otherFeature =
    new FeatureFlagConfigurationSetting("BetaFeature", false);
client.setConfigurationSetting(otherFeature);
`,
    `
var betaFeature =
    new FeatureFlagConfigurationSetting("BetaFeature", true);
betaFeature = new FeatureFlagConfigurationSetting("BetaFeature", false);
client.setConfigurationSetting(betaFeature);
`,
  ]) {
    assert.equal(
      evaluateRule("prompt/enabled-feature-flag", {
        ...completeWorkspace,
        source,
      }),
      false,
      source,
    );
  }
});

test("comments and strings cannot supply an enabled feature flag", () => {
  const workspace = {
    ...completeWorkspace,
    source: `
String decoy = "client.setConfigurationSetting(new FeatureFlagConfigurationSetting(\\"BetaFeature\\", true))";
// client.setConfigurationSetting(new FeatureFlagConfigurationSetting("BetaFeature", true));
/*
var betaFeature =
    new FeatureFlagConfigurationSetting("BetaFeature", true);
client.setConfigurationSetting(betaFeature);
*/
client.setConfigurationSetting(
    new FeatureFlagConfigurationSetting("BetaFeature", false));
`,
  };
  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});
