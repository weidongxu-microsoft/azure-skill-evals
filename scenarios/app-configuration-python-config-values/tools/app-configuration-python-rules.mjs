import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const analyzerPath = fileURLToPath(
  new URL("./app_configuration_analyzer.py", import.meta.url),
);
const analysisCache = new WeakMap();

function analyze(workspace) {
  if (analysisCache.has(workspace)) return analysisCache.get(workspace);
  const result = spawnSync("python", [analyzerPath], {
    encoding: "utf8",
    input: JSON.stringify({ source: workspace.python ?? "" }),
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `App Configuration analysis failed: ${result.stderr || result.stdout}`,
    );
  }
  const analysis = JSON.parse(result.stdout);
  analysisCache.set(workspace, analysis);
  return analysis;
}

const rules = {
  "prompt/app-configuration-package": ({ dependencies }) =>
    /\bazure-appconfiguration\b/i.test(dependencies),
  "prompt/configuration-client": ({ python }) =>
    /\bAzureAppConfigurationClient(?:\s*\(|\.from_connection_string\s*\()/.test(
      python,
    ),
  "prompt/set-settings": ({ python }) =>
    /\.set_configuration_setting\s*\(/.test(python) &&
    /["']app:Settings:FontSize["']/.test(python) &&
    /["']24["']/.test(python),
  "prompt/production-label": ({ python }) =>
    /\blabel\s*=\s*["']Production["']/.test(python),
  "prompt/get-list-settings": (workspace) =>
    analyze(workspace).get_list_settings,
  "prompt/enabled-feature-flag": ({ python }) =>
    /\.set_configuration_setting\s*\([\s\S]{0,320}?\bFeatureFlagConfigurationSetting\s*\([\s\S]{0,240}?feature_id\s*=\s*["']BetaFeature["'][\s\S]{0,160}?enabled\s*=\s*True/.test(
      python,
    ),
  "prompt/delete-error": ({ python }) =>
    /\.delete_configuration_setting\s*\(/.test(python) &&
    /\bexcept\s+HttpResponseError\b/.test(python),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }
  return rule(workspace);
}

export function ruleNames() {
  return Object.keys(rules);
}
