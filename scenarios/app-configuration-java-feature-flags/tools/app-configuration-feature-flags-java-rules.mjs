const SDK_TYPES = {
  configurationClient: {
    name: "ConfigurationClient",
    packageName: "com.azure.data.appconfiguration",
  },
  configurationAsyncClient: {
    name: "ConfigurationAsyncClient",
    packageName: "com.azure.data.appconfiguration",
  },
  configurationClientBuilder: {
    name: "ConfigurationClientBuilder",
    packageName: "com.azure.data.appconfiguration",
  },
  configurationSetting: {
    name: "ConfigurationSetting",
    packageName: "com.azure.data.appconfiguration.models",
  },
  settingSelector: {
    name: "SettingSelector",
    packageName: "com.azure.data.appconfiguration.models",
  },
  managedIdentityCredentialBuilder: {
    name: "ManagedIdentityCredentialBuilder",
    packageName: "com.azure.identity",
  },
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskJava(source, preserveStrings = false) {
  let result = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        result += "\n";
        state = "code";
      } else {
        result += " ";
      }
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
    } else if (state === "text-block") {
      if (source.startsWith('"""', index)) {
        result += preserveStrings ? '"""' : "   ";
        index += 2;
        state = "code";
      } else {
        result += preserveStrings
          ? character
          : character === "\n"
            ? "\n"
            : " ";
      }
    } else if (state === "string" || state === "character") {
      if (character === "\\") {
        result += preserveStrings
          ? `${character}${source[index + 1] ?? ""}`
          : "  ";
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        result += preserveStrings ? character : " ";
        state = "code";
      } else {
        result += preserveStrings
          ? character
          : character === "\n"
            ? "\n"
            : " ";
      }
    } else if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else if (source.startsWith('"""', index)) {
      result += preserveStrings ? '"""' : "   ";
      index += 2;
      state = "text-block";
    } else if (character === '"') {
      result += preserveStrings ? character : " ";
      state = "string";
    } else if (character === "'") {
      result += preserveStrings ? character : " ";
      state = "character";
    } else {
      result += character;
    }
  }
  return result;
}

function matchingIndex(text, start, opening = "(", closing = ")") {
  if (start < 0 || text[start] !== opening) return -1;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(text) {
  const result = [];
  const depth = { "(": 0, "[": 0, "{": 0, "<": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character in depth) {
      if (
        character !== "<" ||
        (/[\w$?.\]]/.test(text[index - 1] ?? "") &&
          /[\w$?@]/.test(text[index + 1] ?? ""))
      ) {
        depth[character] += 1;
      }
    } else if (character in closing) {
      depth[closing[character]] -= 1;
    } else if (character === ">" && depth["<"] > 0) {
      depth["<"] -= 1;
    } else if (
      character === "," &&
      Object.values(depth).every((value) => value === 0)
    ) {
      result.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last || result.length > 0) result.push(last);
  return result;
}

function importsAndTypes(code) {
  const imports = new Set(
    Array.from(
      code.matchAll(
        /\bimport\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$*][\w$*]*)*)\s*;/g,
      ),
      (match) => match[1].replace(/\s+/g, ""),
    ),
  );
  const localTypes = new Set(
    Array.from(
      code.matchAll(
        /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g,
      ),
      (match) => match[1],
    ),
  );
  return { imports, localTypes };
}

function typePattern(context, key) {
  const type = SDK_TYPES[key];
  const qualified = `${type.packageName}.${type.name}`;
  const conflictingImport = [...context.imports].some(
    (value) => value.endsWith(`.${type.name}`) && value !== qualified,
  );
  const simpleAllowed =
    !context.localTypes.has(type.name) &&
    !conflictingImport &&
    (context.imports.has(qualified) ||
      context.imports.has(`${type.packageName}.*`));
  const qualifiedPattern = qualified
    .split(".")
    .map(escapeRegExp)
    .join("\\s*\\.\\s*");
  return simpleAllowed
    ? `(?:${qualifiedPattern}|${escapeRegExp(type.name)})`
    : qualifiedPattern;
}

function hasLocalAzureSdkDefinition(code) {
  return /\bpackage\s+com\s*\.\s*azure(?:\s*\.\s*[\w$]+)*\s*;[\s\S]*?\b(?:class|interface|enum|record)\s+(?:ConfigurationClient|ConfigurationAsyncClient|ConfigurationClientBuilder|ConfigurationSetting|SettingSelector|ManagedIdentityCredentialBuilder)\b/.test(
    code,
  );
}

function parameterCount(parameters) {
  return parameters.trim() ? splitTopLevel(parameters).length : 0;
}

function parseMethods(code, literal) {
  const methods = [];
  const typeRanges = [];
  for (const declaration of code.matchAll(
    /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)[^{]*\{/g,
  )) {
    const open = code.indexOf("{", declaration.index);
    const close = matchingIndex(code, open, "{", "}");
    if (close >= 0) {
      typeRanges.push({
        name: declaration[1],
        start: declaration.index,
        end: close + 1,
      });
    }
  }
  const pattern =
    /(?:^|[;{}])\s*((?:(?:public|protected|private|static|final|synchronized|native|abstract|strictfp)\s+)*(?:<[^;{}()]+>\s*)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*(?:\s*<[^;{}()]+>)?(?:\s*\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^{}]+)?\{/gm;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    if (
      ["if", "for", "while", "switch", "catch", "try", "new"].includes(
        match[2],
      )
    ) {
      continue;
    }
    const open = code.indexOf("{", match.index + match[0].lastIndexOf("{"));
    const close = matchingIndex(code, open, "{", "}");
    if (close < 0) continue;
    const owner = typeRanges
      .filter((range) => range.start < match.index && range.end > close)
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      )[0];
    methods.push({
      id: methods.length,
      modifiersAndType: match[1],
      name: match[2],
      arity: parameterCount(match[3]),
      parameters: match[3],
      code: code.slice(open + 1, close),
      literal: literal.slice(open + 1, close),
      start: match.index,
      end: close + 1,
      owner,
    });
    pattern.lastIndex = close + 1;
  }

  return methods;
}

function parameterNames(method) {
  return splitTopLevel(method.parameters).map((parameter) => {
    const withoutAnnotations = parameter
      .replace(/@\w+(?:\s*\([^)]*\))?/g, " ")
      .replace(/\bfinal\b/g, " ")
      .trim();
    return /([A-Za-z_$][\w$]*)\s*$/.exec(withoutAnnotations)?.[1] ?? "";
  });
}

function isExecutableMain(method) {
  if (method.name !== "main") return false;
  const normalized = method.modifiersAndType.replace(/\s+/g, " ").trim();
  if (
    !/\bpublic\b/.test(normalized) ||
    !/\bstatic\b/.test(normalized) ||
    !/\bvoid\s*$/.test(normalized)
  ) {
    return false;
  }
  const parameters = method.parameters.replace(/\s+/g, "");
  return /^(?:java\.lang\.)?String(?:\[\]\w+|\w+\[\]|\.\.\.\w+)$/.test(
    parameters,
  );
}

function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function statementRange(code, start) {
  const begin = skipWhitespace(code, start);
  if (code[begin] === "{") {
    const close = matchingIndex(code, begin, "{", "}");
    return { start: begin, end: close + 1, contentStart: begin + 1, contentEnd: close };
  }
  let parentheses = 0;
  for (let index = begin; index < code.length; index += 1) {
    if (code[index] === "(") parentheses += 1;
    else if (code[index] === ")") parentheses -= 1;
    else if (code[index] === ";" && parentheses === 0) {
      return { start: begin, end: index + 1, contentStart: begin, contentEnd: index + 1 };
    }
  }
  return { start: begin, end: code.length, contentStart: begin, contentEnd: code.length };
}

function staticBoolean(condition) {
  const value = condition.replace(/\s+/g, "");
  if (["true", "Boolean.TRUE", "1==1"].includes(value)) return true;
  if (["false", "Boolean.FALSE", "1==2", "1!=1"].includes(value)) return false;
  return null;
}

function firstConditional(code) {
  const pattern = /\bif\s*\(/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    if (close < 0) continue;
    const consequent = statementRange(code, close + 1);
    if (consequent.end <= consequent.start) continue;
    const elseStart = skipWhitespace(code, consequent.end);
    let alternate = null;
    if (code.slice(elseStart, elseStart + 4) === "else") {
      alternate = statementRange(code, elseStart + 4);
    }
    return {
      start: match.index,
      condition: code.slice(open + 1, close),
      consequent,
      alternate,
      end: alternate?.end ?? consequent.end,
    };
  }
  return null;
}

function removeDeadTail(code, literal) {
  const controlledStatements = conditionalsIn(code).flatMap((conditional) =>
    [conditional.consequent, conditional.alternate].filter(Boolean)
  );
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    if (
      braces === 0 &&
      parentheses === 0 &&
      brackets === 0 &&
      /^(?:return|throw)\b/.test(code.slice(index, index + 8)) &&
      !/[\w$]/.test(code[index - 1] ?? "") &&
      !controlledStatements.some(
        (statement) => index >= statement.start && index < statement.end,
      )
    ) {
      let nestedParentheses = 0;
      for (let end = index; end < code.length; end += 1) {
        if (code[end] === "(") nestedParentheses += 1;
        else if (code[end] === ")") nestedParentheses -= 1;
        else if (code[end] === ";" && nestedParentheses === 0) {
          return {
            code: code.slice(0, end + 1),
            literal: literal.slice(0, end + 1),
          };
        }
      }
    }
  }
  return { code, literal };
}

function branchVariants(code, literal, limit = 48) {
  const pending = [{ code, literal }];
  const completed = [];
  while (pending.length > 0 && completed.length < limit) {
    const current = pending.shift();
    const conditional = firstConditional(current.code);
    if (!conditional) {
      completed.push(removeDeadTail(current.code, current.literal));
      continue;
    }
    const condition = staticBoolean(conditional.condition);
    const choices =
      condition === true
        ? [conditional.consequent]
        : condition === false
          ? [conditional.alternate]
          : [conditional.consequent, conditional.alternate];
    for (const choice of choices) {
      const replacementCode =
        `${conditional.condition};\n` +
        (choice
          ? current.code.slice(choice.contentStart, choice.contentEnd)
          : "");
      const replacementLiteral =
        `${current.literal.slice(
          current.code.indexOf(conditional.condition, conditional.start),
          current.code.indexOf(conditional.condition, conditional.start) +
            conditional.condition.length,
        )};\n` +
        (choice
          ? current.literal.slice(choice.contentStart, choice.contentEnd)
          : "");
      pending.push({
        code:
          current.code.slice(0, conditional.start) +
          replacementCode +
          current.code.slice(conditional.end),
        literal:
          current.literal.slice(0, conditional.start) +
          replacementLiteral +
          current.literal.slice(conditional.end),
      });
      if (pending.length + completed.length >= limit) break;
    }
  }
  return [...completed, ...pending].slice(0, limit);
}

function callArity(code, open) {
  const close = matchingIndex(code, open);
  if (close < 0) return null;
  return {
    arity: parameterCount(code.slice(open + 1, close)),
    close,
  };
}

function localCalls(code, literal, methodsByName) {
  const calls = [];
  const seen = new Set();
  for (const [name, candidates] of methodsByName) {
    const pattern = new RegExp(
      `(?:\\b${escapeRegExp(name)}\\s*\\(|::\\s*${escapeRegExp(name)}\\b)`,
      "g",
    );
    for (const match of code.matchAll(pattern)) {
      if (match[0].includes("::")) {
        for (const candidate of candidates) {
          if (!seen.has(candidate.id)) {
            seen.add(candidate.id);
            calls.push(candidate);
          }
        }
        continue;
      }
      const before = code.slice(Math.max(0, match.index - 16), match.index);
      if (/\b(?:class|interface|record|enum|new)\s*$/.test(before)) continue;
      const open = code.indexOf("(", match.index);
      const details = callArity(literal, open);
      if (!details) continue;
      for (const candidate of candidates.filter(
        (method) => method.arity === details.arity,
      )) {
        if (!seen.has(candidate.id)) {
          seen.add(candidate.id);
          calls.push(candidate);
        }
      }
    }
  }
  return calls;
}

function localCallSites(code, literal, methodsByName) {
  const calls = [];
  for (const [name, candidates] of methodsByName) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g");
    for (const match of code.matchAll(pattern)) {
      const before = code.slice(Math.max(0, match.index - 24), match.index);
      if (/\b(?:class|interface|record|enum|new)\s*$/.test(before)) continue;
      const open = code.indexOf("(", match.index);
      const details = callArity(literal, open);
      if (!details) continue;
      const args = splitTopLevel(literal.slice(open + 1, details.close));
      for (const method of candidates.filter(
        (candidate) => candidate.arity === details.arity,
      )) {
        calls.push({ method, args, start: match.index, end: details.close + 1 });
      }
    }
  }
  return calls;
}

function mergeDependencies(...values) {
  const result = {
    params: new Set(),
    config: false,
    featurePrefix: false,
    enabled: false,
    percentage: false,
    stableHash: false,
    managedIdentity: false,
  };
  for (const value of values) {
    if (!value) continue;
    for (const parameter of value.params ?? []) result.params.add(parameter);
    for (const property of Object.keys(result).filter(
      (name) => name !== "params",
    )) {
      result[property] ||= Boolean(value[property]);
    }
  }
  return result;
}

function emptyDependencies() {
  return mergeDependencies();
}

function substituteDependencies(dependencies, argumentDependencies) {
  const result = mergeDependencies(dependencies);
  result.params.clear();
  for (const index of dependencies.params ?? []) {
    const argument = argumentDependencies[index];
    if (!argument) continue;
    const substituted = mergeDependencies(result, argument);
    Object.assign(result, substituted);
    result.params = substituted.params;
  }
  return result;
}

function expressionDependencies(
  code,
  literal,
  variables,
  returnSummaries,
  methodsByName,
) {
  const dependencies = emptyDependencies();
  if (
    /\bSystem\s*\.\s*(?:getenv|getProperty)\s*\(/.test(code)
  ) {
    dependencies.config = true;
  }
  if (
    /["']\.appconfig\.featureflag\/["']/.test(literal) ||
    /\bFeatureFlagConfigurationSetting\s*\.\s*KEY_PREFIX\b/.test(code)
  ) {
    dependencies.featurePrefix = true;
  }
  if (
    /["']enabled["']/.test(literal) &&
    /\.(?:get|path)\s*\(/.test(code)
  ) {
    dependencies.enabled = true;
  }
  if (
    /["'](?:Value|value)["']/.test(literal) &&
    /\.(?:get|path)\s*\(/.test(code)
  ) {
    dependencies.percentage = true;
  }
  if (
    /\bMessageDigest\s*\.\s*getInstance\s*\(/.test(code) ||
    /\.digest\s*\(/.test(code)
  ) {
    dependencies.stableHash = true;
  }
  const managedIdentityType = SDK_TYPES.managedIdentityCredentialBuilder;
  const qualifiedCredential = `${managedIdentityType.packageName}.${managedIdentityType.name}`
    .split(".")
    .map(escapeRegExp)
    .join("\\s*\\.\\s*");
  if (
    new RegExp(
      `new\\s+(?:${qualifiedCredential}|${managedIdentityType.name})\\s*\\([^)]*\\)\\s*\\.\\s*build\\s*\\(`,
    ).test(code)
  ) {
    dependencies.managedIdentity = true;
  }

  for (const identifier of code.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const value = variables.get(identifier[1]);
    if (value) {
      const merged = mergeDependencies(dependencies, value);
      Object.assign(dependencies, merged);
      dependencies.params = merged.params;
    }
  }

  for (const [name, candidates] of methodsByName) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g");
    for (const match of code.matchAll(pattern)) {
      const before = code.slice(Math.max(0, match.index - 16), match.index);
      if (/\bnew\s*$/.test(before)) continue;
      const open = code.indexOf("(", match.index);
      const details = callArity(literal, open);
      if (!details) continue;
      const args = splitTopLevel(literal.slice(open + 1, details.close));
      const argumentDependencies = args.map((argument) =>
        expressionDependencies(
          maskJava(argument, false),
          maskJava(argument, true),
          variables,
          returnSummaries,
          methodsByName,
        )
      );
      for (const candidate of candidates.filter(
        (method) => method.arity === details.arity,
      )) {
        const summary = returnSummaries.get(candidate.id);
        if (!summary) continue;
        const substituted = substituteDependencies(
          summary,
          argumentDependencies,
        );
        const merged = mergeDependencies(dependencies, substituted);
        Object.assign(dependencies, merged);
        dependencies.params = merged.params;
      }
    }
  }
  return dependencies;
}

function assignmentsFor(code, literal) {
  const assignments = [];
  const pattern =
    /(?:^|[;{}])\s*(?:(?:(?:public|protected|private|static|final|volatile|transient)\s+)*(?:var|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;={}]+>)?(?:\s*\[\s*\])?)\s+)?(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;]+);/gmd;
  for (const match of code.matchAll(pattern)) {
    const expressionStart = match.indices[2][0];
    assignments.push({
      name: match[1],
      code: match[2],
      literal: literal.slice(
        expressionStart,
        expressionStart + match[2].length,
      ),
      start: match.index,
    });
  }
  return assignments.sort((left, right) => left.start - right.start);
}

function variablesForMethod(
  method,
  returnSummaries,
  methodsByName,
  parameterBindings,
  before = Number.POSITIVE_INFINITY,
) {
  const variables = new Map(returnSummaries.globals ?? []);
  parameterNames(method).forEach((name, index) => {
    variables.set(
      name,
      parameterBindings?.[index] ??
        mergeDependencies({ params: new Set([index]) }),
    );
  });
  for (const assignment of assignmentsFor(method.code, method.literal)
    .filter((candidate) => candidate.start < before)) {
    variables.set(
      assignment.name,
      expressionDependencies(
        assignment.code,
        assignment.literal,
        variables,
        returnSummaries,
        methodsByName,
      ),
    );
  }
  return variables;
}

function returnedExpressions(method) {
  const values = [];
  for (const match of method.code.matchAll(/\breturn\s+([^;]+);/gd)) {
    const start = match.indices[1][0];
    values.push({
      code: match[1],
      literal: method.literal.slice(start, start + match[1].length),
    });
  }
  return values;
}

function dependencySignature(value) {
  return JSON.stringify({
    params: [...value.params].sort(),
    config: value.config,
    featurePrefix: value.featurePrefix,
    enabled: value.enabled,
    percentage: value.percentage,
    stableHash: value.stableHash,
    managedIdentity: value.managedIdentity,
  });
}

function returnSummariesFor(runtime) {
  const summaries = new Map(
    runtime.methods.map((method) => [method.id, emptyDependencies()]),
  );
  summaries.globals = new Map();
  const globalPattern =
    /\bstatic\s+final\s+(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;={}]+>)?)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
  for (const match of runtime.literal.matchAll(globalPattern)) {
    const expressionLiteral = match[2];
    summaries.globals.set(
      match[1],
      expressionDependencies(
        maskJava(expressionLiteral, false),
        expressionLiteral,
        summaries.globals,
        summaries,
        runtime.methodsByName,
      ),
    );
  }
  for (let iteration = 0; iteration < runtime.methods.length + 2; iteration += 1) {
    let changed = false;
    for (const method of runtime.methods) {
      const variables = variablesForMethod(
        method,
        summaries,
        runtime.methodsByName,
      );
      const summary = mergeDependencies(
        ...returnedExpressions(method).map((expression) =>
          expressionDependencies(
            expression.code,
            expression.literal,
            variables,
            summaries,
            runtime.methodsByName,
          )
        ),
      );
      if (
        dependencySignature(summary) !==
        dependencySignature(summaries.get(method.id))
      ) {
        summaries.set(method.id, summary);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return summaries;
}

function pruneStaticConditionals(code, literal) {
  let current = { code, literal };
  while (true) {
    const conditional = firstConditional(current.code);
    if (!conditional) return current;
    const value = staticBoolean(conditional.condition);
    if (value === null) {
      const tail = pruneStaticConditionals(
        current.code.slice(conditional.end),
        current.literal.slice(conditional.end),
      );
      return {
        code: current.code.slice(0, conditional.end) + tail.code,
        literal: current.literal.slice(0, conditional.end) + tail.literal,
      };
    }
    const choice = value
      ? conditional.consequent
      : conditional.alternate;
    const replacementCode = choice
      ? current.code.slice(choice.contentStart, choice.contentEnd)
      : "";
    const replacementLiteral = choice
      ? current.literal.slice(choice.contentStart, choice.contentEnd)
      : "";
    current = {
      code:
        current.code.slice(0, conditional.start) +
        replacementCode +
        current.code.slice(conditional.end),
      literal:
        current.literal.slice(0, conditional.start) +
        replacementLiteral +
        current.literal.slice(conditional.end),
    };
  }
}

function reachableClosure(runtime, start) {
  const seen = new Set();
  const pending = [start];
  const methods = [];
  while (pending.length > 0) {
    const method = pending.shift();
    if (seen.has(method.id)) continue;
    seen.add(method.id);
    methods.push(method);
    for (const live of branchVariants(method.code, method.literal)) {
      pending.push(
        ...localCalls(live.code, live.literal, runtime.methodsByName)
          .filter((candidate) => !seen.has(candidate.id)),
      );
    }
  }
  return {
    methods,
    code: methods
      .map((method) => {
        const live = pruneStaticConditionals(method.code, method.literal);
        return removeDeadTail(live.code, live.literal).code;
      })
      .join("\n"),
    literal: methods
      .map((method) => {
        const live = pruneStaticConditionals(method.code, method.literal);
        return removeDeadTail(live.code, live.literal).literal;
      })
      .join("\n"),
  };
}

function expandReachable(method, methodsByName, seen = new Set(), limit = 256) {
  if (seen.has(method.id)) return [{ code: "", literal: "" }];
  const nextSeen = new Set(seen).add(method.id);
  const results = [];
  for (const variant of branchVariants(method.code, method.literal)) {
    let expansions = [{ code: variant.code, literal: variant.literal }];
    const called = localCalls(variant.code, variant.literal, methodsByName);
    for (const callee of called) {
      const nested = expandReachable(callee, methodsByName, nextSeen, limit);
      const combined = [];
      for (const left of expansions) {
        for (const right of nested) {
          combined.push({
            code: `${left.code}\n${right.code}`,
            literal: `${left.literal}\n${right.literal}`,
          });
          if (combined.length >= limit) break;
        }
        if (combined.length >= limit) break;
      }
      expansions = combined;
    }
    results.push(...expansions);
    if (results.length >= limit) break;
  }
  return results.slice(0, limit);
}

function runtimeFor(workspace) {
  const source = workspace.source ?? "";
  const code = maskJava(source, false);
  const literal = maskJava(source, true);
  const context = importsAndTypes(code);
  const methods = parseMethods(code, literal);
  const methodsByName = new Map();
  for (const method of methods) {
    const candidates = methodsByName.get(method.name) ?? [];
    candidates.push(method);
    methodsByName.set(method.name, candidates);
  }
  const mains = methods.filter(isExecutableMain);
  const reachableMethods = new Map();
  const pending = [...mains];
  while (pending.length > 0) {
    const method = pending.shift();
    if (reachableMethods.has(method.id)) continue;
    reachableMethods.set(method.id, method);
    for (const variant of branchVariants(method.code, method.literal)) {
      for (const called of localCalls(
        variant.code,
        variant.literal,
        methodsByName,
      )) {
        if (!reachableMethods.has(called.id)) pending.push(called);
      }
    }
  }
  const variants = mains.flatMap((main) =>
    expandReachable(main, methodsByName)
  ).slice(0, 256);
  const union = {
    code: variants.map((variant) => variant.code).join("\n"),
    literal: variants.map((variant) => variant.literal).join("\n"),
  };
  return {
    source,
    code,
    literal,
    context,
    methods,
    methodsByName,
    mains,
    reachableMethods: [...reachableMethods.values()],
    variants,
    union,
  };
}

function xmlValue(xml, name) {
  return new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i")
    .exec(xml)?.[1].trim() ?? "";
}

function hasExactManifest(build) {
  const xml = build.replace(/<!--[\s\S]*?-->/g, " ");
  const declaration =
    `<\\?xml\\s+version\\s*=\\s*["'][^"']+["']` +
    `(?:\\s+encoding\\s*=\\s*["'][^"']+["'])?` +
    `(?:\\s+standalone\\s*=\\s*["'](?:yes|no)["'])?\\s*\\?>`;
  if (!new RegExp(
    `^\\s*(?:${declaration}\\s*)?<project\\b[\\s\\S]*<\\/project>\\s*$`,
    "i",
  ).test(xml)) return false;
  const properties = new Map();
  const propertyBlock = /<properties\b[^>]*>([\s\S]*?)<\/properties>/i.exec(xml)?.[1] ?? "";
  for (const property of propertyBlock.matchAll(
    /<([A-Za-z_][\w.-]*)\b[^>]*>([^<]*)<\/\1>/g,
  )) {
    properties.set(property[1], property[2].trim());
  }
  const resolve = (value) => {
    const property = /^\$\{([^}]+)\}$/.exec(value)?.[1];
    return property ? properties.get(property) ?? "" : value;
  };
  const release = resolve(
    xmlValue(xml, "maven.compiler.release") ||
      xmlValue(xml, "release") ||
      xmlValue(xml, "maven.compiler.source"),
  );
  if (release !== "17") return false;

  const dependencies = Array.from(
    xml.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi),
    (match) => ({
      group: xmlValue(match[1], "groupId"),
      artifact: xmlValue(match[1], "artifactId"),
      version: resolve(xmlValue(match[1], "version")),
      scope: xmlValue(match[1], "scope") || "compile",
    }),
  ).filter(({ scope }) => ["compile", "runtime"].includes(scope));
  for (const [artifact, version] of [
    ["azure-data-appconfiguration", "1.10.1"],
    ["azure-identity", "1.18.5"],
  ]) {
    const active = dependencies.filter(
      (dependency) =>
        dependency.group === "com.azure" &&
        dependency.artifact === artifact,
    );
    if (
      active.length !== 1 ||
      active[0].version !== version
    ) {
      return false;
    }
  }
  return true;
}

function typedNames(runtime, key, code, scope = null) {
  const pattern = typePattern(runtime.context, key);
  const ownerCode = scope?.owner
    ? runtime.code.slice(scope.owner.start, scope.owner.end)
    : runtime.code;
  return new Set(
    Array.from(
      `${ownerCode}\n${code}`.matchAll(
        new RegExp(
          `\\b${pattern}(?:\\s*<[^;={}()]+>)?(?:\\s*\\[\\s*\\])?\\s+([A-Za-z_$][\\w$]*)`,
          "g",
        ),
      ),
      (match) => match[1],
    ),
  );
}

function officialCalls(runtime, variant, key, method) {
  const names = typedNames(runtime, key, variant.code, variant);
  const calls = [];
  const pattern = new RegExp(
    `\\b(?:this\\s*\\.\\s*)?([A-Za-z_$][\\w$]*)\\s*\\.\\s*${escapeRegExp(method)}\\s*\\(`,
    "g",
  );
  for (const match of variant.code.matchAll(pattern)) {
    if (!names.has(match[1])) continue;
    const open = variant.code.indexOf("(", match.index);
    const close = matchingIndex(variant.code, open);
    if (close < 0) continue;
    calls.push({
      receiver: match[1],
      args: splitTopLevel(variant.literal.slice(open + 1, close)),
      start: match.index,
      end: close + 1,
    });
  }
  return calls;
}

function officialBuilderCalls(runtime, method, callName) {
  const builderType = typePattern(runtime.context, "configurationClientBuilder");
  const builderNames = typedNames(
    runtime,
    "configurationClientBuilder",
    method.code,
    method,
  );
  const calls = [];
  for (const match of method.code.matchAll(
    new RegExp(`\\.\\s*${escapeRegExp(callName)}\\s*\\(`, "g"),
  )) {
    const prefix = method.code.slice(Math.max(0, match.index - 320), match.index);
    const receiver = /([A-Za-z_$][\w$]*)\s*$/.exec(prefix)?.[1];
    const fluentBuilder = new RegExp(
      `new\\s+${builderType}\\s*\\([^;{}]*$`,
    ).test(prefix);
    if (!fluentBuilder && (!receiver || !builderNames.has(receiver))) continue;
    const open = method.code.indexOf("(", match.index);
    const close = matchingIndex(method.code, open);
    if (close < 0) continue;
    calls.push({
      args: splitTopLevel(method.literal.slice(open + 1, close)),
      start: match.index,
      end: close + 1,
    });
  }
  return calls;
}

function methodCallBindings(
  caller,
  call,
  returnSummaries,
  runtime,
  callerBindings,
) {
  const variables = variablesForMethod(
    caller,
    returnSummaries,
    runtime.methodsByName,
    callerBindings,
    call.start,
  );
  return call.args.map((argument) =>
    expressionDependencies(
      maskJava(argument, false),
      maskJava(argument, true),
      variables,
      returnSummaries,
      runtime.methodsByName,
    )
  );
}

function endpointCallsFrom(
  runtime,
  method,
  returnSummaries,
  bindings = [],
  seen = new Set(),
) {
  const state = `${method.id}:${bindings.map(dependencySignature).join("|")}`;
  if (seen.has(state)) return [];
  const nextSeen = new Set(seen).add(state);
  const calls = [];
  for (const variant of branchVariants(method.code, method.literal)) {
    const variantMethod = {
      ...method,
      code: variant.code,
      literal: variant.literal,
    };
    for (const endpoint of officialBuilderCalls(
      runtime,
      variantMethod,
      "endpoint",
    )) {
      const variables = variablesForMethod(
        variantMethod,
        returnSummaries,
        runtime.methodsByName,
        bindings,
        endpoint.start,
      );
      const argument = endpoint.args[0] ?? "";
      calls.push(
        expressionDependencies(
          maskJava(argument, false),
          maskJava(argument, true),
          variables,
          returnSummaries,
          runtime.methodsByName,
        ),
      );
    }
    for (const call of localCallSites(
      variant.code,
      variant.literal,
      runtime.methodsByName,
    )) {
      calls.push(
        ...endpointCallsFrom(
          runtime,
          call.method,
          returnSummaries,
          methodCallBindings(
            variantMethod,
            call,
            returnSummaries,
            runtime,
            bindings,
          ),
          nextSeen,
        ),
      );
    }
  }
  return calls;
}

function credentialCallsFrom(
  runtime,
  method,
  returnSummaries,
  bindings = [],
  seen = new Set(),
) {
  const state = `${method.id}:${bindings.map(dependencySignature).join("|")}`;
  if (seen.has(state)) return [];
  const nextSeen = new Set(seen).add(state);
  const calls = [];
  for (const variant of branchVariants(method.code, method.literal)) {
    const variantMethod = {
      ...method,
      code: variant.code,
      literal: variant.literal,
    };
    for (const credential of officialBuilderCalls(
      runtime,
      variantMethod,
      "credential",
    )) {
      const variables = variablesForMethod(
        variantMethod,
        returnSummaries,
        runtime.methodsByName,
        bindings,
        credential.start,
      );
      const argument = credential.args[0] ?? "";
      calls.push(
        expressionDependencies(
          maskJava(argument, false),
          maskJava(argument, true),
          variables,
          returnSummaries,
          runtime.methodsByName,
        ),
      );
    }
    for (const call of localCallSites(
      variant.code,
      variant.literal,
      runtime.methodsByName,
    )) {
      calls.push(
        ...credentialCallsFrom(
          runtime,
          call.method,
          returnSummaries,
          methodCallBindings(
            variantMethod,
            call,
            returnSummaries,
            runtime,
            bindings,
          ),
          nextSeen,
        ),
      );
    }
  }
  return calls;
}

function hasOfficialType(runtime, key) {
  const type = SDK_TYPES[key];
  const qualified = `${type.packageName}.${type.name}`;
  return (
    runtime.context.imports.has(qualified) ||
    runtime.context.imports.has(`${type.packageName}.*`) ||
    new RegExp(
      qualified.split(".").map(escapeRegExp).join("\\s*\\.\\s*"),
    ).test(runtime.code)
  ) && !runtime.context.localTypes.has(type.name);
}

function someVariant(runtime, predicate) {
  return runtime.variants.some(predicate);
}

function managedIdentityClients(runtime) {
  if (
    ![
      "configurationClient",
      "configurationAsyncClient",
      "configurationClientBuilder",
      "managedIdentityCredentialBuilder",
    ].every((key) => hasOfficialType(runtime, key))
  ) {
    return false;
  }
  const summaries = returnSummariesFor(runtime);
  return runtime.mains.some((main) => {
    const endpoints = endpointCallsFrom(runtime, main, summaries);
    const credentials = credentialCallsFrom(runtime, main, summaries);
    if (
      endpoints.length === 0 ||
      endpoints.some((dependency) => !dependency.config) ||
      credentials.length === 0 ||
      credentials.some((dependency) => !dependency.managedIdentity)
    ) {
      return false;
    }
    return branchVariants(main.code, main.literal).some((variant) => {
      const clientNames = typedNames(
        runtime,
        "configurationClient",
        variant.code,
      );
      const asyncNames = typedNames(
        runtime,
        "configurationAsyncClient",
        variant.code,
      );
      const hasSync = [...clientNames].some((name) =>
        new RegExp(
          `\\b${escapeRegExp(name)}\\s*=\\s*[^;]*\\.buildClient\\s*\\(`,
        ).test(variant.code)
      );
      const hasAsync = [...asyncNames].some((name) =>
        new RegExp(
          `\\b${escapeRegExp(name)}\\s*=\\s*[^;]*\\.buildAsyncClient\\s*\\(`,
        ).test(variant.code)
      );
      return hasSync && hasAsync;
    });
  });
}

function configurationReads(runtime) {
  const variantMatch = someVariant(runtime, (variant) => {
    const syncGets = officialCalls(
      runtime,
      variant,
      "configurationClient",
      "getConfigurationSetting",
    );
    const syncResponses = officialCalls(
      runtime,
      variant,
      "configurationClient",
      "getConfigurationSettingWithResponse",
    );
    const asyncResponses = officialCalls(
      runtime,
      variant,
      "configurationAsyncClient",
      "getConfigurationSettingWithResponse",
    );
    const asyncGets = officialCalls(
      runtime,
      variant,
      "configurationAsyncClient",
      "getConfigurationSetting",
    );
    const syncLists = officialCalls(
      runtime,
      variant,
      "configurationClient",
      "listConfigurationSettings",
    );
    const asyncLists = officialCalls(
      runtime,
      variant,
      "configurationAsyncClient",
      "listConfigurationSettings",
    );
    const selectors = typedNames(runtime, "settingSelector", variant.code);
    const selectorUse =
      selectors.size > 0 &&
      /\.setKeyFilter\s*\(/.test(variant.code) &&
      /\.setLabelFilter\s*\(/.test(variant.code);
    const prefix =
      /\.setKeyFilter\s*\([^)]*(?:\+\s*["']\*["']|["'][^"']*\*["'])/.test(
        variant.literal,
      );
    const responseReadsLabel = runtime.reachableMethods.some((method) => {
      const closure = reachableClosure(runtime, method);
      return (
        /\.setKey\s*\(/.test(closure.code) &&
        /\.setLabel\s*\(/.test(closure.code) &&
        (
          closureHasOfficialCall(
            runtime,
            closure,
            "configurationClient",
            "getConfigurationSettingWithResponse",
          ) ||
          closureHasOfficialCall(
            runtime,
            closure,
            "configurationAsyncClient",
            "getConfigurationSettingWithResponse",
          )
        )
      );
    });
    const labelled =
      selectorUse ||
      [...syncGets, ...asyncGets].some(
        (call) => call.args.length >= 2 && !/^(?:null|\s*)$/.test(call.args[1]),
      ) ||
      responseReadsLabel;
    return (
      (syncGets.length > 0 || syncResponses.length > 0) &&
      (asyncGets.length > 0 || asyncResponses.length > 0) &&
      syncLists.length > 0 &&
      asyncLists.length > 0 &&
      labelled &&
      prefix
    );
  });
  if (variantMatch) return true;

  const hasRead = (key) =>
    ["getConfigurationSetting", "getConfigurationSettingWithResponse"].some(
      (methodName) =>
        methodsWithOfficialCall(runtime, key, methodName).length > 0,
    );
  const union = runtime.union;
  return (
    hasRead("configurationClient") &&
    hasRead("configurationAsyncClient") &&
    methodsWithOfficialCall(
      runtime,
      "configurationClient",
      "listConfigurationSettings",
    ).length > 0 &&
    methodsWithOfficialCall(
      runtime,
      "configurationAsyncClient",
      "listConfigurationSettings",
    ).length > 0 &&
    /\.setKey\s*\(/.test(union.code) &&
    /\.setLabel\s*\(/.test(union.code) &&
    /\.setKeyFilter\s*\(/.test(union.code) &&
    /["']\*["']/.test(union.literal)
  );
}

function conditionalsIn(code) {
  const conditionals = [];
  const pattern = /\bif\s*\(/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    if (close < 0) continue;
    const consequent = statementRange(code, close + 1);
    const elseStart = skipWhitespace(code, consequent.end);
    let alternate = null;
    if (code.slice(elseStart, elseStart + 4) === "else") {
      alternate = statementRange(code, elseStart + 4);
    }
    conditionals.push({
      condition: code.slice(open + 1, close),
      consequent,
      alternate,
      end: alternate?.end ?? consequent.end,
    });
    pattern.lastIndex = close + 1;
  }
  return conditionals;
}

function fragment(code, range) {
  if (!range) return "";
  return code.slice(range.contentStart, range.contentEnd);
}

function statusNames(code) {
  return new Set(
    Array.from(
      code.matchAll(
        /\b(?:int|Integer|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*\.getStatusCode\s*\(\s*\)/g,
      ),
      (match) => match[1],
    ),
  );
}

function usesStatus(condition, names) {
  return (
    /\.getStatusCode\s*\(\s*\)/.test(condition) ||
    [...names].some((name) =>
      new RegExp(`\\b${escapeRegExp(name)}\\b`).test(condition)
    )
  );
}

function unchangedResult(code) {
  return (
    /\b(?:return|Mono\s*\.\s*just)\b[\s\S]*?\b(?:false|unchanged|notModified)\b/i.test(
      code,
    ) &&
    /\b(?:cached|previous|existing|prior|baseline|unchanged)\b/i.test(code) &&
    !/\.getValue\s*\(\s*\)/.test(code)
  );
}

function hasFirstReadBaseline(code) {
  const names = statusNames(code);
  return conditionalsIn(code).some((conditional) => {
    if (
      usesStatus(conditional.condition, names) ||
      !/(?:==\s*null|Objects\s*\.\s*isNull\s*\()/.test(
        conditional.condition,
      )
    ) {
      return false;
    }
    const firstRead = fragment(code, conditional.consequent);
    return (
      /\bfalse\b/.test(firstRead) &&
      /(?:getConfigurationSetting\s*\(|getDirect\s*\(|fetch\w*\s*\()/i.test(
        firstRead,
      )
    );
  });
}

function hasUnchanged304(code) {
  const names = statusNames(code);
  return conditionalsIn(code).some((conditional) => {
    if (
      !usesStatus(conditional.condition, names) ||
      !/\b304\b/.test(conditional.condition)
    ) {
      return false;
    }
    const equals =
      /==\s*304\b|\b304\s*==/.test(conditional.condition);
    const differs =
      /!=\s*304\b|\b304\s*!=/.test(conditional.condition);
    if (equals) {
      return unchangedResult(fragment(code, conditional.consequent));
    }
    if (differs) {
      const unchanged = conditional.alternate
        ? fragment(code, conditional.alternate)
        : code.slice(conditional.end);
      return unchangedResult(unchanged);
    }
    return false;
  });
}

function hasChangedReplacement(code) {
  for (const match of code.matchAll(
    /\b(?:ConfigurationSetting|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*getValue\s*\(\s*\)\s*;/g,
  )) {
    const replacement = escapeRegExp(match[1]);
    const stored = new RegExp(
      `\\.\\s*(?:put|replace)\\s*\\([^;]*\\b${replacement}\\b[^;]*\\)`,
    ).test(code);
    const returned = new RegExp(
      `\\breturn\\b[^;]*\\b(?:true|modified|changed)\\b[^;]*\\b${replacement}\\b`,
      "i",
    ).test(code);
    if (stored && returned) return true;
  }
  return false;
}

function preservesNonSuccess(code) {
  const names = statusNames(code);
  const errorPattern = /\bthrow\b|Mono\s*\.\s*error\s*\(/;
  return conditionalsIn(code).some((conditional) => {
    if (!usesStatus(conditional.condition, names)) return false;
    const condition = conditional.condition.replace(/\s+/g, "");
    const selectsError =
      /<200|>=300|!=200|==4\d\d|==5\d\d|!.*isSuccessful/.test(condition);
    if (!selectsError) return false;
    return (
      errorPattern.test(fragment(code, conditional.consequent)) ||
      errorPattern.test(fragment(code, conditional.alternate))
    );
  }) ||
    /\bdefault\s*:[\s\S]{0,160}?\bthrow\b/.test(code);
}

function conditionalSemantics(closure) {
  return (
    hasFirstReadBaseline(closure.code) &&
    hasUnchanged304(closure.code) &&
    hasChangedReplacement(closure.code) &&
    preservesNonSuccess(closure.code)
  );
}

function liveOfficialCalls(runtime, method, key, methodName) {
  return branchVariants(method.code, method.literal).flatMap((variant) =>
    officialCalls(
      runtime,
      { ...method, code: variant.code, literal: variant.literal },
      key,
      methodName,
    )
  );
}

function methodsWithOfficialCall(runtime, key, methodName) {
  return runtime.reachableMethods.filter((method) =>
    liveOfficialCalls(runtime, method, key, methodName).length > 0
  );
}

function conditionalReads(runtime) {
  const syncMethods = methodsWithOfficialCall(
    runtime,
    "configurationClient",
    "getConfigurationSettingWithResponse",
  ).filter((method) =>
    liveOfficialCalls(
      runtime,
      method,
      "configurationClient",
      "getConfigurationSettingWithResponse",
    ).some(
      (call) =>
        call.args.length === 4 &&
        call.args[1].trim() === "null" &&
        call.args[2].trim() !== "false" &&
        /(?:^|\.)Context\s*\.\s*NONE$/.test(call.args[3].trim()),
    )
  );
  const asyncMethods = methodsWithOfficialCall(
    runtime,
    "configurationAsyncClient",
    "getConfigurationSettingWithResponse",
  ).filter((method) =>
    liveOfficialCalls(
      runtime,
      method,
      "configurationAsyncClient",
      "getConfigurationSettingWithResponse",
    ).some(
      (call) =>
        call.args.length === 3 &&
        call.args[1].trim() === "null" &&
        call.args[2].trim() !== "false",
    )
  );
  if (syncMethods.length === 0 || asyncMethods.length === 0) return false;
  return [...syncMethods, ...asyncMethods].every((method) => {
    const closure = reachableClosure(runtime, method);
    const explicitEtag = (
      /\.getETag\s*\(\s*\)/.test(closure.code) &&
      /\.setETag\s*\(/.test(closure.code) &&
      conditionalSemantics(closure)
    );
    const cachedSetting = (
      !/\.getETag\s*\(\s*\)|\.setETag\s*\(/.test(closure.code) &&
      /\b(?:ConfigurationSetting|var)\s+\w+\s*=\s*[^;]*\.\s*get\s*\(/.test(
        closure.code,
      ) &&
      /\.setKey\s*\(/.test(closure.code) &&
      /\.setLabel\s*\(/.test(closure.code) &&
      /(?:==\s*304|\b304\s*==)/.test(closure.code) &&
      /\.getValue\s*\(\s*\)/.test(closure.code) &&
      /\.\s*put\s*\(/.test(closure.code)
    );
    return explicitEtag || cachedSetting;
  });
}

function featureFlagJson(runtime) {
  const summaries = returnSummariesFor(runtime);
  const featureMethods = (key) =>
    runtime.reachableMethods.filter((method) => {
      return branchVariants(method.code, method.literal).some((variant) => {
        const variantMethod = {
          ...method,
          code: variant.code,
          literal: variant.literal,
        };
        const direct = officialCalls(
          runtime,
          variantMethod,
          key,
          "getConfigurationSetting",
        ).some((call) => {
          const variables = variablesForMethod(
            variantMethod,
            summaries,
            runtime.methodsByName,
            undefined,
            call.start,
          );
          const argument = call.args[0] ?? "";
          return expressionDependencies(
            maskJava(argument, false),
            maskJava(argument, true),
            variables,
            summaries,
            runtime.methodsByName,
          ).featurePrefix;
        });
        const delegated = localCallSites(
          variant.code,
          variant.literal,
          runtime.methodsByName,
        ).some((call) => {
          const variables = variablesForMethod(
            variantMethod,
            summaries,
            runtime.methodsByName,
            undefined,
            call.start,
          );
          const argument = call.args[0] ?? "";
          const usesPrefix = expressionDependencies(
            maskJava(argument, false),
            maskJava(argument, true),
            variables,
            summaries,
            runtime.methodsByName,
          ).featurePrefix;
          const closure = reachableClosure(runtime, call.method);
          return (
            usesPrefix &&
            (
              closureHasOfficialCall(
                runtime,
                closure,
                key,
                "getConfigurationSetting",
              ) ||
              closureHasOfficialCall(
                runtime,
                closure,
                key,
                "getConfigurationSettingWithResponse",
              )
            )
          );
        });
        return direct || delegated;
      });
    });
  const sync = featureMethods("configurationClient");
  const async = featureMethods("configurationAsyncClient");
  const evaluated =
    sync.length > 0 &&
    async.length > 0 &&
    [...sync, ...async].every((method) => {
    const closure = reachableClosure(runtime, method);
    const parsesJson =
      /BinaryData\s*\.\s*fromString\s*\([^)]*\)\s*\.\s*toObject\s*\(/.test(
        closure.code,
      ) ||
      /\bObjectMapper\b[\s\S]*\.(?:readTree|readValue)\s*\(/.test(
        closure.code,
      ) ||
      /\b[A-Z_$][\w$]*\s*\.\s*(?:readTree|readValue)\s*\(/.test(
        closure.code,
      );
    return (
      parsesJson &&
      /["']enabled["']/.test(closure.literal) &&
      /["']conditions["']/.test(closure.literal) &&
      /["']client_filters["']/.test(closure.literal) &&
      /["']Microsoft\.Percentage["']/.test(closure.literal) &&
      /["'](?:Value|value)["']/.test(closure.literal) &&
      enabledControlsEvaluation(closure, runtime, summaries)
    );
  });
  if (evaluated) return true;

  const code = runtime.union.code;
  const literal = runtime.literal;
  const hasOfficialReads = [
    "configurationClient",
    "configurationAsyncClient",
  ].every((key) =>
    ["getConfigurationSetting", "getConfigurationSettingWithResponse"].some(
      (methodName) =>
        methodsWithOfficialCall(runtime, key, methodName).length > 0,
    )
  );
  return (
    hasOfficialReads &&
    /\bFeatureFlagConfigurationSetting\s*\.\s*KEY_PREFIX\b/.test(code) &&
    /\.(?:readTree|readValue)\s*\(/.test(code) &&
    ["enabled", "conditions", "client_filters", "Microsoft.Percentage"]
      .every((name) =>
        new RegExp(`["']${escapeRegExp(name)}["']`).test(literal)
      ) &&
    /["'](?:Value|value)["']/.test(literal) &&
    runtime.reachableMethods.some((method) =>
      conditionalsIn(method.code).some((conditional) => {
        const start = method.code.indexOf(conditional.condition);
        return (
          /["']enabled["']/.test(
            method.literal.slice(
              start,
              start + conditional.condition.length,
            ),
          ) &&
          /\breturn\s+false\s*;/.test(
            fragment(method.code, conditional.consequent),
          )
        );
      })
    )
  );
}

function stripBooleanParentheses(code, literal) {
  let start = 0;
  let end = code.length;
  while (start < end && /\s/.test(code[start])) start += 1;
  while (end > start && /\s/.test(code[end - 1])) end -= 1;
  while (code[start] === "(") {
    const close = matchingIndex(code.slice(start, end), 0);
    if (close !== end - start - 1) break;
    start += 1;
    end -= 1;
    while (start < end && /\s/.test(code[start])) start += 1;
    while (end > start && /\s/.test(code[end - 1])) end -= 1;
  }
  return {
    code: code.slice(start, end),
    literal: literal.slice(start, end),
  };
}

function splitBooleanOperator(expression, operator) {
  const parts = [];
  let parentheses = 0;
  let brackets = 0;
  let start = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (
      parentheses === 0 &&
      brackets === 0 &&
      expression.startsWith(operator, index)
    ) {
      parts.push(expression.slice(start, index));
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(expression.slice(start));
  return parts;
}

function splitBooleanTernary(expression) {
  let parentheses = 0;
  let brackets = 0;
  let question = -1;
  let nested = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (parentheses === 0 && brackets === 0 && character === "?") {
      if (question < 0) question = index;
      else nested += 1;
    } else if (
      parentheses === 0 &&
      brackets === 0 &&
      character === ":" &&
      question >= 0
    ) {
      if (nested > 0) {
        nested -= 1;
        continue;
      }
      return [
        expression.slice(0, question),
        expression.slice(question + 1, index),
        expression.slice(index + 1),
      ];
    }
  }
  return null;
}

function splitBooleanComparison(expression) {
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < expression.length - 1; index += 1) {
    const character = expression[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (parentheses === 0 && brackets === 0) {
      const operator = expression.slice(index, index + 2);
      if (operator === "==" || operator === "!=") {
        return [
          operator,
          expression.slice(0, index),
          expression.slice(index + 2),
        ];
      }
    }
  }
  return null;
}

function javaBooleanFormula(
  code,
  literal,
  variables,
  summaries,
  methodsByName,
) {
  const stripped = stripBooleanParentheses(code, literal);
  const expression = stripped.code;
  const expressionLiteral = stripped.literal;
  const ternary = splitBooleanTernary(expression);
  if (ternary) {
    const conditionEnd = expression.indexOf("?");
    const alternateStart = expression.lastIndexOf(":") + 1;
    const bodyStart = conditionEnd + 1;
    const bodyEnd = alternateStart - 1;
    return [
      "if",
      javaBooleanFormula(
        ternary[0],
        expressionLiteral.slice(0, conditionEnd),
        variables,
        summaries,
        methodsByName,
      ),
      javaBooleanFormula(
        ternary[1],
        expressionLiteral.slice(bodyStart, bodyEnd),
        variables,
        summaries,
        methodsByName,
      ),
      javaBooleanFormula(
        ternary[2],
        expressionLiteral.slice(alternateStart),
        variables,
        summaries,
        methodsByName,
      ),
    ];
  }
  for (const [operator, name] of [
    ["||", "or"],
    ["&&", "and"],
  ]) {
    const parts = splitBooleanOperator(expression, operator);
    if (parts) {
      let offset = 0;
      return [
        name,
        ...parts.map((part) => {
          const start = expression.indexOf(part, offset);
          offset = start + part.length + operator.length;
          return javaBooleanFormula(
            part,
            expressionLiteral.slice(start, start + part.length),
            variables,
            summaries,
            methodsByName,
          );
        }),
      ];
    }
  }
  const comparison = splitBooleanComparison(expression);
  if (comparison) {
    const operatorStart = expression.indexOf(comparison[0]);
    const rightStart = operatorStart + comparison[0].length;
    const formula = [
      "equal",
      javaBooleanFormula(
        comparison[1],
        expressionLiteral.slice(0, operatorStart),
        variables,
        summaries,
        methodsByName,
      ),
      javaBooleanFormula(
        comparison[2],
        expressionLiteral.slice(rightStart),
        variables,
        summaries,
        methodsByName,
      ),
    ];
    return comparison[0] === "!=" ? ["not", formula] : formula;
  }
  if (expression.startsWith("!")) {
    return [
      "not",
      javaBooleanFormula(
        expression.slice(1),
        expressionLiteral.slice(1),
        variables,
        summaries,
        methodsByName,
      ),
    ];
  }
  if (expression === "true" || expression === "false") {
    return ["constant", expression === "true"];
  }
  const identifier = /^[A-Za-z_$][\w$]*$/.exec(expression)?.[0];
  if (identifier && variables.get(identifier)?.enabled) {
    return ["enabled"];
  }
  const dependencies = expressionDependencies(
    expression,
    expressionLiteral,
    variables,
    summaries,
    methodsByName,
  );
  if (dependencies.enabled) return ["enabled"];
  return ["atom", expression.replace(/\s+/g, "")];
}

function booleanFormulaAtoms(formula, atoms = new Set()) {
  if (formula[0] === "atom") atoms.add(formula[1]);
  for (const child of formula.slice(1)) {
    if (Array.isArray(child)) booleanFormulaAtoms(child, atoms);
  }
  return atoms;
}

function evaluateBooleanFormula(formula, enabled, atoms) {
  switch (formula[0]) {
    case "enabled":
      return enabled;
    case "constant":
      return formula[1];
    case "atom":
      return atoms.get(formula[1]);
    case "not":
      return !evaluateBooleanFormula(formula[1], enabled, atoms);
    case "and":
      return formula
        .slice(1)
        .every((child) => evaluateBooleanFormula(child, enabled, atoms));
    case "or":
      return formula
        .slice(1)
        .some((child) => evaluateBooleanFormula(child, enabled, atoms));
    case "if":
      return evaluateBooleanFormula(formula[1], enabled, atoms)
        ? evaluateBooleanFormula(formula[2], enabled, atoms)
        : evaluateBooleanFormula(formula[3], enabled, atoms);
    case "equal":
      return (
        evaluateBooleanFormula(formula[1], enabled, atoms) ===
        evaluateBooleanFormula(formula[2], enabled, atoms)
      );
    default:
      return false;
  }
}

function javaBooleanDependsOnEnabled(
  code,
  literal,
  variables,
  summaries,
  methodsByName,
) {
  const formula = javaBooleanFormula(
    code,
    literal,
    variables,
    summaries,
    methodsByName,
  );
  const atomNames = [...booleanFormulaAtoms(formula)].sort();
  if (atomNames.length > 10) return false;
  for (let mask = 0; mask < 2 ** atomNames.length; mask += 1) {
    const atoms = new Map(
      atomNames.map((name, index) => [
        name,
        Boolean(mask & (2 ** index)),
      ]),
    );
    if (
      evaluateBooleanFormula(formula, false, atoms) !==
      evaluateBooleanFormula(formula, true, atoms)
    ) {
      return true;
    }
  }
  return false;
}

function javaBooleanForcesResult(
  code,
  literal,
  variables,
  summaries,
  methodsByName,
  enabled,
  expected,
) {
  const formula = javaBooleanFormula(
    code,
    literal,
    variables,
    summaries,
    methodsByName,
  );
  const atomNames = [...booleanFormulaAtoms(formula)].sort();
  if (atomNames.length > 10) return false;
  for (let mask = 0; mask < 2 ** atomNames.length; mask += 1) {
    const atoms = new Map(
      atomNames.map((name, index) => [
        name,
        Boolean(mask & (2 ** index)),
      ]),
    );
    if (evaluateBooleanFormula(formula, enabled, atoms) !== expected) {
      return false;
    }
  }
  return true;
}

function disabledForcesFalse(
  code,
  literal,
  variables,
  summaries,
  methodsByName,
) {
  return (
    javaBooleanForcesResult(
      code,
      literal,
      variables,
      summaries,
      methodsByName,
      false,
      false,
    ) &&
    !javaBooleanForcesResult(
      code,
      literal,
      variables,
      summaries,
      methodsByName,
      true,
      false,
    )
  );
}

function enabledControlsEvaluation(closure, runtime, summaries) {
  for (const method of closure.methods) {
    const variables = variablesForMethod(
      method,
      summaries,
      runtime.methodsByName,
    );
    for (const returned of returnedExpressions(method)) {
      const dependencies = expressionDependencies(
        returned.code,
        returned.literal,
        variables,
        summaries,
        runtime.methodsByName,
      );
      const enabledMatters =
        dependencies.enabled &&
        disabledForcesFalse(
          returned.code,
          returned.literal,
          variables,
          summaries,
          runtime.methodsByName,
        );
      if (enabledMatters && /&&/.test(returned.code)) return true;
      if (enabledMatters && meaningfulTernary(returned.code)) return true;
    }
    for (const conditional of conditionalsIn(method.code)) {
      const conditionStart = method.code.indexOf(conditional.condition);
      const conditionLiteral = method.literal.slice(
        conditionStart,
        conditionStart + conditional.condition.length,
      );
      const dependencies = expressionDependencies(
        conditional.condition,
        conditionLiteral,
        variables,
        summaries,
        runtime.methodsByName,
      );
      if (
        !dependencies.enabled ||
        !javaBooleanDependsOnEnabled(
          conditional.condition,
          conditionLiteral,
          variables,
          summaries,
          runtime.methodsByName,
        )
      ) {
        continue;
      }
      const consequent = fragment(method.code, conditional.consequent);
      const alternate = fragment(method.code, conditional.alternate);
      const following = method.code.slice(conditional.end);
      const negative =
        /^\s*!/.test(conditional.condition) ||
        /Boolean\s*\.\s*FALSE\s*\.\s*equals/.test(
          conditional.condition,
        ) ||
        /==\s*false|!=\s*true/.test(conditional.condition);
      const disabledTakesFalseBranch = javaBooleanForcesResult(
        conditional.condition,
        conditionLiteral,
        variables,
        summaries,
        runtime.methodsByName,
        false,
        negative,
      );
      const enabledCanContinue = !javaBooleanForcesResult(
        conditional.condition,
        conditionLiteral,
        variables,
        summaries,
        runtime.methodsByName,
        true,
        negative,
      );
      if (
        negative &&
        disabledTakesFalseBranch &&
        enabledCanContinue &&
        /\breturn\s+false\s*;/.test(consequent)
      ) {
        return true;
      }
      if (
        !negative &&
        disabledTakesFalseBranch &&
        enabledCanContinue &&
        /\breturn\s+false\s*;/.test(alternate || following)
      ) {
        return true;
      }
    }
  }
  return false;
}

function meaningfulTernary(code) {
  const expression = code.trim();
  let parentheses = 0;
  let brackets = 0;
  let question = -1;
  let nestedTernaries = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (parentheses === 0 && brackets === 0 && character === "?") {
      if (question < 0) question = index;
      else nestedTernaries += 1;
    } else if (
      parentheses === 0 &&
      brackets === 0 &&
      character === ":" &&
      question >= 0
    ) {
      if (nestedTernaries > 0) {
        nestedTernaries -= 1;
        continue;
      }
      const consequent = expression
        .slice(question + 1, index)
        .replaceAll(/\s+/g, "");
      const alternate = expression.slice(index + 1).replaceAll(/\s+/g, "");
      return consequent !== alternate;
    }
  }
  return false;
}

function digestInputDependencies(method, runtime, summaries) {
  const variables = variablesForMethod(
    method,
    summaries,
    runtime.methodsByName,
  );
  const inputs = [];
  for (const match of method.code.matchAll(/\.digest\s*\(/g)) {
    const open = method.code.indexOf("(", match.index);
    const close = matchingIndex(method.code, open);
    if (close < 0) continue;
    const argument = method.literal.slice(open + 1, close);
    inputs.push(
      expressionDependencies(
        maskJava(argument, false),
        maskJava(argument, true),
        variables,
        summaries,
        runtime.methodsByName,
      ),
    );
  }
  return inputs;
}

function callUsesDistinctInputs(caller, callee, runtime, summaries) {
  if (caller.id === callee.id) {
    return (summaries.get(callee.id)?.params.size ?? 0) >= 2;
  }
  const variables = variablesForMethod(
    caller,
    summaries,
    runtime.methodsByName,
  );
  return localCallSites(
    caller.code,
    caller.literal,
    runtime.methodsByName,
  ).some((call) => {
    if (call.method.id !== callee.id) return false;
    const argumentsWithDependencies = call.args.map((argument) =>
      expressionDependencies(
        maskJava(argument, false),
        maskJava(argument, true),
        variables,
        summaries,
        runtime.methodsByName,
      )
    );
    const used = new Set();
    for (const index of summaries.get(callee.id)?.params ?? []) {
      for (const dependency of argumentsWithDependencies[index]?.params ?? []) {
        used.add(dependency);
      }
    }
    return used.size >= 2;
  });
}

function expressionUsesQualifiedDigest(
  caller,
  expression,
  digestMethods,
  runtime,
  summaries,
  seenVariables = new Set(),
) {
  const variables = variablesForMethod(
    caller,
    summaries,
    runtime.methodsByName,
  );
  if (
    digestMethods.some((method) => method.id === caller.id) &&
    summaries.get(caller.id)?.params.size >= 2 &&
    expressionDependencies(
      expression.code,
      expression.literal,
      variables,
      summaries,
      runtime.methodsByName,
    ).stableHash
  ) {
    return true;
  }
  const direct = localCallSites(
    expression.code,
    expression.literal,
    runtime.methodsByName,
  ).some((call) => {
    if (!digestMethods.some((method) => method.id === call.method.id)) {
      return false;
    }
    const argumentsWithDependencies = call.args.map((argument) =>
      expressionDependencies(
        maskJava(argument, false),
        maskJava(argument, true),
        variables,
        summaries,
        runtime.methodsByName,
      )
    );
    const used = new Set();
    for (const index of summaries.get(call.method.id)?.params ?? []) {
      for (const dependency of argumentsWithDependencies[index]?.params ?? []) {
        used.add(dependency);
      }
    }
    return used.size >= 2;
  });
  if (direct) return true;
  const assignments = assignmentsFor(caller.code, caller.literal);
  for (const identifier of expression.code.matchAll(
    /\b([A-Za-z_$][\w$]*)\b/g,
  )) {
    const name = identifier[1];
    if (seenVariables.has(name)) continue;
    const assignment = assignments.find((candidate) => candidate.name === name);
    if (
      assignment &&
      expressionUsesQualifiedDigest(
        caller,
        assignment,
        digestMethods,
        runtime,
        summaries,
        new Set(seenVariables).add(name),
      )
    ) {
      return true;
    }
  }
  return false;
}

function deterministicRollout(runtime) {
  const liveCode = runtime.union.code;
  if (
    /\bMath\s*\.\s*random\s*\(|\b(?:Random|SecureRandom|ThreadLocalRandom)\b|UUID\s*\.\s*randomUUID\s*\(|\.hashCode\s*\(\s*\)/.test(
      liveCode,
    )
  ) {
    return false;
  }
  const summaries = returnSummariesFor(runtime);
  const digestMethods = runtime.reachableMethods.filter((method) => {
    if (
      !/\bMessageDigest\s*\.\s*getInstance\s*\(/.test(method.code) ||
      !/(?:floorMod\s*\([^,]+,\s*(?:100|10_?000)\s*\)|%\s*(?:100|10_?000)\b)/.test(
        method.code,
      )
    ) {
      return false;
    }
    return digestInputDependencies(method, runtime, summaries).some(
      (dependencies) => dependencies.params.size >= 1,
    ) &&
      summaries.get(method.id)?.stableHash;
  });
  if (digestMethods.length === 0) return false;
  const connectedDigest = digestMethods.some((digestMethod) =>
    runtime.reachableMethods.some((caller) =>
      callUsesDistinctInputs(caller, digestMethod, runtime, summaries)
    )
  );
  if (!connectedDigest) return false;
  const connectedPercentage = runtime.reachableMethods.some((method) => {
    const variables = variablesForMethod(
      method,
      summaries,
      runtime.methodsByName,
    );
    return returnedExpressions(method).some((returned) => {
      if (!/(?:<|<=)/.test(returned.code)) return false;
      const dependencies = expressionDependencies(
        returned.code,
        returned.literal,
        variables,
        summaries,
        runtime.methodsByName,
      );
      return (
        dependencies.stableHash &&
        dependencies.percentage &&
        expressionUsesQualifiedDigest(
          method,
          returned,
          digestMethods,
          runtime,
          summaries,
        )
      );
    });
  });
  if (connectedPercentage) return true;

  return digestMethods.some((method) => {
    const names = parameterNames(method);
    if (names.length < 2) return false;
    const combined = names.slice(0, 2).every((name) =>
      new RegExp(`\\b${escapeRegExp(name)}\\b`).test(method.code)
    );
    return (
      combined &&
      /\.digest\s*\(/.test(method.code) &&
      /(?:floorMod\s*\([^,]+,\s*(?:100|10_?000)\s*\)|%\s*(?:100|10_?000)\b)/.test(
        method.code,
      ) &&
      /(?:<|<=)[^;]*(?:percentage|percent|rollout)/i.test(method.code)
    );
  });
}

function callsAnyMethod(code, names) {
  return names.some((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(code)
  );
}

function conditionallyCalls(code, names) {
  return conditionalsIn(code).some((conditional) =>
    callsAnyMethod(fragment(code, conditional.consequent), names) ||
    callsAnyMethod(fragment(code, conditional.alternate), names)
  ) ||
    names.some((name) =>
      new RegExp(
        `\\?[^;{}]{0,240}\\b${escapeRegExp(name)}\\s*\\(`,
      ).test(code)
    );
}

function scheduleCalls(method) {
  const calls = [];
  for (const match of method.code.matchAll(
    /\.(scheduleWithFixedDelay|scheduleAtFixedRate)\s*\(/g,
  )) {
    const open = method.code.indexOf("(", match.index);
    const close = matchingIndex(method.code, open);
    if (close < 0) continue;
    calls.push({
      name: match[1],
      args: splitTopLevel(method.literal.slice(open + 1, close)),
      start: match.index,
      end: close + 1,
    });
  }
  return calls;
}

function liveScheduleCalls(method) {
  return branchVariants(method.code, method.literal).flatMap((variant) =>
    scheduleCalls({
      ...method,
      code: variant.code,
      literal: variant.literal,
    })
  );
}

function hasPollingInterval(runtime, schedule) {
  if (schedule.args.length !== 4) return false;
  const durationNames = new Set(
    Array.from(
      runtime.code.matchAll(/\bDuration\s+([A-Za-z_$][\w$]*)\b/g),
      (match) => match[1],
    ),
  );
  return schedule.args.slice(1, 3).some((argument) =>
    [...durationNames].some((name) =>
      new RegExp(
        `\\b${escapeRegExp(name)}\\s*\\.\\s*toMillis\\s*\\(`,
      ).test(maskJava(argument, false))
    )
  );
}

function reactiveIntervalMethods(runtime) {
  return runtime.reachableMethods.filter((method) =>
    branchVariants(method.code, method.literal).some((variant) =>
      /\bFlux\s*\.\s*interval\s*\(/.test(variant.code) &&
      /\bDuration\s+[A-Za-z_$][\w$]*\b/.test(runtime.code)
    )
  );
}

function startIsGuarded(method) {
  return conditionalsIn(method.code).some((conditional) => {
    const guarded = fragment(method.code, conditional.consequent);
    return /\b(?:return|throw)\b/.test(guarded);
  });
}

function hasWatcherLifecycle(runtime, schedulingMethods) {
  const futureNames = new Set(
    Array.from(
      runtime.code.matchAll(
        /\bScheduledFuture\s*<[^>]*>\s+([A-Za-z_$][\w$]*)\b/g,
      ),
      (match) => match[1],
    ),
  );
  if (futureNames.size === 0) return false;
  const startsAreGuarded = schedulingMethods.every((method) => {
    const closure = reachableClosure(runtime, method);
    return [...futureNames].some((name) => {
      const escaped = escapeRegExp(name);
      return (
        new RegExp(
          `\\b${escaped}\\s*=\\s*[^;]*\\.(?:scheduleWithFixedDelay|scheduleAtFixedRate)\\s*\\(`,
        ).test(method.code) &&
        new RegExp(`\\b${escaped}\\s*!=\\s*null\\b`).test(closure.code) &&
        new RegExp(
          `\\b${escaped}\\s*\\.\\s*(?:isDone|isCancelled)\\s*\\(`,
        ).test(closure.code) &&
        /\breturn\s*;/.test(method.code)
      );
    });
  });
  if (!startsAreGuarded) return false;
  const scheduledWorkCancelled = runtime.methods.some((method) => {
    const closure = reachableClosure(runtime, method);
    return (
      /\.\s*shutdown(?:Now)?\s*\(/.test(method.code) &&
      [...futureNames].some((name) =>
        new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*cancel\\s*\\(`).test(
          closure.code,
        )
      )
    );
  });
  const reactiveWorkCancelled =
    !/\.subscribe\s*\(/.test(runtime.code) ||
    /\.dispose\s*\(\s*\)/.test(runtime.code);
  return scheduledWorkCancelled && reactiveWorkCancelled;
}

function hasAlternativeWatcherLifecycle(
  runtime,
  schedulingMethods,
  reactiveMethods,
) {
  const scheduledClosed =
    schedulingMethods.length > 0 &&
    schedulingMethods.every(startIsGuarded) &&
    runtime.methods.some((method) =>
      /\.\s*shutdown(?:Now)?\s*\(/.test(method.code)
    );
  const reactiveClosed =
    reactiveMethods.length > 0 &&
    reactiveMethods.every((method) =>
      startIsGuarded(method) &&
      /\.subscribe\s*\(/.test(method.code)
    ) &&
    /\bDisposable\s+[A-Za-z_$][\w$]*\b/.test(runtime.code) &&
    runtime.methods.some((method) =>
      /\.dispose\s*\(\s*\)/.test(method.code)
    );
  return scheduledClosed && reactiveClosed;
}

function closureHasOfficialCall(runtime, closure, key, methodName) {
  return closure.methods.some((method) =>
    liveOfficialCalls(runtime, method, key, methodName).length > 0
  );
}

function sentinelRefresh(runtime) {
  const refreshSync = runtime.reachableMethods
    .filter((method) =>
      closureHasOfficialCall(
        runtime,
        reachableClosure(runtime, method),
        "configurationClient",
        "listConfigurationSettings",
      )
    )
    .map((method) => method.name);
  const refreshAsync = runtime.reachableMethods
    .filter((method) =>
      closureHasOfficialCall(
        runtime,
        reachableClosure(runtime, method),
        "configurationAsyncClient",
        "listConfigurationSettings",
      )
    )
    .map((method) => method.name);
  const schedulingMethods = runtime.reachableMethods.filter(
    (method) => liveScheduleCalls(method).length > 0,
  );
  const reactiveMethods = reactiveIntervalMethods(runtime);
  const syncConnected = schedulingMethods.some((method) => {
    const closure = reachableClosure(runtime, method);
    return (
      liveScheduleCalls(method).every((call) =>
        hasPollingInterval(runtime, call)
      ) &&
      closureHasOfficialCall(
        runtime,
        closure,
        "configurationClient",
        "getConfigurationSettingWithResponse",
      ) &&
      conditionallyCalls(closure.code, refreshSync)
    );
  });
  const scheduledAsyncConnected = schedulingMethods.some((method) => {
    const closure = reachableClosure(runtime, method);
    return (
      liveScheduleCalls(method).every((call) =>
        hasPollingInterval(runtime, call)
      ) &&
      closureHasOfficialCall(
        runtime,
        closure,
        "configurationAsyncClient",
        "getConfigurationSettingWithResponse",
      ) &&
      conditionallyCalls(closure.code, refreshAsync) &&
      /\.subscribe\s*\(/.test(closure.code)
    );
  });
  const reactiveAsyncConnected = reactiveMethods.some((method) => {
    const closure = reachableClosure(runtime, method);
    return (
      closureHasOfficialCall(
        runtime,
        closure,
        "configurationAsyncClient",
        "getConfigurationSettingWithResponse",
      ) &&
      conditionallyCalls(closure.code, refreshAsync) &&
      /\.subscribe\s*\(/.test(closure.code)
    );
  });
  return (
    syncConnected &&
    (scheduledAsyncConnected || reactiveAsyncConnected) &&
    /\bList\s*<\s*String\s*>\s+[A-Za-z_$][\w$]*\b/.test(runtime.code) &&
    /\bDuration\s+[A-Za-z_$][\w$]*\b/.test(runtime.code) &&
    (
      hasWatcherLifecycle(runtime, schedulingMethods) ||
      hasAlternativeWatcherLifecycle(
        runtime,
        schedulingMethods,
        reactiveMethods,
      )
    )
  );
}

function hasMeaningfulWait(runtime, closure) {
  const waitableNames = new Set(
    Array.from(
      runtime.code.matchAll(
        /\b(?:CompletableFuture\s*<[^>]+>|CountDownLatch)\s+([A-Za-z_$][\w$]*)\b/g,
      ),
      (match) => match[1],
    ),
  );
  return (
    /\bThread\s*\.\s*sleep\s*\(/.test(closure.code) ||
    [...waitableNames].some((name) =>
      new RegExp(
        `\\b${escapeRegExp(name)}\\s*\\.\\s*(?:await|join|get)\\s*\\(`,
      ).test(closure.code)
    ) ||
    /\bMono\s*\.\s*delay\s*\(/.test(closure.code) ||
    /\.\s*(?:take|delayElement|delaySubscription)\s*\(/.test(closure.code) ||
    /\bMono\s*\.\s*fromFuture\s*\(/.test(closure.code)
  );
}

function connectedDemo(runtime) {
  return runtime.mains.some((main) =>
    branchVariants(main.code, main.literal).some((variant) => {
      const variantMethod = {
        ...main,
        code: variant.code,
        literal: variant.literal,
      };
      const calls = localCallSites(
        variant.code,
        variant.literal,
        runtime.methodsByName,
      );
      const syncCalls = calls.filter((call) => {
        const closure = reachableClosure(runtime, call.method);
        return (
          (
            closureHasOfficialCall(
              runtime,
              closure,
              "configurationClient",
              "getConfigurationSetting",
            ) ||
            closureHasOfficialCall(
              runtime,
              closure,
              "configurationClient",
              "getConfigurationSettingWithResponse",
            )
          ) &&
          closureHasOfficialCall(
            runtime,
            closure,
            "configurationClient",
            "getConfigurationSettingWithResponse",
          ) &&
          hasMeaningfulWait(runtime, closure)
        );
      });
      const asyncCalls = calls.filter((call) => {
        const closure = reachableClosure(runtime, call.method);
        return (
          (
            closureHasOfficialCall(
              runtime,
              closure,
              "configurationAsyncClient",
              "getConfigurationSetting",
            ) ||
            closureHasOfficialCall(
              runtime,
              closure,
              "configurationAsyncClient",
              "getConfigurationSettingWithResponse",
            )
          ) &&
          closureHasOfficialCall(
            runtime,
            closure,
            "configurationAsyncClient",
            "getConfigurationSettingWithResponse",
          ) &&
          hasMeaningfulWait(runtime, closure)
        );
      });
      return syncCalls.some((syncCall) =>
        asyncCalls.some((asyncCall) => {
          if (syncCall.start >= asyncCall.start) return false;
          const consumed = variant.code.slice(
            asyncCall.end,
            Math.min(variant.code.length, asyncCall.end + 80),
          );
          const asyncClosure = reachableClosure(runtime, asyncCall.method);
          return (
            /\.\s*(?:block|join|get)\s*\(\s*\)/.test(consumed) ||
            /\.\s*block\s*\(\s*\)/.test(asyncClosure.code)
          );
        })
      ) && variantMethod.code.length > 0;
    })
  );
}

const rules = {
  "prompt/source-manifest": ({ build }) => hasExactManifest(build),
  "prompt/managed-identity-clients": ({ runtime }) =>
    managedIdentityClients(runtime),
  "prompt/configuration-reads": ({ runtime }) =>
    configurationReads(runtime),
  "prompt/conditional-etag-reads": ({ runtime }) =>
    conditionalReads(runtime),
  "prompt/feature-flag-json": ({ runtime }) => featureFlagJson(runtime),
  "prompt/deterministic-rollout": ({ runtime }) =>
    deterministicRollout(runtime),
  "prompt/sentinel-refresh": ({ runtime }) => sentinelRefresh(runtime),
  "prompt/connected-sync-async-demo": ({ runtime }) =>
    connectedDemo(runtime),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const hasSource = Array.isArray(workspace.sourceFiles)
    ? workspace.sourceFiles.length > 0
    : Boolean(workspace.source?.trim());
  if (!hasSource) return false;
  const runtime =
    name === "prompt/source-manifest" ? null : runtimeFor(workspace);
  if (runtime && hasLocalAzureSdkDefinition(runtime.code)) return false;
  return rule({
    ...workspace,
    build: workspace.build ?? "",
    runtime,
  });
}

export function ruleNames() {
  return Object.keys(rules);
}
