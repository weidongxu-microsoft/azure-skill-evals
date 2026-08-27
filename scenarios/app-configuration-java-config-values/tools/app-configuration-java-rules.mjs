const rules = {
  "prompt/app-configuration-package": ({ build }) =>
    /<groupId>com\.azure<\/groupId>[\s\S]{0,120}?<artifactId>azure-data-appconfiguration<\/artifactId>/.test(
      build,
    ),
  "prompt/configuration-client": ({ source }) =>
    /\bConfigurationClientBuilder\s*\(\s*\)/.test(source) &&
    /\.connectionString\s*\(/.test(source) &&
    /\.buildClient\s*\(\s*\)/.test(source),
  "prompt/set-settings": ({ source }) =>
    /\.setConfigurationSetting\s*\(/.test(source) &&
    /["']app:Settings:FontSize["']/.test(source) &&
    /["']24["']/.test(source),
  "prompt/production-label": ({ source }) =>
    /\.setConfigurationSetting\s*\(/.test(source) &&
    /(?:["']Production["']|\.setLabel\s*\(\s*["']Production["'])/.test(source),
  "prompt/get-list-settings": ({ source }) =>
    /\.getConfigurationSetting\s*\(/.test(source) &&
    /\.listConfigurationSettings\s*\(/.test(source) &&
    /\.setKeyFilter\s*\(\s*["']app:Settings:\*["']/.test(source) &&
    /\b(\w+)\s*=\s*[\s\S]{0,120}?\.getConfigurationSetting\s*\([\s\S]{0,240}?System\.out\.(?:print|println|printf)\s*\([\s\S]{0,120}?\b\1\.getValue\s*\(\s*\)/.test(
      source,
    ),
  "prompt/enabled-feature-flag": ({ source }) =>
    /\.setConfigurationSetting\s*\([\s\S]{0,240}?\bFeatureFlagConfigurationSetting\s*\(\s*["']BetaFeature["']\s*,\s*true/.test(
      source,
    ),
  "prompt/delete-error": ({ source }) =>
    /\.deleteConfigurationSetting\s*\(/.test(source) &&
    /\bcatch\s*\(\s*HttpResponseException\b/.test(source) &&
    /\.getStatusCode\s*\(\s*\)/.test(source),
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
