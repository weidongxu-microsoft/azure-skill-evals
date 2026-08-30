function sanitizeJava(source) {
  const result = [...source];
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (character === "\n") state = "code";
      else result[index] = " ";
    } else if (state === "block") {
      if (character === "*" && next === "/") {
        result[index] = result[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (character !== "\n") result[index] = " ";
    } else if (state === "string" || state === "character") {
      if (character === "\\") {
        result[index] = " ";
        index += 1;
        if (result[index] !== "\n") result[index] = " ";
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        result[index] = " ";
        state = "code";
      } else if (character !== "\n") result[index] = " ";
    } else if (character === "/" && next === "/") {
      result[index] = result[index + 1] = " ";
      index += 1;
      state = "line";
    } else if (character === "/" && next === "*") {
      result[index] = result[index + 1] = " ";
      index += 1;
      state = "block";
    } else if (character === '"' || character === "'") {
      result[index] = " ";
      state = character === '"' ? "string" : "character";
    }
  }
  return result.join("");
}

function matchingBrace(source, opening) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function matchingParenthesis(source, opening) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function maskUnreachable(code) {
  const result = [...code];
  for (const match of code.matchAll(/\bif\s*\(\s*false\s*\)\s*\{/g)) {
    const opening = code.indexOf("{", match.index);
    const closing = matchingBrace(code, opening);
    if (closing < 0) continue;
    for (let index = match.index; index <= closing; index += 1) {
      if (result[index] !== "\n") result[index] = " ";
    }
  }
  return result.join("");
}

function parseMethods(raw, code) {
  const methods = new Map();
  const pattern =
    /(?:^|[;{}])\s*(?:public|protected|private|static|final|synchronized|\s)+[\w<>, ?.\[\]]+\s+(\w+)\s*\(([^)]*)\)\s*\{/g;
  for (const match of code.matchAll(pattern)) {
    const opening = code.indexOf("{", match.index + match[0].lastIndexOf("{"));
    const closing = matchingBrace(code, opening);
    if (closing < 0) continue;
    const parameters = match[2]
      .split(",")
      .map((value) => value.trim().match(/(\w+)\s*$/)?.[1])
      .filter(Boolean);
    methods.set(match[1], {
      name: match[1],
      parameters,
      code: code.slice(opening + 1, closing),
      raw: raw.slice(opening + 1, closing),
    });
  }
  return methods;
}

function pathRegion(dispatcher, label, methods) {
  const switchPattern = new RegExp(
    `\\bcase\\s+${label}\\s*->\\s*(?:\\{\\s*)?(?:return\\s+)?(\\w+)\\s*\\(`,
  );
  const switchMatch = switchPattern.exec(dispatcher.code);
  if (switchMatch && methods.has(switchMatch[1])) {
    return methods.get(switchMatch[1]);
  }
  const ifPattern = new RegExp(
    `\\bif\\s*\\([^)]*\\b${label}\\b[^)]*\\)\\s*\\{([\\s\\S]*?)\\}`,
  );
  const ifMatch = ifPattern.exec(dispatcher.code);
  const helper = ifMatch?.[1].match(/\breturn\s+(\w+)\s*\(/)?.[1];
  return helper && methods.has(helper) ? methods.get(helper) : null;
}

function dispatcher(context) {
  for (const method of context.methods.values()) {
    const paths = {
      DEV: pathRegion(method, "DEV", context.methods),
      CI: pathRegion(method, "CI", context.methods),
      PRODUCTION: pathRegion(method, "PRODUCTION", context.methods),
    };
    if (Object.values(paths).every(Boolean)) return { method, paths };
  }
  return null;
}

function constructorKind(expression, region, methods, seen = new Set()) {
  const constructors = [
    ["managed", "ManagedIdentityCredentialBuilder"],
    ["workload", "WorkloadIdentityCredentialBuilder"],
    ["environment", "EnvironmentCredentialBuilder"],
    ["pipelines", "AzurePipelinesCredentialBuilder"],
    ["cli", "AzureCliCredentialBuilder"],
    ["powershell", "AzurePowerShellCredentialBuilder"],
    ["default", "DefaultAzureCredentialBuilder"],
  ];
  for (const [kind, name] of constructors) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(expression)) return kind;
  }
  const helper = expression.match(/\b(\w+)\s*\([^)]*\)\s*$/)?.[1];
  if (helper && methods.has(helper) && !seen.has(helper)) {
    seen.add(helper);
    const method = methods.get(helper);
    for (const [kind, name] of constructors) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(method.code)) return kind;
    }
  }
  const variable = expression.trim().match(/^(\w+)$/)?.[1];
  if (!variable) return "";
  const assignment = new RegExp(
    `\\b${variable}\\s*=\\s*([^;]+)`,
  ).exec(region.code);
  return assignment
    ? constructorKind(assignment[1], region, methods, seen)
    : "";
}

function chainItems(region, methods) {
  if (!region) return [];
  const builderConnected =
    /\breturn\s+new\s+(?:[\w.]+\.)?ChainedTokenCredentialBuilder\s*\(/.test(
      region.code,
    ) ||
    (() => {
      const variable = /\b(\w+)\s*=\s*new\s+(?:[\w.]+\.)?ChainedTokenCredentialBuilder\s*\(/.exec(
        region.code,
      )?.[1];
      return variable
        ? new RegExp(`\\breturn\\s+${variable}\\s*\\.\\s*build\\s*\\(`).test(
            region.code,
          )
        : false;
    })();
  if (!builderConnected) return [];
  const items = [];
  for (const match of region.code.matchAll(/\.addLast\s*\(/g)) {
    const opening = match.index + match[0].lastIndexOf("(");
    const closing = matchingParenthesis(region.code, opening);
    if (closing < 0) continue;
    const kind = constructorKind(
      region.code.slice(opening + 1, closing),
      region,
      methods,
    );
    if (kind) items.push(kind);
  }
  return items;
}

function reachableMethods(region, methods) {
  const found = [];
  const visit = (method) => {
    if (!method || found.includes(method)) return;
    found.push(method);
    for (const match of method.code.matchAll(/\b(\w+)\s*\(/g)) {
      if (methods.has(match[1])) visit(methods.get(match[1]));
    }
  };
  visit(region);
  return found;
}

function supportsManagedIdentityModes(region, methods) {
  return reachableMethods(region, methods).some((method) =>
    /\bManagedIdentityCredentialBuilder\s*\(/.test(method.code) &&
    /\.clientId\s*\(/.test(method.code) &&
    /\bSystem\s*\.\s*getenv\s*\(/.test(method.code) &&
    /["']AZURE_CLIENT_ID["']/.test(method.raw)
  );
}

function environmentDetector(context) {
  const ciKeys = ["CI", "TF_BUILD", "BUILD_SOURCESDIRECTORY", "AZURE_PIPELINE_WORKSPACE"];
  const productionKeys = ["IDENTITY_ENDPOINT", "MSI_ENDPOINT"];
  for (const method of context.methods.values()) {
    const hasGetenv = reachableMethods(method, context.methods).some(
      (candidate) => /\bSystem\s*\.\s*getenv\s*\(/.test(candidate.code),
    );
    const hasCi = ciKeys.some((key) =>
      method.raw.includes(`"${key}"`) || context.raw.includes(`present("${key}")`)
    );
    const hasProduction = productionKeys.some((key) =>
      method.raw.includes(`"${key}"`) || context.raw.includes(`present("${key}")`)
    );
    const hasReturns = ["CI", "PRODUCTION", "DEV"].every((value) =>
      new RegExp(`\\breturn\\s+(?:\\w+\\.)?${value}\\b`).test(method.code)
    );
    if (hasGetenv && hasCi && hasProduction && hasReturns) return method;
  }
  return null;
}

function requestContextFor(method, context) {
  const getToken = /\.getToken\s*\(([^)]*)\)/.exec(method.code);
  if (!getToken) return null;
  const expression = getToken[1].trim();
  const helper = expression.match(/^(\w+)\s*\(/)?.[1];
  if (helper && context.methods.has(helper)) return context.methods.get(helper);
  const variable = expression.match(/^(\w+)$/)?.[1];
  if (!variable) return method;
  return new RegExp(
    `\\b${variable}\\s*=\\s*new\\s+(?:[\\w.]+\\.)?TokenRequestContext\\s*\\(`,
  ).test(method.code)
    ? method
    : null;
}

function tokenTesters(context) {
  const testers = { sync: null, async: null };
  for (const method of context.methods.values()) {
    const credential = method.parameters[0];
    if (
      !credential ||
      !new RegExp(`\\b${credential}\\s*\\.\\s*getToken\\s*\\(`).test(
        method.code,
      )
    ) {
      continue;
    }
    const request = requestContextFor(method, context);
    if (!request) continue;
    const hasScope =
      request.raw.includes('"https://management.azure.com/.default"') ||
      (/\b[A-Z_]+\b/.test(request.code) &&
        context.raw.includes('"https://management.azure.com/.default"'));
    const hasCae = /\.setCaeEnabled\s*\(\s*true\s*\)/.test(request.code);
    const hasExpiry =
      /\.getExpiresAt\s*\(\s*\)/.test(method.code) &&
      /\bSystem\s*\.\s*(?:out|err)\s*\.\s*(?:print|printf|format)/.test(
        method.code,
      );
    if (!hasScope || !hasCae || !hasExpiry) continue;
    if (/\.block(?:Optional)?\s*\(/.test(method.code)) testers.sync = method;
    else if (
      /\bMono\s*</.test(context.code) ||
      /\.doOnNext\s*\(/.test(method.code)
    ) {
      testers.async = method;
    }
  }
  return testers;
}

function usefulAuthFailure(method, asynchronous) {
  if (!method) return false;
  if (asynchronous) {
    const match = /\.doOnError\s*\(\s*(?:[\w.]+\.)?ClientAuthenticationException\s*\.class\s*,\s*(\w+)\s*->([\s\S]*)/.exec(
      method.code,
    );
    return Boolean(
      match &&
      new RegExp(`\\b${match[1]}\\s*\\.\\s*getMessage\\s*\\(`).test(match[2]) &&
      /\bSystem\s*\.\s*err\s*\./.test(match[2])
    );
  }
  const match = /\bcatch\s*\(\s*(?:[\w.]+\.)?ClientAuthenticationException\s+(\w+)\s*\)\s*\{([\s\S]*?)\}/.exec(
    method.code,
  );
  return Boolean(
    match &&
    new RegExp(`\\b${match[1]}\\s*\\.\\s*getMessage\\s*\\(`).test(match[2]) &&
    /\bSystem\s*\.\s*err\s*\./.test(match[2])
  );
}

function applicationFlow(context) {
  const detector = environmentDetector(context);
  const factory = dispatcher(context);
  const testers = tokenTesters(context);
  if (!detector || !factory || !testers.sync || !testers.async) return false;
  for (const method of context.methods.values()) {
    const environment = new RegExp(
      `\\b(\\w+)\\s*=\\s*(?:\\w+\\.)?${detector.name}\\s*\\(\\s*\\)`,
    ).exec(method.code)?.[1];
    if (!environment) continue;
    const credential = new RegExp(
      `\\b(\\w+)\\s*=\\s*(?:\\w+\\.)?${factory.method.name}\\s*\\(\\s*${environment}\\s*\\)`,
    ).exec(method.code)?.[1];
    if (!credential) continue;
    const syncCall = new RegExp(
      `\\b${testers.sync.name}\\s*\\(\\s*${credential}\\s*\\)`,
    ).test(method.code);
    const asyncCall = new RegExp(
      `\\b${testers.async.name}\\s*\\(\\s*${credential}\\s*\\)\\s*\\.\\s*block\\s*\\(`,
    ).test(method.code);
    const output = /\bSystem\s*\.\s*out\s*\.\s*(?:print|printf|format)/.test(
      method.code,
    ) && /strategy/i.test(method.raw) && method.raw.includes(environment);
    if (syncCall && asyncCall && output) return true;
  }
  return false;
}

function createContext(workspace) {
  const raw = workspace.source ?? "";
  const code = maskUnreachable(sanitizeJava(raw));
  return { raw, code, methods: parseMethods(raw, code) };
}

function hasSource(workspace) {
  return Array.isArray(workspace.sourceFiles)
    ? workspace.sourceFiles.length > 0
    : Boolean(workspace.source?.trim());
}

function activeIdentityDependency(build) {
  const xml = build.replace(/<!--[\s\S]*?-->/g, " ");
  return /<dependency>\s*<groupId>com\.azure<\/groupId>\s*<artifactId>azure-identity<\/artifactId>\s*<version>[^<]+<\/version>[\s\S]*?<\/dependency>/.test(
    xml,
  );
}

const rules = {
  "prompt/identity-package": (workspace) =>
    hasSource(workspace) && activeIdentityDependency(workspace.build ?? ""),
  "prompt/environment-detection": (workspace) =>
    hasSource(workspace) &&
    Boolean(environmentDetector(createContext(workspace))),
  "prompt/dev-credential-chain": (workspace) => {
    if (!hasSource(workspace)) return false;
    const context = createContext(workspace);
    const path = dispatcher(context)?.paths.DEV;
    const items = chainItems(path, context.methods);
    return items.length > 0 && items.includes("cli");
  },
  "prompt/ci-credential-chain": (workspace) => {
    if (!hasSource(workspace)) return false;
    const context = createContext(workspace);
    const path = dispatcher(context)?.paths.CI;
    const items = chainItems(path, context.methods);
    return (
      items.length > 0 &&
      (items.includes("environment") || items.includes("pipelines")) &&
      !items.includes("default")
    );
  },
  "prompt/production-credential-chain": (workspace) => {
    if (!hasSource(workspace)) return false;
    const context = createContext(workspace);
    const path = dispatcher(context)?.paths.PRODUCTION;
    const items = chainItems(path, context.methods);
    return (
      items[0] === "managed" &&
      items[1] === "workload" &&
      supportsManagedIdentityModes(path, context.methods)
    );
  },
  "prompt/cae-token-tests": (workspace) => {
    if (!hasSource(workspace)) return false;
    const testers = tokenTesters(createContext(workspace));
    return Boolean(testers.sync && testers.async);
  },
  "prompt/auth-failure-details": (workspace) => {
    if (!hasSource(workspace)) return false;
    const testers = tokenTesters(createContext(workspace));
    return (
      usefulAuthFailure(testers.sync, false) &&
      usefulAuthFailure(testers.async, true)
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
