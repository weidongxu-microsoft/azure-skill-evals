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
    hasEnabledFeatureFlag(source),
  "prompt/delete-error": ({ source }) =>
    /\.deleteConfigurationSetting\s*\(/.test(source) &&
    /\bcatch\s*\(\s*HttpResponseException\b/.test(source) &&
    /\.getStatusCode\s*\(\s*\)/.test(source),
};

function maskJavaSource(source, maskStrings = true) {
  let result = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line") {
      result += current === "\n" ? "\n" : " ";
      if (current === "\n") state = "code";
    } else if (state === "block") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
    } else if (state === "string" || state === "character") {
      if (current === "\\") {
        result += maskStrings ? "  " : current + next;
        index += 1;
      } else {
        const closes =
          (state === "string" && current === '"') ||
          (state === "character" && current === "'");
        result += maskStrings && !closes && current !== "\n" ? " " : current;
        if (closes) state = "code";
      }
    } else if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block";
    } else {
      result += current;
      if (current === '"') state = "string";
      if (current === "'") state = "character";
    }
  }
  return result;
}

function matchingClosing(code, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1;
    if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(text) {
  const code = maskJavaSource(text);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    if (")]}".includes(code[index])) depth -= 1;
    if (code[index] === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function expressionEnd(code, start) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    if (")]}".includes(code[index])) depth -= 1;
    if (code[index] === ";" && depth === 0) return index;
  }
  return code.length;
}

function unwrapParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    const closing = matchingClosing(maskJavaSource(value), 0);
    if (closing !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function isEnabledFeatureFlagConstructor(expression) {
  const value = unwrapParentheses(expression);
  const match =
    /^new\s+(?:[A-Za-z_$]\w*\s*\.\s*)*FeatureFlagConfigurationSetting\s*\(/.exec(
      maskJavaSource(value),
    );
  if (!match) return false;
  const opening = maskJavaSource(value).indexOf("(", match.index);
  const closing = matchingClosing(maskJavaSource(value), opening);
  if (closing === -1 || value.slice(closing + 1).trim()) return false;
  const argumentsList = splitTopLevel(value.slice(opening + 1, closing));
  const featureName = maskJavaSource(argumentsList[0] ?? "", false).trim();
  const enabled = maskJavaSource(argumentsList[1] ?? "", false).trim();
  return argumentsList.length >= 2 &&
    /^["']BetaFeature["']$/.test(featureName) &&
    unwrapParentheses(enabled).replace(/\s+/g, "") === "true";
}

function latestAssignment(source, variable, position) {
  const code = maskJavaSource(source);
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?<![\\w$.])${escaped}\\s*=(?!=)`,
    "g",
  );
  let latest = null;
  for (const match of code.slice(0, position).matchAll(pattern)) {
    const equals = match.index + match[0].lastIndexOf("=");
    latest = source.slice(equals + 1, expressionEnd(code, equals + 1));
  }
  return latest;
}

function hasEnabledFeatureFlag(source) {
  const code = maskJavaSource(source);
  for (const match of code.matchAll(/\.setConfigurationSetting\s*\(/g)) {
    const opening = match.index + match[0].lastIndexOf("(");
    const closing = matchingClosing(code, opening);
    if (closing === -1) continue;
    const argumentsList = splitTopLevel(source.slice(opening + 1, closing));
    if (argumentsList.length !== 1) continue;
    const argument = unwrapParentheses(argumentsList[0]);
    if (isEnabledFeatureFlagConstructor(argument)) return true;
    if (!/^[A-Za-z_$]\w*$/.test(argument)) continue;
    const assignment = latestAssignment(source, argument, match.index);
    if (assignment && isEnabledFeatureFlagConstructor(assignment)) return true;
  }
  return false;
}

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
