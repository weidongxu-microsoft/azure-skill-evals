function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codeOnly(source) {
  let result = "";
  let quote = null;
  let triple = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (quote !== null) {
      if (character === "\n") {
        result += "\n";
        if (!triple) {
          quote = null;
        }
        continue;
      }
      if (
        triple &&
        character === quote &&
        source.slice(index, index + 3) === quote.repeat(3)
      ) {
        result += "   ";
        index += 2;
        quote = null;
        triple = false;
      } else if (
        !triple &&
        character === quote &&
        source[index - 1] !== "\\"
      ) {
        result += " ";
        quote = null;
      } else {
        result += " ";
      }
      continue;
    }

    if (character === "#") {
      while (index < source.length && source[index] !== "\n") {
        result += " ";
        index += 1;
      }
      if (index < source.length) {
        result += "\n";
      }
      continue;
    }

    if (character === "'" || character === '"') {
      triple = source.slice(index, index + 3) === character.repeat(3);
      quote = character;
      result += triple ? "   " : " ";
      if (triple) {
        index += 2;
      }
      continue;
    }

    result += character;
  }

  return result;
}

function findClosingParenthesis(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === "(") {
      depth += 1;
    } else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitArgumentRanges(argumentSource) {
  const ranges = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < argumentSource.length; index += 1) {
    const character = argumentSource[index];
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (depth === 0 && character === ",") {
      ranges.push([start, index]);
      start = index + 1;
    }
  }
  ranges.push([start, argumentSource.length]);
  return ranges.filter(([from, to]) => argumentSource.slice(from, to).trim());
}

function topLevelEquals(argument) {
  let depth = 0;
  for (let index = 0; index < argument.length; index += 1) {
    const character = argument[index];
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (depth === 0 && character === "=") {
      return index;
    }
  }
  return -1;
}

function parseArguments(argumentSource, rawArgumentSource = argumentSource) {
  const positional = [];
  const named = new Map();

  for (const [rangeStart, rangeEnd] of splitArgumentRanges(argumentSource)) {
    const masked = argumentSource.slice(rangeStart, rangeEnd);
    const raw = rawArgumentSource.slice(rangeStart, rangeEnd);
    const leading = masked.match(/^\s*/)[0].length;
    const trimmed = masked.trim();
    const equals = topLevelEquals(trimmed);
    if (equals !== -1 && /^\w+$/.test(trimmed.slice(0, equals).trim())) {
      const name = trimmed.slice(0, equals).trim();
      const valueStart = leading + equals + 1;
      named.set(name, {
        offset: rangeStart + valueStart,
        raw: raw.slice(valueStart).trim(),
        value: masked.slice(valueStart).trim(),
      });
    } else {
      positional.push({
        offset: rangeStart + leading,
        raw: raw.trim(),
        value: trimmed,
      });
    }
  }
  return { named, positional };
}

function importBindings(source, moduleName, importedName) {
  const bindings = new Set();
  const escapedModule = escapeRegularExpression(moduleName);
  const directPattern = new RegExp(
    `\\bfrom\\s+${escapedModule}\\s+import\\s+(\\([^)]*\\)|[^\\n]+)`,
    "g",
  );

  for (const match of source.matchAll(directPattern)) {
    const imports = match[1].replace(/[()]/g, " ");
    for (const imported of imports.split(",")) {
      const binding = imported
        .trim()
        .match(
          new RegExp(
            `^${escapeRegularExpression(importedName)}(?:\\s+as\\s+(\\w+))?$`,
          ),
        );
      if (binding) {
        bindings.add(binding[1] ?? importedName);
      }
    }
  }

  const importPattern = new RegExp(
    `(?:^|\\n)\\s*import\\s+${escapedModule}(?:\\s+as\\s+(\\w+))?`,
    "g",
  );
  for (const match of source.matchAll(importPattern)) {
    bindings.add(`${match[1] ?? moduleName}.${importedName}`);
  }

  const separator = moduleName.lastIndexOf(".");
  if (separator !== -1) {
    const parent = moduleName.slice(0, separator);
    const child = moduleName.slice(separator + 1);
    const fromParentPattern = new RegExp(
      `\\bfrom\\s+${escapeRegularExpression(parent)}\\s+import\\s+${escapeRegularExpression(child)}(?:\\s+as\\s+(\\w+))?`,
      "g",
    );
    for (const match of source.matchAll(fromParentPattern)) {
      bindings.add(`${match[1] ?? child}.${importedName}`);
    }
  }

  return bindings;
}

function moduleBindings(source, moduleName) {
  const bindings = new Set();
  const pattern = new RegExp(
    `(?:^|\\n)\\s*import\\s+${escapeRegularExpression(moduleName)}(?:\\s+as\\s+(\\w+))?`,
    "g",
  );
  for (const match of source.matchAll(pattern)) {
    bindings.add(match[1] ?? moduleName);
  }
  return bindings;
}

function expressionPattern(bindings) {
  return [...bindings]
    .sort((left, right) => right.length - left.length)
    .map((binding) =>
      escapeRegularExpression(binding).replaceAll("\\.", "\\s*\\.\\s*"),
    )
    .join("|");
}

const symbolSource = String.raw`\w+(?:\s*\.\s*\w+)*`;

function normalizedSymbol(expression) {
  const symbol = expression.trim();
  return new RegExp(`^${symbolSource}$`).test(symbol)
    ? symbol.replace(/\s+/g, "")
    : null;
}

function withoutOuterParentheses(expression) {
  let candidate = expression.trim();
  while (
    candidate.startsWith("(") &&
    findClosingParenthesis(candidate, 0) === candidate.length - 1
  ) {
    candidate = candidate.slice(1, -1).trim();
  }
  return candidate;
}

function assignmentBefore(source, callStart) {
  const prefixStart = Math.max(0, callStart - 400);
  const prefix = source.slice(prefixStart, callStart);
  const match = prefix.match(
    new RegExp(
      `(?:^|\\n)\\s*(${symbolSource})\\s*(?::[^=\\n]+)?=` +
        String.raw`\s*(?:await\s+)?(?:\(\s*)?$`,
    ),
  );
  if (!match) {
    return {};
  }
  const assigned = normalizedSymbol(match[1]);
  return {
    assigned,
    assignmentStart:
      prefixStart + match.index + match[0].lastIndexOf(match[1]),
  };
}

function collectCalls(source, rawSource, bindings, baseOffset = 0) {
  const patternSource = expressionPattern(bindings);
  if (!patternSource) {
    return [];
  }

  const calls = [];
  const pattern = new RegExp(`\\b(?:${patternSource})\\s*\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const closingIndex = findClosingParenthesis(source, openingIndex);
    if (closingIndex === -1) {
      continue;
    }
    const assignment = assignmentBefore(source, match.index);
    const suffix = source.slice(closingIndex + 1, closingIndex + 100);
    calls.push({
      ...assignment,
      args: source.slice(openingIndex + 1, closingIndex),
      closingIndex: baseOffset + closingIndex,
      contextAlias: normalizedSymbol(
        suffix.match(
          new RegExp(`^\\s+as\\s+(${symbolSource})`),
        )?.[1] ?? "",
      ),
      openingIndex: baseOffset + openingIndex,
      rawArgs: rawSource.slice(openingIndex + 1, closingIndex),
      startIndex: baseOffset + match.index,
    });
  }
  return calls;
}

function collectMethodCalls(source, rawSource, receivers, methodNames) {
  const methods = methodNames.map(escapeRegularExpression).join("|");
  const pattern = new RegExp(
    `\\b(${symbolSource})\\s*\\.\\s*(${methods})\\s*\\(`,
    "g",
  );
  const calls = [];

  for (const match of source.matchAll(pattern)) {
    const receiver = normalizedSymbol(match[1]);
    if (receivers && !receivers.has(receiver)) {
      continue;
    }
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const closingIndex = findClosingParenthesis(source, openingIndex);
    if (closingIndex !== -1) {
      calls.push({
        ...assignmentBefore(source, match.index),
        args: source.slice(openingIndex + 1, closingIndex),
        closingIndex,
        method: match[2],
        openingIndex,
        rawArgs: rawSource.slice(openingIndex + 1, closingIndex),
        receiver,
        startIndex: match.index,
      });
    }
  }
  return calls;
}

function sourceLines(source) {
  const lines = [];
  let start = 0;
  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0] && match.index === source.length) {
      break;
    }
    const text = match[0].replace(/\r?\n$/, "");
    lines.push({
      end: match.index + match[0].length,
      indentation: text.match(/^\s*/)[0].length,
      start,
      text,
    });
    start = match.index + match[0].length;
  }
  return lines;
}

function nextBoundary(lines, start, indentation) {
  for (let index = start; index < lines.length; index += 1) {
    if (
      lines[index].text.trim() &&
      lines[index].indentation <= indentation
    ) {
      return index;
    }
  }
  return lines.length;
}

function collectScopes(source) {
  const lines = sourceLines(source);
  const scopes = [
    { end: source.length, parameters: new Set(), start: 0 },
  ];
  const pattern = /^([ \t]*)(?:async\s+)?def\s+\w+\s*\(/gm;

  for (const match of source.matchAll(pattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const closingIndex = findClosingParenthesis(source, openingIndex);
    if (closingIndex === -1) {
      continue;
    }
    const lineEnd = source.indexOf("\n", closingIndex);
    const colon = source.indexOf(":", closingIndex);
    if (colon === -1 || (lineEnd !== -1 && colon > lineEnd)) {
      continue;
    }
    let headerLine = lines.findIndex(
      ({ end, start }) => colon >= start && colon < end,
    );
    if (headerLine === -1) {
      headerLine = lines.length - 1;
    }
    const boundary = nextBoundary(
      lines,
      headerLine + 1,
      match[1].length,
    );
    const parameterSource = source.slice(openingIndex + 1, closingIndex);
    const parameters = new Set(
      splitArgumentRanges(parameterSource)
        .map(([from, to]) =>
          parameterSource
            .slice(from, to)
            .split(/[=:]/, 1)[0]
            .replace(/^\*+/, "")
            .trim(),
        )
        .filter(Boolean),
    );
    scopes.push({
      end: boundary < lines.length ? lines[boundary].start : source.length,
      parameters,
      start:
        headerLine + 1 < lines.length
          ? lines[headerLine + 1].start
          : source.length,
    });
  }
  return scopes;
}

function innermostScope(scopes, position) {
  return scopes
    .filter(({ end, start }) => position >= start && position < end)
    .sort((left, right) => right.start - left.start)[0];
}

function collectAssignments(source, rawSource, scopes) {
  const assignments = [];
  const pattern = new RegExp(
    `^([ \\t]*)(${symbolSource})[ \\t]*(?::[^=\\n]+)?=[ \\t]*(.*)$`,
    "gm",
  );
  for (const match of source.matchAll(pattern)) {
    let nestingDepth = 0;
    for (const character of source.slice(0, match.index)) {
      if ("([{".includes(character)) {
        nestingDepth += 1;
      } else if (")]}".includes(character)) {
        nestingDepth -= 1;
      }
    }
    if (nestingDepth > 0) {
      continue;
    }
    const variableOffset = match[0].indexOf(match[2]);
    const start = match.index + variableOffset;
    const rawLine = rawSource.slice(match.index, match.index + match[0].length);
    const rawRhs = rawLine.slice(match[0].indexOf("=") + 1).trim();
    assignments.push({
      kind: "assignment",
      rawRhs,
      rhs: match[3],
      scope: innermostScope(scopes, start),
      start,
      variable: normalizedSymbol(match[2]),
    });
  }
  return assignments;
}

function topLevelAs(contextItem) {
  let depth = 0;
  for (let index = 0; index < contextItem.length; index += 1) {
    const character = contextItem[index];
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (
      depth === 0 &&
      /^\s+as\s+/.test(contextItem.slice(index))
    ) {
      return index;
    }
  }
  return -1;
}

function collectWithAliases(source, rawSource, scopes) {
  const aliases = [];
  const lines = sourceLines(source);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const header = lines[lineIndex].text.match(
      /^(\s*)(?:async\s+)?with\s+(.+)$/,
    );
    if (!header) {
      continue;
    }

    const headerStart =
      lines[lineIndex].start + lines[lineIndex].text.indexOf(header[2]);
    let depth = 0;
    let colon = -1;
    for (let index = headerStart; index < source.length; index += 1) {
      const character = source[index];
      if ("([{".includes(character)) {
        depth += 1;
      } else if (")]}".includes(character)) {
        depth -= 1;
      } else if (depth === 0 && character === ":") {
        colon = index;
        break;
      }
    }
    if (colon === -1) {
      continue;
    }

    while (
      lineIndex + 1 < lines.length &&
      lines[lineIndex + 1].start <= colon
    ) {
      lineIndex += 1;
    }
    const boundary = nextBoundary(
      lines,
      lineIndex + 1,
      header[1].length,
    );
    const bodyStart =
      lineIndex + 1 < lines.length
        ? lines[lineIndex + 1].start
        : source.length;
    const bodyEnd =
      boundary < lines.length ? lines[boundary].start : source.length;
    let items = source.slice(headerStart, colon);
    let rawItems = rawSource.slice(headerStart, colon);
    let itemsOffset = 0;
    const firstNonWhitespace = items.search(/\S/);
    const lastNonWhitespace = items.search(/\s*$/) - 1;
    if (
      firstNonWhitespace !== -1 &&
      items[firstNonWhitespace] === "(" &&
      findClosingParenthesis(items, firstNonWhitespace) ===
        lastNonWhitespace
    ) {
      itemsOffset = firstNonWhitespace + 1;
      items = items.slice(itemsOffset, lastNonWhitespace);
      rawItems = rawItems.slice(itemsOffset, lastNonWhitespace);
    }

    for (const [from, to] of splitArgumentRanges(items)) {
      const item = items.slice(from, to);
      const asIndex = topLevelAs(item);
      if (asIndex === -1) {
        continue;
      }
      const aliasMatch = item
        .slice(asIndex)
        .match(new RegExp(`^\\s+as\\s+(${symbolSource})\\s*$`));
      const variable = normalizedSymbol(aliasMatch?.[1] ?? "");
      if (!variable) {
        continue;
      }
      const expression = item.slice(0, asIndex).trim();
      const leading = item.slice(0, asIndex).match(/^\s*/)[0].length;
      const expressionStart =
        headerStart + itemsOffset + from + leading;
      aliases.push({
        bodyEnd,
        bodyStart,
        expression,
        expressionEnd: expressionStart + expression.length,
        expressionStart,
        kind: "context",
        rawRhs: rawItems.slice(from, from + asIndex).trim(),
        rhs: expression,
        scope: innermostScope(scopes, expressionStart),
        start:
          headerStart +
          itemsOffset +
          from +
          asIndex +
          item.slice(asIndex).indexOf(aliasMatch[1]),
        variable,
      });
    }
  }
  return aliases;
}

function latestDefinition(context, variable, useIndex) {
  const activeContextAliases = context.withAliases.filter(
    (alias) =>
      alias.variable === variable &&
      useIndex >= alias.bodyStart &&
      useIndex < alias.bodyEnd,
  );

  let candidates;
  if (variable.includes(".")) {
    candidates = [
      ...context.assignments.filter(
        (assignment) => assignment.variable === variable,
      ),
      ...activeContextAliases,
    ];
  } else {
    const useScope = innermostScope(context.scopes, useIndex);
    const localAssignments = context.assignments.filter(
      (assignment) =>
        assignment.variable === variable && assignment.scope === useScope,
    );
    const localAliases = context.withAliases.filter(
      (alias) => alias.variable === variable && alias.scope === useScope,
    );
    const hasLocalBinding =
      useScope.parameters.has(variable) ||
      localAssignments.length > 0 ||
      localAliases.length > 0;
    candidates = hasLocalBinding
      ? [...localAssignments, ...activeContextAliases]
      : context.assignments.filter(
          (assignment) =>
            assignment.variable === variable &&
            assignment.scope === context.scopes[0],
        );
  }

  return candidates
    .filter(
      (definition) =>
        definition.start < useIndex &&
        (definition.kind !== "context" ||
          (useIndex >= definition.bodyStart &&
            useIndex < definition.bodyEnd)),
    )
    .sort((left, right) => right.start - left.start)[0];
}

function currentCallForVariable(
  context,
  calls,
  variable,
  useIndex,
  seen = new Set(),
) {
  const cycleKey = `${variable}@${useIndex}`;
  if (seen.has(cycleKey)) {
    return null;
  }
  seen.add(cycleKey);

  const definition = latestDefinition(context, variable, useIndex);
  if (definition) {
    const assignedCall =
      definition.kind === "context"
        ? calls.find(
            ({ startIndex }) =>
              startIndex >= definition.expressionStart &&
              startIndex < definition.expressionEnd,
          )
        : calls.find(
            ({ assigned, assignmentStart }) =>
              assigned === variable &&
              assignmentStart === definition.start,
          );
    if (assignedCall) {
      return assignedCall;
    }

    const alias = normalizedSymbol(definition.rhs);
    if (alias) {
      return currentCallForVariable(
        context,
        calls,
        alias,
        definition.start,
        seen,
      );
    }
    return null;
  }

  return null;
}

function isEnvironmentKey(context, expression, expectedName, useIndex) {
  const key = withoutOuterParentheses(expression);
  if (
    new RegExp(
      `^(["'])${escapeRegularExpression(expectedName)}\\1$`,
    ).test(key)
  ) {
    return true;
  }
  const variable = key.match(/^(\w+)$/)?.[1];
  if (!variable) {
    return false;
  }
  const definition = latestDefinition(context, variable, useIndex);
  return (
    definition !== undefined &&
    new RegExp(
      `^(["'])${escapeRegularExpression(expectedName)}\\1$`,
    ).test(definition.rawRhs.trim())
  );
}

function singleCallArgument(expression, callablePattern) {
  const match = expression.match(
    new RegExp(`^(?:${callablePattern})\\s*\\(`),
  );
  if (!match) {
    return null;
  }
  const openingIndex = match[0].lastIndexOf("(");
  const closingIndex = findClosingParenthesis(expression, openingIndex);
  if (
    closingIndex === -1 ||
    expression.slice(closingIndex + 1).trim() !== ""
  ) {
    return null;
  }
  const argumentsSource = expression.slice(openingIndex + 1, closingIndex);
  const ranges = splitArgumentRanges(argumentsSource);
  if (ranges.length !== 1) {
    return null;
  }
  const [start, end] = ranges[0];
  return argumentsSource.slice(start, end).trim().replace(/,\s*$/, "");
}

function osEnvironmentExpression(
  context,
  expression,
  expectedName,
  useIndex,
  seen = new Set(),
) {
  const candidate = withoutOuterParentheses(expression);
  for (const binding of context.osBindings) {
    const os = escapeRegularExpression(binding);
    const subscript = candidate.match(
      new RegExp(`^${os}\\s*\\.\\s*environ\\s*\\[([^\\]]+)\\]$`),
    );
    const call = singleCallArgument(
      candidate,
      `${os}\\s*\\.\\s*(?:getenv|environ\\s*\\.\\s*get)`,
    );
    if (
      (subscript &&
        isEnvironmentKey(
          context,
          subscript[1],
          expectedName,
          useIndex,
        )) ||
      (call !== null &&
        isEnvironmentKey(context, call, expectedName, useIndex))
    ) {
      return true;
    }
  }
  for (const binding of context.getenvBindings) {
    const call = singleCallArgument(
      candidate,
      escapeRegularExpression(binding),
    );
    if (
      call !== null &&
      isEnvironmentKey(context, call, expectedName, useIndex)
    ) {
      return true;
    }
  }
  for (const binding of context.environBindings) {
    const environ = escapeRegularExpression(binding);
    const subscript = candidate.match(
      new RegExp(`^${environ}\\s*\\[([^\\]]+)\\]$`),
    );
    const call = singleCallArgument(
      candidate,
      `${environ}\\s*\\.\\s*get`,
    );
    if (
      (subscript &&
        isEnvironmentKey(
          context,
          subscript[1],
          expectedName,
          useIndex,
        )) ||
      (call !== null &&
        isEnvironmentKey(context, call, expectedName, useIndex))
    ) {
      return true;
    }
  }

  const variable = normalizedSymbol(candidate);
  if (!variable) {
    return false;
  }
  const cycleKey = `${variable}@${useIndex}`;
  if (seen.has(cycleKey)) {
    return false;
  }
  seen.add(cycleKey);
  const definition = latestDefinition(context, variable, useIndex);
  return (
    definition !== undefined &&
    osEnvironmentExpression(
      context,
      definition.rawRhs,
      expectedName,
      definition.start,
      seen,
    )
  );
}

function osClientIdExpression(context, expression, useIndex) {
  return osEnvironmentExpression(
    context,
    expression,
    "AZURE_CLIENT_ID",
    useIndex,
  );
}

function callArguments(call) {
  return parseArguments(call.args, call.rawArgs);
}

function managedIdentityKind(context, call) {
  const args = callArguments(call);
  if (args.positional.length === 0 && args.named.size === 0) {
    return "system";
  }
  const clientId = args.named.get("client_id");
  if (
    clientId &&
    args.positional.length === 0 &&
    osClientIdExpression(context, clientId.raw, call.startIndex)
  ) {
    return "user";
  }
  return null;
}

function defaultCredentialIsConfigured(context, call) {
  const args = callArguments(call);
  const clientId = args.named.get("managed_identity_client_id");
  const exclusion = args.named.get("exclude_managed_identity_credential");
  return (
    clientId !== undefined &&
    osClientIdExpression(context, clientId.raw, call.startIndex) &&
    (exclusion === undefined ||
      /^(?:False|false|0)$/.test(exclusion.value.trim()))
  );
}

function expressionCall(expression, rawExpression, bindings, baseOffset) {
  const pattern = expressionPattern(bindings);
  if (!pattern) {
    return null;
  }
  const leading = expression.match(/^\s*/)[0].length;
  const trimmed = expression.slice(leading);
  if (!new RegExp(`^(?:${pattern})\\s*\\(`).test(trimmed)) {
    return null;
  }
  return (
    collectCalls(
      trimmed,
      rawExpression.slice(leading),
      bindings,
      baseOffset + leading,
    )[0] ?? null
  );
}

function credentialKindForExpression(
  context,
  expression,
  rawExpression,
  useIndex,
) {
  const variable = normalizedSymbol(expression);
  if (variable) {
    for (const [kind, calls] of [
      ["managed", context.managedIdentityCalls],
      ["default", context.defaultCredentialCalls],
      ["chain", context.chainCalls],
    ]) {
      const call = currentCallForVariable(
        context,
        calls,
        variable,
        useIndex,
      );
      if (call) {
        if (kind === "managed") {
          return managedIdentityKind(context, call) ? kind : null;
        }
        if (kind === "chain") {
          return chainIsOrdered(context, call) ? kind : null;
        }
        return kind;
      }
    }
    return null;
  }

  const candidates = [
    ["managed", context.managedIdentityBindings],
    ["default", context.defaultCredentialBindings],
    ["chain", context.chainBindings],
  ];
  for (const [kind, bindings] of candidates) {
    const call = expressionCall(
      expression,
      rawExpression,
      bindings,
      useIndex,
    );
    if (!call) {
      continue;
    }
    if (kind === "managed") {
      return managedIdentityKind(context, call) ? kind : null;
    }
    if (kind === "chain") {
      return chainIsOrdered(context, call) ? kind : null;
    }
    return kind;
  }
  return null;
}

function expressionIsAzureCli(context, argument, useIndex) {
  const variable = normalizedSymbol(argument.value);
  if (variable) {
    return Boolean(
      currentCallForVariable(
        context,
        context.azureCliCalls,
        variable,
        useIndex,
      ),
    );
  }
  return Boolean(
    expressionCall(
      argument.value,
      argument.raw,
      context.azureCliBindings,
      useIndex,
    ),
  );
}

function expressionIsManagedIdentity(context, argument, useIndex) {
  const variable = normalizedSymbol(argument.value);
  if (variable) {
    const call = currentCallForVariable(
      context,
      context.managedIdentityCalls,
      variable,
      useIndex,
    );
    return Boolean(call && managedIdentityKind(context, call));
  }
  const call = expressionCall(
    argument.value,
    argument.raw,
    context.managedIdentityBindings,
    useIndex,
  );
  return Boolean(call && managedIdentityKind(context, call));
}

function chainIsOrdered(context, call) {
  const args = callArguments(call);
  return (
    args.positional.length >= 2 &&
    expressionIsManagedIdentity(context, args.positional[0], call.startIndex) &&
    expressionIsAzureCli(context, args.positional[1], call.startIndex)
  );
}

function exceptHeader(source, lines, lineIndex, indentation) {
  const line = lines[lineIndex];
  const match = line.text.match(/^(\s*)except(?:\*|\b)/);
  if (!match || match[1].length !== indentation) {
    return null;
  }
  const headerStart = line.start + match[0].length;
  let depth = 0;
  for (let index = headerStart; index < source.length; index += 1) {
    const character = source[index];
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (character === ":" && depth === 0) {
      const endLine = lines.findIndex(
        ({ end, start }) => index >= start && index < end,
      );
      return {
        endLine,
        header: source.slice(headerStart, index).trim(),
      };
    } else if (character === "\n" && depth === 0) {
      return null;
    }
  }
  return null;
}

function collectTryStatements(source, rawSource = source) {
  const lines = sourceLines(source);
  const statements = [];

  for (let index = 0; index < lines.length; index += 1) {
    const tryMatch = lines[index].text.match(/^(\s*)try\s*:\s*$/);
    if (!tryMatch) {
      continue;
    }
    const indentation = tryMatch[1].length;
    let boundary = nextBoundary(lines, index + 1, indentation);
    const handlers = [];
    const bodyEnd =
      boundary < lines.length ? lines[boundary].start : source.length;

    while (boundary < lines.length) {
      const parsedHeader = exceptHeader(
        source,
        lines,
        boundary,
        indentation,
      );
      if (!parsedHeader) {
        break;
      }
      const next = nextBoundary(
        lines,
        parsedHeader.endLine + 1,
        indentation,
      );
      const handlerBodyStart = lines[parsedHeader.endLine].end;
      const handlerBodyEnd =
        next < lines.length ? lines[next].start : source.length;
      handlers.push({
        body: source.slice(handlerBodyStart, handlerBodyEnd),
        header: parsedHeader.header,
        rawBody: rawSource.slice(handlerBodyStart, handlerBodyEnd),
      });
      boundary = next;
    }
    if (handlers.length > 0) {
      statements.push({
        bodyEnd,
        bodyStart: lines[index].end,
        handlers,
      });
    }
  }
  return statements;
}

function exceptionBinding(header) {
  return header.match(/\s+as\s+(\w+)\s*$/)?.[1] ?? null;
}

function bareRaise(body) {
  return /(?:^|[;\n])\s*raise\s*(?=$|[;\n])/.test(body);
}

function identifierPattern(identifier) {
  return new RegExp(
    `(?:^|[^\\w.])${escapeRegularExpression(identifier)}(?:$|[^\\w])`,
  );
}

function fStringUsesIdentifier(raw, identifier) {
  const interpolation = new RegExp(
    `\\{[^{}]*\\b${escapeRegularExpression(identifier)}\\b[^{}]*\\}`,
  );
  for (let index = 0; index < raw.length; index += 1) {
    const quote = raw[index];
    if (quote !== "'" && quote !== '"') {
      continue;
    }
    let prefixStart = index;
    while (prefixStart > 0 && /[a-z]/i.test(raw[prefixStart - 1])) {
      prefixStart -= 1;
    }
    const prefix = raw.slice(prefixStart, index);
    if (
      !/^[rubf]*$/i.test(prefix) ||
      !prefix.toLowerCase().includes("f") ||
      (prefixStart > 0 && /\w/.test(raw[prefixStart - 1]))
    ) {
      continue;
    }
    const triple = raw.slice(index, index + 3) === quote.repeat(3);
    const contentStart = index + (triple ? 3 : 1);
    let closingIndex = -1;
    for (
      let candidate = contentStart;
      candidate < raw.length;
      candidate += 1
    ) {
      if (
        raw[candidate] === quote &&
        raw[candidate - 1] !== "\\" &&
        (!triple ||
          raw.slice(candidate, candidate + 3) === quote.repeat(3))
      ) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex === -1) {
      return false;
    }
    if (interpolation.test(raw.slice(contentStart, closingIndex))) {
      return true;
    }
    index = closingIndex + (triple ? 2 : 0);
  }
  return false;
}

function diagnosticUsesCaughtError(body, rawBody, identifier) {
  const diagnostics =
    /\b(?:print|(?:\w+\s*\.\s*)*(?:exception|error|warning|critical)|(?:sys\s*\.\s*stderr\s*\.\s*)?write|(?:sys\s*\.\s*)?exit)\s*\(/g;
  for (const match of body.matchAll(diagnostics)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const closingIndex = findClosingParenthesis(body, openingIndex);
    if (closingIndex === -1) {
      continue;
    }
    const args = body.slice(openingIndex + 1, closingIndex);
    const rawArgs = rawBody.slice(openingIndex + 1, closingIndex);
    if (
      identifierPattern(identifier).test(args) ||
      fStringUsesIdentifier(rawArgs, identifier)
    ) {
      return true;
    }
  }
  return false;
}

function causallyPreservesCaughtError(body, identifier) {
  if (!identifier) {
    return bareRaise(body);
  }
  const escaped = escapeRegularExpression(identifier);
  return (
    new RegExp(`\\braise\\s+${escaped}\\b`).test(body) ||
    new RegExp(`\\bfrom\\s+${escaped}\\b`).test(body)
  );
}

function validUnavailableHandler(handler) {
  const binding = exceptionBinding(handler.header);
  return (
    causallyPreservesCaughtError(handler.body, binding) ||
    (binding !== null &&
      diagnosticUsesCaughtError(handler.body, handler.rawBody, binding))
  );
}

function logicalPythonLines(body) {
  const physical = sourceLines(body);
  const logical = [];
  for (let index = 0; index < physical.length; index += 1) {
    const first = physical[index];
    let text = first.text;
    let depth = 0;
    const updateDepth = (value) => {
      for (const character of value) {
        if ("([{".includes(character)) depth += 1;
        else if (")]}".includes(character)) depth -= 1;
      }
    };
    updateDepth(text);
    while (
      index + 1 < physical.length &&
      (depth > 0 || /\\\s*$/.test(text))
    ) {
      index += 1;
      text += ` ${physical[index].text.trim()}`;
      updateDepth(physical[index].text);
    }
    if (text.trim()) {
      logical.push({
        indentation: first.indentation,
        text: text.trim(),
      });
    }
  }
  return logical;
}

function pythonRaiseIsCausal(statement, binding) {
  const value = statement.replace(/;\s*$/, "").trim();
  if (value === "raise") return true;
  if (!binding) return false;
  const expression = value.replace(/^raise\s+/, "");
  const from = expression.match(/^([\s\S]+)\s+from\s+([\s\S]+)$/);
  if (from) {
    return withoutOuterParentheses(from[2]) === binding;
  }
  return withoutOuterParentheses(expression) === binding;
}

function pythonHandlerAlwaysCausal(handler) {
  const lines = logicalPythonLines(handler.body);
  if (lines.length === 0) return false;
  const binding = exceptionBinding(handler.header);

  const combineSequence = (current, next) => {
    const result = new Set([...current].filter((value) => value !== "fall"));
    if (current.has("fall")) {
      for (const value of next) result.add(value);
    }
    return result;
  };

  const splitSimpleSuite = (suite) => {
    const statements = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < suite.length; index += 1) {
      const character = suite[index];
      if ("([{".includes(character)) depth += 1;
      else if (")]}".includes(character)) depth -= 1;
      else if (character === ";" && depth === 0) {
        statements.push(suite.slice(start, index));
        start = index + 1;
      }
    }
    statements.push(suite.slice(start));
    return statements;
  };

  const simpleSuiteOutcomes = (suite) => {
    let outcomes = new Set(["fall"]);
    for (const statement of splitSimpleSuite(suite)) {
      const text = statement.trim();
      if (!text) continue;
      let next = new Set(["fall"]);
      if (/^raise\b/.test(text)) {
        next = new Set([
          pythonRaiseIsCausal(text, binding) ? "safe" : "unsafe",
        ]);
      } else if (/^return\b/.test(text)) {
        next = new Set(["unsafe"]);
      } else if (/^break\b/.test(text)) {
        next = new Set([
          /^break\s*$/.test(text) ? "break" : "unsafe",
        ]);
      } else if (/^continue\b/.test(text)) {
        next = new Set([
          /^continue\s*$/.test(text) ? "continue" : "unsafe",
        ]);
      }
      outcomes = combineSequence(outcomes, next);
    }
    return outcomes;
  };

  const suiteHeader = (text, keywords) => {
    const keyword = keywords.find((value) =>
      new RegExp(`^${value}\\b`).test(text),
    );
    if (!keyword) return null;
    let depth = 0;
    for (let index = keyword.length; index < text.length; index += 1) {
      const character = text[index];
      if ("([{".includes(character)) depth += 1;
      else if (")]}".includes(character)) depth -= 1;
      else if (character === ":" && depth === 0) {
        return {
          keyword,
          condition: text.slice(keyword.length, index).trim(),
          inline: text.slice(index + 1).trim(),
        };
      }
    }
    return null;
  };

  const blockEnd = (start, end, indentation) => {
    let cursor = start;
    while (cursor < end && lines[cursor].indentation > indentation) {
      cursor += 1;
    }
    return cursor;
  };

  const literalCondition = (condition) => {
    const normalized = withoutOuterParentheses(condition).trim();
    if (normalized === "True") return true;
    if (normalized === "False") return false;
    return null;
  };

  const analyzeLoop = (
    bodyOutcomes,
    condition,
    elseOutcomes = new Set(["fall"]),
  ) => {
    if (condition === false) return elseOutcomes;
    const result = new Set(
      [...bodyOutcomes].filter(
        (value) => value === "safe" || value === "unsafe",
      ),
    );
    if (bodyOutcomes.has("break")) result.add("fall");
    const reachesCondition =
      bodyOutcomes.has("fall") || bodyOutcomes.has("continue");
    if (condition !== true && reachesCondition) {
      for (const value of elseOutcomes) result.add(value);
    }
    if (condition === null) {
      for (const value of elseOutcomes) result.add(value);
    }
    return result;
  };

  const analyzeSuite = (start, end, indentation) => {
    let outcomes = new Set(["fall"]);
    let index = start;
    while (index < end) {
      const line = lines[index];
      if (line.indentation < indentation) break;
      if (line.indentation > indentation) {
        outcomes = combineSequence(outcomes, new Set(["unsafe"]));
        index = blockEnd(index, end, indentation);
        continue;
      }

      const loop = suiteHeader(line.text, [
        "async\\s+for",
        "while",
        "for",
      ]);
      if (loop) {
        const bodyEnd = blockEnd(index + 1, end, indentation);
        const bodyOutcomes = loop.inline
          ? simpleSuiteOutcomes(loop.inline)
          : index + 1 < bodyEnd
            ? analyzeSuite(
                index + 1,
                bodyEnd,
                lines[index + 1].indentation,
              )
            : new Set(["fall"]);
        let cursor = bodyEnd;
        let elseOutcomes = new Set(["fall"]);
        const elseHeader =
          cursor < end && lines[cursor].indentation === indentation
            ? suiteHeader(lines[cursor].text, ["else"])
            : null;
        if (elseHeader) {
          const elseEnd = blockEnd(cursor + 1, end, indentation);
          elseOutcomes = elseHeader.inline
            ? simpleSuiteOutcomes(elseHeader.inline)
            : cursor + 1 < elseEnd
              ? analyzeSuite(
                  cursor + 1,
                  elseEnd,
                  lines[cursor + 1].indentation,
                )
              : new Set(["fall"]);
          cursor = elseEnd;
        }
        const condition =
          loop.keyword === "while"
            ? literalCondition(loop.condition)
            : null;
        outcomes = combineSequence(
          outcomes,
          analyzeLoop(bodyOutcomes, condition, elseOutcomes),
        );
        index = cursor;
        continue;
      }

      const conditional = suiteHeader(line.text, ["if"]);
      if (!conditional) {
        const generic = suiteHeader(line.text, [
          "async\\s+with",
          "with",
          "try",
          "except",
          "finally",
          "match",
          "case",
          "def",
          "class",
        ]);
        if (generic) {
          const nestedEnd = blockEnd(index + 1, end, indentation);
          const nested = generic.inline
            ? simpleSuiteOutcomes(generic.inline)
            : index + 1 < nestedEnd
              ? analyzeSuite(
                  index + 1,
                  nestedEnd,
                  lines[index + 1].indentation,
                )
              : new Set(["fall"]);
          outcomes = combineSequence(
            outcomes,
            new Set(["fall", ...nested]),
          );
          index = nestedEnd;
        } else {
          outcomes = combineSequence(
            outcomes,
            simpleSuiteOutcomes(line.text),
          );
          index += 1;
        }
        continue;
      }

      const branchOutcomes = [];
      let cursor = index;
      let hasElse = false;
      while (cursor < end) {
        const branch = lines[cursor];
        if (branch.indentation !== indentation) break;
        const header = suiteHeader(branch.text, ["if", "elif", "else"]);
        if (
          !header ||
          (cursor !== index && header.keyword === "if")
        ) break;
        if (header.keyword === "else") hasElse = true;
        const next = blockEnd(cursor + 1, end, indentation);
        if (header.inline) {
          branchOutcomes.push(simpleSuiteOutcomes(header.inline));
        } else if (
          cursor + 1 < next &&
          lines[cursor + 1].indentation > indentation
        ) {
          branchOutcomes.push(
            analyzeSuite(
              cursor + 1,
              next,
              lines[cursor + 1].indentation,
            ),
          );
        } else {
          branchOutcomes.push(new Set(["fall"]));
        }
        cursor = next;
        if (
          cursor >= end ||
          lines[cursor].indentation !== indentation ||
          !/^(?:elif|else)\b/.test(lines[cursor].text)
        ) {
          break;
        }
      }
      if (!hasElse) branchOutcomes.push(new Set(["fall"]));
      const conditionalOutcomes = new Set();
      for (const branch of branchOutcomes) {
        for (const value of branch) conditionalOutcomes.add(value);
      }
      outcomes = combineSequence(outcomes, conditionalOutcomes);
      index = cursor;
    }
    return outcomes;
  };

  const indentation = Math.min(...lines.map((line) => line.indentation));
  const outcomes = analyzeSuite(0, lines.length, indentation);
  return outcomes.size === 1 && outcomes.has("safe");
}

function exceptionIsExactly(header, bindings) {
  const pattern = expressionPattern(bindings);
  if (!pattern) {
    return false;
  }
  const exception = header.replace(/\s+as\s+\w+\s*$/, "").trim();
  return new RegExp(`^\\(?\\s*(?:${pattern})\\s*,?\\s*\\)?$`).test(
    exception,
  );
}

function broadException(header) {
  const exception = header.replace(/\s+as\s+\w+\s*$/, "").trim();
  return (
    exception === "" ||
    /^(?:Exception|BaseException)$/.test(exception) ||
    /^\(\s*(?:Exception|BaseException)\b/.test(exception)
  );
}

function createContext(workspace) {
  const rawSource = workspace.python ?? "";
  const source = codeOnly(rawSource);
  const managedIdentityBindings = importBindings(
    source,
    "azure.identity",
    "ManagedIdentityCredential",
  );
  const defaultCredentialBindings = importBindings(
    source,
    "azure.identity",
    "DefaultAzureCredential",
  );
  const chainBindings = importBindings(
    source,
    "azure.identity",
    "ChainedTokenCredential",
  );
  const azureCliBindings = importBindings(
    source,
    "azure.identity",
    "AzureCliCredential",
  );
  const unavailableBindings = importBindings(
    source,
    "azure.identity",
    "CredentialUnavailableError",
  );
  const secretClientBindings = new Set([
    ...importBindings(source, "azure.keyvault.secrets", "SecretClient"),
    ...importBindings(source, "azure.keyvault.secrets.aio", "SecretClient"),
  ]);
  const scopes = collectScopes(source);
  const assignments = collectAssignments(source, rawSource, scopes);
  const withAliases = collectWithAliases(source, rawSource, scopes);
  const context = {
    assignments,
    azureCliBindings,
    chainBindings,
    defaultCredentialBindings,
    environBindings: importBindings(source, "os", "environ"),
    getenvBindings: importBindings(source, "os", "getenv"),
    managedIdentityBindings,
    osBindings: moduleBindings(source, "os"),
    rawSource,
    scopes,
    source,
    unavailableBindings,
    withAliases,
  };

  context.managedIdentityCalls = collectCalls(
    source,
    rawSource,
    managedIdentityBindings,
  );
  context.defaultCredentialCalls = collectCalls(
    source,
    rawSource,
    defaultCredentialBindings,
  );
  context.chainCalls = collectCalls(source, rawSource, chainBindings);
  context.azureCliCalls = collectCalls(source, rawSource, azureCliBindings);
  context.clients = collectCalls(
    source,
    rawSource,
    secretClientBindings,
  ).map((client) => {
    const args = callArguments(client);
    const vaultUrl = args.named.get("vault_url") ?? args.positional[0];
    const credential = args.named.get("credential") ?? args.positional[1];
    const vaultUrlApproved =
      vaultUrl !== undefined &&
      osEnvironmentExpression(
        context,
        vaultUrl.raw,
        "AZURE_KEY_VAULT_URL",
        client.openingIndex + 1 + vaultUrl.offset,
      );
    const associated =
      vaultUrlApproved &&
      credential !== undefined &&
      credentialKindForExpression(
        context,
        credential.value,
        credential.raw,
        client.openingIndex + 1 + credential.offset,
      ) !== null;
    return {
      ...client,
      associated,
      variable: client.assigned ?? client.contextAlias,
      vaultUrlApproved,
    };
  });
  return context;
}

function collectAuthenticatedRetrievals(context) {
  const calls = [];
  const methodCalls = collectMethodCalls(
    context.source,
    context.rawSource,
    null,
    ["get_secret"],
  );
  for (const methodCall of methodCalls) {
    const client = currentCallForVariable(
      context,
      context.clients,
      methodCall.receiver,
      methodCall.startIndex,
    );
    if (!client?.associated) {
      continue;
    }
    const args = parseArguments(methodCall.args, methodCall.rawArgs);
    const secretName = args.named.get("name") ?? args.positional[0];
    if (
      secretName &&
      osEnvironmentExpression(
        context,
        secretName.raw,
        "AZURE_KEY_VAULT_SECRET_NAME",
        methodCall.openingIndex + 1 + secretName.offset,
      )
    ) {
      calls.push(methodCall);
    }
  }

  for (const client of context.clients.filter(({ associated }) => associated)) {
    const suffixStart = client.closingIndex + 1;
    const suffix = context.source.slice(suffixStart, suffixStart + 180);
    const chained = suffix.match(/^\s*\.\s*get_secret\s*\(/);
    if (chained) {
      const openingIndex = suffixStart + chained[0].lastIndexOf("(");
      const closingIndex = findClosingParenthesis(
        context.source,
        openingIndex,
      );
      if (closingIndex !== -1) {
        const args = parseArguments(
          context.source.slice(openingIndex + 1, closingIndex),
          context.rawSource.slice(openingIndex + 1, closingIndex),
        );
        const secretName = args.named.get("name") ?? args.positional[0];
        if (
          secretName &&
          osEnvironmentExpression(
            context,
            secretName.raw,
            "AZURE_KEY_VAULT_SECRET_NAME",
            openingIndex + 1 + secretName.offset,
          )
        ) {
          calls.push({
            assigned: client.assigned,
            closingIndex,
            openingIndex,
            startIndex: suffixStart + chained.index,
          });
        }
      }
    }
  }
  return calls.filter(
    (call, index) =>
      calls.findIndex(({ startIndex }) => startIndex === call.startIndex) ===
      index,
  );
}

function hasValueOutput(context, retrieval) {
  const printCalls = collectCalls(
    context.source,
    context.rawSource,
    new Set(["print"]),
  );
  if (
    printCalls.some(
      (printCall) =>
        printCall.openingIndex < retrieval.startIndex &&
        printCall.closingIndex > retrieval.closingIndex &&
        /^\s*\)*\s*\.value\b/.test(
          context.source.slice(
            retrieval.closingIndex + 1,
            printCall.closingIndex,
          ),
        ),
    )
  ) {
    return true;
  }
  if (!retrieval.assigned) {
    return false;
  }

  const result = escapeRegularExpression(retrieval.assigned);
  const returnsValue = /^\s*\)*\s*\.value\b/.test(
    context.source.slice(retrieval.closingIndex + 1),
  );
  const outputPattern = returnsValue
    ? new RegExp(`(?:^|[^\\w.])${result}\\b`)
    : new RegExp(`(?:^|[^\\w.])${result}\\s*\\.\\s*value\\b`);
  const interpolation = returnsValue
    ? `\\b${result}\\b`
    : `\\b${result}\\s*\\.\\s*value\\b`;
  const interpolatedOutput = new RegExp(
    `(?:^|[,([]\\s*)(?:[rub]*f[rub]*)(?:"""|'''|"|')` +
      `[^{}]*\\{[^{}]*${interpolation}[^{}]*\\}`,
    "i",
  );
  const reassigned = new RegExp(
    `(?:^|[;\\n])\\s*${result}\\s*(?::[^=;\\n]+)?=`,
  );
  if (
    printCalls.some(
      (printCall) =>
        printCall.startIndex > retrieval.closingIndex &&
        !reassigned.test(
          context.source.slice(
            retrieval.closingIndex + 1,
            printCall.startIndex,
          ),
        ) &&
        (outputPattern.test(printCall.args) ||
          interpolatedOutput.test(printCall.rawArgs)),
    )
  ) {
    return true;
  }

  const valueAssignmentPattern = returnsValue
    ? new RegExp(
        `(?:^|\\n)\\s*(\\w+)\\s*(?::[^=\\n]+)?=\\s*${result}\\b`,
        "g",
      )
    : new RegExp(
        `(?:^|\\n)\\s*(\\w+)\\s*(?::[^=\\n]+)?=\\s*${result}\\s*\\.\\s*value\\b`,
        "g",
      );
  const suffix = context.source.slice(retrieval.closingIndex + 1);
  for (const match of suffix.matchAll(valueAssignmentPattern)) {
    const assignmentStart = retrieval.closingIndex + 1 + match.index;
    if (reassigned.test(context.source.slice(retrieval.closingIndex + 1, assignmentStart))) {
      continue;
    }
    const valueVariable = escapeRegularExpression(match[1]);
    const valueReassigned = new RegExp(
      `(?:^|[;\\n])\\s*${valueVariable}\\s*(?::[^=;\\n]+)?=`,
    );
    if (
      printCalls.some(
        (printCall) =>
          printCall.startIndex > assignmentStart + match[0].length &&
          !valueReassigned.test(
            context.source.slice(
              assignmentStart + match[0].length,
              printCall.startIndex,
            ),
          ) &&
          new RegExp(`(?:^|[^\\w.])${valueVariable}\\b`).test(printCall.args),
      )
    ) {
      return true;
    }
  }
  return false;
}

function authenticatedRetrievalsWithOutput(context) {
  return collectAuthenticatedRetrievals(context).filter((retrieval) =>
    hasValueOutput(context, retrieval),
  );
}

function hasUnavailableErrorHandling(context) {
  if (context.unavailableBindings.size === 0) {
    return false;
  }
  const retrievals = authenticatedRetrievalsWithOutput(context);
  const statements = collectTryStatements(
    context.source,
    context.rawSource,
  );
  const connectedScopes = new Set();
  for (const statement of statements) {
    if (
      retrievals.some(
        ({ startIndex }) =>
          startIndex >= statement.bodyStart &&
          startIndex < statement.bodyEnd,
      )
    ) {
      connectedScopes.add(
        innermostScope(context.scopes, statement.bodyStart),
      );
    }
  }
  if (connectedScopes.size === 0) return false;

  let hasValidUnavailableHandler = false;
  for (const statement of statements) {
    const scope = innermostScope(context.scopes, statement.bodyStart);
    if (!connectedScopes.has(scope)) continue;
    const connected = retrievals.some(
      ({ startIndex }) =>
        startIndex >= statement.bodyStart && startIndex < statement.bodyEnd,
    );
    for (const handler of statement.handlers) {
      if (exceptionIsExactly(handler.header, context.unavailableBindings)) {
        if (connected && validUnavailableHandler(handler)) {
          hasValidUnavailableHandler = true;
        }
      } else if (!pythonHandlerAlwaysCausal(handler)) {
        return false;
      }
    }
  }
  return hasValidUnavailableHandler;
}

function hasSource(workspace) {
  return (
    typeof workspace.python === "string" &&
    codeOnly(workspace.python).trim() !== ""
  );
}

function declaresPackage(dependencies, packageName) {
  const packagePattern = escapeRegularExpression(packageName);
  return dependencies.split(/\r?\n/).some((line) => {
    const declaration = line.replace(/\s+#.*$/, "").trim();
    return (
      new RegExp(
        `^${packagePattern}(?:\\[[^\\]]+\\])?(?:\\s*(?:===|==|~=|!=|<=|>=|<|>|@)\\s*[^\\s,]+(?:\\s*,\\s*(?:!=|<=|>=|<|>)\\s*[^\\s,]+)*)?(?:\\s*;\\s*.+)?$`,
        "i",
      ).test(declaration) ||
      new RegExp(
        `^["']${packagePattern}(?:\\[[^\\]]+\\])?(?:\\s*(?:===|==|~=|!=|<=|>=|<|>|@)\\s*[^"']+)?["']\\s*,?$`,
        "i",
      ).test(declaration) ||
      new RegExp(
        `^["']?${packagePattern}["']?\\s*=\\s*(?:["'][^"']+["']|\\{.+\\})\\s*,?$`,
        "i",
      ).test(declaration)
    );
  });
}

const rules = {
  "prompt/identity-packages": (workspace) =>
    hasSource(workspace) &&
    declaresPackage(workspace.dependencies ?? "", "azure-identity") &&
    declaresPackage(workspace.dependencies ?? "", "azure-keyvault-secrets"),
  "prompt/system-assigned-credential": (workspace) => {
    if (!hasSource(workspace)) {
      return false;
    }
    const context = createContext(workspace);
    return context.managedIdentityCalls.some(
      (call) => managedIdentityKind(context, call) === "system",
    );
  },
  "prompt/user-assigned-credential": (workspace) => {
    if (!hasSource(workspace)) {
      return false;
    }
    const context = createContext(workspace);
    return context.managedIdentityCalls.some(
      (call) => managedIdentityKind(context, call) === "user",
    );
  },
  "prompt/default-azure-credential": (workspace) => {
    if (!hasSource(workspace)) {
      return false;
    }
    const context = createContext(workspace);
    return context.defaultCredentialCalls.some((call) =>
      defaultCredentialIsConfigured(context, call),
    );
  },
  "prompt/local-fallback-chain": (workspace) => {
    if (!hasSource(workspace)) {
      return false;
    }
    const context = createContext(workspace);
    return context.chainCalls.some((call) => chainIsOrdered(context, call));
  },
  "prompt/credential-client-association": (workspace) =>
    hasSource(workspace) &&
    createContext(workspace).clients.some(({ associated }) => associated),
  "prompt/authenticated-operation": (workspace) =>
    hasSource(workspace) &&
    authenticatedRetrievalsWithOutput(createContext(workspace)).length > 0,
  "prompt/credential-unavailable-error": (workspace) =>
    hasSource(workspace) &&
    hasUnavailableErrorHandling(createContext(workspace)),
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
