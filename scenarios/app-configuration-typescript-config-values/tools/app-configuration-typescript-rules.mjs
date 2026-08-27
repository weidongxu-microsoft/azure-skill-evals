const rules = {
  "prompt/app-configuration-package": ({ packageJson }) =>
    /"@azure\/app-configuration"\s*:/.test(packageJson),
  "prompt/configuration-client": ({ source }) =>
    /\bnew\s+AppConfigurationClient\s*\(/.test(source),
  "prompt/set-settings": ({ source }) =>
    /\.setConfigurationSetting\s*\(/.test(source) &&
    /["']app:Settings:FontSize["']/.test(source) &&
    /["']24["']/.test(source),
  "prompt/production-label": ({ source }) =>
    /\.setConfigurationSetting\s*\(/.test(source) &&
    /\blabel\s*:\s*["']Production["']/.test(source),
  "prompt/get-list-settings": ({ source }) =>
    /\.getConfigurationSetting\s*\(/.test(source) &&
    /\.listConfigurationSettings\s*\([\s\S]{0,200}?keyFilter\s*:\s*["']app:Settings:\*["']/.test(
      source,
    ) &&
    /\bfor\s+await\s*\(/.test(source) &&
    /\bconst\s+(\w+)\s*=\s*await\s+\w+\.getConfigurationSetting\s*\([\s\S]{0,240}?console\.log\s*\([\s\S]{0,120}?\b\1\.value\b/.test(
      source,
    ),
  "prompt/enabled-feature-flag": ({ source }) =>
    /\bfeatureFlagContentType\b/.test(source) &&
    /\b(?:const|let|var)\s+(\w+)(?:\s*:[^=]+)?\s*=\s*\{[\s\S]{0,500}?\bid\s*:\s*["']BetaFeature["'][\s\S]{0,240}?\benabled\s*:\s*true[\s\S]{0,400}?\.setConfigurationSetting\s*\(\s*\1\s*\)/.test(
      source,
    ),
  "prompt/delete-error": ({ source }) =>
    /\.deleteConfigurationSetting\s*\(/.test(source) &&
    /\bcatch\s*\(/.test(source) &&
    /\.statusCode\b/.test(source),
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
