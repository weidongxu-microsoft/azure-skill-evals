function sanitizeJava(source) {
  let result = "";
  let state = "code";
  const preserved = new Set([
    "AZURE_KEY_VAULT_URL",
    "AZURE_KEY_VAULT_SECRET_NAME",
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
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
      const actionableAuthenticationDiagnostic =
        /\b(?:auth(?:entication)?|credential)\w*\b/i.test(value) &&
        /\b(?:check|configure|ensure|provide|set|update|verify)\w*\b/i.test(
          value,
        );
      if (
        quote === '"' &&
        (preserved.has(value) || actionableAuthenticationDiagnostic)
      ) {
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
        kind: /\b(?:class|interface|record|enum)\s+[A-Za-z_$][\w$]*[\s\S]*$/.test(
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
    ClientSecretCredentialBuilder: "credential-builder",
    ClientSecretCredential: "credential",
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
  const pattern =
    /(?:^|[;{}])\s*((?:this\s*\.\s*)?[A-Za-z_$][\w$]*)\s*\./g;
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
        receiver: match[1].replace(/\s+/g, ""),
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

const typePackages = {
  ClientSecretCredentialBuilder: "com.azure.identity",
  ClientSecretCredential: "com.azure.identity",
  TokenCredential: "com.azure.core.credential",
  SecretClientBuilder: "com.azure.security.keyvault.secrets",
  SecretClient: "com.azure.security.keyvault.secrets",
  KeyVaultSecret: "com.azure.security.keyvault.secrets.models",
  Response: "com.azure.core.http.rest",
  ClientAuthenticationException: "com.azure.core.exception",
};

function typeIsShadowed(source, simple, position, scopes) {
  const current = scopeAt(scopes, position);
  const isWithin = (scope, ancestor) => {
    for (let candidate = scope; candidate; candidate = candidate.parent) {
      if (candidate === ancestor) {
        return true;
      }
    }
    return false;
  };
  const pattern =
    /\b(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)\b/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== simple) {
      continue;
    }
    const container = scopeAt(scopes, match.index);
    if (!isWithin(current, container)) {
      continue;
    }
    if (container.kind !== "block" || match.index <= position) {
      return true;
    }
  }
  return false;
}

function authenticType(source, type, position = 0, scopes = lexicalScopes(source)) {
  const normalized = type.replace(/\s+/g, "");
  const base = normalized.replace(/<[\s\S]*>/, "").replace(/\[\]$/, "");
  const simple = simpleType(base);
  if (simple === "String" || simple === "var") {
    return !base.includes(".") || base === "java.lang.String";
  }
  const packageName = typePackages[simple];
  if (!packageName) {
    return false;
  }
  if (base.includes(".")) {
    return base === `${packageName}.${simple}`;
  }
  if (typeIsShadowed(source, simple, position, scopes)) {
    return false;
  }
  const explicitImports = Array.from(
    source.matchAll(
      new RegExp(
        `\\bimport\\s+([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\.${simple}\\s*;`,
        "g",
      ),
    ),
    (match) => match[1],
  );
  if (explicitImports.length > 0) {
    return (
      explicitImports.length === 1 &&
      explicitImports[0] === packageName
    );
  }
  return new RegExp(
    `\\bimport\\s+${packageName.replaceAll(".", "\\.")}\\.\\*\\s*;`,
  ).test(source);
}

function hasConstructor(expression, type, position, context) {
  const match = new RegExp(
    `^\\s*new\\s+((?:[A-Za-z_$][\\w$]*\\.)*)${type}\\s*\\(`,
  ).exec(expression);
  if (!match) {
    return false;
  }
  const qualified = match[1]
    ? `${match[1]}${type}`.replace(/\.$/, "")
    : type;
  return authenticType(context.source, qualified, position, context.scopes);
}

function directEnvironment(expression) {
  return /^(?:java\.lang\.)?System\s*\.\s*getenv\s*\(\s*"(AZURE_KEY_VAULT_URL|AZURE_KEY_VAULT_SECRET_NAME|AZURE_TENANT_ID|AZURE_CLIENT_ID|AZURE_CLIENT_SECRET)"\s*\)$/.exec(
    unwrapParentheses(expression),
  )?.[1];
}

function environmentSource(expression, position, context) {
  const direct = directEnvironment(expression);
  if (direct) {
    return direct;
  }
  const accessor = environmentAccessorSource(
    expression,
    context.environmentAccessors,
  );
  if (accessor) {
    return accessor;
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
    if (next.kind === "credential-builder" && call.method === "tenantId") {
      next.tenantId =
        environmentSource(call.args, position + call.start, context) ===
        "AZURE_TENANT_ID";
    } else if (
      next.kind === "credential-builder" &&
      call.method === "clientId"
    ) {
      next.clientId =
        environmentSource(call.args, position + call.start, context) ===
        "AZURE_CLIENT_ID";
    } else if (
      next.kind === "credential-builder" &&
      call.method === "clientSecret"
    ) {
      next.clientSecret =
        environmentSource(call.args, position + call.start, context) ===
        "AZURE_CLIENT_SECRET";
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
  if (builder.kind === "credential-builder") {
    return {
      kind: "credential",
      valid:
        builder.valid &&
        builder.tenantId &&
        builder.clientId &&
        builder.clientSecret,
      credentialKind: "client-secret",
    };
  }
  return null;
}

function builderFromExpression(expression, position, kind, context) {
  const constructors = {
    "credential-builder": "ClientSecretCredentialBuilder",
    "client-builder": "SecretClientBuilder",
  };
  let state = null;
  if (hasConstructor(expression, constructors[kind], position, context)) {
    if (kind === "credential-builder") {
      state = {
        kind,
        valid: true,
        objectId: context.createObjectId(),
        tenantId: false,
        clientId: false,
        clientSecret: false,
      };
    } else if (kind === "client-builder") {
      state = {
        kind,
        valid: true,
        objectId: context.createObjectId(),
        vaultUrl: false,
        credential: { valid: false, credentialKind: "", binding: null },
      };
    } else {
      state = { kind, valid: true };
    }
  } else {
    const receiver = unwrapParentheses(expression).match(
      /^((?:this\s*\.\s*)?[A-Za-z_$][\w$]*)\s*\./,
    )?.[1].replace(/\s+/g, "");
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
    const environment =
      directEnvironment(value) ||
      environmentAccessorSource(value, context.environmentAccessors);
    if (environment) {
      return { kind: "string", valid: true, environment };
    }
  }

  const builderKinds = [
    "credential-builder",
    "client-builder",
  ];
  if (expectedKind === "var") {
    for (const kind of builderKinds) {
      const builder = builderFromExpression(value, position, kind, context);
      if (!builder) {
        continue;
      }
      if (
        kind === "credential-builder" &&
        /\.build\s*\(\s*\)\s*$/.test(value)
      ) {
        const credential = builtCredential(builder, context);
        context.constructions.push(credential);
        return credential;
      }
      if (
        kind === "client-builder" &&
        /\.buildClient\s*\(\s*\)\s*$/.test(value)
      ) {
        return {
          kind: "client",
          valid:
            builder.valid &&
            builder.vaultUrl &&
            sourceIsValid(builder.credential, context) &&
            builder.credential.credentialKind === "client-secret",
          credential: builder.credential,
          vaultUrl: builder.vaultUrl,
        };
      }
      return builder;
    }
  }
  if (builderKinds.includes(expectedKind)) {
    return builderFromExpression(
      value,
      position,
      expectedKind,
      context,
    );
  }

  if (expectedKind === "credential" || expectedKind === "var") {
    for (const kind of builderKinds.slice(0, 1)) {
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
            builder.credential.credentialKind === "client-secret",
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
  const environmentAccessors = environmentAccessorSummaries(source);
  const allDeclarations = declarations(source, scopes);
  const relevant = allDeclarations.filter(
    (declaration) =>
      declaredKind(declaration.type) &&
      authenticType(source, declaration.type, declaration.nameStart, scopes),
  );
  const events = [
    ...assignmentEvents(source),
    ...mutationEvents(source),
  ].sort((left, right) => left.start - right.start);

  const simulate = (before) => {
    const states = new Map();
    const constructions = [];
    const clientConstructions = [];
    let nextObjectId = 0;
    const context = {
      states,
      constructions,
      source,
      scopes,
      environmentAccessors,
      createObjectId: () => nextObjectId++,
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
            "credential-builder",
            "client-builder",
          ].includes(state.kind)
        ) {
          const next = applyBuilderCalls(
            state,
            event.expression,
            event.start,
            context,
          );
          for (const [candidate, candidateState] of states) {
            if (
              candidateState?.objectId === state.objectId &&
              candidateState.kind === state.kind
            ) {
              states.set(candidate, cloneState(next));
            }
          }
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
    environmentAccessors,
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
    environmentAccessors: analysis.environmentAccessors,
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
    /\b(?:java\.lang\.)?System\s*\.\s*(?:out|err)\s*\.\s*(?:append|print|println|printf|format|write)\s*\(/g;
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

function loggingCalls(source) {
  const found = [];
  const pattern =
    /\.\s*(?:trace|debug|info|warn|warning|error|fatal|log)\s*\(/g;
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

function hasAssociatedGetSecret(source) {
  const analysis = analyze(source);
  const pattern =
    /(?<![\w$.])((?:this\s*\.\s*)?[A-Za-z_$][\w$]*)\s*\.\s*getSecret\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf("(", match.index);
    const close = matchingIndex(source, open);
    if (close === -1) {
      continue;
    }
    if (
      operationKind(
        source.slice(match.index, close + 1),
        match.index,
        analysis,
      ) === "secret"
    ) {
      return true;
    }
  }
  return false;
}

function mergeTaint(...values) {
  const merged = new Map();
  for (const value of values) {
    for (const [dependency] of value ?? []) {
      if (!merged.has(dependency)) {
        merged.set(dependency, 0);
      }
    }
  }
  return merged;
}

function deepenTaint(value) {
  return new Map(Array.from(value ?? [], ([dependency]) => [dependency, 0]));
}

function taintEqual(left, right) {
  return (
    left.size === right.size &&
    Array.from(left.keys()).every((dependency) => right.has(dependency))
  );
}

function summaryMapsEqual(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const [name, summaries] of left) {
    const other = right.get(name);
    if (!other || summaries.length !== other.length) {
      return false;
    }
    for (let index = 0; index < summaries.length; index += 1) {
      const current = summaries[index];
      const candidate = other[index];
      if (
        !taintEqual(current.returns, candidate.returns) ||
        !taintEqual(current.sinks, candidate.sinks) ||
        current.effects.size !== candidate.effects.size ||
        current.mutations.size !== candidate.mutations.size
      ) {
        return false;
      }
      for (const [member, value] of current.effects) {
        if (
          !candidate.effects.has(member) ||
          !taintEqual(value, candidate.effects.get(member))
        ) {
          return false;
        }
      }
      for (const [parameter, value] of current.mutations) {
        if (
          !candidate.mutations.has(parameter) ||
          !taintEqual(value, candidate.mutations.get(parameter))
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let start = 0;
  const depths = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character in depths) {
      depths[character] += 1;
    } else if (character in closing) {
      depths[closing[character]] -= 1;
    } else if (
      character === delimiter &&
      Object.values(depths).every((depth) => depth === 0)
    ) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function helperMethods(source) {
  const methods = [];
  const pattern =
    /(?:^|[;{}])\s*(?:(?:public|protected|private|static|final|synchronized|native|abstract|default)\s+)*(?:<[^>{}]+>\s*)?([A-Za-z_$][\w$]*(?:\s*<[^;{}()]+>)?(?:\s*\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*\(([^{}()]*)\)\s*(?:throws\s+[^{]+)?\{/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = pattern.lastIndex - 1;
    const close = matchingIndex(source, open, "{", "}");
    if (close === -1) {
      continue;
    }
    let parameterSource = match[3];
    let previous;
    do {
      previous = parameterSource;
      parameterSource = parameterSource.replace(
        /<[^<>]*>/g,
        " ",
      );
    } while (parameterSource !== previous);
    const parameters = splitTopLevel(parameterSource, ",")
      .map((parameter) =>
        parameter.trim().match(/([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?\s*$/)
          ?.[1],
      )
      .filter(Boolean);
    const parameterTypes = splitTopLevel(parameterSource, ",")
      .map((parameter) => {
        const parsed =
          /^(?:(?:final|@\w+(?:\([^)]*\))?)\s+)*([\w$.]+(?:\s*<[^>]+>)?(?:\s*\[\s*\])?)\s+[A-Za-z_$][\w$]*\s*(?:\[\s*\])?\s*$/.exec(
            parameter.trim(),
          );
        return parsed?.[1].replace(/\s+/g, "") ?? "";
      })
      .filter(Boolean);
    const prefix = match[0].slice(0, match[0].lastIndexOf(match[1]));
    methods.push({
      id: methods.length,
      name: match[2],
      parameters,
      parameterTypes,
      isStatic: /\bstatic\b/.test(prefix),
      start: match.index,
      bodyStart: open + 1,
      bodyEnd: close,
      body: source.slice(open + 1, close),
    });
    pattern.lastIndex = open + 1;
  }
  return methods;
}

function validationBodyAlwaysThrows(body) {
  const value = body.trim();
  const throwMatch = /\bthrow\s+[^;]+;\s*$/.exec(value);
  if (!throwMatch) {
    return false;
  }
  const prefix = value.slice(0, throwMatch.index);
  return !/\b(?:break|continue|do|for|if|return|switch|try|while|yield)\b/.test(
    prefix,
  );
}

function throwingIfConditions(body) {
  const conditions = [];
  const pattern = /\bif\s*\(/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const open = body.indexOf("(", match.index);
    const close = matchingIndex(body, open);
    if (close === -1) {
      continue;
    }
    let statementStart = close + 1;
    statementStart += body.slice(statementStart).match(/^\s*/)[0].length;
    let statementBody;
    let statementEndPosition;
    if (body[statementStart] === "{") {
      const statementClose = matchingIndex(body, statementStart, "{", "}");
      if (statementClose === -1) {
        continue;
      }
      statementBody = body.slice(statementStart + 1, statementClose);
      statementEndPosition = statementClose + 1;
    } else {
      const end = statementEnd(body, statementStart);
      statementBody = body.slice(statementStart, end + 1);
      statementEndPosition = end + 1;
    }
    if (validationBodyAlwaysThrows(statementBody)) {
      conditions.push({
        condition: body.slice(open + 1, close),
        start: match.index,
      });
    }
    pattern.lastIndex = statementEndPosition;
  }
  return conditions;
}

function aliasPattern(alias) {
  return alias
    .split(".")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*\\.\\s*");
}

function hasNullValidation(condition, aliases) {
  return Array.from(aliases).some((alias) => {
    const reference = aliasPattern(alias);
    return (
      new RegExp(`(?:\\b${reference}\\b\\s*==\\s*null|null\\s*==\\s*\\b${reference}\\b)`).test(
        condition,
      ) ||
      new RegExp(
        `\\b(?:java\\.util\\.)?Objects\\s*\\.\\s*isNull\\s*\\(\\s*${reference}\\s*\\)`,
      ).test(condition)
    );
  });
}

function hasBlankValidation(condition, aliases) {
  return Array.from(aliases).some((alias) => {
    const reference = aliasPattern(alias);
    return new RegExp(
      `\\b${reference}\\b\\s*\\.\\s*(?:isBlank\\s*\\(\\s*\\)|(?:trim|strip)\\s*\\(\\s*\\)\\s*\\.\\s*isEmpty\\s*\\(\\s*\\))`,
    ).test(condition);
  });
}

function hasNegatedValidation(condition, aliases) {
  return Array.from(aliases).some((alias) => {
    const reference = aliasPattern(alias);
    return new RegExp(
      `!\\s*(?:\\(\\s*)?(?:${reference}\\s*==\\s*null|(?:java\\.util\\.)?Objects\\s*\\.\\s*isNull\\s*\\(\\s*${reference}\\s*\\)|${reference}\\s*\\.\\s*(?:isBlank\\s*\\(\\s*\\)|(?:trim|strip)\\s*\\(\\s*\\)\\s*\\.\\s*isEmpty\\s*\\(\\s*\\)))`,
    ).test(condition);
  });
}

function directParameterEnvironment(expression, parameter) {
  const reference = parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(?:java\\.lang\\.)?System\\s*\\.\\s*getenv\\s*\\(\\s*${reference}\\s*\\)$`,
  ).test(unwrapParentheses(expression));
}

function environmentAccessorSummary(method) {
  if (
    !method.isStatic ||
    method.parameters.length !== 1 ||
    method.parameterTypes.length !== 1 ||
    simpleType(method.parameterTypes[0]) !== "String"
  ) {
    return null;
  }
  const parameter = method.parameters[0];
  const returns = Array.from(method.body.matchAll(/\breturn\s+([^;]+);/g));
  if (returns.length !== 1) {
    return null;
  }
  const returnPosition = returns[0].index;
  const derived = new Set();
  let environmentReads = 0;
  let environmentReadPosition = -1;
  for (const assignment of assignmentEvents(method.body)) {
    if (assignment.name.replace(/^this\./, "") === parameter) {
      return null;
    }
    if (assignment.start >= returnPosition) {
      continue;
    }
    const target = assignment.name.replace(/^this\./, "");
    if (
      assignment.operator === "=" &&
      directParameterEnvironment(assignment.expression, parameter)
    ) {
      environmentReads += 1;
      environmentReadPosition = assignment.start;
      derived.add(target);
      continue;
    }
    const reference = exactReference(assignment.expression);
    if (
      assignment.operator === "=" &&
      reference &&
      derived.has(reference.replace(/^this\./, ""))
    ) {
      derived.add(target);
    } else {
      derived.delete(target);
    }
  }
  if (environmentReads !== 1) {
    return null;
  }

  if (
    !derived.has(exactReference(returns[0][1]).replace(/^this\./, ""))
  ) {
    return null;
  }

  let validatesMissing = false;
  let validatesBlank = false;
  for (const validation of throwingIfConditions(method.body)) {
    if (
      validation.start <= environmentReadPosition ||
      validation.start >= returnPosition ||
      hasNegatedValidation(validation.condition, derived)
    ) {
      continue;
    }
    const condition = validation.condition;
    const missing = hasNullValidation(condition, derived);
    const blank = hasBlankValidation(condition, derived);
    if (missing && blank && !condition.includes("||")) {
      continue;
    }
    validatesMissing ||= missing;
    validatesBlank ||= blank;
  }
  return validatesMissing && validatesBlank
    ? { name: method.name, parameterIndex: 0 }
    : null;
}

function environmentAccessorSummaries(source) {
  const methods = helperMethods(source);
  const definitions = new Map();
  for (const method of methods) {
    const candidates = definitions.get(method.name) ?? [];
    candidates.push({
      arity: method.parameters.length,
      summary: environmentAccessorSummary(method),
    });
    definitions.set(method.name, candidates);
  }
  return definitions;
}

function environmentAccessorSource(expression, summaries) {
  if (!summaries) {
    return "";
  }
  const value = unwrapParentheses(expression);
  const match =
    /^(?:(?:[A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/.exec(
      value,
    );
  if (!match) {
    return "";
  }
  const open = value.indexOf("(", match.index);
  const close = matchingIndex(value, open);
  if (close !== value.length - 1) {
    return "";
  }
  const argumentsList = splitTopLevel(value.slice(open + 1, close), ",");
  const candidates = (summaries.get(match[1]) ?? []).filter(
    ({ arity }) => arity === argumentsList.length,
  );
  if (
    candidates.length !== 1 ||
    !candidates[0].summary ||
    candidates[0].summary.parameterIndex !== 0
  ) {
    return "";
  }
  return /^"(AZURE_KEY_VAULT_URL|AZURE_KEY_VAULT_SECRET_NAME|AZURE_TENANT_ID|AZURE_CLIENT_ID|AZURE_CLIENT_SECRET)"$/.exec(
    argumentsList[0].trim(),
  )?.[1] ?? "";
}

function mergedHelperSummary(summaries, name) {
  const candidates = summaries.get(name) ?? [];
  const effects = new Map();
  const mutations = new Map();
  for (const summary of candidates) {
    for (const [member, value] of summary.effects) {
      effects.set(member, mergeTaint(effects.get(member), value));
    }
    for (const [parameter, value] of summary.mutations) {
      mutations.set(parameter, mergeTaint(mutations.get(parameter), value));
    }
  }
  return {
    returns: mergeTaint(...candidates.map(({ returns }) => returns)),
    sinks: mergeTaint(...candidates.map(({ sinks }) => sinks)),
    effects,
    mutations,
  };
}

function callMemberName(member, receiver) {
  if (!receiver || receiver === "this" || member.includes(".")) {
    return member;
  }
  return `${receiver}.${member}`;
}

function mapSummaryTaint(
  value,
  argumentsTaint,
  members,
  symbolic,
  receiver = "",
) {
  let mapped = new Map();
  for (const [dependency, depth] of value) {
    let source = new Map();
    if (dependency === "secret") {
      source.set("secret", 0);
    } else if (dependency.startsWith("param:")) {
      source = argumentsTaint[Number(dependency.slice(6))] ?? new Map();
    } else if (dependency.startsWith("member:")) {
      const member = callMemberName(dependency.slice(7), receiver);
      source =
        members.get(member) ??
        (symbolic ? new Map([[`member:${member}`, 0]]) : new Map());
    }
    mapped = mergeTaint(mapped, deepenTaint(source, depth));
  }
  return mapped;
}

function wholeHelperCall(expression, methodNames) {
  const value = unwrapParentheses(expression);
  const match =
    /^(?:(this|[A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/.exec(
      value,
    );
  if (!match || !methodNames.has(match[2])) {
    return null;
  }
  const open = value.indexOf("(", match.index);
  const close = matchingIndex(value, open);
  if (close !== value.length - 1) {
    return null;
  }
  return {
    receiver: match[1] ?? "",
    name: match[2],
    arguments: splitTopLevel(value.slice(open + 1, close), ","),
  };
}

function memberName(reference, fieldNames) {
  const normalized = reference.replace(/\s+/g, "");
  if (normalized.startsWith("this.")) {
    return normalized.slice(5);
  }
  if (normalized.includes(".") || fieldNames.has(normalized)) {
    return normalized;
  }
  return "";
}

function taintExpression(
  expression,
  locals,
  members,
  summaries,
  fieldNames,
  symbolic,
) {
  let value = unwrapParentheses(expression);
  value = value.replace(
    /^\(\s*[A-Za-z_$][\w$<>,.?\s]*(?:\[\s*\])?\s*\)\s*/,
    "",
  );
  if (directEnvironment(value) === "AZURE_CLIENT_SECRET") {
    return new Map([[symbolic ? "secret" : "secret", 0]]);
  }
  if (
    environmentAccessorSource(value, summaries.environmentAccessors) ===
    "AZURE_CLIENT_SECRET"
  ) {
    return new Map([["secret", 0]]);
  }

  const methodNames = new Set(summaries.keys());
  const helper = wholeHelperCall(value, methodNames);
  if (helper) {
    const argumentValues = helper.arguments.map((argument) =>
      taintExpression(
        argument,
        locals,
        members,
        summaries,
        fieldNames,
        symbolic,
      ),
    );
    return mapSummaryTaint(
      mergedHelperSummary(summaries, helper.name).returns,
      argumentValues,
      members,
      symbolic,
      helper.receiver,
    );
  }

  const question = splitTopLevel(value, "?");
  if (question.length > 1) {
    const branches = question.slice(1).flatMap((part) =>
      splitTopLevel(part, ":"),
    );
    return mergeTaint(
      ...branches.map((branch) =>
        taintExpression(
          branch,
          locals,
          members,
          summaries,
          fieldNames,
          symbolic,
        ),
      ),
    );
  }

  const concatenated = splitTopLevel(value, "+");
  if (concatenated.length > 1) {
    return mergeTaint(
      ...concatenated.map((part) =>
        taintExpression(
          part,
          locals,
          members,
          summaries,
          fieldNames,
          symbolic,
        ),
      ),
    );
  }

  const indexed = /^([\s\S]+?)\s*\[[^\]]*\]\s*$/.exec(value);
  if (indexed) {
    return taintExpression(
      indexed[1],
      locals,
      members,
      summaries,
      fieldNames,
      symbolic,
    );
  }

  const foundCalls = calls(value);
  const transformingCall =
    /^(?:String\s*\.\s*(?:format|join|valueOf)|java\.text\.MessageFormat\s*\.\s*format|Objects\s*\.\s*(?:toString|requireNonNull)|Arrays\s*\.\s*toString|(?:List|Set|Map|Arrays|Collections)\s*\.\s*(?:of|asList|singleton|singletonList|singletonMap))\s*\(/.test(
      value,
    ) ||
    foundCalls.length > 0;
  if (transformingCall) {
    let transformed = new Map();
    const receiver = value.match(
      /^((?:this\s*\.\s*)?[A-Za-z_$][\w$]*)\s*\./,
    )?.[1];
    if (receiver) {
      transformed = mergeTaint(
        transformed,
        taintExpression(
          receiver,
          locals,
          members,
          summaries,
          fieldNames,
          symbolic,
        ),
      );
    }
    const nonRevealingArgumentMethods = new Set([
      "add",
      "addAll",
      "clientId",
      "clientSecret",
      "credential",
      "offer",
      "push",
      "put",
      "putAll",
      "set",
      "tenantId",
      "vaultUrl",
    ]);
    for (const call of foundCalls) {
      if (nonRevealingArgumentMethods.has(call.method)) {
        continue;
      }
      transformed = mergeTaint(
        transformed,
        ...splitTopLevel(call.args, ",").map((argument) =>
          taintExpression(
            argument,
            locals,
            members,
            summaries,
            fieldNames,
            symbolic,
          ),
        ),
      );
    }
    return transformed;
  }

  const reference =
    /^(?:(?:this|[A-Za-z_$][\w$]*)\s*\.\s*)*[A-Za-z_$][\w$]*$/.test(
      value,
    )
      ? value.replace(/\s+/g, "")
      : "";
  if (!reference) {
    return new Map();
  }

  if (locals.has(reference)) {
    return locals.get(reference);
  }
  const member = memberName(reference, fieldNames);
  if (!member) {
    return new Map();
  }
  return (
    members.get(member) ??
    (symbolic ? new Map([[`member:${member}`, 0]]) : new Map())
  );
}

function aggregateMutations(source) {
  const found = [];
  const pattern =
    /(?<![\w$.])((?:this|[A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*(add|addAll|put|putAll|set|offer|push)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf("(", match.index);
    const close = matchingIndex(source, open);
    if (close !== -1) {
      found.push({
        kind: "aggregate",
        receiver: match[1].replace(/\s+/g, ""),
        start: match.index,
        arguments: splitTopLevel(source.slice(open + 1, close), ","),
      });
      pattern.lastIndex = close + 1;
    }
  }
  const indexed =
    /(?<![\w$.])((?:this|[A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\[[^\]]+\]\s*=(?!=)\s*/g;
  while ((match = indexed.exec(source)) !== null) {
    const end = statementEnd(source, indexed.lastIndex);
    found.push({
      kind: "aggregate",
      receiver: match[1].replace(/\s+/g, ""),
      start: match.index,
      arguments: [source.slice(indexed.lastIndex, end)],
    });
    indexed.lastIndex = end + 1;
  }
  return found;
}

function taintAssignments(source) {
  const found = [];
  const pattern =
    /(?<![\w$.])((?:this|[A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(>>>=|>>=|<<=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|=(?!=))/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const end = statementEnd(source, pattern.lastIndex);
    found.push({
      kind: "assignment",
      start: match.index,
      target: match[1].replace(/\s+/g, ""),
      operator: match[2],
      expression: source.slice(pattern.lastIndex, end),
    });
    pattern.lastIndex = end + 1;
  }
  return found;
}

function helperInvocations(source, methodNames) {
  const found = [];
  const pattern =
    /(?<![\w$])(?:(this|[A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (!methodNames.has(match[2])) {
      continue;
    }
    const open = source.indexOf("(", match.index);
    const close = matchingIndex(source, open);
    if (close !== -1) {
      found.push({
        kind: "helper",
        receiver: match[1] ?? "",
        name: match[2],
        start: match.index,
        arguments: splitTopLevel(source.slice(open + 1, close), ","),
      });
    }
  }
  return found;
}

function taintRegion(
  source,
  parameters,
  summaries,
  members,
  fieldNames,
  symbolic,
) {
  const locals = new Map(
    parameters.map((parameter, index) => [
      parameter,
      new Map([[`param:${index}`, 0]]),
    ]),
  );
  const parameterIndexes = new Map(
    parameters.map((parameter, index) => [parameter, index]),
  );
  const formalMutation = (target) => {
    const normalized = target.replace(/\s+/g, "").replace(/^this\./, "");
    for (const [parameter, index] of parameterIndexes) {
      if (
        normalized === parameter ||
        normalized.startsWith(`${parameter}.`)
      ) {
        return {
          key: `${index}${normalized.slice(parameter.length)}`,
          parameter,
        };
      }
    }
    return null;
  };
  const mutations = new Map();
  const methodNames = new Set(summaries.keys());
  const events = [
    ...taintAssignments(source),
    ...aggregateMutations(source),
    ...helperInvocations(source, methodNames),
    ...systemOutputCalls(source).map((event) => ({ ...event, kind: "sink" })),
    ...loggingCalls(source).map((event) => ({ ...event, kind: "sink" })),
  ].sort((left, right) => left.start - right.start);
  let sinks = new Map();
  const writtenMembers = new Set();

  for (const event of events) {
    if (event.kind === "assignment") {
      const next =
        event.operator === "="
          ? taintExpression(
              event.expression,
              locals,
              members,
              summaries,
              fieldNames,
              symbolic,
            )
          : new Map();
      const formal = formalMutation(event.target);
      if (formal) {
        mutations.set(
          formal.key,
          mergeTaint(mutations.get(formal.key), next),
        );
        locals.set(
          formal.parameter,
          mergeTaint(locals.get(formal.parameter), next),
        );
        if (event.target !== formal.parameter) {
          members.set(event.target, next);
        }
        continue;
      }
      const member = memberName(event.target, fieldNames);
      if (member && !locals.has(event.target)) {
        members.set(member, next);
        writtenMembers.add(member);
      } else {
        locals.set(event.target, next);
      }
      continue;
    }
    if (event.kind === "helper") {
      const argumentsTaint = event.arguments.map((argument) =>
        taintExpression(
          argument,
          locals,
          members,
          summaries,
          fieldNames,
          symbolic,
        ),
      );
      const summary = mergedHelperSummary(summaries, event.name);
      sinks = mergeTaint(
        sinks,
        mapSummaryTaint(
          summary.sinks,
          argumentsTaint,
          members,
          symbolic,
          event.receiver,
        ),
      );
      for (const [member, value] of summary.effects) {
        const targetMember = callMemberName(member, event.receiver);
        members.set(
          targetMember,
          mapSummaryTaint(
            value,
            argumentsTaint,
            members,
            symbolic,
            event.receiver,
          ),
        );
        writtenMembers.add(targetMember);
      }
      for (const [formalKey, value] of summary.mutations) {
        const parsed = /^(\d+)(.*)$/.exec(String(formalKey));
        if (!parsed) continue;
        const parameter = Number(parsed[1]);
        const argument = exactReference(event.arguments[parameter] ?? "");
        if (!argument) continue;
        const target = `${argument}${parsed[2]}`;
        const member = memberName(target, fieldNames);
        const aggregate =
          locals.get(target) ??
          (member ? members.get(member) : null) ??
          new Map();
        const mapped = mapSummaryTaint(
          value,
          argumentsTaint,
          members,
          symbolic,
          event.receiver,
        );
        for (const [dependency] of mapped) {
          aggregate.set(dependency, 0);
        }
        if (locals.has(target) || !member) {
          locals.set(target, aggregate);
        } else {
          members.set(member, aggregate);
          writtenMembers.add(member);
        }
        const argumentAggregate = mergeTaint(
          locals.get(argument),
          mapped,
        );
        if (locals.has(argument) || !memberName(argument, fieldNames)) {
          locals.set(argument, argumentAggregate);
        }
        const enclosingFormal = formalMutation(target);
        if (enclosingFormal) {
          mutations.set(
            enclosingFormal.key,
            mergeTaint(
              mutations.get(enclosingFormal.key),
              mapped,
            ),
          );
        }
      }
      continue;
    }
    if (event.kind === "aggregate") {
      const added = mergeTaint(
        ...event.arguments.map((argument) =>
          taintExpression(
            argument,
            locals,
            members,
            summaries,
            fieldNames,
            symbolic,
          ),
        ),
      );
      const formal = formalMutation(event.receiver);
      if (formal) {
        mutations.set(
          formal.key,
          mergeTaint(mutations.get(formal.key), added),
        );
        locals.set(
          formal.parameter,
          mergeTaint(locals.get(formal.parameter), added),
        );
        if (event.receiver !== formal.parameter) {
          members.set(event.receiver, added);
        }
        continue;
      }
      const member = memberName(event.receiver, fieldNames);
      const aggregate =
        locals.get(event.receiver) ??
        (member ? members.get(member) : null) ??
        new Map();
      for (const [dependency] of added) {
        aggregate.set(dependency, 0);
      }
      if (locals.has(event.receiver) || !member) {
        locals.set(event.receiver, aggregate);
      } else {
        members.set(member, aggregate);
        writtenMembers.add(member);
      }
      continue;
    }
    sinks = mergeTaint(
      sinks,
      ...splitTopLevel(event.args, ",").map((argument) =>
        taintExpression(
          argument,
          locals,
          members,
          summaries,
          fieldNames,
          symbolic,
        ),
      ),
    );
  }

  let returns = new Map();
  const returnPattern = /\breturn\s+([^;]+);/g;
  for (const match of source.matchAll(returnPattern)) {
    returns = mergeTaint(
      returns,
      taintExpression(
        match[1],
        locals,
        members,
        summaries,
        fieldNames,
        symbolic,
      ),
    );
  }
  return {
    returns,
    sinks,
    effects: new Map(
      Array.from(writtenMembers, (member) => [
        member,
        members.get(member) ?? new Map(),
      ]),
    ),
    mutations,
  };
}

function allocationIdentityTaint(source, methods) {
  const objects = new Map();
  const cleanSinks = new Set();
  const environmentAccessors = environmentAccessorSummaries(source);
  const methodsByName = new Map();
  for (const method of methods) {
    const overloads = methodsByName.get(method.name) ?? [];
    overloads.push(method);
    methodsByName.set(method.name, overloads);
  }
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
    const normalized = unwrapParentheses(path)
      .replace(
        /\[\s*(?:"([^"]+)"|'([^']+)'|(\d+))\s*\]/g,
        (_match, double, single, number) => `.${double ?? single ?? number}`,
      )
      .replace(/\[[^\]]+\]/g, ".*")
      .replace(/\s+/g, "");
    return /^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\d+|\*))*$/.test(
      normalized,
    )
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
    for (const id of current.ids) {
      objects.get(id)?.set(segments.at(-1), next);
    }
  };

  const statements = (region) => {
    const found = [];
    let start = 0;
    let parentheses = 0;
    let brackets = 0;
    let initializerBraces = 0;
    for (let index = 0; index < region.length; index += 1) {
      const character = region[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") parentheses = Math.max(0, parentheses - 1);
      else if (character === "[") brackets += 1;
      else if (character === "]") brackets = Math.max(0, brackets - 1);
      else if (character === "{") {
        const prefix = region.slice(start, index);
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
        const statement = region.slice(start, index).trim();
        if (statement) found.push(statement);
        start = index + 1;
      }
    }
    return found;
  };
  const invocations = (expression) => {
    const found = [];
    const pattern =
      /((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*\(/g;
    let match;
    while ((match = pattern.exec(expression)) !== null) {
      const open = expression.indexOf("(", match.index);
      const close = matchingIndex(expression, open);
      if (close < 0) continue;
      found.push({
        args: expression.slice(open + 1, close),
        end: close + 1,
        name: match[1].replace(/\s+/g, ""),
        start: match.index,
      });
      pattern.lastIndex = close + 1;
    }
    return found;
  };
  const isSink = (name) =>
    /^(?:System\.(?:out|err)\.(?:print|println|printf|write|append)|(?:[A-Za-z_$][\w$]*\.)*(?:trace|debug|info|warn|error|log))$/.test(
      name,
    );
  const declaration =
    /^\s*(?:(?:public|protected|private|static|final|volatile|transient|synchronized)\s+)*(?:var|[A-Za-z_$][\w$]*(?:\s*<[^;=]+>)?(?:\s*\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/;
  const assignment =
    /^\s*((?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]+\]))*)\s*=\s*([\s\S]+)$/;

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
    let text = unwrapParentheses(expression.trim())
      .replace(/^\(\s*[A-Za-z_$][\w$<>,.?\s]*(?:\[\s*\])?\s*\)\s*/, "");
    if (
      /System\s*\.\s*getenv\s*\(\s*["']AZURE_CLIENT_SECRET["']/.test(text)
    ) {
      return value(true);
    }
    if (
      environmentAccessorSource(text, environmentAccessors) ===
      "AZURE_CLIENT_SECRET"
    ) {
      return value(true);
    }
    const path = normalize(text);
    if (path) return readPath(path, environment);

    const foundCalls = invocations(text);
    const whole = foundCalls.find(
      (call) =>
        call.start === 0 &&
        call.end === text.length &&
        methodsByName.has(call.name.split(".").at(-1)),
    );
    if (whole) {
      const argumentsList = splitTopLevel(whole.args, ",").map((argument) =>
        expressionValue(argument, environment, depth),
      );
      const receiverPath = whole.name.split(".").slice(0, -1).join(".");
      const receiver = receiverPath
        ? readPath(receiverPath, environment)
        : environment.get("this");
      return merge(
        ...(methodsByName.get(whole.name.split(".").at(-1)) ?? [])
          .filter(
            (definition) =>
              definition.parameters.length === argumentsList.length,
          )
          .map((definition) =>
            executeDefinition(definition, argumentsList, receiver, depth)
          ),
      );
    }

    if (/^new\b/.test(text)) {
      const result = allocate();
      if (/ClientSecretCredentialBuilder/.test(text)) return result;
      const initializer = /\{([\s\S]*)\}\s*$/.exec(text)?.[1];
      if (initializer) {
        for (const entry of splitTopLevel(initializer, ",")) {
          const child = expressionValue(entry, environment, depth);
          for (const id of result.ids) {
            objects.get(id).set(
              "*",
              merge(objects.get(id).get("*"), child),
            );
          }
        }
      }
      for (const call of foundCalls) {
        if (/^(?:add|addAll|append|offer|push|put|putAll|set)$/.test(
          call.name.split(".").at(-1),
        )) {
          const added = merge(
            ...splitTopLevel(call.args, ",").map((argument) =>
              expressionValue(argument, environment, depth)
            ),
          );
          for (const id of result.ids) {
            objects.get(id).set(
              "*",
              merge(objects.get(id).get("*"), added),
            );
          }
        }
      }
      return result;
    }

    const question = splitTopLevel(text, "?");
    if (question.length > 1) {
      return merge(
        ...question.slice(1).flatMap((part) =>
          splitTopLevel(part, ":").map((branch) =>
            expressionValue(branch, environment, depth)
          )
        ),
      );
    }
    const code = sanitizeJava(text);
    const references = [];
    for (const call of foundCalls) {
      const receiver = call.name.split(".").slice(0, -1).join(".");
      if (receiver) references.push(readPath(receiver, environment));
    }
    for (const match of code.matchAll(
      /(?<![\w.])(?:this\s*\.\s*)?[A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]+\]))*/g,
    )) {
      references.push(readPath(match[0], environment));
    }
    return merge(...references);
  };

  const execute = (region, environment, depth = 0) => {
    let returned = value();
    for (const statement of statements(region)) {
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
        const simpleName = call.name.split(".").at(-1);
        const argumentsList = splitTopLevel(call.args, ",").map((argument) =>
          expressionValue(argument, environment, depth),
        );
        if (isSink(call.name)) {
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
        const receiverPath = call.name.split(".").slice(0, -1).join(".");
        const receiver = receiverPath
          ? readPath(receiverPath, environment)
          : environment.get("this");
        if (
          /^(?:add|addAll|offer|push|put|putAll|set)$/.test(simpleName) &&
          receiverPath
        ) {
          writePath(
            `${receiverPath}[*]`,
            merge(readPath(`${receiverPath}[*]`, environment), ...argumentsList),
            environment,
          );
        }
        for (const definition of methodsByName.get(simpleName) ?? []) {
          if (definition.parameters.length === argumentsList.length) {
            executeDefinition(definition, argumentsList, receiver, depth);
          }
        }
      }
    }
    return { returned };
  };

  let root = source;
  for (const definition of [...methods].sort(
    (left, right) => right.start - left.start,
  )) {
    const start = /[;{}]/.test(root[definition.start])
      ? definition.start + 1
      : definition.start;
    root =
      root.slice(0, start) +
      root.slice(start, definition.bodyEnd + 1).replace(/[^\n]/g, " ") +
      root.slice(definition.bodyEnd + 1);
  }
  execute(root, new Map());

  let sanitized = source;
  for (const statement of cleanSinks) {
    sanitized = sanitized.replaceAll(statement, statement.replace(/[^\n]/g, " "));
  }
  return { exposed, source: sanitized };
}

function hasSecretLeak(source) {
  const methods = helperMethods(source);
  const environmentAccessors = environmentAccessorSummaries(source);
  const identity = allocationIdentityTaint(source, methods);
  if (identity.exposed) return true;
  source = identity.source;
  const scopes = lexicalScopes(source);
  const fieldNames = new Set(
    declarations(source, scopes)
      .filter(({ scope }) => scope.kind === "type")
      .map(({ name }) => name),
  );
  let summaries = new Map(
    methods.map(({ name }) => [name, []]),
  );
  summaries.environmentAccessors = environmentAccessors;
  while (true) {
    const next = new Map(Array.from(summaries.keys(), (name) => [name, []]));
    next.environmentAccessors = environmentAccessors;
    for (const method of methods) {
      const members = new Map();
      const summary = taintRegion(
        method.body,
        method.parameters,
        summaries,
        members,
        fieldNames,
        true,
      );
      next.get(method.name).push({
        returns: deepenTaint(summary.returns),
        sinks: deepenTaint(summary.sinks),
        effects: new Map(
          Array.from(summary.effects, ([member, value]) => [
            member,
            deepenTaint(value),
          ]),
        ),
        mutations: new Map(
          Array.from(summary.mutations, ([parameter, value]) => [
            parameter,
            deepenTaint(value),
          ]),
        ),
      });
    }
    if (summaryMapsEqual(summaries, next)) {
      summaries = next;
      break;
    }
    summaries = next;
  }
  let root = source;
  for (const method of [...methods].sort((left, right) => right.start - left.start)) {
    root =
      root.slice(0, method.start) +
      root
        .slice(method.start, method.bodyEnd + 1)
        .replace(/[^\n]/g, " ") +
      root.slice(method.bodyEnd + 1);
  }
  const regions = [root, ...methods.map(({ body }) => body)];
  for (const region of regions) {
    const result = taintRegion(
      region,
      [],
      summaries,
      new Map(),
      fieldNames,
      false,
    );
    if (result.sinks.has("secret")) {
      return true;
    }
  }
  return false;
}

function hasSafeEnvironmentManagement(source) {
  const analysis = analyze(source);
  const simulation = analysis.simulate(source.length + 1);
  const credentials = simulation.constructions.filter(
    (credential) => credential.credentialKind === "client-secret",
  );
  return (
    credentials.length > 0 &&
    credentials.every((credential) => credential.valid) &&
    simulation.clientConstructions.length > 0 &&
    hasAssociatedGetSecret(source) &&
    !hasSecretLeak(source)
  );
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
    preservesCatch(header, body) ||
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

function javaHandlerAlwaysCausal(header, body, allowNonzeroExit = false) {
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
      if (
        allowNonzeroExit &&
        /^(?:java\.lang\.)?System\s*\.\s*exit\s*\(\s*[+-]?(?!0+\s*\))\d+\s*\)\s*;\s*$/.test(
          text,
        )
      ) {
        return new Set(["safe"]);
      }
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

function actionableAuthenticationExit(body) {
  const diagnosticCalls = [
    ...systemOutputCalls(body),
    ...loggingCalls(body),
  ];
  const braceDepthAt = (position) => {
    let depth = 0;
    for (let index = 0; index < position; index += 1) {
      if (body[index] === "{") depth += 1;
      else if (body[index] === "}") depth -= 1;
    }
    return depth;
  };
  const actionableDiagnostics = diagnosticCalls.filter(({ args, start }) => {
    const literals = Array.from(
      args.matchAll(/"((?:\\.|[^"\\])*)"/g),
      (match) => match[1],
    ).join(" ");
    return (
      braceDepthAt(start) === 0 &&
      /\b(?:auth(?:entication)?|credential)\w*\b/i.test(literals) &&
      /\b(?:check|configure|ensure|provide|set|update|verify)\w*\b/i.test(
        literals,
      )
    );
  });
  const exitPattern =
    /\b(?:java\.lang\.)?System\s*\.\s*exit\s*\(\s*[+-]?(?!0+\s*\))\d+\s*\)/g;
  const hasOrderedDiagnostic = actionableDiagnostics.some(({ start }) => {
    const prefix = body.slice(0, start);
    if (
      /\b(?:break|continue|do|for|if|return|switch|throw|try|while|yield)\b/.test(
        prefix,
      ) ||
      /\b(?:java\.lang\.)?System\s*\.\s*exit\s*\(/.test(prefix)
    ) {
      return false;
    }
    exitPattern.lastIndex = start;
    return exitPattern.exec(body) !== null;
  });
  return (
    hasOrderedDiagnostic &&
    javaHandlerAlwaysCausal("", body, true)
  );
}

function authenticationCatchKind(header, source, position) {
  const parsed =
    /^\s*(?:final\s+)?([\s\S]*?)\s+([A-Za-z_$][\w$]*)\s*$/.exec(header);
  if (!parsed) {
    return "";
  }
  const references = parsed[1].split("|").map((type) => type.trim());
  const types = references.map((type) => type.split(".").at(-1));
  const authenticationIndexes = types
    .map((type, index) =>
      type === "ClientAuthenticationException" ? index : -1,
    )
    .filter((index) => index >= 0);
  if (
    authenticationIndexes.length !== 1 ||
    !authenticType(
      source,
      references[authenticationIndexes[0]],
      position,
    )
  ) {
    return "";
  }
  if (types.length === 1) {
    return "exact";
  }
  return "authentication-multi";
}

function handlesAuthenticationErrors(source) {
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
            environmentAccessors: analysis.environmentAccessors,
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
      const kind = authenticationCatchKind(header, source, start);
      if (
        kind &&
        (meaningfulCatch(header, catchBody) ||
          javaHandlerAlwaysCausal(header, catchBody) ||
          (kind === "exact" && actionableAuthenticationExit(catchBody)))
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
      const kind = authenticationCatchKind(header, source, start);
      return (
        (kind === "exact" && usefulConnectedCatches.has(start)) ||
        javaHandlerAlwaysCausal(header, body)
      );
    })
  );
}

function compareJavaVersions(left, right) {
  const leftParts = left.split(/[._-]/).map((part) => Number(part) || 0);
  const rightParts = right.split(/[._-]/).map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function jdkActivationMatchesJava17(declaration) {
  const value = declaration.trim();
  const current = "17";
  const range = /^([\[(])\s*([^,]*)\s*,\s*([^)\]]*)\s*([)\]])$/.exec(
    value,
  );
  if (range) {
    const lower = range[2];
    const upper = range[3];
    const aboveLower =
      !lower ||
      compareJavaVersions(current, lower) > 0 ||
      (range[1] === "[" && compareJavaVersions(current, lower) === 0);
    const belowUpper =
      !upper ||
      compareJavaVersions(current, upper) < 0 ||
      (range[4] === "]" && compareJavaVersions(current, upper) === 0);
    return aboveLower && belowUpper;
  }
  const exactRange = /^\[\s*([^\]]+)\s*\]$/.exec(value);
  if (exactRange) {
    return compareJavaVersions(current, exactRange[1]) === 0;
  }
  if (value.startsWith("!")) {
    return !current.startsWith(value.slice(1).trim());
  }
  return current.startsWith(value);
}

function mavenProfileIsActive(profile) {
  const activation =
    /<activation\b[^>]*>([\s\S]*?)<\/activation\s*>/i.exec(profile)?.[1];
  if (!activation) return false;
  const predicates = [];
  const activeByDefault =
    /<activeByDefault\b[^>]*>([^<]*)<\/activeByDefault\s*>/i.exec(
      activation,
    );
  if (activeByDefault) {
    predicates.push(activeByDefault[1].trim().toLowerCase() === "true");
  }
  const jdk = /<jdk\b[^>]*>([^<]*)<\/jdk\s*>/i.exec(activation);
  if (jdk) predicates.push(jdkActivationMatchesJava17(jdk[1]));
  if (/<(?:property|os|file)\b/i.test(activation)) predicates.push(false);
  return predicates.length > 0 && predicates.every(Boolean);
}

function mavenRuntimeManifest(build) {
  const profiles =
    build.match(/<profile\b[^>]*>[\s\S]*?<\/profile\s*>/gi) ?? [];
  const activeProfiles = profiles.filter(mavenProfileIsActive);
  const base = build.replace(/<profiles\b[^>]*>[\s\S]*?<\/profiles\s*>/gi, " ");
  return `${base}\n${activeProfiles.join("\n")}`.replace(
    /<dependencyManagement\b[\s\S]*?<\/dependencyManagement\s*>/gi,
    " ",
  ).replace(/<plugin\b[\s\S]*?<\/plugin\s*>/gi, " ");
}

function matchingToken(tokens, start, open = "(", close = ")") {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) {
      depth += 1;
    } else if (tokens[index].value === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function staticGradleBoolean(tokens, start, end) {
  const binary = (lower, symbols, combine) => {
    let left = lower();
    while (
      symbols.some((symbol) =>
        symbol.every(
          (value, offset) => tokens[left.index + offset]?.value === value,
        ),
      )
    ) {
      const symbol = symbols.find((candidate) =>
        candidate.every(
          (value, offset) => tokens[left.index + offset]?.value === value,
        ),
      );
      const rightStart = left.index + symbol.length;
      cursor = rightStart;
      const right = lower();
      left = {
        value: combine(left.value, right.value, symbol.join("")),
        index: right.index,
      };
    }
    return left;
  };
  let cursor = start;
  const primary = () => {
    if (tokens[cursor]?.value === "!") {
      cursor += 1;
      const nested = primary();
      return {
        value: nested.value === null ? null : !nested.value,
        index: nested.index,
      };
    }
    if (tokens[cursor]?.value === "(") {
      cursor += 1;
      const nested = disjunction();
      if (tokens[cursor]?.value === ")") cursor += 1;
      return { value: nested.value, index: cursor };
    }
    if (tokens[cursor]?.value === "true" || tokens[cursor]?.value === "false") {
      const value = tokens[cursor].value === "true";
      cursor += 1;
      return { value, index: cursor };
    }
    if (tokens[cursor]?.kind === "number") {
      const value = Number(tokens[cursor].value) !== 0;
      cursor += 1;
      return { value, index: cursor };
    }
    if (
      ["+", "-"].includes(tokens[cursor]?.value) &&
      tokens[cursor + 1]?.kind === "number"
    ) {
      const sign = tokens[cursor].value === "-" ? -1 : 1;
      const value = sign * Number(tokens[cursor + 1].value) !== 0;
      cursor += 2;
      return { value, index: cursor };
    }
    if (tokens[cursor]?.kind === "string") {
      const value = tokens[cursor].value.length > 0;
      cursor += 1;
      return { value, index: cursor };
    }
    if (
      tokens[cursor]?.value === "Boolean" &&
      tokens[cursor + 1]?.value === "." &&
      ["TRUE", "FALSE"].includes(tokens[cursor + 2]?.value)
    ) {
      const value = tokens[cursor + 2].value === "TRUE";
      cursor += 3;
      return { value, index: cursor };
    }
    cursor += 1;
    if (tokens[cursor]?.value === "(") {
      const close = matchingToken(tokens, cursor);
      cursor = close === -1 ? end : close + 1;
    }
    return { value: null, index: cursor };
  };
  const equality = () =>
    binary(primary, [["=", "="], ["!", "="]], (left, right, operator) =>
      left === null || right === null
        ? null
        : operator === "=="
          ? left === right
          : left !== right,
    );
  const conjunction = () =>
    binary(equality, [["&", "&"]], (left, right) =>
      left === false || right === false
        ? false
        : left === true && right === true
          ? true
          : null,
    );
  const disjunction = () =>
    binary(conjunction, [["|", "|"]], (left, right) =>
      left === true || right === true
        ? true
        : left === false && right === false
          ? false
          : null,
    );
  return disjunction().value;
}

function inactiveGradleTokens(tokens) {
  const inactive = new Set();
  const markStatement = (start) => {
    let open = start;
    while (
      open < tokens.length &&
      tokens[open].value !== "{" &&
      tokens[open].value !== ";"
    ) {
      open += 1;
    }
    if (tokens[open]?.value === "{") {
      const close = matchingToken(tokens, open, "{", "}");
      if (close !== -1) {
        for (let index = start; index <= close; index += 1) {
          inactive.add(index);
        }
      }
      return close;
    }
    let end = start;
    while (end < tokens.length && tokens[end].value !== ";") {
      end += 1;
    }
    for (let index = start; index <= end; index += 1) {
      inactive.add(index);
    }
    return end;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index].kind !== "identifier" ||
      tokens[index].value !== "if" ||
      tokens[index + 1]?.value !== "("
    ) {
      continue;
    }
    const conditionEnd = matchingToken(tokens, index + 1);
    if (conditionEnd === -1) continue;
    const condition = staticGradleBoolean(tokens, index + 2, conditionEnd);
    let consequentStart = conditionEnd + 1;
    while (tokens[consequentStart]?.value === ";") consequentStart += 1;
    let consequentEnd;
    if (condition === false) {
      consequentEnd = markStatement(consequentStart);
    } else if (tokens[consequentStart]?.value === "{") {
      consequentEnd = matchingToken(tokens, consequentStart, "{", "}");
    } else {
      consequentEnd = consequentStart;
      while (
        consequentEnd < tokens.length &&
        tokens[consequentEnd].value !== ";"
      ) {
        consequentEnd += 1;
      }
    }
    const elseIndex = consequentEnd + 1;
    if (
      condition === true &&
      tokens[elseIndex]?.kind === "identifier" &&
      tokens[elseIndex].value === "else"
    ) {
      markStatement(elseIndex + 1);
    }
  }
  return inactive;
}

function hasDependency(build, artifact) {
  const runtimeManifest = mavenRuntimeManifest(build);
  const dependencies =
    runtimeManifest.match(/<dependency\b[^>]*>[\s\S]*?<\/dependency\s*>/gi) ??
    [];
  const maven = dependencies.some(
    (dependency) =>
      /<groupId>\s*com\.azure\s*<\/groupId>/i.test(dependency) &&
      new RegExp(
        `<artifactId>\\s*${artifact}\\s*<\\/artifactId>`,
        "i",
      ).test(
        dependency,
      ) &&
      !/<scope>\s*(?!compile\s*<|runtime\s*<)[^<]+<\/scope>/i.test(
        dependency,
      ),
  );

  const tokens = [];
  for (let index = 0; index < build.length; ) {
    if (build.startsWith("//", index)) {
      index = build.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (build.startsWith("/*", index)) {
      const close = build.indexOf("*/", index + 2);
      index = close === -1 ? build.length : close + 2;
      continue;
    }
    if (/\s/.test(build[index])) {
      index += 1;
      continue;
    }
    if (/[$A-Za-z_]/.test(build[index])) {
      const match = /^[$A-Za-z_][\w$]*/.exec(build.slice(index))[0];
      tokens.push({ kind: "identifier", value: match });
      index += match.length;
      continue;
    }
    if (/\d/.test(build[index])) {
      const match = /^\d+(?:\.\d+)?/.exec(build.slice(index))[0];
      tokens.push({ kind: "number", value: match });
      index += match.length;
      continue;
    }
    if (build[index] === '"' || build[index] === "'") {
      const quote = build[index];
      let value = "";
      index += 1;
      while (index < build.length && build[index] !== quote) {
        if (build[index] === "\\" && index + 1 < build.length) {
          value += build[index + 1];
          index += 2;
        } else {
          value += build[index];
          index += 1;
        }
      }
      tokens.push({ kind: "string", value });
      index += index < build.length ? 1 : 0;
      continue;
    }
    tokens.push({ kind: "punctuation", value: build[index] });
    index += 1;
  }
  const coordinate = new RegExp(
    `^com\\.azure:${artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?::[^:]+)?$`,
  );
  const inactive = inactiveGradleTokens(tokens);
  const gradle = tokens.some((token, index) => {
    if (
      inactive.has(index) ||
      token.kind !== "identifier" ||
      !["implementation", "api", "runtimeOnly"].includes(token.value)
    ) {
      return false;
    }
    let next = index + 1;
    if (tokens[next]?.value === "(") {
      next += 1;
    }
    return (
      tokens[next]?.kind === "string" &&
      coordinate.test(tokens[next].value)
    );
  });
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
  "prompt/environment-secret-management": ({ source }) =>
    hasSafeEnvironmentManagement(source),
  "prompt/client-secret-credential": ({ source }) =>
    hasConstruction(
      source,
      (credential) =>
        credential.valid &&
        credential.credentialKind === "client-secret",
    ),
  "prompt/credential-client-association": ({ source }) =>
    analyze(source).simulate(source.length + 1).clientConstructions.length > 0,
  "prompt/authenticated-operation": ({ source }) =>
    printsAssociatedSecret(source),
  "prompt/authentication-errors": ({ source }) =>
    handlesAuthenticationErrors(source),
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
