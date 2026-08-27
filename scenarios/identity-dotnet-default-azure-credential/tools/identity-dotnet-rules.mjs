import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const defaultCredentialType =
  String.raw`(?:global::)?(?:Azure\.Identity\.)?DefaultAzureCredential`;
const tokenCredentialType =
  String.raw`(?:global::)?(?:Azure\.Core\.)?TokenCredential`;
const blobServiceClientType =
  String.raw`(?:global::)?(?:Azure\.Storage\.Blobs\.)?BlobServiceClient`;
const listenerType =
  String.raw`(?:global::)?(?:Azure\.Core\.Diagnostics\.)?AzureEventSourceListener`;
const eventLevelType =
  String.raw`(?:(?:global::)?System\.Diagnostics\.Tracing\.)?EventLevel`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripXmlComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, " ");
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

function constructorDeclarations(source, type, declaredTypes = [type]) {
  const results = [];
  const explicit = new RegExp(
    String.raw`\b(?:var|${declaredTypes.join("|")})\s+(\w+)\s*=\s*new\s+${type}\s*\(`,
    "g",
  );
  const targetTyped = new RegExp(
    String.raw`\b(?:${declaredTypes.join("|")})\s+(\w+)\s*=\s*new\s*\(`,
    "g",
  );

  for (const pattern of [explicit, targetTyped]) {
    for (const match of source.matchAll(pattern)) {
      const openIndex = match.index + match[0].lastIndexOf("(");
      const closeIndex = matchingDelimiter(source, openIndex, "(", ")");
      if (closeIndex >= 0) {
        results.push({
          name: match[1],
          arguments: source.slice(openIndex + 1, closeIndex),
          start: match.index,
          end: closeIndex + 1,
        });
      }
    }
  }

  return results.filter(
    (candidate, index) =>
      results.findIndex(
        (other) =>
          other.name === candidate.name && other.start === candidate.start,
      ) === index,
  );
}

function credentialDeclarations(source) {
  return constructorDeclarations(source, defaultCredentialType, [
    defaultCredentialType,
    tokenCredentialType,
  ]);
}

function lookupBinding(scopes, name) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) {
      return scopes[index].get(name);
    }
  }
  return null;
}

function aliasBinding(expression, scopes) {
  const alias = /^\s*\(?\s*(\w+)(?:\s*\.\s*\w+)*\s*\)?\s*$/.exec(
    expression,
  );
  return alias === null ? null : lookupBinding(scopes, alias[1]);
}

function operationProvenance(expression, scopes) {
  for (const match of expression.matchAll(
    /\bawait\s+(\w+)\s*\.\s*GetAccountInfoAsync\s*\(/g,
  )) {
    const binding = lookupBinding(scopes, match[1]);
    if (binding?.kind === "client" && binding.provenance) {
      return true;
    }
  }
  return false;
}

function credentialProvenance(expression, scopes, targetTyped = false) {
  if (
    new RegExp(String.raw`\bnew\s+${defaultCredentialType}\s*\(`).test(
      expression,
    ) ||
    (targetTyped && /^\s*new\s*\(/.test(expression))
  ) {
    return true;
  }
  const alias = aliasBinding(expression, scopes);
  return alias?.kind === "credential" && alias.provenance;
}

function constructorArguments(expression, type, targetTyped = false) {
  const pattern = targetTyped
    ? /^\s*new\s*\(/
    : new RegExp(String.raw`^\s*new\s+${type}\s*\(`);
  const match = pattern.exec(expression);
  if (match === null) {
    return null;
  }
  const openIndex = expression.indexOf("(", match.index);
  const closeIndex = matchingDelimiter(expression, openIndex, "(", ")");
  return closeIndex < 0
    ? null
    : expression.slice(openIndex + 1, closeIndex);
}

function clientProvenance(expression, scopes, targetTyped = false) {
  const argumentsSource = constructorArguments(
    expression,
    blobServiceClientType,
    targetTyped,
  );
  if (argumentsSource === null) {
    const alias = aliasBinding(expression, scopes);
    return alias?.kind === "client" && alias.provenance;
  }
  if (
    new RegExp(String.raw`\bnew\s+${defaultCredentialType}\s*\(`).test(
      argumentsSource,
    )
  ) {
    return true;
  }
  const identifiers = argumentsSource.match(/\b\w+\b/g) ?? [];
  return identifiers.some((name) => {
    const binding = lookupBinding(scopes, name);
    return binding?.kind === "credential" && binding.provenance;
  });
}

function valueProvenance(expression, scopes) {
  if (operationProvenance(expression, scopes)) {
    return true;
  }
  const alias = aliasBinding(expression, scopes);
  return alias?.kind === "value" && alias.provenance;
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

function inferredBinding(expression, scopes) {
  if (
    new RegExp(String.raw`^\s*new\s+${defaultCredentialType}\s*\(`).test(
      expression,
    )
  ) {
    return {
      kind: "credential",
      provenance: credentialProvenance(expression, scopes),
    };
  }
  if (
    new RegExp(String.raw`^\s*new\s+${blobServiceClientType}\s*\(`).test(
      expression,
    )
  ) {
    return {
      kind: "client",
      provenance: clientProvenance(expression, scopes),
    };
  }
  const alias = aliasBinding(expression, scopes);
  if (alias !== null) {
    return { ...alias };
  }
  return {
    kind: "value",
    provenance: valueProvenance(expression, scopes),
  };
}

function outputHasProvenance(expression, scopes) {
  if (operationProvenance(expression, scopes)) {
    return true;
  }
  const identifiers = expression.match(/\b\w+\b/g) ?? [];
  return identifiers.some((name) => {
    const binding = lookupBinding(scopes, name);
    return binding?.kind === "value" && binding.provenance;
  });
}

function processIdentityStatement(statement, state) {
  const { scopes } = state;
  const output =
    /\bConsole\s*\.\s*(?:Write|WriteLine)\s*\(([\s\S]*)\)\s*$/.exec(
      statement,
    );
  if (output !== null) {
    state.outputFound ||= outputHasProvenance(output[1], scopes);
    return;
  }

  const credentialDeclaration = new RegExp(
    String.raw`^\s*(?:using\s+)?(${defaultCredentialType}|${tokenCredentialType})\s+(\w+)\s*=\s*([\s\S]+)$`,
  ).exec(statement);
  if (credentialDeclaration !== null) {
    bind(
      scopes,
      credentialDeclaration[2],
      {
        kind: "credential",
        provenance: credentialProvenance(
          credentialDeclaration[3],
          scopes,
          credentialDeclaration[1].endsWith("DefaultAzureCredential"),
        ),
      },
      true,
    );
    return;
  }

  const clientDeclaration = new RegExp(
    String.raw`^\s*(?:using\s+)?${blobServiceClientType}\s+(\w+)\s*=\s*([\s\S]+)$`,
  ).exec(statement);
  if (clientDeclaration !== null) {
    const provenance = clientProvenance(
      clientDeclaration[2],
      scopes,
      true,
    );
    bind(
      scopes,
      clientDeclaration[1],
      { kind: "client", provenance },
      true,
    );
    state.associationFound ||= provenance;
    return;
  }

  const variableDeclaration =
    /^\s*(?:using\s+)?var\s+(\w+)\s*=\s*([\s\S]+)$/.exec(statement);
  if (variableDeclaration !== null) {
    const binding = inferredBinding(variableDeclaration[2], scopes);
    bind(scopes, variableDeclaration[1], binding, true);
    if (binding.kind === "client") {
      state.associationFound ||= binding.provenance;
    }
    return;
  }

  const valueDeclaration = new RegExp(
    String.raw`^\s*(?:(?:global::)?(?:Azure\.)?Response\s*<[^;=]+>|(?:global::)?(?:Azure\.Storage\.Blobs\.Models\.)?AccountInfo)\s+(\w+)\s*=\s*([\s\S]+)$`,
  ).exec(statement);
  if (valueDeclaration !== null) {
    bind(
      scopes,
      valueDeclaration[1],
      {
        kind: "value",
        provenance: valueProvenance(valueDeclaration[2], scopes),
      },
      true,
    );
    return;
  }

  const assignment = /^\s*(\w+)\s*=\s*([\s\S]+)$/.exec(statement);
  if (assignment === null) {
    return;
  }
  const previous = lookupBinding(scopes, assignment[1]);
  let binding;
  if (previous?.kind === "credential") {
    binding = {
      kind: "credential",
      provenance: credentialProvenance(assignment[2], scopes),
    };
  } else if (previous?.kind === "client") {
    binding = {
      kind: "client",
      provenance: clientProvenance(assignment[2], scopes),
    };
    state.associationFound ||= binding.provenance;
  } else if (previous?.kind === "value") {
    binding = {
      kind: "value",
      provenance: valueProvenance(assignment[2], scopes),
    };
  } else {
    binding = inferredBinding(assignment[2], scopes);
  }
  bind(scopes, assignment[1], binding, false);
}

function analyzeIdentityBindings(source) {
  const state = {
    scopes: [new Map()],
    associationFound: false,
    outputFound: false,
  };
  let statement = "";
  let parentheses = 0;
  let brackets = 0;
  let initializerBraces = 0;

  for (const character of source) {
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
        (initializerBraces > 0) ||
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
        if (state.scopes.length > 1) {
          state.scopes.pop();
        }
      }
    } else if (
      character === ";" &&
      parentheses === 0 &&
      brackets === 0 &&
      initializerBraces === 0
    ) {
      processIdentityStatement(statement, state);
      statement = "";
    } else {
      statement += character;
    }
  }
  return state;
}

function accountOperation(source) {
  return analyzeIdentityBindings(source).outputFound;
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

function handledAuthException(header, body, type) {
  const match = new RegExp(
    String.raw`\b(?:global::)?(?:Azure\.Identity\.)?${type}\s+(\w+)\b`,
  ).exec(header);
  return (
    match !== null &&
    new RegExp(
      String.raw`Console\s*\.\s*(?:Error\s*\.\s*)?(?:Write|WriteLine)\s*\([^;]*\b${escapeRegExp(match[1])}\b`,
    ).test(body)
  );
}

function authenticatedAccountOperation(source, body, bodyStart) {
  for (const match of body.matchAll(
    /\bawait\b(\s*(?:\(\s*)*)(\w+)\s*\.\s*GetAccountInfoAsync\s*\(/g,
  )) {
    const receiverOffset = "await".length + match[1].length;
    const operationIndex = bodyStart + match.index + receiverOffset;
    const binding = lookupBinding(
      analyzeIdentityBindings(source.slice(0, operationIndex)).scopes,
      match[2],
    );
    if (binding?.kind === "client" && binding.provenance) {
      return true;
    }
  }
  return false;
}

function hasAuthErrorHandling(source) {
  const tryPattern = /\btry\s*\{/g;
  for (const tryMatch of source.matchAll(tryPattern)) {
    const tryBlock = blockAt(source, source.indexOf("{", tryMatch.index));
    if (
      tryBlock === null ||
      !authenticatedAccountOperation(
        source,
        tryBlock.body,
        tryBlock.start + 1,
      )
    ) {
      continue;
    }

    const catches = [];
    let index = tryBlock.end;
    while (index < source.length) {
      while (/\s/.test(source[index] ?? "")) index += 1;
      const header = /^catch\s*\(([^)]*)\)\s*\{/.exec(source.slice(index));
      if (!header) break;
      const openIndex = index + header[0].lastIndexOf("{");
      const catchBlock = blockAt(source, openIndex);
      if (catchBlock === null) break;
      catches.push({ header: header[1], body: catchBlock.body });
      index = catchBlock.end;
    }

    const unavailable = catches.findIndex(({ header, body }) =>
      handledAuthException(
        header,
        body,
        "CredentialUnavailableException",
      ),
    );
    const failed = catches.findIndex(({ header, body }) =>
      handledAuthException(header, body, "AuthenticationFailedException"),
    );
    if (unavailable >= 0 && failed > unavailable) {
      return true;
    }
  }
  return false;
}

function hasIdentityDiagnostics(source) {
  const createConsoleLogger = new RegExp(
    String.raw`\b(?:using\s+${listenerType}\s+\w+|using\s+var\s+\w+)\s*=\s*${listenerType}\s*\.\s*CreateConsoleLogger\s*\(\s*${eventLevelType}\s*\.\s*(?:Informational|Verbose)\s*\)`,
  );
  const explicitListener = new RegExp(
    String.raw`\b(?:using\s+${listenerType}\s+\w+|using\s+var\s+\w+)\s*=\s*new\s+(?:${listenerType}\s*)?\([\s\S]{0,800}?${eventLevelType}\s*\.\s*(?:Informational|Verbose)[\s\S]{0,200}?\)\s*;`,
  );
  return createConsoleLogger.test(source) || explicitListener.test(source);
}

const rules = {
  "prompt/identity-packages": ({ project }) =>
    ["Azure.Identity", "Azure.Storage.Blobs"].every((name) =>
      new RegExp(
        String.raw`<PackageReference\b[^>]*\bInclude\s*=\s*["']${escapeRegExp(name)}["']`,
      ).test(stripXmlComments(project)),
    ),

  "prompt/default-azure-credential": ({ source }) =>
    credentialDeclarations(source).length > 0 ||
    new RegExp(String.raw`\bnew\s+${defaultCredentialType}\s*\(`).test(source),

  "prompt/credential-client-association": ({ source }) =>
    analyzeIdentityBindings(source).associationFound,

  "prompt/authenticated-operation": ({ source }) =>
    accountOperation(source),

  "prompt/auth-errors": ({ source }) => hasAuthErrorHandling(source),

  "prompt/identity-diagnostics": ({ source }) =>
    hasIdentityDiagnostics(source),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }
  return Boolean(
    rule({
      ...workspace,
      source: dotnetCodeOnly(workspace.source ?? ""),
    }),
  );
}

export function ruleNames() {
  return Object.keys(rules);
}
