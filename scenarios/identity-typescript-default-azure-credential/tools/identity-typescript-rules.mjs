function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskSource(source, maskStrings) {
  let result = "";
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (current === "\n") {
        state = "code";
        result += current;
      } else {
        result += " ";
      }
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
        result += maskStrings ? "  " : current + next;
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        result += current;
        state = "code";
      } else {
        result += maskStrings && current !== "\n" ? " " : current;
      }
      continue;
    }

    if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else {
      result += current;
      if (current === "'") state = "single";
      if (current === '"') state = "double";
      if (current === "`") state = "template";
    }
  }

  return result;
}

function balancedText(source, openingIndex, opening = "(", closing = ")") {
  let depth = 0;
  let state = "code";

  for (let index = openingIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state !== "code") {
      if (current === "\\") {
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      index += 1;
      state = "line-comment";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 1;
      state = "block-comment";
      continue;
    }
    if (current === "'") {
      state = "single";
      continue;
    }
    if (current === '"') {
      state = "double";
      continue;
    }
    if (current === "`") {
      state = "template";
      continue;
    }
    if (current === opening) depth += 1;
    if (current === closing) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openingIndex + 1, index);
      }
    }
  }

  return "";
}

function splitTopLevel(argumentsText) {
  const parts = [];
  let current = "";
  let depth = 0;
  let state = "code";

  for (let index = 0; index < argumentsText.length; index += 1) {
    const character = argumentsText[index];
    const next = argumentsText[index + 1];

    if (state === "line-comment") {
      current += character;
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      current += character;
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state !== "code") {
      current += character;
      if (character === "\\") {
        current += next;
        index += 1;
      } else if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      current += character + next;
      index += 1;
      state = "line-comment";
      continue;
    }
    if (character === "/" && next === "*") {
      current += character + next;
      index += 1;
      state = "block-comment";
      continue;
    }
    if (character === "'") state = "single";
    if (character === '"') state = "double";
    if (character === "`") state = "template";
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;

    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }

  if (current.trim() || argumentsText.includes(",")) {
    parts.push(current.trim());
  }
  return parts;
}

function expressionCode(source) {
  let result = "";
  let state = "code";
  const templateDepths = [];

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
    if (state === "single" || state === "double") {
      result += current === "\n" ? "\n" : " ";
      if (current === "\\") {
        result += " ";
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"')
      ) {
        state = "code";
      }
      continue;
    }
    if (state === "template") {
      if (current === "\\") {
        result += "  ";
        index += 1;
      } else if (current === "`") {
        result += " ";
        state = "code";
      } else if (current === "$" && next === "{") {
        result += "  ";
        index += 1;
        templateDepths.push(1);
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else if (current === "'") {
      result += " ";
      state = "single";
    } else if (current === '"') {
      result += " ";
      state = "double";
    } else if (current === "`") {
      result += " ";
      state = "template";
    } else {
      result += current;
      if (templateDepths.length > 0) {
        if (current === "{") {
          templateDepths[templateDepths.length - 1] += 1;
        } else if (current === "}") {
          templateDepths[templateDepths.length - 1] -= 1;
          if (templateDepths[templateDepths.length - 1] === 0) {
            templateDepths.pop();
            state = "template";
          }
        }
      }
    }
  }

  return result;
}

function matchingOpening(source, closingIndex, opening, closing) {
  let depth = 0;
  for (let index = closingIndex; index >= 0; index -= 1) {
    if (source[index] === closing) {
      depth += 1;
    } else if (source[index] === opening) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parameterListBefore(source, code, end) {
  let closingIndex = end - 1;
  while (closingIndex >= 0 && /\s/.test(code[closingIndex])) {
    closingIndex -= 1;
  }

  if (code[closingIndex] !== ")") {
    for (let index = closingIndex; index >= 0; index -= 1) {
      if (";={}".includes(code[index])) return null;
      if (code[index] === ")") {
        const annotation = code.slice(index + 1, end).trim();
        if (!annotation.startsWith(":")) return null;
        closingIndex = index;
        break;
      }
    }
  }
  if (code[closingIndex] !== ")") return null;

  const openingIndex = matchingOpening(code, closingIndex, "(", ")");
  if (openingIndex === -1) return null;
  return {
    openingIndex,
    parameters: source.slice(openingIndex + 1, closingIndex),
  };
}

function callableBodies(source) {
  const code = maskSource(source, true);
  const bodies = [];
  const controlFlowNames = new Set([
    "catch",
    "for",
    "if",
    "switch",
    "while",
    "with",
  ]);

  for (let openingBrace = 0; openingBrace < code.length; openingBrace += 1) {
    if (code[openingBrace] !== "{") continue;

    const prefix = code.slice(0, openingBrace);
    const arrow = /=>\s*$/.exec(prefix);
    if (arrow) {
      const parameterList = parameterListBefore(
        source,
        code,
        arrow.index,
      );
      if (parameterList) {
        bodies.push({
          openingBrace,
          parameters: parameterList.parameters,
        });
        continue;
      }

      const singleParameter = code
        .slice(0, arrow.index)
        .match(/([A-Za-z_$]\w*)\s*$/);
      if (singleParameter) {
        bodies.push({
          openingBrace,
          parameters: singleParameter[1],
        });
      }
      continue;
    }

    const parameterList = parameterListBefore(
      source,
      code,
      openingBrace,
    );
    if (!parameterList) continue;
    const callablePrefix = code.slice(0, parameterList.openingIndex);
    const callableName = callablePrefix
      .match(/([A-Za-z_$]\w*)\s*(?:<[^<>]*>)?\s*$/)?.[1];
    if (
      !callableName ||
      controlFlowNames.has(callableName) ||
      /\bfor\s+await\s*$/.test(callablePrefix)
    ) {
      continue;
    }

    bodies.push({
      openingBrace,
      parameters: parameterList.parameters,
    });
  }

  return bodies;
}

function sourceScopes(source) {
  const code = maskSource(source, true);
  const root = {
    bindings: new Map(),
    end: source.length,
    functionScope: null,
    parent: null,
    start: 0,
  };
  root.functionScope = root;
  const scopes = [root];
  const stack = [root];
  const callables = callableBodies(source);
  const functionOpenings = new Set(
    callables.map(({ openingBrace }) => openingBrace),
  );

  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === "{") {
      const parent = stack[stack.length - 1];
      const scope = {
        bindings: new Map(),
        end: source.length,
        functionScope: null,
        parent,
        start: index + 1,
      };
      scope.functionScope = functionOpenings.has(index)
        ? scope
        : parent.functionScope;
      scopes.push(scope);
      stack.push(scope);
    } else if (code[index] === "}" && stack.length > 1) {
      stack.pop().end = index;
    }
  }

  return {
    at(position) {
      let selected = root;
      for (const scope of scopes) {
        if (
          scope.start <= position &&
          position < scope.end &&
          scope.start >= selected.start
        ) {
          selected = scope;
        }
      }
      return selected;
    },
    callables,
    scopes,
  };
}

function expressionEnd(code, start) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const current = code[index];
    if ("([{".includes(current)) depth += 1;
    if (")]}".includes(current)) depth -= 1;
    if (current === ";" && depth === 0) return index;
  }
  return code.length;
}

function simpleReference(expression) {
  const code = maskSource(expression, true).trim();
  const match = code.match(
    /^\(*\s*([A-Za-z_$]\w*)\s*!?\s*(?:as\s+[\w.<>]+\s*)?\)*$/,
  );
  return match?.[1] ?? null;
}

function bindingState(source, credentialNames, clientTypeNames) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const scopeIndex = sourceScopes(source);
  const events = [];
  const declarationEquals = new Set();
  let nextBindingId = 1;
  let nextVersion = 1;

  const declarations =
    /\b(const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:\s*[^=;\n]+)?\s*(=)?/g;
  for (const match of code.matchAll(declarations)) {
    const equals = match[3]
      ? match.index + match[0].lastIndexOf("=")
      : -1;
    if (equals !== -1) declarationEquals.add(equals);
    events.push({
      declarationKind: match[1],
      equals,
      index: match.index,
      kind: "declaration",
      name: match[2],
    });
  }

  function addParameters(parameters, openingBrace) {
    for (const parameter of splitTopLevel(parameters)) {
      const name = parameter
        .trim()
        .match(/^(?:\.\.\.)?([A-Za-z_$]\w*)\b/)?.[1];
      if (!name) continue;
      events.push({
        equals: -1,
        index: openingBrace + 1,
        kind: "declaration",
        name,
      });
    }
  }

  for (const callable of scopeIndex.callables) {
    addParameters(callable.parameters, callable.openingBrace);
  }
  const catchParameters = /\bcatch\s*\(([^)]*)\)\s*\{/g;
  for (const match of code.matchAll(catchParameters)) {
    addParameters(
      match[1],
      match.index + match[0].lastIndexOf("{"),
    );
  }

  const assignments = /(?<![\w$.])([A-Za-z_$]\w*)\s*=(?!=|>)/g;
  for (const match of code.matchAll(assignments)) {
    const equals = match.index + match[0].lastIndexOf("=");
    if (declarationEquals.has(equals)) continue;
    events.push({
      equals,
      index: match.index,
      kind: "assignment",
      name: match[1],
    });
  }

  const propertyAssignments =
    /(?<![\w$.])([A-Za-z_$]\w*)\s*\.\s*value\s*=(?!=|>)/g;
  for (const match of code.matchAll(propertyAssignments)) {
    events.push({
      index: match.index,
      kind: "property-assignment",
      name: match[1],
    });
  }

  events.sort((left, right) =>
    left.index - right.index ||
    (left.kind === "declaration" ? -1 : 1),
  );

  function resolve(name, position) {
    for (
      let scope = scopeIndex.at(position);
      scope;
      scope = scope.parent
    ) {
      const binding = scope.bindings.get(name);
      if (!binding || binding.index > position) continue;
      return binding;
    }
    return null;
  }

  function valueAt(binding, position) {
    if (!binding) return null;
    let selected = null;
    for (const entry of binding.history) {
      if (entry.index > position) break;
      selected = entry.value;
    }
    return selected;
  }

  function typeConstructor(expression, names, exportedName) {
    const calls = constructorCalls(expression, names, exportedName);
    return calls.find((call) =>
      maskSource(expression.slice(0, call.index), true).trim() === ""
    ) ?? null;
  }

  function classify(expression, position) {
    const credentialCall = typeConstructor(
      expression,
      credentialNames,
      "DefaultAzureCredential",
    );
    if (credentialCall) {
      return { kind: "credential", version: nextVersion++ };
    }

    const clientCall = typeConstructor(
      expression,
      clientTypeNames,
      "SecretClient",
    );
    if (clientCall) {
      const clientArguments = splitTopLevel(clientCall.arguments);
      if (clientArguments.length < 2) return null;
      const credentialArgument = clientArguments[1];
      if (
        typeConstructor(
          credentialArgument,
          credentialNames,
          "DefaultAzureCredential",
        )
      ) {
        return {
          credentialBinding: null,
          credentialVersion: null,
          kind: "client",
          version: nextVersion++,
        };
      }

      const credentialName = simpleReference(credentialArgument);
      const credentialBinding = resolve(credentialName, position);
      const credentialValue = valueAt(credentialBinding, position);
      if (credentialValue?.kind !== "credential") return null;
      return {
        credentialBinding,
        credentialVersion: credentialValue.version,
        kind: "client",
        version: nextVersion++,
      };
    }

    const reference = simpleReference(expression);
    const referencedBinding = resolve(reference, position);
    return valueAt(referencedBinding, position);
  }

  const clientCandidates = new Set();
  const bindings = [];
  for (const event of events) {
    const lexicalScope = scopeIndex.at(event.index);
    const scope = event.declarationKind === "var"
      ? lexicalScope.functionScope
      : lexicalScope;
    let binding;
    if (event.kind === "declaration") {
      binding = event.declarationKind === "var"
        ? scope.bindings.get(event.name)
        : null;
      if (!binding) {
        binding = {
          history: [],
          id: nextBindingId++,
          index: event.index,
          name: event.name,
          scope,
        };
        bindings.push(binding);
        scope.bindings.set(event.name, binding);
      }
    } else {
      binding = resolve(event.name, event.index);
    }
    if (!binding) continue;

    let value = null;
    if (event.kind !== "property-assignment" && event.equals !== -1) {
      const start = event.equals + 1;
      value = classify(
        original.slice(start, expressionEnd(code, start)),
        event.index,
      );
    }
    binding.history.push({ index: event.index, value });
    if (value?.kind === "client") clientCandidates.add(binding.name);
  }

  function validClientValue(value, position) {
    if (value?.kind !== "client") return false;
    if (!value.credentialBinding) return true;
    const credentialValue = valueAt(value.credentialBinding, position);
    return (
      credentialValue?.kind === "credential" &&
      credentialValue.version === value.credentialVersion
    );
  }

  function isValidClientAt(name, position) {
    const binding = resolve(name, position);
    return validClientValue(valueAt(binding, position), position);
  }

  const associatedClients = [];
  for (const binding of bindings) {
    const position = Math.max(binding.index, binding.scope.end - 1);
    const value = valueAt(binding, position);
    if (validClientValue(value, position)) {
      associatedClients.push({ name: binding.name });
    }
  }

  return {
    associatedClients,
    clientCandidates,
    isValidClientAt,
  };
}

function packageDependencies(packageJson) {
  try {
    const manifest = JSON.parse(packageJson);
    return manifest.dependencies ?? {};
  } catch {
    return {};
  }
}

function hasSource(workspace) {
  return typeof workspace.source === "string" && workspace.source.trim() !== "";
}

function importBindings(source, moduleName) {
  const commentsMasked = maskSource(source, false);
  const codeMasked = maskSource(source, true);
  const modulePattern = escapeRegExp(moduleName);
  const named = new Map();
  const namespaces = new Set();

  const namedPattern = new RegExp(
    `\\bimport\\s*\\{([^}]+)\\}\\s*from\\s*["']${modulePattern}["']`,
    "g",
  );
  for (const match of commentsMasked.matchAll(namedPattern)) {
    if (codeMasked[match.index] !== "i") continue;
    for (const specifier of match[1].split(",")) {
      const parsed = specifier
        .trim()
        .match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (parsed) named.set(parsed[1], parsed[2] ?? parsed[1]);
    }
  }

  const namespacePattern = new RegExp(
    `\\bimport\\s*\\*\\s*as\\s*(\\w+)\\s*from\\s*["']${modulePattern}["']`,
    "g",
  );
  for (const match of commentsMasked.matchAll(namespacePattern)) {
    if (codeMasked[match.index] === "i") namespaces.add(match[1]);
  }

  return { named, namespaces };
}

function typeNames(source, moduleName, exportedName) {
  const imports = importBindings(source, moduleName);
  const names = new Set();
  const local = imports.named.get(exportedName);
  if (local) names.add(local);
  for (const namespace of imports.namespaces) {
    names.add(`${namespace}.${exportedName}`);
  }
  return names;
}

function isKnownType(candidate, names, exportedName) {
  const normalized = candidate.replace(/\s+/g, "");
  return names.has(normalized);
}

function constructorCalls(source, names, exportedName) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern =
    /\bnew\s+([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*(?:<[^;(){}]+>)?\s*\(/g;
  const calls = [];

  for (const match of code.matchAll(pattern)) {
    if (!isKnownType(match[1], names, exportedName)) continue;
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(original, openingIndex);
    calls.push({
      arguments: argumentsText,
      argumentsStart: openingIndex + 1,
      end: openingIndex + argumentsText.length + 2,
      index: match.index,
    });
  }
  return calls;
}

function constructorBindings(source, names, exportedName) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern =
    /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;]+)?\s*=\s*new\s+([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*(?:<[^;(){}]+>)?\s*\(/g;
  const bindings = [];

  for (const match of code.matchAll(pattern)) {
    if (!isKnownType(match[2], names, exportedName)) continue;
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(original, openingIndex);
    bindings.push({
      arguments: argumentsText,
      end: openingIndex + argumentsText.length + 2,
      index: match.index,
      name: match[1],
    });
  }
  return bindings;
}

function methodCalls(source, receiver, method) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern = new RegExp(
    `\\b${escapeRegExp(receiver)}\\s*(?:\\?\\.|\\.)\\s*${method}\\s*\\(`,
    "g",
  );
  const calls = [];

  for (const match of code.matchAll(pattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(original, openingIndex);
    calls.push({
      arguments: argumentsText,
      end: openingIndex + argumentsText.length + 2,
      index: match.index,
    });
  }
  return calls;
}

function consoleCalls(source) {
  return [
    ...methodCalls(source, "console", "log"),
    ...methodCalls(source, "console", "info"),
  ];
}

function declarationScopes(source, name, scopeIndex) {
  const code = maskSource(source, true);
  const escapedName = escapeRegExp(name);
  const declarations = new Set();
  const patterns = [
    new RegExp(`\\b(const|let|var)\\s+${escapedName}\\b`, "g"),
    new RegExp(
      `\\b(const|let|var)\\s*\\{[^{}]*` +
        `(?:\\bvalue\\s*:\\s*)?\\b${escapedName}\\b[^{}]*\\}`,
      "g",
    ),
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const lexicalScope = scopeIndex.at(match.index);
      declarations.add(
        match[1] === "var"
          ? lexicalScope.functionScope
          : lexicalScope,
      );
    }
  }

  const parameterLists = [
    ...scopeIndex.callables.map((callable) => ({
      openingBrace: callable.openingBrace,
      parameters: callable.parameters,
    })),
  ];
  const catchParameters = /\bcatch\s*\(([^)]*)\)\s*\{/g;
  for (const match of code.matchAll(catchParameters)) {
    parameterLists.push({
      openingBrace: match.index + match[0].lastIndexOf("{"),
      parameters: match[1],
    });
  }
  for (const { openingBrace, parameters } of parameterLists) {
    const declaresName = splitTopLevel(parameters).some((parameter) =>
      parameter
        .trim()
        .match(/^(?:\.\.\.)?([A-Za-z_$]\w*)\b/)?.[1] === name
    );
    if (declaresName) {
      declarations.add(scopeIndex.at(openingBrace + 1));
    }
  }
  return declarations;
}

function resolvesToScope(
  position,
  bindingScope,
  scopeIndex,
  shadowingScopes,
) {
  let scope = scopeIndex.at(position);
  while (scope && scope !== bindingScope) {
    if (shadowingScopes.has(scope)) return false;
    scope = scope.parent;
  }
  return scope === bindingScope;
}

function firstValueOverwrite(
  source,
  name,
  start,
  bindingScope,
  scopeIndex,
  shadowingScopes,
) {
  const code = maskSource(source, true);
  const escapedName = escapeRegExp(name);
  const patterns = [
    new RegExp(
      `\\b${escapedName}\\s*(?:\\.\\s*value\\s*)?=(?!=|>)`,
      "g",
    ),
    new RegExp(
      `\\{[^{}]*\\bvalue\\s*:\\s*${escapedName}\\b[^{}]*\\}\\s*=`,
      "g",
    ),
  ];
  let first = -1;

  for (const pattern of patterns) {
    pattern.lastIndex = start;
    for (const match of code.matchAll(pattern)) {
      if (
        resolvesToScope(
          match.index,
          bindingScope,
          scopeIndex,
          shadowingScopes,
        ) &&
        (first === -1 || match.index < first)
      ) {
        first = match.index;
      }
    }
  }
  return first;
}

function printsBoundValue(
  source,
  name,
  start,
  property = true,
  bindingScope = null,
  scopeIndex = null,
) {
  scopeIndex ??= sourceScopes(source);
  bindingScope ??= scopeIndex.at(Math.max(0, start - 1));
  const shadowingScopes = declarationScopes(source, name, scopeIndex);
  const overwrite = firstValueOverwrite(
    source,
    name,
    start,
    bindingScope,
    scopeIndex,
    shadowingScopes,
  );
  const valuePattern = property
    ? new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*value\\b`)
    : new RegExp(`\\b${escapeRegExp(name)}\\b`);

  if (consoleCalls(source).some((call) => {
    if (call.index < start || (overwrite !== -1 && call.index >= overwrite)) {
      return false;
    }
    if (!resolvesToScope(
      call.index,
      bindingScope,
      scopeIndex,
      shadowingScopes,
    )) return false;
    return valuePattern.test(expressionCode(call.arguments));
  })) {
    return true;
  }

  const code = maskSource(source, true);
  const sourceName = escapeRegExp(name);
  const sourceExpression = property
    ? `${sourceName}\\s*\\.\\s*value`
    : sourceName;
  const aliasPattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$]\\w*)` +
      `(?:\\s*:[^=;]+)?\\s*=\\s*${sourceExpression}\\b`,
    "g",
  );
  for (const match of code.matchAll(aliasPattern)) {
    if (
      match.index < start ||
      (overwrite !== -1 && match.index >= overwrite) ||
      !resolvesToScope(
        match.index,
        bindingScope,
        scopeIndex,
        shadowingScopes,
      )
    ) {
      continue;
    }
    const aliasStart = match.index + match[0].length;
    if (printsBoundValue(
      source,
      match[1],
      aliasStart,
      false,
      scopeIndex.at(match.index),
      scopeIndex,
    )) {
      return true;
    }
  }
  return false;
}

function credentialContext(workspace) {
  const source = workspace.source;
  const credentialNames = typeNames(
    source,
    "@azure/identity",
    "DefaultAzureCredential",
  );
  const clientNames = typeNames(
    source,
    "@azure/keyvault-secrets",
    "SecretClient",
  );
  const credentials = constructorBindings(
    source,
    credentialNames,
    "DefaultAzureCredential",
  );
  const state = bindingState(source, credentialNames, clientNames);

  return {
    associatedClients: state.associatedClients,
    clientCandidates: state.clientCandidates,
    clientNames,
    credentialNames,
    credentials,
    isValidClientAt: state.isValidClientAt,
    source,
  };
}

function printsSecretResult(
  source,
  clientName,
  isValidClientAt = () => true,
) {
  const code = maskSource(source, true);
  const escapedClient = escapeRegExp(clientName);

  const assignment = new RegExp(
    `(?:\\b(?:const|let|var)\\s+|(?<![\\w$.]))(\\w+)` +
      `(?:\\s*:[^=;\\n{}]+)?\\s*=\\s*\\(*\\s*await\\s+` +
      `${escapedClient}\\s*\\.\\s*getSecret\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(assignment)) {
    const callIndex = match.index + match[0].lastIndexOf(clientName);
    if (!isValidClientAt(clientName, callIndex)) continue;
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(source, openingIndex);
    const operationEnd = openingIndex + argumentsText.length + 2;
    const extractsValue = /^\s*\)*\s*\.\s*value\b/.test(
      code.slice(operationEnd),
    );
    if (
      argumentsText.trim() !== "" &&
      printsBoundValue(
        source,
        match[1],
        operationEnd,
        !extractsValue,
      )
    ) {
      return true;
    }
  }

  const destructuring = new RegExp(
    `(?:\\b(?:const|let|var)\\s+)?\\{\\s*value(?:\\s*:\\s*(\\w+))?\\s*\\}\\s*=\\s*await\\s+${escapedClient}\\s*\\.\\s*getSecret\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(destructuring)) {
    const callIndex = match.index + match[0].lastIndexOf(clientName);
    if (!isValidClientAt(clientName, callIndex)) continue;
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(source, openingIndex);
    const operationEnd = openingIndex + argumentsText.length + 2;
    const valueName = match[1] ?? "value";
    if (
      argumentsText.trim() !== "" &&
      printsBoundValue(source, valueName, operationEnd, false)
    ) {
      return true;
    }
  }

  const secretCalls = methodCalls(source, clientName, "getSecret").filter(
    ({ arguments: args, index }) =>
      args.trim() !== "" && isValidClientAt(clientName, index),
  );
  for (const call of secretCalls) {
    if (
      consoleCalls(source).some((consoleCall) => {
        if (
          call.index < consoleCall.index ||
          call.end > consoleCall.end
        ) {
          return false;
        }
        return /^\s*\)*\s*\.\s*value\b/.test(
          code.slice(call.end, consoleCall.end),
        );
      })
    ) {
      return true;
    }

    for (const consoleCall of consoleCalls(source)) {
      const expression = expressionCode(consoleCall.arguments);
      const nestedCalls = methodCalls(
        expression,
        clientName,
        "getSecret",
      );
      if (nestedCalls.some((nestedCall) => {
        const globalIndex = consoleCall.argumentsStart + nestedCall.index;
        return (
          nestedCall.arguments.trim() !== "" &&
          isValidClientAt(clientName, globalIndex) &&
          /^\s*\)*\s*\.\s*value\b/.test(
            expression.slice(nestedCall.end),
          )
        );
      })) {
        return true;
      }
    }

    const continuation = code.slice(call.end, call.end + 500);
    const then = continuation.match(
      /^\s*\.\s*then\s*\(\s*(?:async\s*)?\(?\s*(\w+)[^=]*=>\s*/,
    );
    if (
      then &&
      printsBoundValue(
        source,
        then[1],
        call.end + then.index + then[0].length,
      )
    ) {
      return true;
    }
  }

  return false;
}

function tryCatchBlocks(source) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern = /\btry\s*\{/g;
  const blocks = [];

  for (const match of code.matchAll(pattern)) {
    const tryOpeningIndex = match.index + match[0].lastIndexOf("{");
    const tryBody = balancedText(original, tryOpeningIndex, "{", "}");
    const tryClosingIndex = tryOpeningIndex + tryBody.length + 1;
    const catchMatch = code.slice(tryClosingIndex + 1).match(
      /^\s*catch\s*\(\s*([A-Za-z_$]\w*)(?:\s*:\s*[^)]+)?\)\s*\{/,
    );
    if (!catchMatch) continue;

    const catchOpeningIndex =
      tryClosingIndex +
      1 +
      catchMatch.index +
      catchMatch[0].lastIndexOf("{");
    blocks.push({
      body: balancedText(original, catchOpeningIndex, "{", "}"),
      error: catchMatch[1],
      tryBody,
      tryStart: tryOpeningIndex + 1,
    });
  }
  return blocks;
}

function ifBlocks(source) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern = /\bif\s*\(/g;
  const blocks = [];

  for (const match of code.matchAll(pattern)) {
    const conditionOpening = match.index + match[0].lastIndexOf("(");
    const condition = balancedText(original, conditionOpening);
    const conditionClosing = conditionOpening + condition.length + 1;
    const consequentMatch = code.slice(conditionClosing + 1).match(/^\s*\{/);
    if (!consequentMatch) continue;

    const consequentOpening =
      conditionClosing + 1 + consequentMatch.index +
      consequentMatch[0].lastIndexOf("{");
    const consequent = balancedText(
      original,
      consequentOpening,
      "{",
      "}",
    );
    const consequentClosing = consequentOpening + consequent.length + 1;
    const alternateMatch = code.slice(consequentClosing + 1).match(
      /^\s*else\s*\{/,
    );
    let alternate = null;
    let end = consequentClosing + 1;
    if (alternateMatch) {
      const alternateOpening =
        consequentClosing + 1 + alternateMatch.index +
        alternateMatch[0].lastIndexOf("{");
      alternate = balancedText(original, alternateOpening, "{", "}");
      end = alternateOpening + alternate.length + 2;
    }

    blocks.push({
      alternate,
      condition,
      consequent,
      end,
      index: match.index,
    });
  }
  return blocks;
}

function startsWithThrow(source, error) {
  return new RegExp(
    `^\\s*throw\\s+${escapeRegExp(error)}\\b`,
  ).test(maskSource(source, true));
}

function reportsAuthenticationFailure(source, error) {
  const escapedError = escapeRegExp(error);
  const calls = ["error", "warn", "log", "info"].flatMap((method) =>
    methodCalls(source, "console", method)
  );
  return calls.some((call) =>
    new RegExp(
      `\\b${escapedError}(?:\\s*\\.\\s*(?:message|name|stack))?\\b`,
    ).test(expressionCode(call.arguments))
  );
}

function handlesAuthenticationError(
  source,
  clientCandidates,
  isValidClientAt,
) {
  const errorNames = typeNames(
    source,
    "@azure/identity",
    "AuthenticationError",
  );
  if (errorNames.size === 0) return false;
  const typeAlternation = [...errorNames]
    .map((name) => escapeRegExp(name))
    .join("|");

  return tryCatchBlocks(source).some(({
    body,
    error,
    tryBody,
    tryStart,
  }) => {
    const tryCode = maskSource(tryBody, true);
    const escapedError = escapeRegExp(error);
    const handlesCredentialOperation = [...clientCandidates].some((name) =>
      methodCalls(tryBody, name, "getSecret").some(
        ({ arguments: args, index }) =>
          args.trim() !== "" &&
          isValidClientAt(name, tryStart + index) &&
          /\bawait\s+(?:\(\s*)*$/.test(tryCode.slice(0, index)),
      ),
    );
    if (!handlesCredentialOperation) return false;

    const authenticationCheck = new RegExp(
      `\\b${escapedError}\\s+instanceof\\s+(?:${typeAlternation}|\\w+\\.AuthenticationError)\\b`,
    );
    return ifBlocks(body).some((block) => {
      if (!authenticationCheck.test(maskSource(block.condition, true))) {
        return false;
      }

      const condition = maskSource(block.condition, true);
      const negated = new RegExp(
        `^\\s*!\\s*\\(?\\s*${escapedError}\\s+instanceof\\b`,
      ).test(condition);
      if (negated) {
        const authenticationPath = block.alternate ??
          body.slice(block.end);
        return (
          startsWithThrow(block.consequent, error) &&
          reportsAuthenticationFailure(authenticationPath, error)
        );
      }

      const nonAuthenticationPath = block.alternate ??
        body.slice(block.end);
      return (
        reportsAuthenticationFailure(block.consequent, error) &&
        startsWithThrow(nonAuthenticationPath, error)
      );
    });
  });
}

function loggingLevelConstants(source) {
  const levels = new Map();
  const commentsMasked = maskSource(source, false);
  const code = maskSource(source, true);
  const pattern =
    /\bconst\s+(\w+)(?:\s*:\s*[^=;]+)?\s*=\s*["'](verbose|info|warning|error)["']\s*;/g;
  for (const match of commentsMasked.matchAll(pattern)) {
    if (code[match.index] === "c") levels.set(match[1], match[2]);
  }
  return levels;
}

function configuresIdentityDiagnostics(source) {
  const imports = importBindings(source, "@azure/logger");
  const callNames = new Set();
  const direct = imports.named.get("setLogLevel");
  if (direct) callNames.add(direct);
  for (const namespace of imports.namespaces) {
    callNames.add(`${namespace}.setLogLevel`);
  }
  if (callNames.size === 0) return false;

  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const levels = loggingLevelConstants(source);

  for (const callName of callNames) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(callName)}\\s*\\(`,
      "g",
    );
    for (const match of code.matchAll(pattern)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const argument = balancedText(original, openingIndex).trim();
      if (
        /^["'](?:verbose|info|warning|error)["']$/.test(argument) ||
        levels.has(argument)
      ) {
        return true;
      }
    }
  }
  return false;
}

const rules = {
  "prompt/identity-packages": (workspace) => {
    if (!hasSource(workspace)) return false;
    const dependencies = packageDependencies(workspace.packageJson);
    return [
      "@azure/identity",
      "@azure/keyvault-secrets",
      "@azure/logger",
    ].every((name) => typeof dependencies[name] === "string");
  },
  "prompt/default-azure-credential": (workspace) => {
    if (!hasSource(workspace)) return false;
    const { credentialNames, source } = credentialContext(workspace);
    return (
      constructorCalls(source, credentialNames, "DefaultAzureCredential")
        .length > 0
    );
  },
  "prompt/credential-client-association": (workspace) => {
    if (!hasSource(workspace)) return false;
    return credentialContext(workspace).associatedClients.length > 0;
  },
  "prompt/authenticated-operation": (workspace) => {
    if (!hasSource(workspace)) return false;
    const {
      clientCandidates,
      isValidClientAt,
      source,
    } = credentialContext(workspace);
    return [...clientCandidates].some((name) => {
      const calls = methodCalls(source, name, "getSecret");
      return (
        calls.some(({ arguments: args, index }) =>
          args.trim() !== "" && isValidClientAt(name, index)
        ) &&
        printsSecretResult(source, name, isValidClientAt)
      );
    });
  },
  "prompt/authentication-errors": (workspace) => {
    if (!hasSource(workspace)) return false;
    const {
      clientCandidates,
      isValidClientAt,
      source,
    } = credentialContext(workspace);
    return handlesAuthenticationError(
      source,
      clientCandidates,
      isValidClientAt,
    );
  },
  "prompt/identity-diagnostics": (workspace) =>
    hasSource(workspace) &&
    typeof packageDependencies(workspace.packageJson)["@azure/logger"] ===
      "string" &&
    configuresIdentityDiagnostics(workspace.source),
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
