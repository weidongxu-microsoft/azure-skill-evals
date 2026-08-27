function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskCommentsAndStrings(source) {
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

function splitArguments(argumentSource) {
  const argumentsList = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < argumentSource.length; index += 1) {
    const character = argumentSource[index];
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (depth === 0 && character === ",") {
      argumentsList.push(argumentSource.slice(start, index).trim());
      start = index + 1;
    }
  }

  const finalArgument = argumentSource.slice(start).trim();
  if (finalArgument) {
    argumentsList.push(finalArgument);
  }
  return argumentsList;
}

function splitNamedArgument(argument) {
  let depth = 0;
  for (let index = 0; index < argument.length; index += 1) {
    const character = argument[index];
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (depth === 0 && character === "=") {
      return [argument.slice(0, index).trim(), argument.slice(index + 1).trim()];
    }
  }
  return null;
}

function parseArguments(argumentSource) {
  const positional = [];
  const named = new Map();

  for (const argument of splitArguments(argumentSource)) {
    const pair = splitNamedArgument(argument);
    if (pair && /^\w+$/.test(pair[0])) {
      named.set(pair[0], pair[1]);
    } else {
      positional.push(argument);
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

function expressionPattern(bindings) {
  return [...bindings]
    .sort((left, right) => right.length - left.length)
    .map((binding) =>
      escapeRegularExpression(binding).replaceAll("\\.", "\\s*\\.\\s*"),
    )
    .join("|");
}

function assignmentBefore(source, callStart) {
  const prefix = source.slice(Math.max(0, callStart - 300), callStart);
  return prefix.match(
    /(?:^|\n)\s*(\w+)\s*(?::[^=\n]+)?=\s*(?:await\s+)?$/,
  )?.[1];
}

function collectCalls(source, rawSource, bindings) {
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
    const suffix = source.slice(closingIndex + 1, closingIndex + 100);
    calls.push({
      args: source.slice(openingIndex + 1, closingIndex),
      assigned: assignmentBefore(source, match.index),
      closingIndex,
      contextAlias: suffix.match(/^\s+as\s+(\w+)/)?.[1],
      openingIndex,
      rawArgs: rawSource.slice(openingIndex + 1, closingIndex),
      startIndex: match.index,
    });
  }
  return calls;
}

function expressionUsesConstructor(expression, bindings) {
  const patternSource = expressionPattern(bindings);
  return (
    patternSource.length > 0 &&
    new RegExp(`\\b(?:${patternSource})\\s*\\(`).test(expression)
  );
}

function collectMethodCalls(source, receivers, methodNames) {
  const methods = methodNames.map(escapeRegularExpression).join("|");
  const pattern = new RegExp(
    `\\b(\\w+)\\s*\\.\\s*(${methods})\\s*\\(`,
    "g",
  );
  const calls = [];

  for (const match of source.matchAll(pattern)) {
    if (receivers && !receivers.has(match[1])) {
      continue;
    }
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const closingIndex = findClosingParenthesis(source, openingIndex);
    if (closingIndex !== -1) {
      calls.push({
        args: source.slice(openingIndex + 1, closingIndex),
        assigned: assignmentBefore(source, match.index),
        closingIndex,
        method: match[2],
        openingIndex,
        receiver: match[1],
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

function collectTryStatements(source) {
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
      const handlerMatch = lines[boundary].text.match(
        /^(\s*)except\s+(.+?)\s*:\s*$/,
      );
      if (!handlerMatch || handlerMatch[1].length !== indentation) {
        break;
      }

      const next = nextBoundary(lines, boundary + 1, indentation);
      handlers.push({
        body: source.slice(
          lines[boundary].end,
          next < lines.length ? lines[next].start : source.length,
        ),
        header: handlerMatch[2],
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

function hasUsefulExceptionHandler(body) {
  const meaningful = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    meaningful.length === 0 ||
    meaningful.every((line) => line === "pass" || line === "...")
  ) {
    return false;
  }

  return (
    /\braise\b/.test(body) ||
    /\breturn\b/.test(body) ||
    /\bprint\s*\(/.test(body) ||
    /\b(?:\w+\.)*(?:exception|error|warning|critical)\s*\(/.test(body) ||
    /\b(?:sys\.)?exit\s*\(/.test(body)
  );
}

function hasDiagnosticLevel(argumentSource) {
  return /\b(?:DEBUG|INFO)\b/.test(argumentSource) ||
    /\b(?:10|20)\b/.test(argumentSource);
}

function createContext(workspace) {
  const rawSource = workspace.python ?? "";
  const source = maskCommentsAndStrings(rawSource);
  const credentialBindings = importBindings(
    source,
    "azure.identity",
    "DefaultAzureCredential",
  );
  const secretClientBindings = new Set([
    ...importBindings(source, "azure.keyvault.secrets", "SecretClient"),
    ...importBindings(source, "azure.keyvault.secrets.aio", "SecretClient"),
  ]);
  const credentials = collectCalls(source, rawSource, credentialBindings);
  const credentialVariables = new Set(
    credentials.map(({ assigned }) => assigned).filter(Boolean),
  );
  const clients = collectCalls(source, rawSource, secretClientBindings).map(
    (client) => {
      const args = parseArguments(client.args);
      const credentialArgument =
        args.named.get("credential") ?? args.positional[1];
      const associated =
        credentialArgument !== undefined &&
        (credentialVariables.has(credentialArgument.trim()) ||
          expressionUsesConstructor(credentialArgument, credentialBindings));
      return {
        ...client,
        associated,
        variable: client.assigned ?? client.contextAlias,
      };
    },
  );

  return {
    clients,
    credentialBindings,
    credentials,
    rawSource,
    source,
  };
}

function collectAuthenticatedRetrievals(context) {
  const calls = [];

  for (const client of context.clients.filter(({ associated }) => associated)) {
    if (client.variable) {
      calls.push(
        ...collectMethodCalls(
          context.source,
          new Set([client.variable]),
          ["get_secret"],
        ),
      );
    }

    const suffixStart = client.closingIndex + 1;
    const suffix = context.source.slice(suffixStart, suffixStart + 150);
    const chained = suffix.match(
      /^\s*\.\s*get_secret\s*\(/,
    );
    if (chained) {
      const openingIndex = suffixStart + chained[0].lastIndexOf("(");
      const closingIndex = findClosingParenthesis(
        context.source,
        openingIndex,
      );
      if (closingIndex !== -1) {
        calls.push({
          assigned: client.assigned,
          closingIndex,
          openingIndex,
          startIndex: suffixStart + chained.index,
        });
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

  const escapedResult = escapeRegularExpression(retrieval.assigned);
  const returnsValue = /^\s*\)*\s*\.value\b/.test(
    context.source.slice(retrieval.closingIndex + 1),
  );
  const outputPattern = returnsValue
    ? new RegExp(`(?:^|[^\\w.])${escapedResult}\\b`)
    : new RegExp(
        `(?:^|[^\\w.])${escapedResult}\\s*\\.\\s*value\\b`,
      );
  const interpolatedExpression = returnsValue
    ? `\\b${escapedResult}\\b`
    : `\\b${escapedResult}\\s*\\.\\s*value\\b`;
  const interpolatedOutputPattern = new RegExp(
    `(?:^|[,([]\\s*)(?:[rub]*f[rub]*)(?:"""|'''|"|')` +
      `[^{}]*\\{[^{}]*${interpolatedExpression}[^{}]*\\}`,
    "i",
  );
  const reassignmentPattern = new RegExp(
    `(?:^|[;\\n])\\s*${escapedResult}\\s*(?::[^=;\\n]+)?=`,
  );

  return printCalls.some(
    (printCall) =>
      printCall.startIndex > retrieval.closingIndex &&
      !reassignmentPattern.test(
        context.source.slice(
          retrieval.closingIndex + 1,
          printCall.startIndex,
        ),
      ) &&
      (outputPattern.test(printCall.args) ||
        interpolatedOutputPattern.test(printCall.rawArgs)),
  );
}

function authenticatedRetrievalsWithOutput(context) {
  return collectAuthenticatedRetrievals(context).filter((retrieval) =>
    hasValueOutput(context, retrieval),
  );
}

function hasAuthenticatedOperation(context) {
  return authenticatedRetrievalsWithOutput(context).length > 0;
}

function exceptionHeaderUses(header, bindings) {
  const pattern = expressionPattern(bindings);
  if (!pattern) {
    return false;
  }
  const exceptionList = header.replace(/\s+as\s+\w+\s*$/, "");
  return new RegExp(
    `(?:^|[(,]\\s*)(?:${pattern})(?:\\s*[,)]|$)`,
  ).test(exceptionList);
}

function hasAuthenticationErrorHandling(context) {
  const authenticationErrorBindings = importBindings(
    context.source,
    "azure.core.exceptions",
    "ClientAuthenticationError",
  );
  const serviceErrorBindings = new Set(
    [
      "HttpResponseError",
      "ServiceRequestError",
      "ServiceResponseError",
    ].flatMap((name) =>
      [...importBindings(context.source, "azure.core.exceptions", name)],
    ),
  );
  if (
    authenticationErrorBindings.size === 0 ||
    serviceErrorBindings.size === 0
  ) {
    return false;
  }

  for (const statement of collectTryStatements(context.source)) {
    const hasConnectedRetrieval = authenticatedRetrievalsWithOutput(
      context,
    ).some(
      ({ startIndex }) =>
        startIndex >= statement.bodyStart && startIndex < statement.bodyEnd,
    );
    if (!hasConnectedRetrieval) {
      continue;
    }

    const hasAuthenticationHandler = statement.handlers.some(
      ({ body, header }) =>
        exceptionHeaderUses(header, authenticationErrorBindings) &&
        !exceptionHeaderUses(header, serviceErrorBindings) &&
        hasUsefulExceptionHandler(body),
    );
    const hasServiceHandler = statement.handlers.some(
      ({ body, header }) =>
        exceptionHeaderUses(header, serviceErrorBindings) &&
        !exceptionHeaderUses(header, authenticationErrorBindings) &&
        hasUsefulExceptionHandler(body),
    );
    if (hasAuthenticationHandler && hasServiceHandler) {
      return true;
    }
  }
  return false;
}

function hasIdentityDiagnostics(context) {
  const loggerBindings = importBindings(
    context.source,
    "logging",
    "getLogger",
  );
  const basicConfigBindings = importBindings(
    context.source,
    "logging",
    "basicConfig",
  );
  const loggerCalls = collectCalls(
    context.source,
    context.rawSource,
    loggerBindings,
  ).filter(({ rawArgs }) =>
    /^\s*(?:[rubfRUBF]*)?(["'])azure\.identity(?:\.[^"']+)?\1\s*$/.test(
      rawArgs,
    ),
  );
  if (loggerCalls.length === 0) {
    return false;
  }

  const rootConfigured =
    collectCalls(
      context.source,
      context.rawSource,
      basicConfigBindings,
    ).length > 0;

  return loggerCalls.some((loggerCall) => {
    const suffix = context.source.slice(
      loggerCall.closingIndex + 1,
      loggerCall.closingIndex + 200,
    );
    const chainedLevel = suffix.match(
      /^\s*\.\s*setLevel\s*\(([^)]*)\)/,
    );
    const chainedHandler =
      /^\s*\.\s*addHandler\s*\((?!\s*\))/.test(suffix);
    const loggerVariable = loggerCall.assigned;
    const levelCalls = loggerVariable
      ? collectMethodCalls(
          context.source,
          new Set([loggerVariable]),
          ["setLevel"],
        )
      : [];
    const handlerCalls = loggerVariable
      ? collectMethodCalls(
          context.source,
          new Set([loggerVariable]),
          ["addHandler"],
        )
      : [];
    const levelConfigured =
      (chainedLevel && hasDiagnosticLevel(chainedLevel[1])) ||
      levelCalls.some(({ args }) => hasDiagnosticLevel(args));
    const outputConfigured =
      rootConfigured ||
      chainedHandler ||
      handlerCalls.some(({ args }) => args.trim().length > 0);
    return Boolean(levelConfigured && outputConfigured);
  });
}

function hasSource(workspace) {
  return typeof workspace.python === "string" && workspace.python.trim() !== "";
}

function declaresPackage(dependencies, packageName) {
  const declarations = dependencies
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  return new RegExp(`\\b${escapeRegularExpression(packageName)}\\b`, "i").test(
    declarations,
  );
}

const rules = {
  "prompt/identity-packages": (workspace) =>
    hasSource(workspace) &&
    declaresPackage(workspace.dependencies ?? "", "azure-identity") &&
    declaresPackage(workspace.dependencies ?? "", "azure-keyvault-secrets"),
  "prompt/default-azure-credential": (workspace) =>
    hasSource(workspace) && createContext(workspace).credentials.length > 0,
  "prompt/credential-client-association": (workspace) =>
    hasSource(workspace) &&
    createContext(workspace).clients.some(({ associated }) => associated),
  "prompt/authenticated-operation": (workspace) =>
    hasSource(workspace) && hasAuthenticatedOperation(createContext(workspace)),
  "prompt/auth-errors": (workspace) =>
    hasSource(workspace) &&
    hasAuthenticationErrorHandling(createContext(workspace)),
  "prompt/identity-diagnostics": (workspace) =>
    hasSource(workspace) && hasIdentityDiagnostics(createContext(workspace)),
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
