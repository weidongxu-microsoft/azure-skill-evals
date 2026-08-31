function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blankRange(source, start, end) {
  return source.slice(0, start) +
    source.slice(start, end).replace(/[^\n]/g, " ") +
    source.slice(end);
}

function maskSource(source, maskStrings = true) {
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
    } else if (state !== "code") {
      if (current === "\\") {
        result += maskStrings ? "  " : current + next;
        index += 1;
      } else {
        const closes =
          (state === "single" && current === "'") ||
          (state === "double" && current === '"') ||
          (state === "template" && current === "`");
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
      if (current === "'") state = "single";
      if (current === '"') state = "double";
      if (current === "`") state = "template";
    }
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
  const end = matchingClosing(code, openingIndex, opening, closing);
  return end === -1 ? "" : source.slice(openingIndex + 1, end);
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

function maskConstantFalseBranches(source) {
  let result = source;
  let code = maskSource(result);
  const pattern = /\bif\s*\(\s*false\s*\)\s*\{/g;
  for (const match of code.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(code, opening, "{", "}");
    if (closing !== -1) {
      result = blankRange(result, opening + 1, closing);
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
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*async\s*\(([^)]*)\)\s*(?::[^=]+)?=>\s*\{/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const bodyStart = match.index + match[0].lastIndexOf("{");
      const bodyEnd = matchingClosing(code, bodyStart, "{", "}");
      if (bodyEnd === -1) continue;
      definitions.push({
        bodyEnd,
        bodyStart,
        end: bodyEnd + 1,
        name: match[1],
        parameters: splitTopLevel(match[2]).map((parameter) =>
          parameter.trim().replace(/^(?:\.\.\.)?/, "").split(/[?:=\s]/)[0]
        ),
        start: match.index,
      });
    }
  }
  return definitions.sort((left, right) => left.start - right.start);
}

function ownerAt(definitions, position) {
  return definitions.find(
    ({ bodyStart, bodyEnd }) => bodyStart < position && position < bodyEnd,
  );
}

function maskAfterUnconditionalReturns(source, definitions) {
  let result = source;
  for (const definition of definitions) {
    const code = maskSource(result);
    let depth = 0;
    for (
      let index = definition.bodyStart + 1;
      index < definition.bodyEnd;
      index += 1
    ) {
      if (code[index] === "{") depth += 1;
      if (code[index] === "}") depth -= 1;
      if (
        depth === 0 &&
        code.slice(index).match(/^return\s*;/)
      ) {
        const end = code.indexOf(";", index) + 1;
        result = blankRange(result, end, definition.bodyEnd);
        break;
      }
    }
  }
  return result;
}

function activeApplication(source) {
  let flowSource = maskConstantFalseBranches(source);
  let definitions = functionDefinitions(flowSource);
  flowSource = maskAfterUnconditionalReturns(flowSource, definitions);
  definitions = functionDefinitions(flowSource);

  let topLevel = flowSource;
  for (const definition of [...definitions].reverse()) {
    topLevel = blankRange(topLevel, definition.start, definition.end);
  }
  const topCode = maskSource(topLevel);
  const reachable = new Set();
  for (const definition of definitions) {
    if (new RegExp(`\\b${escapeRegExp(definition.name)}\\s*\\(`).test(topCode)) {
      reachable.add(definition.name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of definitions) {
      if (!reachable.has(definition.name)) continue;
      const body = maskSource(
        flowSource.slice(definition.bodyStart + 1, definition.bodyEnd),
      );
      for (const candidate of definitions) {
        if (
          !reachable.has(candidate.name) &&
          new RegExp(
            `(?:\\bawait\\s+|\\breturn\\s+)${escapeRegExp(candidate.name)}\\s*\\(`,
          ).test(body)
        ) {
          reachable.add(candidate.name);
          changed = true;
        }
      }
    }
  }

  let active = flowSource;
  for (const definition of [...definitions].reverse()) {
    if (!reachable.has(definition.name)) {
      active = blankRange(active, definition.start, definition.end);
    }
  }
  return {
    code: maskSource(active),
    definitions: definitions.filter(({ name }) => reachable.has(name)),
    source: active,
    topLevel,
  };
}

function runtimeImports(application, packageName, exportName) {
  const imports = new Set();
  const source = maskSource(application.source, false);
  const code = application.code;
  const named = new RegExp(
    `\\bimport\\s+(?!type\\b)\\{([^}]+)\\}\\s+from\\s+(["'])${escapeRegExp(packageName)}\\2`,
    "g",
  );
  for (const match of source.matchAll(named)) {
    if (!code.slice(match.index).startsWith("import")) continue;
    for (const specifier of splitTopLevel(match[1])) {
      const parsed = specifier.trim().match(
        /^(?!type\b)([A-Za-z_$]\w*)(?:\s+as\s+([A-Za-z_$]\w*))?$/,
      );
      if (parsed?.[1] === exportName) imports.add(parsed[2] ?? parsed[1]);
    }
  }
  const namespace = new RegExp(
    `\\bimport\\s+\\*\\s+as\\s+([A-Za-z_$]\\w*)\\s+from\\s+(["'])${escapeRegExp(packageName)}\\2`,
    "g",
  );
  for (const match of source.matchAll(namespace)) {
    if (code.slice(match.index).startsWith("import")) {
      imports.add(`${match[1]}.${exportName}`);
    }
  }
  return [...imports];
}

function referencePattern(references) {
  return references.length
    ? `(?:${references.map(escapeRegExp).join("|")})`
    : "(?!)";
}

function parsePackageJson(packageJson) {
  try {
    return JSON.parse(packageJson);
  } catch {
    return null;
  }
}

function activeDependencies(packageJson) {
  return parsePackageJson(packageJson)?.dependencies ?? {};
}

function assignedResult(source, code, callIndex) {
  const prefix = code.slice(Math.max(0, callIndex - 180), callIndex);
  return prefix.match(
    /(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*await\s*$/,
  )?.[1] ?? null;
}

function functionCalls(application) {
  const calls = [];
  for (const definition of application.definitions) {
    const pattern = new RegExp(`\\b${escapeRegExp(definition.name)}\\s*\\(`, "g");
    for (const match of application.code.matchAll(pattern)) {
      if (
        definition.start <= match.index &&
        match.index <= definition.bodyStart
      ) {
        continue;
      }
      const owner = ownerAt(application.definitions, match.index);
      const prefix = application.code.slice(
        Math.max(owner?.bodyStart ?? 0, match.index - 100),
        match.index,
      );
      if (owner && !/(?:\bawait\s+|\breturn\s+)$/.test(prefix)) continue;
      const opening = application.code.indexOf("(", match.index);
      calls.push({
        arguments: splitTopLevel(
          balancedText(application.source, opening),
        ),
        definition,
        index: match.index,
        result: assignedResult(application.source, application.code, match.index),
      });
    }
  }
  return calls;
}

function unwrap(expression) {
  let value = expression.trim()
    .replace(/\s+as\s+const\s*$/, "")
    .replace(/!\s*$/, "")
    .trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    const close = matchingClosing(maskSource(value, false), 0);
    if (close !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function literalString(expression) {
  const value = unwrap(expression);
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  if (quoted) {
    try {
      return quoted[1] === '"'
        ? JSON.parse(value)
        : quoted[2]
          .replace(/\\'/g, "'")
          .replace(/\\\\/g, "\\")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t");
    } catch {
      return null;
    }
  }
  if (/^`[^$]*`$/.test(value)) return value.slice(1, -1);
  return null;
}

function stringBindings(application, calls) {
  const values = new Map();
  const ambiguous = new Set();
  const add = (name, value) => {
    if (!name || value === null || ambiguous.has(name)) return false;
    if (values.has(name) && values.get(name) !== value) {
      values.delete(name);
      ambiguous.add(name);
      return true;
    }
    if (values.get(name) === value) return false;
    values.set(name, value);
    return true;
  };
  const resolve = (expression) => {
    let value = unwrap(expression);
    const wrapper = value.match(
      /^(?:Buffer\.from|new\s+TextEncoder\s*\(\s*\)\.encode)\s*\(([\s\S]*)\)$/,
    );
    if (wrapper) value = unwrap(wrapper[1]);
    return literalString(value) ??
      (/^[A-Za-z_$]\w*$/.test(value) ? values.get(value) ?? null : null);
  };

  let changed = true;
  while (changed) {
    changed = false;
    const declaration =
      /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*/g;
    for (const match of application.code.matchAll(declaration)) {
      const start = match.index + match[0].length;
      const end = expressionEnd(application.code, start);
      changed = add(
        match[1],
        resolve(application.source.slice(start, end)),
      ) || changed;
    }
    for (const call of calls) {
      call.definition.parameters.forEach((parameter, index) => {
        changed = add(parameter, resolve(call.arguments[index] ?? "")) || changed;
      });
    }
  }
  return { resolve, values };
}

function constructorBindings(application, references) {
  const bindings = [];
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$]\\w*)(?:\\s*:[^=;\\n]+)?\\s*=\\s*new\\s+(${referencePattern(references)})\\s*\\(`,
    "g",
  );
  for (const match of application.code.matchAll(pattern)) {
    const owner = ownerAt(application.definitions, match.index);
    const bindingRoot = match[2].split(".")[0];
    if (owner?.parameters.includes(bindingRoot)) continue;
    const prefix = application.code.slice(0, match.index);
    if (
      new RegExp(
        `\\b(?:class|function|const|let|var)\\s+${escapeRegExp(bindingRoot)}\\b`,
      ).test(prefix)
    ) {
      continue;
    }
    const opening = application.code.indexOf("(", match.index + match[0].length - 1);
    bindings.push({
      arguments: splitTopLevel(balancedText(application.source, opening)),
      index: match.index,
      name: match[1],
    });
  }
  return bindings;
}

function stableBinding(application, name, declarationIndex) {
  const tail = application.code.slice(declarationIndex);
  const declarationEnd = tail.indexOf(";");
  if (declarationEnd === -1) return false;
  return !new RegExp(
    `\\b${escapeRegExp(name)}\\s*=(?!=)`,
  ).test(tail.slice(declarationEnd + 1));
}

function isIdentifier(expression) {
  return unwrap(expression).match(/^[A-Za-z_$]\w*$/)?.[0] ?? null;
}

function methodFactoryBindings(application, receivers, method) {
  if (receivers.size === 0) return [];
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$]\\w*)(?:\\s*:[^=;\\n]+)?\\s*=\\s*(?:await\\s+)?([A-Za-z_$]\\w*)\\s*\\.\\s*${method}\\s*\\(`,
    "g",
  );
  const results = [];
  for (const match of application.code.matchAll(pattern)) {
    if (!receivers.has(match[2])) continue;
    const opening = application.code.indexOf("(", match.index + match[0].length - 1);
    results.push({
      arguments: splitTopLevel(balancedText(application.source, opening)),
      index: match.index,
      name: match[1],
      owner: match[2],
    });
  }
  return results;
}

function returnedFactory(application, definition, receivers, method) {
  const bodyCode = application.code.slice(
    definition.bodyStart + 1,
    definition.bodyEnd,
  );
  const pattern = new RegExp(
    `\\breturn\\s+([A-Za-z_$]\\w*)\\s*\\.\\s*${method}\\s*\\(`,
    "g",
  );
  for (const match of bodyCode.matchAll(pattern)) {
    if (!receivers.has(match[1])) continue;
    const absolute = definition.bodyStart + 1 + match.index;
    const opening = application.code.indexOf("(", absolute + match[0].length - 1);
    return {
      arguments: splitTopLevel(balancedText(application.source, opening)),
      index: absolute,
      owner: match[1],
    };
  }
  return null;
}

function semanticContext(workspace) {
  const application = activeApplication(workspace.source);
  const imports = {
    BlobServiceClient: runtimeImports(
      application,
      "@azure/storage-blob",
      "BlobServiceClient",
    ),
    DefaultAzureCredential: runtimeImports(
      application,
      "@azure/identity",
      "DefaultAzureCredential",
    ),
    RestError: runtimeImports(
      application,
      "@azure/core-rest-pipeline",
      "RestError",
    ),
  };
  const calls = functionCalls(application);
  const strings = stringBindings(application, calls);
  const credentialBindings = constructorBindings(
    application,
    imports.DefaultAzureCredential,
  );
  const credentials = new Set(credentialBindings.map(({ name }) => name));
  const validCredentialAt = (name, position) => {
    const binding = credentialBindings
      .filter((candidate) =>
        candidate.name === name && candidate.index < position
      )
      .at(-1);
    if (!binding) return false;
    const declarationEnd = application.code.indexOf(";", binding.index);
    if (declarationEnd === -1 || declarationEnd >= position) return false;
    return !new RegExp(
      `\\b${escapeRegExp(name)}\\s*=(?!=)`,
    ).test(application.code.slice(declarationEnd + 1, position));
  };
  const services = new Set();
  const containers = new Set();
  const blobs = new Set();
  const containerNames = new Map();
  const blobNames = new Map();

  for (const binding of constructorBindings(
    application,
    imports.BlobServiceClient,
  )) {
    const credential = binding.arguments[1] ?? "";
    const identifier = isIdentifier(credential);
    const inline = new RegExp(
      `^new\\s+${referencePattern(imports.DefaultAzureCredential)}\\s*\\(`,
    ).test(unwrap(credential));
    if (
      binding.arguments[0]?.trim() &&
      ((identifier && validCredentialAt(identifier, binding.index)) || inline) &&
      stableBinding(application, binding.name, binding.index)
    ) {
      services.add(binding.name);
    }
  }

  const addKind = (set, name) => {
    if (!name || set.has(name)) return false;
    set.add(name);
    return true;
  };
  const addNamedKind = (set, names, name, value) => {
    const changed = addKind(set, name);
    if (value !== null && !names.has(name)) names.set(name, value);
    return changed;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of methodFactoryBindings(
      application,
      services,
      "getContainerClient",
    )) {
      if (!stableBinding(application, binding.name, binding.index)) continue;
      changed = addNamedKind(
        containers,
        containerNames,
        binding.name,
        strings.resolve(binding.arguments[0] ?? ""),
      ) || changed;
    }
    for (const method of ["getBlockBlobClient", "getBlobClient"]) {
      for (const binding of methodFactoryBindings(
        application,
        containers,
        method,
      )) {
        if (!stableBinding(application, binding.name, binding.index)) continue;
        changed = addNamedKind(
          blobs,
          blobNames,
          binding.name,
          strings.resolve(binding.arguments[0] ?? ""),
        ) || changed;
      }
    }
    for (const call of calls) {
      call.definition.parameters.forEach((parameter, index) => {
        const argument = isIdentifier(call.arguments[index] ?? "");
        if (!argument) return;
        for (const [set, names] of [
          [services, null],
          [containers, containerNames],
          [blobs, blobNames],
        ]) {
          if (!set.has(argument)) continue;
          changed = addKind(set, parameter) || changed;
          if (names?.has(argument) && !names.has(parameter)) {
            names.set(parameter, names.get(argument));
          }
        }
      });
      if (!call.result) continue;
      for (const [receiverSet, resultSet, names, method] of [
        [services, containers, containerNames, "getContainerClient"],
        [containers, blobs, blobNames, "getBlockBlobClient"],
        [containers, blobs, blobNames, "getBlobClient"],
      ]) {
        const returned = returnedFactory(
          application,
          call.definition,
          receiverSet,
          method,
        );
        if (!returned) continue;
        changed = addNamedKind(
          resultSet,
          names,
          call.result,
          strings.resolve(returned.arguments[0] ?? ""),
        ) || changed;
      }
    }
  }

  return {
    application,
    blobNames,
    blobs,
    calls,
    containerNames,
    containers,
    credentials,
    imports,
    services,
    strings,
  };
}

const operationMethods = [
  "createIfNotExists",
  "exists",
  "create",
  "uploadData",
  "upload",
  "downloadToBuffer",
  "download",
  "deleteIfExists",
  "delete",
];

function executionEvents(context) {
  const { application } = context;
  const events = [];
  const scan = (source, code, offset, root, stack) => {
    const candidates = [];
    const methodPattern = new RegExp(
      `\\b([A-Za-z_$]\\w*)\\s*\\.\\s*(${operationMethods.join("|")})\\s*\\(`,
      "g",
    );
    for (const match of code.matchAll(methodPattern)) {
      const prefix = code.slice(Math.max(0, match.index - 120), match.index);
      if (!/(?:\bawait\s+|\breturn\s+)$/.test(prefix)) continue;
      const opening = code.indexOf("(", match.index + match[0].length - 1);
      candidates.push({
        arguments: splitTopLevel(balancedText(source, opening)),
        index: match.index,
        method: match[2],
        receiver: match[1],
        result: assignedResult(source, code, match.index),
        type: "method",
      });
    }
    for (const definition of application.definitions) {
      const pattern = new RegExp(`\\b${escapeRegExp(definition.name)}\\s*\\(`, "g");
      for (const match of code.matchAll(pattern)) {
        const prefix = code.slice(Math.max(0, match.index - 120), match.index);
        if (!root && !/(?:\bawait\s+|\breturn\s+)$/.test(prefix)) continue;
        const opening = code.indexOf("(", match.index);
        candidates.push({
          definition,
          index: match.index,
          type: "helper",
        });
      }
    }
    candidates.sort((left, right) => left.index - right.index);
    for (const candidate of candidates) {
      if (candidate.type === "method") {
        events.push({ ...candidate, runtimeIndex: events.length });
        continue;
      }
      if (stack.has(candidate.definition.name)) continue;
      const bodySource = application.source.slice(
        candidate.definition.bodyStart + 1,
        candidate.definition.bodyEnd,
      );
      scan(
        bodySource,
        maskSource(bodySource),
        candidate.definition.bodyStart + 1,
        false,
        new Set(stack).add(candidate.definition.name),
      );
    }
  };

  let topLevel = application.source;
  for (const definition of [...application.definitions].reverse()) {
    topLevel = blankRange(topLevel, definition.start, definition.end);
  }
  scan(topLevel, maskSource(topLevel), 0, true, new Set());
  return events;
}

function exactNamed(set, names, expected) {
  return new Set([...set].filter((name) => names.get(name) === expected));
}

function eventsFor(events, receivers, methods) {
  return events.filter(
    ({ method, receiver }) =>
      receivers.has(receiver) && methods.includes(method),
  );
}

function branchRange(code, start) {
  while (/\s/.test(code[start] ?? "")) start += 1;
  if (code[start] === "{") {
    const end = matchingClosing(code, start, "{", "}");
    return end === -1
      ? null
      : { content: code.slice(start + 1, end), end: end + 1 };
  }
  const end = expressionEnd(code, start);
  return { content: code.slice(start, end), end: Math.min(end + 1, code.length) };
}

function conditionState(condition, expression) {
  const value = unwrap(condition);
  const operand = `\\(?\\s*${expression}\\s*\\)?`;
  const matches = (pattern) => new RegExp(`^${pattern}$`).test(value);
  if (
    matches(`!\\s*${operand}`) ||
    matches(`${operand}\\s*(?:===|==)\\s*false`) ||
    matches(`false\\s*(?:===|==)\\s*${operand}`) ||
    matches(`${operand}\\s*!==\\s*true`) ||
    matches(`true\\s*!==\\s*${operand}`)
  ) {
    return "missing";
  }
  if (
    matches(operand) ||
    matches(`${operand}\\s*(?:===|==)\\s*true`) ||
    matches(`true\\s*(?:===|==)\\s*${operand}`) ||
    matches(`${operand}\\s*!==\\s*false`) ||
    matches(`false\\s*!==\\s*${operand}`)
  ) {
    return "exists";
  }
  return null;
}

function conditionalCreate(context, containers) {
  const { application } = context;
  const code = application.code;
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const opening = code.indexOf("(", match.index);
    const closing = matchingClosing(code, opening);
    if (closing === -1) continue;
    const consequent = branchRange(code, closing + 1);
    if (!consequent) continue;
    let cursor = consequent.end;
    while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    const alternate = code.startsWith("else", cursor)
      ? branchRange(code, cursor + 4)
      : null;
    const condition = code.slice(opening + 1, closing);

    for (const container of containers) {
      const receiver = escapeRegExp(container);
      const createPattern = new RegExp(
        `(?:\\bawait\\s+|\\breturn\\s+)${receiver}\\s*\\.\\s*create\\s*\\(`,
      );
      const directExists =
        `await\\s+${receiver}\\s*\\.\\s*exists\\s*\\(\\s*\\)`;
      let state = conditionState(condition, directExists);

      if (state === null) {
        const declarations = new RegExp(
          `\\b(?:const|let|var)\\s+([A-Za-z_$]\\w*)` +
            `(?:\\s*:[^=;\\n]+)?\\s*=\\s*${directExists}\\s*;`,
          "g",
        );
        for (const declaration of code.slice(0, match.index).matchAll(
          declarations,
        )) {
          const declarationIndex = declaration.index;
          if (
            ownerAt(application.definitions, declarationIndex) !==
            ownerAt(application.definitions, match.index)
          ) {
            continue;
          }
          const tail = code.slice(
            declarationIndex + declaration[0].length,
            match.index,
          );
          if (
            new RegExp(
              `\\b${escapeRegExp(declaration[1])}\\s*=(?!=)`,
            ).test(tail)
          ) {
            continue;
          }
          state = conditionState(
            condition,
            escapeRegExp(declaration[1]),
          );
        }
      }

      if (
        state === "missing" &&
        createPattern.test(consequent.content)
      ) {
        return true;
      }
      if (
        state === "exists" &&
        alternate &&
        createPattern.test(alternate.content)
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasConsoleReference(application, name) {
  return new RegExp(
    `\\bconsole\\.(?:log|info)\\s*\\([^;\\n]*\\b${escapeRegExp(name)}\\b`,
  ).test(application.code);
}

function validUploadArguments(event, strings) {
  const content = event.arguments[0] ?? "";
  if (strings.resolve(content) !== "Hello Azure!") return false;
  if (event.method === "uploadData") {
    return /^(?:Buffer\.from|new\s+TextEncoder\s*\(\s*\)\.encode)\s*\(/.test(
      unwrap(content),
    );
  }
  const length = unwrap(event.arguments[1] ?? "");
  const contentName = isIdentifier(content);
  return length === "12" ||
    (contentName !== null &&
      new RegExp(
        `^(?:${escapeRegExp(contentName)}\\.length|Buffer\\.byteLength\\(\\s*${escapeRegExp(contentName)}\\s*\\))$`,
      ).test(length));
}

function validListAndOutput(context) {
  const containers = exactNamed(
    context.containers,
    context.containerNames,
    "my-container",
  );
  const pattern =
    /\bfor\s+await\s*\(\s*(?:const|let|var)\s+([A-Za-z_$]\w*)\s+of\s+([A-Za-z_$]\w*)\s*\.\s*listBlobsFlat\s*\([^)]*\)\s*\)\s*\{/g;
  for (const match of context.application.code.matchAll(pattern)) {
    if (!containers.has(match[2])) continue;
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(
      context.application.code,
      opening,
      "{",
      "}",
    );
    if (closing === -1) continue;
    const body = context.application.source.slice(opening + 1, closing);
    if (
      new RegExp(
        `\\bconsole\\.(?:log|info)\\s*\\([\\s\\S]{0,240}?\\b${escapeRegExp(match[1])}\\s*\\.\\s*name\\b`,
      ).test(body)
    ) {
      return true;
    }
  }
  return false;
}

function helperConsumesStream(context, call, responseName) {
  const argument = call.arguments[0] ?? "";
  if (
    !new RegExp(
      `^${escapeRegExp(responseName)}\\s*\\.\\s*readableStreamBody$`,
    ).test(unwrap(argument))
  ) {
    return false;
  }
  const parameter = call.definition.parameters[0];
  if (!parameter) return false;
  const body = context.application.code.slice(
    call.definition.bodyStart + 1,
    call.definition.bodyEnd,
  );
  return (
    new RegExp(
      `\\bfor\\s+await\\s*\\([^)]*\\bof\\s+${escapeRegExp(parameter)}\\b`,
    ).test(body) ||
    new RegExp(`\\b${escapeRegExp(parameter)}\\s*\\.\\s*on\\s*\\(`).test(body) ||
    new RegExp(`\\bnew\\s+Response\\s*\\(\\s*${escapeRegExp(parameter)}\\s*\\)`).test(
      body,
    )
  ) && /\b(?:toString|text)\s*\(/.test(body);
}

function inlineConsumesStream(context, event) {
  const response = escapeRegExp(event.result);
  const code = context.application.code;
  const source = context.application.source;
  const streamNames = new Set([`${event.result}.readableStreamBody`]);
  const aliasPattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$]\\w*)[^=;\\n]*=\\s*` +
      `${response}\\s*\\.\\s*readableStreamBody\\s*;`,
    "g",
  );
  for (const alias of code.matchAll(aliasPattern)) {
    if (event.index < alias.index) streamNames.add(alias[1]);
  }
  for (const stream of streamNames) {
    const loopPattern = new RegExp(
      `\\bfor\\s+await\\s*\\(\\s*(?:const|let|var)\\s+` +
        `([A-Za-z_$]\\w*)\\s+of\\s+${escapeRegExp(stream)}\\s*\\)\\s*\\{`,
      "g",
    );
    for (const loop of code.matchAll(loopPattern)) {
      if (loop.index < event.index) continue;
      const opening = loop.index + loop[0].lastIndexOf("{");
      const closing = matchingClosing(code, opening, "{", "}");
      if (closing === -1) continue;
      const chunk = loop[1];
      const prefix = code.slice(event.end ?? event.index, loop.index);
      const arrays = [...prefix.matchAll(
        /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*\[\s*\]\s*;/g,
      )];
      for (const array of arrays) {
        const chunks = array[1];
        const body = source.slice(opening + 1, closing);
        if (
          !new RegExp(
            `\\b${escapeRegExp(chunks)}\\s*\\.\\s*push\\s*\\(` +
              `[\\s\\S]{0,240}\\b${escapeRegExp(chunk)}\\b`,
          ).test(maskSource(body, false))
        ) {
          continue;
        }
        const tail = source.slice(closing + 1);
        if (
          new RegExp(
            `\\bconsole\\s*\\.\\s*(?:log|info)\\s*\\(` +
              `[\\s\\S]{0,240}?Buffer\\s*\\.\\s*concat\\s*\\(\\s*` +
              `${escapeRegExp(chunks)}\\s*\\)\\s*\\.\\s*toString\\s*\\(` +
              `\\s*(?:["']utf-?8["'])?\\s*\\)`,
            "i",
          ).test(maskSource(tail, false))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function validDownloadAndOutput(context, events) {
  const blobs = exactNamed(context.blobs, context.blobNames, "greeting.txt");
  for (const event of eventsFor(
    events,
    blobs,
    ["download", "downloadToBuffer"],
  )) {
    if (event.method === "downloadToBuffer") {
      if (
        event.result &&
        new RegExp(
          `\\bconsole\\.(?:log|info)\\s*\\([^;\\n]*\\b${escapeRegExp(event.result)}\\s*\\.\\s*toString\\s*\\(`,
        ).test(context.application.code)
      ) {
        return true;
      }
      const receiver = escapeRegExp(event.receiver);
      if (
        new RegExp(
          `\\bconsole\\.(?:log|info)\\s*\\(\\s*\\(\\s*await\\s+${receiver}\\s*\\.\\s*downloadToBuffer\\s*\\([^)]*\\)\\s*\\)\\s*\\.\\s*toString\\s*\\(`,
        ).test(context.application.code)
      ) {
        return true;
      }
      continue;
    }
    if (!event.result) continue;
    if (inlineConsumesStream(context, event)) return true;
    for (const call of context.calls) {
      if (
        call.result &&
        helperConsumesStream(context, call, event.result) &&
        hasConsoleReference(context.application, call.result)
      ) {
        return true;
      }
    }
    const response = escapeRegExp(event.result);
    const browserText = new RegExp(
      `(?:const|let)\\s+([A-Za-z_$]\\w*)[^=]*=\\s*await\\s*\\(\\s*await\\s+${response}\\s*\\.\\s*blobBody\\s*\\)\\s*\\.\\s*text\\s*\\(\\s*\\)`,
    ).exec(context.application.code);
    if (
      browserText &&
      hasConsoleReference(context.application, browserText[1])
    ) {
      return true;
    }
  }
  return false;
}

function validRestErrorBody(body, error, reference) {
  const code = maskSource(body, false);
  const escaped = escapeRegExp(error);
  const branchPattern = new RegExp(
    `\\bif\\s*\\(\\s*${escaped}\\s+instanceof\\s+${reference}\\s*\\)\\s*\\{`,
    "g",
  );
  for (const match of code.matchAll(branchPattern)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(code, opening, "{", "}");
    if (closing === -1) continue;
    const branch = code.slice(opening + 1, closing);
    if (!new RegExp(`\\b${escaped}\\s*\\.\\s*statusCode\\b`).test(branch)) {
      continue;
    }
    const reports = [...branch.matchAll(
      /\bconsole\s*\.\s*(?:error|warn|log)\s*\(([\s\S]{0,500}?)\)\s*;/g,
    )];
    if (
      reports.some((report) => {
        const argumentsText = report[1];
        return new RegExp(
          `\\b${escaped}\\s*\\.\\s*(?:message|code)\\b`,
        ).test(argumentsText) ||
          new RegExp(
            `(?:^|,)\\s*${escaped}\\s*(?:,|$)`,
          ).test(argumentsText);
      })
    ) {
      return true;
    }
  }
  return false;
}

function validRestError(context) {
  if (context.imports.RestError.length === 0) return false;
  const reference = referencePattern(context.imports.RestError);
  const catchPattern = /\bcatch\s*\(\s*([A-Za-z_$]\w*)[^)]*\)\s*\{/g;
  for (const match of context.application.code.matchAll(catchPattern)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(
      context.application.code,
      opening,
      "{",
      "}",
    );
    if (closing === -1) continue;
    const body = context.application.code.slice(opening + 1, closing);
    if (validRestErrorBody(body, match[1], reference)) {
      return true;
    }
  }
  for (const definition of context.application.definitions) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(definition.name)}\\s*\\([^)]*\\)\\s*` +
        `\\.\\s*catch\\s*\\(`,
      "g",
    );
    for (const match of context.application.code.matchAll(pattern)) {
      if (
        definition.start <= match.index &&
        match.index <= definition.bodyEnd
      ) {
        continue;
      }
      const opening = context.application.code.indexOf(
        "(",
        match.index + match[0].lastIndexOf("catch"),
      );
      const handler = balancedText(context.application.source, opening);
      const arrow = handler.match(
        /^\s*(?:async\s*)?(?:\(\s*([A-Za-z_$]\w*)(?:\s*:[^)]*)?\)|([A-Za-z_$]\w*))\s*=>\s*\{/,
      );
      if (!arrow) continue;
      const bodyOpening = handler.indexOf("{", arrow.index);
      const body = balancedText(handler, bodyOpening, "{", "}");
      if (validRestErrorBody(body, arrow[1] ?? arrow[2], reference)) {
        return true;
      }
    }
  }
  return false;
}

const rules = {
  "prompt/packages": (workspace) => {
    if (!workspace.source.trim()) return false;
    const dependencies = activeDependencies(workspace.packageJson);
    return [
      "@azure/core-rest-pipeline",
      "@azure/identity",
      "@azure/storage-blob",
    ].every((name) => typeof dependencies[name] === "string");
  },
  "prompt/authenticated-client": (workspace) => {
    if (!workspace.source.trim()) return false;
    const context = semanticContext(workspace);
    return context.services.size > 0;
  },
  "prompt/container-create": (workspace) => {
    if (!workspace.source.trim()) return false;
    const context = semanticContext(workspace);
    const events = executionEvents(context);
    const containers = exactNamed(
      context.containers,
      context.containerNames,
      "my-container",
    );
    return eventsFor(events, containers, ["createIfNotExists"]).length > 0 ||
      conditionalCreate(context, containers);
  },
  "prompt/upload": (workspace) => {
    if (!workspace.source.trim()) return false;
    const context = semanticContext(workspace);
    const blobs = exactNamed(context.blobs, context.blobNames, "greeting.txt");
    return eventsFor(executionEvents(context), blobs, ["upload", "uploadData"])
      .some((event) => validUploadArguments(event, context.strings));
  },
  "prompt/list-and-output": (workspace) => {
    if (!workspace.source.trim()) return false;
    return validListAndOutput(semanticContext(workspace));
  },
  "prompt/download-and-output": (workspace) => {
    if (!workspace.source.trim()) return false;
    const context = semanticContext(workspace);
    return validDownloadAndOutput(context, executionEvents(context));
  },
  "prompt/delete-lifecycle": (workspace) => {
    if (!workspace.source.trim()) return false;
    const context = semanticContext(workspace);
    const events = executionEvents(context);
    const blobs = exactNamed(context.blobs, context.blobNames, "greeting.txt");
    const containers = exactNamed(
      context.containers,
      context.containerNames,
      "my-container",
    );
    const blobDeletes = eventsFor(events, blobs, ["delete", "deleteIfExists"]);
    const containerDeletes = eventsFor(
      events,
      containers,
      ["delete", "deleteIfExists"],
    );
    return blobDeletes.some((blobDelete) =>
      containerDeletes.some(
        (containerDelete) =>
          blobDelete.runtimeIndex < containerDelete.runtimeIndex,
      )
    );
  },
  "prompt/rest-error": (workspace) => {
    if (!workspace.source.trim()) return false;
    return validRestError(semanticContext(workspace));
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
