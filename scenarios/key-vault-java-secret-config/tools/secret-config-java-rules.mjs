const PINS = new Map([
  ["azure-identity", "1.18.5"],
  ["azure-security-keyvault-secrets", "4.11.2"],
]);

function mask(source, preserveStrings = false) {
  let output = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (character === "\n") {
        output += "\n";
        state = "code";
      } else output += " ";
    } else if (state === "block") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else output += character === "\n" ? "\n" : " ";
    } else if (state === "string" || state === "char") {
      if (character === "\\") {
        output += preserveStrings ? `${character}${next ?? ""}` : "  ";
        index += 1;
      } else if ((state === "string" && character === '"') ||
          (state === "char" && character === "'")) {
        output += preserveStrings ? character : " ";
        state = "code";
      } else output += preserveStrings ? character : character === "\n" ? "\n" : " ";
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line";
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block";
    } else if (character === '"') {
      output += preserveStrings ? character : " ";
      state = "string";
    } else if (character === "'") {
      output += preserveStrings ? character : " ";
      state = "char";
    } else output += character;
  }
  return output;
}

function closeBrace(code, opening) {
  let depth = 0;
  for (let index = opening; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function closeParen(code, opening) {
  let depth = 0;
  for (let index = opening; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1;
    else if (code[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function methods(source) {
  const code = mask(source, true);
  const found = [];
  const pattern = /(?:^|[;{}])\s*(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:<[^>{}]+>\s*)?(?:[\w$.[\]<>?,]+\s+)?([A-Za-z_$][\w$]*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^{]+)?\{/gm;
  for (const match of code.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = closeBrace(code, opening);
    if (closing < 0) continue;
    const prefix = code.slice(Math.max(0, match.index - 300), match.index);
    const classMatches = [...prefix.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)];
    found.push({
      name: match[1],
      className: classMatches.at(-1)?.[1] ?? "",
      body: source.slice(opening + 1, closing),
      code: code.slice(opening + 1, closing),
      start: opening + 1,
      isMain: match[1] === "main" && /\bstatic\b/.test(match[0]),
    });
  }
  return found;
}

function activeBody(body) {
  const code = mask(body, true);
  let output = "";
  let depth = 0;
  for (let index = 0; index < code.length;) {
    const falseMatch = /^if\s*\(\s*(?:false|Boolean\.FALSE)\s*\)\s*\{/.exec(code.slice(index));
    if (falseMatch) {
      const opening = index + falseMatch[0].lastIndexOf("{");
      const closing = closeBrace(code, opening);
      output += " ".repeat(closing - index + 1);
      index = closing + 1;
      continue;
    }
    const returnMatch = /^return\b[^;]*;/.exec(code.slice(index));
    if (returnMatch && depth === 0) {
      output += code.slice(index, index + returnMatch[0].length);
      break;
    }
    output += code[index];
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") depth -= 1;
    index += 1;
  }
  return output;
}

function reachableMethods(source) {
  const all = methods(source);
  const byName = new Map();
  for (const method of all) {
    if (!byName.has(method.name)) byName.set(method.name, []);
    byName.get(method.name).push(method);
  }
  const queue = all.filter((method) => method.isMain);
  const reachable = new Set();
  while (queue.length > 0) {
    const method = queue.pop();
    if (reachable.has(method)) continue;
    reachable.add(method);
    const body = activeBody(method.body);
    for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      for (const target of byName.get(match[1]) ?? []) queue.push(target);
    }
  }
  return [...reachable];
}

function imports(source) {
  return new Set([...mask(source, true).matchAll(/\bimport\s+([\w.]+)\s*;/g)].map((item) => item[1]));
}

function officialTypes(source) {
  const required = [
    "com.azure.identity.DefaultAzureCredentialBuilder",
    "com.azure.security.keyvault.secrets.SecretClient",
    "com.azure.security.keyvault.secrets.SecretAsyncClient",
    "com.azure.security.keyvault.secrets.SecretClientBuilder",
    "com.azure.core.exception.ResourceNotFoundException",
  ];
  const imported = imports(source);
  const local = new Set([...mask(source).matchAll(/\b(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)/g)].map((item) => item[1]));
  return required.every((type) => imported.has(type) && !local.has(type.split(".").at(-1)));
}

function pinnedDependencies(build) {
  const xml = build.replace(/<!--[\s\S]*?-->/g, " ");
  if (!/^\s*<project\b[\s\S]*<\/project>\s*$/i.test(xml)) return false;
  if (/<packaging>\s*pom\s*<\/packaging>/i.test(xml)) return false;
  const runtime = xml
    .replace(/<dependencyManagement\b[\s\S]*?<\/dependencyManagement>/gi, " ")
    .replace(/<build\b[\s\S]*?<\/build>/gi, " ")
    .replace(/<profiles\b[\s\S]*?<\/profiles>/gi, " ");
  const dependencies = new Map();
  for (const match of runtime.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)) {
    const value = match[1];
    const group = /<groupId>\s*([^<]+)\s*<\/groupId>/i.exec(value)?.[1];
    const artifact = /<artifactId>\s*([^<]+)\s*<\/artifactId>/i.exec(value)?.[1];
    const version = /<version>\s*([^<]+)\s*<\/version>/i.exec(value)?.[1];
    const scope = /<scope>\s*([^<]+)\s*<\/scope>/i.exec(value)?.[1] ?? "compile";
    if (group === "com.azure" && ["compile", "runtime"].includes(scope)) {
      dependencies.set(artifact, version);
    }
  }
  return [...PINS].every(([artifact, version]) => dependencies.get(artifact) === version);
}

function sourceFacts(workspace) {
  const source = workspace.source ?? "";
  const reachable = reachableMethods(source);
  return {
    source,
    code: reachable.map((method) => activeBody(method.body)).join("\n"),
    methods: reachable,
    types: officialTypes(source),
  };
}

function classBody(source, name) {
  if (!name) return "";
  const code = mask(source, true);
  const match = new RegExp(`\\bclass\\s+${name}\\b[^\\{]*\\{`).exec(code);
  if (!match) return "";
  const opening = match.index + match[0].lastIndexOf("{");
  const end = closeBrace(code, opening);
  return end < 0 ? "" : source.slice(opening + 1, end);
}

function configuration(facts) {
  if (!facts.types) return false;
  const code = facts.code;
  return (
    /\bSystem\s*\.\s*getenv\s*\(/.test(code) &&
    /\bnew\s+DefaultAzureCredentialBuilder\s*\(\s*\)\s*\.\s*build\s*\(\s*\)/.test(code) &&
    /\bnew\s+SecretClientBuilder\s*\(/.test(code) &&
    /\.vaultUrl\s*\(/.test(code) &&
    /\.credential\s*\(/.test(code) &&
    /\.buildClient\s*\(/.test(code) &&
    /\.buildAsyncClient\s*\(/.test(code)
  );
}

function provider(facts, asynchronous) {
  if (!facts.types) return false;
  return facts.methods.some((method) => {
    const code = activeBody(method.body);
    const owner = classBody(facts.source, method.className);
    const typedClient = asynchronous
      ? /\bSecretAsyncClient\s+[A-Za-z_$][\w$]*\b/.test(owner)
      : /\bSecretClient\s+[A-Za-z_$][\w$]*\b/.test(owner);
    const client = asynchronous
      ? /\.onErrorResume\s*\(/.test(code)
      : /\bcatch\s*\(/.test(code);
    const version = /\.getSecret\s*\(\s*[^,()]+\s*,\s*[^,)]+\)/.test(code);
    const expiry = /\.getProperties\s*\(\s*\)\s*\.\s*getExpiresOn\s*\(\s*\)/.test(code);
    const fallback = asynchronous
      ? /\.onErrorResume\s*\(\s*ResourceNotFoundException\s*\.\s*class\b/.test(code) && /\bMono\s*\.\s*just\s*\(/.test(code)
      : /\bcatch\s*\(\s*ResourceNotFoundException\b/.test(code) && /\breturn\b[\s\S]*\bdefault\w*/i.test(code);
    return typedClient && client && version && expiry && fallback;
  });
}

function cache(facts) {
  const code = facts.code;
  const names = facts.methods.map((method) => method.name.toLowerCase());
  return (
    /\b(?:ConcurrentHashMap|HashMap|Map)\b/.test(facts.source) &&
    /\.(?:put|computeIfAbsent)\s*\(/.test(code) &&
    (/\bfor\s*\(/.test(code) || /\bFlux\s*\.\s*fromIterable\s*\(/.test(code)) &&
    /\bDuration\b/.test(facts.source) &&
    /\bOffsetDateTime\s*\.\s*now\s*\(\s*\)\s*\.\s*plus\s*\(/.test(code) &&
    /\.getExpiresOn\s*\(\s*\)/.test(code) &&
    names.some((name) => /load|warm/.test(name)) &&
    names.some((name) => /refresh/.test(name))
  );
}

function branchContexts(body, positions) {
  const code = mask(body, true);
  const contexts = positions.map(() => new Map());
  let branch = 0;
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const conditionOpen = match.index + match[0].lastIndexOf("(");
    const conditionClose = closeParen(code, conditionOpen);
    const trueOpen = code.indexOf("{", conditionClose);
    if (trueOpen < 0) continue;
    const trueClose = closeBrace(code, trueOpen);
    if (trueClose < 0) continue;
    branch += 1;
    positions.forEach((position, index) => {
      if (trueOpen < position && position < trueClose) contexts[index].set(branch, true);
    });
    const tail = code.slice(trueClose + 1);
    const elseMatch = /^\s*else\s*\{/.exec(tail);
    if (elseMatch) {
      const falseOpen = trueClose + 1 + elseMatch[0].lastIndexOf("{");
      const falseClose = closeBrace(code, falseOpen);
      positions.forEach((position, index) => {
        if (falseOpen < position && position < falseClose) contexts[index].set(branch, false);
      });
    }
  }
  return contexts;
}

function compatible(contexts) {
  for (let left = 0; left < contexts.length; left += 1) {
    for (let right = left + 1; right < contexts.length; right += 1) {
      for (const [branch, value] of contexts[left]) {
        if (contexts[right].has(branch) && contexts[right].get(branch) !== value) return false;
      }
    }
  }
  return true;
}

function orderedRotation(facts, asynchronous) {
  return facts.methods.some((method) => {
    const code = activeBody(method.body);
    const beginMatch = /([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.]*)\s*\.\s*beginDeleteSecret\s*\(\s*([^)]+?)\s*\)/.exec(code);
    if (!beginMatch) return false;
    const normalize = (value) => value.replace(/\s+/g, "");
    const poller = beginMatch[1];
    const client = normalize(beginMatch[2]);
    const name = normalize(beginMatch[3]);
    const waitPattern = asynchronous
      ? new RegExp(`\\b${poller}\\s*\\.\\s*(?:last|blockLast)\\s*\\(`)
      : new RegExp(`\\b${poller}\\s*\\.\\s*waitForCompletion\\s*\\(`);
    const waitMatch = waitPattern.exec(code.slice(beginMatch.index + beginMatch[0].length));
    if (!waitMatch) return false;
    const wait = beginMatch.index + beginMatch[0].length + waitMatch.index;
    const purgePattern = /([A-Za-z_$][\w$.]*)\s*\.\s*purgeDeletedSecret\s*\(\s*([^)]+?)\s*\)/g;
    purgePattern.lastIndex = wait;
    const purgeMatch = purgePattern.exec(code);
    if (!purgeMatch || normalize(purgeMatch[1]) !== client || normalize(purgeMatch[2]) !== name) return false;
    const setPattern = /([A-Za-z_$][\w$.]*)\s*\.\s*setSecret\s*\(\s*([^;]+?)\s*\)/g;
    setPattern.lastIndex = purgeMatch.index + purgeMatch[0].length;
    const setMatch = setPattern.exec(code);
    if (!setMatch || normalize(setMatch[1]) !== client || !normalize(setMatch[2]).includes(name)) return false;
    if (!compatible(branchContexts(code, [
      beginMatch.index,
      wait,
      purgeMatch.index,
      setMatch.index,
    ]))) return false;
    if (!/\.setExpiresOn\s*\(/.test(facts.code)) return false;
    const classText = facts.source.slice(Math.max(0, method.start - 1200), method.start);
    return asynchronous
      ? /\b(?:SecretAsyncClient|PollerFlux|Mono)\b/.test(classText + code)
      : /\b(?:SecretClient|SyncPoller)\b/.test(classText + code);
  });
}

function connectedDemo(facts, state) {
  if (!Object.values(state).every(Boolean)) return false;
  const main = facts.methods.find((method) => method.isMain);
  if (!main) return false;
  const code = activeBody(main.body);
  const calls = [...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((item) => ({ name: item[1], index: item.index }));
  const syncMethods = facts.methods.filter((method) =>
    /\.waitForCompletion\s*\(/.test(activeBody(method.body)) ||
    /\bSyncCache\b/.test(activeBody(method.body))
  );
  const asyncMethods = facts.methods.filter((method) =>
    /\.(?:block|blockLast)\s*\(/.test(activeBody(method.body)) ||
    /\bAsyncCache\b/.test(activeBody(method.body))
  );
  const syncCall = calls.find((call) => syncMethods.some((method) => method.name === call.name));
  const asyncCall = calls.find((call) => asyncMethods.some((method) => method.name === call.name));
  return Boolean(syncCall && asyncCall && syncCall.index < asyncCall.index);
}

const rules = {
  "prompt/sdk-dependencies": (workspace) => pinnedDependencies(workspace.build ?? ""),
  "prompt/managed-identity-configuration": (_, facts) => configuration(facts),
  "prompt/sync-provider": (_, facts) => provider(facts, false),
  "prompt/async-provider": (_, facts) => provider(facts, true),
  "prompt/expiry-aware-cache": (_, facts) => cache(facts),
  "prompt/sync-safe-rotation": (_, facts) => orderedRotation(facts, false),
  "prompt/async-safe-rotation": (_, facts) => orderedRotation(facts, true),
  "prompt/connected-demo": (_, facts) => connectedDemo(facts, {
    configuration: configuration(facts),
    syncProvider: provider(facts, false),
    asyncProvider: provider(facts, true),
    cache: cache(facts),
    syncRotation: orderedRotation(facts, false),
    asyncRotation: orderedRotation(facts, true),
  }),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  if (!(workspace.sourceFiles?.length > 0 || workspace.source?.trim())) return false;
  return rule(workspace, sourceFacts(workspace));
}

export function ruleNames() {
  return Object.keys(rules);
}
