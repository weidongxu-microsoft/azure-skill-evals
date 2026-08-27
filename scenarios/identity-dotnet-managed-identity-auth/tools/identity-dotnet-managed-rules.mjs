import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const knownTypes = new Set([
  "AzureCliCredential",
  "BlobServiceClient",
  "ChainedTokenCredential",
  "CredentialUnavailableException",
  "DefaultAzureCredential",
  "DefaultAzureCredentialOptions",
  "Exception",
  "ManagedIdentityCredential",
  "ManagedIdentityId",
  "RequestFailedException",
  "TokenCredential",
  "Uri",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchingDelimiter(source, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) {
      depth += 1;
    } else if (source[index] === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
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
    if (character !== '"') {
      continue;
    }

    if (
      source.startsWith('"""', index) ||
      source[index - 1] === "$" ||
      (source[index - 1] === "@" && source[index - 2] === "$") ||
      (source[index - 1] === "$" && source[index - 2] === "@")
    ) {
      const delimiter = source.startsWith('"""', index) ? '"""' : '"';
      const closeIndex = source.indexOf(
        delimiter,
        index + delimiter.length,
      );
      if (closeIndex >= 0) {
        index = closeIndex + delimiter.length - 1;
      }
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
          {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            '"': '"',
          }[escaped] ?? escaped;
        cursor += 1;
      } else if (source[cursor] === '"') {
        closeIndex = cursor;
        break;
      } else {
        value += source[cursor];
      }
    }
    if (closeIndex < 0) {
      continue;
    }

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

function canonicalType(type, aliases) {
  if (!type) return null;
  let normalized = type
    .replace(/\s+/g, "")
    .replace(/^global::/, "")
    .replace(/[?[\]]+$/g, "");
  const first = normalized.split(/[.:]/)[0];
  if (aliases.has(first)) {
    normalized = normalized.replace(first, aliases.get(first));
  }
  if (aliases.has(normalized)) {
    normalized = aliases.get(normalized);
  }
  const simple = normalized.split(/[.:]/).at(-1)?.replace(/<.*>$/, "");
  return knownTypes.has(simple) ? simple : null;
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
  const last = source.slice(start).trim();
  if (last) result.push(last);
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

function stripNamedArgument(expression) {
  return expression.replace(/^\s*\w+\s*:\s*/, "").trim();
}

function lookupBinding(scopes, name) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) return scopes[index].get(name);
  }
  return null;
}

function accessPath(expression) {
  const normalized = stripOuterParentheses(expression)
    .replace(/\s+/g, "")
    .replace(/^this\./, "");
  return /^\w+(?:\.\w+)*$/.test(normalized) ? normalized : null;
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

function bindValue(state, expression, binding, declaration, memberDeclaration) {
  const path = accessPath(expression);
  if (!path) return;
  if (
    path.includes(".") ||
    memberDeclaration ||
    state.memberTypes.has(path)
  ) {
    state.members.set(path, binding);
    return;
  }
  bind(state.scopes, path, binding, declaration);
}

function invalidateInstanceMembers(state, name) {
  const prefix = `${name}.`;
  for (const path of state.members.keys()) {
    if (path.startsWith(prefix)) state.members.delete(path);
  }
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
  if (state.aliases.has(first)) {
    receiver = receiver.replace(first, state.aliases.get(first));
  }
  if (!["Environment", "System.Environment"].includes(receiver)) return null;
  const fallback = match[3].trim();
  if (fallback && !/^\?\?\s*throw\b[\s\S]+$/.test(fallback)) return null;
  const value = literalArgumentValue(match[2], state.literals);
  if (value === "AZURE_CLIENT_ID") return { kind: "client-id" };
  if (value === "AZURE_STORAGE_BLOB_ENDPOINT") {
    return { kind: "endpoint-value" };
  }
  return { kind: "unknown" };
}

function constructor(expression, expectedType, aliases) {
  const value = stripOuterParentheses(expression);
  const match = /^\s*new\s*([\w:.]+)?\s*(\(|\{)/.exec(value);
  if (!match) return null;
  const hasArguments = match[2] === "(";
  const openIndex = value.indexOf(match[2], match.index);
  const closeIndex = matchingDelimiter(
    value,
    openIndex,
    match[2],
    hasArguments ? ")" : "}",
  );
  if (closeIndex < 0) return null;
  const type = match[1]
    ? canonicalType(match[1], aliases)
    : canonicalType(expectedType, aliases);
  return {
    type,
    arguments: hasArguments ? value.slice(openIndex + 1, closeIndex) : "",
    initializer: hasArguments
      ? value.slice(closeIndex + 1).trim()
      : value.slice(openIndex, closeIndex + 1),
  };
}

function managedIdentityIdKind(expression, state) {
  const systemAssigned =
    /^\s*((?:global::)?[\w.:]+)\s*\.\s*SystemAssigned\b/.exec(expression);
  if (
    systemAssigned &&
    canonicalType(systemAssigned[1], state.aliases) === "ManagedIdentityId"
  ) {
    return "system";
  }
  const userAssigned =
    /^\s*((?:global::)?[\w.:]+)\s*\.\s*FromUserAssignedClientId\s*\(([\s\S]*)\)\s*$/.exec(
      expression,
    );
  if (
    userAssigned &&
    canonicalType(userAssigned[1], state.aliases) === "ManagedIdentityId" &&
    evaluateExpression(userAssigned[2], null, state)?.kind === "client-id"
  ) {
    return "user";
  }
  const binding = lookupBinding(
    state.scopes,
    accessPath(expression) ?? "",
  );
  const value = binding ?? lookupValue(state, expression);
  return value?.kind === "managed-identity-id"
    ? value.identityKind
    : null;
}

function optionInitializer(initializer, state) {
  const result = {
    kind: "default-options",
    managedIdentityClientId: false,
    managedIdentityExcluded: false,
  };
  const openIndex = initializer.indexOf("{");
  if (openIndex < 0) return result;
  const closeIndex = matchingDelimiter(initializer, openIndex, "{", "}");
  if (closeIndex < 0) return result;
  for (const assignment of splitArguments(
    initializer.slice(openIndex + 1, closeIndex),
  )) {
    const property = /^\s*(\w+)\s*=\s*([\s\S]+)$/.exec(assignment);
    if (!property) continue;
    if (property[1] === "ManagedIdentityClientId") {
      result.managedIdentityClientId =
        evaluateExpression(property[2], null, state)?.kind === "client-id";
    } else if (property[1] === "ExcludeManagedIdentityCredential") {
      const value = evaluateExpression(property[2], "bool", state);
      result.managedIdentityExcluded =
        value?.kind === "boolean" ? value.value : null;
    }
  }
  return result;
}

function credentialArguments(source) {
  const trimmed = source.trim();
  const array = /^(?:new\s+[\w:.<>]+\s*\[\s*\]\s*)?\{([\s\S]*)\}$/.exec(
    trimmed,
  );
  if (array) return splitArguments(array[1]);
  const collection = /^\[([\s\S]*)\]$/.exec(trimmed);
  if (collection) return splitArguments(collection[1]);
  return splitArguments(source);
}

function isUsableCredential(binding) {
  return (
    (binding?.kind === "managed-identity" &&
      ["system", "user"].includes(binding.identityKind)) ||
    (binding?.kind === "default-credential" && binding.valid) ||
    (binding?.kind === "chain" && binding.valid)
  );
}

function awaitedOperation(expression, state) {
  const match =
    /\bawait\s*(?:\(\s*)*((?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*)\s*\.\s*GetAccountInfoAsync\s*\(/.exec(
      expression,
    );
  if (!match) return null;
  const client = lookupValue(state, match[1]);
  return client?.kind === "blob-client" && client.authenticated
    ? { kind: "response", authenticated: true }
    : { kind: "response", authenticated: false };
}

function evaluateExpression(expression, expectedType, state) {
  const value = stripOuterParentheses(stripNamedArgument(expression));
  if (/^true$/.test(value)) return { kind: "boolean", value: true };
  if (/^false$/.test(value)) return { kind: "boolean", value: false };

  const environment = environmentValue(value, state);
  if (environment) return environment;

  const identityKind = managedIdentityIdKind(value, state);
  if (identityKind) {
    return { kind: "managed-identity-id", identityKind };
  }

  const credentialCollection =
    /^(?:new\s+(?:global::)?[\w.:<>]+\s*\[\s*\]\s*)?\{([\s\S]*)\}$/.exec(
      value,
    ) ?? /^\[([\s\S]*)\]$/.exec(value);
  if (credentialCollection) {
    return {
      kind: "credential-list",
      credentials: splitArguments(credentialCollection[1]).map((argument) =>
        evaluateExpression(argument, "TokenCredential", state),
      ),
    };
  }

  const operation = awaitedOperation(value, state);
  if (operation) {
    state.operationFound ||= operation.authenticated;
    if (/\.Value\s*$/.test(value)) {
      return { kind: "account-info", authenticated: operation.authenticated };
    }
    if (/\.Value\s*\.\s*(AccountKind|SkuName)\s*$/.test(value)) {
      return {
        kind: "account-field",
        authenticated: operation.authenticated,
        field: RegExp.$1,
      };
    }
    return operation;
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
      return {
        kind: "account-info",
        authenticated: binding.authenticated,
      };
    }
  }

  const reference = accessPath(value);
  if (reference) {
    const binding = lookupValue(state, reference);
    if (binding?.kind === "default-options") return binding;
    return binding ? { ...binding } : { kind: "unknown" };
  }

  const created = constructor(value, expectedType, state.aliases);
  if (!created?.type) return { kind: "unknown" };
  const argumentsList = splitArguments(created.arguments);

  if (created.type === "ManagedIdentityId") {
    return {
      kind: "managed-identity-id",
      identityKind: managedIdentityIdKind(created.arguments, state),
    };
  }
  if (created.type === "ManagedIdentityCredential") {
    let identityKind = null;
    if (argumentsList.length === 0) {
      identityKind = "system";
    } else {
      const argument = stripNamedArgument(argumentsList[0]);
      const binding = evaluateExpression(argument, null, state);
      if (binding?.kind === "client-id") identityKind = "user";
      else identityKind = managedIdentityIdKind(argument, state);
    }
    const binding = { kind: "managed-identity", identityKind };
    if (identityKind === "system") state.systemAssignedFound = true;
    if (identityKind === "user") state.userAssignedFound = true;
    return binding;
  }
  if (created.type === "DefaultAzureCredentialOptions") {
    return optionInitializer(created.initializer, state);
  }
  if (created.type === "DefaultAzureCredential") {
    const options =
      argumentsList.length > 0
        ? evaluateExpression(argumentsList[0], "DefaultAzureCredentialOptions", state)
        : null;
    const valid =
      options?.kind === "default-options" &&
      options.managedIdentityClientId &&
      options.managedIdentityExcluded === false;
    if (valid) state.defaultCredentialFound = true;
    return { kind: "default-credential", valid };
  }
  if (created.type === "AzureCliCredential") {
    return { kind: "azure-cli" };
  }
  if (created.type === "Uri") {
    const endpoint =
      argumentsList.length > 0
        ? evaluateExpression(argumentsList[0], null, state)
        : null;
    return ["endpoint", "endpoint-value"].includes(endpoint?.kind)
      ? { kind: "endpoint" }
      : { kind: "unknown" };
  }
  if (created.type === "ChainedTokenCredential") {
    let credentials = credentialArguments(created.arguments).map((argument) =>
      evaluateExpression(argument, "TokenCredential", state),
    );
    if (
      credentials.length === 1 &&
      credentials[0]?.kind === "credential-list"
    ) {
      credentials = credentials[0].credentials;
    }
    const valid =
      credentials.length >= 2 &&
      credentials[0]?.kind === "managed-identity" &&
      ["system", "user"].includes(credentials[0].identityKind) &&
      credentials[1]?.kind === "azure-cli";
    if (valid) state.localFallbackFound = true;
    return { kind: "chain", valid };
  }
  if (created.type === "BlobServiceClient") {
    const values = argumentsList.map((argument) =>
      evaluateExpression(argument, null, state),
    );
    const authenticated =
      values.some((binding) => binding?.kind === "endpoint") &&
      values.some(isUsableCredential);
    if (authenticated) state.associationFound = true;
    return { kind: "blob-client", authenticated };
  }
  return { kind: "unknown" };
}

function visibleBindings(scopes) {
  const result = new Map();
  for (const scope of scopes) {
    for (const [name, binding] of scope) result.set(name, binding);
  }
  return result;
}

function recordOutput(expression, state) {
  const directOperation = awaitedOperation(expression, state);
  if (directOperation?.authenticated) {
    state.operationFound = true;
    for (const field of ["AccountKind", "SkuName"]) {
      if (new RegExp(`\\b${field}\\b`).test(expression)) {
        state.printedFields.add(field);
      }
    }
  }

  const locals = visibleBindings(state.scopes);
  const bindings = [
    ...[...state.members].map(([name, binding]) => ({
      name,
      binding,
      member: true,
    })),
    ...[...locals].map(([name, binding]) => ({
      name,
      binding,
      member: false,
    })),
  ];
  for (const { name, binding, member } of bindings) {
    const escaped = name
      .split(".")
      .map(escapeRegExp)
      .join(String.raw`\s*\.\s*`);
    const shadowed = member && !name.includes(".") && locals.has(name);
    const reference =
      member && !name.includes(".")
        ? shadowed
          ? String.raw`this\s*\.\s*${escaped}`
          : String.raw`(?:this\s*\.\s*)?${escaped}`
        : escaped;
    if (
      binding?.kind === "account-field" &&
      binding.authenticated &&
      new RegExp(`\\b${reference}\\b`).test(expression)
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
            `\\b${reference}\\s*\\.\\s*(?:Value\\s*\\.\\s*)?${field}\\b`,
          ).test(expression)
        ) {
          state.printedFields.add(field);
        }
      }
    }
  }
}

function processStatement(statement, state) {
  const output =
    /^\s*Console\s*\.\s*(?:Error\s*\.\s*)?(?:Write|WriteLine)\s*\(([\s\S]*)\)\s*$/.exec(
      statement,
    );
  if (output) {
    recordOutput(output[1], state);
    return;
  }

  const propertyAssignment =
    /^\s*((?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*)\s*\.\s*(ManagedIdentityClientId|ExcludeManagedIdentityCredential)\s*=\s*([\s\S]+)$/.exec(
      statement,
    );
  if (propertyAssignment) {
    const previous = lookupValue(state, propertyAssignment[1]);
    if (previous?.kind !== "default-options") return;
    if (propertyAssignment[2] === "ManagedIdentityClientId") {
      previous.managedIdentityClientId =
        evaluateExpression(propertyAssignment[3], null, state)?.kind ===
        "client-id";
    } else {
      const value = evaluateExpression(propertyAssignment[3], "bool", state);
      previous.managedIdentityExcluded =
        value?.kind === "boolean" ? value.value : null;
    }
    return;
  }

  const declaration =
    /^\s*((?:(?:public|private|protected|internal|static|readonly|volatile|required|new|unsafe|const)\s+)*)(?:await\s+)?(?:using\s+)?(var|(?:global::)?[\w.:<>?[\]]+)\s+(\w+)\s*=\s*([\s\S]+)$/.exec(
      statement,
    );
  if (declaration) {
    const memberDeclaration =
      declaration[1].trim() !== "" &&
      state.memberTypes.has(declaration[3]);
    const expectedType =
      declaration[2] === "var"
        ? state.memberTypes.get(declaration[3]) ?? declaration[2]
        : declaration[2];
    const binding = evaluateExpression(declaration[4], expectedType, state);
    invalidateInstanceMembers(state, declaration[3]);
    bindValue(
      state,
      declaration[3],
      binding,
      true,
      memberDeclaration,
    );
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
      previous?.kind === "default-options"
        ? "DefaultAzureCredentialOptions"
        : state.memberTypes.get(path) ??
          state.memberTypes.get(path?.split(".").at(-1)) ??
          null;
    if (path && !path.includes(".")) {
      invalidateInstanceMembers(state, path);
    }
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

function analyze(source) {
  const { code, literals } = literalAwareCode(source);
  const aliases = typeAliases(code);
  const memberTypes = new Map();
  for (const match of code.matchAll(
    /\b(?:(?:public|private|protected|internal|static|readonly|volatile|required|new|unsafe)\s+)+((?:global::)?[\w.:<>?[\]]+)\s+(\w+)\s*(?=[=;{])/g,
  )) {
    const type = canonicalType(match[1], aliases);
    if (type) memberTypes.set(match[2], type);
  }
  const state = {
    aliases,
    literals,
    scopes: [new Map()],
    members: new Map(
      [...memberTypes].map(([name, declaredType]) => [
        name,
        { kind: "unknown", declaredType },
      ]),
    ),
    memberTypes,
    systemAssignedFound: false,
    userAssignedFound: false,
    defaultCredentialFound: false,
    localFallbackFound: false,
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

function usefulUnavailableCatch(caughtName, body) {
  if (!caughtName) return false;
  const name = escapeRegExp(caughtName);
  return new RegExp(
    String.raw`\b(?:System\s*\.\s*)?Console\s*\.\s*(?:Error\s*\.\s*)?(?:Write|WriteLine)\s*\([^;]*\b${name}\s*(?:\.\s*(?:Message|ToString)\b)?`,
  ).test(body);
}

function csharpThrowIsCausal(statement, caughtName) {
  if (/^\s*throw\s*;\s*$/.test(statement)) return true;
  const expression = /^\s*throw\s+([\s\S]+);\s*$/.exec(statement)?.[1];
  if (!expression || !caughtName) return false;
  const name = escapeRegExp(caughtName);
  if (
    new RegExp(`^\\s*${name}\\s*$`).test(
      stripOuterParentheses(expression),
    )
  ) return true;
  return new RegExp(
    String.raw`(?:\(|,)\s*(?:\w+\s*:\s*)?\b${name}\b\s*(?=,|\))`,
  ).test(expression);
}

function csharpLabelsInScope(source, start, end, ancestors) {
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
    if (character === "(") {
      parentheses += 1;
      continue;
    }
    if (character === ")") {
      parentheses = Math.max(0, parentheses - 1);
      continue;
    }
    if (character === "[") {
      brackets += 1;
      continue;
    }
    if (character === "]") {
      brackets = Math.max(0, brackets - 1);
      continue;
    }
    if (parentheses > 0 || brackets > 0) continue;

    const match = /^([A-Za-z_]\w*)\s*:/.exec(source.slice(index, end));
    if (!match || ["case", "default"].includes(match[1])) continue;
    const prefix = source.slice(start, index).trimEnd();
    const previous = prefix.at(-1);
    const canStart =
      !prefix ||
      ";{}:)".includes(previous) ||
      /\b(?:do|else)\s*$/.test(prefix);
    if (!canStart) continue;

    if (
      labels.has(match[1]) ||
      ancestors.some((scope) => scope.has(match[1]))
    ) {
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
    const registered = csharpLabelsInScope(
      body,
      start,
      end,
      labelScopes,
    );
    labelScopes.push(registered.labels);
    let result = new Set(["fall"]);
    let index = start;
    const sequence = (next) => {
      const combined = new Set(
        [...result].filter((value) => value !== "fall"),
      );
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
    const loopOutcomes = (
      bodyOutcomes,
      condition,
      canSkip,
      executesOnce = false,
    ) => {
      const invalid = [...bodyOutcomes].filter(
        (value) => value === "invalid",
      );
      if (condition === false && !executesOnce) {
        return new Set(["fall", ...invalid]);
      }
      const loopResult = new Set(
        [...bodyOutcomes].filter(
          (value) =>
            value === "safe" ||
            value === "unsafe" ||
            value === "invalid",
        ),
      );
      if (bodyOutcomes.has("break")) loopResult.add("fall");
      if (
        condition !== true &&
        (canSkip ||
          bodyOutcomes.has("fall") ||
          bodyOutcomes.has("continue"))
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
      let start = 0;
      let depth = 0;
      for (let cursor = 0; cursor < header.length; cursor += 1) {
        const character = header[cursor];
        if ("([{".includes(character)) depth += 1;
        else if (")]}".includes(character)) depth -= 1;
        else if (character === ";" && depth === 0) {
          parts.push(header.slice(start, cursor));
          start = cursor + 1;
        }
      }
      parts.push(header.slice(start));
      if (parts.length !== 3) return "ambiguous";
      return parts[1].trim() === ""
        ? true
        : conditionKind(parts[1]);
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
        const labelsLoop =
          /^(?:while|foreach|for|do)\b/.test(body.slice(index));
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
        index += body.slice(index).match(/^while\b/)[0].length;
        const condition = parenthesized();
        if (condition === null) return new Set(["unsafe"]);
        const kind = conditionKind(condition);
        const nested = statement();
        return loopOutcomes(nested, kind, kind === null);
      }
      if (/^foreach\b/.test(body.slice(index))) {
        index += body.slice(index).match(/^foreach\b/)[0].length;
        if (parenthesized() === null) return new Set(["unsafe"]);
        return loopOutcomes(statement(), null, true);
      }
      if (/^for\b/.test(body.slice(index))) {
        index += body.slice(index).match(/^for\b/)[0].length;
        const header = parenthesized();
        if (header === null) return new Set(["unsafe"]);
        const kind = forCondition(header);
        const nested = statement();
        if (kind === "ambiguous") return new Set(["unsafe"]);
        return loopOutcomes(nested, kind, kind === null);
      }
      if (/^do\b/.test(body.slice(index))) {
        index += body.slice(index).match(/^do\b/)[0].length;
        const nested = statement();
        skipWhitespace();
        if (!/^while\b/.test(body.slice(index))) {
          return new Set(["unsafe"]);
        }
        index += body.slice(index).match(/^while\b/)[0].length;
        const condition = parenthesized();
        if (condition === null) return new Set(["unsafe"]);
        skipWhitespace();
        if (body[index] === ";") index += 1;
        return loopOutcomes(
          nested,
          conditionKind(condition),
          false,
          true,
        );
      }
      if (/^if\b/.test(body.slice(index))) {
        index += body.slice(index).match(/^if\b/)[0].length;
        const condition = parenthesized();
        if (condition === null) return new Set(["unsafe"]);
        const consequent = statement();
        skipWhitespace();
        let alternate = new Set(["fall"]);
        if (/^else\b/.test(body.slice(index))) {
          index += body.slice(index).match(/^else\b/)[0].length;
          alternate = statement();
        }
        const kind = conditionKind(condition);
        const invalid = new Set(
          [...consequent, ...alternate].filter(
            (value) => value === "invalid",
          ),
        );
        if (kind === true) return new Set([...consequent, ...invalid]);
        if (kind === false) return new Set([...alternate, ...invalid]);
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
          const prefix = body.slice(statementStart, index).trim();
          index = close + 1;
          if (/^[A-Za-z_]\w*\s*:/.test(prefix)) {
            return new Set(["unsafe"]);
          }
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
      if (/^(?:return|goto)\b/.test(text)) {
        return new Set(["unsafe"]);
      }
      if (/^break\b/.test(text)) {
        return new Set([
          /^break\s*;\s*$/.test(text) ? "break" : "invalid",
        ]);
      }
      if (/^continue\b/.test(text)) {
        return new Set([
          /^continue\s*;\s*$/.test(text) ? "continue" : "invalid",
        ]);
      }
      if (/^[A-Za-z_]\w*\s*:/.test(text)) {
        return new Set(["unsafe"]);
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

function csharpCatchAt(code, start) {
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
    index += code.slice(index).match(/^when\b/)[0].length;
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
  const parsed = /^\s*((?:global::)?[\w.:]+)(?:\s+(\w+))?\s*$/.exec(
    header,
  );
  return {
    body: block.body,
    caughtName: parsed?.[2] ?? null,
    end: block.end,
    filter,
    header,
    start,
    type: parsed?.[1] ?? null,
  };
}

function allCSharpCatches(code) {
  const catches = [];
  for (const match of code.matchAll(/\bcatch\b/g)) {
    const parsed = csharpCatchAt(code, match.index);
    if (parsed) catches.push(parsed);
  }
  return catches;
}

function exactCredentialCatch(caught, aliases) {
  if (
    canonicalType(caught.type, aliases) ===
    "CredentialUnavailableException"
  ) {
    return true;
  }
  if (!caught.caughtName || !caught.filter) return false;
  const name = escapeRegExp(caught.caughtName);
  const match = new RegExp(
    `^\\s*\\(?\\s*${name}\\s+is\\s+((?:global::)?[\\w.:]+)(?:\\s+\\w+)?\\s*\\)?\\s*$`,
  ).exec(caught.filter);
  return (
    match !== null &&
    canonicalType(match[1], aliases) ===
      "CredentialUnavailableException"
  );
}

function attachedCatches(code, blockEnd) {
  const catches = [];
  let index = blockEnd;
  while (index < code.length) {
    while (/\s/.test(code[index] ?? "")) index += 1;
    const caught = csharpCatchAt(code, index);
    if (!caught) break;
    catches.push(caught);
    index = caught.end;
  }
  return catches;
}

function hasCredentialUnavailableHandling(source) {
  const { code } = literalAwareCode(source);
  const aliases = typeAliases(code);
  const catches = allCSharpCatches(code);
  if (
    catches.some(
      (caught) =>
        !exactCredentialCatch(caught, aliases) &&
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
          exactCredentialCatch(caught, aliases) &&
          (usefulUnavailableCatch(caught.caughtName, caught.body) ||
            csharpHandlerAlwaysCausal(caught.body, caught.caughtName)),
      )
    ) return true;
  }
  return false;
}

function projectDocuments(project) {
  const withoutComments = project.replace(/<!--[\s\S]*?-->/g, " ");
  return [
    ...withoutComments.matchAll(
      /<Project\b[^>]*>[\s\S]*?<\/Project\s*>/gi,
    ),
  ].map((match) => match[0]);
}

function xmlAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(
    /\b([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g,
  )) {
    attributes.set(match[1].toLowerCase(), match[3]);
  }
  return attributes;
}

function msbuildProperties(project) {
  const properties = new Map();
  for (const group of project.matchAll(
    /<PropertyGroup\b[^>]*>([\s\S]*?)<\/PropertyGroup\s*>/gi,
  )) {
    for (const property of group[1].matchAll(
      /<([A-Za-z_][\w.-]*)\b[^>]*>([^<]*)<\/\1\s*>/gi,
    )) {
      properties.set(property[1].toLowerCase(), property[2].trim());
    }
  }
  return properties;
}

function resolveMsbuildValue(value, properties, resolving = new Set()) {
  let unresolved = false;
  const resolved = value.replace(
    /\$\(([A-Za-z_][\w.-]*)\)/g,
    (_reference, propertyName) => {
      const key = propertyName.toLowerCase();
      if (resolving.has(key) || !properties.has(key)) {
        unresolved = true;
        return "";
      }
      const nested = resolveMsbuildValue(
        properties.get(key),
        properties,
        new Set([...resolving, key]),
      );
      if (nested === null) {
        unresolved = true;
        return "";
      }
      return nested;
    },
  );
  return unresolved || /\$\([^)]+\)/.test(resolved) ? null : resolved.trim();
}

function hasNet8Target(properties) {
  const values = [];
  for (const name of ["targetframework", "targetframeworks"]) {
    if (!properties.has(name)) continue;
    const value = resolveMsbuildValue(
      properties.get(name),
      properties,
      new Set([name]),
    );
    if (value === null) return false;
    values.push(...value.split(";").map((entry) => entry.trim()));
  }
  return values.some((value) =>
    /^net8\.0(?:-[a-z][a-z0-9]*(?:\.[0-9]+)*)?$/i.test(value),
  );
}

function packageReferences(project) {
  const references = [];
  for (const match of project.matchAll(
    /<PackageReference\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/PackageReference\s*>)/gi,
  )) {
    const attributes = xmlAttributes(match[1]);
    const childVersion =
      /<Version\b[^>]*>([^<]*)<\/Version\s*>/i.exec(match[2] ?? "")?.[1];
    references.push({
      include: attributes.get("include"),
      version: attributes.get("version") ?? childVersion,
    });
  }
  return references;
}

function hasExactPackage(references, properties, name, version) {
  return references.some((reference) => {
    if (!reference.include || reference.version === undefined) return false;
    const include = resolveMsbuildValue(reference.include, properties);
    const resolvedVersion = resolveMsbuildValue(reference.version, properties);
    return (
      include?.toLowerCase() === name.toLowerCase() &&
      (resolvedVersion === version || resolvedVersion === `[${version}]`)
    );
  });
}

function hasIdentityManifest(project) {
  return projectDocuments(project).some((document) => {
    const properties = msbuildProperties(document);
    if (!hasNet8Target(properties)) return false;
    const references = packageReferences(document);
    return (
      hasExactPackage(
        references,
        properties,
        "Azure.Identity",
        "1.21.0",
      ) &&
      hasExactPackage(
        references,
        properties,
        "Azure.Storage.Blobs",
        "12.29.2",
      )
    );
  });
}

const rules = {
  "prompt/identity-packages": ({ project }) => hasIdentityManifest(project),
  "prompt/system-assigned-credential": ({ analysis }) =>
    analysis.systemAssignedFound,
  "prompt/user-assigned-credential": ({ analysis }) =>
    analysis.userAssignedFound,
  "prompt/default-azure-credential": ({ analysis }) =>
    analysis.defaultCredentialFound,
  "prompt/local-fallback-chain": ({ analysis }) =>
    analysis.localFallbackFound,
  "prompt/credential-client-association": ({ analysis }) =>
    analysis.associationFound,
  "prompt/authenticated-operation": ({ analysis }) =>
    analysis.operationFound &&
    analysis.printedFields.has("AccountKind") &&
    analysis.printedFields.has("SkuName"),
  "prompt/credential-unavailable-error": ({ source }) =>
    hasCredentialUnavailableHandling(source),
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
