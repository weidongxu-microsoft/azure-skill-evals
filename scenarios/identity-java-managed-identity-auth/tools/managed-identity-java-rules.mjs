function sanitizeJava(source) {
  let result = "";
  let state = "code";
  const preserved = new Set([
    "AZURE_KEY_VAULT_URL",
    "AZURE_KEY_VAULT_SECRET_NAME",
    "AZURE_CLIENT_ID",
  ]);

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
        result += "  ";
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        result += character;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
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
    } else if (character === '"' || character === "'") {
      const quote = character;
      const end = source.indexOf(quote, index + 1);
      const value = end === -1 ? "" : source.slice(index + 1, end);
      if (quote === '"' && preserved.has(value)) {
        result += source.slice(index, end + 1);
        index = end;
      } else {
        result += character;
        state = character === '"' ? "string" : "character";
      }
    } else {
      result += character;
    }
  }
  return result;
}

function sanitizeBuild(build) {
  return build.replace(/<!--[\s\S]*?-->/g, " ");
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

function calls(text) {
  const found = [];
  const pattern = /\.([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const open = text.indexOf("(", match.index);
    const close = matchingIndex(text, open);
    if (close !== -1) {
      found.push({
        method: match[1],
        args: text.slice(open + 1, close),
        start: match.index,
      });
      pattern.lastIndex = close + 1;
    }
  }
  return found;
}

function lexicalScopes(source) {
  const root = {
    id: 0,
    start: 0,
    end: source.length,
    parent: null,
    kind: "root",
  };
  const scopes = [root];
  const stack = [root];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "{") {
      const prefix = source.slice(
        Math.max(
          source.lastIndexOf(";", index - 1),
          source.lastIndexOf("}", index - 1),
          source.lastIndexOf("{", index - 1),
        ) + 1,
        index,
      );
      const scope = {
        id: scopes.length,
        start: index + 1,
        end: source.length,
        parent: stack.at(-1),
        kind: /\b(?:class|record|enum)\s+[A-Za-z_$][\w$]*[\s\S]*$/.test(
          prefix,
        )
          ? "type"
          : "block",
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

function resolveDeclaration(allDeclarations, name, position, scopes) {
  const explicitField = /^this\.([A-Za-z_$][\w$]*)$/.exec(name);
  if (explicitField) {
    let scope = scopeAt(scopes, position);
    const typeScopes = new Set();
    while (scope) {
      if (scope.kind === "type") {
        typeScopes.add(scope);
      }
      scope = scope.parent;
    }
    return (
      allDeclarations
        .filter(
          (declaration) =>
            declaration.name === explicitField[1] &&
            typeScopes.has(declaration.scope),
        )
        .sort((left, right) => left.scope.start - right.scope.start)
        .at(-1) ?? null
    );
  }

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

function simpleType(type) {
  return type
    .replace(/<[\s\S]*>/, "")
    .replace(/\[\]$/, "")
    .split(".")
    .at(-1);
}

function declaredKind(type) {
  const simple = simpleType(type);
  const kinds = {
    String: "string",
    ManagedIdentityCredentialBuilder: "mi-builder",
    ManagedIdentityCredential: "credential",
    DefaultAzureCredentialBuilder: "default-builder",
    DefaultAzureCredential: "credential",
    AzureCliCredentialBuilder: "cli-builder",
    AzureCliCredential: "credential",
    ChainedTokenCredentialBuilder: "chain-builder",
    ChainedTokenCredential: "credential",
    TokenCredential: "credential",
    SecretClientBuilder: "client-builder",
    SecretClient: "client",
    KeyVaultSecret: "secret",
    Response: "response",
  };
  return simple === "var" ? "var" : kinds[simple] ?? "";
}

function assignmentEvents(source) {
  const assignments = [];
  const pattern =
    /(?<![\w$.])((?:this\s*\.\s*)?[A-Za-z_$][\w$]*)\s*(>>>=|>>=|<<=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|=(?!=))/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const end = statementEnd(source, pattern.lastIndex);
    assignments.push({
      type: "assignment",
      name: match[1].replace(/\s+/g, ""),
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

function mutationEvents(source) {
  const events = [];
  const pattern = /(?:^|[;{}])\s*([A-Za-z_$][\w$]*)\s*\./g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const start = match.index + match[0].lastIndexOf(match[1]);
    const end = statementEnd(source, start);
    const expression = source.slice(start, end);
    const firstOpen = expression.indexOf("(");
    const assignment = expression.search(/=(?!=)/);
    if (firstOpen !== -1 && (assignment === -1 || firstOpen < assignment)) {
      events.push({
        type: "mutation",
        receiver: match[1],
        expression,
        start,
        end,
      });
      pattern.lastIndex = end;
    }
  }
  return events;
}

function exactReference(expression) {
  return /^(?:(this)\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(
    unwrapParentheses(expression),
  )
    ?.slice(1)
    .filter(Boolean)
    .join(".") ?? "";
}

function cloneState(state) {
  if (!state) {
    return null;
  }
  return {
    ...state,
    items: state.items ? state.items.map((item) => ({ ...item })) : undefined,
    credential: state.credential ? { ...state.credential } : undefined,
  };
}

function hasConstructor(expression, type) {
  return new RegExp(
    `^\\s*new\\s+(?:[A-Za-z_$][\\w$]*\\.)*${type}\\s*\\(`,
  ).test(expression);
}

function directEnvironment(expression) {
  return /^(?:java\.lang\.)?System\s*\.\s*getenv\s*\(\s*"(AZURE_KEY_VAULT_URL|AZURE_KEY_VAULT_SECRET_NAME|AZURE_CLIENT_ID)"\s*\)$/.exec(
    unwrapParentheses(expression),
  )?.[1];
}

function environmentSource(expression, position, context) {
  const direct = directEnvironment(expression);
  if (direct) {
    return direct;
  }
  const reference = exactReference(expression);
  const binding = reference && context.resolve(reference, position);
  const state = binding && context.states.get(binding);
  return state?.kind === "string" && state.valid ? state.environment : "";
}

function credentialSource(expression, position, context) {
  const reference = exactReference(expression);
  if (reference) {
    const binding = context.resolve(reference, position);
    const state = binding && context.states.get(binding);
    return state?.kind === "credential"
      ? { valid: state.valid, credentialKind: state.credentialKind, binding }
      : { valid: false, credentialKind: "", binding: null };
  }
  const state = expressionState(expression, position, "credential", context);
  return state?.kind === "credential"
    ? {
        valid: state.valid,
        credentialKind: state.credentialKind,
        binding: null,
      }
    : { valid: false, credentialKind: "", binding: null };
}

function sourceIsValid(source, context) {
  if (!source?.valid) {
    return false;
  }
  if (!source.binding) {
    return true;
  }
  const state = context.states.get(source.binding);
  return (
    state?.kind === "credential" &&
    state.valid &&
    state.credentialKind === source.credentialKind
  );
}

function applyBuilderCalls(state, expression, position, context) {
  let next = cloneState(state);
  for (const call of calls(expression)) {
    if (next.kind === "mi-builder" && call.method === "clientId") {
      next.clientId =
        environmentSource(call.args, position + call.start, context) ===
        "AZURE_CLIENT_ID";
    } else if (
      next.kind === "default-builder" &&
      call.method === "managedIdentityClientId"
    ) {
      next.clientId =
        environmentSource(call.args, position + call.start, context) ===
        "AZURE_CLIENT_ID";
    } else if (
      next.kind === "default-builder" &&
      call.method === "excludeManagedIdentityCredential"
    ) {
      next.managedIdentityEnabled = false;
    } else if (
      next.kind === "chain-builder" &&
      (call.method === "addFirst" || call.method === "addLast")
    ) {
      const credential = credentialSource(
        call.args,
        position + call.start,
        context,
      );
      if (call.method === "addFirst") {
        next.items.unshift(credential);
      } else {
        next.items.push(credential);
      }
    } else if (next.kind === "client-builder" && call.method === "vaultUrl") {
      next.vaultUrl =
        environmentSource(call.args, position + call.start, context) ===
        "AZURE_KEY_VAULT_URL";
    } else if (next.kind === "client-builder" && call.method === "credential") {
      next.credential = credentialSource(
        call.args,
        position + call.start,
        context,
      );
    }
  }
  return next;
}

function builtCredential(builder, context) {
  if (builder.kind === "mi-builder") {
    return {
      kind: "credential",
      valid: builder.valid && (builder.clientId === false || builder.clientId),
      credentialKind: builder.clientId ? "user-mi" : "system-mi",
    };
  }
  if (builder.kind === "default-builder") {
    return {
      kind: "credential",
      valid: builder.valid && builder.managedIdentityEnabled,
      credentialKind: "default",
      managedIdentityEnabled: builder.managedIdentityEnabled,
      clientId: builder.clientId,
    };
  }
  if (builder.kind === "cli-builder") {
    return {
      kind: "credential",
      valid: builder.valid,
      credentialKind: "cli",
    };
  }
  if (builder.kind === "chain-builder") {
    const items = builder.items ?? [];
    const validItems = items.every((item) => sourceIsValid(item, context));
    return {
      kind: "credential",
      valid:
        builder.valid &&
        validItems &&
        items.length >= 2 &&
        ["system-mi", "user-mi"].includes(items[0]?.credentialKind) &&
        items.at(-1)?.credentialKind === "cli",
      credentialKind: "chain",
    };
  }
  return null;
}

function builderFromExpression(expression, position, kind, context) {
  const constructors = {
    "mi-builder": "ManagedIdentityCredentialBuilder",
    "default-builder": "DefaultAzureCredentialBuilder",
    "cli-builder": "AzureCliCredentialBuilder",
    "chain-builder": "ChainedTokenCredentialBuilder",
    "client-builder": "SecretClientBuilder",
  };
  let state = null;
  if (hasConstructor(expression, constructors[kind])) {
    if (kind === "mi-builder") {
      state = { kind, valid: true, clientId: false };
    } else if (kind === "default-builder") {
      state = {
        kind,
        valid: true,
        managedIdentityEnabled: true,
        clientId: false,
      };
    } else if (kind === "chain-builder") {
      state = { kind, valid: true, items: [] };
    } else if (kind === "client-builder") {
      state = {
        kind,
        valid: true,
        vaultUrl: false,
        credential: { valid: false, credentialKind: "", binding: null },
      };
    } else {
      state = { kind, valid: true };
    }
  } else {
    const receiver = unwrapParentheses(expression).match(
      /^([A-Za-z_$][\w$]*)\s*\./,
    )?.[1];
    const binding = receiver && context.resolve(receiver, position);
    const current = binding && context.states.get(binding);
    if (current?.kind === kind) {
      state = cloneState(current);
    }
  }
  return state
    ? applyBuilderCalls(state, expression, position, context)
    : null;
}

function expressionState(expression, position, expectedKind, context) {
  const value = unwrapParentheses(expression);
  const reference = exactReference(value);
  if (reference) {
    const binding = context.resolve(reference, position);
    const state = binding && context.states.get(binding);
    return state && (expectedKind === "var" || state.kind === expectedKind)
      ? cloneState(state)
      : null;
  }

  if (expectedKind === "string" || expectedKind === "var") {
    const environment = directEnvironment(value);
    if (environment) {
      return { kind: "string", valid: true, environment };
    }
  }

  const builderKinds = [
    "mi-builder",
    "default-builder",
    "cli-builder",
    "chain-builder",
    "client-builder",
  ];
  if (builderKinds.includes(expectedKind)) {
    return builderFromExpression(
      value,
      position,
      expectedKind,
      context,
    );
  }

  if (expectedKind === "credential" || expectedKind === "var") {
    for (const kind of builderKinds.slice(0, 4)) {
      const builder = builderFromExpression(value, position, kind, context);
      if (
        builder &&
        /\.build\s*\(\s*\)\s*$/.test(value)
      ) {
        const credential = builtCredential(builder, context);
        if (credential) {
          context.constructions.push(credential);
          return credential;
        }
      }
    }
  }

  if (expectedKind === "client" || expectedKind === "var") {
    if (/\.buildClient\s*\(\s*\)\s*$/.test(value)) {
      const builder = builderFromExpression(
        value,
        position,
        "client-builder",
        context,
      );
      if (builder) {
        return {
          kind: "client",
          valid:
            builder.valid &&
            builder.vaultUrl &&
            sourceIsValid(builder.credential, context) &&
            ["system-mi", "user-mi", "default", "chain"].includes(
              builder.credential.credentialKind,
            ),
          credential: builder.credential,
          vaultUrl: builder.vaultUrl,
        };
      }
    }
  }
  return null;
}

function analyze(source) {
  const scopes = lexicalScopes(source);
  const allDeclarations = declarations(source, scopes);
  const relevant = allDeclarations.filter((declaration) =>
    declaredKind(declaration.type),
  );
  const events = [
    ...assignmentEvents(source),
    ...mutationEvents(source),
  ].sort((left, right) => left.start - right.start);

  const simulate = (before) => {
    const states = new Map();
    const constructions = [];
    const clientConstructions = [];
    const context = {
      states,
      constructions,
      resolve: (name, position) =>
        resolveDeclaration(relevant, name, position, scopes),
    };

    for (const event of events) {
      if (event.start >= before) {
        break;
      }
      if (event.type === "mutation") {
        const binding = context.resolve(event.receiver, event.start);
        const state = binding && states.get(binding);
        if (
          state &&
          [
            "mi-builder",
            "default-builder",
            "chain-builder",
            "client-builder",
          ].includes(state.kind)
        ) {
          states.set(
            binding,
            applyBuilderCalls(state, event.expression, event.start, context),
          );
        }
        continue;
      }

      const binding = context.resolve(event.name, event.start);
      if (!binding) {
        continue;
      }
      const declared = declaredKind(binding.type);
      const expected =
        declared === "var" ? states.get(binding)?.kind ?? "var" : declared;
      const next =
        event.operator === "="
          ? expressionState(
              event.expression,
              event.expressionStart,
              expected,
              context,
            )
          : null;
      states.set(binding, next ?? { kind: expected, valid: false });
      if (next?.kind === "client" && next.valid) {
        clientConstructions.push({ binding, start: event.start });
      }
    }
    return { states, constructions, clientConstructions };
  };

  const clientState = (name, position) => {
    const simulation = simulate(position);
    const binding = resolveDeclaration(relevant, name, position, scopes);
    const state = binding && simulation.states.get(binding);
    return state?.kind === "client" && state.valid &&
      sourceIsValid(state.credential, {
        states: simulation.states,
      })
      ? state
      : null;
  };

  return {
    allDeclarations,
    scopes,
    simulate,
    clientState,
  };
}

function operationKind(expression, position, analysis) {
  const value = unwrapParentheses(expression);
  const match =
    /^((?:this\s*\.\s*)?[A-Za-z_$][\w$]*)\s*\.\s*getSecret\s*\(/.exec(
      value,
    );
  const receiver = match?.[1].replace(/\s+/g, "");
  if (!match || !analysis.clientState(receiver, position)) {
    return "";
  }
  const open = value.indexOf("(", match.index);
  const close = matchingIndex(value, open);
  if (close === -1) {
    return "";
  }
  const simulation = analysis.simulate(position);
  const context = {
    states: simulation.states,
    resolve: (name, at) =>
      resolveDeclaration(
        analysis.allDeclarations,
        name,
        at,
        analysis.scopes,
      ),
  };
  if (
    environmentSource(value.slice(open + 1, close), position, context) !==
    "AZURE_KEY_VAULT_SECRET_NAME"
  ) {
    return "";
  }
  let suffix = value.slice(close + 1);
  if (/^\s*\.\s*getValue\s*\(\s*\)\s*$/.test(suffix)) {
    return "value";
  }
  return suffix.trim().length === 0 ? "secret" : "";
}

function systemOutputCalls(source) {
  const found = [];
  const pattern =
    /\b(?:java\.lang\.)?System\s*\.\s*(?:out|err)\s*\.\s*(?:print|println|printf|format)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf("(", match.index);
    const close = matchingIndex(source, open);
    if (close !== -1) {
      found.push({
        args: source.slice(open + 1, close),
        start: match.index,
        argsStart: open + 1,
      });
      pattern.lastIndex = close + 1;
    }
  }
  return found;
}

function expectedProvenance(type) {
  const simple = simpleType(type);
  if (simple === "KeyVaultSecret") {
    return "secret";
  }
  if (simple === "String") {
    return "value";
  }
  return simple === "var" ? "var" : "";
}

function provenanceFromExpression(
  expression,
  position,
  analysis,
  provenances,
) {
  const operation = operationKind(expression, position, analysis);
  if (operation) {
    return operation;
  }
  const value = unwrapParentheses(expression);
  const match = /^([A-Za-z_$][\w$]*)([\s\S]*)$/.exec(value);
  if (!match) {
    return "";
  }
  const binding = resolveDeclaration(
    analysis.allDeclarations,
    match[1],
    position,
    analysis.scopes,
  );
  let kind = binding && provenances.get(binding);
  if (!kind) {
    return "";
  }
  let suffix = match[2];
  if (/^\s*\.\s*getValue\s*\(\s*\)\s*$/.test(suffix) && kind === "secret") {
    kind = "value";
    suffix = "";
  }
  return suffix.trim().length === 0 ? kind : "";
}

function outputUsesProvenance(args, position, analysis, provenances) {
  if (operationKind(args, position, analysis) === "value") {
    return true;
  }
  const operationPattern =
    /(?<![\w$.])((?:this\s*\.\s*)?[A-Za-z_$][\w$]*)\s*\.\s*getSecret\s*\(/g;
  for (const match of args.matchAll(operationPattern)) {
    if (
      operationKind(
        args.slice(match.index),
        position + match.index,
        analysis,
      ) === "value"
    ) {
      return true;
    }
  }
  for (const [binding, kind] of provenances) {
    if (
      resolveDeclaration(
        analysis.allDeclarations,
        binding.name,
        position,
        analysis.scopes,
      ) !== binding
    ) {
      continue;
    }
    const pattern =
      kind === "secret"
        ? new RegExp(`\\b${binding.name}\\s*\\.\\s*getValue\\s*\\(\\s*\\)`)
        : new RegExp(`\\b${binding.name}\\b`);
    if (
      pattern.test(args) &&
      !new RegExp(`\\b${binding.name}\\s*=(?!=)`).test(args)
    ) {
      return true;
    }
  }
  return false;
}

function printsAssociatedSecret(source) {
  const analysis = analyze(source);
  const assignments = assignmentEvents(source);
  const outputs = systemOutputCalls(source);
  const provenances = new Map();
  const inferred = new Map();
  let index = 0;

  for (const output of outputs) {
    while (index < assignments.length && assignments[index].start < output.start) {
      const assignment = assignments[index];
      const binding = resolveDeclaration(
        analysis.allDeclarations,
        assignment.name,
        assignment.start,
        analysis.scopes,
      );
      if (binding) {
        const kind =
          assignment.operator === "="
            ? provenanceFromExpression(
                assignment.expression,
                assignment.expressionStart,
                analysis,
                provenances,
              )
            : "";
        const expected = expectedProvenance(binding.type) || inferred.get(binding);
        if (kind && (expected === "var" || !expected || expected === kind)) {
          provenances.set(binding, kind);
          if (expected === "var" && !inferred.has(binding)) {
            inferred.set(binding, kind);
          }
        } else {
          provenances.delete(binding);
        }
      }
      index += 1;
    }
    if (
      outputUsesProvenance(
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

function meaningfulCatch(header, body) {
  const parameter = header.match(/\b([A-Za-z_$][\w$]*)\s*$/)?.[1];
  if (!parameter || !new RegExp(`\\b${parameter}\\b`).test(body)) {
    return false;
  }
  return (
    new RegExp(`\\bthrow\\b[^;]*\\b${parameter}\\b`).test(body) ||
    new RegExp(
      `\\b(?:java\\.lang\\.)?System\\s*\\.\\s*(?:out|err)\\s*\\.\\s*(?:print|println|printf|format)\\s*\\([^;]*\\b${parameter}\\b`,
    ).test(body) ||
    new RegExp(
      `\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:trace|debug|info|warn|warning|error|fatal|log)\\s*\\([^;]*\\b${parameter}\\b`,
    ).test(body)
  );
}

function preservesCatch(header, body) {
  const parameter = header.match(/\b([A-Za-z_$][\w$]*)\s*$/)?.[1];
  if (!parameter) {
    return false;
  }

  const aliases = new Set([parameter]);
  const events = [];
  const assignmentPattern =
    /((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?<![=!<>])=(?!=)\s*([^;]+);/g;
  const throwPattern = /\bthrow\s+([^;]+);/g;
  let match;
  while ((match = assignmentPattern.exec(body)) !== null) {
    events.push({
      kind: "assignment",
      start: match.index,
      target: match[1].replace(/\s+/g, ""),
      expression: match[2],
    });
  }
  while ((match = throwPattern.exec(body)) !== null) {
    events.push({
      kind: "throw",
      start: match.index,
      expression: match[1],
    });
  }
  events.sort((left, right) => left.start - right.start);

  const usesAlias = (expression) =>
    Array.from(aliases).some((alias) => {
      const pattern = alias
        .split(".")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s*\\.\\s*");
      const reference = new RegExp(
        `${alias.includes(".") ? "(?<![\\w$])" : "(?<![\\w$.])"}${pattern}\\b`,
        "g",
      );
      return Array.from(expression.matchAll(reference)).some(
        (match) =>
          !/^\s*\./.test(
            expression.slice(match.index + match[0].length),
          ),
      );
    });

  let lastThrowCausal = false;
  for (const event of events) {
    if (event.kind === "assignment") {
      if (usesAlias(event.expression)) {
        aliases.add(event.target);
      } else {
        aliases.delete(event.target);
      }
    } else {
      lastThrowCausal = usesAlias(event.expression);
    }
  }
  return lastThrowCausal;
}

function caughtTypes(header) {
  const match =
    /^\s*(?:final\s+)?([\s\S]*?)\s+([A-Za-z_$][\w$]*)\s*$/.exec(header);
  if (!match) {
    return [];
  }
  return match[1]
    .split("|")
    .map((type) => type.trim().split(".").at(-1))
    .filter(Boolean);
}

function catchesAfter(source, blockEnd) {
  const catches = [];
  let cursor = blockEnd + 1;
  while (cursor < source.length) {
    cursor += source.slice(cursor).match(/^\s*/)[0].length;
    if (!source.startsWith("catch", cursor)) {
      break;
    }
    const open = source.indexOf("(", cursor + 5);
    const close = matchingIndex(source, open);
    const bodyOpen = source.indexOf("{", close);
    const bodyClose = matchingIndex(source, bodyOpen, "{", "}");
    if ([open, close, bodyOpen, bodyClose].includes(-1)) {
      break;
    }
    catches.push({
      start: cursor,
      header: source.slice(open + 1, close),
      body: source.slice(bodyOpen + 1, bodyClose),
    });
    cursor = bodyClose + 1;
  }
  return catches;
}

function allCatches(source) {
  const catches = [];
  const pattern = /\bcatch\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf("(", match.index);
    const close = matchingIndex(source, open);
    const bodyOpen = source.indexOf("{", close);
    const bodyClose = matchingIndex(source, bodyOpen, "{", "}");
    if ([open, close, bodyOpen, bodyClose].includes(-1)) {
      continue;
    }
    catches.push({
      start: match.index,
      header: source.slice(open + 1, close),
      body: source.slice(bodyOpen + 1, bodyClose),
    });
  }
  return catches;
}

function javaHandlerAlwaysCausal(header, body) {
  let nextTargetId = 0;
  const outcomes = (start, end, frames = []) => {
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
      let value = condition.trim();
      while (value.startsWith("(")) {
        const close = matchingIndex(value, 0);
        if (close !== value.length - 1) break;
        value = value.slice(1, -1).trim();
      }
      value = value.replace(/\s+/g, "").toLowerCase();
      if (value === "true") return true;
      if (value === "false") return false;
      return null;
    };
    const loopOutcomes = (
      bodyOutcomes,
      condition,
      canSkip,
      executesOnce = false,
      consumedTargets = [],
    ) => {
      const consumed = new Set(consumedTargets);
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
            value === "invalid" ||
            (/^(?:break|continue):/.test(value) &&
              !consumed.has(value.slice(value.indexOf(":") + 1))),
        ),
      );
      const consumedBreak = [...bodyOutcomes].some(
        (value) =>
          value.startsWith("break:") &&
          consumed.has(value.slice("break:".length)),
      );
      const consumedContinue = [...bodyOutcomes].some(
        (value) =>
          value.startsWith("continue:") &&
          consumed.has(value.slice("continue:".length)),
      );
      if (consumedBreak) loopResult.add("fall");
      if (
        condition !== true &&
        (canSkip ||
          bodyOutcomes.has("fall") ||
          consumedContinue)
      ) {
        loopResult.add("fall");
      }
      return loopResult;
    };
    const parenthesized = () => {
      skipWhitespace();
      if (body[index] !== "(") return null;
      const close = matchingIndex(body, index);
      if (close < 0 || close >= end) return null;
      const value = body.slice(index + 1, close);
      index = close + 1;
      return value;
    };
    const forCondition = (headerValue) => {
      const parts = [];
      let partStart = 0;
      let depth = 0;
      for (
        let cursor = 0;
        cursor < headerValue.length;
        cursor += 1
      ) {
        const character = headerValue[cursor];
        if ("([{".includes(character)) depth += 1;
        else if (")]}".includes(character)) depth -= 1;
        else if (character === ";" && depth === 0) {
          parts.push(headerValue.slice(partStart, cursor));
          partStart = cursor + 1;
        }
      }
      parts.push(headerValue.slice(partStart));
      if (parts.length === 1 && /\b:\b/.test(headerValue)) return null;
      if (parts.length === 1 && headerValue.includes(":")) return null;
      if (parts.length !== 3) return "ambiguous";
      return parts[1].trim() === ""
        ? true
        : conditionKind(parts[1]);
    };
    const statement = (activeFrames = frames, loopLabelIds = []) => {
      skipWhitespace();
      if (index >= end) return new Set(["invalid"]);
      if (body[index] === ";") {
        index += 1;
        return new Set(["fall"]);
      }
      const labelNames = [];
      while (true) {
        const label = /^([A-Za-z_$][\w$]*)\s*:/.exec(
          body.slice(index),
        );
        if (!label) break;
        labelNames.push(label[1]);
        index += label[0].length;
        skipWhitespace();
      }
      if (labelNames.length > 0) {
        const seen = new Set(
          activeFrames
            .map((frame) => frame.name)
            .filter((name) => name !== undefined),
        );
        let duplicate = false;
        for (const name of labelNames) {
          if (seen.has(name)) duplicate = true;
          seen.add(name);
        }
        const labelsLoop = /^(?:while|for|do)\b/.test(
          body.slice(index),
        );
        const labelFrames = labelNames.map((name) => ({
          id: String(nextTargetId++),
          kind: labelsLoop ? "loop-label" : "label",
          name,
        }));
        const nested = statement(
          [...activeFrames, ...labelFrames],
          labelsLoop ? labelFrames.map(({ id }) => id) : [],
        );
        const labelIds = new Set(labelFrames.map(({ id }) => id));
        const resolved = new Set(
          [...nested].map((value) =>
            value.startsWith("break:") &&
            labelIds.has(value.slice("break:".length))
              ? "fall"
              : value,
          ),
        );
        if (duplicate) resolved.add("invalid");
        return resolved;
      }
      if (body[index] === "{") {
        const close = matchingIndex(body, index, "{", "}");
        if (close < 0 || close >= end) {
          index = end;
          return new Set(["invalid"]);
        }
        const nested = outcomes(index + 1, close, activeFrames);
        index = close + 1;
        return nested;
      }
      if (/^while\b/.test(body.slice(index))) {
        index += body.slice(index).match(/^while\b/)[0].length;
        const condition = parenthesized();
        if (condition === null) return new Set(["invalid"]);
        const kind = conditionKind(condition);
        const loopId = String(nextTargetId++);
        return loopOutcomes(
          statement([
            ...activeFrames,
            { id: loopId, kind: "loop" },
          ]),
          kind,
          kind === null,
          false,
          [loopId, ...loopLabelIds],
        );
      }
      if (/^for\b/.test(body.slice(index))) {
        index += body.slice(index).match(/^for\b/)[0].length;
        const headerValue = parenthesized();
        if (headerValue === null) return new Set(["invalid"]);
        const kind = forCondition(headerValue);
        const loopId = String(nextTargetId++);
        const nested = statement([
          ...activeFrames,
          { id: loopId, kind: "loop" },
        ]);
        if (kind === "ambiguous") return new Set(["invalid"]);
        return loopOutcomes(
          nested,
          kind,
          kind === null,
          false,
          [loopId, ...loopLabelIds],
        );
      }
      if (/^do\b/.test(body.slice(index))) {
        index += body.slice(index).match(/^do\b/)[0].length;
        const loopId = String(nextTargetId++);
        const nested = statement([
          ...activeFrames,
          { id: loopId, kind: "loop" },
        ]);
        skipWhitespace();
        if (!/^while\b/.test(body.slice(index))) {
          return new Set(["invalid"]);
        }
        index += body.slice(index).match(/^while\b/)[0].length;
        const condition = parenthesized();
        if (condition === null) return new Set(["invalid"]);
        skipWhitespace();
        if (body[index] === ";") index += 1;
        return loopOutcomes(
          nested,
          conditionKind(condition),
          false,
          true,
          [loopId, ...loopLabelIds],
        );
      }
      if (/^if\b/.test(body.slice(index))) {
        index += body.slice(index).match(/^if\b/)[0].length;
        const condition = parenthesized();
        if (condition === null) return new Set(["invalid"]);
        const consequent = statement(activeFrames);
        skipWhitespace();
        let alternate = new Set(["fall"]);
        if (/^else\b/.test(body.slice(index))) {
          index += body.slice(index).match(/^else\b/)[0].length;
          alternate = statement(activeFrames);
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
          const close = matchingIndex(body, index, "{", "}");
          if (close < 0 || close >= end) {
            index = end;
            return new Set(["unsafe"]);
          }
          const nested = outcomes(index + 1, close, activeFrames);
          const prefix = body.slice(statementStart, index).trim();
          index = close + 1;
          if (/^[A-Za-z_$][\w$]*\s*:/.test(prefix)) {
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
          preservesCatch(header, body.slice(0, index))
            ? "safe"
            : "unsafe",
        ]);
      }
      if (/^(?:return|yield)\b/.test(text)) {
        return new Set(["unsafe"]);
      }
      if (/^(?:break|continue)\b/.test(text)) {
        const control =
          /^(break|continue)(?:\s+([A-Za-z_$][\w$]*))?\s*;\s*$/.exec(
            text,
          );
        if (!control) return new Set(["invalid"]);
        const [, kind, labelName] = control;
        let target;
        if (labelName) {
          target = [...activeFrames]
            .reverse()
            .find((frame) => frame.name === labelName);
          if (
            !target ||
            (kind === "continue" && target.kind !== "loop-label")
          ) {
            return new Set(["invalid"]);
          }
        } else {
          target = [...activeFrames]
            .reverse()
            .find((frame) => frame.kind === "loop");
          if (!target) return new Set(["invalid"]);
        }
        return new Set([`${kind}:${target.id}`]);
      }
      if (/^[A-Za-z_$][\w$]*\s*:/.test(text)) {
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
    return result;
  };
  const result = outcomes(0, body.length);
  return result.size === 1 && result.has("safe");
}

function credentialCatchKind(header) {
  const types = caughtTypes(header);
  if (
    types.length === 1 &&
    types[0] === "CredentialUnavailableException"
  ) {
    return "exact";
  }
  const supportedAuthenticationTypes = new Set([
    "ClientAuthenticationException",
    "CredentialUnavailableException",
  ]);
  if (
    types.length > 1 &&
    types.includes("CredentialUnavailableException") &&
    types.every((type) => supportedAuthenticationTypes.has(type))
  ) {
    return "authentication-multi";
  }
  return "";
}

function handlesCredentialUnavailable(source) {
  const analysis = analyze(source);
  const catches = allCatches(source);
  const pattern = /\btry\b/g;
  let hasUsefulConnectedCatch = false;
  const usefulConnectedCatches = new Set();
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
      /(?<![\w$.])((?:this\s*\.\s*)?[A-Za-z_$][\w$]*)\s*\.\s*getSecret\s*\(/g;
    const hasOperation = Array.from(body.matchAll(operationPattern)).some(
      (operation) => {
        const start = cursor + 1 + operation.index;
        const end = statementEnd(source, start);
        const expression = source.slice(start, end);
        const open = expression.indexOf("(");
        const close = matchingIndex(expression, open);
        if (
          open === -1 ||
          close === -1 ||
          !analysis.clientState(
            operation[1].replace(/\s+/g, ""),
            start,
          )
        ) {
          return false;
        }
        const simulation = analysis.simulate(start);
        return (
          environmentSource(expression.slice(open + 1, close), start, {
            states: simulation.states,
            resolve: (name, at) =>
              resolveDeclaration(
                analysis.allDeclarations,
                name,
                at,
                analysis.scopes,
              ),
          }) === "AZURE_KEY_VAULT_SECRET_NAME"
        );
      },
    );
    if (!hasOperation) {
      pattern.lastIndex = blockEnd + 1;
      continue;
    }
    const catches = catchesAfter(source, blockEnd);
    for (const { start, header, body: catchBody } of catches) {
      const kind = credentialCatchKind(header);
      if (
        kind &&
        (meaningfulCatch(header, catchBody) ||
          javaHandlerAlwaysCausal(header, catchBody))
      ) {
        hasUsefulConnectedCatch = true;
        usefulConnectedCatches.add(start);
      }
    }
    pattern.lastIndex = blockEnd + 1;
  }
  return (
    hasUsefulConnectedCatch &&
    catches.every(({ start, header, body }) => {
      const kind = credentialCatchKind(header);
      return (
        (kind === "exact" && usefulConnectedCatches.has(start)) ||
        javaHandlerAlwaysCausal(header, body)
      );
    })
  );
}

function hasDependency(build, artifact) {
  const dependencies = build.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [];
  const maven = dependencies.some(
    (dependency) =>
      /<groupId>\s*com\.azure\s*<\/groupId>/.test(dependency) &&
      new RegExp(`<artifactId>\\s*${artifact}\\s*<\\/artifactId>`).test(
        dependency,
      ),
  );
  const gradle = new RegExp(
    `["']com\\.azure:${artifact}(?::[^"']+)?["']`,
  ).test(build);
  return maven || gradle;
}

function hasConstruction(source, predicate) {
  const analysis = analyze(source);
  return analysis.simulate(source.length + 1).constructions.some(predicate);
}

const rules = {
  "prompt/identity-packages": ({ source, build }) =>
    Boolean(source.trim()) &&
    hasDependency(build, "azure-identity") &&
    hasDependency(build, "azure-security-keyvault-secrets"),
  "prompt/system-assigned-credential": ({ source }) =>
    hasConstruction(
      source,
      (credential) =>
        credential.valid && credential.credentialKind === "system-mi",
    ),
  "prompt/user-assigned-credential": ({ source }) =>
    hasConstruction(
      source,
      (credential) =>
        credential.valid && credential.credentialKind === "user-mi",
    ),
  "prompt/default-azure-credential": ({ source }) =>
    hasConstruction(
      source,
      (credential) =>
        credential.valid &&
        credential.credentialKind === "default" &&
        credential.managedIdentityEnabled &&
        credential.clientId,
    ),
  "prompt/local-fallback-chain": ({ source }) =>
    hasConstruction(
      source,
      (credential) =>
        credential.valid && credential.credentialKind === "chain",
    ),
  "prompt/credential-client-association": ({ source }) =>
    analyze(source).simulate(source.length + 1).clientConstructions.length > 0,
  "prompt/authenticated-operation": ({ source }) =>
    printsAssociatedSecret(source),
  "prompt/credential-unavailable-error": ({ source }) =>
    handlesCredentialUnavailable(source),
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
  return rule({
    ...workspace,
    source: sanitizeJava(workspace.source ?? ""),
    build: sanitizeBuild(workspace.build ?? ""),
  });
}

export function ruleNames() {
  return Object.keys(rules);
}
