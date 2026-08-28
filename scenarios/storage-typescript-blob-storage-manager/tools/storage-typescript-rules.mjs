import { activeDependencies, sourceDocuments } from "./source-manifest.mjs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskSource(source, maskStrings = true) {
  let result = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      result += current === "\n" ? "\n" : " ";
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      if (current === "\\") {
        result += maskStrings ? "  " : current + (next ?? "");
        index += 1;
      } else {
        const closes =
          (state === "single" && current === "'") ||
          (state === "double" && current === '"') ||
          (state === "template" && current === "`");
        result += maskStrings && !closes && current !== "\n" ? " " : current;
        if (closes) state = "code";
      }
      continue;
    }
    if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
      continue;
    }
    if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
      continue;
    }
    result += current;
    if (current === "'") state = "single";
    if (current === '"') state = "double";
    if (current === "`") state = "template";
  }
  return result;
}

function matchingClosing(code, openingIndex, opening = "(", closing = ")") {
  let depth = 0;
  for (let index = openingIndex; index < code.length; index += 1) {
    if (code[index] === opening) depth += 1;
    if (code[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function balancedText(source, openingIndex, opening = "(", closing = ")") {
  const code = maskSource(source, false);
  const closingIndex = matchingClosing(code, openingIndex, opening, closing);
  return closingIndex === -1
    ? ""
    : source.slice(openingIndex + 1, closingIndex);
}

function splitTopLevel(text) {
  const code = maskSource(text, false);
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
  const tail = text.slice(start).trim();
  if (tail || text.includes(",")) parts.push(tail);
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

function blankRange(source, start, end) {
  return source.slice(0, start) +
    source.slice(start, end).replace(/[^\n]/g, " ") +
    source.slice(end);
}

function maskConstantFalseBranches(source) {
  let result = source;
  let code = maskSource(result);
  const pattern = /\bif\s*\(\s*false\s*\)\s*\{/g;
  for (const match of code.matchAll(pattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("{");
    const closingIndex = matchingClosing(code, openingIndex, "{", "}");
    if (closingIndex !== -1) {
      result = blankRange(result, openingIndex + 1, closingIndex);
      code = maskSource(result);
    }
  }
  return result;
}

function functionDefinitions(source) {
  const code = maskSource(source);
  const definitions = [];
  const patterns = [
    /\b(?:export\s+)?(?:default\s+)?async\s+function\s+([A-Za-z_$]\w*)\s*\(([^)]*)\)\s*(?::[^{]+)?\{/g,
    /\b(?:export\s+)?function\s+([A-Za-z_$]\w*)\s*\(([^)]*)\)\s*(?::[^{]+)?\{/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::[^=]+)?=>\s*\{/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const bodyStart = match.index + match[0].lastIndexOf("{");
      const bodyEnd = matchingClosing(code, bodyStart, "{", "}");
      if (bodyEnd === -1) continue;
      definitions.push({
        body: source.slice(bodyStart + 1, bodyEnd),
        bodyEnd,
        bodyStart,
        end: bodyEnd + 1,
        name: match[1],
        parameters: splitTopLevel(match[2]).map((parameter) =>
          parameter.trim().replace(/^(?:\.\.\.)?/, "").split(/[?:=\s]/)[0]
        ).filter(Boolean),
        start: match.index,
      });
    }
  }
  return definitions
    .sort((left, right) => left.start - right.start)
    .filter((definition, index, ordered) =>
      !ordered.slice(0, index).some((candidate) =>
        candidate.name === definition.name &&
        candidate.start <= definition.start &&
        definition.end <= candidate.end
      )
    );
}

function functionMap(source) {
  return new Map(functionDefinitions(source).map((definition) => [
    definition.name,
    definition,
  ]));
}

function classDefinitions(source) {
  const code = maskSource(source);
  const definitions = [];
  const pattern =
    /\b(?:export\s+)?class\s+([A-Za-z_$]\w*)(?:\s+extends\s+[A-Za-z_$][\w$.<>]*)?\s*\{/g;
  for (const match of code.matchAll(pattern)) {
    const bodyStart = match.index + match[0].lastIndexOf("{");
    const bodyEnd = matchingClosing(code, bodyStart, "{", "}");
    if (bodyEnd === -1) continue;
    definitions.push({
      body: source.slice(bodyStart + 1, bodyEnd),
      bodyEnd,
      bodyStart,
      end: bodyEnd + 1,
      name: match[1],
      start: match.index,
    });
  }
  return definitions;
}

function typeDefinitions(source) {
  const code = maskSource(source);
  const definitions = [];

  const interfacePattern =
    /\b(?:export\s+)?interface\s+[A-Za-z_$]\w*(?:\s+extends\s+[^{]+)?\s*\{/g;
  for (const match of code.matchAll(interfacePattern)) {
    const bodyStart = match.index + match[0].lastIndexOf("{");
    const bodyEnd = matchingClosing(code, bodyStart, "{", "}");
    if (bodyEnd === -1) continue;
    definitions.push({
      start: match.index,
      end: bodyEnd + 1,
    });
  }

  const typePattern = /\b(?:export\s+)?type\s+[A-Za-z_$]\w*\s*=/g;
  for (const match of code.matchAll(typePattern)) {
    const end = expressionEnd(code, match.index);
    definitions.push({
      start: match.index,
      end: code[end] === ";" ? end + 1 : end,
    });
  }

  return definitions;
}

function classMethods(classSource) {
  const code = maskSource(classSource);
  const methods = [];
  const reserved = new Set(["catch", "for", "if", "switch", "while"]);
  const pattern =
    /(?:^|\n)\s*(?:(?:public|private|protected|static|readonly)\s+)*(async\s*)?(\*?\s*[A-Za-z_$]\w*)\s*\(([^)]*)\)\s*(?::[^{]+)?\{/g;
  for (const match of code.matchAll(pattern)) {
    const bodyStart = match.index + match[0].lastIndexOf("{");
    const bodyEnd = matchingClosing(code, bodyStart, "{", "}");
    if (bodyEnd === -1) continue;
    const name = match[2].replace(/^\*\s*/, "");
    if (reserved.has(name)) continue;
    methods.push({
      async: Boolean(match[1]),
      body: classSource.slice(bodyStart + 1, bodyEnd),
      bodyEnd,
      bodyStart,
      name,
      parameters: splitTopLevel(match[3]).map((parameter) =>
        parameter.trim().replace(/^(?:\.\.\.)?/, "").split(/[?:=\s]/)[0]
      ).filter(Boolean),
    });
  }
  return methods;
}

function importBindings(source, packageName) {
  const named = new Map();
  const namespaces = new Set();
  const original = maskSource(source, false);
  const code = maskSource(source, true);

  const namedPattern = new RegExp(
    `\\bimport\\s+(?!type\\b)\\{([^}]+)\\}\\s+from\\s+(["'])${escapeRegExp(packageName)}\\2`,
    "g",
  );
  for (const match of original.matchAll(namedPattern)) {
    if (!code.slice(match.index).startsWith("import")) continue;
    for (const specifier of splitTopLevel(match[1])) {
      const local = /^(?<name>[A-Za-z_$]\w*)(?:\s+as\s+(?<alias>[A-Za-z_$]\w*))?$/
        .exec(specifier);
      if (local?.groups) {
        named.set(local.groups.name, local.groups.alias ?? local.groups.name);
      }
    }
  }

  const namespacePattern = new RegExp(
    `\\bimport\\s+\\*\\s+as\\s+([A-Za-z_$]\\w*)\\s+from\\s+(["'])${escapeRegExp(packageName)}\\2`,
    "g",
  );
  for (const match of original.matchAll(namespacePattern)) {
    if (!code.slice(match.index).startsWith("import")) continue;
    namespaces.add(match[1]);
  }

  return { named, namespaces };
}

function importReferences(source, packageName, exportName) {
  const imports = importBindings(source, packageName);
  const references = new Set();
  const direct = imports.named.get(exportName);
  if (direct) references.add(direct);
  for (const namespace of imports.namespaces) {
    references.add(`${namespace}.${exportName}`);
  }
  return references;
}

function hasShadowedBinding(source, name) {
  const code = maskSource(source);
  return new RegExp(
    `\\b(?:class|function|const|let|var)\\s+${escapeRegExp(name)}\\b`,
  ).test(code) ||
    new RegExp(
      `\\b(?:async\\s+)?function\\s+[A-Za-z_$]\\w*\\s*\\([^)]*\\b${escapeRegExp(name)}\\b[^)]*\\)`,
    ).test(code) ||
    new RegExp(
      `\\([^)]*\\b${escapeRegExp(name)}\\b[^)]*\\)\\s*=>`,
    ).test(code);
}

function constructorBindings(source, references) {
  const bindings = [];
  for (const reference of references) {
    const pattern = new RegExp(
      `\\b(?:const|let|var)\\s+(\\w+)(?:\\s*:[^=;]+)?\\s*=\\s*new\\s+${escapeRegExp(reference)}\\s*\\(`,
      "g",
    );
    for (const match of source.matchAll(pattern)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      bindings.push({
        arguments: balancedText(source, openingIndex),
        index: match.index,
        name: match[1],
        reference,
      });
    }
  }
  return bindings;
}

function constructorCalls(source, references) {
  const calls = [];
  for (const reference of references) {
    const pattern = new RegExp(`\\bnew\\s+${escapeRegExp(reference)}\\s*\\(`, "g");
    for (const match of source.matchAll(pattern)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      calls.push({
        arguments: balancedText(source, openingIndex),
        index: match.index,
        reference,
      });
    }
  }
  return calls;
}

function methodCalls(source, receiver, methodName) {
  const pattern = new RegExp(
    `\\b${escapeRegExp(receiver)}\\s*(?:\\?\\.|\\.)\\s*${escapeRegExp(methodName)}\\s*\\(`,
    "g",
  );
  const calls = [];
  for (const match of source.matchAll(pattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    calls.push({
      arguments: balancedText(source, openingIndex),
      index: match.index,
      receiver,
    });
  }
  return calls;
}

function parentFunctionDefinition(context, definition) {
  return context.functionDefinitions
    .filter((candidate) =>
      candidate !== definition &&
      candidate.start < definition.start &&
      definition.end <= candidate.end
    )
    .toSorted((left, right) => (left.end - left.start) - (right.end - right.start))
    .at(0) ?? null;
}

function collectMethodNames(classes, predicate) {
  const names = [];
  for (const cls of classes) {
    for (const method of cls.methods) {
      if (predicate(method)) names.push(method.name);
    }
  }
  return [...new Set(names)];
}

function directEnvNames(source) {
  const names = new Set();
  const code = maskSource(source);
  for (const match of code.matchAll(/\bprocess\s*\.\s*env\s*\.\s*([A-Z0-9_]+)/g)) {
    names.add(match[1]);
  }
  for (const match of code.matchAll(
    /\bprocess\s*\.\s*env\s*\[\s*["']([A-Z0-9_]+)["']\s*\]/g,
  )) {
    names.add(match[1]);
  }
  return names;
}

function helperEnvNames(source, helpers) {
  const names = new Set();
  const code = maskSource(source);
  for (const helper of helpers) {
    const pattern = new RegExp(`\\b${escapeRegExp(helper)}\\s*\\(`, "g");
    for (const match of code.matchAll(pattern)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const [firstArgument] = splitTopLevel(balancedText(source, openingIndex));
      const envName = /^["']([A-Z0-9_]+)["']$/.exec(firstArgument ?? "");
      if (envName) names.add(envName[1]);
    }
  }
  return names;
}

function workspaceContext(workspace) {
  const documents = sourceDocuments(workspace);
  const source = documents.map(({ source: documentSource }) => documentSource)
    .join("\n");
  const activeSource = maskConstantFalseBranches(source);
  const functionDefinitionsList = functionDefinitions(activeSource);
  const classes = classDefinitions(activeSource).map((definition) => ({
    ...definition,
    methods: classMethods(definition.body),
  }));
  const functions = new Map(functionDefinitionsList.map((definition) => [
    definition.name,
    definition,
  ]));
  const types = typeDefinitions(activeSource);
  const envNames = new Set([
    ...directEnvNames(activeSource),
    ...helperEnvNames(activeSource, ["requireEnvironment", "integerEnvironment"]),
  ]);
  return {
    classes,
    code: maskSource(activeSource),
    documents,
    envNames,
    functionDefinitions: functionDefinitionsList,
    functions,
    source: activeSource,
    types,
  };
}

function usesConnectionStringOrKey(source) {
  const code = maskSource(source);
  return /\bfromConnectionString\s*\(/.test(code) ||
    /\bStorageSharedKeyCredential\b/.test(code) ||
    /\bAzureNamedKeyCredential\b/.test(code) ||
    /\bAccountKey\b/.test(code) ||
    /\bconnectionString\b/.test(code);
}

function credentialBindings(source) {
  const references = importReferences(source, "@azure/identity", "DefaultAzureCredential");
  if (
    references.size === 0 ||
    [...references].some((reference) => !reference.includes(".") && hasShadowedBinding(source, reference))
  ) {
    return [];
  }
  return constructorBindings(source, references);
}

function serviceClientBindings(source) {
  const references = importReferences(source, "@azure/storage-blob", "BlobServiceClient");
  if (
    references.size === 0 ||
    [...references].some((reference) => !reference.includes(".") && hasShadowedBinding(source, reference))
  ) {
    return [];
  }
  return constructorBindings(source, references);
}

function loggerCallNames(source) {
  const imports = importBindings(source, "@azure/logger");
  const callNames = new Set();
  const direct = imports.named.get("setLogLevel");
  if (direct) callNames.add(direct);
  for (const namespace of imports.namespaces) {
    callNames.add(`${namespace}.setLogLevel`);
  }
  return callNames;
}

function definitionLocalBindings(context, definition) {
  context.localBindings ??= new Map();
  const cached = context.localBindings.get(definition);
  if (cached) return cached;

  const bindings = new Set([definition.name, ...definition.parameters]);
  const body = runtimeBody(context, definition);
  const code = maskSource(body);

  for (const match of code.matchAll(/\b(?:class|const|let|var)\s+([A-Za-z_$]\w*)\b/g)) {
    bindings.add(match[1]);
  }

  for (const candidate of context.functionDefinitions) {
    if (parentFunctionDefinition(context, candidate) === definition) {
      bindings.add(candidate.name);
    }
  }

  for (const candidate of context.classes) {
    if (enclosingFunction(context, candidate.start) === definition) {
      bindings.add(candidate.name);
    }
  }

  context.localBindings.set(definition, bindings);
  return bindings;
}

function bindingShadowedAt(context, name, position) {
  return context.functionDefinitions
    .filter(({ start, end }) => start <= position && position < end)
    .some((definition) => definitionLocalBindings(context, definition).has(name));
}

function hasRetryConfiguration(source) {
  const code = maskSource(source);
  if (!/\bretryOptions\s*:/.test(code)) return false;
  const hasExponential = /\bretryPolicyType\s*:\s*[A-Za-z0-9_$.]*EXPONENTIAL\b/.test(code) ||
    /\bStorageRetryPolicyType\s*\.\s*EXPONENTIAL\b/.test(code);
  const hasRetryCounts = /\bmaxTries\s*:/.test(code);
  const hasRetryDelay = /\bretryDelayInMs\s*:/.test(code);
  const configurable = [
    ...directEnvNames(source),
    ...helperEnvNames(source, ["requireEnvironment", "integerEnvironment"]),
  ].some((name) =>
    /RETRY|DELAY|LOG_LEVEL/.test(name)
  );
  return hasExponential && hasRetryCounts && hasRetryDelay && configurable;
}

function expressionUsesCredential(expression, credentialNames) {
  const trimmed = expression.trim();
  return credentialNames.some((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`).test(trimmed)
  ) || /\bnew\s+[A-Za-z0-9_$.]*DefaultAzureCredential\s*\(/.test(trimmed);
}

function endpointEnvName(name) {
  return /(ACCOUNT_URL|BLOB_ENDPOINT|STORAGE_ENDPOINT|STORAGE_ACCOUNT_URL)/
    .test(name);
}

function normalizeTrackedExpression(expression) {
  let result = unwrapExpression(expression);
  let changed = true;
  while (changed) {
    changed = false;

    if (/^await\b/.test(result)) {
      result = unwrapExpression(result.replace(/^await\b/, "").trim());
      changed = true;
    }

    if (/[)\]A-Za-z0-9_$"'`]!$/.test(result)) {
      result = unwrapExpression(result.slice(0, -1).trim());
      changed = true;
    }

    const cast = /^(.*)\s+as\s+[^?:][\s\S]*$/.exec(result);
    if (cast) {
      result = unwrapExpression(cast[1]);
      changed = true;
    }
  }
  return result;
}

function directEndpointEnvExpression(expression) {
  const normalized = normalizeTrackedExpression(expression);
  const dotted =
    /^process\s*\.\s*env\s*\.\s*([A-Z0-9_]+)$/.exec(normalized)?.[1] ?? null;
  if (dotted && endpointEnvName(dotted)) return true;

  const indexed =
    /^process\s*\.\s*env\s*\[\s*["']([A-Z0-9_]+)["']\s*\]$/.exec(normalized)
      ?.[1] ?? null;
  if (indexed && endpointEnvName(indexed)) return true;

  const helper =
    /^requireEnvironment\s*\(\s*["']([A-Z0-9_]+)["']\s*\)$/.exec(normalized)
      ?.[1] ?? null;
  return Boolean(helper && endpointEnvName(helper));
}

function enclosingFunction(context, position) {
  return context.functionDefinitions
    .filter(({ start, end }) => start <= position && position < end)
    .toSorted((left, right) => (left.end - left.start) - (right.end - right.start))
    .at(0) ?? null;
}

function runtimeBody(context, definition) {
  const bodyStart = definition.bodyStart + 1;
  const nested = [
    ...context.classes.filter(({ start, end }) =>
      definition.start < start && end <= definition.end
    ),
    ...context.functionDefinitions.filter((candidate) =>
      candidate !== definition &&
      definition.start < candidate.start &&
      candidate.end <= definition.end
    ),
    ...context.types.filter(({ start, end }) =>
      definition.start < start && end <= definition.end
    ),
  ].toSorted((left, right) => right.start - left.start);

  let body = definition.body;
  for (const entry of nested) {
    body = blankRange(
      body,
      entry.start - bodyStart,
      entry.end - bodyStart,
    );
  }
  return body;
}

function reachableSegments(context) {
  const segments = [{
    definition: null,
    offset: 0,
    source: runtimeSource(context),
  }];
  const reachable = reachableFunctionNames(context);
  for (const definition of context.functionDefinitions) {
    if (!reachable.has(definition.name)) continue;
    segments.push({
      definition,
      offset: definition.bodyStart + 1,
      source: runtimeBody(context, definition),
    });
  }
  return segments;
}

function directFunctionCalls(source, functionName, offset = 0) {
  const code = maskSource(source);
  const pattern = new RegExp(
    `(?:^|[^\\w$.])(${escapeRegExp(functionName)})\\s*\\(`,
    "g",
  );
  const calls = [];
  for (const match of code.matchAll(pattern)) {
    const nameIndex = match.index + match[0].lastIndexOf(match[1]);
    const openingIndex = code.indexOf("(", nameIndex + match[1].length);
    calls.push({
      arguments: splitTopLevel(balancedText(source, openingIndex)),
      index: offset + nameIndex,
    });
  }
  return calls;
}

function reachableFunctionNames(context) {
  if (context.reachableFunctions) return context.reachableFunctions;

  const reachable = new Set();
  const topLevel = runtimeSource(context);
  for (const definition of context.functionDefinitions) {
    if (directFunctionCalls(topLevel, definition.name).length > 0) {
      reachable.add(definition.name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of context.functionDefinitions) {
      if (!reachable.has(definition.name)) continue;
      const body = runtimeBody(context, definition);
      for (const candidate of context.functionDefinitions) {
        if (
          !reachable.has(candidate.name) &&
          directFunctionCalls(body, candidate.name).length > 0
        ) {
          reachable.add(candidate.name);
          changed = true;
        }
      }
    }
  }

  context.reachableFunctions = reachable;
  return reachable;
}

function callSitesForFunction(context, definition) {
  const reachable = reachableFunctionNames(context);
  const sites = directFunctionCalls(runtimeSource(context), definition.name).map((call) => ({
    ...call,
    caller: null,
  }));

  for (const caller of context.functionDefinitions) {
    if (!reachable.has(caller.name)) continue;
    for (const call of directFunctionCalls(
      runtimeBody(context, caller),
      definition.name,
      caller.bodyStart + 1,
    )) {
      sites.push({
        ...call,
        caller,
      });
    }
  }

  return sites;
}

function latestAssignmentExpression(source, name, beforeIndex, start = 0) {
  const code = maskSource(source);
  const patterns = [
    new RegExp(
      `\\b(?:const|let|var)\\s+${escapeRegExp(name)}(?:\\s*:[^=;\\n]+)?\\s*=`,
      "g",
    ),
    new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*=(?!=|>)`, "g"),
  ];

  let latest = null;
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (match.index < start || match.index >= beforeIndex) continue;
      const expressionStart = match.index + match[0].length;
      if (expressionStart > beforeIndex) continue;
      const expressionStop = expressionEnd(code, expressionStart);
      if (expressionStop > beforeIndex) continue;
      latest = source.slice(expressionStart, expressionStop).trim();
    }
  }
  return latest;
}

function returnExpressions(definition, context) {
  const body = runtimeBody(context, definition);
  const code = maskSource(body);
  const returns = [];
  for (const match of code.matchAll(/\breturn\b/g)) {
    const expressionStart = match.index + match[0].length;
    const expressionStop = expressionEnd(code, expressionStart);
    const expression = body.slice(expressionStart, expressionStop).trim();
    if (expression) returns.push(expression);
  }
  return returns;
}

function memberPath(expression) {
  let remainder = normalizeTrackedExpression(expression);
  const segments = [];

  while (true) {
    const dot = /^([\s\S]*?)(?:\?\.|\.)\s*([A-Za-z_$]\w*)$/.exec(remainder);
    if (dot) {
      segments.unshift(dot[2]);
      remainder = normalizeTrackedExpression(dot[1]);
      continue;
    }

    const bracket =
      /^([\s\S]*)\[\s*["']([A-Za-z_$]\w*)["']\s*\]$/.exec(remainder);
    if (bracket) {
      segments.unshift(bracket[2]);
      remainder = normalizeTrackedExpression(bracket[1]);
      continue;
    }

    break;
  }

  return segments.length > 0 ? { base: remainder, segments } : null;
}

function callExpression(expression) {
  const normalized = normalizeTrackedExpression(expression);
  const code = maskSource(normalized, false);
  const openingIndex = code.indexOf("(");
  if (openingIndex === -1 || matchingClosing(code, openingIndex) !== code.length - 1) {
    return null;
  }

  const callee = normalized.slice(0, openingIndex).trim();
  if (!/^[A-Za-z_$]\w*$/.test(callee)) return null;

  return {
    arguments: splitTopLevel(balancedText(normalized, openingIndex)),
    name: callee,
  };
}

function objectPropertyValue(expression, propertyName) {
  const normalized = normalizeTrackedExpression(expression);
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) return null;

  const body = balancedText(normalized, 0, "{", "}");
  for (const property of splitTopLevel(body)) {
    const entry = property.trim();
    if (!entry || entry.startsWith("...")) continue;

    const keyed = /^([A-Za-z_$]\w*|["'][^"']+["'])\s*:\s*([\s\S]+)$/.exec(entry);
    if (keyed) {
      const key = keyed[1].replace(/^["']|["']$/g, "");
      if (key === propertyName) return keyed[2].trim();
      continue;
    }

    if (entry === propertyName) return propertyName;
  }

  return null;
}

function appendPropertyChain(expression, segments) {
  if (segments.length === 0) return expression;
  const base = normalizeTrackedExpression(expression);
  const prefix = base.startsWith("{") && base.endsWith("}") ? `(${base})` : base;
  return [prefix, ...segments].join(".");
}

function derivedExpressions(expression, context, scope) {
  const normalized = normalizeTrackedExpression(expression);
  const candidates = [];
  const addCandidate = (candidateExpression, candidateScope = scope) => {
    if (!candidateExpression) return;
    const normalizedCandidate = normalizeTrackedExpression(candidateExpression);
    if (!normalizedCandidate) return;
    candidates.push({
      expression: normalizedCandidate,
      scope: candidateScope,
    });
  };
  const propertyPath = memberPath(normalized);
  if (propertyPath) {
    const collectProperty = (baseExpression, baseScope) => {
      const direct = objectPropertyValue(baseExpression, propertyPath.segments[0]);
      if (direct !== null) {
        addCandidate(
          propertyPath.segments.length === 1
            ? direct
            : appendPropertyChain(direct, propertyPath.segments.slice(1)),
          baseScope,
        );
        return;
      }

      for (const candidate of derivedExpressions(baseExpression, context, baseScope)) {
        collectProperty(candidate.expression, candidate.scope);
      }
    };

    collectProperty(propertyPath.base, scope);
    return candidates;
  }

  const identifier = /^[A-Za-z_$]\w*$/.exec(normalized)?.[0] ?? null;
  if (identifier) {
    const owner = scope.definition ?? null;
    const beforeIndex = scope.position ?? context.source.length;
    if (owner) {
      const local = latestAssignmentExpression(
        context.source,
        identifier,
        beforeIndex,
        owner.bodyStart + 1,
      );
      if (local !== null) addCandidate(local, scope);

      const parameterIndex = owner.parameters.indexOf(identifier);
      if (parameterIndex !== -1) {
        for (const callSite of callSitesForFunction(context, owner)) {
          const argument = callSite.arguments[parameterIndex];
          if (!argument) continue;
          addCandidate(argument, {
            definition: callSite.caller,
            position: callSite.index,
          });
        }
      }
    }

    const topLevel = latestAssignmentExpression(
      runtimeSource(context),
      identifier,
      beforeIndex,
    );
    if (topLevel !== null) {
      addCandidate(topLevel, { definition: null, position: beforeIndex });
    }
    return candidates;
  }

  const call = callExpression(normalized);
  if (call) {
    const definition = context.functions.get(call.name);
    if (!definition) return candidates;
    for (const returned of returnExpressions(definition, context)) {
      addCandidate(returned, {
        definition,
        position: definition.bodyEnd,
      });
    }
  }

  return candidates;
}

function isAzureLogLevelReference(expression) {
  const normalized = normalizeTrackedExpression(expression);
  return /^process\s*\.\s*env\s*\.\s*AZURE_LOG_LEVEL$/.test(normalized) ||
    /^process\s*\.\s*env\s*\[\s*["']AZURE_LOG_LEVEL["']\s*\]$/.test(normalized);
}

function logLevelLiteralConfigured(expression) {
  return /["'](?:verbose|info|warning|error)["']/.test(
    maskSource(normalizeTrackedExpression(expression), false),
  );
}

function meaningfulAzureLogLevelExpression(expression, context, scope, seen = new Set()) {
  const normalized = normalizeTrackedExpression(expression);
  if (!normalized || /^(?:null|undefined|void\s+0)$/.test(normalized)) {
    return false;
  }
  if (logLevelLiteralConfigured(normalized)) return true;
  if (
    /^process\s*\.\s*argv\b/.test(normalized) ||
    /^import\s*\.\s*meta\s*\.\s*env\b/.test(normalized)
  ) {
    return true;
  }
  if (/^process\s*\.\s*env\b/.test(normalized)) {
    return !isAzureLogLevelReference(normalized) ||
      /(?:\?\?|\|\|)/.test(maskSource(normalized, false));
  }

  const key = [
    scope.definition?.name ?? "<top>",
    scope.position ?? context.source.length,
    normalized,
  ].join(":");
  if (seen.has(key)) return false;
  seen.add(key);

  return derivedExpressions(normalized, context, scope).some((candidate) =>
    meaningfulAzureLogLevelExpression(candidate.expression, context, candidate.scope, seen)
  );
}

function loggerCallConfigured(context) {
  const imports = importBindings(context.source, "@azure/logger");
  const direct = imports.named.get("setLogLevel");

  return reachableSegments(context).some(({ offset, source }) => {
    if (direct) {
      for (const call of directFunctionCalls(source, direct, offset)) {
        if (!bindingShadowedAt(context, direct, call.index)) {
          return true;
        }
      }
    }

    for (const namespace of imports.namespaces) {
      for (const call of methodCalls(source, namespace, "setLogLevel")) {
        if (!bindingShadowedAt(context, namespace, offset + call.index)) {
          return true;
        }
      }
    }

    return false;
  });
}

function azureLogLevelConfigured(context) {
  const assignmentPattern =
    /\bprocess\s*\.\s*env\s*(?:\.\s*AZURE_LOG_LEVEL|\[\s*["']AZURE_LOG_LEVEL["']\s*\])\s*(?:\?\?=|\|\|=|=)/g;

  for (const segment of reachableSegments(context)) {
    const code = maskSource(segment.source, false);
    for (const match of code.matchAll(assignmentPattern)) {
      const expressionStart = match.index + match[0].length;
      const expressionStop = expressionEnd(code, expressionStart);
      const expression = segment.source.slice(expressionStart, expressionStop).trim();
      if (!expression) continue;
      if (
        meaningfulAzureLogLevelExpression(expression, context, {
          definition: segment.definition,
          position: segment.offset + match.index,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

function expressionUsesEndpointEnv(expression, context, scope, seen = new Set()) {
  const normalized = normalizeTrackedExpression(expression);
  if (!normalized) return false;
  if (directEndpointEnvExpression(normalized)) return true;

  const key = [
    scope.definition?.name ?? "<top>",
    scope.position ?? context.source.length,
    normalized,
  ].join(":");
  if (seen.has(key)) return false;
  seen.add(key);

  return derivedExpressions(normalized, context, scope).some((candidate) =>
    expressionUsesEndpointEnv(candidate.expression, context, candidate.scope, seen)
  );
}

function configurationSatisfied(context) {
  if (context.documents.length < 2) return false;
  if (usesConnectionStringOrKey(context.source)) return false;

  const credentials = credentialBindings(context.source).map(({ name }) => name);
  const serviceClients = serviceClientBindings(context.source);
  if (credentials.length === 0 || serviceClients.length === 0) return false;

  const hasEndpointEnv = [...context.envNames].some(endpointEnvName);
  if (!hasEndpointEnv) return false;

  return serviceClients.some((binding) => {
    const owner = enclosingFunction(context, binding.index);
    const scope = { definition: owner, position: binding.index };
    const args = splitTopLevel(binding.arguments);
    if (args.length < 2) return false;
    if (!expressionUsesEndpointEnv(args[0], context, scope)) return false;
    return expressionUsesCredential(args[1], credentials);
  });
}

function streamHelperNames(context) {
  const helpers = new Set();
  for (const [name, definition] of context.functions) {
    const body = maskSource(definition.body);
    if (
      /\bfor\s+await\s*\([^)]*\bof\b/.test(body) ||
      /\bnew\s+Response\s*\(/.test(body)
    ) {
      helpers.add(name);
    }
  }
  return helpers;
}

function streamConsumedFromResponse(body, helpers) {
  const code = maskSource(body);
  if (
    /\breadableStreamBody\b/.test(code) &&
    (/\bfor\s+await\s*\([^)]*\bof\b/.test(code) || /\bnew\s+Response\s*\(/.test(code))
  ) {
    return true;
  }
  for (const helper of helpers) {
    if (
      new RegExp(`\\b${escapeRegExp(helper)}\\s*\\([^)]*readableStreamBody`).test(code)
    ) {
      return true;
    }
  }
  return false;
}

function classHelperConsumesStream(methods, method, context) {
  const helperNames = streamHelperNames(context);
  if (streamConsumedFromResponse(method.body, helperNames)) {
    return true;
  }
  const code = maskSource(method.body);
  return methods.some((candidate) =>
    candidate.name !== method.name &&
    new RegExp(`\\b(?:this\\s*\\.\\s*)?${escapeRegExp(candidate.name)}\\s*\\(`).test(code) &&
    streamConsumedFromResponse(candidate.body, helperNames)
  );
}

function methodOperation(method, methods, context) {
  const body = maskSource(method.body);
  return {
    deleteBlob: /\.(?:delete|deleteIfExists)\s*\(/.test(body),
    downloadStream:
      /\.download\s*\(/.test(body) && classHelperConsumesStream(methods, method, context),
    leaseOverwrite:
      /(?:getBlobLeaseClient\s*\(|new\s+[A-Za-z0-9_$.]*BlobLeaseClient\s*\()/.test(body) &&
      /\.acquireLease\s*\(/.test(body) &&
      /\.uploadStream\s*\(/.test(body) &&
      /\bconditions\s*:\s*\{[\s\S]{0,160}?\bleaseId\b/.test(body),
    listBlobs:
      /\bfor\s+await\s*\(\s*(?:const|let|var)\s+[A-Za-z_$]\w*\s+of\s+[A-Za-z_$][\w$.]*\s*\.\s*listBlobsFlat\s*\([^)]*\)\s*\)/.test(body) &&
      (/\byield\b/.test(body) || /\bconsole\.(?:log|info)\s*\(/.test(body)),
    uploadWithTags:
      /\.uploadStream\s*\(/.test(body) &&
      /\btags\s*:/.test(body) &&
      !/\bacquireLease\s*\(/.test(body) &&
      !/\bleaseId\b/.test(body) &&
      !/\.uploadData\s*\(|\.upload\s*\(/.test(body.replace(/\.uploadStream\s*\(/g, "")),
  };
}

function serviceClasses(context) {
  return context.classes.map((cls) => ({
    ...cls,
    methodOperations: cls.methods.map((method) => ({
      method,
      ...methodOperation(method, cls.methods, context),
    })),
  })).filter((cls) => cls.methods.length > 0);
}

function findServiceClass(context) {
  return serviceClasses(context).find((cls) => {
    const operations = cls.methodOperations;
    return operations.some((operation) => operation.uploadWithTags) &&
      operations.some((operation) => operation.listBlobs) &&
      operations.some((operation) => operation.downloadStream) &&
      operations.some((operation) => operation.deleteBlob) &&
      operations.some((operation) => operation.leaseOverwrite);
  }) ?? null;
}

function packageRule(workspace, context) {
  if (context.documents.length === 0) return false;
  const dependencies = activeDependencies(workspace.packageJson);
  const required = [
    "@azure/identity",
    "@azure/storage-blob",
  ];
  if (loggerCallNames(context.source).size > 0) {
    required.push("@azure/logger");
  }
  if (!required.every((name) => typeof dependencies[name] === "string")) {
    return false;
  }
  const importsRestError =
    importReferences(context.source, "@azure/core-rest-pipeline", "RestError").size > 0;
  return !importsRestError || typeof dependencies["@azure/core-rest-pipeline"] === "string";
}

function hasStatusHandling(body, statusCode, context) {
  const code = maskSource(body);
  const direct = (
    new RegExp(
      `\\bstatusCode\\b[\\s\\S]{0,80}(?:===|==|!==|!=)\\s*${statusCode}\\b`,
    ).test(code) ||
    new RegExp(
      `${statusCode}\\b[\\s\\S]{0,80}(?:===|==|!==|!=)[\\s\\S]{0,80}\\bstatusCode\\b`,
    ).test(code)
  ) && /\b(?:catch|throw|console\.(?:error|warn|log))\b/.test(code);
  if (direct) return true;

  for (const [name, helper] of context.functions.entries()) {
    if (!helper || !/\bstatusCode\b/.test(maskSource(helper.body))) continue;
    if (
      new RegExp(
        `\\b${escapeRegExp(name)}\\s*\\([^)]*\\b${statusCode}\\b[^)]*\\)`,
      ).test(code)
    ) {
      return /\b(?:catch|throw|console\.(?:error|warn|log))\b/.test(code);
    }
  }
  return false;
}

function errorHandlingSatisfied(context, serviceClass) {
  if (!serviceClass) return false;
  const hasLeaseConflict = serviceClass.methodOperations.some((operation) =>
    operation.leaseOverwrite && hasStatusHandling(operation.method.body, 409, context)
  );
  const hasNotFound = serviceClass.methodOperations.some((operation) =>
    (operation.downloadStream || operation.deleteBlob) &&
    hasStatusHandling(operation.method.body, 404, context)
  );
  return hasLeaseConflict && hasNotFound;
}

function branchBody(source, code, start) {
  while (/\s/.test(code[start] ?? "")) start += 1;
  if (start >= code.length) return null;
  if (code[start] === "{") {
    const end = matchingClosing(code, start, "{", "}");
    return end === -1
      ? null
      : { body: source.slice(start + 1, end), end: end + 1 };
  }
  if (/^(?:if|for|try)\b/.test(code.slice(start))) {
    const statement = parseStatement(source, code, start);
    return statement ? { body: source.slice(start, statement.end), end: statement.end } : null;
  }
  const end = expressionEnd(code, start);
  return {
    body: source.slice(start, code[end] === ";" ? end + 1 : end),
    end: code[end] === ";" ? end + 1 : end,
  };
}

function parseStatement(source, code, start) {
  while (/[\s;]/.test(code[start] ?? "")) start += 1;
  if (start >= code.length) return null;

  if (/^if\b/.test(code.slice(start))) {
    const opening = code.indexOf("(", start);
    const closing = opening === -1 ? -1 : matchingClosing(code, opening);
    if (closing === -1) return null;
    const consequent = branchBody(source, code, closing + 1);
    if (!consequent) return null;
    let end = consequent.end;
    while (/\s/.test(code[end] ?? "")) end += 1;
    let alternate = null;
    if (code.startsWith("else", end)) {
      alternate = branchBody(source, code, end + 4);
      if (!alternate) return null;
      end = alternate.end;
    }
    return {
      type: "if",
      condition: source.slice(opening + 1, closing),
      consequent: consequent.body,
      alternate: alternate?.body ?? null,
      end,
    };
  }

  if (/^try\b/.test(code.slice(start))) {
    const body = branchBody(source, code, start + 3);
    if (!body) return null;
    let end = body.end;
    let catchBody = null;
    let finallyBody = null;

    while (/\s/.test(code[end] ?? "")) end += 1;
    if (code.startsWith("catch", end)) {
      let cursor = end + 5;
      while (/\s/.test(code[cursor] ?? "")) cursor += 1;
      if (code[cursor] === "(") {
        const closing = matchingClosing(code, cursor);
        if (closing === -1) return null;
        cursor = closing + 1;
      }
      catchBody = branchBody(source, code, cursor);
      if (!catchBody) return null;
      end = catchBody.end;
      while (/\s/.test(code[end] ?? "")) end += 1;
    }

    if (code.startsWith("finally", end)) {
      finallyBody = branchBody(source, code, end + 7);
      if (!finallyBody) return null;
      end = finallyBody.end;
    }

    return {
      type: "try",
      body: body.body,
      catchBody: catchBody?.body ?? null,
      finallyBody: finallyBody?.body ?? null,
      end,
    };
  }

  if (/^for\b/.test(code.slice(start))) {
    const opening = code.indexOf("(", start);
    const closing = opening === -1 ? -1 : matchingClosing(code, opening);
    if (closing === -1) return null;
    const body = branchBody(source, code, closing + 1);
    if (!body) return null;
    return {
      type: "loop",
      header: source.slice(opening + 1, closing),
      body: body.body,
      end: body.end,
    };
  }

  if (/^return\b/.test(code.slice(start))) {
    const end = expressionEnd(code, start);
    return {
      type: "return",
      source: source.slice(start, code[end] === ";" ? end + 1 : end),
      end: code[end] === ";" ? end + 1 : end,
    };
  }

  if (/^throw\b/.test(code.slice(start))) {
    const end = expressionEnd(code, start);
    return {
      type: "throw",
      source: source.slice(start, code[end] === ";" ? end + 1 : end),
      end: code[end] === ";" ? end + 1 : end,
    };
  }

  const end = expressionEnd(code, start);
  return {
    type: "statement",
    source: source.slice(start, code[end] === ";" ? end + 1 : end),
    end: code[end] === ";" ? end + 1 : end,
  };
}

function blockStatements(source) {
  const code = maskSource(source);
  const statements = [];
  let cursor = 0;
  while (cursor < code.length) {
    const statement = parseStatement(source, code, cursor);
    if (!statement) break;
    statements.push(statement);
    cursor = statement.end;
  }
  return statements;
}

function unwrapExpression(expression) {
  let result = expression.trim();
  let changed = true;
  while (changed && result.startsWith("(") && result.endsWith(")")) {
    changed = false;
    const code = maskSource(result, false);
    const closing = matchingClosing(code, 0);
    if (closing === code.length - 1) {
      result = result.slice(1, -1).trim();
      changed = true;
    }
  }
  return result;
}

function constantBoolean(expression) {
  const value = unwrapExpression(expression);
  if (value === "true") return true;
  if (value === "false") return false;

  const negated = /^!\s*(.+)$/.exec(value);
  if (negated) {
    const nested = constantBoolean(negated[1]);
    return nested === null ? null : !nested;
  }

  const comparison =
    /^(true|false)\s*(===|==|!==|!=)\s*(true|false)$/.exec(value) ??
    /^(.+)\s*(===|==|!==|!=)\s*(true|false)$/.exec(value) ??
    /^(true|false)\s*(===|==|!==|!=)\s*(.+)$/.exec(value);
  if (!comparison) return null;

  const left = comparison[1] === "true" || comparison[1] === "false"
    ? comparison[1] === "true"
    : constantBoolean(comparison[1]);
  const right = comparison[3] === "true" || comparison[3] === "false"
    ? comparison[3] === "true"
    : constantBoolean(comparison[3]);
  if (left === null || right === null) return null;

  return comparison[2] === "===" || comparison[2] === "=="
    ? left === right
    : left !== right;
}

function stateSignature(state) {
  const aliases = [...state.aliases.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join(",");
  const operations = state.operations.map(({ instanceId, type }) =>
    `${type}@${instanceId}`
  ).join(",");
  return [
    aliases,
    operations,
    state.logs,
    state.abrupt ?? "normal",
    state.returnValue?.id ?? "",
  ].join("|");
}

function dedupeStates(states) {
  const unique = new Map();
  for (const state of states) {
    const signature = stateSignature(state);
    const existing = unique.get(signature);
    if (!existing || existing.logs < state.logs) {
      unique.set(signature, state);
    }
  }
  return [...unique.values()];
}

function cloneState(state) {
  return {
    aliases: new Map(state.aliases),
    operations: [...state.operations],
    logs: state.logs,
    abrupt: state.abrupt,
    returnValue: state.returnValue,
  };
}

function lifecycleOperations(serviceClass) {
  const operations = new Map();
  for (const operation of serviceClass.methodOperations) {
    if (operation.uploadWithTags) operations.set(operation.method.name, "upload");
    if (operation.downloadStream) operations.set(operation.method.name, "download");
    if (operation.leaseOverwrite) operations.set(operation.method.name, "overwrite");
    if (operation.deleteBlob) operations.set(operation.method.name, "delete");
    if (operation.listBlobs) operations.set(operation.method.name, "list");
  }
  return operations;
}

function runtimeSource(context) {
  const definitions = [
    ...context.classes.map(({ end, start }) => ({ end, start })),
    ...[...context.functions.values()].map(({ end, start }) => ({ end, start })),
    ...typeDefinitions(context.source),
  ].toSorted((left, right) => right.start - left.start);
  let source = context.source;
  for (const definition of definitions) {
    source = blankRange(source, definition.start, definition.end);
  }
  return source;
}

function assignmentTarget(source) {
  return /^\s*(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;]+)?\s*=/.exec(source)?.[1] ??
    /^\s*([A-Za-z_$]\w*)\s*=/.exec(source)?.[1] ??
    null;
}

function constructorAssignmentTarget(source, className) {
  const pattern = new RegExp(
    `^\\s*(?:(?:const|let|var)\\s+)?([A-Za-z_$]\\w*)(?:\\s*:[^=;]+)?\\s*=\\s*new\\s+${escapeRegExp(className)}\\s*\\(`,
  );
  return pattern.exec(source)?.[1] ?? null;
}

function aliasAssignment(source, aliases) {
  const match =
    /^\s*(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;]+)?\s*=\s*([A-Za-z_$]\w*)\s*;?\s*$/.exec(source) ??
    /^\s*([A-Za-z_$]\w*)\s*=\s*([A-Za-z_$]\w*)\s*;?\s*$/.exec(source);
  if (!match) return null;
  return aliases.has(match[2]) ? { from: match[2], to: match[1] } : null;
}

function directInstanceValue(expression, state, analysis) {
  const value = unwrapExpression(expression);
  if (state.aliases.has(value)) {
    return { id: state.aliases.get(value) };
  }
  return new RegExp(
    `^new\\s+${escapeRegExp(analysis.serviceClass.name)}\\s*\\(`,
  ).test(value)
    ? { id: `manager-${analysis.counter.value++}` }
    : null;
}

function helperCalls(source, analysis) {
  const calls = [];
  const code = maskSource(source);
  for (const [name, definition] of analysis.functions.entries()) {
    const pattern = new RegExp(
      `(?:^|[^\\w$.])(${escapeRegExp(name)})\\s*\\(`,
      "g",
    );
    for (const match of code.matchAll(pattern)) {
      const nameIndex = match.index + match[0].lastIndexOf(match[1]);
      const openingIndex = code.indexOf("(", nameIndex + match[1].length);
      calls.push({
        arguments: splitTopLevel(balancedText(source, openingIndex)),
        definition,
        index: nameIndex,
        name,
      });
    }
  }
  return calls.toSorted((left, right) => left.index - right.index);
}

function applyStatementLogs(state, source) {
  const count = (maskSource(source).match(/\bconsole\.(?:log|info)\s*\(/g) ?? [])
    .length;
  if (count === 0) return state;
  return {
    ...state,
    logs: state.logs + count,
  };
}

function mergeHelperResult(caller, helperState, target) {
  const merged = {
    aliases: new Map(caller.aliases),
    operations: helperState.operations,
    logs: helperState.logs,
    abrupt: helperState.abrupt === "throw" ? "throw" : null,
    returnValue: null,
  };
  if (target && helperState.returnValue?.id) {
    merged.aliases.set(target, helperState.returnValue.id);
  }
  return merged;
}

function executeBlock(source, entryState, analysis, stack = new Set()) {
  let states = [entryState];
  for (const statement of blockStatements(source)) {
    const next = [];
    for (const state of states) {
      if (state.abrupt) {
        next.push(state);
        continue;
      }
      next.push(...executeStatement(statement, state, analysis, stack));
    }
    states = dedupeStates(next);
    if (states.length === 0) break;
  }
  return states;
}

function executeReturn(source, state, analysis, stack) {
  const expression = source.replace(/^\s*return\b/, "").replace(/;\s*$/, "");
  const targetValue = directInstanceValue(expression, state, analysis);
  if (targetValue) {
    return [{
      ...state,
      abrupt: "return",
      returnValue: targetValue,
    }];
  }

  const helperCall = helperCalls(expression, analysis).at(0);
  if (helperCall && !stack.has(helperCall.name)) {
    const helperEntry = {
      aliases: new Map(state.aliases),
      operations: [...state.operations],
      logs: state.logs,
      abrupt: null,
      returnValue: null,
    };
    helperCall.definition.parameters.forEach((parameter, index) => {
      const argument = helperCall.arguments[index];
      const value = argument === undefined
        ? null
        : directInstanceValue(argument, state, analysis);
      if (parameter && value) helperEntry.aliases.set(parameter, value.id);
    });

    return executeBlock(
      helperCall.definition.body,
      helperEntry,
      analysis,
      new Set(stack).add(helperCall.name),
    ).map((result) => ({
      aliases: new Map(state.aliases),
      operations: result.operations,
      logs: result.logs,
      abrupt: result.abrupt === "throw" ? "throw" : "return",
      returnValue: result.returnValue,
    }));
  }

  const operation = executeSimpleStatement(expression, state, analysis, stack);
  return operation.map((candidate) => ({
    ...candidate,
    abrupt: candidate.abrupt === "throw" ? "throw" : "return",
  }));
}

function executeLoop(statement, state, analysis, stack) {
  let states = [cloneState(state)];
  for (const [name, instanceId] of states[0].aliases.entries()) {
    for (const [method, type] of analysis.operations.entries()) {
      if (type !== "list") continue;
      if (
        new RegExp(
          `\\bof\\s+${escapeRegExp(name)}\\s*(?:\\?\\.|\\.)\\s*${escapeRegExp(method)}\\s*\\(`,
        ).test(maskSource(statement.header))
      ) {
        states = states.map((candidate) => ({
          ...candidate,
          operations: [
            ...candidate.operations,
            { instanceId, type: "list" },
          ],
        }));
      }
    }
  }

  if (!statement.body.trim()) return states;
  return states.flatMap((candidate) =>
    executeBlock(statement.body, candidate, analysis, stack)
  );
}

function executeTry(statement, state, analysis, stack) {
  const tryStates = executeBlock(statement.body, cloneState(state), analysis, stack);
  if (!statement.finallyBody) return tryStates;

  const results = [];
  for (const candidate of tryStates) {
    const preservedAbrupt = candidate.abrupt;
    const preservedReturn = candidate.returnValue;
    const resumed = {
      ...candidate,
      abrupt: null,
    };
    for (
      const finalized of executeBlock(statement.finallyBody, resumed, analysis, stack)
    ) {
      results.push(
        finalized.abrupt
          ? finalized
          : {
            ...finalized,
            abrupt: preservedAbrupt,
            returnValue: finalized.returnValue ?? preservedReturn,
          },
      );
    }
  }
  return results;
}

function executeSimpleStatement(source, state, analysis, stack) {
  const constructorTarget = constructorAssignmentTarget(
    source,
    analysis.serviceClass.name,
  );
  if (constructorTarget) {
    const next = cloneState(state);
    next.aliases.set(constructorTarget, `manager-${analysis.counter.value++}`);
    return [next];
  }

  const alias = aliasAssignment(source, state.aliases);
  if (alias) {
    const next = cloneState(state);
    next.aliases.set(alias.to, next.aliases.get(alias.from));
    return [next];
  }

  const helperCall = helperCalls(source, analysis).at(0);
  if (helperCall && !stack.has(helperCall.name)) {
    const helperEntry = {
      aliases: new Map(state.aliases),
      operations: [...state.operations],
      logs: state.logs,
      abrupt: null,
      returnValue: null,
    };
    helperCall.definition.parameters.forEach((parameter, index) => {
      const argument = helperCall.arguments[index];
      const value = argument === undefined
        ? null
        : directInstanceValue(argument, state, analysis);
      if (parameter && value) helperEntry.aliases.set(parameter, value.id);
    });

    return executeBlock(
      helperCall.definition.body,
      helperEntry,
      analysis,
      new Set(stack).add(helperCall.name),
    ).map((result) =>
      applyStatementLogs(
        mergeHelperResult(state, result, assignmentTarget(source)),
        source,
      )
    );
  }

  let next = cloneState(state);
  const code = maskSource(source);
  const matches = [];
  for (const [receiver, instanceId] of next.aliases.entries()) {
    for (const [method, type] of analysis.operations.entries()) {
      if (type === "list") continue;
      const pattern = new RegExp(
        `\\b${escapeRegExp(receiver)}\\s*(?:\\?\\.|\\.)\\s*${escapeRegExp(method)}\\s*\\(`,
        "g",
      );
      for (const match of code.matchAll(pattern)) {
        matches.push({ index: match.index, instanceId, type });
      }
    }
  }
  matches.sort((left, right) => left.index - right.index);
  for (const match of matches) {
    next = {
      ...next,
      operations: [...next.operations, {
        instanceId: match.instanceId,
        type: match.type,
      }],
    };
  }

  return [applyStatementLogs(next, source)];
}

function executeStatement(statement, state, analysis, stack) {
  if (statement.type === "if") {
    const condition = constantBoolean(statement.condition);
    const states = [];
    if (condition !== false) {
      states.push(...executeBlock(statement.consequent, cloneState(state), analysis, stack));
    }
    if (statement.alternate && condition !== true) {
      states.push(...executeBlock(statement.alternate, cloneState(state), analysis, stack));
    } else if (condition === null) {
      states.push(cloneState(state));
    }
    return states.length > 0 ? states : [cloneState(state)];
  }
  if (statement.type === "try") {
    return executeTry(statement, state, analysis, stack);
  }
  if (statement.type === "loop") {
    return executeLoop(statement, state, analysis, stack);
  }
  if (statement.type === "return") {
    return executeReturn(statement.source, state, analysis, stack);
  }
  if (statement.type === "throw") {
    return [{
      ...state,
      abrupt: "throw",
      returnValue: null,
    }];
  }
  return executeSimpleStatement(statement.source, state, analysis, stack);
}

function lifecycleSatisfiedOnPath(state) {
  const required = ["upload", "list", "download", "overwrite", "delete"];
  const grouped = new Map();
  for (const operation of state.operations) {
    if (!grouped.has(operation.instanceId)) grouped.set(operation.instanceId, []);
    grouped.get(operation.instanceId).push(operation.type);
  }

  return state.abrupt !== "throw" &&
    state.logs >= 5 &&
    [...grouped.values()].some((operations) => {
      let index = 0;
      for (const operation of operations) {
        if (operation === required[index]) index += 1;
        if (index === required.length) return true;
      }
      return false;
    });
}

function demoLifecycleSatisfied(context, serviceClass) {
  if (!serviceClass) return false;
  const analysis = {
    counter: { value: 0 },
    functions: context.functions,
    operations: lifecycleOperations(serviceClass),
    serviceClass,
  };
  const states = executeBlock(runtimeSource(context), {
    aliases: new Map(),
    operations: [],
    logs: 0,
    abrupt: null,
    returnValue: null,
  }, analysis);
  return states.some(lifecycleSatisfiedOnPath);
}

const rules = {
  "prompt/packages": (workspace) => {
    const context = workspaceContext(workspace);
    return packageRule(workspace, context);
  },
  "prompt/configuration": (workspace) => {
    const context = workspaceContext(workspace);
    return packageRule(workspace, context) && configurationSatisfied(context);
  },
  "prompt/retry-and-logging": (workspace) => {
    const context = workspaceContext(workspace);
    return configurationSatisfied(context) &&
      hasRetryConfiguration(context.source) &&
      (loggerCallConfigured(context) || azureLogLevelConfigured(context));
  },
  "prompt/service-class": (workspace) => {
    const context = workspaceContext(workspace);
    return context.documents.length >= 2 && findServiceClass(context) !== null;
  },
  "prompt/upload-with-tags": (workspace) => {
    const context = workspaceContext(workspace);
    const serviceClass = findServiceClass(context);
    return Boolean(serviceClass?.methodOperations.some((operation) =>
      operation.uploadWithTags
    ));
  },
  "prompt/list-blobs": (workspace) => {
    const context = workspaceContext(workspace);
    const serviceClass = findServiceClass(context);
    return Boolean(serviceClass?.methodOperations.some((operation) =>
      operation.listBlobs
    ));
  },
  "prompt/download-stream": (workspace) => {
    const context = workspaceContext(workspace);
    const serviceClass = findServiceClass(context);
    return Boolean(serviceClass?.methodOperations.some((operation) =>
      operation.downloadStream
    ));
  },
  "prompt/lease-overwrite": (workspace) => {
    const context = workspaceContext(workspace);
    const serviceClass = findServiceClass(context);
    return Boolean(serviceClass?.methodOperations.some((operation) =>
      operation.leaseOverwrite
    ));
  },
  "prompt/error-handling": (workspace) => {
    const context = workspaceContext(workspace);
    return errorHandlingSatisfied(context, findServiceClass(context));
  },
  "prompt/demo-lifecycle": (workspace) => {
    const context = workspaceContext(workspace);
    return demoLifecycleSatisfied(context, findServiceClass(context));
  },
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  return rule(workspace);
}

export function ruleNames() {
  return Object.keys(rules);
}
