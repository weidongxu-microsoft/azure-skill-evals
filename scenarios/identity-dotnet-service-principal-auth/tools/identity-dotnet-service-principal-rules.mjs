import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const knownTypes = new Set([
  "AuthenticationFailedException",
  "BlobServiceClient",
  "ClientSecretCredential",
  "Exception",
  "Uri",
]);

const sdkTypeNamespaces = new Map([
  ["AuthenticationFailedException", "Azure.Identity"],
  ["BlobServiceClient", "Azure.Storage.Blobs"],
  ["ClientSecretCredential", "Azure.Identity"],
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchingDelimiter(source, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close && --depth === 0) return index;
  }
  return -1;
}

function literalAwareCode(source) {
  const characters = [...dotnetCodeOnly(source)];
  const literals = new Map();
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      index += 1;
      state = "line-comment";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 1;
      state = "block-comment";
      continue;
    }
    if (character === "'") {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === "'") break;
      }
      continue;
    }
    if (character !== '"') continue;

    const interpolated =
      source[index - 1] === "$" ||
      (source[index - 1] === "@" && source[index - 2] === "$") ||
      (source[index - 1] === "$" && source[index - 2] === "@");
    if (source.startsWith('"""', index) || interpolated) {
      const delimiter = source.startsWith('"""', index) ? '"""' : '"';
      const closeIndex = source.indexOf(delimiter, index + delimiter.length);
      if (closeIndex >= 0) index = closeIndex + delimiter.length - 1;
      continue;
    }

    const verbatim = source[index - 1] === "@";
    const contentStart = index + 1;
    let value = "";
    let closeIndex = -1;
    for (let cursor = contentStart; cursor < source.length; cursor += 1) {
      if (verbatim && source[cursor] === '"' && source[cursor + 1] === '"') {
        value += '"';
        cursor += 1;
      } else if (!verbatim && source[cursor] === "\\") {
        const escaped = source[cursor + 1] ?? "";
        value +=
          { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' }[escaped] ??
          escaped;
        cursor += 1;
      } else if (source[cursor] === '"') {
        closeIndex = cursor;
        break;
      } else {
        value += source[cursor];
      }
    }
    if (closeIndex < 0) continue;
    const width = closeIndex - contentStart;
    if (width > 0) {
      const marker = `L${literals.size}`.padEnd(width, "_").slice(0, width);
      for (let offset = 0; offset < width; offset += 1) {
        characters[contentStart + offset] = marker[offset];
      }
      literals.set(marker, value);
    }
    index = closeIndex;
  }

  return { code: characters.join(""), literals };
}

function typeAliases(source) {
  const aliases = new Map();
  for (const match of source.matchAll(
    /\b(?:global\s+)?using\s+(\w+)\s*=\s*((?:global::)?[\w.]+)\s*;/g,
  )) {
    aliases.set(match[1], match[2].replace(/^global::/, ""));
  }
  return aliases;
}

function typeContext(source) {
  const aliases = typeAliases(source);
  const imports = new Set();
  for (const match of source.matchAll(
    /\b(?:global\s+)?using\s+((?:global::)?[\w.]+)\s*;/g,
  )) {
    imports.add(match[1].replace(/^global::/, ""));
  }
  const localTypes = new Set(
    [
      ...source.matchAll(
        /\b(?:class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+(\w+)/g,
      ),
    ].map((match) => match[1]),
  );
  return { aliases, imports, localTypes };
}

function canonicalType(type, types) {
  if (!type) return null;
  let normalized = type
    .replace(/\s+/g, "")
    .replace(/^global::/, "")
    .replace(/[?[\]]+$/g, "");
  const aliases = types?.aliases ?? types ?? new Map();
  const first = normalized.split(/[.:]/)[0];
  if (aliases.has(first)) {
    normalized = normalized.replace(first, aliases.get(first));
  }
  if (aliases.has(normalized)) normalized = aliases.get(normalized);
  const simple = normalized.split(/[.:]/).at(-1)?.replace(/<.*>$/, "");
  if (!knownTypes.has(simple)) return null;

  const sdkNamespace = sdkTypeNamespaces.get(simple);
  if (!sdkNamespace) return simple;
  if (normalized === `${sdkNamespace}.${simple}`) return simple;
  if (normalized !== simple) return null;
  return types?.imports?.has(sdkNamespace) &&
    !types?.localTypes?.has(simple)
    ? simple
    : null;
}

function splitArguments(source) {
  const result = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (
      character === "," &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      result.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = source.slice(start).trim();
  if (final) result.push(final);
  return result;
}

function stripOuterParentheses(expression) {
  let result = expression.trim();
  while (result.startsWith("(")) {
    const close = matchingDelimiter(result, 0, "(", ")");
    if (close !== result.length - 1) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function namedArgument(expression) {
  const match = /^\s*(\w+)\s*:\s*([\s\S]+)$/.exec(expression);
  return match
    ? { name: match[1].toLowerCase(), expression: match[2].trim() }
    : { name: null, expression: expression.trim() };
}

function accessPath(expression) {
  const normalized = stripOuterParentheses(expression)
    .replace(/\s+/g, "")
    .replace(/^this\./, "");
  return /^\w+(?:\.\w+)*$/.test(normalized) ? normalized : null;
}

function lookupBinding(scopes, name) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) return scopes[index].get(name);
  }
  return null;
}

function lookupValue(state, expression) {
  const path = accessPath(expression);
  if (!path) return null;
  if (!path.includes(".")) {
    const local = lookupBinding(state.scopes, path);
    if (local) return local;
  }
  return state.members.get(path) ?? null;
}

function bind(scopes, name, binding, declaration) {
  if (declaration) {
    scopes.at(-1).set(name, binding);
    return;
  }
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) {
      scopes[index].set(name, binding);
      return;
    }
  }
  scopes.at(-1).set(name, binding);
}

function bindValue(state, expression, binding, declaration, memberDeclaration) {
  const path = accessPath(expression);
  if (!path) return;
  if (path.includes(".") || memberDeclaration || state.memberNames.has(path)) {
    state.members.set(path, binding);
  } else {
    bind(state.scopes, path, binding, declaration);
  }
}

function invalidateInstanceMembers(state, name) {
  for (const path of state.members.keys()) {
    if (path.startsWith(`${name}.`)) state.members.delete(path);
  }
}

function literalArgumentValue(expression, literals) {
  const match = /^\s*"([^"]+)"\s*$/.exec(expression);
  return match ? literals.get(match[1]) : undefined;
}

function environmentValue(expression, state) {
  const match =
    /^\s*((?:global::)?[\w.:]+)\s*\.\s*GetEnvironmentVariable\s*\(\s*("[^"]+")\s*\)\s*!?\s*([\s\S]*)$/.exec(
      expression,
    );
  if (!match) return null;
  let receiver = match[1].replace(/^global::/, "");
  const first = receiver.split(/[.:]/)[0];
  if (state.aliases.has(first)) receiver = receiver.replace(first, state.aliases.get(first));
  if (!["Environment", "System.Environment"].includes(receiver)) return null;
  const fallback = match[3].trim();
  if (fallback && !/^\?\?\s*throw\b[\s\S]+$/.test(fallback)) return null;
  const variable = literalArgumentValue(match[2], state.literals);
  const kinds = {
    AZURE_TENANT_ID: "tenant-id",
    AZURE_CLIENT_ID: "client-id",
    AZURE_CLIENT_SECRET: "client-secret",
    AZURE_STORAGE_BLOB_ENDPOINT: "endpoint-value",
  };
  const kind = kinds[variable] ?? "unknown";
  if (kind !== "unknown") state.environmentKinds.add(kind);
  return { kind };
}

function constructor(expression, expectedType, types) {
  const value = stripOuterParentheses(expression);
  const match = /^\s*new\s*([\w:.]+)?\s*(\(|\{)/.exec(value);
  if (!match) return null;
  const openIndex = value.indexOf(match[2], match.index);
  const close = match[2] === "(" ? ")" : "}";
  const closeIndex = matchingDelimiter(value, openIndex, match[2], close);
  if (closeIndex < 0) return null;
  return {
    type: match[1]
      ? canonicalType(match[1], types)
      : canonicalType(expectedType, types),
    arguments:
      match[2] === "(" ? value.slice(openIndex + 1, closeIndex) : "",
  };
}

function orderedCredentialArguments(argumentsSource, state) {
  const parameters = ["tenantid", "clientid", "clientsecret", "options"];
  const values = new Array(4).fill(null);
  let positionalIndex = 0;
  for (const raw of splitArguments(argumentsSource)) {
    const argument = namedArgument(raw);
    let index;
    if (argument.name) {
      index = parameters.indexOf(argument.name);
      if (index < 0 || values[index] !== null) return null;
    } else {
      while (values[positionalIndex] !== null) positionalIndex += 1;
      index = positionalIndex;
      positionalIndex += 1;
    }
    if (index >= values.length) return null;
    values[index] = evaluateExpression(argument.expression, null, state);
  }
  return values;
}

function isAuthenticatedCredential(binding) {
  return binding?.kind === "client-secret-credential" && binding.valid;
}

function awaitedOperation(expression, state) {
  const match =
    /\bawait\s*(?:\(\s*)*((?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*)\s*\.\s*GetAccountInfoAsync\s*\(/.exec(
      expression,
    );
  if (!match) return null;
  const client = lookupValue(state, match[1]);
  const authenticated =
    client?.kind === "blob-client" && client.authenticated === true;
  if (authenticated) state.operationFound = true;
  return { kind: "response", authenticated };
}

function evaluateExpression(expression, expectedType, state) {
  const value = stripOuterParentheses(namedArgument(expression).expression);
  const environment = environmentValue(value, state);
  if (environment) return environment;

  const accessor = environmentAccessorValue(value, state);
  if (accessor) return accessor;

  const operation = awaitedOperation(value, state);
  if (operation) {
    if (/\.Value\s*$/.test(value)) {
      return { kind: "account-info", authenticated: operation.authenticated };
    }
    const field = /\.Value\s*\.\s*(AccountKind|SkuName)\s*$/.exec(value)?.[1];
    return field
      ? { kind: "account-field", authenticated: operation.authenticated, field }
      : operation;
  }

  const property =
    /^\s*((?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*)\s*\.\s*(?:Value\s*\.\s*)?(AccountKind|SkuName)\s*$/.exec(
      value,
    );
  if (property) {
    const binding = lookupValue(state, property[1]);
    if (
      binding?.authenticated &&
      ["response", "account-info"].includes(binding.kind)
    ) {
      return {
        kind: "account-field",
        authenticated: true,
        field: property[2],
      };
    }
  }

  const responseValue =
    /^\s*((?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*)\s*\.\s*Value\s*$/.exec(
      value,
    );
  if (responseValue) {
    const binding = lookupValue(state, responseValue[1]);
    if (binding?.kind === "response") {
      return { kind: "account-info", authenticated: binding.authenticated };
    }
  }

  const reference = accessPath(value);
  if (reference) {
    const binding = lookupValue(state, reference);
    return binding ? { ...binding } : { kind: "unknown" };
  }

  const created = constructor(value, expectedType, state.types);
  if (!created?.type) return { kind: "unknown" };
  const argumentsList = splitArguments(created.arguments);

  if (created.type === "ClientSecretCredential") {
    const values = orderedCredentialArguments(created.arguments, state);
    const valid =
      values?.length === 4 &&
      values[0]?.kind === "tenant-id" &&
      values[1]?.kind === "client-id" &&
      values[2]?.kind === "client-secret";
    if (valid) state.credentialFound = true;
    return { kind: "client-secret-credential", valid };
  }
  if (created.type === "Uri") {
    const endpoint =
      argumentsList.length > 0
        ? evaluateExpression(argumentsList[0], null, state)
        : null;
    return endpoint?.kind === "endpoint-value"
      ? { kind: "endpoint" }
      : { kind: "unknown" };
  }
  if (created.type === "BlobServiceClient") {
    const values = argumentsList.map((argument) =>
      evaluateExpression(argument, null, state),
    );
    const endpoint = values.some((binding) =>
      ["endpoint", "endpoint-value"].includes(binding?.kind),
    );
    const authenticated = endpoint && values.some(isAuthenticatedCredential);
    if (authenticated) state.associationFound = true;
    return { kind: "blob-client", authenticated };
  }
  return { kind: "unknown" };
}

function visibleBindings(state) {
  const result = new Map(state.members);
  for (const scope of state.scopes) {
    for (const [name, binding] of scope) result.set(name, binding);
  }
  return result;
}

function recordOutput(expression, state) {
  const direct = awaitedOperation(expression, state);
  if (direct?.authenticated) {
    for (const field of ["AccountKind", "SkuName"]) {
      if (new RegExp(`\\b${field}\\b`).test(expression)) {
        state.printedFields.add(field);
      }
    }
  }
  for (const [name, binding] of visibleBindings(state)) {
    const reference = name
      .split(".")
      .map(escapeRegExp)
      .join(String.raw`\s*\.\s*`);
    if (
      binding?.kind === "account-field" &&
      binding.authenticated &&
      new RegExp(String.raw`\b(?:this\s*\.\s*)?${reference}\b`).test(expression)
    ) {
      state.printedFields.add(binding.field);
    }
    if (
      binding?.authenticated &&
      ["response", "account-info"].includes(binding.kind)
    ) {
      for (const field of ["AccountKind", "SkuName"]) {
        if (
          new RegExp(
            String.raw`\b(?:this\s*\.\s*)?${reference}\s*\.\s*(?:Value\s*\.\s*)?${field}\b`,
          ).test(expression)
        ) {
          state.printedFields.add(field);
        }
      }
    }
  }
}

function loggingArgument(statement) {
  const match =
    /^\s*(?:(?:System\s*\.\s*)?Console\s*\.\s*(?:Error\s*\.\s*|Out\s*\.\s*)?(?:Write|WriteLine)|(?:System\s*\.\s*Diagnostics\s*\.\s*)?(?:Debug|Trace)\s*\.\s*(?:Write|WriteLine|Trace\w*)|(?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*\s*\.\s*Log(?:Trace|Debug|Information|Warning|Error|Critical)?)\s*\(([\s\S]*)\)\s*$/.exec(
      statement,
    );
  return match?.[1] ?? null;
}

function processStatement(statement, state) {
  const output = loggingArgument(statement);
  if (output !== null) {
    recordOutput(output, state);
    return;
  }

  const declaration =
    /^\s*((?:(?:public|private|protected|internal|static|readonly|volatile|required|new|unsafe|const)\s+)*)(?:await\s+)?(?:using\s+)?(var|(?:global::)?[\w.:<>?[\]]+)\s+(\w+)\s*=\s*([\s\S]+)$/.exec(
      statement,
    );
  if (declaration) {
    const memberDeclaration =
      declaration[1].trim() !== "" && state.memberNames.has(declaration[3]);
    const expectedType =
      declaration[2] === "var"
        ? state.memberTypes.get(declaration[3]) ?? declaration[2]
        : declaration[2];
    const binding = evaluateExpression(declaration[4], expectedType, state);
    invalidateInstanceMembers(state, declaration[3]);
    bindValue(state, declaration[3], binding, true, memberDeclaration);
    return;
  }

  const assignment =
    /^\s*((?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*)\s*=\s*([\s\S]+)$/.exec(
      statement,
    );
  if (assignment) {
    const path = accessPath(assignment[1]);
    const previous = lookupValue(state, assignment[1]);
    const expectedType =
      previous?.declaredType ??
      state.memberTypes.get(path) ??
      state.memberTypes.get(path?.split(".").at(-1)) ??
      null;
    if (path && !path.includes(".")) invalidateInstanceMembers(state, path);
    bindValue(
      state,
      assignment[1],
      evaluateExpression(assignment[2], expectedType, state),
      false,
      false,
    );
    return;
  }

  awaitedOperation(statement, state);
}

function methodDefinitions(code) {
  const methods = new Map();
  const pattern =
    /\b((?:(?:public|private|protected|internal|static|virtual|override|sealed|new|unsafe|extern|async|partial)\s+)*)(?:[\w.:<>\[\]?]+\s+)(\w+)\s*\(([^()]*)\)\s*(=>|\{)/g;
  const ignored = new Set(["if", "for", "foreach", "while", "switch", "catch"]);
  let id = 0;
  for (const match of code.matchAll(pattern)) {
    if (ignored.has(match[2])) continue;
    const parameters = splitArguments(match[3])
      .map((parameter) =>
        /(?:^|[\s.])([A-Za-z_]\w*)\s*(?:=[\s\S]*)?$/.exec(
          parameter.replace(/\[[^\]]*\]/g, "").trim(),
        )?.[1],
      )
      .filter(Boolean);
    let body;
    let bodyStart;
    let bodyEnd;
    if (match[4] === "{") {
      const open = match.index + match[0].lastIndexOf("{");
      const close = matchingDelimiter(code, open, "{", "}");
      if (close < 0) continue;
      body = code.slice(open + 1, close);
      bodyStart = open + 1;
      bodyEnd = close;
    } else {
      const start = match.index + match[0].length;
      let end = start;
      let parentheses = 0;
      for (; end < code.length; end += 1) {
        if (code[end] === "(") parentheses += 1;
        else if (code[end] === ")") parentheses -= 1;
        else if (code[end] === ";" && parentheses === 0) break;
      }
      body = `return ${code.slice(start, end)};`;
      bodyStart = start;
      bodyEnd = end;
    }
    id += 1;
    const definition = {
      body,
      bodyEnd,
      bodyStart,
      id,
      modifiers: match[1].trim().split(/\s+/).filter(Boolean),
      name: match[2],
      parameters,
      start: match.index,
    };
    const overloads = methods.get(definition.name) ?? [];
    overloads.push(definition);
    methods.set(definition.name, overloads);
  }
  return methods;
}

function environmentAccessorSummaries(code, types) {
  const summaries = new Map();
  const methods = methodDefinitions(code);
  const allDefinitions = [...methods.values()].flat();
  const typeRanges = [];
  for (const match of code.matchAll(
    /\b(?:class|record|struct)\s+\w+[^{;]*\{/g,
  )) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(code, open, "{", "}");
    if (close >= 0) typeRanges.push({ start: open + 1, end: close });
  }
  for (const definitions of methods.values()) {
    for (const definition of definitions) {
      const local =
        !typeRanges.some(
          (range) =>
            range.start <= definition.start && definition.bodyEnd < range.end,
        ) ||
        allDefinitions.some(
          (candidate) =>
            candidate !== definition &&
            candidate.bodyStart <= definition.start &&
            definition.bodyEnd <= candidate.bodyEnd,
        );
      if (!local && !definition.modifiers.includes("static")) continue;

      const derived = new Set();
      let sourceParameter = null;
      let returnedParameter = null;
      let unsafe = false;
      const environmentParameter = (expression) => {
        const match =
          /^\s*((?:global::)?[\w.:]+)\s*\.\s*GetEnvironmentVariable\s*\(\s*(\w+)\s*\)\s*!?\s*([\s\S]*)$/.exec(
            expression,
          );
        if (!match) return null;
        let receiver = match[1].replace(/^global::/, "");
        const first = receiver.split(/[.:]/)[0];
        if (types.aliases.has(first)) {
          receiver = receiver.replace(first, types.aliases.get(first));
        }
        const parameterIndex = definition.parameters.indexOf(match[2]);
        const fallback = match[3].trim();
        return ["Environment", "System.Environment"].includes(receiver) &&
            parameterIndex >= 0 &&
            (!fallback || /^\?\?\s*throw\b[\s\S]+$/.test(fallback))
          ? parameterIndex
          : null;
      };

      for (const statement of taintStatements(definition.body)) {
        const environmentDeclaration =
          /^\s*(?:string\s*\?|string|var)\s+(\w+)\s*=\s*([\s\S]+)$/.exec(
            statement,
          );
        if (environmentDeclaration) {
          const parameterIndex = environmentParameter(
            environmentDeclaration[2],
          );
          if (parameterIndex !== null) {
            if (sourceParameter !== null) {
              unsafe = true;
              continue;
            }
            sourceParameter = parameterIndex;
            derived.add(environmentDeclaration[1]);
            continue;
          }
          const alias = accessPath(
            stripOuterParentheses(environmentDeclaration[2]).replace(/!+$/, ""),
          );
          if (alias && derived.has(alias)) {
            derived.add(environmentDeclaration[1]);
          }
          continue;
        }

        const assignment =
          /^\s*(\w+)\s*(\?\?=|=)\s*([\s\S]+)$/.exec(statement);
        if (assignment && derived.has(assignment[1])) {
          const alias = accessPath(
            stripOuterParentheses(assignment[3]).replace(/!+$/, ""),
          );
          if (assignment[2] !== "=" || !alias || !derived.has(alias)) {
            derived.delete(assignment[1]);
          }
          continue;
        }

        const output = loggingArgument(statement);
        if (
          output !== null &&
          [...derived].some((name) =>
            new RegExp(String.raw`\b${escapeRegExp(name)}\b`).test(output)
          )
        ) {
          unsafe = true;
        }

        const returned = /^\s*return\s+([\s\S]+)$/.exec(statement)?.[1];
        if (returned) {
          const parameterIndex = environmentParameter(returned);
          if (parameterIndex !== null) {
            if (
              sourceParameter !== null &&
              sourceParameter !== parameterIndex
            ) {
              unsafe = true;
            } else {
              sourceParameter = parameterIndex;
              returnedParameter = parameterIndex;
            }
            continue;
          }
          const alias = accessPath(
            stripOuterParentheses(returned).replace(/!+$/, ""),
          );
          if (alias && derived.has(alias)) returnedParameter = sourceParameter;
        }
      }

      if (!unsafe && sourceParameter !== null && returnedParameter !== null) {
        const entries = summaries.get(definition.name) ?? [];
        entries.push({
          arity: definition.parameters.length,
          parameters: definition.parameters,
          sourceParameter: returnedParameter,
        });
        summaries.set(definition.name, entries);
      }
    }
  }
  return summaries;
}

function environmentAccessorValue(expression, state) {
  const calls = invocations(expression);
  const call = calls.find(
    (candidate) =>
      candidate.start === 0 &&
      candidate.end === expression.length &&
      !candidate.constructed,
  );
  if (!call) return null;
  const name = call.name.split(/[.:]/).at(-1);
  const argumentsList = splitArguments(call.arguments).map(namedArgument);
  const candidates = (state.environmentAccessors.get(name) ?? []).filter(
    (summary) => summary.arity === argumentsList.length,
  );
  const kinds = new Set();
  for (const summary of candidates) {
    const ordered = new Array(summary.arity).fill(null);
    let positional = 0;
    let valid = true;
    for (const argument of argumentsList) {
      const index = argument.name
        ? summary.parameters.findIndex(
            (parameter) =>
              parameter.toLowerCase() === argument.name.toLowerCase(),
          )
        : positional++;
      if (index < 0 || ordered[index] !== null) {
        valid = false;
        break;
      }
      ordered[index] = argument.expression;
    }
    if (!valid) continue;
    const variable = literalArgumentValue(
      ordered[summary.sourceParameter] ?? "",
      state.literals,
    );
    const kind = {
      AZURE_TENANT_ID: "tenant-id",
      AZURE_CLIENT_ID: "client-id",
      AZURE_CLIENT_SECRET: "client-secret",
      AZURE_STORAGE_BLOB_ENDPOINT: "endpoint-value",
    }[variable];
    if (kind) kinds.add(kind);
  }
  if (kinds.size !== 1) return null;
  const kind = [...kinds][0];
  state.environmentKinds.add(kind);
  return { kind };
}

function taintStatements(source) {
  const statements = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let initializerBraces = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "{") {
      const prefix = source.slice(start, index);
      const initializer =
        parentheses > 0 ||
        brackets > 0 ||
        initializerBraces > 0 ||
        (/=/.test(prefix) && /\bnew\b/.test(prefix));
      if (initializer) initializerBraces += 1;
      else start = index + 1;
    } else if (character === "}") {
      if (initializerBraces > 0) initializerBraces -= 1;
      else start = index + 1;
    } else if (
      character === ";" &&
      parentheses === 0 &&
      brackets === 0 &&
      initializerBraces === 0
    ) {
      const statement = source.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  return statements;
}

function taintReference(expression, tainted) {
  for (const name of tainted) {
    const segments = name.split(".");
    const path = segments.map(escapeRegExp).join(String.raw`\s*\.\s*`);
    if (
      new RegExp(String.raw`\b(?:this\s*\.\s*)?${path}\b`).test(expression)
    ) {
      return true;
    }
    for (let length = 1; length < segments.length; length += 1) {
      const aggregate = segments
        .slice(0, length)
        .map(escapeRegExp)
        .join(String.raw`\s*\.\s*`);
      if (
        new RegExp(
          String.raw`\b(?:this\s*\.\s*)?${aggregate}\b(?!\s*\.)`,
        ).test(expression)
      ) {
        return true;
      }
    }
  }
  return false;
}

function taintAccessPath(expression) {
  const normalized = stripOuterParentheses(expression)
    .replace(
      /\[\s*(?:"([^"]+)"|'([^']+)'|(\d+))\s*\]/g,
      (_match, double, single, number) => `.${double ?? single ?? number}`,
    )
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, "")
    .replace(/^this\./, "");
  return /^\w+(?:\.\w+)*$/.test(normalized) ? normalized : null;
}

function invocations(expression) {
  const calls = [];
  const pattern =
    /((?:global::)?[A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*)*)\s*\(/g;
  for (const match of expression.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf("(");
    const close = matchingDelimiter(expression, open, "(", ")");
    if (close < 0) continue;
    calls.push({
      arguments: expression.slice(open + 1, close),
      constructed: /\bnew\s*$/.test(expression.slice(0, match.index)),
      end: close + 1,
      name: match[1],
      start: match.index,
    });
  }
  return calls;
}

function isLoggingCall(name) {
  return /^(?:(?:System\.)?Console\.(?:(?:Error|Out)\.)?(?:Write|WriteLine)|(?:System\.Diagnostics\.)?(?:Debug|Trace)\.(?:Write|WriteLine|Trace\w*)|(?:\w+\.)+Log(?:Trace|Debug|Information|Warning|Error|Critical)?)$/.test(
    name.replace(/^global::/, ""),
  );
}

function allocationIdentityTaint(
  source,
  methods,
  secretMarkers,
  literals,
  environmentAccessors,
) {
  const objects = new Map();
  const cleanSinks = new Set();
  let nextObjectId = 1;
  let exposed = false;

  const value = (tainted = false, ids = [], derived = false) => ({
    derived,
    ids: new Set(ids),
    tainted,
  });
  const merge = (...values) => {
    const merged = value();
    for (const item of values) {
      if (!item) continue;
      merged.tainted ||= item.tainted;
      merged.derived ||= item.derived;
      for (const id of item.ids) merged.ids.add(id);
    }
    return merged;
  };
  const allocate = () => {
    const id = nextObjectId;
    nextObjectId += 1;
    objects.set(id, new Map());
    return value(false, [id]);
  };
  const descendantTainted = (item, seen = new Set()) => {
    if (item?.tainted) return true;
    for (const id of item?.ids ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of objects.get(id)?.values() ?? []) {
        if (descendantTainted(child, seen)) return true;
      }
    }
    return false;
  };
  const normalize = (path) => {
    const normalized = stripOuterParentheses(path)
      .replace(
        /\[\s*(?:"([^"]+)"|'([^']+)'|(\d+))\s*\]/g,
        (_match, double, single, number) => `.${double ?? single ?? number}`,
      )
      .replace(/\[[^\]]+\]/g, ".*")
      .replace(/\s+/g, "")
      .replace(/^this\./, "");
    return /^\w+(?:\.(?:\w+|\*))*$/.test(normalized)
      ? normalized
      : null;
  };
  const pathSegments = (path, environment) => {
    const normalized = normalize(path);
    if (!normalized) return null;
    const segments = normalized.split(".");
    if (!environment.has(segments[0]) && environment.has("this")) {
      segments.unshift("this");
    }
    return segments;
  };
  const readPath = (path, environment) => {
    const segments = pathSegments(path, environment);
    if (!segments) return value();
    let current = environment.get(segments[0]) ?? value();
    for (const segment of segments.slice(1)) {
      const next = [];
      for (const id of current.ids) {
        const edges = objects.get(id);
        next.push(edges?.get(segment), edges?.get("*"));
      }
      current = merge(...next, value(false, [], true));
    }
    return current;
  };
  const writePath = (path, next, environment) => {
    const segments = pathSegments(path, environment);
    if (!segments) return;
    if (segments.length === 1) {
      environment.set(segments[0], next);
      return;
    }
    let current = environment.get(segments[0]);
    if (!current || current.ids.size === 0) {
      current = allocate();
      environment.set(segments[0], current);
    }
    for (const segment of segments.slice(1, -1)) {
      const children = [];
      for (const id of current.ids) {
        const edges = objects.get(id);
        let child = edges.get(segment);
        if (!child || child.ids.size === 0) {
          child = allocate();
          edges.set(segment, child);
        }
        children.push(child);
      }
      current = merge(...children);
    }
    const field = segments.at(-1);
    for (const id of current.ids) {
      objects.get(id)?.set(field, next);
    }
  };

  const declaration =
    /^\s*(?:(?:public|private|protected|internal|static|readonly|volatile|required|new|unsafe|const|await|using)\s+)*(?:var|(?:global::)?[\w.:<>?[\]]+)\s+(\w+)\s*=\s*([\s\S]+)$/;
  const assignment =
    /^\s*((?:this\s*\.\s*)?\w+(?:\s*(?:\.\s*\w+|\[[^\]]+\]))*)\s*=\s*([\s\S]+)$/;
  const executeDefinition = (definition, argumentsList, receiver, depth) => {
    if (depth > 128) return value();
    const environment = new Map();
    definition.parameters.forEach((parameter, index) => {
      environment.set(parameter, argumentsList[index] ?? value());
    });
    if (receiver) environment.set("this", receiver);
    return execute(definition.body, environment, depth + 1).returned;
  };
  const expressionValue = (expression, environment, depth) => {
    let text = stripOuterParentheses(expression.trim());
    text = text.replace(/^await\s+/, "").replace(/!+$/, "");
    if (
      /Environment\s*\.\s*GetEnvironmentVariable\s*\(\s*["']AZURE_CLIENT_SECRET["']/.test(
        text,
      ) ||
      [...secretMarkers].some((marker) =>
        new RegExp(
          String.raw`Environment\s*\.\s*GetEnvironmentVariable\s*\(\s*["']${escapeRegExp(marker)}["']`,
        ).test(text)
      )
    ) {
      return value(true);
    }

    const path = normalize(text);
    if (path) return readPath(path, environment);

    const calls = invocations(text);
    const whole = calls.find(
      (call) =>
        call.start === 0 &&
        call.end === text.length &&
        (methods.get(call.name.split(/[.:]/).at(-1))?.length ?? 0) > 0,
    );
    if (whole) {
      const parsedArguments = splitArguments(whole.arguments).map(namedArgument);
      const simpleName = whole.name.split(/[.:]/).at(-1);
      for (const accessor of environmentAccessors.get(simpleName) ?? []) {
        if (accessor.arity !== parsedArguments.length) continue;
        const ordered = new Array(accessor.arity).fill(null);
        let positional = 0;
        let valid = true;
        for (const argument of parsedArguments) {
          const index = argument.name
            ? accessor.parameters.findIndex(
                (parameter) =>
                  parameter.toLowerCase() === argument.name.toLowerCase(),
              )
            : positional++;
          if (index < 0 || ordered[index] !== null) {
            valid = false;
            break;
          }
          ordered[index] = argument.expression;
        }
        if (
          valid &&
          literalArgumentValue(
            ordered[accessor.sourceParameter] ?? "",
            literals,
          ) === "AZURE_CLIENT_SECRET"
        ) {
          return value(true);
        }
      }
      const argumentsList = parsedArguments.map((argument) =>
        expressionValue(argument.expression, environment, depth)
      );
      const receiverPath = whole.name.split(/[.:]/).slice(0, -1).join(".");
      const receiver = receiverPath
        ? readPath(receiverPath, environment)
        : environment.get("this");
      const result = merge(
        ...(methods.get(simpleName) ?? [])
          .filter(
            (definition) =>
              definition.parameters.length === argumentsList.length,
          )
          .map((definition) =>
            executeDefinition(definition, argumentsList, receiver, depth)
          ),
      );
      return result;
    }

    if (/^new\b|^new\s*\(/.test(text)) {
      const result = allocate();
      if (/ClientSecretCredential/.test(text)) return result;
      const initializer = /\{([\s\S]*)\}\s*$/.exec(text)?.[1];
      if (initializer) {
        for (const entry of splitArguments(initializer)) {
          const field =
            /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(entry);
          if (field) {
            for (const id of result.ids) {
              objects.get(id).set(
                field[1],
                expressionValue(field[2], environment, depth),
              );
            }
          } else {
            const child = expressionValue(entry, environment, depth);
            for (const id of result.ids) {
              objects.get(id).set(
                "*",
                merge(objects.get(id).get("*"), child),
              );
            }
          }
        }
      }
      return result;
    }

    const question = text.indexOf("?");
    const colon = question < 0 ? -1 : text.indexOf(":", question + 1);
    if (colon > question) {
      return merge(
        expressionValue(text.slice(question + 1, colon), environment, depth),
        expressionValue(text.slice(colon + 1), environment, depth),
      );
    }

    const code = literalAwareCode(text).code;
    const references = [];
    for (const match of code.matchAll(
      /(?<![\w.])(?:this\s*\.\s*)?[A-Za-z_]\w*(?:\s*(?:\.\s*[A-Za-z_]\w+|\[[^\]]+\]))*/g,
    )) {
      references.push(readPath(match[0], environment));
    }
    return merge(...references);
  };

  const execute = (region, environment, depth = 0) => {
    let returned = value();
    for (const statement of taintStatements(region)) {
      const declared = declaration.exec(statement);
      if (declared) {
        writePath(
          declared[1],
          expressionValue(declared[2], environment, depth),
          environment,
        );
        continue;
      }
      const assigned = assignment.exec(statement);
      if (assigned) {
        writePath(
          assigned[1],
          expressionValue(assigned[2], environment, depth),
          environment,
        );
        continue;
      }
      const returnedExpression = /^\s*return\s+([\s\S]+)$/.exec(statement);
      if (returnedExpression) {
        returned = merge(
          returned,
          expressionValue(returnedExpression[1], environment, depth),
        );
        continue;
      }
      for (const call of invocations(statement)) {
        const simpleName = call.name.split(/[.:]/).at(-1);
        const argumentsList = splitArguments(call.arguments).map((argument) =>
          expressionValue(namedArgument(argument).expression, environment, depth),
        );
        if (isLoggingCall(call.name)) {
          if (argumentsList.some((argument) => descendantTainted(argument))) {
            exposed = true;
          } else if (
            argumentsList.some(
              (argument) => argument.derived || argument.ids.size > 0,
            )
          ) {
            cleanSinks.add(statement);
          }
          continue;
        }
        const receiverPath = call.name.split(/[.:]/).slice(0, -1).join(".");
        const receiver = receiverPath
          ? readPath(receiverPath, environment)
          : environment.get("this");
        if (/^(?:Add|AddRange|Enqueue|Push|Set)$/.test(simpleName) && receiver) {
          writePath(
            `${receiverPath}[*]`,
            merge(readPath(`${receiverPath}[*]`, environment), ...argumentsList),
            environment,
          );
        }
        for (const definition of methods.get(simpleName) ?? []) {
          if (definition.parameters.length === argumentsList.length) {
            executeDefinition(definition, argumentsList, receiver, depth);
          }
        }
      }
    }
    return { returned };
  };

  let root = source;
  const definitions = [...methods.values()].flat();
  for (const definition of definitions.sort(
    (left, right) => right.start - left.start,
  )) {
    root =
      root.slice(0, definition.start) +
      root.slice(definition.start, definition.bodyEnd + 1).replace(/[^\n]/g, " ") +
      root.slice(definition.bodyEnd + 1);
  }
  execute(root, new Map());

  let sanitized = source;
  for (const statement of cleanSinks) {
    sanitized = sanitized.replaceAll(statement, statement.replace(/[^\n]/g, " "));
  }
  return { exposed, source: sanitized };
}

function secretExposureAnalysis(
  code,
  literals,
  types,
  environmentAccessors,
) {
  const methods = methodDefinitions(code);
  const secretMarkers = new Set(
    [...literals]
      .filter(([, value]) => value === "AZURE_CLIENT_SECRET")
      .map(([marker]) => marker),
  );
  const identity = allocationIdentityTaint(
    code,
    methods,
    secretMarkers,
    literals,
    environmentAccessors,
  );
  if (identity.exposed) return true;
  code = identity.source;
  const memo = new Map();
  const active = new Set();

  const resultSignature = (result) =>
    JSON.stringify({
      exposed: result.exposed,
      formalUpdates: [...result.formalUpdates].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      memberUpdates: [...result.memberUpdates].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      returnTainted: result.returnTainted,
    });

  const fragment = (
    source,
    initialTainted = new Set(),
    parameters = new Set(),
  ) => {
    const tainted = new Set(initialTainted);
    const callableAliases = new Map();
    const localNames = new Set();
    const formalUpdates = new Map();
    const memberUpdates = new Map();
    let exposed = false;
    let returnTainted = false;
    const formalPath = (path) =>
      [...parameters].find(
        (parameter) =>
          path === parameter || path.startsWith(`${parameter}.`),
      );
    const recordMutation = (path, isTainted) => {
      const parameter = formalPath(path);
      if (parameter) {
        formalUpdates.set(path, isTainted);
        return;
      }
      const root = path.split(".")[0];
      if (!localNames.has(root)) memberUpdates.set(path, isTainted);
    };

    const callResult = (call) => {
      const parsedArguments = splitArguments(call.arguments).map(namedArgument);
      const argumentExpressions = parsedArguments.map(
        (argument) => argument.expression,
      );
      const argumentTaints = argumentExpressions.map((argument) =>
        expressionTainted(argument),
      );
      const simpleName =
        callableAliases.get(call.name) ?? call.name.split(/[.:]/).at(-1);
      if (isLoggingCall(call.name)) {
        return { exposed: argumentTaints.some(Boolean), tainted: false };
      }
      const receiver = call.name
        .split(/[.:]/)
        .slice(0, -1)
        .join(".")
        .replace(/^this(?:\.|$)/, "");
      if (
        simpleName === "Add" &&
        receiver &&
        argumentTaints.some(Boolean)
      ) {
        const path = taintAccessPath(receiver);
        if (path) {
          tainted.add(path);
          recordMutation(path, true);
        }
      }

      const environmentReceiver = call.name
        .replace(/^global::/, "")
        .replace(
          /^([A-Za-z_]\w*)/,
          (first) => types.aliases.get(first) ?? first,
        );
      if (
        environmentReceiver.endsWith("Environment.GetEnvironmentVariable") &&
        [...secretMarkers].some((marker) =>
          new RegExp(String.raw`["']${escapeRegExp(marker)}["']`).test(
            call.arguments,
          ),
        )
      ) {
        return { exposed: false, tainted: true };
      }

      const accessorDefinitions =
        environmentAccessors.get(simpleName) ?? [];
      for (const accessor of accessorDefinitions) {
        if (accessor.arity !== parsedArguments.length) continue;
        const ordered = new Array(accessor.arity).fill(null);
        let positional = 0;
        let valid = true;
        for (const argument of parsedArguments) {
          const index = argument.name
            ? accessor.parameters.findIndex(
                (parameter) =>
                  parameter.toLowerCase() === argument.name.toLowerCase(),
              )
            : positional++;
          if (index < 0 || ordered[index] !== null) {
            valid = false;
            break;
          }
          ordered[index] = argument.expression;
        }
        if (
          valid &&
          literalArgumentValue(
            ordered[accessor.sourceParameter] ?? "",
            literals,
          ) === "AZURE_CLIENT_SECRET"
        ) {
          return { exposed: false, tainted: true };
        }
      }

      const definitions = (methods.get(simpleName) ?? []).filter(
        (definition) =>
          definition.parameters.length === argumentExpressions.length,
      );
      if (definitions.length > 0) {
        const receiver = call.name
          .split(/[.:]/)
          .slice(0, -1)
          .join(".")
          .replace(/^this(?:\.|$)/, "");
        let callExposed = false;
        let callTainted = false;
        const updates = new Map();
        for (const definition of definitions) {
          const mappedTaints = new Array(definition.parameters.length).fill(
            false,
          );
          const mappedArguments = new Array(definition.parameters.length).fill(
            null,
          );
          let positionalIndex = 0;
          for (let index = 0; index < parsedArguments.length; index += 1) {
            const argument = parsedArguments[index];
            let parameterIndex;
            if (argument.name) {
              parameterIndex = definition.parameters.findIndex(
                (parameter) =>
                  parameter.toLowerCase() === argument.name.toLowerCase(),
              );
            } else {
              while (mappedTaints[positionalIndex] !== false) {
                positionalIndex += 1;
              }
              parameterIndex = positionalIndex;
              positionalIndex += 1;
            }
            if (parameterIndex >= 0) {
              mappedTaints[parameterIndex] = argumentTaints[index] || null;
              mappedArguments[parameterIndex] = argumentExpressions[index];
            }
          }
          const receiverTaints = new Set();
          for (const path of tainted) {
            if (receiver && path.startsWith(`${receiver}.`)) {
              receiverTaints.add(path.slice(receiver.length + 1));
            } else if (!receiver && !path.includes(".")) {
              receiverTaints.add(path);
            }
          }
          const key = `${definition.id}:${mappedTaints
            .map(Number)
            .join("")}:${[...receiverTaints].sort().join(",")}`;
          let result = memo.get(key);
          if (!result) {
            result = {
              exposed: false,
              formalUpdates: new Map(),
              memberUpdates: new Map(),
              returnTainted: false,
            };
            memo.set(key, result);
          }
          if (!active.has(key)) {
            const parameterTaints = new Set(
              definition.parameters.filter(
                (_parameter, index) => mappedTaints[index],
              ),
            );
            for (const member of receiverTaints) parameterTaints.add(member);
            active.add(key);
            let previous;
            do {
              previous = resultSignature(result);
              const next = fragment(
                definition.body,
                parameterTaints,
                new Set(definition.parameters),
              );
              result = {
                exposed: result.exposed || next.exposed,
                formalUpdates: new Map([
                  ...result.formalUpdates,
                  ...next.formalUpdates,
                ]),
                memberUpdates: new Map([
                  ...result.memberUpdates,
                  ...next.memberUpdates,
                ]),
                returnTainted: result.returnTainted || next.returnTainted,
              };
              memo.set(key, result);
            } while (resultSignature(result) !== previous);
            active.delete(key);
          }
          callExposed ||= result?.exposed ?? false;
          callTainted ||= result?.returnTainted ?? false;
          for (const [member, isTainted] of result?.memberUpdates ?? []) {
            if (isTainted || !updates.has(member)) {
              updates.set(member, isTainted);
            }
          }
          for (const [formal, isTainted] of result?.formalUpdates ?? []) {
            const parameterIndex = definition.parameters.findIndex(
              (parameter) =>
                formal === parameter || formal.startsWith(`${parameter}.`),
            );
            const argument = taintAccessPath(
              mappedArguments[parameterIndex] ?? "",
            );
            if (!argument || parameterIndex < 0) continue;
            const parameter = definition.parameters[parameterIndex];
            const path = argument + formal.slice(parameter.length);
            if (isTainted) tainted.add(path);
            else tainted.delete(path);
            recordMutation(path, isTainted);
          }
        }
        for (const [member, isTainted] of updates) {
          const path = receiver ? `${receiver}.${member}` : member;
          if (isTainted) tainted.add(path);
          else tainted.delete(path);
        }
        return { exposed: callExposed, tainted: callTainted };
      }

      const constructed =
        call.constructed &&
        canonicalType(call.name, types) === "ClientSecretCredential";
      return {
        exposed: false,
        tainted: constructed ? false : argumentTaints.some(Boolean),
      };
    };

    const expressionTainted = (expression) => {
      let remaining = expression;
      const calls = invocations(expression);
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index];
        if (
          calls.some(
            (outer, outerIndex) =>
              outerIndex !== index &&
              outer.start < call.start &&
              outer.end >= call.end,
          )
        ) {
          continue;
        }
        const result = callResult(call);
        exposed ||= result.exposed;
        remaining =
          remaining.slice(0, call.start) +
          (result.tainted ? " __SECRET_TAINT__ " : " ") +
          remaining.slice(call.end);
      }
      return (
        remaining.includes("__SECRET_TAINT__") ||
        taintReference(remaining, tainted)
      );
    };

    for (const statement of taintStatements(source)) {
      const output = loggingArgument(statement);
      if (output !== null) {
        exposed ||= expressionTainted(output);
        continue;
      }

      const returned = /^\s*return\s+([\s\S]+)$/.exec(statement)?.[1];
      if (returned) {
        returnTainted ||= expressionTainted(returned);
        continue;
      }

      const declaration =
        /^\s*(?:(?:public|private|protected|internal|static|readonly|volatile|required|new|unsafe|const|await|using)\s+)*(?:var|(?:global::)?[\w.:<>?[\]]+)\s+(\w+)\s*=\s*([\s\S]+)$/.exec(
          statement,
        );
      if (declaration) {
        const path = declaration[1];
        const value = declaration[2];
        localNames.add(path);
        const methodAlias = accessPath(value);
        if (methodAlias && methods.has(methodAlias.split(".").at(-1))) {
          callableAliases.set(path, methodAlias.split(".").at(-1));
        }
        if (expressionTainted(value)) tainted.add(path);
        else tainted.delete(path);
        continue;
      }

      const assignment =
        /^\s*((?:this\s*\.\s*)?\w+(?:\s*(?:\.\s*\w+|\[[^\]]+\]))*)\s*=\s*([\s\S]+)$/.exec(
          statement,
        );
      if (assignment) {
        const path = taintAccessPath(assignment[1]);
        if (path) {
          const isTainted = expressionTainted(assignment[2]);
          if (isTainted) tainted.add(path);
          else tainted.delete(path);
          recordMutation(path, isTainted);
        }
        continue;
      }

      for (const call of invocations(statement)) {
        exposed ||= callResult(call).exposed;
      }
    }
    return { exposed, formalUpdates, memberUpdates, returnTainted };
  };

  return fragment(code).exposed;
}

function analyze(source) {
  const { code, literals } = literalAwareCode(source);
  const types = typeContext(code);
  const environmentAccessors = environmentAccessorSummaries(code, types);
  const memberTypes = new Map();
  const memberNames = new Set();
  for (const match of code.matchAll(
    /\b(?:(?:public|private|protected|internal|static|readonly|volatile|required|new|unsafe)\s+)+((?:global::)?[\w.:<>?[\]]+)\s+(\w+)\s*(?=[=;{])/g,
  )) {
    memberNames.add(match[2]);
    const type = canonicalType(match[1], types);
    if (type) memberTypes.set(match[2], type);
  }
  const state = {
    aliases: types.aliases,
    types,
    literals,
    scopes: [new Map()],
    members: new Map(
      [...memberTypes].map(([name, declaredType]) => [
        name,
        { kind: "unknown", declaredType },
      ]),
    ),
    memberNames,
    memberTypes,
    environmentAccessors,
    environmentKinds: new Set(),
    secretExposed: false,
    credentialFound: false,
    associationFound: false,
    operationFound: false,
    printedFields: new Set(),
  };
  let statement = "";
  let parentheses = 0;
  let brackets = 0;
  let initializerBraces = 0;

  for (const character of code) {
    if (character === "(") {
      parentheses += 1;
      statement += character;
    } else if (character === ")") {
      parentheses = Math.max(0, parentheses - 1);
      statement += character;
    } else if (character === "[") {
      brackets += 1;
      statement += character;
    } else if (character === "]") {
      brackets = Math.max(0, brackets - 1);
      statement += character;
    } else if (character === "{") {
      const initializer =
        parentheses > 0 ||
        brackets > 0 ||
        initializerBraces > 0 ||
        (/=/.test(statement) && /\bnew\b/.test(statement));
      if (initializer) {
        initializerBraces += 1;
        statement += character;
      } else {
        statement = "";
        state.scopes.push(new Map());
      }
    } else if (character === "}") {
      if (initializerBraces > 0) {
        initializerBraces -= 1;
        statement += character;
      } else {
        statement = "";
        if (state.scopes.length > 1) state.scopes.pop();
      }
    } else if (
      character === ";" &&
      parentheses === 0 &&
      brackets === 0 &&
      initializerBraces === 0
    ) {
      processStatement(statement, state);
      statement = "";
    } else {
      statement += character;
    }
  }
  state.secretExposed ||= secretExposureAnalysis(
    code,
    literals,
    types,
    environmentAccessors,
  );
  return { ...state, code };
}

function blockAt(source, openIndex) {
  const closeIndex = matchingDelimiter(source, openIndex, "{", "}");
  return closeIndex < 0
    ? null
    : {
        body: source.slice(openIndex + 1, closeIndex),
        start: openIndex,
        end: closeIndex + 1,
      };
}

function authenticatedAwaitInBlock(fullSource, block) {
  for (const match of block.body.matchAll(
    /\bawait\s*(?:\(\s*)*((?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*)\s*\.\s*GetAccountInfoAsync\s*\(/g,
  )) {
    const receiverOffset = match[0].indexOf(match[1]);
    const beforeReceiver = fullSource.slice(
      0,
      block.start + 1 + match.index + receiverOffset,
    );
    const binding = lookupValue(analyze(beforeReceiver), match[1]);
    if (binding?.kind === "blob-client" && binding.authenticated) return true;
  }
  return false;
}

function usefulAuthenticationCatch(caughtName, body) {
  if (!caughtName) return false;
  const name = escapeRegExp(caughtName);
  return new RegExp(
    String.raw`\b(?:(?:System\s*\.\s*)?Console\s*\.\s*(?:Error\s*\.\s*|Out\s*\.\s*)?(?:Write|WriteLine)|(?:System\s*\.\s*Diagnostics\s*\.\s*)?(?:Debug|Trace)\s*\.\s*(?:Write|WriteLine|Trace\w*)|(?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*\s*\.\s*Log(?:Trace|Debug|Information|Warning|Error|Critical)?)\s*\([^;]*\b${name}\s*(?:\.\s*(?:Message|ToString)\b)?`,
  ).test(body);
}

function csharpThrowIsCausal(statement, caughtName) {
  if (/^\s*throw\s*;\s*$/.test(statement)) return true;
  const expression = /^\s*throw\s+([\s\S]+);\s*$/.exec(statement)?.[1];
  if (!expression || !caughtName) return false;
  const name = escapeRegExp(caughtName);
  if (new RegExp(`^\\s*${name}\\s*$`).test(stripOuterParentheses(expression))) {
    return true;
  }
  return new RegExp(
    String.raw`(?:\(|,)\s*(?:\w+\s*:\s*)?\b${name}\b\s*(?=,|\))`,
  ).test(expression);
}

function labelsInScope(source, start, end, ancestors) {
  const labels = new Set();
  let invalid = false;
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < end; index += 1) {
    const character = source[index];
    if (character === "{" && parentheses === 0 && brackets === 0) {
      const close = matchingDelimiter(source, index, "{", "}");
      if (close < 0 || close >= end) break;
      index = close;
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    if (parentheses > 0 || brackets > 0) continue;

    const match = /^([A-Za-z_]\w*)\s*:/.exec(source.slice(index, end));
    if (!match || ["case", "default"].includes(match[1])) continue;
    const prefix = source.slice(start, index).trimEnd();
    const previous = prefix.at(-1);
    const canStart =
      !prefix || ";{}:)".includes(previous) || /\b(?:do|else)\s*$/.test(prefix);
    if (!canStart) continue;
    if (labels.has(match[1]) || ancestors.some((scope) => scope.has(match[1]))) {
      invalid = true;
    }
    labels.add(match[1]);
    index += match[0].length - 1;
  }
  return { labels, invalid };
}

function csharpHandlerAlwaysCausal(body, caughtName) {
  if (/\bgoto\b/.test(body)) return false;
  const labelScopes = [];

  const outcomes = (start, end) => {
    const registered = labelsInScope(body, start, end, labelScopes);
    labelScopes.push(registered.labels);
    let result = new Set(["fall"]);
    let index = start;

    const sequence = (next) => {
      const combined = new Set([...result].filter((value) => value !== "fall"));
      if (result.has("fall")) {
        for (const value of next) combined.add(value);
      }
      result = combined;
    };
    const skipWhitespace = () => {
      while (index < end && /\s/.test(body[index])) index += 1;
    };
    const conditionKind = (condition) => {
      const value = stripOuterParentheses(condition)
        .replace(/\s+/g, "")
        .toLowerCase();
      if (value === "true") return true;
      if (value === "false") return false;
      return null;
    };
    const loopOutcomes = (nested, condition, canSkip, executesOnce = false) => {
      const loopResult = new Set(
        [...nested].filter((value) =>
          ["safe", "unsafe", "invalid"].includes(value),
        ),
      );
      if (condition === false && !executesOnce) {
        return new Set([
          "fall",
          ...[...nested].filter((value) => value === "invalid"),
        ]);
      }
      if (nested.has("break")) loopResult.add("fall");
      if (
        condition !== true &&
        (canSkip || nested.has("fall") || nested.has("continue"))
      ) {
        loopResult.add("fall");
      }
      return loopResult;
    };
    const parenthesized = () => {
      skipWhitespace();
      if (body[index] !== "(") return null;
      const close = matchingDelimiter(body, index, "(", ")");
      if (close < 0 || close >= end) return null;
      const value = body.slice(index + 1, close);
      index = close + 1;
      return value;
    };
    const forCondition = (header) => {
      const parts = [];
      let startIndex = 0;
      let depth = 0;
      for (let cursor = 0; cursor < header.length; cursor += 1) {
        const character = header[cursor];
        if ("([{".includes(character)) depth += 1;
        else if (")]}".includes(character)) depth -= 1;
        else if (character === ";" && depth === 0) {
          parts.push(header.slice(startIndex, cursor));
          startIndex = cursor + 1;
        }
      }
      parts.push(header.slice(startIndex));
      if (parts.length !== 3) return "ambiguous";
      return parts[1].trim() === "" ? true : conditionKind(parts[1]);
    };

    const statement = () => {
      skipWhitespace();
      if (index >= end) return new Set(["unsafe"]);
      if (body[index] === ";") {
        index += 1;
        return new Set(["fall"]);
      }

      const labels = new Set();
      let hasLabel = false;
      let duplicateLabel = false;
      while (true) {
        const label = /^([A-Za-z_]\w*)\s*:/.exec(body.slice(index));
        if (!label) break;
        hasLabel = true;
        if (labels.has(label[1])) duplicateLabel = true;
        labels.add(label[1]);
        index += label[0].length;
        skipWhitespace();
      }
      if (hasLabel) {
        const labelsLoop = /^(?:while|foreach|for|do)\b/.test(body.slice(index));
        const nested = statement();
        if (duplicateLabel) return new Set(["invalid"]);
        return labelsLoop ? nested : new Set(["unsafe"]);
      }
      if (body[index] === "{") {
        const close = matchingDelimiter(body, index, "{", "}");
        if (close < 0 || close >= end) {
          index = end;
          return new Set(["unsafe"]);
        }
        const nested = outcomes(index + 1, close);
        index = close + 1;
        return nested;
      }
      if (/^while\b/.test(body.slice(index))) {
        index += 5;
        const condition = parenthesized();
        if (condition === null) return new Set(["unsafe"]);
        const kind = conditionKind(condition);
        return loopOutcomes(statement(), kind, kind === null);
      }
      if (/^foreach\b/.test(body.slice(index))) {
        index += 7;
        if (parenthesized() === null) return new Set(["unsafe"]);
        return loopOutcomes(statement(), null, true);
      }
      if (/^for\b/.test(body.slice(index))) {
        index += 3;
        const header = parenthesized();
        if (header === null) return new Set(["unsafe"]);
        const kind = forCondition(header);
        const nested = statement();
        return kind === "ambiguous"
          ? new Set(["unsafe"])
          : loopOutcomes(nested, kind, kind === null);
      }
      if (/^do\b/.test(body.slice(index))) {
        index += 2;
        const nested = statement();
        skipWhitespace();
        if (!/^while\b/.test(body.slice(index))) return new Set(["unsafe"]);
        index += 5;
        const condition = parenthesized();
        if (condition === null) return new Set(["unsafe"]);
        skipWhitespace();
        if (body[index] === ";") index += 1;
        return loopOutcomes(nested, conditionKind(condition), false, true);
      }
      if (/^if\b/.test(body.slice(index))) {
        index += 2;
        const condition = parenthesized();
        if (condition === null) return new Set(["unsafe"]);
        const consequent = statement();
        skipWhitespace();
        let alternate = new Set(["fall"]);
        if (/^else\b/.test(body.slice(index))) {
          index += 4;
          alternate = statement();
        }
        const kind = conditionKind(condition);
        if (kind === true) return consequent;
        if (kind === false) return alternate;
        return new Set([...consequent, ...alternate]);
      }

      const statementStart = index;
      let parentheses = 0;
      let brackets = 0;
      for (; index < end; index += 1) {
        const character = body[index];
        if (character === "(") parentheses += 1;
        else if (character === ")") parentheses -= 1;
        else if (character === "[") brackets += 1;
        else if (character === "]") brackets -= 1;
        else if (
          character === "{" &&
          parentheses === 0 &&
          brackets === 0
        ) {
          const close = matchingDelimiter(body, index, "{", "}");
          if (close < 0 || close >= end) {
            index = end;
            return new Set(["unsafe"]);
          }
          const nested = outcomes(index + 1, close);
          index = close + 1;
          return new Set(["fall", ...nested]);
        } else if (
          character === ";" &&
          parentheses === 0 &&
          brackets === 0
        ) {
          index += 1;
          break;
        }
      }
      const text = body.slice(statementStart, index).trim();
      if (/^throw\b/.test(text)) {
        return new Set([
          csharpThrowIsCausal(text, caughtName) ? "safe" : "unsafe",
        ]);
      }
      if (/^(?:return|goto)\b/.test(text)) return new Set(["unsafe"]);
      if (/^break\b/.test(text)) {
        return new Set([/^break\s*;\s*$/.test(text) ? "break" : "invalid"]);
      }
      if (/^continue\b/.test(text)) {
        return new Set([
          /^continue\s*;\s*$/.test(text) ? "continue" : "invalid",
        ]);
      }
      return new Set(["fall"]);
    };

    while (index < end) {
      skipWhitespace();
      while (body[index] === ";") {
        index += 1;
        skipWhitespace();
      }
      if (index >= end) break;
      sequence(statement());
    }
    if (registered.invalid) result.add("invalid");
    labelScopes.pop();
    return result;
  };

  const result = outcomes(0, body.length);
  return result.size === 1 && result.has("safe");
}

function catchAt(code, start) {
  const keyword = /^catch\b/.exec(code.slice(start));
  if (!keyword) return null;
  let index = start + keyword[0].length;
  while (/\s/.test(code[index] ?? "")) index += 1;
  let header = "";
  if (code[index] === "(") {
    const close = matchingDelimiter(code, index, "(", ")");
    if (close < 0) return null;
    header = code.slice(index + 1, close);
    index = close + 1;
  }
  while (/\s/.test(code[index] ?? "")) index += 1;
  let filter = "";
  if (/^when\b/.test(code.slice(index))) {
    index += 4;
    while (/\s/.test(code[index] ?? "")) index += 1;
    if (code[index] !== "(") return null;
    const close = matchingDelimiter(code, index, "(", ")");
    if (close < 0) return null;
    filter = code.slice(index + 1, close);
    index = close + 1;
  }
  while (/\s/.test(code[index] ?? "")) index += 1;
  if (code[index] !== "{") return null;
  const block = blockAt(code, index);
  if (!block) return null;
  const parsed = /^\s*((?:global::)?[\w.:]+)(?:\s+(\w+))?\s*$/.exec(header);
  return {
    body: block.body,
    caughtName: parsed?.[2] ?? null,
    end: block.end,
    filter,
    start,
    type: parsed?.[1] ?? null,
  };
}

function allCatches(code) {
  const catches = [];
  for (const match of code.matchAll(/\bcatch\b/g)) {
    const caught = catchAt(code, match.index);
    if (caught) catches.push(caught);
  }
  return catches;
}

function exactAuthenticationCatch(caught, aliases) {
  if (canonicalType(caught.type, aliases) === "AuthenticationFailedException") {
    return true;
  }
  if (!caught.caughtName || !caught.filter) return false;
  const name = escapeRegExp(caught.caughtName);
  const match = new RegExp(
    `^\\s*\\(?\\s*${name}\\s+is\\s+((?:global::)?[\\w.:]+)(?:\\s+\\w+)?\\s*\\)?\\s*$`,
  ).exec(caught.filter);
  return (
    match !== null &&
    canonicalType(match[1], aliases) === "AuthenticationFailedException"
  );
}

function attachedCatches(code, blockEnd) {
  const catches = [];
  let index = blockEnd;
  while (index < code.length) {
    while (/\s/.test(code[index] ?? "")) index += 1;
    const caught = catchAt(code, index);
    if (!caught) break;
    catches.push(caught);
    index = caught.end;
  }
  return catches;
}

function hasAuthenticationErrorHandling(source) {
  const { code } = literalAwareCode(source);
  const aliases = typeContext(code);
  if (
    allCatches(code).some(
      (caught) =>
        !exactAuthenticationCatch(caught, aliases) &&
        !csharpHandlerAlwaysCausal(caught.body, caught.caughtName),
    )
  ) {
    return false;
  }

  for (const tryMatch of code.matchAll(/\btry\s*\{/g)) {
    const tryBlock = blockAt(code, code.indexOf("{", tryMatch.index));
    if (!tryBlock || !authenticatedAwaitInBlock(source, tryBlock)) continue;
    if (
      attachedCatches(code, tryBlock.end).some(
        (caught) =>
          exactAuthenticationCatch(caught, aliases) &&
          (usefulAuthenticationCatch(caught.caughtName, caught.body) ||
            csharpHandlerAlwaysCausal(caught.body, caught.caughtName)),
      )
    ) {
      return true;
    }
  }
  return false;
}

function projectDocuments(project) {
  const withoutComments = project.replace(/<!--[\s\S]*?-->/g, " ");
  return [
    ...withoutComments.matchAll(
      /<(?:\w+:)?Project\b[^>]*>[\s\S]*?<\/(?:\w+:)?Project\s*>/gi,
    ),
  ].map((match) => match[0]);
}

function xmlAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(
    /\b([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g,
  )) {
    attributes.set(match[1].toLowerCase(), match[3].trim());
  }
  return attributes;
}

function xmlChildValue(source, name) {
  return new RegExp(
    String.raw`<(?:\w+:)?${name}\b[^>]*>([^<]*)<\/(?:\w+:)?${name}\s*>`,
    "i",
  ).exec(source)?.[1]?.trim();
}

function staticConditionValue(condition) {
  if (condition === undefined) return null;
  const tokens =
    condition.match(
      /"(?:[^"]|"")*"|'(?:[^']|'')*'|==|!=|&&|\|\||[()!]|[^\s()!&|=]+/g,
    ) ?? [];
  let index = 0;

  const literal = (token) => {
    if (token === undefined) return { known: false };
    const quoted =
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'));
    const value = quoted ? token.slice(1, -1) : token;
    if (/[$%@]\(/.test(value)) return { known: false };
    if (/^(?:true|false)$/i.test(value)) {
      return { known: true, value: value.toLowerCase() === "true" };
    }
    if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      return { known: true, value: Number(value) };
    }
    return quoted ? { known: true, value } : { known: false };
  };
  const boolean = (value) => {
    if (!value.known) return null;
    if (typeof value.value === "boolean") return value.value;
    if (typeof value.value === "number") return value.value !== 0;
    return null;
  };
  const combine = (left, right, operator) => {
    if (operator === "and") {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : null;
    }
    if (left === true || right === true) return true;
    return left === false && right === false ? false : null;
  };

  const primary = () => {
    if (tokens[index] === "(") {
      index += 1;
      const value = disjunction();
      if (tokens[index] !== ")") return { known: false };
      index += 1;
      return { known: value !== null, value };
    }
    const value = literal(tokens[index]);
    index += 1;
    return value;
  };
  const comparison = () => {
    const left = primary();
    const operator = tokens[index];
    if (!["==", "!="].includes(operator)) return boolean(left);
    index += 1;
    const right = primary();
    if (!left.known || !right.known) return null;
    return operator === "=="
      ? left.value === right.value
      : left.value !== right.value;
  };
  const unary = () => {
    if (/^(?:!|not)$/i.test(tokens[index] ?? "")) {
      index += 1;
      const value = unary();
      return value === null ? null : !value;
    }
    return comparison();
  };
  const conjunction = () => {
    let value = unary();
    while (/^(?:and|&&)$/i.test(tokens[index] ?? "")) {
      index += 1;
      value = combine(value, unary(), "and");
    }
    return value;
  };
  function disjunction() {
    let value = conjunction();
    while (/^(?:or|\|\|)$/i.test(tokens[index] ?? "")) {
      index += 1;
      value = combine(value, conjunction(), "or");
    }
    return value;
  }

  const result = disjunction();
  return index === tokens.length ? result : null;
}

function staticConditionIsFalse(condition) {
  return staticConditionValue(condition) === false;
}

function staticallyDisabledAncestor(document, referenceIndex) {
  const stack = [];
  const tagPattern = /<\/?(?:\w+:)?(Project|ItemGroup)\b[^>]*>/gi;
  for (const match of document.matchAll(tagPattern)) {
    if (match.index >= referenceIndex) break;
    if (/^<\//.test(match[0])) {
      stack.pop();
      continue;
    }
    if (!/\/\s*>$/.test(match[0])) {
      stack.push(xmlAttributes(match[0]).get("condition"));
    }
  }
  return stack.some(staticConditionIsFalse);
}

function staticallyDisabledChooseBranch(document, referenceIndex) {
  const chooses = [];
  const stack = [];
  const tags =
    /<\/?(?:\w+:)?(Choose|When|Otherwise)\b[^>]*>/gi;
  for (const match of document.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    if (/^<\//.test(match[0])) {
      const position = stack.map(({ tag: name }) => name).lastIndexOf(tag);
      if (position === -1) continue;
      const closed = stack[position];
      closed.end = match.index + match[0].length;
      stack.length = position;
      continue;
    }
    const entry = {
      condition: xmlAttributes(match[0]).get("condition"),
      end: document.length,
      start: match.index,
      tag,
    };
    if (tag === "choose") {
      entry.branches = [];
      chooses.push(entry);
    } else {
      const parent = [...stack]
        .reverse()
        .find(({ tag: name }) => name === "choose");
      parent?.branches.push(entry);
    }
    if (!/\/\s*>$/.test(match[0])) stack.push(entry);
  }

  return chooses.some((choose) => {
    if (!(choose.start <= referenceIndex && referenceIndex < choose.end)) {
      return false;
    }
    const branch = choose.branches.find(
      (candidate) =>
        candidate.start <= referenceIndex && referenceIndex < candidate.end,
    );
    if (!branch) return false;
    let selectionClosed = false;
    for (const candidate of choose.branches) {
      if (candidate === branch) {
        return (
          selectionClosed ||
          (candidate.tag === "when" &&
            staticConditionValue(candidate.condition) === false)
        );
      }
      if (
        !selectionClosed &&
        candidate.tag === "when" &&
        staticConditionValue(candidate.condition) === true
      ) {
        selectionClosed = true;
      }
    }
    return false;
  });
}

function activePackageNames(document) {
  const names = new Set();
  for (const match of document.matchAll(
    /<(?:\w+:)?PackageReference\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?PackageReference\s*>)/gi,
  )) {
    const attributes = xmlAttributes(match[1]);
    const body = match[2] ?? "";
    const condition =
      attributes.get("condition") ?? xmlChildValue(body, "Condition");
    const excludeAssets =
      attributes.get("excludeassets") ?? xmlChildValue(body, "ExcludeAssets");
    const includeAssets =
      attributes.get("includeassets") ?? xmlChildValue(body, "IncludeAssets");
    const excluded = new Set(
      (excludeAssets ?? "")
        .split(";")
        .map((asset) => asset.trim().toLowerCase())
        .filter(Boolean),
    );
    const included = new Set(
      (includeAssets ?? "all")
        .split(";")
        .map((asset) => asset.trim().toLowerCase())
        .filter(Boolean),
    );
    if (
      staticConditionIsFalse(condition) ||
      staticallyDisabledAncestor(document, match.index) ||
      staticallyDisabledChooseBranch(document, match.index) ||
      excluded.has("all") ||
      excluded.has("compile") ||
      included.has("none") ||
      (!included.has("all") && !included.has("compile"))
    ) {
      continue;
    }
    const include =
      attributes.get("include") ?? xmlChildValue(body, "Include");
    if (include) names.add(include.toLowerCase());
  }
  return names;
}

function hasRequiredPackages(project) {
  return projectDocuments(project).some((document) => {
    const packages = activePackageNames(document);
    return ["azure.identity", "azure.storage.blobs"].every((name) =>
      packages.has(name),
    );
  });
}

const rules = {
  "prompt/identity-packages": ({ project }) => hasRequiredPackages(project),
  "prompt/environment-secret-management": ({ analysis }) =>
    ["tenant-id", "client-id", "client-secret", "endpoint-value"].every((kind) =>
      analysis.environmentKinds.has(kind),
    ) && !analysis.secretExposed,
  "prompt/client-secret-credential": ({ analysis }) =>
    analysis.credentialFound,
  "prompt/credential-client-association": ({ analysis }) =>
    analysis.associationFound,
  "prompt/authenticated-operation": ({ analysis }) =>
    analysis.operationFound &&
    analysis.printedFields.has("AccountKind") &&
    analysis.printedFields.has("SkuName"),
  "prompt/authentication-errors": ({ source }) =>
    hasAuthenticationErrorHandling(source),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const source = workspace.source ?? "";
  if (source.trim() === "") return false;
  return Boolean(rule({ ...workspace, source, analysis: analyze(source) }));
}

export function ruleNames() {
  return Object.keys(rules);
}
