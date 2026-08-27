const rules = {
  "prompt/app-configuration-package": ({ project }) =>
    /<PackageReference\s+Include="Azure\.Data\.AppConfiguration"/.test(project),
  "prompt/configuration-client": ({ source }) =>
    /\bnew\s+ConfigurationClient\s*\(/.test(source),
  "prompt/set-settings": ({ source }) =>
    /\.SetConfigurationSetting(?:Async)?\s*\(/.test(source) &&
    /["']app:Settings:FontSize["']/.test(source) &&
    /["']24["']/.test(source),
  "prompt/production-label": ({ source }) =>
    /\.SetConfigurationSetting(?:Async)?\s*\(/.test(source) &&
    /["']Production["']/.test(source),
  "prompt/get-list-settings": ({ source }) =>
    /\.GetConfigurationSetting(?:Async)?\s*\(/.test(source) &&
    /\.GetConfigurationSettings(?:Async)?\s*\(/.test(source) &&
    /\bKeyFilter\s*=\s*["']app:Settings:\*["']/.test(source) &&
    /\b(\w+)\s*=\s*[\s\S]{0,120}?GetConfigurationSetting(?:Async)?\s*\([\s\S]{0,240}?Console\.WriteLine\s*\([\s\S]{0,120}?\b\1(?:\.Value)?\.Value\b/.test(
      source,
    ),
  "prompt/enabled-feature-flag": ({ source }) =>
    (/\b(?:var|FeatureFlagConfigurationSetting)\s+(\w+)\s*=\s*new\s+FeatureFlagConfigurationSetting\s*\([\s\S]{0,160}?["']BetaFeature["'][\s\S]{0,120}?(?:isEnabled\s*:\s*)?true[\s\S]{0,240}?\.SetConfigurationSetting(?:Async)?\s*\(\s*\1\s*\)/.test(
      source,
    ) ||
      /\.SetConfigurationSetting(?:Async)?\s*\(\s*new\s+FeatureFlagConfigurationSetting\s*\([\s\S]{0,160}?["']BetaFeature["'][\s\S]{0,120}?(?:isEnabled\s*:\s*)?true/.test(
        source,
      )),
  "prompt/delete-error": ({ source }) =>
    /\.DeleteConfigurationSetting(?:Async)?\s*\(/.test(source) &&
    /\bcatch\s*\(\s*RequestFailedException\b/.test(source) &&
    /\.Status\b/.test(source),
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
