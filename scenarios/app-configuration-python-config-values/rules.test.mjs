import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
  pythonCheckNames,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/app-configuration-python-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadPythonWorkspace(goldenWorkspacePath);
const baselinePath = fileURLToPath(
  new URL("./fixtures/baseline-33403910898", import.meta.url),
);
const baseline33403910898 = loadPythonWorkspace(baselinePath);

test("Python App Configuration reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("Python App Configuration reference passes every language check", () => {
  for (const check of pythonCheckNames()) {
    assert.equal(evaluatePythonCheck(check, completeWorkspace), true, check);
  }
});

test("baseline run 33403910898 exact output preserves its lifecycle failure", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33403910898), true, rule);
  }
  assert.equal(
    evaluatePythonCheck("language/client-lifecycle", baseline33403910898),
    false,
  );
});

test("disabled feature flag fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    python: completeWorkspace.python.replace("enabled=True", "enabled=False"),
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});

test("unfiltered listing fails its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    python: completeWorkspace.python.replace(
      'key_filter="app:Settings:*"',
      "",
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test("a wrong filter constant fails its prompt rule", () => {
  const workspace = {
    ...baseline33403910898,
    python: baseline33403910898.python.replace(
      'KEY_FILTER = "app:Settings:*"',
      'KEY_FILTER = "other:*"',
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test("connection-string factory and context manager are accepted", () => {
  const workspace = {
    ...completeWorkspace,
    python: `
with AzureAppConfigurationClient.from_connection_string(connection_string) as client:
    pass
`,
  };

  assert.equal(evaluateRule("prompt/configuration-client", workspace), true);
  assert.equal(
    evaluatePythonCheck("language/client-lifecycle", workspace),
    true,
  );
});

test("retrieved values must be printed", () => {
  const workspace = {
    ...completeWorkspace,
    python: completeWorkspace.python.replace("print(setting.value)", ""),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test("unrelated value output cannot satisfy the get result requirement", () => {
  const workspace = {
    ...baseline33403910898,
    python: baseline33403910898.python.replace(
      "print(setting.value)",
      "print(unrelated.value)",
    ),
  };

  assert.equal(evaluateRule("prompt/get-list-settings", workspace), false);
});

test("unused feature flags fail their prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    python: `
feature_flag = FeatureFlagConfigurationSetting(
    feature_id="BetaFeature",
    enabled=True,
)
`,
  };

  assert.equal(evaluateRule("prompt/enabled-feature-flag", workspace), false);
});
