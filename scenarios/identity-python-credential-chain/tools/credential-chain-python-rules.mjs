function maskPython(source) {
  const result = [...source];
  let quote = "";
  let triple = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === "\\" && !triple) {
        if (result[index] !== "\n") result[index] = " ";
        index += 1;
        if (result[index] !== "\n") result[index] = " ";
      } else if (
        triple &&
        source.slice(index, index + 3) === quote.repeat(3)
      ) {
        result[index] = result[index + 1] = result[index + 2] = " ";
        index += 2;
        quote = "";
        triple = false;
      } else if (!triple && character === quote) {
        result[index] = " ";
        quote = "";
      } else if (character !== "\n") {
        result[index] = " ";
      }
    } else if (character === "#") {
      while (index < source.length && source[index] !== "\n") {
        result[index] = " ";
        index += 1;
      }
    } else if (character === "'" || character === '"') {
      triple = source.slice(index, index + 3) === character.repeat(3);
      quote = character;
      result[index] = " ";
      if (triple) {
        result[index + 1] = result[index + 2] = " ";
        index += 2;
      }
    }
  }
  return result.join("");
}

function maskUnreachable(raw, code) {
  const result = [...code];
  const lines = code.split(/\r?\n/);
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)if\s+(?:False|0|None)\s*:\s*$/);
    if (!match) continue;
    const indentation = match[1].length;
    let end = index + 1;
    while (
      end < lines.length &&
      (!lines[end].trim() ||
        (lines[end].match(/^\s*/)?.[0].length ?? 0) > indentation)
    ) {
      end += 1;
    }
    const from = offsets[index];
    const to = end < offsets.length ? offsets[end] : raw.length;
    for (let position = from; position < to; position += 1) {
      if (result[position] !== "\n") result[position] = " ";
    }
  }
  return result.join("");
}

function findClosingParenthesis(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function splitArguments(source) {
  const values = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if ("([{".includes(source[index])) depth += 1;
    else if (")]}".includes(source[index])) depth -= 1;
    else if (source[index] === "," && depth === 0) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = source.slice(start).trim();
  if (last) values.push(last);
  return values;
}

function parseFunctions(raw, code) {
  const functions = new Map();
  const lines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(
      /^(\s*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->[^:]*)?:\s*$/,
    );
    if (!match) continue;
    const indentation = match[1].length;
    let end = index + 1;
    while (
      end < lines.length &&
      (!lines[end].trim() ||
        (lines[end].match(/^\s*/)?.[0].length ?? 0) > indentation)
    ) {
      end += 1;
    }
    functions.set(match[3], {
      name: match[3],
      async: Boolean(match[2]),
      parameters: match[4]
        .split(",")
        .map((value) => value.trim().split(/[=:]/)[0].replace(/^\*+/, ""))
        .filter(Boolean),
      raw: rawLines.slice(index + 1, end).join("\n"),
      code: lines.slice(index + 1, end).join("\n"),
    });
  }
  return functions;
}

function literalArgument(raw, code, pattern, accepted) {
  for (const match of code.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf("(");
    const closing = findClosingParenthesis(code, opening);
    if (closing < 0) continue;
    const argument = raw.slice(opening + 1, closing);
    if (accepted.some((value) => argument.includes(`"${value}"`) ||
      argument.includes(`'${value}'`))) {
      return true;
    }
  }
  return false;
}

function branchFor(fn, label) {
  const lines = fn.code.split(/\r?\n/);
  const rawLines = fn.raw.split(/\r?\n/);
  const labelPattern = new RegExp(
    `(?:["']${label}["']|\\.${label.toUpperCase()}\\b)`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    const branch = lines[index].match(
      /^(\s*)(?:if|elif)\s+.+:\s*$|^(\s*)case\s+.+:\s*$/,
    );
    if (!branch || !labelPattern.test(rawLines[index])) continue;
    const indentation = (branch[1] ?? branch[2]).length;
    let end = index + 1;
    while (
      end < lines.length &&
      (!lines[end].trim() ||
        (lines[end].match(/^\s*/)?.[0].length ?? 0) > indentation)
    ) {
      end += 1;
    }
    return {
      code: lines.slice(index + 1, end).join("\n"),
      raw: rawLines.slice(index + 1, end).join("\n"),
    };
  }
  return null;
}

function returnedTarget(region, functions, seen = new Set()) {
  if (!region) return null;
  for (const match of region.code.matchAll(/\breturn\s+([^\n]+)/g)) {
    const expression = match[1].trim();
    if (/\bChainedTokenCredential\s*\(/.test(expression)) return region;
    const call = expression.match(/^(?:await\s+)?(\w+)\s*\(/);
    if (call && functions.has(call[1]) && !seen.has(call[1])) {
      seen.add(call[1]);
      return returnedTarget(functions.get(call[1]), functions, seen);
    }
    const variable = expression.match(/^(\w+)$/)?.[1];
    if (variable) {
      const assignment = new RegExp(
        `\\b${variable}\\s*(?::[^=\\n]+)?=\\s*([^\\n]+)`,
      ).exec(region.code);
      if (assignment?.[1].includes("ChainedTokenCredential(")) return region;
      const helper = assignment?.[1].match(/^(\w+)\s*\(/)?.[1];
      if (helper && functions.has(helper) && !seen.has(helper)) {
        seen.add(helper);
        return returnedTarget(functions.get(helper), functions, seen);
      }
    }
  }
  return null;
}

function constructorKind(expression, region, functions, seen = new Set()) {
  const constructors = [
    ["managed", "ManagedIdentityCredential"],
    ["workload", "WorkloadIdentityCredential"],
    ["environment", "EnvironmentCredential"],
    ["pipelines", "AzurePipelinesCredential"],
    ["cli", "AzureCliCredential"],
    ["powershell", "AzurePowerShellCredential"],
    ["vscode", "VisualStudioCodeCredential"],
    ["default", "DefaultAzureCredential"],
  ];
  for (const [kind, name] of constructors) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(expression)) return kind;
  }
  const helper = expression.match(/^(?:await\s+)?(\w+)\s*\(/)?.[1];
  if (helper && functions.has(helper) && !seen.has(helper)) {
    seen.add(helper);
    const fn = functions.get(helper);
    for (const [kind, name] of constructors) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(fn.code)) return kind;
    }
  }
  const variable = expression.replace(/^\*/, "").trim().match(/^(\w+)$/)?.[1];
  if (!variable) return "";
  const list = new RegExp(
    `\\b${variable}\\s*(?::[^=\\n]+)?=\\s*\\[([^\\]]*)\\]`,
  ).exec(region.code);
  if (list) {
    return splitArguments(list[1])
      .map((item) => constructorKind(item, region, functions, seen))
      .filter(Boolean);
  }
  const assignment = new RegExp(
    `\\b${variable}\\s*(?::[^=\\n]+)?=\\s*([^\\n]+)`,
  ).exec(region.code);
  if (assignment) {
    return constructorKind(assignment[1], region, functions, seen);
  }
  return "";
}

function chainItems(region, functions) {
  if (!region) return [];
  const pattern = /\b(?:\w+\.)*ChainedTokenCredential\s*\(/g;
  for (const match of region.code.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf("(");
    const closing = findClosingParenthesis(region.code, opening);
    if (closing < 0) continue;
    const argumentsList = splitArguments(
      region.code.slice(opening + 1, closing),
    );
    const items = [];
    for (const argument of argumentsList) {
      const kind = constructorKind(argument, region, functions);
      if (Array.isArray(kind)) items.push(...kind);
      else if (kind) items.push(kind);
    }
    for (const append of region.code.matchAll(/\b(\w+)\.append\s*\(([^)]+)\)/g)) {
      if (argumentsList.some((argument) =>
        argument.replace(/^\*/, "").trim() === append[1])) {
        const kind = constructorKind(append[2], region, functions);
        if (kind) items.push(kind);
      }
    }
    if (items.length > 0) return items;
  }
  return [];
}

function factoryCandidates(context) {
  const candidates = [];
  for (const fn of context.functions.values()) {
    const paths = {
      dev: returnedTarget(branchFor(fn, "dev"), context.functions),
      ci: returnedTarget(branchFor(fn, "ci"), context.functions),
      production: returnedTarget(
        branchFor(fn, "production"),
        context.functions,
      ),
    };
    if (Object.values(paths).every(Boolean)) {
      const asynchronous =
        fn.async ||
        /async/i.test(fn.name) ||
        Object.values(paths).some((path) => /\baio\s*\./.test(path.code));
      candidates.push({ fn, paths, asynchronous });
    }
  }
  return candidates;
}

function managedIdentitySupportsBoth(region, functions) {
  if (!region) return false;
  const sources = [];
  const visit = (candidate) => {
    if (!candidate || sources.includes(candidate)) return;
    sources.push(candidate);
    for (const match of candidate.code.matchAll(/\b(\w+)\s*\(/g)) {
      if (functions.has(match[1])) visit(functions.get(match[1]));
    }
  };
  visit(region);
  return sources.some((candidate) =>
    /\bManagedIdentityCredential\s*\([^)]*\bclient_id\s*=/.test(
      candidate.code,
    ) &&
    literalArgument(
      candidate.raw,
      candidate.code,
      /\b(?:os\.)?(?:getenv|environ\.get)\s*\(/g,
      ["AZURE_CLIENT_ID"],
    )
  );
}

function validFactory(candidate, context) {
  const dev = chainItems(candidate.paths.dev, context.functions);
  const ci = chainItems(candidate.paths.ci, context.functions);
  const production = chainItems(
    candidate.paths.production,
    context.functions,
  );
  return (
    dev.length >= 1 &&
    dev.includes("cli") &&
    ci.length >= 1 &&
    (ci.includes("environment") || ci.includes("pipelines")) &&
    !ci.includes("default") &&
    production[0] === "managed" &&
    production[1] === "workload" &&
    managedIdentitySupportsBoth(candidate.paths.production, context.functions)
  );
}

function detectEnvironment(context) {
  for (const fn of context.functions.values()) {
    const ciKeys = ["CI", "TF_BUILD", "BUILD_SOURCESDIRECTORY", "AZURE_PIPELINE_WORKSPACE"];
    const productionKeys = ["IDENTITY_ENDPOINT", "MSI_ENDPOINT"];
    const hasCiProbe = literalArgument(
      fn.raw,
      fn.code,
      /\b(?:os\.)?(?:getenv|environ\.get)\s*\(/g,
      ciKeys,
    ) || ciKeys.some((key) => fn.raw.includes(`"${key}"`) || fn.raw.includes(`'${key}'`));
    const hasProductionProbe = literalArgument(
      fn.raw,
      fn.code,
      /\b(?:os\.)?(?:getenv|environ\.get)\s*\(/g,
      productionKeys,
    );
    const structuralReturns = [...fn.code.matchAll(/\breturn\s+[^\n]+/g)]
      .map((match) => fn.raw.slice(match.index, match.index + match[0].length));
    const hasReturns = ["ci", "production", "dev"].every((label) =>
      structuralReturns.some((value) =>
        new RegExp(`["']${label}["']|\\.${label.toUpperCase()}\\b`).test(value)
      )
    );
    if (hasCiProbe && hasProductionProbe && hasReturns) return fn;
  }
  return null;
}

function tokenTester(context, asynchronous) {
  const scope = "https://management.azure.com/.default";
  return [...context.functions.values()].find((fn) => {
    if (asynchronous !== fn.async) return false;
    const parameter = fn.parameters[0];
    if (!parameter) return false;
    const tokenPattern = new RegExp(
      `${asynchronous ? "\\bawait\\s+" : "\\b"}${parameter}\\s*\\.\\s*get_token\\s*\\(`,
      "g",
    );
    const calls = [...fn.code.matchAll(tokenPattern)];
    const validCall = calls.some((match) => {
      const opening = match.index + match[0].lastIndexOf("(");
      const closing = findClosingParenthesis(fn.code, opening);
      if (closing < 0) return false;
      const codeArgs = fn.code.slice(opening + 1, closing);
      const rawArgs = fn.raw.slice(opening + 1, closing);
      const scopeVariable = codeArgs.match(/^\s*(\w+)/)?.[1];
      const scopeValue =
        rawArgs.includes(scope) ||
        (scopeVariable &&
          new RegExp(
            `\\b${scopeVariable}\\s*=\\s*["']${scope.replaceAll(".", "\\.")}["']`,
          ).test(context.raw));
      return scopeValue && /\benable_cae\s*=\s*True\b/.test(codeArgs);
    });
    return (
      validCall &&
      /\.expires_on\b/.test(fn.raw) &&
      /\bprint\s*\(/.test(fn.code)
    );
  });
}

function usefulAuthenticationHandler(fn) {
  if (!fn) return false;
  const lines = fn.code.split(/\r?\n/);
  const rawLines = fn.raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(
      /^(\s*)except\s+(?:\w+\.)*ClientAuthenticationError\s+as\s+(\w+)\s*:/,
    );
    if (!match) continue;
    const indentation = match[1].length;
    let end = index + 1;
    while (
      end < lines.length &&
      (!lines[end].trim() ||
        (lines[end].match(/^\s*/)?.[0].length ?? 0) > indentation)
    ) {
      end += 1;
    }
    const body = lines.slice(index + 1, end).join("\n");
    const rawBody = rawLines.slice(index + 1, end).join("\n");
    if (
      new RegExp(`\\b${match[2]}\\b`).test(rawBody) &&
      /\b(?:print|raise|error|exception|warning)\b/.test(body)
    ) {
      return true;
    }
  }
  return false;
}

function applicationFlow(context) {
  const detector = detectEnvironment(context);
  const factories = factoryCandidates(context);
  const syncFactory = factories.find(
    (candidate) => !candidate.asynchronous && validFactory(candidate, context),
  );
  const asyncFactory = factories.find(
    (candidate) => candidate.asynchronous && validFactory(candidate, context),
  );
  const syncTester = tokenTester(context, false);
  const asyncTester = tokenTester(context, true);
  if (!detector || !syncFactory || !asyncFactory || !syncTester || !asyncTester) {
    return false;
  }
  const code = context.code;
  const environment = new RegExp(
    `\\b(\\w+)\\s*=\\s*${detector.name}\\s*\\(\\s*\\)`,
  ).exec(code)?.[1];
  if (!environment) return false;
  const syncCredential = new RegExp(
    `\\b(\\w+)\\s*=\\s*${syncFactory.fn.name}\\s*\\(\\s*${environment}\\s*\\)`,
  ).exec(code)?.[1];
  const asyncCredential = new RegExp(
    `\\b(\\w+)\\s*=\\s*(?:await\\s+)?${asyncFactory.fn.name}\\s*\\(\\s*${environment}\\s*\\)`,
  ).exec(code)?.[1];
  return Boolean(
    syncCredential &&
    asyncCredential &&
    new RegExp(`\\b${syncTester.name}\\s*\\(\\s*${syncCredential}\\b`).test(code) &&
    new RegExp(
      `\\bawait\\s+${asyncTester.name}\\s*\\(\\s*${asyncCredential}\\b`,
    ).test(code) &&
    new RegExp(`\\bprint\\s*\\([^\\n]*\\{[^}]*\\b${environment}\\b`).test(
      context.raw,
    ) &&
    /\bprint\s*\([^\n]*strategy/i.test(context.raw)
  );
}

function createContext(workspace) {
  const raw = workspace.python ?? "";
  const initiallyMasked = maskPython(raw);
  const code = maskUnreachable(raw, initiallyMasked);
  return {
    raw,
    code,
    functions: parseFunctions(raw, code),
  };
}

function hasSource(workspace) {
  return typeof workspace.python === "string" && workspace.python.trim() !== "";
}

const rules = {
  "prompt/identity-package": (workspace) =>
    hasSource(workspace) &&
    workspace.dependencies
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, ""))
      .some((line) => /^\s*azure-identity(?:\s*[=<>!~]=?.*)?\s*$/i.test(line)),
  "prompt/environment-detection": (workspace) =>
    hasSource(workspace) && Boolean(detectEnvironment(createContext(workspace))),
  "prompt/sync-credential-chains": (workspace) => {
    if (!hasSource(workspace)) return false;
    const context = createContext(workspace);
    return factoryCandidates(context).some(
      (candidate) => !candidate.asynchronous && validFactory(candidate, context),
    );
  },
  "prompt/async-credential-chains": (workspace) => {
    if (!hasSource(workspace)) return false;
    const context = createContext(workspace);
    const hasAsyncIdentity =
      /(?:from\s+azure\.identity\.aio\s+import|import\s+azure\.identity\.aio|from\s+azure\.identity\s+import[\s\S]{0,300}\baio\b)/.test(
        context.code,
      );
    return hasAsyncIdentity && factoryCandidates(context).some(
      (candidate) => candidate.asynchronous && validFactory(candidate, context),
    );
  },
  "prompt/cae-token-tests": (workspace) => {
    if (!hasSource(workspace)) return false;
    const context = createContext(workspace);
    return Boolean(tokenTester(context, false) && tokenTester(context, true));
  },
  "prompt/auth-failure-details": (workspace) => {
    if (!hasSource(workspace)) return false;
    const context = createContext(workspace);
    return (
      usefulAuthenticationHandler(tokenTester(context, false)) &&
      usefulAuthenticationHandler(tokenTester(context, true))
    );
  },
  "prompt/application-flow": (workspace) =>
    hasSource(workspace) && applicationFlow(createContext(workspace)),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  return rule(workspace);
}

export function ruleNames() {
  return Object.keys(rules);
}
