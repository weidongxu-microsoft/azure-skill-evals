const sdkTypes = new Set([
  "CosmosClient",
  "CosmosClientBuilder",
  "CosmosContainer",
  "CosmosContainerProperties",
  "CosmosDatabase",
  "CosmosException",
  "CosmosPagedIterable",
  "CosmosQueryRequestOptions",
  "SqlParameter",
  "SqlQuerySpec",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskJava(source, preserveStrings = false) {
  let result = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line") {
      result += current === "\n" ? "\n" : " ";
      if (current === "\n") state = "code";
    } else if (state === "block") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
    } else if (state === "string" || state === "character") {
      if (current === "\\") {
        result += preserveStrings ? `${current}${next ?? ""}` : "  ";
        index += 1;
      } else if (
        (state === "string" && current === '"') ||
        (state === "character" && current === "'")
      ) {
        result += preserveStrings ? current : " ";
        state = "code";
      } else {
        result += preserveStrings
          ? current
          : current === "\n"
            ? "\n"
            : " ";
      }
    } else if (source.startsWith('"""', index)) {
      const close = source.indexOf('"""', index + 3);
      const end = close < 0 ? source.length : close + 3;
      const text = source.slice(index, end);
      result += preserveStrings ? text : text.replace(/[^\n]/g, " ");
      index = end - 1;
    } else if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block";
    } else if (current === '"') {
      result += preserveStrings ? current : " ";
      state = "string";
    } else if (current === "'") {
      result += preserveStrings ? current : " ";
      state = "character";
    } else {
      result += current;
    }
  }
  return result;
}

function matchingIndex(source, start, opening = "(", closing = ")") {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === opening) depth += 1;
    else if (source[index] === closing && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(source, separator = ",") {
  const syntax = maskJava(source, true);
  const result = [];
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  let start = 0;
  for (let index = 0; index < syntax.length; index += 1) {
    const current = syntax[index];
    if (current in depth) depth[current] += 1;
    else if (current in closing) depth[closing[current]] -= 1;
    else if (
      current === separator &&
      Object.values(depth).every((value) => value === 0)
    ) {
      result.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = source.slice(start).trim();
  if (final || result.length > 0) result.push(final);
  return result;
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n") characters[index] = " ";
  }
}

function reachableBody(source) {
  const characters = [...source];
  const syntax = maskJava(source);
  for (const match of syntax.matchAll(
    /\b(?:if|while)\s*\(\s*false\s*\)\s*\{/g,
  )) {
    const open = syntax.indexOf("{", match.index);
    const close = matchingIndex(syntax, open, "{", "}");
    if (close >= 0) maskRange(characters, match.index, close + 1);
  }
  for (const match of syntax.matchAll(
    /\bfor\s*\([^;]*;\s*false\s*;[^)]*\)\s*\{/g,
  )) {
    const open = syntax.indexOf("{", match.index);
    const close = matchingIndex(syntax, open, "{", "}");
    if (close >= 0) maskRange(characters, match.index, close + 1);
  }
  let braces = 0;
  let parentheses = 0;
  let statementStart = 0;
  for (let index = 0; index < syntax.length; index += 1) {
    const current = syntax[index];
    if (current === "{") braces += 1;
    else if (current === "}") braces -= 1;
    else if (current === "(") parentheses += 1;
    else if (current === ")") parentheses -= 1;
    else if (current === ";" && braces === 0 && parentheses === 0) {
      const statement = characters.slice(statementStart, index).join("");
      if (/^\s*(?:return|throw)\b/.test(statement)) {
        maskRange(characters, index + 1, characters.length);
        break;
      }
      statementStart = index + 1;
    }
  }
  return characters.join("");
}

function parseMethods(source) {
  const code = maskJava(source);
  const literal = maskJava(source, true);
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
    const parameterSources = splitTopLevel(match[3]);
    methods.push({
      arity: parameterSources.length,
      body: reachableBody(literal.slice(open + 1, close)),
      code: reachableBody(code.slice(open + 1, close)),
      id: methods.length,
      modifiersAndType: match[1],
      name: match[2],
      parameters: parameterSources.map((parameter) =>
        /([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?\s*$/.exec(parameter)?.[1]
      ),
    });
    pattern.lastIndex = close + 1;
  }
  return methods;
}

function isMain(method) {
  return method.name === "main" &&
    /\bpublic\b/.test(method.modifiersAndType) &&
    /\bstatic\b/.test(method.modifiersAndType) &&
    /\bvoid\s*$/.test(method.modifiersAndType) &&
    method.arity === 1;
}

function callsIn(method) {
  const result = [];
  for (const match of method.code.matchAll(
    /(?:(\b[A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    const before = method.code.slice(Math.max(0, match.index - 20), match.index);
    if (/\b(?:new|class|interface|record|enum)\s*$/.test(before)) continue;
    const open = method.code.indexOf("(", match.index);
    const close = matchingIndex(method.code, open);
    if (close < 0) continue;
    result.push({
      arguments: splitTopLevel(method.body.slice(open + 1, close)),
      close,
      index: match.index,
      name: match[2],
      receiver: match[1] ?? "",
    });
  }
  return result;
}

function stringConstants(source) {
  const constants = new Map();
  const literal = maskJava(source, true);
  for (const match of literal.matchAll(
    /\b(?:public|protected|private|static|final|\s)*String\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
  )) {
    constants.set(match[1], match[2].trim());
  }
  return constants;
}

function assignments(body) {
  const result = new Map();
  for (const match of body.matchAll(
    /\b(?:var|[A-Za-z_$][\w$]*(?:\s*<[^;=]+>)?(?:\s*\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
  )) {
    result.set(match[1], match[2].trim());
  }
  return result;
}

function unwrap(expression) {
  let value = expression.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    const close = matchingIndex(maskJava(value, true), 0);
    if (close !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function resolveString(
  expression,
  globals,
  locals = new Map(),
  parameters = new Map(),
  seen = new Set(),
) {
  const value = unwrap(expression);
  const literal = /^(["'])([\s\S]*)\1$/.exec(value);
  if (literal) return literal[2];
  if (!/^[A-Za-z_$][\w$]*$/.test(value) || seen.has(value)) return null;
  if (parameters.has(value)) return parameters.get(value);
  const next = locals.get(value) ?? globals.get(value);
  return next === undefined
    ? null
    : resolveString(
        next,
        globals,
        locals,
        parameters,
        new Set(seen).add(value),
      );
}

function analyze(source) {
  const code = maskJava(source);
  const localTypes = new Set(
    [...code.matchAll(
      /\b(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)/g,
    )].map((match) => match[1]),
  );
  const fakeSdk = [...sdkTypes].some((type) => localTypes.has(type)) ||
    /\bpackage\s+com\s*\.\s*azure\s*\.\s*cosmos\b/.test(code) ||
    !/\bimport\s+com\.azure\.cosmos(?:\.models)?\./.test(code);
  const methods = parseMethods(source);
  const byName = new Map();
  for (const method of methods) {
    const candidates = byName.get(method.name) ?? [];
    candidates.push(method);
    byName.set(method.name, candidates);
  }
  const globals = stringConstants(source);
  const contexts = [];
  const visit = (method, parameters = new Map(), seen = new Set()) => {
    const identity = `${method.id}:${JSON.stringify([...parameters])}`;
    if (seen.has(identity)) return;
    const nextSeen = new Set(seen).add(identity);
    const locals = assignments(method.body);
    const context = {
      calls: callsIn(method),
      locals,
      method,
      parameters,
      resolve: (expression) =>
        resolveString(expression, globals, locals, parameters),
    };
    contexts.push(context);
    for (const call of context.calls.filter((candidate) => !candidate.receiver)) {
      const candidates = (byName.get(call.name) ?? []).filter(
        (candidate) => candidate.arity === call.arguments.length,
      );
      if (candidates.length !== 1) continue;
      const bindings = new Map();
      candidates[0].parameters.forEach((parameter, index) => {
        const resolved = context.resolve(call.arguments[index] ?? "");
        if (parameter && resolved !== null) bindings.set(parameter, resolved);
      });
      visit(candidates[0], bindings, nextSeen);
    }
  };
  methods.filter(isMain).forEach((method) => visit(method));
  return { contexts, fakeSdk, globals };
}

function constructorArguments(expression, type) {
  const syntax = maskJava(expression);
  const match = new RegExp(`\\bnew\\s+${type}\\s*\\(`).exec(syntax);
  if (!match) return null;
  const open = syntax.indexOf("(", match.index);
  const close = matchingIndex(syntax, open);
  return close < 0
    ? null
    : splitTopLevel(expression.slice(open + 1, close));
}

function databaseContainer(analysis) {
  let database = false;
  let container = false;
  for (const context of analysis.contexts) {
    const databaseNames = context.calls
      .filter(({ name }) => name === "createDatabaseIfNotExists")
      .map(({ arguments: args }) => context.resolve(args[0] ?? ""))
      .filter((value) => value === "TestDB");
    database ||= databaseNames.length > 0 &&
      context.calls.some(
        ({ name, arguments: args }) =>
          name === "getDatabase" &&
          databaseNames.includes(context.resolve(args[0] ?? "")),
      );

    const properties = new Map();
    for (const [name, expression] of context.locals) {
      const args = constructorArguments(expression, "CosmosContainerProperties");
      if (args?.length >= 2) {
        properties.set(name, {
          name: context.resolve(args[0]),
          partitionKey: context.resolve(args[1]),
        });
      }
    }
    for (const call of context.calls.filter(
      ({ name }) => name === "createContainerIfNotExists",
    )) {
      const first = call.arguments[0] ?? "";
      const directName = context.resolve(first);
      const directPartition = context.resolve(call.arguments[1] ?? "");
      const configured = properties.get(first.trim());
      const name = configured?.name ?? directName;
      const partitionKey = configured?.partitionKey ?? directPartition;
      if (
        name === "Items" &&
        partitionKey === "/category" &&
        context.calls.some(
          (candidate) =>
            candidate.name === "getContainer" &&
            context.resolve(candidate.arguments[0] ?? "") === name,
        )
      ) {
        container = true;
      }
    }
  }
  return database && container;
}

function queryConsumption(context, call) {
  const prefix = context.method.body.slice(Math.max(0, call.index - 300), call.index);
  const after = context.method.code.slice(call.close + 1);
  if (
    /\bfor\s*\([^:]+:\s*$/.test(prefix) ||
    /^\s*\.\s*(?:forEach|iterator|iterableByPage)\s*\(/.test(after)
  ) {
    return true;
  }
  const bound = [...context.locals].find(([, expression]) =>
    /\bqueryItems\s*\(/.test(maskJava(expression))
  )?.[0];
  if (!bound) return false;
  const name = escapeRegExp(bound);
  return new RegExp(
    `\\bfor\\s*\\([^:]+:\\s*${name}\\b|\\b${name}\\s*\\.\\s*(?:forEach|iterator|iterableByPage)\\s*\\(`,
  ).test(context.method.code);
}

function querySpec(context, expression, seen = new Set()) {
  const value = unwrap(expression);
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    if (seen.has(value)) return null;
    const assigned = context.locals.get(value);
    return assigned === undefined
      ? null
      : querySpec(context, assigned, new Set(seen).add(value));
  }
  const args = constructorArguments(value, "SqlQuerySpec");
  if (!args?.length) return null;
  const sql = context.resolve(args[0] ?? "");
  if (!sql) return null;
  const from = /\bFROM\s+([A-Za-z_$][\w$]*)\b/i.exec(sql)?.[1];
  const where = /\bWHERE\s+([A-Za-z_$][\w$]*)\s*\.\s*category\s*=\s*(@[A-Za-z_$][\w$]*)\b/i.exec(
    sql,
  );
  if (!from || !where || from !== where[1]) return null;
  for (const parameter of value.matchAll(/\bnew\s+SqlParameter\s*\(/g)) {
    const open = value.indexOf("(", parameter.index);
    const close = matchingIndex(maskJava(value), open);
    if (close < 0) continue;
    const parameterArgs = splitTopLevel(value.slice(open + 1, close));
    const name = context.resolve(parameterArgs[0] ?? "");
    const supplied = context.resolve(parameterArgs[1] ?? "");
    if (name === where[2] && supplied === "electronics") {
      return { alias: from, parameter: name };
    }
  }
  return null;
}

function hasParameterizedConsumedQuery(analysis) {
  return analysis.contexts.some((context) =>
    context.calls.some((call) =>
      call.name === "queryItems" &&
      queryConsumption(context, call) &&
      querySpec(context, call.arguments[0] ?? "") !== null
    )
  );
}

const rules = {
  "prompt/cosmos-package": ({ build }) =>
    /<groupId>com\.azure<\/groupId>[\s\S]{0,120}?<artifactId>azure-cosmos<\/artifactId>/.test(
      build,
    ),
  "prompt/cosmos-client": ({ analysis }) =>
    analysis.contexts.some(({ method }) =>
      /\bnew\s+CosmosClientBuilder\s*\(\s*\)/.test(method.code) &&
      /\.endpoint\s*\(/.test(method.code) &&
      /\.key\s*\(/.test(method.code) &&
      /\.buildClient\s*\(\s*\)/.test(method.code)
    ),
  "prompt/database-container": ({ analysis }) => databaseContainer(analysis),
  "prompt/item-crud": ({ analysis }) => {
    const reachable = analysis.contexts.map(({ method }) => method.code).join("\n");
    return ["createItem", "readItem", "replaceItem", "deleteItem"].every(
      (method) => new RegExp(`\\.${method}\\s*\\(`).test(reachable),
    ) &&
      ["id", "category", "name", "quantity"].every(
        (field) => new RegExp(`\\b${field}\\b`, "i").test(analysis.fullCode),
      ) &&
      /\.setQuantity\s*\(/.test(reachable);
  },
  "prompt/query-iteration": ({ analysis }) =>
    analysis.contexts.some((context) =>
      context.calls.some(
        (call) =>
          call.name === "queryItems" &&
          /\bnew\s+CosmosQueryRequestOptions\s*\(/.test(
            call.arguments.join(","),
          ) &&
          queryConsumption(context, call),
      )
    ),
  "prompt/parameterized-query": ({ analysis }) =>
    hasParameterizedConsumedQuery(analysis),
  "prompt/cosmos-exception": ({ analysis }) =>
    analysis.contexts.some(({ method }) =>
      /\bcatch\s*\(\s*CosmosException\b/.test(method.code)
    ) &&
    analysis.contexts.some(({ method }) =>
      /\.getStatusCode\s*\(\s*\)/.test(method.code)
    ),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  if (name === "prompt/cosmos-package") return rule(workspace);
  const analysis = analyze(workspace.source ?? "");
  analysis.fullCode = maskJava(workspace.source ?? "");
  return !analysis.fakeSdk && Boolean(rule({ ...workspace, analysis }));
}

export function ruleNames() {
  return Object.keys(rules);
}
