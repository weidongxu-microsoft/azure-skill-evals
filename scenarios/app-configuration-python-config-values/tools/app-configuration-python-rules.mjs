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
  "prompt/get-list-settings": ({ python }) =>
    /\.get_configuration_setting\s*\(/.test(python) &&
    /\.list_configuration_settings\s*\([\s\S]{0,300}?key_filter\s*=\s*["']app:Settings:\*["']/.test(
      python,
    ) &&
    /\b(\w+)\s*=\s*\w+\.get_configuration_setting\s*\([\s\S]{0,240}?\bprint\s*\(\s*\1\.value\b/.test(
      python,
    ),
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
