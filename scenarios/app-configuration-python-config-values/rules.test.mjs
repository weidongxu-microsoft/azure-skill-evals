import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
const baseline33420505368Path = fileURLToPath(
  new URL("./fixtures/baseline-33420505368", import.meta.url),
);
const baseline33420505368 = loadPythonWorkspace(baseline33420505368Path);
const scenarioPath = fileURLToPath(new URL(".", import.meta.url));

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

test("baseline run 33420505368 exact output passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33420505368), true, rule);
  }
});

test("declared eval files stage every referenced analyzer", () => {
  const evalSource = readFileSync(join(scenarioPath, "eval.yaml"), "utf8");
  const rulesSource = readFileSync(
    join(scenarioPath, "tools", "app-configuration-python-rules.mjs"),
    "utf8",
  );
  const declarations = [
    ...evalSource.matchAll(
      /- src: ([^\r\n]+)\r?\n\s+dest: ([^\r\n]+)/g,
    ),
  ].map((match) => ({ src: match[1].trim(), dest: match[2].trim() }));
  const analyzers = [
    ...rulesSource.matchAll(/new URL\("\.\/([^"]+_analyzer\.py)"/g),
  ].map((match) => match[1]);
  for (const analyzer of analyzers) {
    assert.ok(
      declarations.some(({ dest }) => dest.endsWith(`/tools/${analyzer}`)),
      analyzer,
    );
  }

  const workspace = join(scenarioPath, ".declared-environment-fixture");
  rmSync(workspace, { recursive: true, force: true });
  try {
    mkdirSync(workspace, { recursive: true });
    for (const entry of readdirSync(baseline33420505368Path, {
      withFileTypes: true,
    })) {
      if (entry.isFile()) {
        copyFileSync(
          join(baseline33420505368Path, entry.name),
          join(workspace, entry.name),
        );
      }
    }
    for (const { src, dest } of declarations) {
      const destination = join(workspace, dest);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(scenarioPath, src), destination);
    }
    const result = spawnSync(
      "node",
      [
        join(
          workspace,
          ".vally",
          "scenarios",
          "app-configuration-python-config-values",
          "tools",
          "check-app-configuration-python.mjs",
        ),
        "prompt/get-list-settings",
      ],
      { cwd: workspace, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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
