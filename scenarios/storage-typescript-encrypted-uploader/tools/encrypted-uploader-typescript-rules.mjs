import { activeDependencies, sourceDocuments } from "./source-manifest.mjs";

const sdkNames = new Set([
  "KeyClient",
  "CryptographyClient",
  "BlobServiceClient",
  "DefaultAzureCredential",
  "ManagedIdentityCredential",
  "SecretClient",
]);
const reservedWords = new Set([
  "catch",
  "for",
  "if",
  "switch",
  "while",
  "with",
]);

function replaceRange(source, start, end) {
  return `${source.slice(0, start)}${source.slice(start, end).replace(/[^\n]/g, " ")}${source.slice(end)}`;
}

function withoutComments(source) {
  let result = "";
  let state = "code";
  let escaped = false;
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line") {
      result += current === "\n" ? "\n" : " ";
      if (current === "\n") state = "code";
    } else if (state === "block") {
      result += current === "\n" ? "\n" : " ";
      if (current === "*" && next === "/") {
        result += " ";
        index += 1;
        state = "code";
      }
    } else if (state === "string") {
      result += current;
      if (!escaped && current === quote) state = "code";
      escaped = !escaped && current === "\\";
    } else if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block";
    } else if (current === "'" || current === '"' || current === "`") {
      result += current;
      state = "string";
      quote = current;
      escaped = false;
    } else {
      result += current;
    }
  }
  return result;
}

function maskLiterals(source) {
  let result = "";
  let quote = "";
  let escaped = false;
  for (const character of source) {
    if (quote) {
      result += character === "\n" ? "\n" : " ";
      if (!escaped && character === quote) quote = "";
      escaped = !escaped && character === "\\";
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += " ";
      escaped = false;
    } else {
      result += character;
    }
  }
  return result;
}

function matchingDelimiter(source, start, open = "{", close = "}") {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    if (source[index] === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function statementEnd(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  if (source[index] === "{") {
    const close = matchingDelimiter(source, index);
    return close < 0 ? -1 : close + 1;
  }

  let depth = 0;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;
    if (character === ";" && depth === 0) return index + 1;
  }
  return -1;
}

function withoutUnreachableBranches(source) {
  let result = source;
  let changed = true;
  const assignments = new Map();
  while (changed) {
    changed = false;
    const syntax = maskLiterals(result);
    const matches = [...syntax.matchAll(/\b(if|while)\s*\(/g)];
    for (const match of matches.reverse()) {
      const open = match.index + match[0].lastIndexOf("(");
      const close = matchingDelimiter(syntax, open, "(", ")");
      if (close < 0) continue;
      const consequent = flowStatementRange(syntax, close + 1);
      if (!consequent) continue;
      const constant = constantBoolean(
        result.slice(open + 1, close),
        assignments,
      );
      if (constant === null) continue;

      if (match[1] === "while" || constant === false) {
        result = replaceRange(result, match.index, consequent.end);
        changed = true;
        continue;
      }

      let alternateStart = consequent.end;
      while (/\s/.test(syntax[alternateStart] ?? "")) alternateStart += 1;
      if (!syntax.startsWith("else", alternateStart)) continue;
      const alternate = flowStatementRange(syntax, alternateStart + "else".length);
      if (!alternate) continue;
      result = replaceRange(result, alternateStart, alternate.end);
      changed = true;
    }
  }
  return result;
}

function parameterNames(source) {
  return splitArguments(source)
    .map((parameter) => {
      const match = /([A-Za-z_$][\w$]*)\s*(?:\??\s*(?::|=|$))/.exec(
        parameter.trim().replace(/^(?:public|private|protected|readonly)\s+/, ""),
      );
      return match?.[1] ?? null;
    })
    .filter(Boolean);
}

function assignmentExpression(source, start) {
  const syntax = maskLiterals(source);
  let depth = 0;
  for (let index = start; index < syntax.length; index += 1) {
    const character = syntax[index];
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;
    if (character === ";" && depth === 0) return source.slice(start, index).trim();
  }
  return source.slice(start).trim();
}

function assignmentsIn(source, position = Number.POSITIVE_INFINITY) {
  return assignmentsBefore(source, position);
}

function boundValues(source, call) {
  const prefix = source.slice(Math.max(0, call.index - 512), call.index);
  const values = new Set();
  const equals = prefix.lastIndexOf("=");
  if (equals >= 0) {
    const callPrefix = prefix.slice(equals + 1);
    if (
      /^\s*(?:await\s*)?(?:(?:this\s*\.)|(?:this\s*\.)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.)?$/.test(
        callPrefix,
      )
    ) {
      const declaration = prefix.slice(prefix.lastIndexOf(";", equals) + 1);
      const simple =
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*(?:await\s*)?(?:(?:this\s*\.)|(?:this\s*\.)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.)?\s*$/.exec(
          declaration,
        );
      if (simple) values.add(simple[1]);

      const destructured =
        /\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::\s*[^=;\n]+)?=\s*(?:await\s*)?(?:(?:this\s*\.)|(?:this\s*\.)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.)?\s*$/.exec(
          declaration,
        );
      if (destructured) {
        for (const member of destructured[1].split(",")) {
          const [property, local = property] = member.trim().split(/\s*:\s*/);
          if (/^[A-Za-z_$][\w$]*$/.test(local.trim())) values.add(local.trim());
        }
      }
    }
  }
  if (values.size === 0) {
    const callSource = source.slice(call.index, call.close + 1);
    for (const [name, expression] of assignmentsIn(source)) {
      if (expression.trim().replace(/^await\s+/, "") === callSource) values.add(name);
    }
  }
  if (values.size === 0) {
    const statementStart = Math.max(
      source.lastIndexOf(";", call.index - 1),
      source.lastIndexOf("{", call.index - 1),
      source.lastIndexOf("}", call.index - 1),
    ) + 1;
    const prefix = source.slice(statementStart, call.index);
    const simple = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*(?:await\s+)?[\s\S]*$/.exec(
      prefix,
    );
    if (simple) values.add(simple[1]);
    const destructured = /\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::\s*[^=;\n]+)?=\s*(?:await\s+)?[\s\S]*$/.exec(
      prefix,
    );
    if (destructured) {
      for (const member of destructured[1].split(",")) {
        const [, local] = member.trim().split(/\s*:\s*/);
        const name = (local ?? member).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) values.add(name);
      }
    }
  }
  return values;
}

function destructuredBindings(source, call) {
  const prefix = source.slice(Math.max(0, call.index - 512), call.index);
  const equals = prefix.lastIndexOf("=");
  if (equals < 0) return new Map();
  if (
    !/^\s*(?:await\s*)?(?:(?:this\s*\.)|(?:this\s*\.)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.)?$/.test(
      prefix.slice(equals + 1),
    )
  ) {
    return new Map();
  }
  const declaration = prefix.slice(prefix.lastIndexOf(";", equals) + 1);
  const match =
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::\s*[^=;\n]+)?=\s*(?:await\s*)?(?:(?:this\s*\.)|(?:this\s*\.)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.)?\s*$/.exec(
      declaration,
    );
  if (!match) return new Map();

  const bindings = new Map();
  for (const member of match[1].split(",")) {
    const [property, local = property] = member.trim().split(/\s*:\s*/);
    if (
      /^[A-Za-z_$][\w$]*$/.test(property.trim()) &&
      /^[A-Za-z_$][\w$]*$/.test(local.trim())
    ) {
      bindings.set(property.trim(), local.trim());
    }
  }
  return bindings;
}

function referencesName(expression, name) {
  return new RegExp(`\\b${escapeExpression(name)}\\b`).test(expression);
}

function derivesFrom(expression, values, assignments, seen = new Set()) {
  const value = expression.trim().replace(/^await\s+/, "");
  if ([...values].some((name) => referencesName(value, name))) return true;
  for (const name of value.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) {
    if (seen.has(name) || !assignments.has(name)) continue;
    seen.add(name);
    if (derivesFrom(assignments.get(name), values, assignments, seen)) return true;
  }
  return false;
}

function derivedNames(values, assignments) {
  const result = new Set(values);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, expression] of assignments) {
      if (!result.has(name) && derivesFrom(expression, result, assignments)) {
        result.add(name);
        changed = true;
      }
    }
  }
  return result;
}

function terminatingStatementEnd(source, start) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if ("([{".includes(source[index])) depth += 1;
    if (")]}".includes(source[index])) depth -= 1;
    if (depth === 0 && (source[index] === ";" || source[index] === "\n")) {
      return index + 1;
    }
  }
  return source.length;
}

function reachableBody(source) {
  const syntax = maskLiterals(source);
  const assignments = assignmentsIn(source);
  const atTopLevel = (position) => {
    let depth = 0;
    for (let index = 0; index < position; index += 1) {
      if (syntax[index] === "{") depth += 1;
      if (syntax[index] === "}") depth -= 1;
    }
    return depth === 0;
  };
  let branchCut = source.length;
  const conditionalRanges = [];

  for (const match of syntax.matchAll(/\bif\s*\(/g)) {
    if (!atTopLevel(match.index)) continue;
    const open = match.index + match[0].lastIndexOf("(");
    const close = matchingDelimiter(syntax, open, "(", ")");
    if (close < 0) continue;
    const consequent = flowStatementRange(syntax, close + 1);
    if (!consequent) continue;
    conditionalRanges.push({
      end: consequent.end,
      start: consequent.contentStart,
    });
    const constant = constantBoolean(source.slice(open + 1, close), assignments);

    let alternateStart = consequent.end;
    while (/\s/.test(syntax[alternateStart] ?? "")) alternateStart += 1;
    const alternate = syntax.startsWith("else", alternateStart)
      ? flowStatementRange(syntax, alternateStart + "else".length)
      : null;
    if (alternate) {
      conditionalRanges.push({
        end: alternate.end,
        start: alternate.contentStart,
      });
    }
    if (constant === null) continue;
    if (
      (constant === true && branchAlwaysTerminates(source, consequent)) ||
      (constant === false && alternate && branchAlwaysTerminates(source, alternate))
    ) {
      branchCut = Math.min(branchCut, match.index);
    }
  }

  for (const match of syntax.matchAll(/\b(?:return|throw)\b/g)) {
    if (!atTopLevel(match.index)) continue;
    if (
      conditionalRanges.some(
        (range) => range.start <= match.index && match.index < range.end,
      )
    ) {
      continue;
    }
    if (match.index >= branchCut) break;
    return source.slice(
      0,
      terminatingStatementEnd(syntax, match.index + match[0].length),
    );
  }
  return source.slice(0, branchCut);
}

function splitArguments(source) {
  const syntax = maskLiterals(source);
  const argumentsList = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < syntax.length; index += 1) {
    const character = syntax[index];
    if ("({[".includes(character)) depth += 1;
    if (")}]".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      argumentsList.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  argumentsList.push(source.slice(start).trim());
  return argumentsList;
}

function callsIn(source) {
  const syntax = maskLiterals(source);
  const calls = [];
  for (const match of syntax.matchAll(
    /\b([A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*)*)\s*\(/g,
  )) {
    const open = match.index + match[0].lastIndexOf("(");
    const close = matchingDelimiter(syntax, open, "(", ")");
    if (close < 0) continue;
    const statementStart = Math.max(
      syntax.lastIndexOf(";", match.index - 1),
      syntax.lastIndexOf("{", match.index - 1),
      syntax.lastIndexOf("}", match.index - 1),
    ) + 1;
    const prefix = syntax.slice(statementStart, match.index);
    calls.push({
      arguments: splitArguments(source.slice(open + 1, close)),
      awaited: /\bawait\s+(?:\(*\s*)*$/.test(prefix),
      callee: match[1].replace(/\s/g, "").replaceAll("?.", "."),
      close,
      index: match.index,
    });
  }
  return calls;
}

function importedBindings(source) {
  const bindings = new Map();
  const modules = new Set();
  const syntax = maskLiterals(source);
  const add = (local, moduleName, imported) => {
    bindings.set(local, { imported, moduleName });
    modules.add(moduleName);
  };

  for (const match of source.matchAll(
    /\bimport\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    if (syntax[match.index] !== "i") continue;
    for (const member of match[1].split(",")) {
      const parts = member.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (parts.length && /^[A-Za-z_$][\w$]*$/.test(parts[0])) {
        add(parts.at(-1), match[2], parts[0]);
      }
    }
  }
  for (const match of source.matchAll(
    /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g,
  )) {
    if (syntax[match.index] !== "i") continue;
    add(match[1], match[2], "*");
  }
  for (const match of source.matchAll(
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g,
  )) {
    if (syntax[match.index] !== "i") continue;
    add(match[1], match[2], "default");
  }
  for (const match of source.matchAll(
    /\bconst\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    if (syntax[match.index] !== "c") continue;
    for (const member of match[1].split(",")) {
      const [imported, local = imported] = member.trim().split(/\s*:\s*/);
      if (/^[A-Za-z_$][\w$]*$/.test(imported)) add(local, match[2], imported);
    }
  }
  return { bindings, modules };
}

function aliasesFor(imports, moduleName, symbol) {
  return new Set(
    [...imports.bindings.entries()]
      .filter(([, binding]) =>
        binding.moduleName === moduleName &&
        (binding.imported === symbol || binding.imported === "*")
      )
      .map(([local, binding]) =>
        binding.imported === "*" && symbol !== "*"
          ? `${local}.${symbol}`
          : local,
      ),
  );
}

function hasFakeSdk(source, imports) {
  const syntax = maskLiterals(source);
  if (
    /\b(?:class|function|const|let|var)\s+(?:(?:Fake|Mock|Local|Stub)\w*)?(?:KeyClient|CryptographyClient|BlobServiceClient|DefaultAzureCredential|SecretClient)\b/.test(
      syntax,
    )
  ) {
    return true;
  }
  return [...imports.bindings.keys()].some((binding) =>
    sdkNames.has(imports.bindings.get(binding).imported) &&
    new RegExp(
      `\\b(?:class|function|const|let|var)\\s+${escapeExpression(binding)}\\b`,
    ).test(syntax)
  );
}

function extractConstants(source) {
  const constants = new Map();
  const syntax = maskLiterals(source);
  for (const match of source.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([^;\n]+)[;\n]/g,
  )) {
    if (!["c", "l"].includes(syntax[match.index])) continue;
    constants.set(match[1], match[2].trim());
  }
  return constants;
}

function resolveExpression(expression, constants, seen = new Set()) {
  const value = expression.trim().replace(/^\((.*)\)$/, "$1").trim();
  const literal = /^(["'])(.*)\1$/s.exec(value);
  if (literal) return literal[2];
  if (/^[A-Za-z_$][\w$]*$/.test(value) && !seen.has(value)) {
    const alias = constants.get(value);
    if (alias !== undefined) {
      seen.add(value);
      return resolveExpression(alias, constants, seen);
    }
  }
  return null;
}

function resolvesToNumber(expression, expected, constants, seen = new Set()) {
  const value = expression.trim().replace(/^\((.*)\)$/, "$1").trim();
  if (/^[A-Za-z_$][\w$]*$/.test(value) && !seen.has(value)) {
    const alias = constants.get(value);
    if (alias !== undefined) {
      seen.add(value);
      return resolvesToNumber(alias, expected, constants, seen);
    }
  }
  return Number(value) === expected;
}

function resolvesToAlgorithm(expression, expected, constants) {
  return resolveExpression(expression, constants) === expected;
}

function resolvesToRsaOaepAlgorithm(expression, constants) {
  return (
    resolvesToAlgorithm(expression, "RSA-OAEP", constants) ||
    resolvesToAlgorithm(expression, "RSA-OAEP-256", constants)
  );
}

function collectUnits(source) {
  const syntax = maskLiterals(source);
  const units = new Map();
  const classes = new Map();
  const classRanges = [];
  const addUnit = (key, details) => {
    if (!units.has(key)) units.set(key, { key, ...details });
  };

  for (const match of syntax.matchAll(
    /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)[^{]*\{/g,
  )) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(syntax, open);
    if (close < 0) continue;
    const name = match[1];
    const details = {
      end: close,
      methods: new Map(),
      name,
      properties: new Map(),
      source: source.slice(match.index, close + 1),
      start: match.index,
    };
    classes.set(name, details);
    classRanges.push([match.index, close + 1]);

    const classBody = syntax.slice(open + 1, close);
    const methodPattern =
      /(?:^|[;}\n])\s*(?:(?:public|private|protected|static|readonly|async|override|declare|abstract)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>{}()]*>)?\s*\(/g;
    for (const method of classBody.matchAll(methodPattern)) {
      if (reservedWords.has(method[1])) continue;
      const methodStart = open + 1 + method.index;
      const methodOpen = open + 1 + method.index + method[0].lastIndexOf("(");
      const parameterClose = matchingDelimiter(syntax, methodOpen, "(", ")");
      if (parameterClose < 0) continue;
      const methodBodyOpen = syntax.indexOf("{", parameterClose);
      if (methodBodyOpen < 0 || methodBodyOpen >= close) continue;
      const methodClose = matchingDelimiter(syntax, methodBodyOpen);
      if (methodClose < 0 || methodClose > close) continue;
      const key = `${name}.${method[1]}`;
      addUnit(key, {
        body: reachableBody(source.slice(methodBodyOpen + 1, methodClose)),
        className: name,
        end: methodClose + 1,
        kind: "method",
        name: method[1],
        parameterSource: source.slice(methodOpen + 1, parameterClose),
        parameters: parameterNames(source.slice(methodOpen + 1, parameterClose)),
        rawBody: source.slice(methodBodyOpen + 1, methodClose),
        start: methodStart,
      });
      details.methods.set(method[1], key);
    }

    const propertyPattern =
      /\b(?:public|private|protected)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g;
    for (const property of classBody.matchAll(propertyPattern)) {
      details.properties.set(property[1], property[2].replace(/\s/g, ""));
    }
  }

  const insideClass = (index) =>
    classRanges.some(([start, end]) => index >= start && index < end);
  const atTopLevel = (index) => {
    let depth = 0;
    for (let current = 0; current < index; current += 1) {
      if (syntax[current] === "{") depth += 1;
      if (syntax[current] === "}") depth -= 1;
    }
    return depth === 0;
  };
  const functionPattern =
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>{}()]*>)?\s*\(/g;
  for (const match of syntax.matchAll(functionPattern)) {
    if (insideClass(match.index) || !atTopLevel(match.index)) continue;
    const open = match.index + match[0].lastIndexOf("(");
    const parameterClose = matchingDelimiter(syntax, open, "(", ")");
    if (parameterClose < 0) continue;
    const bodyOpen = syntax.indexOf("{", parameterClose);
    const bodyClose = bodyOpen < 0 ? -1 : matchingDelimiter(syntax, bodyOpen);
    if (bodyClose < 0) continue;
    addUnit(`function.${match[1]}`, {
      body: reachableBody(source.slice(bodyOpen + 1, bodyClose)),
      className: null,
      end: bodyClose + 1,
      kind: "function",
      name: match[1],
      parameterSource: source.slice(open + 1, parameterClose),
      parameters: parameterNames(source.slice(open + 1, parameterClose)),
      rawBody: source.slice(bodyOpen + 1, bodyClose),
      start: match.index,
    });
  }

  const arrowFunctionPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*(?:async\s+)?(?:\(([^)]*)\)(?:\s*:\s*[^=;\n]+)?|([A-Za-z_$][\w$]*))\s*=>/g;
  for (const match of syntax.matchAll(arrowFunctionPattern)) {
    if (insideClass(match.index) || !atTopLevel(match.index)) continue;
    const key = `function.${match[1]}`;
    if (units.has(key)) continue;
    let bodyStart = match.index + match[0].length;
    while (/\s/.test(syntax[bodyStart] ?? "")) bodyStart += 1;
    const blockBody = syntax[bodyStart] === "{";
    const bodyClose = blockBody
      ? matchingDelimiter(syntax, bodyStart)
      : statementEnd(syntax, bodyStart);
    if (bodyClose < 0) continue;
    const expression = blockBody
      ? source.slice(bodyStart + 1, bodyClose)
      : source.slice(bodyStart, bodyClose).replace(/;\s*$/, "");
    const body = blockBody ? expression : `return ${expression};`;
    addUnit(key, {
      body: reachableBody(body),
      className: null,
      end: blockBody ? bodyClose + 1 : bodyClose,
      kind: "function",
      name: match[1],
      parameterSource: match[2] ?? match[3] ?? "",
      parameters: parameterNames(match[2] ?? match[3] ?? ""),
      rawBody: body,
      start: match.index,
    });
  }

  const definitions = [...units.values()];
  let topLevel = source;
  for (const range of [
    ...classRanges,
    ...definitions
      .filter((unit) => unit.kind === "function")
      .map((unit) => [unit.start, unit.end]),
  ].sort(([left], [right]) => right - left)) {
    topLevel = replaceRange(topLevel, range[0], range[1]);
  }
  return { classes, topLevel, units };
}

function returnClasses(unit) {
  return new Set(
    [...unit.rawBody.matchAll(/\breturn\s+new\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(
      (match) => match[1],
    ),
  );
}

function buildGraph(definitions) {
  const { classes, units } = definitions;
  const functions = new Map(
    [...units.values()]
      .filter((unit) => unit.kind === "function")
      .map((unit) => [unit.name, unit.key]),
  );
  const returns = new Map([...units.values()].map((unit) => [unit.key, returnClasses(unit)]));
  const graph = new Map();

  for (const unit of units.values()) {
    const edges = new Set();
    const variables = new Map();
    const classDetails = unit.className ? classes.get(unit.className) : null;
    for (const match of unit.body.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g,
    )) {
      variables.set(match[1], match[3]);
    }
    for (const match of unit.body.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/g,
    )) {
      const target = functions.get(match[2]);
      const classesReturned = target ? returns.get(target) : undefined;
      if (classesReturned?.size === 1) variables.set(match[1], [...classesReturned][0]);
    }
    for (const match of unit.body.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\b/g,
    )) {
      variables.set(match[1], match[2]);
    }

    for (const call of callsIn(unit.body)) {
      const segments = call.callee.split(".");
      const method = segments.at(-1);
      const receiver = segments.slice(0, -1).join(".");
      if (!receiver) {
        if (functions.has(method)) edges.add(functions.get(method));
        if (classes.has(method)) {
          const constructor = classes.get(method).methods.get("constructor");
          if (constructor) edges.add(constructor);
        }
        continue;
      }
      let receiverClass = variables.get(receiver);
      if (receiver.startsWith("this.") && classDetails) {
        receiverClass = classDetails.properties.get(receiver.slice(5).split(".")[0]) ?? null;
      }
      if (receiverClass) {
        const target = classes.get(receiverClass)?.methods.get(method);
        if (target) edges.add(target);
      } else if (receiver === "this" && classDetails) {
        const target = classDetails.methods.get(method);
        if (target) edges.add(target);
      } else {
        const matchingMethods = [...classes.values()]
          .map((details) => details.methods.get(method))
          .filter(Boolean);
        if (matchingMethods.length === 1) edges.add(matchingMethods[0]);
      }
    }
    graph.set(unit.key, edges);
  }
  return graph;
}

function closure(graph, start) {
  const reached = new Set();
  const pending = [...start];
  while (pending.length) {
    const current = pending.pop();
    if (reached.has(current)) continue;
    reached.add(current);
    for (const target of graph.get(current) ?? []) pending.push(target);
  }
  return reached;
}

function sourceFor(units, keys) {
  return [...keys]
    .map((key) => {
      const unit = units.get(key);
      if (!unit) return "";
      return unit.kind === "function"
        ? `function ${unit.name}() {${unit.body}}`
        : unit.body;
    })
    .join("\n");
}

function hasConstructor(source, aliases) {
  return [...aliases].some((alias) =>
    new RegExp(`\\bnew\\s+${escapeExpression(alias)}\\s*\\(`).test(maskLiterals(source))
  );
}

function cryptoCallNames(imports, symbol, source) {
  const direct = aliasesFor(imports, "node:crypto", symbol);
  for (const alias of aliasesFor(imports, "crypto", symbol)) direct.add(alias);
  const namespaces = new Set([
    ...aliasesFor(imports, "node:crypto", "*"),
    ...aliasesFor(imports, "crypto", "*"),
  ]);
  const constants = extractConstants(source);
  for (const [name, value] of constants) {
    if (direct.has(value.trim())) direct.add(name);
  }
  return new Set([
    ...direct,
    ...[...namespaces].map((namespace) => `${namespace}.${symbol}`),
  ]);
}

function escapeExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clientVariables(source, aliases) {
  const clients = new Set();
  const syntax = maskLiterals(source);
  for (const alias of aliases) {
    const escaped = escapeExpression(alias);
    for (const match of syntax.matchAll(
      new RegExp(
        `\\b(?:(this)\\s*\\.\\s*)?([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${escaped}\\s*\\(`,
        "g",
      ),
    )) {
      clients.add(match[1] ? `this.${match[2]}` : match[2]);
    }
    for (const match of source.matchAll(
      new RegExp(
        `\\bfunction\\s+([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)[^{]*\\{[^}]*\\breturn\\s+new\\s+${escaped}\\s*\\(`,
        "g",
      ),
    )) {
      const factory = escapeExpression(match[1]);
      for (const created of syntax.matchAll(
        new RegExp(
          `\\b(?:(this)\\s*\\.\\s*)?([A-Za-z_$][\\w$]*)\\s*=\\s*${factory}\\s*\\(`,
          "g",
        ),
      )) {
        clients.add(created[1] ? `this.${created[2]}` : created[2]);
      }
    }
  }
  return clients;
}

function objectProperties(source) {
  const properties = new Map();
  for (const entry of splitArguments(source)) {
    const property = /^\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/.exec(entry);
    if (property) {
      properties.set(property[1] ?? property[2], property[3].trim());
      continue;
    }
    const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(entry);
    if (shorthand) properties.set(shorthand[1], shorthand[1]);
  }
  return properties;
}

function metadataObjectsIn(expression, assignments, seen = new Set()) {
  const value = expression.trim();
  const metadata = [];
  if (/^[A-Za-z_$][\w$]*$/.test(value) && assignments.has(value) && !seen.has(value)) {
    seen.add(value);
    return metadataObjectsIn(assignments.get(value), assignments, seen);
  }

  const syntax = maskLiterals(value);
  if (syntax.startsWith("{")) {
    const close = matchingDelimiter(syntax, 0);
    if (close === syntax.length - 1) {
      metadata.push(objectProperties(value.slice(1, close)));
    }
  }
  for (const match of syntax.matchAll(/\bmetadata\s*:\s*\{/g)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(syntax, open);
    if (close >= 0) metadata.push(objectProperties(value.slice(open + 1, close)));
  }
  for (const match of syntax.matchAll(/\bmetadata\s*:\s*([A-Za-z_$][\w$]*)/g)) {
    const name = match[1];
    if (assignments.has(name) && !seen.has(name)) {
      seen.add(name);
      metadata.push(...metadataObjectsIn(assignments.get(name), assignments, seen));
    }
  }
  if (/(?:^|[,{\s])metadata\s*(?=[,}])/.test(syntax) && assignments.has("metadata")) {
    metadata.push(...metadataObjectsIn(assignments.get("metadata"), assignments, seen));
  }
  return metadata;
}

function propertyValues(properties, pattern) {
  return [...properties.entries()]
    .filter(([name]) => pattern.test(name))
    .map(([, value]) => value);
}

function encodesBase64From(
  expression,
  constants,
  assignments,
  sourceMatches,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  if (/^[A-Za-z_$][\w$]*$/.test(value) && assignments.has(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return encodesBase64From(
      assignments.get(value),
      constants,
      assignments,
      sourceMatches,
      seen,
    );
  }
  const match = /^([\s\S]+)\.\s*toString\s*\(([\s\S]*)\)$/.exec(value);
  if (!match || !resolvesToAlgorithm(match[2], "base64", constants)) {
    return false;
  }
  return sourceMatches(match[1]);
}

function exactCallArguments(expression, receiver, method) {
  const syntax = maskLiterals(unwrappedValue(expression)).trim();
  const match = new RegExp(
    `^${escapeExpression(receiver)}\\s*\\.\\s*${escapeExpression(method)}\\s*\\(`,
  ).exec(syntax);
  if (!match) return null;
  const open = match.index + match[0].lastIndexOf("(");
  const close = matchingDelimiter(syntax, open, "(", ")");
  return close === syntax.length - 1
    ? splitArguments(unwrappedValue(expression).slice(open + 1, close))
    : null;
}

function exactCall(expression, receiver, method) {
  return exactCallArguments(expression, receiver, method) !== null;
}

function bufferConcatParts(expression) {
  const value = unwrappedValue(expression);
  const syntax = maskLiterals(value);
  const match = /^Buffer\s*\.\s*concat\s*\(/.exec(syntax);
  if (!match) return null;
  const open = match.index + match[0].lastIndexOf("(");
  const close = matchingDelimiter(syntax, open, "(", ")");
  if (close !== syntax.length - 1) return null;
  const [array] = splitArguments(value.slice(open + 1, close));
  if (!array?.trim().startsWith("[")) return null;
  const arraySyntax = maskLiterals(array);
  const arrayOpen = arraySyntax.indexOf("[");
  const arrayClose = matchingDelimiter(arraySyntax, arrayOpen, "[", "]");
  if (arrayClose !== arraySyntax.trimEnd().length - 1) return null;
  return splitArguments(array.slice(arrayOpen + 1, arrayClose)).filter((part) =>
    part.trim()
  );
}

function isExactCipherChunk(
  expression,
  cipher,
  method,
  assignments,
  seen,
  argumentMatches = () => true,
) {
  const value = unwrappedValue(expression);
  const argumentsList = exactCallArguments(value, cipher, method);
  if (
    argumentsList &&
    (method !== "update" || argumentMatches(argumentsList[0] ?? ""))
  ) {
    return true;
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return isExactCipherChunk(
    assignments.get(value),
    cipher,
    method,
    assignments,
    seen,
    argumentMatches,
  );
}

function isCiphertextFrom(
  expression,
  cipher,
  assignments,
  seen = new Set(),
  updateArgumentMatches = () => true,
) {
  const value = unwrappedValue(expression);
  if (/^[A-Za-z_$][\w$]*$/.test(value) && assignments.has(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return isCiphertextFrom(
      assignments.get(value),
      cipher,
      assignments,
      seen,
      updateArgumentMatches,
    );
  }
  const parts = bufferConcatParts(value);
  if (!parts || parts.length < 2) return false;
  const isUpdate = (part) =>
    isExactCipherChunk(
      part,
      cipher,
      "update",
      assignments,
      new Set(seen),
      updateArgumentMatches,
    );
  const isFinal = (part) =>
    isExactCipherChunk(part, cipher, "final", assignments, new Set(seen));
  return (
    parts.every((part) => isUpdate(part) || isFinal(part)) &&
    parts.some(isUpdate) &&
    parts.some(isFinal)
  );
}

function isAuthenticationTagFrom(expression, cipher, assignments, seen = new Set()) {
  const value = unwrappedValue(expression);
  if (exactCall(value, cipher, "getAuthTag")) {
    return true;
  }
  const buffer = /^Buffer\s*\.\s*from\s*\(([\s\S]*)\)$/.exec(value);
  if (buffer) {
    const [input] = splitArguments(buffer[1]);
    return Boolean(
      input &&
        isAuthenticationTagFrom(input, cipher, assignments, seen),
    );
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return isAuthenticationTagFrom(assignments.get(value), cipher, assignments, seen);
}

function parameterHasType(unit, name, types) {
  return new RegExp(
    `\\b${escapeExpression(name)}\\s*\\??\\s*:\\s*(?:${[...types]
      .map(escapeExpression)
      .join("|")})\\b`,
  ).test(unit.parameterSource ?? "");
}

function storageClientKinds(app) {
  return {
    blob: new Set([
      ...aliasesFor(app.imports, "@azure/storage-blob", "BlobClient"),
      ...aliasesFor(app.imports, "@azure/storage-blob", "BlockBlobClient"),
    ]),
    container: aliasesFor(
      app.imports,
      "@azure/storage-blob",
      "ContainerClient",
    ),
    service: aliasesFor(
      app.imports,
      "@azure/storage-blob",
      "BlobServiceClient",
    ),
  };
}

function realContainerExpression(app, unit, expression, seen = new Set()) {
  const value = expression.trim().replace(/^\(+|\)+$/g, "");
  const kinds = storageClientKinds(app);
  if (seen.has(value)) return false;
  seen.add(value);
  if (value.startsWith("this.") && unit.className) {
    const property = value.slice(5);
    const type = app.classes.get(unit.className)?.properties.get(property);
    return Boolean(type && kinds.container.has(type));
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    if (parameterHasType(unit, value, kinds.container)) return true;
    const assignment = assignmentsIn(unit.body).get(value);
    if (assignment) {
      const match = /^([\s\S]+)\.\s*getContainerClient\s*\(/.exec(
        assignment.trim().replace(/^await\s+/, ""),
      );
      if (match && realBlobServiceExpression(app, unit, match[1], seen)) {
        return true;
      }
      return realContainerExpression(app, unit, assignment, seen);
    }
  }
  return false;
}

function realBlobServiceExpression(app, unit, expression, seen = new Set()) {
  const value = expression.trim().replace(/^\(+|\)+$/g, "");
  const kinds = storageClientKinds(app);
  if (seen.has(`service:${value}`)) return false;
  seen.add(`service:${value}`);
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    const assignment = assignmentsIn(unit.body).get(value);
    if (assignment) {
      if (constructorArguments(assignment, kinds.service)) return true;
      const factory = /^([A-Za-z_$][\w$]*)\s*\(/.exec(
        assignment.trim().replace(/^await\s+/, ""),
      );
      const helper = factory && [...app.units.values()].find(
        (candidate) =>
          candidate.kind === "function" && candidate.name === factory[1],
      );
      return Boolean(helper && constructorArguments(helper.body, kinds.service));
    }
  }
  return Boolean(constructorArguments(value, kinds.service));
}

function realBlobExpression(app, unit, expression, seen = new Set()) {
  const value = expression.trim().replace(/^\(+|\)+$/g, "");
  const kinds = storageClientKinds(app);
  if (seen.has(`blob:${value}`)) return false;
  seen.add(`blob:${value}`);
  if (value.startsWith("this.") && unit.className) {
    const type = app.classes.get(unit.className)?.properties.get(value.slice(5));
    if (type && kinds.blob.has(type)) return true;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    if (parameterHasType(unit, value, kinds.blob)) return true;
    const assignment = assignmentsIn(unit.body).get(value);
    if (assignment) {
      const match = /^([\s\S]+)\.\s*get(?:Block)?BlobClient\s*\(/.exec(
        assignment.trim().replace(/^await\s+/, ""),
      );
      if (match && realContainerExpression(app, unit, match[1], seen)) {
        return true;
      }
      return realBlobExpression(app, unit, assignment, seen);
    }
  }
  const match = /^([\s\S]+)\.\s*get(?:Block)?BlobClient\s*\(/.exec(value);
  return Boolean(match && realContainerExpression(app, unit, match[1], seen));
}

function functionNamed(app, name) {
  const matches = [...app.units.values()].filter(
    (unit) => unit.kind === "function" && unit.name === name,
  );
  return matches.length === 1 ? matches[0] : null;
}

function returnedObjectProperty(unit, property) {
  for (const match of unit.body.matchAll(/\breturn\s+([\s\S]*?);/g)) {
    const expression = match[1].trim();
    if (!expression.startsWith("{")) continue;
    const close = matchingDelimiter(maskLiterals(expression), 0);
    if (close < 0) continue;
    const value = objectProperties(expression.slice(1, close)).get(property);
    if (value !== undefined) return { index: match.index, value };
  }
  return null;
}

function destructuredFactoryValue(app, unit, name, position) {
  const syntax = maskLiterals(unit.body);
  const declarations = /\b(?:const|let|var)\s*\{([^}]*)\}\s*(?::\s*[^=;\n]+)?=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  let result = null;
  for (const match of syntax.matchAll(declarations)) {
    if (match.index >= position) continue;
    for (const member of match[1].split(",")) {
      const [property, local = property] = member.trim().split(/\s*:\s*/);
      if (local.trim() !== name) continue;
      const factory = functionNamed(app, match[2]);
      if (!factory) return null;
      const returned = returnedObjectProperty(factory, property.trim());
      if (!returned) return null;
      result = { factory, returned };
    }
  }
  return result;
}

function factoryMemberValue(app, unit, expression, position) {
  const member = /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(
    expression.trim(),
  );
  if (!member) return null;
  const assignment = assignmentsBefore(unit.body, position).get(member[1]);
  const factoryCall = assignment &&
    /^([A-Za-z_$][\w$]*)\s*\(/.exec(assignment.trim().replace(/^await\s+/, ""));
  const factory = factoryCall && functionNamed(app, factoryCall[1]);
  const returned = factory && returnedObjectProperty(factory, member[2]);
  return returned ? { factory, returned } : null;
}

function strictContainerValue(
  app,
  unit,
  expression,
  position = Number.POSITIVE_INFINITY,
  seen = new Set(),
) {
  const value = expression
    .trim()
    .replace(/^await\s+/, "")
    .replace(/\s+as\s+[\s\S]+$/, "")
    .trim();
  const identity = `${unit.key}:${value}`;
  if (!value || seen.has(identity)) return false;
  seen.add(identity);

  const directContainer = /^([\s\S]+)\.\s*getContainerClient\s*\(/.exec(value);
  if (directContainer) {
    return realBlobServiceExpression(app, unit, directContainer[1], new Set());
  }
  const memberValue = factoryMemberValue(app, unit, value, position);
  if (memberValue) {
    return strictContainerValue(
      app,
      memberValue.factory,
      memberValue.returned.value,
      memberValue.returned.index,
      seen,
    );
  }

  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    const assignment = assignmentsBefore(unit.body, position).get(value);
    if (assignment !== undefined) {
      return strictContainerValue(app, unit, assignment, position, seen);
    }
    const factoryValue = destructuredFactoryValue(app, unit, value, position);
    if (factoryValue) {
      return strictContainerValue(
        app,
        factoryValue.factory,
        factoryValue.returned.value,
        factoryValue.returned.index,
        seen,
      );
    }
    return parameterHasType(unit, value, storageClientKinds(app).container);
  }

  const factoryCall = /^([A-Za-z_$][\w$]*)\s*\(/.exec(value);
  const factory = factoryCall && functionNamed(app, factoryCall[1]);
  if (!factory) return false;
  for (const match of factory.body.matchAll(/\breturn\s+([\s\S]*?);/g)) {
    if (
      strictContainerValue(
        app,
        factory,
        match[1],
        match.index,
        new Set(seen),
      )
    ) {
      return true;
    }
  }
  return false;
}

function classAliases(app, className) {
  return new Set([
    className,
    ...[...app.imports.bindings.entries()]
      .filter(([, binding]) => binding.imported === className)
      .map(([local]) => local),
  ]);
}

function constructedClassArguments(
  app,
  unit,
  receiver,
  className,
  position,
  seen = new Set(),
) {
  const value = receiver.trim();
  const identity = `${unit.key}:${value}`;
  if (!value || seen.has(identity)) return null;
  seen.add(identity);

  const isIdentifier = /^[A-Za-z_$][\w$]*$/.test(value);
  const expression = isIdentifier
    ? assignmentsBefore(unit.body, position).get(value)
    : value;
  if (!expression) return null;
  const argumentsList = constructorArguments(expression, classAliases(app, className));
  if (argumentsList) return { arguments: argumentsList, position, unit };

  if (/^[A-Za-z_$][\w$]*$/.test(expression.trim())) {
    return constructedClassArguments(
      app,
      unit,
      expression,
      className,
      position,
      seen,
    );
  }

  const factoryCall = /^([A-Za-z_$][\w$]*)\s*\(/.exec(
    expression.trim().replace(/^await\s+/, ""),
  );
  const factory = factoryCall && functionNamed(app, factoryCall[1]);
  if (!factory) return null;
  for (const match of factory.body.matchAll(/\breturn\s+([\s\S]*?);/g)) {
    const returned = constructorArguments(
      match[1],
      classAliases(app, className),
    );
    if (returned) {
      return { arguments: returned, position: match.index, unit: factory };
    }
  }
  return isIdentifier ? { invalid: true } : null;
}

function strictConstructedClassValue(
  app,
  unit,
  expression,
  position,
  className,
  seen = new Set(),
) {
  const value = expression
    .trim()
    .replace(/^await\s+/, "")
    .replace(/\s+as\s+[\s\S]+$/, "")
    .trim();
  const identity = `${unit.key}:${className}:${value}`;
  if (!value || seen.has(identity)) return false;
  seen.add(identity);

  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    const assignment = assignmentsBefore(unit.body, position).get(value);
    if (assignment !== undefined) {
      return strictConstructedClassValue(
        app,
        unit,
        assignment,
        position,
        className,
        seen,
      );
    }
    const factoryValue = destructuredFactoryValue(app, unit, value, position);
    if (factoryValue) {
      return strictConstructedClassValue(
        app,
        factoryValue.factory,
        factoryValue.returned.value,
        factoryValue.returned.index,
        className,
        seen,
      );
    }
    return parameterHasType(unit, value, classAliases(app, className));
  }

  if (constructorArguments(value, classAliases(app, className))) return true;
  const factoryCall = /^([A-Za-z_$][\w$]*)\s*\(/.exec(value);
  const factory = factoryCall && functionNamed(app, factoryCall[1]);
  if (!factory) return false;
  for (const match of factory.body.matchAll(/\breturn\s+([\s\S]*?);/g)) {
    if (
      strictConstructedClassValue(
        app,
        factory,
        match[1],
        match.index,
        className,
        new Set(seen),
      )
    ) {
      return true;
    }
  }
  return false;
}

function eventUsesRealSdkClients(app, event) {
  const target = event.target;
  if (!target?.className) return true;
  const constructor = app.units.get(`${target.className}.constructor`);
  const details = app.classes.get(target.className);
  if (!constructor || !details) return true;
  const containerTypes = storageClientKinds(app).container;
  const containerProperty = [...details.properties.entries()].find(([, type]) =>
    containerTypes.has(type),
  )?.[0];
  if (!containerProperty) return true;
  const index = constructor.parameters.indexOf(containerProperty);
  if (index < 0) return true;

  const receiver = event.call.callee.split(".").slice(0, -1).join(".");
  const construction = constructedClassArguments(
    app,
    event.unit,
    receiver,
    target.className,
    event.call.index,
  );
  if (!construction) return true;
  if (construction.invalid) return false;
  const container = construction.arguments[index];
  if (
    !container ||
    !strictContainerValue(
      app,
      construction.unit,
      container,
      construction.position,
    )
  ) {
    return false;
  }

  const keyManagerClasses = new Set(
    [
      ...cryptoContracts(app, new Set(app.units.keys()), "wrapKey"),
      ...cryptoContracts(app, new Set(app.units.keys()), "unwrapKey"),
    ]
      .map((contract) => contract.unit.className)
      .filter(Boolean),
  );
  for (const [property, type] of details.properties) {
    const propertyClass = importedClassName(app, type) ?? type;
    if (!keyManagerClasses.has(propertyClass)) continue;
    const propertyIndex = constructor.parameters.indexOf(property);
    const dependency = construction.arguments[propertyIndex];
    if (
      propertyIndex < 0 ||
      !dependency ||
      !strictConstructedClassValue(
        app,
        construction.unit,
        dependency,
        construction.position,
        propertyClass,
      )
    ) {
      return false;
    }
  }
  return true;
}

function receiverBeforeCall(source, call) {
  const statementStart = Math.max(
    source.lastIndexOf(";", call.index - 1),
    source.lastIndexOf("{", call.index - 1),
    source.lastIndexOf("}", call.index - 1),
  ) + 1;
  const prefix = source.slice(statementStart, call.index);
  const match = /([\s\S]*?)\.\s*$/.exec(prefix);
  return match?.[1]
    .trim()
    .replace(/^(?:const|let|var)\s+\w+(?:\s*:[^=;]+)?\s*=\s*/, "")
    .replace(/^(?:await|return)\s+/, "") ?? "";
}

function isRealBlobOperation(app, unit, call) {
  const parts = call.callee.split(".");
  const receiver = parts.length > 1
    ? parts.slice(0, -1).join(".")
    : receiverBeforeCall(unit.body, call);
  return realBlobExpression(app, unit, receiver);
}

function encryptionEvidence(app, unit) {
  const { imports, constants } = app;
  const source = unit.body;
  const assignments = assignmentsIn(source);
  const randomBytes = cryptoCallNames(imports, "randomBytes", source);
  const keys = new Set();
  const initializationVectors = new Set();
  const keyOrigins = [];
  const initializationVectorOrigins = [];
  for (const call of callsIn(source)) {
    if (!randomBytes.has(call.callee)) continue;
    const targets = resolvesToNumber(call.arguments[0] ?? "", 32, constants)
      ? keys
      : resolvesToNumber(call.arguments[0] ?? "", 12, constants)
        ? initializationVectors
        : null;
    if (!targets) continue;
    for (const value of boundValues(source, call)) targets.add(value);
    if (targets === keys) keyOrigins.push(call);
    else initializationVectorOrigins.push(call);
  }
  for (const contract of cryptoContracts(
    app,
    new Set(app.units.keys()),
    "wrapKey",
  )) {
    if (contract.inputProperties.size === 0) continue;
    for (const call of callsIn(source)) {
      if (
        call.callee.split(".").at(-1) !== contract.unit.name ||
        !callTargetsContract(app, unit, call, contract)
      ) {
        continue;
      }
      for (const output of boundValues(source, call)) {
        for (const property of contract.inputProperties) {
          keys.add(`${output}.${property}`);
        }
      }
      keyOrigins.push(call);
    }
  }

  const evidence = [];
  const cipherNames = cryptoCallNames(imports, "createCipheriv", source);
  for (const cipherCall of callsIn(source)) {
    if (
      !cipherNames.has(cipherCall.callee) ||
      !resolvesToAlgorithm(cipherCall.arguments[0] ?? "", "aes-256-gcm", constants) ||
      !derivesFrom(cipherCall.arguments[1] ?? "", keys, assignments) ||
      !derivesFrom(cipherCall.arguments[2] ?? "", initializationVectors, assignments)
    ) {
      continue;
    }
    for (const cipher of boundValues(source, cipherCall)) {
      for (const upload of callsIn(source).filter(
        (call) =>
          call.callee.split(".").at(-1) === "uploadData" &&
          isRealBlobOperation(app, unit, call) &&
          isCiphertextFrom(call.arguments[0] ?? "", cipher, assignments),
      )) {
        for (const metadata of metadataObjectsIn(upload.arguments[1] ?? "", assignments)) {
          evidence.push({
            cipher,
            cipherCall,
            initializationVectorOrigins,
            initializationVectors,
            keyOrigins,
            keys,
            metadata,
            upload,
          });
        }
      }
    }
  }
  return evidence;
}

function constructorArguments(expression, aliases) {
  const syntax = maskLiterals(expression);
  for (const alias of aliases) {
    const match = new RegExp(`\\bnew\\s+${escapeExpression(alias)}\\s*\\(`).exec(syntax);
    if (!match) continue;
    const open = match.index + match[0].lastIndexOf("(");
    const close = matchingDelimiter(syntax, open, "(", ")");
    if (close >= 0) return splitArguments(expression.slice(open + 1, close));
  }
  return null;
}

function propertyAssignment(source, property) {
  const syntax = maskLiterals(source);
  const match = new RegExp(
    `\\b${escapeExpression(property)}\\s*=\\s*`,
  ).exec(syntax);
  return match
    ? assignmentExpression(source, match.index + match[0].length)
    : null;
}

function cryptographyBinding(
  app,
  unit,
  receiver,
  aliases,
  call = null,
  seen = new Set(),
) {
  const assignments = assignmentsBefore(
    unit.body,
    call?.index ?? Number.POSITIVE_INFINITY,
  );
  let expression = assignments.get(receiver);
  if (!expression && receiver.startsWith("this.")) {
    expression = propertyAssignment(
      app.units.get(`${unit.className}.constructor`)?.rawBody ?? "",
      receiver,
    );
  }
  if (!expression && call) expression = receiverBeforeCall(unit.body, call);
  if (!expression) return null;

  const direct = constructorArguments(expression, aliases);
  if (direct) return { keyId: direct[0] ?? "", parameters: [] };

  const invocation = /^(?:(this)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/.exec(
    expression.trim().replace(/^await\s+/, ""),
  );
  const helperName = invocation?.[2];
  if (!helperName || seen.has(helperName)) return null;
  const helper = invocation[1] && unit.className
    ? app.units.get(`${unit.className}.${helperName}`)
    : [...app.units.values()].find(
        (candidate) =>
          candidate.kind === "function" && candidate.name === helperName,
      );
  if (!helper) return null;
  const helperConstructor = constructorArguments(helper.body, aliases);
  if (!helperConstructor) return null;
  const callOpen = expression.indexOf("(", invocation.index);
  const invocationArguments = splitArguments(
    expression.slice(callOpen + 1, matchingDelimiter(maskLiterals(expression), callOpen, "(", ")")),
  );
  const helperKeyId = helperConstructor[0] ?? "";
  const parameterIndex = helper.parameters.findIndex((parameter) =>
    referencesName(helperKeyId, parameter),
  );
  if (parameterIndex < 0) return null;
  const parameter = helper.parameters[parameterIndex];
  const argument = invocationArguments[parameterIndex] ?? "";
  const receivesKeyObject = new RegExp(
    `^${escapeExpression(parameter)}\\s*(?:\\.|\\?\\.)\\s*id$`,
  ).test(unwrappedValue(helperKeyId));
  return {
    keyId: receivesKeyObject ? `${argument}.id` : argument,
    parameters: [parameter],
  };
}

function keyClientReceivers(app, unit) {
  const aliases = aliasesFor(app.imports, "@azure/keyvault-keys", "KeyClient");
  const candidates = new Set(clientVariables(
    sourceFor(app.units, app.units.keys()),
    aliases,
  ));
  if (unit.className) {
    for (const [property, type] of app.classes.get(unit.className)?.properties ??
      []) {
      if (aliases.has(type)) candidates.add(`this.${property}`);
    }
  }
  const constructor = app.units.get(`${unit.className}.constructor`);
  if (constructor) {
    for (const receiver of candidates) {
      if (receiver.startsWith("this.")) continue;
      if (new RegExp(
        `\\b${escapeExpression(receiver)}\\s*=`,
      ).test(maskLiterals(constructor.body))) {
        candidates.add(`this.${receiver}`);
      }
    }
  }
  return candidates;
}

function keyIdSources(app, unit) {
  const aliases = aliasesFor(app.imports, "@azure/keyvault-keys", "KeyClient");
  const keyClients = keyClientReceivers(app, unit);
  const assignments = assignmentsIn(unit.body);
  const objects = new Set();
  const ids = new Set();
  for (const call of callsIn(unit.body)) {
    if (
      call.callee.split(".").at(-1) !== "getKey" ||
      !(
        keyClients.has(call.callee.split(".").slice(0, -1).join(".")) ||
        constructorArguments(receiverBeforeCall(unit.body, call), aliases)
      )
    ) {
      continue;
    }
    const bindings = destructuredBindings(unit.body, call);
    if (bindings.size > 0) {
      for (const [property, local] of bindings) {
        if (property === "id") ids.add(local);
      }
      continue;
    }
    for (const value of boundValues(unit.body, call)) objects.add(value);
  }
  return {
    assignments,
    ids,
    objects,
  };
}

function keyIdSourcesMutated(unit, sources) {
  const syntax = maskLiterals(unit.body);
  for (const name of sources.objects) {
    if (
      new RegExp(
        `(?<![\\w$.])${escapeExpression(name)}\\s*(?:\\.|\\?\\.)\\s*id\\s*=(?!=|>)`,
      ).test(syntax)
    ) {
      return true;
    }
  }
  for (const name of sources.ids) {
    if (
      new RegExp(
        `(?<![\\w$.])${escapeExpression(name)}\\s*=(?!=|>)`,
      ).test(syntax)
    ) {
      return true;
    }
  }
  return false;
}

function unwrappedValue(expression) {
  let value = expression.trim().replace(/^await\s+/, "").trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    const close = matchingDelimiter(maskLiterals(value), 0, "(", ")");
    if (close !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/!\s*$/, "").trim();
  return value.replace(
    /\s+as\s+(?:const|[A-Za-z_$][\w$]*(?:\s*<[^>]+>)?(?:\s*\[\])?)\s*$/,
    "",
  ).trim();
}

function derivesFromKeyObject(value, sources, ignored, seen) {
  if (sources.objects.has(value)) return true;
  if (
    ignored.has(value) ||
    seen.has(value) ||
    !sources.assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return derivesFromKeyObject(
    unwrappedValue(sources.assignments.get(value)),
    sources,
    ignored,
    seen,
  );
}

function derivesFromKeyId(expression, sources, ignored = new Set(), seen = new Set()) {
  const value = unwrappedValue(expression);
  if (sources.ids.has(value)) return true;

  const property = /^([A-Za-z_$][\w$]*)\s*(?:\.|\?\.)\s*id$/.exec(value);
  if (
    property &&
    derivesFromKeyObject(property[1], sources, ignored, new Set(seen))
  ) {
    return true;
  }

  const converted = stringConversionArgument(value);
  if (converted) {
    return derivesFromKeyId(converted, sources, ignored, seen);
  }

  if (
    /^[A-Za-z_$][\w$]*$/.test(value) &&
    !ignored.has(value) &&
    !seen.has(value) &&
    sources.assignments.has(value)
  ) {
    seen.add(value);
    return derivesFromKeyId(
      sources.assignments.get(value),
      sources,
      ignored,
      seen,
    );
  }
  return false;
}

function derivesFromParameter(
  expression,
  parameters,
  assignments,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  if (parameters.has(value)) return true;
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return derivesFromParameter(assignments.get(value), parameters, assignments, seen);
}

function stringConversionArgument(value) {
  const stringCall = /^String\s*\(([\s\S]*)\)$/.exec(value);
  if (stringCall) return stringCall[1];
  const toString = /^([\s\S]+)\.\s*toString\s*\(\s*\)$/.exec(value);
  return toString?.[1] ?? null;
}

function derivesExactValue(
  expression,
  values,
  assignments,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  if (values.has(value)) return true;
  const converted = stringConversionArgument(value);
  if (converted) {
    return derivesExactValue(converted, values, assignments, seen);
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return derivesExactValue(assignments.get(value), values, assignments, seen);
}

function derivesExactReturnedProperty(
  expression,
  outputs,
  properties,
  assignments,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  for (const output of outputs) {
    for (const property of properties) {
      if (
        new RegExp(
          `^${escapeExpression(output)}\\s*(?:\\.|\\?\\.)\\s*${escapeExpression(property)}$`,
        ).test(value)
      ) {
        return true;
      }
    }
  }
  for (const property of properties) {
    const alias = new RegExp(
      `^([A-Za-z_$][\\w$]*)\\s*(?:\\.|\\?\\.)\\s*${escapeExpression(property)}$`,
    ).exec(value);
    if (alias && derivesExactValue(alias[1], outputs, assignments)) {
      return true;
    }
  }
  const converted = stringConversionArgument(value);
  if (converted) {
    return derivesExactReturnedProperty(
      converted,
      outputs,
      properties,
      assignments,
      seen,
    );
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return derivesExactReturnedProperty(
    assignments.get(value),
    outputs,
    properties,
    assignments,
    seen,
  );
}

function derivesExactOperationValue(
  expression,
  results,
  assignments,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  if (
    results.has(value) ||
    [...results].some((name) =>
      new RegExp(
        `^${escapeExpression(name)}\\s*(?:\\.|\\?\\.)\\s*result$`,
      ).test(value)
    )
  ) {
    return true;
  }
  const buffer = /^Buffer\s*\.\s*from\s*\(([\s\S]*)\)$/.exec(value);
  if (buffer) {
    const [input] = splitArguments(buffer[1]);
    return Boolean(
      input &&
        derivesExactOperationValue(input, results, assignments, seen),
    );
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return derivesExactOperationValue(
    assignments.get(value),
    results,
    assignments,
    seen,
  );
}

function derivesExactBufferValue(
  expression,
  values,
  assignments,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  if (values.has(value)) return true;
  const buffer = /^Buffer\s*\.\s*from\s*\(([\s\S]*)\)$/.exec(value);
  if (buffer) {
    const [input] = splitArguments(buffer[1]);
    return Boolean(
      input &&
        derivesExactBufferValue(input, values, assignments, seen),
    );
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return derivesExactBufferValue(
    assignments.get(value),
    values,
    assignments,
    seen,
  );
}

function derivesExactReturnedBufferProperty(
  expression,
  outputs,
  properties,
  assignments,
  seen = new Set(),
) {
  if (
    derivesExactReturnedProperty(
      expression,
      outputs,
      properties,
      assignments,
      new Set(seen),
    )
  ) {
    return true;
  }
  const value = unwrappedValue(expression);
  const buffer = /^Buffer\s*\.\s*from\s*\(([\s\S]*)\)$/.exec(value);
  if (!buffer) return false;
  const [input] = splitArguments(buffer[1]);
  return Boolean(
    input &&
      derivesExactReturnedBufferProperty(
        input,
        outputs,
        properties,
        assignments,
        seen,
      ),
  );
}

function resultSurvivesUntil(unit, call, name, position) {
  const syntax = maskLiterals(unit.body);
  const overwrite = new RegExp(
    `(?<![\\w$.])${escapeExpression(name)}(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)?\\s*=(?!=|>)`,
    "g",
  );
  for (const match of syntax.matchAll(overwrite)) {
    if (call.close < match.index && match.index < position) return false;
  }
  return true;
}

function returnedResultValues(unit, call, values) {
  const properties = new Set();
  let direct = false;
  for (const match of unit.body.matchAll(/\breturn\s+([\s\S]*?);/g)) {
    const origins = new Set(
      [...values].filter((name) =>
        resultSurvivesUntil(unit, call, name, match.index),
      ),
    );
    if (origins.size === 0) continue;
    const assignments = assignmentsBefore(unit.body, match.index);
    const expression = match[1].trim();
    if (!expression.startsWith("{")) {
      direct ||= derivesExactOperationValue(expression, origins, assignments);
      continue;
    }
    const syntax = maskLiterals(expression);
    const close = matchingDelimiter(syntax, 0);
    if (close < 0) continue;
    for (const [name, value] of objectProperties(expression.slice(1, close))) {
      if (derivesExactOperationValue(value, origins, assignments)) {
        properties.add(name);
      }
    }
  }
  return { direct, properties };
}

function cryptoContracts(app, keys, operation) {
  const aliases = aliasesFor(app.imports, "@azure/keyvault-keys", "CryptographyClient");
  const contracts = [];

  for (const key of keys) {
    const unit = app.units.get(key);
    if (!unit) continue;
    const keySources = keyIdSources(app, unit);
    if (keyIdSourcesMutated(unit, keySources)) continue;
    const flow = flowContexts(unit);
    for (const call of callsIn(unit.body)) {
      const receiver = call.callee.split(".").slice(0, -1).join(".");
      const binding = cryptographyBinding(app, unit, receiver, aliases, call);
      if (
        !flow.at(call.index).reachable ||
        call.callee.split(".").at(-1) !== operation ||
        !binding ||
        !resolvesToRsaOaepAlgorithm(call.arguments[0] ?? "", app.constants)
      ) {
        continue;
      }
      const results = boundValues(unit.body, call);
      const returned = returnedResultValues(unit, call, results);
      const returnedProperties = new Map();
      for (const match of unit.body.matchAll(/\breturn\s+([\s\S]*?);/g)) {
        const expression = match[1].trim();
        if (!expression.startsWith("{")) continue;
        const close = matchingDelimiter(maskLiterals(expression), 0);
        if (close < 0) continue;
        for (const [name, value] of objectProperties(expression.slice(1, close))) {
          returnedProperties.set(name, value);
        }
      }
      const keyIdProperties = new Set(
        [...returnedProperties]
          .filter(([, value]) => derivesFromKeyId(value, keySources, results))
          .map(([name]) => name),
      );
      const localDataKeys = new Set();
      for (const candidate of callsIn(unit.body)) {
        if (
          cryptoCallNames(app.imports, "randomBytes", unit.body).has(
            candidate.callee,
          ) &&
          resolvesToNumber(
            candidate.arguments[0] ?? "",
            32,
            app.constants,
          )
        ) {
          for (const value of boundValues(unit.body, candidate)) {
            localDataKeys.add(value);
          }
        }
      }
      const inputProperties = new Set(
        [...returnedProperties]
          .filter(([, value]) =>
            derivesExactBufferValue(
              value,
              new Set([
                ...unit.parameters.filter((parameter) =>
                  referencesName(call.arguments[1] ?? "", parameter)
                ),
                ...localDataKeys,
              ]),
              assignmentsBefore(unit.body, call.index),
            )
          )
          .map(([name]) => name),
      );
      const inputIsConnected =
        unit.parameters.some((parameter) =>
          referencesName(call.arguments[1] ?? "", parameter)
        ) ||
        derivesExactBufferValue(
          call.arguments[1] ?? "",
          localDataKeys,
          assignmentsBefore(unit.body, call.index),
        );
      const resultProperties = new Set(returned.properties);
      const constructorBound =
        operation === "wrapKey"
          ? derivesFromKeyId(binding.keyId, keySources)
          : derivesFromParameter(
            binding.keyId,
            new Set(unit.parameters),
            assignmentsBefore(unit.body, call.index),
          );
      const returnsOperationResult =
        returned.direct || resultProperties.size > 0;
      const returnsKeyId =
        operation !== "wrapKey" || keyIdProperties.size > 0;
      if (
        !constructorBound ||
        !inputIsConnected ||
        !returnsOperationResult ||
        !returnsKeyId
      ) {
        continue;
      }
      contracts.push({
        call,
        inputProperties,
        keyIdProperties,
        key,
        keyIdParameters: unit.parameters.filter((parameter) =>
          referencesName(binding.keyId, parameter),
        ),
        resultProperties,
        returned,
        results,
        unit,
      });
    }
  }
  return contracts;
}

function receiverClass(
  app,
  unit,
  receiver,
  position = Number.POSITIVE_INFINITY,
  seen = new Set(),
) {
  const value = receiver.trim();
  if (seen.has(value)) return null;
  seen.add(value);
  if (value.startsWith("this.") && unit.className) {
    return app.classes.get(unit.className)?.properties.get(value.slice(5).split(".")[0]) ?? null;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    const typed = new RegExp(
      `\\b${escapeExpression(value)}\\s*\\??\\s*:\\s*([A-Za-z_$][\\w$]*)\\b`,
    ).exec(unit.parameterSource ?? "");
    if (typed) return typed[1];
    const expression = assignmentsBefore(unit.body, position).get(value);
    const constructed = expression && /\bnew\s+([A-Za-z_$][\w$]*)\s*\(/.exec(
      expression,
    );
    if (constructed) return constructed[1];
    const factoryCall = expression && /^([A-Za-z_$][\w$]*)\s*\(/.exec(
      expression.trim().replace(/^await\s+/, ""),
    );
    const factory = factoryCall && functionNamed(app, factoryCall[1]);
    const returned = factory && returnClasses(factory);
    if (returned?.size === 1) return [...returned][0];
    if (expression && /^[A-Za-z_$][\w$]*$/.test(expression.trim())) {
      return receiverClass(app, unit, expression, position, seen);
    }
  }
  return null;
}

function callTargetsContract(app, caller, call, contract) {
  if (!contract.unit.className) return true;
  const receiver = call.callee.split(".").slice(0, -1).join(".");
  return receiverClass(app, caller, receiver, call.index) === contract.unit.className;
}

function operationLinks(app, caller, contract, inputMatches, keyIdMatches = () => true) {
  if (caller.key === contract.key) {
    return inputMatches(contract.call.arguments[1] ?? "") && keyIdMatches(contract.unit.body)
      ? [{
          keyIds: new Set(),
          keyIdProperties: contract.keyIdProperties,
          objectOutputs: new Set(),
          outputs: contract.results,
          resultProperties: contract.resultProperties,
        }]
      : [];
  }

  const links = [];
  for (const call of callsIn(caller.body)) {
    if (
      call.callee.split(".").at(-1) !== contract.unit.name ||
      !callTargetsContract(app, caller, call, contract)
    ) {
      continue;
    }
    const wrappedParameter = contract.unit.parameters.findIndex((parameter) =>
      referencesName(contract.call.arguments[1] ?? "", parameter)
    );
    const bindings = destructuredBindings(caller.body, call);
    const objectOutputs = !contract.returned.direct && bindings.size === 0
      ? boundValues(caller.body, call)
      : new Set();
    const inputConnected = wrappedParameter >= 0
      ? inputMatches(call.arguments[wrappedParameter] ?? "")
      : [...bindings].some(
          ([property, local]) =>
            contract.inputProperties.has(property) && inputMatches(local),
        ) ||
        [...objectOutputs].some((output) =>
          [...contract.inputProperties].some((property) =>
            inputMatches(`${output}.${property}`)
          )
        );
    if (!inputConnected) continue;

    const keyIdParameters = contract.keyIdParameters
      .map((parameter) => contract.unit.parameters.indexOf(parameter))
      .filter((index) => index >= 0);
    if (keyIdParameters.some((index) => !keyIdMatches(call.arguments[index] ?? ""))) {
      continue;
    }
    const outputs = contract.returned.direct
      ? boundValues(caller.body, call)
      : new Set(
        [...bindings]
          .filter(([property]) => contract.returned.properties.has(property))
          .map(([, local]) => local),
      );
    if (outputs.size === 0 && objectOutputs.size === 0) continue;
    links.push({
      keyIds: new Set(
        [...bindings]
          .filter(([property]) => contract.keyIdProperties.has(property))
          .map(([, local]) => local),
      ),
      keyIdProperties: contract.keyIdProperties,
      objectOutputs,
      outputs,
      resultProperties: contract.resultProperties,
    });
  }
  return links;
}

function hasUploadProvenance(app, keys) {
  const contracts = cryptoContracts(app, keys, "wrapKey");
  for (const key of keys) {
    const unit = app.units.get(key);
    if (!unit) continue;
    const assignments = assignmentsIn(unit.body);
    for (const encryption of encryptionEvidence(app, unit)) {
      const wrappedValues = propertyValues(encryption.metadata, /(?:wrapped|encrypted)/i);
      const ivValues = propertyValues(encryption.metadata, /^(?:iv|initializationVector)$/i);
      const tagValues = propertyValues(encryption.metadata, /(?:auth(?:entication)?Tag|tag)/i);
      const keyIdValues = propertyValues(encryption.metadata, /(?:keyId|vaultKeyId)/i);
      if (
        wrappedValues.length === 0 ||
        ivValues.length === 0 ||
        tagValues.length === 0 ||
        keyIdValues.length === 0
      ) {
        continue;
      }

      for (const contract of contracts) {
        for (const link of operationLinks(
          app,
          unit,
          contract,
          (expression) =>
            derivesExactBufferValue(
              expression,
              encryption.keys,
              assignments,
            ),
        )) {
          if (
            wrappedValues.some(
              (value) =>
                encodesBase64From(
                  value,
                  app.constants,
                  assignments,
                  (input) =>
                    derivesExactBufferValue(input, link.outputs, assignments) ||
                    derivesExactReturnedBufferProperty(
                      input,
                      link.objectOutputs,
                      link.resultProperties,
                      assignments,
                    ),
                ),
            ) &&
            ivValues.some(
              (value) =>
                encodesBase64From(
                  value,
                  app.constants,
                  assignments,
                  (input) =>
                    derivesExactBufferValue(
                      input,
                      encryption.initializationVectors,
                      assignments,
                    ),
                ),
            ) &&
            tagValues.some(
              (value) =>
                encodesBase64From(
                  value,
                  app.constants,
                  assignments,
                  (input) =>
                    isAuthenticationTagFrom(
                      input,
                      encryption.cipher,
                      assignments,
                    ),
                ),
            ) &&
            keyIdValues.some(
              (value) =>
                derivesExactValue(value, link.keyIds, assignments) ||
                derivesExactReturnedProperty(
                  value,
                  link.objectOutputs,
                  link.keyIdProperties,
                  assignments,
                ),
            )
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function metadataVariablesForResults(unit, assignments, properties) {
  const metadata = new Set();
  for (const [name, expression] of assignments) {
    if (
      /\.\s*metadata\b/.test(expression) &&
      derivesFrom(expression, properties, assignments)
    ) {
      metadata.add(name);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, expression] of assignments) {
      const value = unwrappedValue(expression);
      if (metadata.has(value) && !metadata.has(name)) {
        metadata.add(name);
        changed = true;
      }
    }
  }
  return metadata;
}

function metadataVariables(app, unit, assignments) {
  const properties = new Set();
  for (const call of callsIn(unit.body)) {
    if (
      ["download", "getProperties"].includes(
        call.callee.split(".").at(-1),
      ) &&
      isRealBlobOperation(app, unit, call)
    ) {
      for (const value of boundValues(unit.body, call)) properties.add(value);
    }
  }
  return metadataVariablesForResults(unit, assignments, properties);
}

function metadataFieldDescriptor(
  app,
  unit,
  expression,
  metadataParameters,
  parameterDescriptors = new Map(),
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    if (parameterDescriptors.has(value)) return parameterDescriptors.get(value);
    if (metadataParameters.has(value)) return { object: true };
    const identity = `${unit.key}:${value}`;
    if (seen.has(identity)) return null;
    const assignment = assignmentsIn(unit.body).get(value);
    return assignment === undefined
      ? null
      : metadataFieldDescriptor(
          app,
          unit,
          assignment,
          metadataParameters,
          parameterDescriptors,
          new Set(seen).add(identity),
        );
  }

  const literal = /^(["'])([\s\S]*)\1$/.exec(value);
  if (literal) return { literal: literal[2] };

  const property = /^([A-Za-z_$][\w$]*)\s*(?:\.|\?\.)\s*([A-Za-z_$][\w$]*)$/.exec(
    value,
  );
  if (
    property &&
    (
      metadataParameters.has(property[1]) ||
      parameterDescriptors.get(property[1])?.object
    )
  ) {
    return { decoded: false, field: property[2] };
  }
  const indexed = /^([A-Za-z_$][\w$]*)\s*\[\s*([\s\S]+)\s*\]$/.exec(
    value,
  );
  if (
    indexed &&
    (
      metadataParameters.has(indexed[1]) ||
      parameterDescriptors.get(indexed[1])?.object
    )
  ) {
    const key = metadataFieldDescriptor(
      app,
      unit,
      indexed[2],
      metadataParameters,
      parameterDescriptors,
      seen,
    );
    return key?.literal
      ? { decoded: false, field: key.literal }
      : null;
  }

  const buffer = /^Buffer\s*\.\s*from\s*\(([\s\S]*)\)$/.exec(value);
  if (buffer) {
    const [input, encoding] = splitArguments(buffer[1]);
    const descriptor = input && metadataFieldDescriptor(
      app,
      unit,
      input,
      metadataParameters,
      parameterDescriptors,
      seen,
    );
    return descriptor &&
        encoding &&
        resolvesToAlgorithm(encoding, "base64", app.constants)
      ? { ...descriptor, decoded: true }
      : null;
  }

  const helperCall = /^([A-Za-z_$][\w$]*)\s*\(/.exec(value);
  const helper = helperCall && functionNamed(app, helperCall[1]);
  if (!helper || seen.has(helper.key)) return null;
  const open = value.indexOf("(", helperCall.index);
  const close = matchingDelimiter(maskLiterals(value), open, "(", ")");
  if (close < 0) return null;
  const argumentsList = splitArguments(value.slice(open + 1, close));
  const descriptors = new Map();
  helper.parameters.forEach((parameter, index) => {
    const descriptor = metadataFieldDescriptor(
      app,
      unit,
      argumentsList[index] ?? "",
      metadataParameters,
      parameterDescriptors,
      seen,
    );
    if (descriptor) descriptors.set(parameter, descriptor);
  });
  const returned = [...helper.body.matchAll(/\breturn\s+([\s\S]*?);/g)]
    .map((match) =>
      metadataFieldDescriptor(
        app,
        helper,
        match[1],
        new Set(),
        descriptors,
        new Set(seen).add(helper.key),
      )
    )
    .filter(Boolean);
  return returned.length > 0 &&
      returned.every(
        (descriptor) =>
          descriptor.field === returned[0].field &&
          descriptor.decoded === returned[0].decoded &&
          descriptor.literal === returned[0].literal &&
          descriptor.object === returned[0].object,
      )
    ? returned[0]
    : null;
}

function metadataParserContracts(app) {
  const contracts = [];
  for (const unit of app.units.values()) {
    if (unit.kind !== "function") continue;
    for (const metadataParameter of unit.parameters) {
      const properties = new Map();
      for (const match of unit.body.matchAll(/\breturn\s+([\s\S]*?);/g)) {
        const expression = match[1].trim();
        if (!expression.startsWith("{")) continue;
        const close = matchingDelimiter(maskLiterals(expression), 0);
        if (close < 0) continue;
        for (const [name, value] of objectProperties(
          expression.slice(1, close),
        )) {
          const descriptor = metadataFieldDescriptor(
            app,
            unit,
            value,
            new Set([metadataParameter]),
          );
          if (descriptor) properties.set(name, descriptor);
        }
      }
      if (properties.size > 0) {
        contracts.push({ metadataParameter, properties, unit });
      }
    }
  }
  return contracts;
}

function metadataParserLinks(app, unit, metadata, assignments) {
  const links = [];
  for (const contract of metadataParserContracts(app)) {
    for (const call of callsIn(unit.body)) {
      if (
        call.callee.split(".").at(-1) !== contract.unit.name ||
        !callTargetsContract(app, unit, call, contract)
      ) {
        continue;
      }
      const parameterIndex = contract.unit.parameters.indexOf(
        contract.metadataParameter,
      );
      if (
        parameterIndex < 0 ||
        !derivesExactValue(
          call.arguments[parameterIndex] ?? "",
          metadata,
          assignmentsBefore(unit.body, call.index),
        )
      ) {
        continue;
      }
      for (const output of boundValues(unit.body, call)) {
        links.push({ output, properties: contract.properties });
      }
    }
  }
  return links;
}

function parserMetadataDescriptor(
  expression,
  links,
  assignments,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  for (const link of links) {
    const property = new RegExp(
      `^${escapeExpression(link.output)}\\s*(?:\\.|\\?\\.)\\s*([A-Za-z_$][\\w$]*)$`,
    ).exec(value);
    if (property && link.properties.has(property[1])) {
      return link.properties.get(property[1]);
    }
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return null;
  }
  return parserMetadataDescriptor(
    assignments.get(value),
    links,
    assignments,
    new Set(seen).add(value),
  );
}

function decodesMetadataValue(
  expression,
  pattern,
  metadata,
  assignments,
  constants,
  parserLinks,
) {
  if (
    decodesMetadataField(
      expression,
      pattern,
      metadata,
      assignments,
      constants,
    )
  ) {
    return true;
  }
  let descriptor = parserMetadataDescriptor(
    expression,
    parserLinks,
    assignments,
  );
  if (!descriptor) {
    const value = unwrappedValue(expression);
    const buffer = /^Buffer\s*\.\s*from\s*\(([\s\S]*)\)$/.exec(value);
    if (buffer) {
      const [input, encoding] = splitArguments(buffer[1]);
      const inputDescriptor = input && parserMetadataDescriptor(
        input,
        parserLinks,
        assignments,
      );
      if (
        inputDescriptor &&
        encoding &&
        resolvesToAlgorithm(encoding, "base64", constants)
      ) {
        descriptor = { ...inputDescriptor, decoded: true };
      }
    }
  }
  return Boolean(
    descriptor?.decoded && new RegExp(pattern.source, pattern.flags).test(
      descriptor.field,
    ),
  );
}

function exactMetadataValue(
  expression,
  pattern,
  metadata,
  assignments,
  parserLinks,
) {
  if (
    derivesExactlyFromMetadataField(
      expression,
      pattern,
      metadata,
      assignments,
    )
  ) {
    return true;
  }
  const descriptor = parserMetadataDescriptor(
    expression,
    parserLinks,
    assignments,
  );
  return Boolean(
    descriptor &&
      !descriptor.decoded &&
      new RegExp(pattern.source, pattern.flags).test(descriptor.field),
  );
}

function derivesFromMetadataField(expression, pattern, metadata, assignments, seen = new Set()) {
  const value = expression.trim();
  if (
    [...metadata].some((name) =>
      new RegExp(`\\b${escapeExpression(name)}\\s*\\.\\s*${pattern.source}\\b`, pattern.flags).test(value)
    )
  ) {
    return true;
  }
  for (const name of value.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) {
    if (seen.has(name) || !assignments.has(name)) continue;
    seen.add(name);
    if (
      derivesFromMetadataField(
        assignments.get(name),
        pattern,
        metadata,
        assignments,
        seen,
      )
    ) {
      return true;
    }
  }
  return false;
}

function derivesExactlyFromMetadataField(
  expression,
  pattern,
  metadata,
  assignments,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  if (
    [...metadata].some((name) =>
      new RegExp(
        `^${escapeExpression(name)}\\s*(?:\\.|\\?\\.)\\s*${pattern.source}$`,
        pattern.flags,
      ).test(value)
    )
  ) {
    return true;
  }
  const converted = stringConversionArgument(value);
  if (converted) {
    return derivesExactlyFromMetadataField(
      converted,
      pattern,
      metadata,
      assignments,
      seen,
    );
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return derivesExactlyFromMetadataField(
    assignments.get(value),
    pattern,
    metadata,
    assignments,
    seen,
  );
}

function decodesMetadataField(
  expression,
  pattern,
  metadata,
  assignments,
  constants,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  const buffer = /^Buffer\s*\.\s*from\s*\(([\s\S]*)\)$/.exec(value);
  if (buffer) {
    const [input, encoding] = splitArguments(buffer[1]);
    return Boolean(
      input &&
        encoding &&
        resolvesToAlgorithm(encoding, "base64", constants) &&
        derivesExactlyFromMetadataField(
          input,
          pattern,
          metadata,
          assignments,
        ),
    );
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return decodesMetadataField(
    assignments.get(value),
    pattern,
    metadata,
    assignments,
    constants,
    seen,
  );
}

function derivesExactDownloadedCiphertext(
  expression,
  downloads,
  assignments,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  if (
    [...downloads].some((name) =>
      new RegExp(
        `^${escapeExpression(name)}\\s*(?:\\.|\\?\\.)\\s*(?:readableStreamBody|blobBody)$`,
      ).test(value)
    )
  ) {
    return true;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value) && assignments.has(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return derivesExactDownloadedCiphertext(
      assignments.get(value),
      downloads,
      assignments,
      seen,
    );
  }
  const calls = callsIn(value);
  const call = calls.find(
    (candidate) =>
      candidate.index === 0 &&
      candidate.close === maskLiterals(value).trimEnd().length - 1,
  );
  return Boolean(
    call &&
      call.arguments.length === 1 &&
      derivesExactDownloadedCiphertext(
        call.arguments[0],
        downloads,
        assignments,
        new Set(seen),
      ),
  );
}

function resolvesToUtf8(expression, constants, assignments, seen = new Set()) {
  const value = unwrappedValue(expression);
  const resolved = resolveExpression(value, constants);
  if (resolved !== null) {
    return ["utf8", "utf-8"].includes(resolved.toLowerCase());
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return resolvesToUtf8(assignments.get(value), constants, assignments, seen);
}

function exactDecodedOutputFrom(
  expression,
  cipher,
  assignments,
  constants,
  updateArgumentMatches,
  seen,
) {
  const value = unwrappedValue(expression);
  const stringResult = /^([\s\S]+)\.\s*toString\s*\(([\s\S]*)\)$/.exec(value);
  if (!stringResult) return false;
  const argumentsSource = stringResult[2].trim();
  const argumentsList = argumentsSource ? splitArguments(argumentsSource) : [];
  if (
    argumentsList.length > 1 ||
    (argumentsList.length === 1 &&
      !resolvesToUtf8(argumentsList[0], constants, assignments))
  ) {
    return false;
  }
  return isCiphertextFrom(
    stringResult[1],
    cipher,
    assignments,
    new Set(seen),
    updateArgumentMatches,
  );
}

function decryptedOutputFrom(
  expression,
  cipher,
  assignments,
  constants,
  updateArgumentMatches = () => true,
  seen = new Set(),
) {
  const value = unwrappedValue(expression);
  if (
    isCiphertextFrom(
      value,
      cipher,
      assignments,
      new Set(seen),
      updateArgumentMatches,
    )
  ) {
    return true;
  }
  if (
    exactDecodedOutputFrom(
      value,
      cipher,
      assignments,
      constants,
      updateArgumentMatches,
      seen,
    )
  ) {
    return true;
  }
  const converted = stringConversionArgument(value);
  if (converted) {
    return decryptedOutputFrom(
      converted,
      cipher,
      assignments,
      constants,
      updateArgumentMatches,
      new Set(seen),
    );
  }
  if (
    !/^[A-Za-z_$][\w$]*$/.test(value) ||
    seen.has(value) ||
    !assignments.has(value)
  ) {
    return false;
  }
  seen.add(value);
  return decryptedOutputFrom(
    assignments.get(value),
    cipher,
    assignments,
    constants,
    updateArgumentMatches,
    seen,
  );
}

function returnsCipherOutput(
  unit,
  cipher,
  assignments,
  constants,
  updateArgumentMatches = () => true,
) {
  for (const match of unit.body.matchAll(/\breturn\s+([\s\S]*?);/g)) {
    if (
      decryptedOutputFrom(
        match[1],
        cipher,
        assignments,
        constants,
        updateArgumentMatches,
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasDownloadProvenance(app, keys) {
  const contracts = cryptoContracts(app, keys, "unwrapKey");
  const decipherNames = cryptoCallNames(app.imports, "createDecipheriv", sourceFor(app.units, keys));

  for (const key of keys) {
    const unit = app.units.get(key);
    if (!unit) continue;
    const assignments = assignmentsIn(unit.body);
    const operationReceiver = (call) => {
      const parts = call.callee.split(".");
      const receiver = parts.length > 1
        ? parts.slice(0, -1).join(".")
        : receiverBeforeCall(unit.body, call);
      return unwrappedValue(receiver).replace(/\s+/g, "");
    };
    const downloadResults = callsIn(unit.body)
      .filter(
        (call) =>
          call.callee.split(".").at(-1) === "download" &&
          isRealBlobOperation(app, unit, call),
      )
      .flatMap((call) =>
        [...boundValues(unit.body, call)].map((result) => ({
          receiver: operationReceiver(call),
          result,
        }))
      );
    if (
      downloadResults.length === 0 ||
      !callsIn(unit.body).some(
        (call) =>
          call.callee.split(".").at(-1) === "getBlockBlobClient" &&
          realContainerExpression(
            app,
            unit,
            call.callee.split(".").slice(0, -1).join("."),
          ),
      )
    ) {
      continue;
    }

    for (const downloadResult of downloadResults) {
      const downloads = new Set([downloadResult.result]);
      const metadataProperties = new Set(downloads);
      for (const call of callsIn(unit.body)) {
        if (
          call.callee.split(".").at(-1) === "getProperties" &&
          isRealBlobOperation(app, unit, call) &&
          operationReceiver(call) === downloadResult.receiver
        ) {
          for (const value of boundValues(unit.body, call)) {
            metadataProperties.add(value);
          }
        }
      }
      const metadata = metadataVariablesForResults(
        unit,
        assignments,
        metadataProperties,
      );
      if (metadata.size === 0) continue;
      const parserLinks = metadataParserLinks(
        app,
        unit,
        metadata,
        assignments,
      );

      for (const decipherCall of callsIn(unit.body)) {
        if (
          !decipherNames.has(decipherCall.callee) ||
          !resolvesToAlgorithm(decipherCall.arguments[0] ?? "", "aes-256-gcm", app.constants) ||
          !decodesMetadataValue(
            decipherCall.arguments[2] ?? "",
            /(?:iv|initializationVector)\w*/i,
            metadata,
            assignments,
            app.constants,
            parserLinks,
          )
        ) {
          continue;
        }

        for (const decipher of boundValues(unit.body, decipherCall)) {
          const finalCall = callsIn(unit.body).find(
            (call) => call.callee === `${decipher}.final`,
          );
          const tagCall = finalCall && callsIn(unit.body)
            .filter(
              (call) =>
                call.callee === `${decipher}.setAuthTag` &&
                call.index < finalCall.index,
            )
            .at(-1);
          const hasMetadataAuthenticationTag = Boolean(
            tagCall &&
              decodesMetadataValue(
                tagCall.arguments[0] ?? "",
                /(?:auth(?:entication)?Tag|tag)\w*/i,
                metadata,
                assignments,
                app.constants,
                parserLinks,
              ),
          );
          const updatesDownloadedCiphertext = callsIn(unit.body).some(
            (call) =>
              call.callee === `${decipher}.update` &&
              derivesExactDownloadedCiphertext(
                call.arguments[0] ?? "",
                downloads,
                assignments,
              ),
          );
          if (
            !hasMetadataAuthenticationTag ||
            !finalCall ||
            !updatesDownloadedCiphertext
          ) {
            continue;
          }
          if (
            !returnsCipherOutput(
              unit,
              decipher,
              assignments,
              app.constants,
              (expression) =>
                derivesExactDownloadedCiphertext(
                  expression,
                  downloads,
                  assignments,
                ),
            )
          ) {
            continue;
          }

          for (const contract of contracts) {
            for (const link of operationLinks(
              app,
              unit,
              contract,
              (expression) =>
                decodesMetadataValue(
                  expression,
                  /(?:wrapped|encrypted)\w*/i,
                  metadata,
                  assignments,
                  app.constants,
                  parserLinks,
                ),
              (expression) =>
                exactMetadataValue(
                  expression,
                  /(?:keyId|vaultKeyId)\w*/i,
                  metadata,
                  assignments,
                  parserLinks,
                ),
            )) {
              if (
                derivesExactBufferValue(
                  decipherCall.arguments[1] ?? "",
                  link.outputs,
                  assignments,
                )
              ) {
                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

function persistsRawDataKey(source) {
  return (
    metadataObjectsIn(source, assignmentsIn(source)).some((metadata) =>
      [...metadata.keys()].some((name) =>
        /^(?:raw)?(?:dek|dataKey|dataEncryptionKey)$/i.test(name)
      )
    ) ||
    /\b(?:writeFile|writeFileSync)\s*\([^)]*\b(?:dek|dataKey)\b/i.test(source)
  );
}

function tryCatchRanges(source) {
  const syntax = maskLiterals(source);
  const blocks = [];
  for (const match of syntax.matchAll(/\btry\s*\{/g)) {
    const tryOpening = match.index + match[0].lastIndexOf("{");
    const tryClosing = matchingDelimiter(syntax, tryOpening);
    if (tryClosing < 0) continue;
    const catchMatch = syntax.slice(tryClosing + 1).match(
      /^\s*catch\s*(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\))?\s*\{/,
    );
    if (!catchMatch) continue;
    const catchOpening =
      tryClosing + 1 + catchMatch.index + catchMatch[0].lastIndexOf("{");
    const catchClosing = matchingDelimiter(syntax, catchOpening);
    if (catchClosing < 0) continue;
    blocks.push({
      catchBody: source.slice(catchOpening + 1, catchClosing),
      error: catchMatch[1] ?? null,
      tryEnd: tryClosing,
      tryStart: tryOpening + 1,
    });
  }
  return blocks;
}

function catchHandlesServiceFailure(block) {
  const code = maskLiterals(block.catchBody);
  if (!block.error) {
    return /\b(?:console\s*\.\s*(?:error|warn)|throw\s+new\s+Error)\b/.test(
      code,
    );
  }
  const error = escapeExpression(block.error);
  return (
    new RegExp(`\\bthrow\\s+${error}\\b`).test(code) ||
    new RegExp(`\\bcause\\s*:\\s*${error}\\b`).test(code) ||
    new RegExp(
      `\\bconsole\\s*\\.\\s*(?:error|warn|log|info)\\s*\\([^)]*\\b${error}\\b`,
    ).test(code) ||
    (
      /\bthrow\s+new\s+Error\s*\(/.test(code) &&
      /\b(?:blob|crypto|decrypt|encrypt|key\s+vault|upload|unwrap|wrap)\b/i.test(
        block.catchBody,
      )
    )
  );
}

function hasServiceErrorHandling(app) {
  const reachable = new Set(app.units.keys());
  const keyContracts = [
    ...cryptoContracts(app, reachable, "wrapKey"),
    ...cryptoContracts(app, reachable, "unwrapKey"),
  ];
  let handlesBlob = false;
  let handlesKeyVault = false;

  for (const key of reachable) {
    const unit = app.units.get(key);
    if (!unit) continue;
    const keyClients = keyClientReceivers(app, unit);
    const calls = callsIn(unit.body);
    for (const block of tryCatchRanges(unit.body)) {
      if (!catchHandlesServiceFailure(block)) continue;
      const withinTry = (call) =>
        block.tryStart <= call.index && call.index < block.tryEnd;
      handlesBlob ||= calls.some(
        (call) =>
          withinTry(call) &&
          ["download", "uploadData"].includes(call.callee.split(".").at(-1)) &&
          isRealBlobOperation(app, unit, call),
      );
      handlesKeyVault ||= calls.some(
        (call) =>
          withinTry(call) &&
          call.callee.split(".").at(-1) === "getKey" &&
          keyClients.has(call.callee.split(".").slice(0, -1).join(".")),
      ) || keyContracts.some(
        (contract) =>
          contract.unit.key === unit.key && withinTry(contract.call),
      );
    }
  }
  return handlesBlob && handlesKeyVault;
}

function application(workspace) {
  const documents = sourceDocuments(workspace);
  const rawSource = documents.map(({ source }) => source).join("\n");
  const source = withoutUnreachableBranches(withoutComments(rawSource));
  const imports = importedBindings(source);
  const definitions = collectUnits(source);
  const graph = buildGraph(definitions);
  const roots = [...definitions.units.values()]
    .filter(
      (unit) =>
        unit.kind === "function" &&
        ["main", "run", "demo"].includes(unit.name) &&
        new RegExp(`\\b${unit.name}\\s*\\(`).test(maskLiterals(definitions.topLevel)),
    )
    .map((unit) => unit.key);
  const rootClosure = closure(graph, roots);
  const rootSource = sourceFor(definitions.units, rootClosure);
  const constants = extractConstants(source);
  return {
    classes: definitions.classes,
    constants,
    documents,
    graph,
    imports,
    rootClosure,
    rootSource,
    roots,
    source,
    units: definitions.units,
  };
}

function hasRequiredPackages(workspace) {
  const dependencies = activeDependencies(workspace.packageJson);
  return (
    Object.hasOwn(dependencies, "@azure/identity") &&
    Object.hasOwn(dependencies, "@azure/storage-blob") &&
    Object.hasOwn(dependencies, "@azure/keyvault-keys") &&
    !Object.hasOwn(dependencies, "@azure/keyvault-secrets")
  );
}

function flowStatementRange(source, start) {
  let contentStart = start;
  while (/\s/.test(source[contentStart] ?? "")) contentStart += 1;
  if (source[contentStart] === "{") {
    const close = matchingDelimiter(source, contentStart);
    return close < 0
      ? null
      : {
          contentEnd: close,
          contentStart: contentStart + 1,
          end: close + 1,
        };
  }
  const end = statementEnd(source, contentStart);
  return end < 0
    ? null
    : { contentEnd: end, contentStart, end };
}

function stripFlowParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    const close = matchingDelimiter(maskLiterals(value), 0, "(", ")");
    if (close !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function flowCondition(expression) {
  let value = stripFlowParentheses(expression).replace(/\s+/g, "");
  let inverted = false;
  while (value.startsWith("!")) {
    inverted = !inverted;
    value = stripFlowParentheses(value.slice(1)).replace(/\s+/g, "");
  }
  return { inverted, value };
}

const unknownFlowValue = Symbol("unknown-flow-value");
const undefinedFlowValue = Symbol("undefined-flow-value");
const objectFlowValue = Symbol("object-flow-value");

function stripFlowExpression(expression) {
  let value = expression.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const parenthesized = stripFlowParentheses(value);
    if (parenthesized !== value) {
      value = parenthesized;
      changed = true;
    }
    const assertion = /\s+as\s+(?:const|[A-Za-z_$][\w$]*(?:\s*<[^>]+>)?(?:\s*\[\])?)\s*$/.exec(value);
    if (assertion) {
      value = value.slice(0, assertion.index).trim();
      changed = true;
    }
    if (
      value.length > 1 &&
      value.endsWith("!") &&
      !/[=!<>]$/.test(value.slice(0, -1))
    ) {
      value = value.slice(0, -1).trim();
      changed = true;
    }
  }
  return value;
}

function splitFlowExpression(expression, operator) {
  const source = expression.trim();
  const syntax = maskLiterals(source);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < syntax.length; index += 1) {
    if ("([{".includes(syntax[index])) {
      depth += 1;
      continue;
    }
    if (")]}".includes(syntax[index])) {
      depth -= 1;
      continue;
    }
    if (
      depth === 0 &&
      syntax.startsWith(operator, index) &&
      syntax[index + operator.length] !== "="
    ) {
      parts.push(source.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(source.slice(start).trim());
  return parts.every(Boolean) ? parts : null;
}

function flowStringLiteral(value) {
  const quote = value[0];
  if (
    !["'", '"', "`"].includes(quote) ||
    value.at(-1) !== quote ||
    maskLiterals(value).trim() ||
    (quote === "`" && value.includes("${"))
  ) {
    return undefined;
  }
  const body = value.slice(1, -1);
  const escapes = {
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "\\") {
      result += body[index];
      continue;
    }
    const escaped = body[index + 1];
    if (escaped === undefined) return undefined;
    index += 1;
    if (escaped === "x" && /^[\da-f]{2}$/i.test(body.slice(index + 1, index + 3))) {
      result += String.fromCharCode(Number.parseInt(body.slice(index + 1, index + 3), 16));
      index += 2;
    } else if (
      escaped === "u" &&
      /^[\da-f]{4}$/i.test(body.slice(index + 1, index + 5))
    ) {
      result += String.fromCharCode(Number.parseInt(body.slice(index + 1, index + 5), 16));
      index += 4;
    } else {
      result += escapes[escaped] ?? escaped;
    }
  }
  return result;
}

function flowCallArguments(expression, callee) {
  const value = expression.trim();
  const syntax = maskLiterals(value);
  const match = new RegExp(`^${escapeExpression(callee)}\\s*\\(`).exec(syntax);
  if (!match) return null;
  const open = match.index + match[0].lastIndexOf("(");
  const close = matchingDelimiter(syntax, open, "(", ")");
  if (close !== syntax.length - 1) return null;
  const argumentSource = value.slice(open + 1, close).trim();
  return argumentSource ? splitArguments(argumentSource) : [];
}

function flowTruthiness(value) {
  if (value === unknownFlowValue) return null;
  if (value === undefinedFlowValue || value === null) return false;
  if (value === objectFlowValue) return true;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "boolean") return value;
  return null;
}

function flowComparison(expression, assignments, seen) {
  const value = stripFlowExpression(expression);
  const syntax = maskLiterals(value);
  const operators = ["!==", "===", "==", "!=", "<=", ">=", "<", ">"];
  let depth = 0;
  for (let index = 0; index < syntax.length; index += 1) {
    if ("([{".includes(syntax[index])) {
      depth += 1;
      continue;
    }
    if (")]}".includes(syntax[index])) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    const operator = operators.find((candidate) => syntax.startsWith(candidate, index));
    if (!operator) continue;
    const left = flowValue(value.slice(0, index), assignments, new Set(seen));
    const right = flowValue(
      value.slice(index + operator.length),
      assignments,
      new Set(seen),
    );
    if (
      left === unknownFlowValue ||
      right === unknownFlowValue ||
      left === objectFlowValue ||
      right === objectFlowValue
    ) {
      return unknownFlowValue;
    }
    if (operator === "===" || operator === "!==") {
      const equal = left === right;
      return operator === "===" ? equal : !equal;
    }
    if (operator === "==" || operator === "!=") {
      const nullish =
        left === null || left === undefinedFlowValue
          ? right === null || right === undefinedFlowValue
          : right === null || right === undefinedFlowValue
            ? false
            : null;
      let equal = nullish;
      if (equal === null) {
        if (typeof left === typeof right) {
          equal = left === right;
        } else if (
          ["number", "string", "boolean"].includes(typeof left) &&
          ["number", "string", "boolean"].includes(typeof right)
        ) {
          const leftNumber = Number(left);
          const rightNumber = Number(right);
          equal = !Number.isNaN(leftNumber) &&
            !Number.isNaN(rightNumber) &&
            leftNumber === rightNumber;
        } else {
          return unknownFlowValue;
        }
      }
      return operator === "==" ? equal : !equal;
    }
    if (
      !["number", "string", "bigint"].includes(typeof left) ||
      !["number", "string", "bigint"].includes(typeof right)
    ) {
      return unknownFlowValue;
    }
    try {
      if (operator === "<") return left < right;
      if (operator === "<=") return left <= right;
      if (operator === ">") return left > right;
      return left >= right;
    } catch {
      return unknownFlowValue;
    }
  }
  return unknownFlowValue;
}

function flowValue(expression, assignments, seen = new Set()) {
  const value = stripFlowExpression(expression);
  const disjunction = splitFlowExpression(value, "||");
  if (disjunction) {
    let result = flowValue(disjunction[0], assignments, new Set(seen));
    for (const part of disjunction.slice(1)) {
      const truthy = flowTruthiness(result);
      if (truthy === null) return unknownFlowValue;
      if (truthy) return result;
      result = flowValue(part, assignments, new Set(seen));
    }
    return result;
  }
  const conjunction = splitFlowExpression(value, "&&");
  if (conjunction) {
    let result = flowValue(conjunction[0], assignments, new Set(seen));
    for (const part of conjunction.slice(1)) {
      const truthy = flowTruthiness(result);
      if (truthy === null) return unknownFlowValue;
      if (!truthy) return result;
      result = flowValue(part, assignments, new Set(seen));
    }
    return result;
  }
  const coalescing = splitFlowExpression(value, "??");
  if (coalescing) {
    let result = flowValue(coalescing[0], assignments, new Set(seen));
    for (const part of coalescing.slice(1)) {
      if (result === unknownFlowValue) return unknownFlowValue;
      if (result !== null && result !== undefinedFlowValue) return result;
      result = flowValue(part, assignments, new Set(seen));
    }
    return result;
  }
  const comparison = flowComparison(value, assignments, seen);
  if (comparison !== unknownFlowValue) return comparison;
  if (value.startsWith("!") && !value.startsWith("!=")) {
    const result = constantBoolean(value.slice(1), assignments, new Set(seen));
    return result === null ? unknownFlowValue : !result;
  }
  const booleanArguments = flowCallArguments(value, "Boolean");
  if (booleanArguments) {
    if (booleanArguments.length === 0) return false;
    if (booleanArguments.length === 1) {
      const result = constantBoolean(booleanArguments[0], assignments, new Set(seen));
      return result === null ? unknownFlowValue : result;
    }
    return unknownFlowValue;
  }
  const numberArguments = flowCallArguments(value, "Number");
  if (numberArguments) {
    if (numberArguments.length === 0) return 0;
    if (numberArguments.length !== 1) return unknownFlowValue;
    const argument = flowValue(numberArguments[0], assignments, new Set(seen));
    if (argument === unknownFlowValue || argument === objectFlowValue) {
      return unknownFlowValue;
    }
    if (argument === undefinedFlowValue) return Number.NaN;
    return Number(argument);
  }
  const stringArguments = flowCallArguments(value, "String");
  if (stringArguments) {
    if (stringArguments.length === 0) return "";
    if (stringArguments.length !== 1) return unknownFlowValue;
    const argument = flowValue(stringArguments[0], assignments, new Set(seen));
    if (argument === unknownFlowValue || argument === objectFlowValue) {
      return unknownFlowValue;
    }
    if (argument === undefinedFlowValue) return "undefined";
    return String(argument);
  }
  const literal = flowStringLiteral(value);
  if (literal !== undefined) return literal;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "undefined" || value === "void 0") return undefinedFlowValue;
  if (value === "NaN") return Number.NaN;
  if (value === "Infinity" || value === "+Infinity") return Infinity;
  if (value === "-Infinity") return -Infinity;
  if (/^[+-]?(?:0|[1-9][\d_]*)n$/.test(value)) {
    return BigInt(value.slice(0, -1).replaceAll("_", ""));
  }
  if (
    /^[+-]?(?:(?:\d[\d_]*\.?[\d_]*|\.[\d_]+)(?:e[+-]?[\d_]*)?|0x[\da-f_]+|0b[01_]+|0o[0-7_]+)$/i.test(
      value,
    )
  ) {
    return Number(value.replaceAll("_", ""));
  }
  if (
    (value.startsWith("[") &&
      matchingDelimiter(maskLiterals(value), 0, "[", "]") === value.length - 1) ||
    (value.startsWith("{") &&
      matchingDelimiter(maskLiterals(value), 0, "{", "}") === value.length - 1)
  ) {
    return objectFlowValue;
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value) && !seen.has(value)) {
    const assignment = assignments.get(value);
    if (assignment !== undefined) {
      return flowValue(assignment, assignments, new Set(seen).add(value));
    }
  }
  return unknownFlowValue;
}

function constantBoolean(expression, assignments, seen = new Set()) {
  const value = stripFlowExpression(expression);
  const disjunction = splitFlowExpression(value, "||");
  if (disjunction) {
    const results = disjunction.map((part) =>
      constantBoolean(part, assignments, new Set(seen))
    );
    if (results.includes(true)) return true;
    return results.every((result) => result === false) ? false : null;
  }
  const conjunction = splitFlowExpression(value, "&&");
  if (conjunction) {
    const results = conjunction.map((part) =>
      constantBoolean(part, assignments, new Set(seen))
    );
    if (results.includes(false)) return false;
    return results.every((result) => result === true) ? true : null;
  }
  return flowTruthiness(flowValue(value, assignments, seen));
}

function enclosingFlowEnd(source, position) {
  const syntax = maskLiterals(source);
  const stack = [];
  const ranges = [];
  for (let index = 0; index < syntax.length; index += 1) {
    if (syntax[index] === "{") stack.push(index);
    if (syntax[index] === "}" && stack.length > 0) {
      ranges.push({ end: index, start: stack.pop() });
    }
  }
  return ranges
    .filter((range) => range.start < position && position < range.end)
    .sort((left, right) => right.start - left.start)[0]?.end ?? source.length;
}

function branchAlwaysTerminates(source, range) {
  const statement = source.slice(range.contentStart, range.contentEnd).trim();
  if (/^(?:return|throw)\b/.test(maskLiterals(statement))) return true;
  if (!statement.startsWith("{")) return false;
  const body = statement.slice(1, -1).trim();
  return /^(?:return|throw)\b/.test(maskLiterals(body));
}

function splitFlowHeader(source, separator) {
  const result = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if ("([{".includes(source[index])) depth += 1;
    if (")]}".includes(source[index])) depth -= 1;
    if (source[index] === separator && depth === 0) {
      result.push(source.slice(start, index));
      start = index + 1;
    }
  }
  result.push(source.slice(start));
  return result;
}

function ternaryColon(source, question) {
  let depth = 0;
  let nested = 0;
  for (let index = question + 1; index < source.length; index += 1) {
    if ("([{".includes(source[index])) depth += 1;
    if (")]}".includes(source[index])) depth -= 1;
    if (depth !== 0) continue;
    if (source[index] === "?") nested += 1;
    if (source[index] !== ":") continue;
    if (nested === 0) return index;
    nested -= 1;
  }
  return -1;
}

function flowContexts(unit) {
  const source = unit.body;
  const syntax = maskLiterals(source);
  const assignments = assignmentsIn(source);
  const branches = [];
  const continuations = [];
  for (const match of syntax.matchAll(/\bif\s*\(/g)) {
    const open = match.index + match[0].lastIndexOf("(");
    const close = matchingDelimiter(syntax, open, "(", ")");
    if (close < 0) continue;
    const thenRange = flowStatementRange(syntax, close + 1);
    if (!thenRange) continue;
    const conditionText = source.slice(open + 1, close);
    const condition = flowCondition(conditionText);
    const constant = constantBoolean(conditionText, assignments);
    const key = `${unit.key}:${condition.value}`;
    branches.push({
      end: thenRange.contentEnd,
      key,
      reachable: constant !== false,
      start: thenRange.contentStart,
      value: !condition.inverted,
    });
    let totalEnd = thenRange.end;
    let elseRange = null;
    let cursor = thenRange.end;
    while (/\s/.test(syntax[cursor] ?? "")) cursor += 1;
    if (syntax.startsWith("else", cursor)) {
      elseRange = flowStatementRange(syntax, cursor + 4);
      if (elseRange) {
        branches.push({
          end: elseRange.contentEnd,
          key,
          reachable: constant !== true,
          start: elseRange.contentStart,
          value: condition.inverted,
        });
        totalEnd = elseRange.end;
      }
    }
    if (!elseRange && branchAlwaysTerminates(source, thenRange)) {
      continuations.push({
        end: enclosingFlowEnd(syntax, match.index),
        key,
        reachable: constant !== true,
        start: totalEnd,
        value: condition.inverted,
      });
    }
  }

  for (const match of syntax.matchAll(/\b(?:while|for)\s*\(/g)) {
    const open = match.index + match[0].lastIndexOf("(");
    const close = matchingDelimiter(syntax, open, "(", ")");
    if (close < 0) continue;
    const range = flowStatementRange(syntax, close + 1);
    if (!range) continue;
    const header = source.slice(open + 1, close);
    const condition = match[0].startsWith("for")
      ? splitFlowHeader(header, ";")[1] ?? ""
      : header;
    const constant = condition.trim() === "" && match[0].startsWith("for")
      ? true
      : constantBoolean(condition, assignments);
    branches.push({
      end: range.contentEnd,
      key: `${unit.key}:loop:${match.index}`,
      reachable: constant !== false,
      start: range.contentStart,
      value: true,
    });
  }

  for (let question = syntax.indexOf("?"); question >= 0; question = syntax.indexOf("?", question + 1)) {
    if (syntax[question + 1] === "." || syntax[question + 1] === "?") continue;
    const colon = ternaryColon(syntax, question);
    if (colon < 0) continue;
    const start = Math.max(
      syntax.lastIndexOf(";", question - 1),
      syntax.lastIndexOf("{", question - 1),
      syntax.lastIndexOf("}", question - 1),
    ) + 1;
    let conditionText = source.slice(start, question).trim();
    const equals = conditionText.lastIndexOf("=");
    if (equals >= 0 && !/[=!<>]$/.test(conditionText.slice(0, equals))) {
      conditionText = conditionText.slice(equals + 1).trim();
    }
    if (!conditionText) continue;
    const condition = flowCondition(conditionText);
    const constant = constantBoolean(conditionText, assignments);
    const key = `${unit.key}:ternary:${condition.value}`;
    const end = statementEnd(syntax, colon + 1);
    if (end < 0) continue;
    branches.push(
      {
        end: colon,
        key,
        reachable: constant !== false,
        start: question + 1,
        value: !condition.inverted,
      },
      {
        end,
        key,
        reachable: constant !== true,
        start: colon + 1,
        value: condition.inverted,
      },
    );
  }

  const baseAt = (position, includeContinuations = true) => {
    const constraints = new Map();
    let reachable = true;
    for (const branch of [...branches, ...(includeContinuations ? continuations : [])]) {
      if (branch.start <= position && position < branch.end) {
        reachable &&= branch.reachable;
        const previous = constraints.get(branch.key);
        if (previous !== undefined && previous !== branch.value) reachable = false;
        constraints.set(branch.key, branch.value);
      }
    }
    return { constraints, reachable };
  };

  const returns = [];
  for (const match of syntax.matchAll(/\b(?:return|throw)\b/g)) {
    const end = statementEnd(syntax, match.index + match[0].length);
    if (end < 0) continue;
    returns.push({
      end: enclosingFlowEnd(syntax, match.index),
      path: baseAt(match.index, false),
      start: end,
    });
  }

  return {
    at(position) {
      const context = baseAt(position);
      for (const returned of returns) {
        if (
          returned.start <= position &&
          position < returned.end &&
          mergeFlowPaths(context, returned.path)
        ) {
          context.reachable = false;
        }
      }
      return context;
    },
  };
}

function mergeFlowPaths(...paths) {
  const constraints = new Map();
  for (const path of paths) {
    if (!path?.reachable) return null;
    for (const [key, value] of path.constraints ?? []) {
      const previous = constraints.get(key);
      if (previous !== undefined && previous !== value) return null;
      constraints.set(key, value);
    }
  }
  return { constraints, reachable: true };
}

function importedClassName(app, reference) {
  if (app.classes.has(reference)) return reference;
  const binding = app.imports.bindings.get(reference);
  return binding?.moduleName?.startsWith(".") && app.classes.has(binding.imported)
    ? binding.imported
    : null;
}

function targetForFlowCall(app, unit, call) {
  const parts = call.callee.split(".");
  if (parts.length === 1) {
    const functions = [...app.units.values()].filter(
      (candidate) =>
        candidate.kind === "function" && candidate.name === parts[0],
    );
    return functions.length === 1 ? functions[0] : null;
  }
  const method = parts.at(-1);
  const receiver = parts.slice(0, -1).join(".");
  const className = importedClassName(
    app,
    receiverClass(app, unit, receiver, call.index) ?? "",
  );
  return className
    ? app.units.get(`${className}.${method}`) ?? null
    : null;
}

function assignmentsBefore(source, position) {
  const syntax = maskLiterals(source);
  const result = new Map();
  const declarationEquals = new Set();
  const events = [];
  const declaration =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=\s*/g;
  for (const match of syntax.matchAll(declaration)) {
    const equals = match.index + match[0].lastIndexOf("=");
    declarationEquals.add(equals);
    events.push({ equals, index: match.index, name: match[1] });
  }
  const assignment = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?!=|>)/g;
  for (const match of syntax.matchAll(assignment)) {
    const equals = match.index + match[0].lastIndexOf("=");
    if (declarationEquals.has(equals)) continue;
    events.push({ equals, index: match.index, name: match[1] });
  }
  for (const event of events.sort((left, right) => left.index - right.index)) {
    if (event.index >= position) continue;
    let expressionStart = event.equals + 1;
    while (/\s/.test(source[expressionStart] ?? "")) expressionStart += 1;
    result.set(
      event.name,
      assignmentExpression(source, expressionStart),
    );
  }
  return result;
}

function expressionIdentity(
  unit,
  expression,
  parameters,
  position = Number.POSITIVE_INFINITY,
  seen = new Set(),
) {
  const value = expression.trim().replace(/^await\s+/, "");
  if (parameters.has(value)) return parameters.get(value);
  const literal = /^(["'])([\s\S]*)\1$/.exec(value);
  if (literal) return `literal:${literal[2]}`;
  if (/^process\s*\.\s*env\s*\.\s*[A-Za-z_$][\w$]*$/.test(value)) {
    return value.replace(/\s/g, "");
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value) && !seen.has(value)) {
    const assignments = assignmentsBefore(unit.body, position);
    if (assignments.has(value)) {
      return expressionIdentity(
        unit,
        assignments.get(value),
        parameters,
        position,
        new Set(seen).add(value),
      );
    }
    return `${unit.key}:${value}`;
  }
  return `${unit.key}:${value.replace(/\s+/g, "")}`;
}

function receiverIdentity(
  unit,
  receiver,
  parameters,
  position = Number.POSITIVE_INFINITY,
  seen = new Set(),
) {
  const value = receiver.trim();
  if (parameters.has(value)) return parameters.get(value);
  if (/^[A-Za-z_$][\w$]*$/.test(value) && !seen.has(value)) {
    const expression = assignmentsBefore(unit.body, position).get(value);
    if (expression) {
      if (/\bnew\s+[A-Za-z_$][\w$]*\s*\(/.test(expression)) {
        return `${unit.key}:instance:${value}`;
      }
      return receiverIdentity(
        unit,
        expression,
        parameters,
        position,
        new Set(seen).add(value),
      );
    }
  }
  return `${unit.key}:receiver:${value.replace(/\s+/g, "")}`;
}

function uploadTargetUnits(app) {
  const all = new Set(app.units.keys());
  if (!hasUploadProvenance(app, all)) return new Set();
  const contracts = cryptoContracts(app, all, "wrapKey");
  const targets = new Set();
  for (const [key, unit] of app.units) {
    if (persistsRawDataKey(unit.body)) continue;
    for (const evidence of encryptionEvidence(app, unit)) {
      const flow = flowContexts(unit);
      const wrapCalls = callsIn(unit.body).filter((call) =>
        contracts.some(
          (contract) =>
            call.callee.split(".").at(-1) === contract.unit.name &&
            callTargetsContract(app, unit, call, contract),
        ),
      );
      const path = mergeFlowPaths(
        flow.at(evidence.cipherCall.index),
        flow.at(evidence.upload.index),
        ...evidence.keyOrigins.map((call) => flow.at(call.index)),
        ...evidence.initializationVectorOrigins.map((call) => flow.at(call.index)),
        ...wrapCalls.map((call) => flow.at(call.index)),
      );
      if (path && wrapCalls.length > 0) targets.add(key);
    }
  }
  return targets;
}

function downloadTargetUnits(app) {
  const all = new Set(app.units.keys());
  if (!hasDownloadProvenance(app, all)) return new Set();
  const targets = new Set();
  for (const [key, unit] of app.units) {
    const flow = flowContexts(unit);
    const calls = callsIn(unit.body).filter((call) =>
      (
        ["download", "getProperties"].includes(call.callee.split(".").at(-1)) &&
        isRealBlobOperation(app, unit, call)
      ) ||
      [
        "createDecipheriv",
        "final",
        "setAuthTag",
        "unwrapDataEncryptionKey",
        "update",
      ].includes(call.callee.split(".").at(-1)),
    );
    if (
      calls.length >= 2 &&
      mergeFlowPaths(...calls.map((call) => flow.at(call.index)))
    ) {
      targets.add(key);
    }
  }
  return targets;
}

function outputCandidates(argument) {
  return [
    argument.trim(),
    ...splitArguments(argument),
    ...[...argument.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]),
  ];
}

function derivesFromOperationProperty(
  expression,
  roots,
  properties,
  assignments,
  seen = new Set(),
) {
  const value = expression.trim();
  for (const root of roots) {
    for (const property of properties) {
      if (
        new RegExp(
          `\\b${escapeExpression(root)}\\s*\\.\\s*${property}\\b`,
          "i",
        ).test(value)
      ) {
        return true;
      }
    }
  }
  const direct = unwrappedValue(value);
  for (const property of properties) {
    const alias = new RegExp(
      `^([A-Za-z_$][\\w$]*)\\s*(?:\\.|\\?\\.)\\s*${escapeExpression(property)}$`,
      "i",
    ).exec(direct);
    if (alias && derivesExactValue(alias[1], roots, assignments)) {
      return true;
    }
  }
  for (const name of value.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) {
    if (seen.has(name) || !assignments.has(name)) continue;
    seen.add(name);
    if (
      derivesFromOperationProperty(
        assignments.get(name),
        roots,
        properties,
        assignments,
        seen,
      )
    ) {
      return true;
    }
  }
  return false;
}

function outputUsesOperation(
  output,
  event,
  properties = null,
) {
  if (output.unit !== event.unit || output.index <= event.index) return false;
  const assignments = assignmentsBefore(output.unit.body, output.index);
  const currentResults = new Set(
    [...event.results].filter((name) => {
      if (!resultSurvivesUntil(event.unit, event.call, name, output.index)) {
        return false;
      }
      const expression = assignments.get(name)?.trim().replace(/^await\s+/, "");
      return callsIn(expression ?? "").some(
        (call) =>
          call.callee === event.callee &&
          call.arguments.map((argument) => argument.replace(/\s+/g, "")).join(",") ===
            event.callArguments
              .map((argument) => argument.replace(/\s+/g, ""))
              .join(","),
      );
    }),
  );
  if (currentResults.size === 0) return false;
  return outputCandidates(output.argument).some((candidate) =>
    properties
      ? derivesFromOperationProperty(
          candidate,
          currentResults,
          properties,
          assignments,
        )
      : derivesExactValue(candidate, currentResults, assignments) ||
        [...currentResults].some((result) =>
          new RegExp(
            `^${escapeExpression(result)}\\s*\\.\\s*toString\\s*\\([^)]*\\)$`,
          ).test(unwrappedValue(candidate))
        ),
  );
}

function operationCompletesBefore(uploaded, downloaded) {
  if (uploaded.call.awaited || uploaded.unit !== downloaded.unit) return true;
  const between = uploaded.unit.body.slice(
    uploaded.call.close + 1,
    downloaded.call.index,
  );
  return [...uploaded.results].some((name) =>
    new RegExp(
      `\\bawait\\s*(?:\\(\\s*)?${escapeExpression(name)}\\b`,
    ).test(maskLiterals(between))
  );
}

function roundTripTrace(app, root, uploads, downloads) {
  const events = [];
  let order = 0;
  const visit = (
    unit,
    inheritedPath,
    parameters,
    stack = new Set(),
  ) => {
    if (stack.has(unit.key)) return;
    const nextStack = new Set(stack).add(unit.key);
    const flow = flowContexts(unit);
    for (const call of callsIn(unit.body).sort((left, right) => left.index - right.index)) {
      const path = mergeFlowPaths(inheritedPath, flow.at(call.index));
      if (!path) continue;
      if (call.callee.startsWith("console.")) {
        events.push({
          argument: call.arguments.join(", "),
          index: call.index,
          kind: "output",
          order: order += 1,
          path,
          root,
          unit,
        });
        continue;
      }
      const target = targetForFlowCall(app, unit, call);
      if (!target) continue;
      const receiver = call.callee.split(".").slice(0, -1).join(".");
      const event = {
        blob: expressionIdentity(
          unit,
          call.arguments[0] ?? "",
          parameters,
          call.index,
        ),
        call,
        index: call.index,
        order: order += 1,
        path,
        receiver: receiverIdentity(unit, receiver, parameters, call.index),
        results: boundValues(unit.body, call),
        root,
        target,
        callee: call.callee,
        callArguments: call.arguments,
        unit,
      };
      if (uploads.has(target.key)) {
        events.push({ ...event, kind: "upload" });
        continue;
      }
      if (downloads.has(target.key)) {
        events.push({ ...event, kind: "download" });
        continue;
      }
      const childParameters = new Map(
        target.parameters.map((parameter, index) => [
          parameter,
          expressionIdentity(
            unit,
            call.arguments[index] ?? "",
            parameters,
            call.index,
          ),
        ]),
      );
      visit(target, path, childParameters, nextStack);
    }
  };
  visit(root, { constraints: new Map(), reachable: true }, new Map());
  return events;
}

function hasViableRoundTrip(app) {
  if (app.roots.length === 0 || hasFakeSdk(app.source, app.imports)) return false;
  const uploads = uploadTargetUnits(app);
  const downloads = downloadTargetUnits(app);
  if (uploads.size === 0 || downloads.size === 0) return false;

  for (const rootKey of app.roots) {
    const root = app.units.get(rootKey);
    if (!root) continue;
    const events = roundTripTrace(app, root, uploads, downloads);
    const output = events.filter((event) => event.kind === "output");
    const uploadEvents = events.filter((event) => event.kind === "upload");
    const downloadEvents = events.filter((event) => event.kind === "download");
    for (const uploaded of uploadEvents) {
      for (const downloaded of downloadEvents) {
        const path = mergeFlowPaths(uploaded.path, downloaded.path);
        if (
          !path ||
          downloaded.order <= uploaded.order ||
          !operationCompletesBefore(uploaded, downloaded) ||
          uploaded.receiver !== downloaded.receiver ||
          uploaded.blob !== downloaded.blob ||
          !eventUsesRealSdkClients(app, uploaded) ||
          !eventUsesRealSdkClients(app, downloaded)
        ) {
          continue;
        }
        const compatibleOutput = (event, properties) =>
          output.some(
            (candidate) =>
              candidate.order > downloaded.order &&
              mergeFlowPaths(path, candidate.path) &&
              outputUsesOperation(candidate, event, properties),
          );
        if (
          compatibleOutput(uploaded, ["keyId", "vaultKeyId", "keyIdentifier"]) &&
          compatibleOutput(uploaded, [
            "wrappedDek",
            "wrappedKey",
            "wrappedDataKeyBase64",
            "encryptedDek",
          ]) &&
          compatibleOutput(downloaded)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function hasSemanticClients(app) {
  const credential = new Set([
    ...aliasesFor(
      app.imports,
      "@azure/identity",
      "DefaultAzureCredential",
    ),
    ...aliasesFor(
      app.imports,
      "@azure/identity",
      "ManagedIdentityCredential",
    ),
  ]);
  const blobService = aliasesFor(
    app.imports,
    "@azure/storage-blob",
    "BlobServiceClient",
  );
  const keyClient = aliasesFor(
    app.imports,
    "@azure/keyvault-keys",
    "KeyClient",
  );
  return (
    hasConstructor(app.source, credential) &&
    hasConstructor(app.source, blobService) &&
    hasConstructor(app.source, keyClient) &&
    /\.\s*getContainerClient\s*\(/.test(maskLiterals(app.source))
  );
}

function hasSemanticEnvelope(app) {
  const keys = new Set(app.units.keys());
  return (
    cryptoContracts(app, keys, "wrapKey").length > 0 &&
    cryptoContracts(app, keys, "unwrapKey").length > 0 &&
    uploadTargetUnits(app).size > 0 &&
    downloadTargetUnits(app).size > 0
  );
}

function createsImportedClient(expression, aliases) {
  return Boolean(constructorArguments(expression, aliases));
}

function unitUsesCredentialFor(
  app,
  unit,
  credential,
  aliases,
  seen = new Set(),
) {
  const identity = `${unit.key}:${credential}:${[...aliases].join(",")}`;
  if (seen.has(identity)) return false;
  const nextSeen = new Set(seen).add(identity);
  for (const call of callsIn(unit.body)) {
    const argumentsList = call.arguments.map((argument) =>
      unwrappedValue(argument)
    );
    const credentialIndexes = argumentsList
      .map((argument, index) => argument === credential ? index : -1)
      .filter((index) => index >= 0);
    if (credentialIndexes.length === 0) continue;

    const calleeName = call.callee.split(".").at(-1);
    const prefix = maskLiterals(unit.body.slice(0, call.index));
    const constructed = /\bnew\s*$/.test(prefix);
    if (constructed && aliases.has(call.callee)) return true;

    const target = constructed
      ? app.units.get(`${calleeName}.constructor`)
      : targetForFlowCall(app, unit, call);
    if (!target) continue;
    for (const index of credentialIndexes) {
      const parameter = target.parameters[index];
      if (
        parameter &&
        unitUsesCredentialFor(
          app,
          target,
          parameter,
          aliases,
          nextSeen,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function credentialBindings(app, unit, aliases) {
  const bindings = new Set();
  for (const [name, expression] of assignmentsIn(unit.body)) {
    if (createsImportedClient(expression, aliases)) {
      bindings.add(name);
      continue;
    }
    const factoryCall = /^([A-Za-z_$][\w$]*)\s*\(/.exec(
      expression.trim().replace(/^await\s+/, ""),
    );
    const factory = factoryCall && functionNamed(app, factoryCall[1]);
    if (factory && createsImportedClient(factory.body, aliases)) {
      bindings.add(name);
    }
  }
  return bindings;
}

function hasManagedIdentityConfiguration(app) {
  const credential = new Set([
    ...aliasesFor(
      app.imports,
      "@azure/identity",
      "DefaultAzureCredential",
    ),
    ...aliasesFor(
      app.imports,
      "@azure/identity",
      "ManagedIdentityCredential",
    ),
  ]);
  const blobService = aliasesFor(
    app.imports,
    "@azure/storage-blob",
    "BlobServiceClient",
  );
  const keyClient = aliasesFor(
    app.imports,
    "@azure/keyvault-keys",
    "KeyClient",
  );
  const syntax = maskLiterals(app.source);
  let sharedCredential = false;
  for (const unit of app.units.values()) {
    for (const name of credentialBindings(app, unit, credential)) {
      if (
        unitUsesCredentialFor(app, unit, name, blobService) &&
        unitUsesCredentialFor(app, unit, name, keyClient)
      ) {
        sharedCredential = true;
        break;
      }
    }
    if (sharedCredential) break;
  }
  return (
    hasSemanticClients(app) &&
    /process\s*\.\s*env\s*(?:\[|\.)/.test(syntax) &&
    /\bAZURE_(?:STORAGE|KEY_VAULT)/.test(app.source) &&
    sharedCredential &&
    !/\bfromConnectionString\s*\(/.test(syntax)
  );
}

const rules = {
  "prompt/packages": (workspace) => {
    const app = application(workspace);
    return (
      app.documents.length > 0 &&
      hasRequiredPackages(workspace) &&
      (app.imports.modules.has("node:crypto") || app.imports.modules.has("crypto")) &&
      !hasFakeSdk(app.source, app.imports)
    );
  },
  "prompt/key-vault-envelope-encryption": (workspace) => {
    const app = application(workspace);
    return Boolean(
      hasSemanticClients(app) &&
      hasSemanticEnvelope(app),
    );
  },
  "prompt/encrypted-blob-metadata": (workspace) => {
    const app = application(workspace);
    return Boolean(
      hasSemanticClients(app) &&
      uploadTargetUnits(app).size > 0,
    );
  },
  "prompt/decrypt-path": (workspace) => {
    const app = application(workspace);
    return Boolean(
      hasSemanticClients(app) &&
      downloadTargetUnits(app).size > 0 &&
      cryptoContracts(app, new Set(app.units.keys()), "unwrapKey").length > 0,
    );
  },
  "prompt/managed-identity-configuration": (workspace) => {
    const app = application(workspace);
    return hasManagedIdentityConfiguration(app);
  },
  "prompt/rest-error-handling": (workspace) => {
    const app = application(workspace);
    return app.documents.length > 0 && hasServiceErrorHandling(app);
  },
  "prompt/connected-round-trip": (workspace) => {
    const app = application(workspace);
    return Boolean(
      hasViableRoundTrip(app) &&
      hasSemanticClients(app) &&
      hasSemanticEnvelope(app) &&
      hasManagedIdentityConfiguration(app)
    );
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
