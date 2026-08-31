const RULES = [
  "prompt/source-manifest",
  "prompt/todo-model",
  "prompt/secure-container-factory",
  "prompt/sync-crud-request-charges",
  "prompt/async-crud-request-charges",
  "prompt/etag-conflict-handling",
  "prompt/sync-parameterized-pagination",
  "prompt/async-parameterized-pagination",
  "prompt/connected-sync-then-async-demo",
];
const SDK_TYPES = [
  "CosmosAsyncClient",
  "CosmosAsyncContainer",
  "CosmosClient",
  "CosmosClientBuilder",
  "CosmosContainer",
  "CosmosContainerProperties",
  "CosmosException",
  "CosmosItemRequestOptions",
  "CosmosItemResponse",
  "CosmosPagedFlux",
  "CosmosPagedIterable",
  "CosmosQueryRequestOptions",
  "ExcludedPath",
  "FeedResponse",
  "IndexingPolicy",
  "ManagedIdentityCredentialBuilder",
  "PartitionKey",
  "SqlParameter",
  "SqlQuerySpec",
];
const POINT_OPERATIONS = [
  "createItem",
  "readItem",
  "replaceItem",
  "deleteItem",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskJava(source, preserveStrings = false) {
  let result = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        result += "\n";
        state = "code";
      } else {
        result += " ";
      }
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
    } else if (state === "text-block") {
      if (source.startsWith('"""', index)) {
        result += preserveStrings ? '"""' : "   ";
        index += 2;
        state = "code";
      } else {
        result += preserveStrings
          ? character
          : character === "\n"
            ? "\n"
            : " ";
      }
    } else if (state === "string" || state === "character") {
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
    } else if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else if (source.startsWith('"""', index)) {
      result += preserveStrings ? '"""' : "   ";
      index += 2;
      state = "text-block";
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

function matchingIndex(text, start, opening = "(", closing = ")") {
  if (start < 0 || text[start] !== opening) return -1;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(text) {
  const result = [];
  const depth = { "(": 0, "[": 0, "{": 0, "<": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character in depth) {
      if (
        character !== "<" ||
        (/[\w$?.\]]/.test(text[index - 1] ?? "") &&
          /[\w$?@]/.test(text[index + 1] ?? ""))
      ) {
        depth[character] += 1;
      }
    } else if (character in closing) {
      depth[closing[character]] -= 1;
    } else if (character === ">" && depth["<"] > 0) {
      depth["<"] -= 1;
    } else if (
      character === "," &&
      Object.values(depth).every((value) => value === 0)
    ) {
      result.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = text.slice(start).trim();
  if (final || result.length > 0) result.push(final);
  return result;
}

function parameterCount(parameters) {
  return parameters.trim() ? splitTopLevel(parameters).length : 0;
}

function removeDeadCode(source) {
  const characters = [...source];
  const mask = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  };
  for (const match of source.matchAll(/\bif\s*\(\s*false\s*\)\s*\{/g)) {
    const open = source.indexOf("{", match.index);
    const close = matchingIndex(source, open, "{", "}");
    if (close >= 0) mask(match.index, close + 1);
  }
  let braces = 0;
  let parentheses = 0;
  let statementStart = 0;
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] === "{") braces += 1;
    else if (characters[index] === "}") braces -= 1;
    else if (characters[index] === "(") parentheses += 1;
    else if (characters[index] === ")") parentheses -= 1;
    else if (characters[index] === ";" && braces === 0 && parentheses === 0) {
      if (/^\s*(?:return|throw)\b/.test(
        characters.slice(statementStart, index).join(""),
      )) {
        mask(index + 1, characters.length);
        break;
      }
      statementStart = index + 1;
    }
  }
  return characters.join("");
}

function parseMethods(code, literal) {
  const typeRanges = [];
  for (const match of code.matchAll(
    /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)[^{]*\{/g,
  )) {
    const open = code.indexOf("{", match.index);
    const close = matchingIndex(code, open, "{", "}");
    if (close >= 0) {
      typeRanges.push({
        name: match[1],
        start: match.index,
        end: close + 1,
      });
    }
  }
  const methods = [];
  const pattern =
    /(?:^|[;{}])\s*((?:(?:public|protected|private|static|final|synchronized|native|abstract|strictfp)\s+)*(?:<[^;{}()]+>\s*)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*(?:\s*<[^;{}()]+>)?(?:\s*\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^{}]+)?\{/gm;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    if (["if", "for", "while", "switch", "catch", "try", "new"].includes(match[2])) {
      continue;
    }
    const open = code.indexOf("{", match.index + match[0].lastIndexOf("{"));
    const close = matchingIndex(code, open, "{", "}");
    if (close < 0) continue;
    const owner = typeRanges
      .filter((range) => range.start < match.index && range.end > close)
      .sort((left, right) => left.end - left.start - (right.end - right.start))[0];
    methods.push({
      id: methods.length,
      modifiersAndType: match[1],
      name: match[2],
      arity: parameterCount(match[3]),
      parameters: match[3],
      code: removeDeadCode(code.slice(open + 1, close)),
      literal: removeDeadCode(literal.slice(open + 1, close)),
      owner: owner?.name ?? "",
    });
    pattern.lastIndex = close + 1;
  }
  return methods;
}

function isMain(method) {
  return (
    method.name === "main" &&
    /\bpublic\b/.test(method.modifiersAndType) &&
    /\bstatic\b/.test(method.modifiersAndType) &&
    /\bvoid\s*$/.test(method.modifiersAndType) &&
    /String(?:\s*\[\s*\]|\s*\.\.\.)\s+\w+/.test(method.parameters)
  );
}

function callSites(method) {
  const result = [];
  const pattern = /(?:(\b[A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of method.code.matchAll(pattern)) {
    const before = method.code.slice(Math.max(0, match.index - 16), match.index);
    if (/\b(?:new|class|interface|record|enum)\s*$/.test(before)) continue;
    const open = method.code.indexOf("(", match.index);
    const close = matchingIndex(method.code, open);
    if (close < 0) continue;
    result.push({
      receiver: match[1] ?? "",
      name: match[2],
      arity: parameterCount(method.literal.slice(open + 1, close)),
      start: match.index,
    });
  }
  return result.sort((left, right) => left.start - right.start);
}

function classBindings(method, classNames) {
  const bindings = new Map();
  for (const match of method.code.matchAll(
    /\b(?:var|[A-Za-z_$][\w$]*(?:\s*<[^;=]+>)?)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    if (classNames.has(match[2])) bindings.set(match[1], match[2]);
  }
  return bindings;
}

function linkMethods(methods) {
  const byName = new Map();
  const classNames = new Set(methods.map(({ owner }) => owner).filter(Boolean));
  for (const method of methods) {
    if (!byName.has(method.name)) byName.set(method.name, []);
    byName.get(method.name).push(method);
  }
  for (const method of methods) {
    const bindings = classBindings(method, classNames);
    method.calls = [];
    for (const call of callSites(method)) {
      let candidates = byName.get(call.name) ?? [];
      if (call.receiver === "this") {
        candidates = candidates.filter(({ owner }) => owner === method.owner);
      } else if (bindings.has(call.receiver)) {
        candidates = candidates.filter(
          ({ owner }) => owner === bindings.get(call.receiver),
        );
      } else if (classNames.has(call.receiver)) {
        candidates = candidates.filter(({ owner }) => owner === call.receiver);
      } else if (call.receiver) {
        candidates = [];
      }
      method.calls.push(
        ...candidates.filter(({ arity }) => arity === call.arity),
      );
    }
  }
}

function reachableMethods(methods) {
  const result = new Set();
  const pending = methods.filter(isMain);
  while (pending.length > 0) {
    const method = pending.pop();
    if (result.has(method.id)) continue;
    result.add(method.id);
    pending.push(...method.calls);
  }
  return methods.filter(({ id }) => result.has(id));
}

function closure(method) {
  const result = [];
  const seen = new Set();
  const pending = [method];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    result.push(current);
    pending.push(...current.calls);
  }
  return result;
}

function closureText(method, field = "code") {
  return closure(method).map((candidate) => candidate[field]).join("\n");
}

function validManifest(workspace) {
  const manifests = workspace.buildManifests ??
    [{ name: workspace.buildFiles?.[0] ?? "pom.xml", content: workspace.build ?? "" }];
  const expected = new Map([
    ["azure-cosmos", "4.82.0"],
    ["azure-identity", "1.18.5"],
  ]);
  const allVersions = new Map([...expected].map(([name]) => [name, new Set()]));
  let valid = false;
  for (const manifest of manifests) {
    if (!String(manifest.name ?? "").toLowerCase().endsWith("pom.xml")) continue;
    const xml = String(manifest.content ?? "").replace(/<!--[\s\S]*?-->/g, " ");
    if (!/<maven\.compiler\.release>\s*17\s*<\/maven\.compiler\.release>/i.test(xml)) {
      continue;
    }
    const versions = new Map();
    for (const match of xml.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)) {
      const group = /<groupId\b[^>]*>\s*([^<]+)\s*<\/groupId>/i.exec(match[1])?.[1]?.trim();
      const artifact = /<artifactId\b[^>]*>\s*([^<]+)\s*<\/artifactId>/i.exec(match[1])?.[1]?.trim();
      const version = /<version\b[^>]*>\s*([^<]+)\s*<\/version>/i.exec(match[1])?.[1]?.trim();
      const scope = /<scope\b[^>]*>\s*([^<]+)\s*<\/scope>/i.exec(match[1])?.[1]?.trim() ?? "compile";
      if (group !== "com.azure" || !expected.has(artifact) || !["compile", "runtime"].includes(scope)) {
        continue;
      }
      if (!versions.has(artifact)) versions.set(artifact, new Set());
      versions.get(artifact).add(version);
      allVersions.get(artifact).add(version);
    }
    if ([...expected].every(([name, version]) =>
      versions.get(name)?.size === 1 && versions.get(name).has(version))) {
      valid = true;
    }
  }
  return valid && [...expected].every(([name, version]) =>
    allVersions.get(name).size === 1 && allVersions.get(name).has(version));
}

function sdkProvenance(code) {
  if (
    /\bpackage\s+com\s*\.\s*azure(?:\s*\.\s*[\w$]+)*\s*;[\s\S]*?\b(?:class|interface|record|enum)\s+/.test(code)
  ) {
    return false;
  }
  const local = new Set(
    Array.from(
      code.matchAll(/\b(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)/g),
      (match) => match[1],
    ),
  );
  if (SDK_TYPES.some((name) => local.has(name))) return false;
  return (
    /\bimport\s+com\.azure\.cosmos\./.test(code) &&
    /\bimport\s+com\.azure\.identity\.ManagedIdentityCredentialBuilder\s*;/.test(code)
  );
}

function todoModel(code) {
  for (const match of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g)) {
    const open = code.indexOf("{", match.index);
    const close = matchingIndex(code, open, "{", "}");
    if (close < 0) continue;
    const body = code.slice(open + 1, close);
    if (
      ["id", "title", "description", "completed", "createdAt", "category"]
        .every((name) => new RegExp(`\\b${name}\\b`).test(body))
    ) {
      return true;
    }
  }
  return false;
}

function ownerUsesContainer(code, owner, asynchronous) {
  const declaration = new RegExp(
    `\\bclass\\s+${escapeRegExp(owner)}\\b[^\\{]*\\{`,
  ).exec(code);
  if (!declaration) return false;
  const open = code.indexOf("{", declaration.index);
  const close = matchingIndex(code, open, "{", "}");
  if (close < 0) return false;
  const body = code.slice(open + 1, close);
  const type = asynchronous ? "CosmosAsyncContainer" : "CosmosContainer";
  return new RegExp(`\\b${type}\\s+[A-Za-z_$][\\w$]*\\s*;`).test(body);
}

function factoryRule(reachable, fullCode) {
  let syncClient = false;
  let asyncClient = false;
  let syncContainer = false;
  let asyncContainer = false;
  for (const method of reachable) {
    const code = closureText(method);
    const literal = closureText(method, "literal");
    const managedIdentity =
      /new\s+ManagedIdentityCredentialBuilder\s*\(\s*\)\s*\.\s*build\s*\(\s*\)/.test(code);
    const endpoint =
      /System\s*\.\s*getenv\s*\(/.test(code) &&
      /"AZURE_COSMOS_ENDPOINT"/.test(literal);
    const builder =
      /new\s+CosmosClientBuilder\s*\(\s*\)/.test(code) &&
      /\.endpoint\s*\(/.test(code) &&
      /\.credential\s*\(/.test(code);
    syncClient ||= managedIdentity && endpoint && builder && /\.buildClient\s*\(/.test(code);
    asyncClient ||= managedIdentity && endpoint && builder && /\.buildAsyncClient\s*\(/.test(code);

    const ttlConfigured =
      /\.setDefaultTimeToLiveInSeconds\s*\(\s*(?:7_?776_?000)\s*\)/.test(code) ||
      (
        /\.setDefaultTimeToLiveInSeconds\s*\(\s*DEFAULT_TTL_SECONDS\s*\)/.test(code) &&
        /\bDEFAULT_TTL_SECONDS\s*=\s*(?:7_?776_?000|90\s*\*\s*24\s*\*\s*60\s*\*\s*60)\s*;/.test(
          fullCode,
        )
      );
    const containerConfiguration =
      /new\s+CosmosContainerProperties\s*\([^;]*"\/category"/.test(literal) &&
      ttlConfigured &&
      /new\s+ExcludedPath\s*\(\s*"\/description\/?\?"/.test(literal) &&
      /\.setIndexingPolicy\s*\(/.test(code);
    const creates =
      /\.createDatabaseIfNotExists\s*\(/.test(code) &&
      /\.createContainerIfNotExists\s*\(/.test(code) &&
      containerConfiguration;
    syncContainer ||= creates && /\bCosmosContainer\b/.test(method.modifiersAndType);
    asyncContainer ||= creates && /\bCosmosAsyncContainer\b/.test(method.modifiersAndType);
  }
  return syncClient && asyncClient && syncContainer && asyncContainer;
}

function operationRule(reachable, asynchronous, fullCode) {
  const found = new Set();
  for (const method of reachable) {
    const isAsync = /Async/.test(method.owner) || /\b(?:Mono|Flux)\b/.test(method.modifiersAndType);
    if (isAsync !== asynchronous) continue;
    if (!ownerUsesContainer(fullCode, method.owner, asynchronous)) continue;
    const code = method.code;
    for (const operation of POINT_OPERATIONS) {
      const operationPattern = new RegExp(`\\.${operation}\\s*\\(`);
      if (
        operationPattern.test(code) &&
        /new\s+PartitionKey\s*\(/.test(code) &&
        /\.getRequestCharge\s*\(\s*\)/.test(code) &&
        /(?:System\s*\.\s*out|log|logger)/i.test(code)
      ) {
        found.add(operation);
      }
    }
  }
  return POINT_OPERATIONS.every((operation) => found.has(operation));
}

function conflictRule(reachable, fullCode) {
  const kinds = new Set();
  for (const method of reachable) {
    if (!/\.replaceItem\s*\(/.test(method.code)) continue;
    const asynchronous =
      /Async/.test(method.owner) || /\b(?:Mono|Flux)\b/.test(method.modifiersAndType);
    if (!ownerUsesContainer(fullCode, method.owner, asynchronous)) continue;
    const code = closureText(method);
    if (
      /\.replaceItem\s*\(/.test(code) &&
      /\.setIfMatchETag\s*\([^)]*(?:getEtag|etag)/i.test(code) &&
      /(?:case\s+412|==\s*412)/.test(code) &&
      /\bTodoConflict\w*\s*\(/.test(code)
    ) {
      kinds.add(asynchronous);
    }
  }
  return kinds.has(false) && kinds.has(true);
}

function paginationRule(reachable, asynchronous, fullCode) {
  for (const method of reachable) {
    const isAsync = /Async/.test(method.owner) || /\b(?:Mono|Flux)\b/.test(method.modifiersAndType);
    if (isAsync !== asynchronous) continue;
    if (!ownerUsesContainer(fullCode, method.owner, asynchronous)) continue;
    if (!/\.queryItems\s*\(/.test(method.code)) continue;
    const code = closureText(method);
    const literal = closureText(method, "literal");
    const parameterized =
      /new\s+SqlQuerySpec\s*\(/.test(code) &&
      /WHERE\s+\w+\.category\s*=\s*@category/i.test(literal) &&
      /new\s+SqlParameter\s*\(\s*"@category"\s*,/i.test(literal);
    const pages = asynchronous
      ? /\.queryItems\s*\([\s\S]*?\)\s*\.\s*byPage\s*\(/.test(code) ||
        /\b(\w+)\s*=\s*[^;]*\.queryItems\s*\([\s\S]*?;[\s\S]*?\b\1\s*\.\s*byPage\s*\(/.test(code)
      : /\b(\w+)\s*=\s*[^;]*\.queryItems\s*\([\s\S]*?;[\s\S]*?\b\1\s*\.\s*iterableByPage\s*\(/.test(code);
    if (
      parameterized &&
      new RegExp(
        `\\.${asynchronous ? "byPage" : "iterableByPage"}\\s*\\(\\s*(?:null\\s*,\\s*)?[A-Za-z_$][\\w$]*\\s*\\)`,
      ).test(code) &&
      pages &&
      /\.getResults\s*\(\s*\)\s*\.\s*size\s*\(\s*\)/.test(code) &&
      /\.getContinuationToken\s*\(\s*\)/.test(code) &&
      /\.getRequestCharge\s*\(\s*\)/.test(code) &&
      !/\.stream\s*\(\s*\)\s*\.\s*forEach\s*\(/.test(code)
    ) {
      return true;
    }
  }
  return false;
}

function orderedTrace(methods) {
  const trace = [];
  const visit = (method, stack) => {
    if (stack.has(method.id)) return;
    const nextStack = new Set(stack).add(method.id);
    const isAsync = /Async/.test(method.owner) || /\b(?:Mono|Flux)\b/.test(method.modifiersAndType);
    const calls = callSites(method);
    for (const call of calls) {
      if ([...POINT_OPERATIONS, "queryItems"].includes(call.name)) {
        trace.push(`${isAsync ? "async" : "sync"}:${call.name}`);
      }
      for (const target of method.calls.filter(
        ({ name, arity }) => name === call.name && arity === call.arity,
      )) {
        visit(target, nextStack);
      }
    }
  };
  methods.filter(isMain).forEach((method) => visit(method, new Set()));
  return trace;
}

function connectedDemo(methods) {
  const expected = [
    "sync:createItem",
    "sync:readItem",
    "sync:queryItems",
    "sync:replaceItem",
    "sync:deleteItem",
    "async:createItem",
    "async:readItem",
    "async:queryItems",
    "async:replaceItem",
    "async:deleteItem",
  ];
  const trace = orderedTrace(methods);
  let position = 0;
  for (const event of trace) {
    if (event === expected[position]) position += 1;
  }
  return position === expected.length;
}

function analyze(workspace) {
  const source = workspace.source ?? "";
  const code = maskJava(source);
  const literal = maskJava(source, true);
  if (!workspace.sourceFiles?.length || !sdkProvenance(code)) {
    return Object.fromEntries(RULES.map((name) => [name, false]));
  }
  const methods = parseMethods(code, literal);
  linkMethods(methods);
  const reachable = reachableMethods(methods);
  if (reachable.length === 0) {
    return Object.fromEntries(RULES.map((name) => [name, false]));
  }
  return {
    "prompt/source-manifest": validManifest(workspace),
    "prompt/todo-model": todoModel(code),
    "prompt/secure-container-factory": factoryRule(reachable, code),
    "prompt/sync-crud-request-charges": operationRule(reachable, false, code),
    "prompt/async-crud-request-charges": operationRule(reachable, true, code),
    "prompt/etag-conflict-handling": conflictRule(reachable, code),
    "prompt/sync-parameterized-pagination": paginationRule(reachable, false, code),
    "prompt/async-parameterized-pagination": paginationRule(reachable, true, code),
    "prompt/connected-sync-then-async-demo": connectedDemo(methods),
  };
}

const cache = new WeakMap();

export function evaluateRule(name, workspace) {
  if (!RULES.includes(name)) throw new Error(`Unknown rule: ${name}`);
  if (!cache.has(workspace)) cache.set(workspace, analyze(workspace));
  return cache.get(workspace)[name];
}

export function ruleNames() {
  return [...RULES];
}
