function cleanJava(source, preserveStrings) {
  let result = "";
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        state = "code";
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "string" || state === "character") {
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
      continue;
    }

    if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
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

function sanitizeBuild(build) {
  return cleanJava(build.replace(/<!--[\s\S]*?-->/g, " "), true);
}

function matchingIndex(text, start, open = "(", close = ")") {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === open) {
      depth += 1;
    } else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function statementEnd(text, start) {
  const depths = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character in depths) {
      depths[character] += 1;
    } else if (character in closing) {
      depths[closing[character]] -= 1;
    } else if (
      character === ";" &&
      Object.values(depths).every((depth) => depth === 0)
    ) {
      return index;
    }
  }
  return text.length;
}

function assignmentExpressions(source, typePattern) {
  const assignments = [];
  const modifiers =
    "(?:(?:public|protected|private|static|final|volatile|transient)\\s+)*";
  const pattern = new RegExp(
    `\\b${modifiers}(?:${typePattern}|var)\\s+(\\w+)\\s*=\\s*`,
    "g",
  );
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const end = statementEnd(source, pattern.lastIndex);
    assignments.push({
      name: match[1],
      expression: source.slice(pattern.lastIndex, end),
      start: match.index,
      end,
    });
    pattern.lastIndex = end + 1;
  }
  return assignments;
}

function latestAssignment(source, name, typePattern, before) {
  return assignmentExpressions(source.slice(0, before), typePattern)
    .filter((assignment) => assignment.name === name)
    .at(-1);
}

function callArguments(text, method) {
  const calls = [];
  const pattern = new RegExp(`\\.${method}\\s*\\(`, "g");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const open = text.indexOf("(", match.index);
    const close = matchingIndex(text, open);
    if (close !== -1) {
      calls.push(text.slice(open + 1, close));
      pattern.lastIndex = close + 1;
    }
  }
  return calls;
}

const qualified = (name) => `(?:[A-Za-z_$][\\w$]*\\.)*${name}`;
const credentialType = `(?:${qualified("DefaultAzureCredential")}|${qualified("TokenCredential")})`;
const credentialBuilderType = qualified("DefaultAzureCredentialBuilder");
const secretClientType = `(?:${qualified("SecretClient")}|${qualified("SecretAsyncClient")})`;
const secretClientBuilderType = qualified("SecretClientBuilder");

function directlyBuildsDefaultCredential(expression) {
  return new RegExp(
    `\\bnew\\s+${credentialBuilderType}\\s*\\([^;]*?\\)[\\s\\S]*?\\.build\\s*\\(\\s*\\)`,
  ).test(expression);
}

function expressionBuildsDefaultCredential(source, expression, before) {
  if (directlyBuildsDefaultCredential(expression)) {
    return true;
  }

  const buildReceiver = expression.match(/\b(\w+)\s*\.build\s*\(\s*\)/)?.[1];
  if (!buildReceiver) {
    return false;
  }
  const builder = latestAssignment(
    source,
    buildReceiver,
    credentialBuilderType,
    before,
  );
  return Boolean(
    builder &&
      new RegExp(`\\bnew\\s+${credentialBuilderType}\\s*\\(`).test(
        builder.expression,
      ),
  );
}

function credentialArgumentIsConstructed(source, argument, before) {
  if (expressionBuildsDefaultCredential(source, argument, before)) {
    return true;
  }

  const name = argument.trim().match(/(\w+)\s*$/)?.[1];
  if (!name) {
    return false;
  }
  const assignment = latestAssignment(
    source,
    name,
    credentialType,
    before,
  );
  return Boolean(
    assignment &&
      expressionBuildsDefaultCredential(
        source,
        assignment.expression,
        assignment.start,
      ),
  );
}

function hasDefaultCredentialConstruction(source) {
  if (directlyBuildsDefaultCredential(source)) {
    return true;
  }
  return assignmentExpressions(source, credentialType).some((assignment) =>
    expressionBuildsDefaultCredential(
      source,
      assignment.expression,
      assignment.start,
    ),
  );
}

function receiverStatements(source, receiver, start, end) {
  const statements = [];
  const pattern = new RegExp(`\\b${receiver}\\s*\\.`, "g");
  pattern.lastIndex = start;
  let match;
  while ((match = pattern.exec(source)) !== null && match.index < end) {
    const statementFinish = statementEnd(source, match.index);
    statements.push(source.slice(match.index, statementFinish));
    pattern.lastIndex = statementFinish + 1;
  }
  return statements;
}

function resolveClientBuilder(source, client) {
  if (
    new RegExp(`\\bnew\\s+${secretClientBuilderType}\\s*\\(`).test(
      client.expression,
    )
  ) {
    return client.expression;
  }

  const receiver = client.expression.match(
    /\b(\w+)\s*\.build(?:Async)?Client\s*\(/,
  )?.[1];
  if (!receiver) {
    return "";
  }
  const builder = latestAssignment(
    source,
    receiver,
    secretClientBuilderType,
    client.start,
  );
  if (!builder) {
    return "";
  }

  return [
    builder.expression,
    ...receiverStatements(source, receiver, builder.end + 1, client.end),
  ].join("\n");
}

function associatedClients(source) {
  return bindingAnalysis(source).associatedConstructions;
}

function systemOutputCalls(source) {
  const calls = [];
  const pattern =
    /\b(?:java\.lang\.)?System\s*\.\s*(?:out|err)\s*\.\s*(?:print|println|printf|format)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf("(", match.index);
    const close = matchingIndex(source, open);
    if (close !== -1) {
      calls.push({
        args: source.slice(open + 1, close),
        argsStart: open + 1,
        start: match.index,
      });
      pattern.lastIndex = close + 1;
    }
  }
  return calls;
}

function operationResultKind(expression, clientName) {
  const operation = new RegExp(
    `^\\s*${clientName}\\s*\\.\\s*(getSecretWithResponse|getSecret)\\s*\\(`,
  ).exec(expression);
  if (!operation) {
    return "";
  }

  const open = expression.indexOf("(", operation.index);
  const close = matchingIndex(expression, open);
  if (
    close === -1 ||
    expression.slice(open + 1, close).trim().length === 0
  ) {
    return "";
  }

  let suffix = expression.slice(close + 1);
  let valueCalls = 0;
  while (/^\s*\.\s*getValue\s*\(\s*\)/.test(suffix)) {
    suffix = suffix.replace(/^\s*\.\s*getValue\s*\(\s*\)/, "");
    valueCalls += 1;
  }

  if (operation[1] === "getSecretWithResponse") {
    return valueCalls >= 2 ? "value" : valueCalls === 1 ? "secret" : "response";
  }
  return valueCalls >= 1 ? "value" : "secret";
}

function directlyOutputsOperationValue(expression, clientName) {
  const pattern = new RegExp(
    `\\b${clientName}\\s*\\.\\s*(?:getSecretWithResponse|getSecret)\\s*\\(`,
    "g",
  );
  let match;
  while ((match = pattern.exec(expression)) !== null) {
    if (operationResultKind(expression.slice(match.index), clientName) === "value") {
      return true;
    }
  }
  return false;
}

function outputUsesResult(expression, name, kind) {
  const receiver = `\\b${name}\\s*\\.\\s*getValue\\s*\\(\\s*\\)`;
  if (kind === "response") {
    return new RegExp(`${receiver}\\s*\\.\\s*getValue\\s*\\(\\s*\\)`).test(
      expression,
    );
  }
  if (kind === "secret") {
    return new RegExp(receiver).test(expression);
  }
  return kind === "value" && new RegExp(`\\b${name}\\b`).test(expression);
}

function variableAssignments(source) {
  const assignments = [];
  const pattern =
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(>>>=|>>=|<<=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|=(?!=))/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const end = statementEnd(source, pattern.lastIndex);
    assignments.push({
      name: match[1],
      operator: match[2],
      expression: source.slice(pattern.lastIndex, end),
      expressionStart: pattern.lastIndex,
      start: match.index,
      end,
    });
    pattern.lastIndex = end + 1;
  }
  return assignments;
}

function lexicalScopes(source) {
  const root = { id: 0, start: 0, end: source.length, parent: null };
  const scopes = [root];
  const stack = [root];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "{") {
      const scope = {
        id: scopes.length,
        start: index + 1,
        end: source.length,
        parent: stack.at(-1),
      };
      scopes.push(scope);
      stack.push(scope);
    } else if (source[index] === "}" && stack.length > 1) {
      stack.pop().end = index;
    }
  }
  return scopes;
}

function scopeAt(scopes, position) {
  let selected = scopes[0];
  for (const scope of scopes) {
    if (
      scope.start <= position &&
      position <= scope.end &&
      scope.start >= selected.start
    ) {
      selected = scope;
    }
  }
  return selected;
}

function declarations(source, scopes) {
  const found = [];
  const modifiers =
    "(?:(?:public|protected|private|static|final|volatile|transient)\\s+)*";
  const type =
    "((?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*[A-Za-z_$][\\w$]*(?:\\s*<[^;={}()]+>)?(?:\\s*\\[\\s*\\])*)";
  const pattern = new RegExp(
    `\\b${modifiers}${type}\\s+([A-Za-z_$][\\w$]*)\\s*(?==|;)`,
    "g",
  );
  let match;
  while ((match = pattern.exec(source)) !== null) {
    found.push({
      id: found.length,
      type: match[1].replace(/\s+/g, ""),
      name: match[2],
      start: match.index,
      nameStart: match.index + match[0].lastIndexOf(match[2]),
      scope: scopeAt(scopes, match.index),
    });
  }
  return found;
}

function declaredKind(type) {
  const simple = type
    .replace(/<[\s\S]*>/, "")
    .replace(/\[\]$/, "")
    .split(".")
    .at(-1);
  if (simple === "DefaultAzureCredentialBuilder") {
    return "credential-builder";
  }
  if (simple === "DefaultAzureCredential" || simple === "TokenCredential") {
    return "credential";
  }
  if (simple === "SecretClientBuilder") {
    return "client-builder";
  }
  if (simple === "SecretClient" || simple === "SecretAsyncClient") {
    return "client";
  }
  return simple === "var" ? "var" : "";
}

function resolveDeclaration(allDeclarations, name, position, scopes) {
  let scope = scopeAt(scopes, position);
  while (scope) {
    const candidate = allDeclarations
      .filter(
        (declaration) =>
          declaration.name === name &&
          declaration.scope === scope &&
          declaration.nameStart <= position,
      )
      .at(-1);
    if (candidate) {
      return candidate;
    }
    scope = scope.parent;
  }
  return null;
}

function exactReference(expression) {
  return /^([A-Za-z_$][\w$]*)$/.exec(unwrapParentheses(expression))?.[1] ?? "";
}

function credentialSource(source, expression, position, context) {
  if (directlyBuildsDefaultCredential(expression)) {
    return { valid: true, binding: null };
  }

  const receiver = unwrapParentheses(expression).match(
    /^([A-Za-z_$][\w$]*)\s*\.build\s*\(\s*\)$/,
  )?.[1];
  if (receiver) {
    const binding = context.resolve(receiver, position);
    const state = binding && context.states.get(binding);
    return {
      valid: state?.kind === "credential-builder" && state.valid,
      binding: null,
    };
  }

  const reference = exactReference(expression);
  const binding = reference && context.resolve(reference, position);
  const state = binding && context.states.get(binding);
  return {
    valid: state?.kind === "credential" && state.valid,
    binding: state?.kind === "credential" ? binding : null,
  };
}

function applyCredentialCall(source, expression, position, state, context) {
  const argumentsList = callArguments(expression, "credential");
  if (argumentsList.length === 0) {
    return state;
  }
  return {
    ...state,
    credential: credentialSource(
      source,
      argumentsList.at(-1),
      position,
      context,
    ),
  };
}

function sourceIsValid(sourceState, states) {
  if (!sourceState?.valid) {
    return false;
  }
  if (!sourceState.binding) {
    return true;
  }
  const state = states.get(sourceState.binding);
  return state?.kind === "credential" && state.valid;
}

function expressionState(source, expression, position, expectedKind, context) {
  const value = unwrapParentheses(expression);
  const reference = exactReference(value);
  if (reference) {
    const binding = context.resolve(reference, position);
    const state = binding && context.states.get(binding);
    return state && (expectedKind === "var" || state.kind === expectedKind)
      ? { ...state }
      : null;
  }

  if (expectedKind === "credential-builder") {
    return (
      new RegExp(`^\\s*new\\s+${credentialBuilderType}\\s*\\(`).test(value) &&
      !/\.build\s*\(\s*\)\s*$/.test(value)
    )
      ? { kind: expectedKind, valid: true }
      : null;
  }
  if (expectedKind === "credential") {
    const credential = credentialSource(source, value, position, context);
    return { kind: expectedKind, valid: credential.valid };
  }

  if (expectedKind === "client-builder") {
    let state = null;
    if (
      new RegExp(`^\\s*new\\s+${secretClientBuilderType}\\s*\\(`).test(value) &&
      !/\.build(?:Async)?Client\s*\(\s*\)\s*$/.test(value)
    ) {
      state = {
        kind: expectedKind,
        valid: true,
        credential: { valid: false, binding: null },
      };
    } else {
      const receiver = value.match(/^([A-Za-z_$][\w$]*)\s*\./)?.[1];
      const binding = receiver && context.resolve(receiver, position);
      const current = binding && context.states.get(binding);
      if (current?.kind === expectedKind) {
        state = { ...current };
      }
    }
    return state
      ? applyCredentialCall(source, value, position, state, context)
      : null;
  }

  if (expectedKind === "client") {
    if (!/\.build(?:Async)?Client\s*\(\s*\)\s*$/.test(value)) {
      return null;
    }
    let builder = null;
    if (new RegExp(`^\\s*new\\s+${secretClientBuilderType}\\s*\\(`).test(value)) {
      builder = {
        kind: "client-builder",
        valid: true,
        credential: { valid: false, binding: null },
      };
    } else {
      const receiver = value.match(/^([A-Za-z_$][\w$]*)\s*\./)?.[1];
      const binding = receiver && context.resolve(receiver, position);
      const state = binding && context.states.get(binding);
      if (state?.kind === "client-builder") {
        builder = { ...state };
      }
    }
    builder = builder
      ? applyCredentialCall(source, value, position, builder, context)
      : null;
    return {
      kind: expectedKind,
      valid:
        Boolean(builder?.valid) &&
        sourceIsValid(builder?.credential, context.states),
      credential: builder?.credential ?? null,
    };
  }

  if (expectedKind === "var") {
    for (const kind of [
      "credential",
      "client",
      "credential-builder",
      "client-builder",
    ]) {
      const state = expressionState(source, expression, position, kind, context);
      if (state?.valid) {
        return state;
      }
    }
  }
  return null;
}

function credentialCallEvents(source) {
  const events = [];
  const pattern = /\b([A-Za-z_$][\w$]*)\s*\./g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const end = statementEnd(source, match.index);
    const statement = source.slice(match.index, end);
    const argumentsList = callArguments(statement, "credential");
    if (argumentsList.length > 0) {
      events.push({
        type: "credential-call",
        receiver: match[1],
        argument: argumentsList.at(-1),
        start: match.index,
      });
    }
    pattern.lastIndex = end + 1;
  }
  return events;
}

function bindingAnalysis(source) {
  const scopes = lexicalScopes(source);
  const allDeclarations = declarations(source, scopes);
  const relevant = allDeclarations.filter((declaration) =>
    declaredKind(declaration.type),
  );
  const assignments = variableAssignments(source);
  const events = [
    ...assignments.map((assignment) => ({
      ...assignment,
      type: "assignment",
    })),
    ...credentialCallEvents(source),
  ].sort((left, right) => left.start - right.start);

  const simulate = (before) => {
    const states = new Map();
    const associatedConstructions = [];
    const context = {
      states,
      resolve: (name, position) =>
        resolveDeclaration(relevant, name, position, scopes),
    };
    for (const event of events) {
      if (event.start >= before) {
        break;
      }
      if (event.type === "credential-call") {
        const binding = context.resolve(event.receiver, event.start);
        const state = binding && states.get(binding);
        if (state?.kind === "client-builder") {
          states.set(binding, {
            ...state,
            credential: credentialSource(
              source,
              event.argument,
              event.start,
              context,
            ),
          });
        }
        continue;
      }

      const binding = context.resolve(event.name, event.start);
      if (!binding) {
        continue;
      }
      const declared = declaredKind(binding.type);
      const currentKind =
        declared === "var" ? states.get(binding)?.kind ?? "var" : declared;
      const next =
        event.operator === "="
          ? expressionState(
              source,
              event.expression,
              event.expressionStart,
              currentKind,
              context,
            )
          : null;
      states.set(binding, next ?? { kind: currentKind, valid: false });
      if (
        currentKind === "client" &&
        /\.build(?:Async)?Client\s*\(\s*\)\s*$/.test(
          unwrapParentheses(event.expression),
        ) &&
        next?.valid
      ) {
        associatedConstructions.push({
          name: binding.name,
          start: event.start,
          end: event.end,
        });
      }
    }
    return { states, associatedConstructions };
  };

  const clientIsAssociated = (name, position) => {
    const { states } = simulate(position);
    const binding = resolveDeclaration(relevant, name, position, scopes);
    const state = binding && states.get(binding);
    return (
      state?.kind === "client" &&
      state.valid &&
      sourceIsValid(state.credential, states)
    );
  };

  return {
    allDeclarations,
    scopes,
    clientIsAssociated,
    associatedConstructions: simulate(source.length + 1).associatedConstructions,
  };
}

function unwrapParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith("(")) {
    const close = matchingIndex(value, 0);
    if (close !== value.length - 1) {
      break;
    }
    value = value.slice(1, -1).trim();
  }
  return value;
}

function exactOperationResultKind(expression, clientName) {
  const value = unwrapParentheses(expression);
  const operation = new RegExp(
    `^\\s*${clientName}\\s*\\.\\s*(getSecretWithResponse|getSecret)\\s*\\(`,
  ).exec(value);
  if (!operation) {
    return "";
  }

  const open = value.indexOf("(", operation.index);
  const close = matchingIndex(value, open);
  if (
    close === -1 ||
    value.slice(open + 1, close).trim().length === 0
  ) {
    return "";
  }

  let suffix = value.slice(close + 1);
  let valueCalls = 0;
  while (/^\s*\.\s*getValue\s*\(\s*\)/.test(suffix)) {
    suffix = suffix.replace(/^\s*\.\s*getValue\s*\(\s*\)/, "");
    valueCalls += 1;
  }
  if (suffix.trim().length > 0) {
    return "";
  }

  if (operation[1] === "getSecretWithResponse") {
    return valueCalls === 2
      ? "value"
      : valueCalls === 1
        ? "secret"
        : "response";
  }
  return valueCalls === 1 ? "value" : valueCalls === 0 ? "secret" : "";
}

function assignmentProvenance(expression, clientName, provenances) {
  const operationKind = exactOperationResultKind(expression, clientName);
  if (operationKind) {
    return operationKind;
  }

  const value = unwrapParentheses(expression);
  const reference = /^([A-Za-z_$][\w$]*)([\s\S]*)$/.exec(value);
  if (!reference) {
    return "";
  }

  let kind = provenances.get(reference[1]);
  if (!kind) {
    return "";
  }

  let suffix = reference[2];
  while (/^\s*\.\s*getValue\s*\(\s*\)/.test(suffix)) {
    suffix = suffix.replace(/^\s*\.\s*getValue\s*\(\s*\)/, "");
    if (kind === "response") {
      kind = "secret";
    } else if (kind === "secret") {
      kind = "value";
    } else {
      return "";
    }
  }
  return suffix.trim().length === 0 ? kind : "";
}

function outputUsesProvenance(expression, provenances) {
  for (const [name, kind] of provenances) {
    if (
      !new RegExp(`\\b${name}\\s*=(?!=)`).test(expression) &&
      outputUsesResult(expression, name, kind)
    ) {
      return true;
    }
  }
  return false;
}

function exactAssociatedOperationKind(expression, position, analysis) {
  const value = unwrapParentheses(expression);
  const clientName = value.match(
    /^([A-Za-z_$][\w$]*)\s*\.\s*(?:getSecretWithResponse|getSecret)\s*\(/,
  )?.[1];
  if (!clientName || !analysis.clientIsAssociated(clientName, position)) {
    return "";
  }
  return exactOperationResultKind(value, clientName);
}

function directlyOutputsAssociatedValue(expression, position, analysis) {
  const pattern =
    /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:getSecretWithResponse|getSecret)\s*\(/g;
  let match;
  while ((match = pattern.exec(expression)) !== null) {
    if (
      analysis.clientIsAssociated(match[1], position + match.index) &&
      operationResultKind(expression.slice(match.index), match[1]) === "value"
    ) {
      return true;
    }
  }
  return false;
}

function provenanceKind(expression, position, analysis, provenances) {
  const operationKind = exactAssociatedOperationKind(
    expression,
    position,
    analysis,
  );
  if (operationKind) {
    return operationKind;
  }

  const value = unwrapParentheses(expression);
  const reference = /^([A-Za-z_$][\w$]*)([\s\S]*)$/.exec(value);
  if (!reference) {
    return "";
  }
  const binding = resolveDeclaration(
    analysis.allDeclarations,
    reference[1],
    position,
    analysis.scopes,
  );
  let kind = binding && provenances.get(binding);
  if (!kind) {
    return "";
  }

  let suffix = reference[2];
  while (/^\s*\.\s*getValue\s*\(\s*\)/.test(suffix)) {
    suffix = suffix.replace(/^\s*\.\s*getValue\s*\(\s*\)/, "");
    if (kind === "response") {
      kind = "secret";
    } else if (kind === "secret") {
      kind = "value";
    } else {
      return "";
    }
  }
  return suffix.trim().length === 0 ? kind : "";
}

function expectedProvenanceKind(type) {
  const simple = type
    .replace(/<[\s\S]*>/, "")
    .replace(/\[\]$/, "")
    .split(".")
    .at(-1);
  if (simple === "Response") {
    return "response";
  }
  if (simple === "KeyVaultSecret") {
    return "secret";
  }
  if (simple === "String") {
    return "value";
  }
  return "";
}

function outputUsesScopedProvenance(
  expression,
  position,
  analysis,
  provenances,
) {
  for (const [binding, kind] of provenances) {
    if (
      resolveDeclaration(
        analysis.allDeclarations,
        binding.name,
        position,
        analysis.scopes,
      ) === binding &&
      !new RegExp(`\\b${binding.name}\\s*=(?!=)`).test(expression) &&
      outputUsesResult(expression, binding.name, kind)
    ) {
      return true;
    }
  }
  return false;
}

function printsAssociatedSecretValue(source) {
  const outputs = systemOutputCalls(source);
  const assignments = variableAssignments(source);
  const analysis = bindingAnalysis(source);
  const provenances = new Map();
  const inferredKinds = new Map();
  let assignmentIndex = 0;

  for (const output of outputs) {
    while (
      assignmentIndex < assignments.length &&
      assignments[assignmentIndex].start < output.start
    ) {
      const assignment = assignments[assignmentIndex];
      const binding = resolveDeclaration(
        analysis.allDeclarations,
        assignment.name,
        assignment.start,
        analysis.scopes,
      );
      if (binding) {
        const kind =
          assignment.operator === "="
            ? provenanceKind(
                assignment.expression,
                assignment.expressionStart,
                analysis,
                provenances,
              )
            : "";
        const expected =
          expectedProvenanceKind(binding.type) || inferredKinds.get(binding);
        if (kind && (!expected || expected === kind)) {
          provenances.set(binding, kind);
          if (binding.type === "var" && !inferredKinds.has(binding)) {
            inferredKinds.set(binding, kind);
          }
        } else {
          provenances.delete(binding);
        }
      }
      assignmentIndex += 1;
    }

    if (
      directlyOutputsAssociatedValue(output.args, output.argsStart, analysis) ||
      outputUsesScopedProvenance(
        output.args,
        output.argsStart,
        analysis,
        provenances,
      )
    ) {
      return true;
    }
  }
  return false;
}

function authenticationErrorTypes(header) {
  const caught = new Set();
  for (const type of [
    "CredentialUnavailableException",
    "ClientAuthenticationException",
  ]) {
    if (
      new RegExp(`(?:^|[\\s|])${qualified(type)}(?:\\s|[|])`).test(
        ` ${header} `,
      )
    ) {
      caught.add(type);
    }
  }
  return caught;
}

function catchTypesAfter(source, blockEnd) {
  const caught = new Set();
  let cursor = blockEnd + 1;
  while (cursor < source.length) {
    cursor += source.slice(cursor).match(/^\s*/)[0].length;
    if (!source.startsWith("catch", cursor)) {
      break;
    }
    const open = source.indexOf("(", cursor + "catch".length);
    const close = matchingIndex(source, open);
    if (open === -1 || close === -1) {
      break;
    }
    const catchOpen = source.indexOf("{", close);
    const catchClose = matchingIndex(source, catchOpen, "{", "}");
    if (catchOpen === -1 || catchClose === -1) {
      break;
    }
    const header = source.slice(open + 1, close);
    const body = source.slice(catchOpen + 1, catchClose);
    if (hasMeaningfulAuthenticationCatch(header, body)) {
      for (const type of authenticationErrorTypes(header)) {
        caught.add(type);
      }
    }
    cursor = catchClose + 1;
  }
  return caught;
}

function hasMeaningfulAuthenticationCatch(header, body) {
  const parameter = header.match(/\b([A-Za-z_$][\w$]*)\s*$/)?.[1];
  if (
    /\b(?:throw|return)\b/.test(body) ||
    /\b(?:java\.lang\.)?System\s*\.\s*(?:out|err)\s*\.\s*(?:print|println|printf|format)\s*\(/.test(
      body,
    ) ||
    /\b(?:System\s*\.\s*exit|[A-Za-z_$][\w$]*\s*\.\s*(?:trace|debug|info|warn|warning|error|fatal|log))\s*\(/.test(
      body,
    )
  ) {
    return true;
  }
  if (!parameter) {
    return false;
  }
  return new RegExp(
    `\\b(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*[A-Za-z_$][\\w$]*\\s*\\([^;{}]*\\b${parameter}\\b[^;{}]*\\)`,
  ).test(body);
}

function catchesAuthenticationErrors(source) {
  const analysis = bindingAnalysis(source);
  const pattern = /\btry\b/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    let cursor = match.index + match[0].length;
    cursor += source.slice(cursor).match(/^\s*/)[0].length;
    if (source[cursor] === "(") {
      cursor = matchingIndex(source, cursor) + 1;
      if (cursor === 0) {
        continue;
      }
      cursor += source.slice(cursor).match(/^\s*/)[0].length;
    }
    if (source[cursor] !== "{") {
      continue;
    }
    const blockEnd = matchingIndex(source, cursor, "{", "}");
    if (blockEnd === -1) {
      continue;
    }
    const body = source.slice(cursor + 1, blockEnd);
    const operationPattern =
      /\b([A-Za-z_$][\w$]*)\s*\.\s*getSecret(?:WithResponse)?\s*\(/g;
    const invokesAssociatedClient = Array.from(body.matchAll(operationPattern))
      .some((operation) =>
        analysis.clientIsAssociated(
          operation[1],
          cursor + 1 + operation.index,
        ),
      );
    const caught = catchTypesAfter(source, blockEnd);
    if (
      invokesAssociatedClient &&
      caught.has("CredentialUnavailableException") &&
      caught.has("ClientAuthenticationException")
    ) {
      return true;
    }
    pattern.lastIndex = blockEnd + 1;
  }

  return false;
}

function hasDependency(build, group, artifact) {
  const dependencies = build.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [];
  const maven = dependencies.some(
    (dependency) =>
      new RegExp(
        `<groupId>\\s*${group.replaceAll(".", "\\.")}\\s*<\\/groupId>`,
      ).test(dependency) &&
      new RegExp(
        `<artifactId>\\s*${artifact}\\s*<\\/artifactId>`,
      ).test(dependency),
  );
  const gradle = new RegExp(
    `["']${group.replaceAll(".", "\\.")}:${artifact}(?::[^"']+)?["']`,
  ).test(build);
  return maven || gradle;
}

function hasIdentityDiagnostics(sourceWithStrings, build) {
  const configured = [
    /(?:java\.lang\.)?System\s*\.\s*setProperty\s*\(\s*"org\.slf4j\.simpleLogger\.log\.com\.azure\.identity"\s*,\s*"(?:debug|trace)"\s*\)/i,
    /(?:java\.lang\.)?System\s*\.\s*setProperty\s*\(\s*org\.slf4j\.simple\.SimpleLogger\.DEFAULT_LOG_LEVEL_KEY\s*,\s*"(?:debug|trace)"\s*\)/i,
  ]
    .map((pattern) => sourceWithStrings.search(pattern))
    .find((index) => index >= 0);
  if (configured === undefined) {
    return false;
  }

  const firstIdentityUse = sourceWithStrings.search(
    /\bnew\s+(?:[A-Za-z_$][\w$]*\.)*(?:DefaultAzureCredentialBuilder|SecretClientBuilder)\b/,
  );
  return (
    (firstIdentityUse === -1 || configured < firstIdentityUse) &&
    hasDependency(build, "org.slf4j", "slf4j-simple")
  );
}

const rules = {
  "prompt/identity-packages": ({ build }) =>
    hasDependency(build, "com.azure", "azure-identity") &&
    hasDependency(build, "com.azure", "azure-security-keyvault-secrets"),
  "prompt/default-azure-credential": ({ source }) =>
    hasDefaultCredentialConstruction(source),
  "prompt/credential-client-association": ({ source }) =>
    associatedClients(source).length > 0,
  "prompt/authenticated-operation": ({ source }) =>
    printsAssociatedSecretValue(source),
  "prompt/auth-errors": ({ source }) => catchesAuthenticationErrors(source),
  "prompt/identity-diagnostics": ({ sourceWithStrings, build }) =>
    hasIdentityDiagnostics(sourceWithStrings, build),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }

  const hasSource = Array.isArray(workspace.sourceFiles)
    ? workspace.sourceFiles.length > 0
    : Boolean(workspace.source?.trim());
  if (!hasSource) {
    return false;
  }

  const source = cleanJava(workspace.source ?? "", false);
  const sourceWithStrings = cleanJava(workspace.source ?? "", true);
  const build = sanitizeBuild(workspace.build ?? "");
  return rule({ ...workspace, source, sourceWithStrings, build });
}

export function ruleNames() {
  return Object.keys(rules);
}
