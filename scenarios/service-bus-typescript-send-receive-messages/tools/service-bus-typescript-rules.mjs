import {
  activeDependencies,
  sourceDocuments,
} from "./source-manifest.mjs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskSource(source, maskStrings = true) {
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
    } else if (state !== "code") {
      if (current === "\\") {
        result += maskStrings ? "  " : current + next;
        index += 1;
      } else {
        const closes =
          (state === "single" && current === "'") ||
          (state === "double" && current === '"') ||
          (state === "template" && current === "`");
        result += maskStrings && !closes && current !== "\n" ? " " : current;
        if (closes) state = "code";
      }
    } else if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block";
    } else {
      result += current;
      if (current === "'") state = "single";
      if (current === '"') state = "double";
      if (current === "`") state = "template";
    }
  }
  return result;
}

function matchingClosing(code, openingIndex, opening = "(", closing = ")") {
  let depth = 0;
  for (let index = openingIndex; index < code.length; index += 1) {
    if (code[index] === opening) depth += 1;
    if (code[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function balancedText(source, openingIndex, opening = "(", closing = ")") {
  const end = matchingClosing(
    maskSource(source, false),
    openingIndex,
    opening,
    closing,
  );
  return end === -1 ? "" : source.slice(openingIndex + 1, end);
}

function splitTopLevel(text) {
  const code = maskSource(text, false);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    else if (")]}".includes(code[index])) depth -= 1;
    else if (code[index] === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail || text.includes(",")) parts.push(tail);
  return parts;
}

function expressionEnd(code, start) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    else if (")]}".includes(code[index])) depth -= 1;
    else if (code[index] === ";" && depth === 0) {
      return index;
    }
  }
  return code.length;
}

function unwrap(expression) {
  let value = expression.trim()
    .replace(/^\s*await\s+/, "")
    .replace(/\s+as\s+(?:const|[\w$.<>, [\]|]+)\s*$/s, "")
    .replace(/!\s*$/, "")
    .trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    const end = matchingClosing(maskSource(value, false), 0);
    if (end !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function normalizePath(path) {
  const parts = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function moduleDirectory(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function parseImports(module) {
  const source = maskSource(module.source, false);
  const code = maskSource(module.source);
  const imports = [];
  const pattern =
    /\bimport\s+(type\s+)?([\s\S]*?)\s+from\s*(["'])([^"']+)\3\s*;?/g;
  for (const match of source.matchAll(pattern)) {
    if (code[match.index] !== "i") continue;
    const statementTypeOnly = Boolean(match[1]);
    const clause = match[2].trim();
    const add = (local, imported, kind, typeOnly = false) => imports.push({
      imported,
      index: match.index,
      kind,
      local,
      module,
      specifier: match[4],
      target: null,
      typeOnly,
    });
    const namespace = /^\*\s+as\s+([A-Za-z_$]\w*)$/.exec(clause);
    if (namespace) {
      add(namespace[1], "*", "namespace", statementTypeOnly);
      continue;
    }
    const brace = clause.indexOf("{");
    if (brace !== -1) {
      const defaultName = clause.slice(0, brace).replace(/,\s*$/, "").trim();
      if (defaultName) add(defaultName, "default", "default");
      for (const item of clause.slice(brace + 1, clause.lastIndexOf("}")).split(",")) {
        const parsed = item.trim().match(
          /^(type\s+)?([A-Za-z_$]\w*)(?:\s+as\s+([A-Za-z_$]\w*))?$/,
        );
        if (parsed) {
          add(
            parsed[3] ?? parsed[2],
            parsed[2],
            "named",
            statementTypeOnly || Boolean(parsed[1]),
          );
        }
      }
    } else if (/^[A-Za-z_$]\w*$/.test(clause)) {
      add(clause, "default", "default", statementTypeOnly);
    }
  }
  return imports;
}

function parseExports(module) {
  const code = maskSource(module.source, false);
  const exports = new Map();
  const add = (name, entry) => {
    const entries = exports.get(name) ?? [];
    entries.push(entry);
    exports.set(name, entries);
  };
  for (const match of code.matchAll(
    /\bexport\s+(default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$]\w*)/g,
  )) {
    add(match[1] ? "default" : match[2], {
      kind: "local",
      local: match[2],
    });
  }
  for (const match of code.matchAll(
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$]\w*)/g,
  )) {
    add(match[1], { kind: "local", local: match[1] });
  }
  for (const match of code.matchAll(
    /\bexport\s*\{([^}]+)\}(?:\s*from\s*(["'])([^"']+)\2)?\s*;?/g,
  )) {
    for (const item of match[1].split(",")) {
      const parsed = item.trim().match(
        /^([A-Za-z_$]\w*)(?:\s+as\s+([A-Za-z_$]\w*))?$/,
      );
      if (parsed) {
        add(parsed[2] ?? parsed[1], match[3]
          ? {
              imported: parsed[1],
              kind: "reexport",
              specifier: match[3],
              target: null,
            }
          : { kind: "local", local: parsed[1] });
      }
    }
  }
  const stars = [...code.matchAll(
    /\bexport\s*\*\s*from\s*(["'])([^"']+)\1\s*;?/g,
  )].map((match) => ({ specifier: match[2], target: null }));
  return { exports, stars };
}

function parseCallables(module) {
  const source = module.source;
  const code = maskSource(source);
  const callables = [];
  const add = (name, opening, parameters, kind, owner, start, staticMethod = false) => {
    const closing = matchingClosing(code, opening, "{", "}");
    if (closing === -1) return;
    const parsedParameters = splitTopLevel(parameters).map((parameter) => {
      const match = parameter.match(/^(?:\.\.\.)?([A-Za-z_$]\w*)/);
      const equals = maskSource(parameter, false).indexOf("=");
      return {
        defaultExpression:
          equals === -1 ? null : parameter.slice(equals + 1).trim(),
        name: match?.[1] ?? null,
      };
    }).filter(({ name: parameterName }) => parameterName !== null);
    callables.push({
      bodyEnd: closing,
      bodyStart: opening + 1,
      declarationStart: start,
      id: `${module.path}:${name}:${start}`,
      kind,
      module,
      name,
      owner,
      parameterDefaults: new Map(
        parsedParameters.map((parameter) => [
          parameter.name,
          parameter.defaultExpression,
        ]),
      ),
      parameters: parsedParameters.map((parameter) => parameter.name),
      static: staticMethod,
    });
  };
  for (const match of code.matchAll(
    /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$]\w*)\s*(?:<[^{};]*>)?\s*\(([^)]*)\)[^{]*\{/g,
  )) {
    add(
      match[1],
      match.index + match[0].lastIndexOf("{"),
      match[2],
      "function",
      null,
      match.index,
    );
  }
  for (const match of code.matchAll(
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$]\w*)[^=;\n]*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$]\w*))\s*(?::[^=]+)?=>\s*\{/g,
  )) {
    add(
      match[1],
      match.index + match[0].lastIndexOf("{"),
      match[2] ?? match[3] ?? "",
      "function",
      null,
      match.index,
    );
  }
  const classes = [];
  for (const match of code.matchAll(
    /\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$]\w*)[^{]*\{/g,
  )) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(code, opening, "{", "}");
    if (closing !== -1) {
      classes.push({
        end: closing,
        name: match[1],
        start: opening + 1,
      });
    }
  }
  const methods =
    /(?:^|[;,{}]\s*)(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+)*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$]\w*)\s*(?:<[^{};]*>)?\s*\(([^)]*)\)[^{;]*\{/gm;
  for (const match of code.matchAll(methods)) {
    if (["catch", "for", "if", "switch", "while", "with"].includes(match[1])) {
      continue;
    }
    const opening = match.index + match[0].lastIndexOf("{");
    const classRange = classes
      .filter((range) => range.start <= opening && opening < range.end)
      .sort((left, right) => right.start - left.start)[0];
    if (classRange) {
      add(
        `${classRange.name}.${match[1]}`,
        opening,
        match[2],
        "class-method",
        classRange.name,
        match.index,
        /\bstatic\b/.test(match[0]),
      );
      continue;
    }
    const prefix = code.slice(0, match.index);
    const object = prefix.match(
      /\b(?:const|let|var)\s+([A-Za-z_$]\w*)[^=;\n]*=\s*\{[\s\S]*$/,
    );
    if (object) {
      add(
        `${object[1]}.${match[1]}`,
        opening,
        match[2],
        "object-method",
        object[1],
        match.index,
      );
    }
  }
  callables.push({
    bodyEnd: source.length,
    bodyStart: 0,
    declarationStart: 0,
    id: `${module.path}:<root>`,
    kind: "module-root",
    module,
    name: "<root>",
    owner: null,
    parameters: [],
    static: false,
  });
  return callables;
}

function prepareWorkspace(workspace) {
  const documents = sourceDocuments(workspace);
  const modules = documents.map((document) => ({
    ...document,
    path: normalizePath(document.path),
  }));
  const byPath = new Map();
  for (const module of modules) {
    const entries = byPath.get(module.path) ?? [];
    entries.push(module);
    byPath.set(module.path, entries);
  }
  const resolveRelative = (module, specifier) => {
    if (!specifier.startsWith(".")) return null;
    const base = normalizePath(`${moduleDirectory(module.path)}/${specifier}`);
    const mappings = [
      [".mjs", [".mts"]],
      [".cjs", [".cts"]],
      [".jsx", [".tsx"]],
      [".js", [".ts", ".tsx"]],
    ];
    const mapping = mappings.find(([extension]) => base.endsWith(extension));
    if (!mapping) return null;
    const stem = base.slice(0, -mapping[0].length);
    const matches = mapping[1].flatMap((extension) =>
      byPath.get(`${stem}${extension}`) ?? []
    );
    return matches.length === 1 ? matches[0] : null;
  };
  for (const module of modules) {
    module.imports = parseImports(module);
    const exported = parseExports(module);
    module.exports = exported.exports;
    module.stars = exported.stars;
    module.callables = parseCallables(module);
  }
  for (const module of modules) {
    for (const imported of module.imports) {
      imported.target = resolveRelative(module, imported.specifier);
    }
    for (const entries of module.exports.values()) {
      for (const entry of entries) {
        if (entry.kind === "reexport") {
          entry.target = resolveRelative(module, entry.specifier);
        }
      }
    }
    for (const star of module.stars) {
      star.target = resolveRelative(module, star.specifier);
    }
  }
  return { modules };
}

function ownerAt(module, position) {
  return module.callables
    .filter(
      (callable) =>
        callable.kind !== "module-root" &&
        callable.bodyStart <= position &&
        position < callable.bodyEnd,
    )
    .sort((left, right) => right.bodyStart - left.bodyStart)[0] ??
    module.callables.find((callable) => callable.kind === "module-root");
}

function exportedCallable(module, name, seen = new Set()) {
  if (!module || seen.has(`${module.path}:${name}`)) return null;
  const nextSeen = new Set(seen).add(`${module.path}:${name}`);
  const candidates = [];
  for (const entry of module.exports.get(name) ?? []) {
    if (entry.kind === "local") {
      candidates.push(module.callables.find((callable) =>
        callable.name === entry.local ||
        callable.owner === entry.local
      ));
    } else {
      candidates.push(exportedCallable(entry.target, entry.imported, nextSeen));
    }
  }
  if (name !== "default") {
    for (const star of module.stars) {
      candidates.push(exportedCallable(star.target, name, nextSeen));
    }
  }
  const unique = new Map(
    candidates.filter(Boolean).map((candidate) => [candidate.id, candidate]),
  );
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function importEntry(module, local) {
  const matches = module.imports.filter((entry) => entry.local === local);
  return matches.length === 1 ? matches[0] : null;
}

function isShadowed(module, owner, name, position) {
  if (owner.parameters.includes(name)) return true;
  const code = maskSource(module.source);
  const rangeStart = owner.bodyStart;
  const declaration = new RegExp(
    `\\b(?:const|let|var|class|function)\\s+${escapeRegExp(name)}\\b`,
    "g",
  );
  declaration.lastIndex = rangeStart;
  const found = declaration.exec(code);
  return Boolean(found && found.index < position);
}

function importedType(module, owner, reference, position, moduleName, exportName) {
  const compact = reference.replace(/\s+/g, "");
  const parts = compact.split(".");
  const entry = importEntry(module, parts[0]);
  if (!entry || isShadowed(module, owner, parts[0], position)) return false;
  return !entry.typeOnly && entry.specifier === moduleName &&
    (
      entry.kind === "namespace"
        ? parts.length === 2 && parts[1] === exportName
        : parts.length === 1 && entry.imported === exportName
    );
}

function extractCalls(module) {
  const source = module.source;
  const code = maskSource(source);
  const calls = [];
  const awaitedPromiseArrays = [];
  for (const match of code.matchAll(/\bawait\s+Promise\s*\.\s*all\s*\(/g)) {
    const array = code.indexOf("[", match.index + match[0].length);
    if (array === -1) continue;
    const closing = matchingClosing(code, array, "[", "]");
    if (closing !== -1) awaitedPromiseArrays.push({ end: closing, start: array });
  }
  const pattern =
    /\b([A-Za-z_$]\w*(?:\s*(?:\?\.|\.)\s*[A-Za-z_$]\w*)*)\s*\(/g;
  const ignored = new Set(["catch", "for", "if", "new", "switch", "while"]);
  for (const match of code.matchAll(pattern)) {
    const name = match[1].replace(/\s+/g, "").replaceAll("?.", ".");
    if (
      ignored.has(name) ||
      /\b(?:function|class)\s+$/.test(
        code.slice(Math.max(0, match.index - 20), match.index),
      )
    ) {
      continue;
    }
    const opening = match.index + match[0].lastIndexOf("(");
    const closing = matchingClosing(code, opening);
    if (closing === -1) continue;
    const prefix = code.slice(
      Math.max(
        0,
        Math.max(
          code.lastIndexOf(";", match.index - 1),
          code.lastIndexOf("{", match.index - 1),
          code.lastIndexOf("}", match.index - 1),
          code.lastIndexOf("\n", match.index - 1),
        ) + 1,
      ),
      match.index,
    );
    const inAwaitedPromiseAll = awaitedPromiseArrays.some(
      (range) => range.start < match.index && closing < range.end,
    );
    calls.push({
      arguments: splitTopLevel(source.slice(opening + 1, closing)),
      awaited:
        /\bawait\s+(?:\(*\s*)*$/.test(prefix) || inAwaitedPromiseAll,
      end: closing + 1,
      index: match.index,
      module,
      name,
      owner: ownerAt(module, match.index),
      returned: /\breturn\s+(?:await\s+)?(?:\(*\s*)*$/.test(prefix),
    });
  }
  return calls;
}

function localCallTarget(call) {
  const parts = call.name.split(".");
  const module = call.module;
  if (parts.length === 1) {
    const local = module.callables.filter((candidate) =>
      candidate.kind === "function" && candidate.name === parts[0]
    );
    if (local.length === 1) return local[0];
    const imported = importEntry(module, parts[0]);
    return imported?.kind === "namespace"
      ? null
      : exportedCallable(imported?.target, imported?.imported);
  }
  if (parts.length === 2) {
    const imported = importEntry(module, parts[0]);
    if (imported?.kind === "namespace") {
      return exportedCallable(imported.target, parts[1]);
    }
    const object = module.callables.filter((candidate) =>
      candidate.kind === "object-method" &&
      candidate.name === `${parts[0]}.${parts[1]}`
    );
    if (object.length === 1) return object[0];
    const classMethod = module.callables.filter((candidate) =>
      candidate.kind === "class-method" &&
      candidate.static &&
      candidate.name === `${parts[0]}.${parts[1]}`
    );
    if (classMethod.length === 1) return classMethod[0];
    const before = maskSource(module.source).slice(0, call.index);
    const instance = new RegExp(
      `\\b(?:const|let|var)\\s+${escapeRegExp(parts[0])}` +
        `(?:\\s*:[^=;]+)?\\s*=\\s*new\\s+([A-Za-z_$]\\w*)\\s*\\(`,
      "g",
    );
    const matches = [...before.matchAll(instance)];
    const className = matches.at(-1)?.[1];
    if (className) {
      const methods = module.callables.filter((candidate) =>
        candidate.kind === "class-method" &&
        !candidate.static &&
        candidate.name === `${className}.${parts[1]}`
      );
      if (methods.length === 1) return methods[0];
    }
  }
  if (parts.length === 3 && parts[0] === "this") {
    const methods = module.callables.filter((candidate) =>
      candidate.kind === "class-method" &&
      candidate.owner === call.owner.owner &&
      candidate.name === `${call.owner.owner}.${parts[2]}`
    );
    if (methods.length === 1) return methods[0];
  }
  return null;
}

function buildTraces(prepared) {
  const allCalls = prepared.modules.flatMap(extractCalls);
  for (const call of allCalls) call.target = localCallTarget(call);
  const traces = [];
  let nextTraceId = 1;
  const roots = prepared.modules
    .map((module) =>
      module.callables.find((callable) => callable.kind === "module-root")
    )
    .sort((left, right) => left.module.path.localeCompare(right.module.path));

  function visit(owner, root, incoming, inheritedAwait, stack) {
    if (stack.has(owner.id)) return;
    const context = {
      id: nextTraceId++,
      incoming,
      inheritedAwait,
      owner,
      root,
    };
    traces.push(context);
    const events = allCalls
      .filter((call) => call.owner === owner)
      .sort((left, right) => left.index - right.index);
    for (const call of events) {
      if (call.target) {
        visit(
          call.target,
          root,
          call,
          call.awaited || (inheritedAwait && call.returned),
          new Set(stack).add(owner.id),
        );
      }
    }
  }
  for (const root of roots) visit(root, root, null, false, new Set());
  return { allCalls, roots, traces };
}

function latestAssignment(context, name, position) {
  const source = context.owner.module.source;
  const code = maskSource(source, false);
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(
    `(?:\\b(?:const|let|var)\\s+)?(?<![\\w$.])${escaped}` +
      `(?:\\s*:[^=;\\n]+)?\\s*=(?!=|>)`,
    "g",
  );
  let latest = null;
  for (const match of code.matchAll(pattern)) {
    if (
      match.index < context.owner.bodyStart ||
      match.index >= position ||
      ownerAt(context.owner.module, match.index) !== context.owner
    ) {
      continue;
    }
    const equals = match.index + match[0].lastIndexOf("=");
    latest = {
      declaredType: (() => {
        const declaration = match[0].match(
          /\b(?:const|let|var)\s+[A-Za-z_$]\w*\s*:\s*([^=]+)=/,
        );
        return declaration?.[1].trim() ?? null;
      })(),
      expression: source.slice(
        equals + 1,
        expressionEnd(maskSource(source, false), equals + 1),
      ),
      index: match.index,
      start: equals + 1,
    };
  }
  return latest;
}

function classOrObjectMember(context, member) {
  if (!member.startsWith("this.")) return null;
  const field = member.slice(5);
  const source = context.owner.module.source;
  const code = maskSource(source, false);
  if (context.owner.kind === "class-method") {
    const classPattern = new RegExp(
      `\\bclass\\s+${escapeRegExp(context.owner.owner)}[^\\{]*\\{`,
    );
    const classMatch = classPattern.exec(code);
    if (classMatch) {
      const opening = classMatch.index + classMatch[0].lastIndexOf("{");
      const end = matchingClosing(code, opening, "{", "}");
      const body = source.slice(opening + 1, end);
      const match = new RegExp(
        `(?:^|[;}])\\s*(?:public\\s+|private\\s+|protected\\s+|readonly\\s+)*` +
          `${escapeRegExp(field)}\\s*(?::[^=;]+)?=`,
        "m",
      ).exec(maskSource(body, false));
      if (match) {
        const equals = opening + 1 + match.index + match[0].lastIndexOf("=");
        return {
          expression: source.slice(
            equals + 1,
            expressionEnd(code, equals + 1),
          ),
          start: equals + 1,
        };
      }
    }
  }
  if (context.owner.kind === "object-method") {
    const objectPattern = new RegExp(
      `\\b(?:const|let|var)\\s+${escapeRegExp(context.owner.owner)}` +
        `[^=;\\n]*=\\s*\\{`,
    );
    const object = objectPattern.exec(code);
    if (object) {
      const opening = object.index + object[0].lastIndexOf("{");
      const body = source.slice(
        opening + 1,
        matchingClosing(code, opening, "{", "}"),
      );
      const property = new RegExp(
        `(?:^|[,;])\\s*${escapeRegExp(field)}\\s*:\\s*`,
        "m",
      ).exec(maskSource(body, false));
      if (property) {
        const start = opening + 1 + property.index + property[0].length;
        return {
          expression: source.slice(start, expressionEnd(code, start)),
          start,
        };
      }
    }
  }
  return null;
}

function createResolver(prepared, traceState) {
  const cache = new Map();

  function constantString(expression, context, position, seen) {
    const value = unwrap(expression);
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    if (quoted) return quoted[2];
    const template = /^`([^$`]*)`$/.exec(value);
    if (template) return template[1];
    if (/^[A-Za-z_$]\w*$/.test(value)) {
      const resolved = resolve(value, context, position, seen);
      return resolved?.kind === "string" ? resolved.value : null;
    }
    return null;
  }

  function parameterValue(name, context, seen) {
    const index = context.owner.parameters.indexOf(name);
    if (index === -1 || !context.incoming) return null;
    const argument = context.incoming.arguments[index];
    const caller = traceState.traces.find(
      (candidate) =>
        candidate.owner === context.incoming.owner &&
        candidate.root === context.root,
    );
    if (caller && argument !== undefined) {
      return resolve(argument, caller, context.incoming.index, seen);
    }
    const fallback = context.owner.parameterDefaults?.get(name);
    return fallback
      ? resolve(
          fallback,
          context,
          context.owner.declarationStart,
          seen,
        )
      : null;
  }

  function resolve(expression, context, position, seen = new Set()) {
    if (!expression || !context) return null;
    const text = unwrap(expression);
    const key = `${context.id}:${position}:${text}`;
    if (seen.has(key)) return null;
    const nextSeen = new Set(seen).add(key);
    const dotEnvironment = text.match(
      /^process\s*\.\s*env\s*\.\s*([A-Za-z_$]\w*)$/,
    );
    if (dotEnvironment) {
      return { kind: "environment", name: dotEnvironment[1] };
    }
    const bracketEnvironment = text.match(
      /^process\s*\.\s*env\s*\[\s*(["'])([^"']+)\1\s*\]$/,
    );
    if (bracketEnvironment) {
      return { kind: "environment", name: bracketEnvironment[2] };
    }
    const string = constantString(text, context, position, nextSeen);
    if (string !== null) return { kind: "string", value: string };
    const numeric = text.replaceAll("_", "");
    if (/^-?\d+$/.test(numeric)) {
      return { kind: "number", value: Number(numeric) };
    }
    if (text.startsWith("{") && text.endsWith("}")) {
      const body = text.slice(1, -1);
      const properties = new Map();
      const wait = propertyExpression(body, "maxWaitTimeInMs");
      if (wait !== null) {
        properties.set(
          "maxWaitTimeInMs",
          resolve(wait, context, position, nextSeen),
        );
      }
      return { kind: "object", properties };
    }

    const constructor = text.match(
      /^new\s+([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*(?:<[^;(){}]+>)?\s*\(/,
    );
    if (constructor) {
      const opening = text.indexOf("(", constructor.index);
      const args = splitTopLevel(balancedText(text, opening));
      if (importedType(
        context.owner.module,
        context.owner,
        constructor[1],
        position,
        "@azure/identity",
        "DefaultAzureCredential",
      )) {
        return { id: `credential:${context.id}:${position}`, kind: "credential" };
      }
      if (importedType(
        context.owner.module,
        context.owner,
        constructor[1],
        position,
        "@azure/service-bus",
        "ServiceBusClient",
      )) {
        const namespace = resolve(args[0], context, position, nextSeen);
        const credential = resolve(args[1], context, position, nextSeen);
        return namespace?.kind === "environment" &&
            namespace.name === "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE" &&
            credential?.kind === "credential"
          ? {
              id: `client:${context.id}:${position}`,
              kind: "client",
              context,
              module: context.owner.module,
              namespace: namespace.name,
              origin: position,
            }
          : null;
      }
      return null;
    }

    const method = text.match(
      /^([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*)\s*\.\s*(createSender|createReceiver|createProcessor|createMessageBatch|receiveMessages|subscribe)\s*\(/,
    );
    if (method) {
      const opening = text.indexOf("(", method.index);
      const args = splitTopLevel(balancedText(text, opening));
      const receiver = resolve(method[1], context, position, nextSeen);
      if (
        receiver?.kind === "client" &&
        ["createSender", "createReceiver", "createProcessor"].includes(method[2])
      ) {
        const entity = resolve(args[0], context, position, nextSeen);
        const subscription = resolve(args[1], context, position, nextSeen);
        if (!entity) return null;
        return {
          clientId: receiver.id,
          context,
          entity,
          id: `${method[2]}:${context.id}:${position}`,
          kind: method[2] === "createSender"
            ? "sender"
            : method[2] === "createReceiver"
              ? "receiver"
              : "processor",
          module: context.owner.module,
          origin: position,
          subscription,
        };
      }
      if (receiver?.kind === "sender" && method[2] === "createMessageBatch") {
        return {
          id: `batch:${context.id}:${position}`,
          kind: "batch",
          senderId: receiver.id,
        };
      }
      if (
        ["receiver", "processor"].includes(receiver?.kind) &&
        method[2] === "receiveMessages"
      ) {
        return {
          id: `received:${context.id}:${position}`,
          kind: "received-messages",
          receiverId: receiver.id,
        };
      }
      if (
        ["receiver", "processor"].includes(receiver?.kind) &&
        method[2] === "subscribe"
      ) {
        return {
          id: `subscription:${context.id}:${position}`,
          kind: "subscription",
          context,
          module: context.owner.module,
          origin: position,
          receiverId: receiver.id,
        };
      }
    }

    const helperEnvironment = text.match(
      /^([A-Za-z_$]\w*)\s*\(/,
    );
    const helperArguments = helperEnvironment
      ? splitTopLevel(balancedText(text, text.indexOf("(")))
      : [];
    const helperName = constantString(
      helperArguments[0] ?? "",
      context,
      position,
      nextSeen,
    );
    if (
      helperEnvironment &&
      /^SERVICE_BUS_/.test(helperName ?? "")
    ) {
      const helper = context.owner.module.callables.find(
        (callable) => callable.name === helperEnvironment[1],
      );
      const body = helper &&
        context.owner.module.source.slice(helper.bodyStart, helper.bodyEnd);
      if (
        helper &&
        /process\s*\.\s*env\s*\[/.test(maskSource(body)) &&
        /\bthrow\b/.test(maskSource(body))
      ) {
        return { kind: "environment", name: helperName };
      }
    }

    const member = text.match(
      /^((?:this|[A-Za-z_$]\w*)(?:\.[A-Za-z_$]\w*)+)$/,
    )?.[1];
    if (member) {
      const assignment = latestAssignment(context, member, position) ??
        classOrObjectMember(context, member);
      if (assignment) {
        return resolve(
          assignment.expression,
          context,
          assignment.start,
          nextSeen,
        );
      }
    }
    if (/^[A-Za-z_$]\w*$/.test(text)) {
      const parameter = parameterValue(text, context, nextSeen);
      if (parameter) return parameter;
      const assignment = latestAssignment(context, text, position);
      if (assignment) {
        const messageType = assignment.declaredType?.replace(/\s+/g, "");
        const root = messageType?.split(".")[0];
        const entry = root && importEntry(context.owner.module, root);
        const importedMessage =
          entry?.specifier === "@azure/service-bus" &&
          (
            entry.kind === "namespace"
              ? messageType === `${root}.ServiceBusMessage`
              : entry.imported === "ServiceBusMessage"
          );
        if (importedMessage && /\bbody\s*:/.test(assignment.expression)) {
          return {
            id: `message:${context.id}:${assignment.index}`,
            kind: "message",
            origin: assignment.index,
          };
        }
        return resolve(
          assignment.expression,
          context,
          assignment.start,
          nextSeen,
        );
      }
    }
    return null;
  }

  return {
    resolve(expression, context, position) {
      const key = `${context?.id}:${position}:${expression}`;
      if (!cache.has(key)) cache.set(key, resolve(expression, context, position));
      return cache.get(key);
    },
  };
}

function numericLiteral(expression) {
  const normalized = unwrap(expression).replaceAll("_", "");
  return /^-?\d+$/.test(normalized) ? Number(normalized) : null;
}

function enclosingLoop(module, position) {
  const code = maskSource(module.source);
  const loops = [];
  for (const match of code.matchAll(/\bfor\s*\(/g)) {
    const opening = match.index + match[0].lastIndexOf("(");
    const closing = matchingClosing(code, opening);
    if (closing === -1) continue;
    const bodyOpening = code.indexOf("{", closing + 1);
    if (bodyOpening === -1 || bodyOpening - closing > 80) continue;
    const bodyClosing = matchingClosing(code, bodyOpening, "{", "}");
    if (bodyOpening < position && position < bodyClosing) {
      loops.push({
        bodyEnd: bodyClosing,
        bodyStart: bodyOpening + 1,
        header: module.source.slice(opening + 1, closing),
      });
    }
  }
  return loops.sort((left, right) => right.bodyStart - left.bodyStart)[0] ?? null;
}

function loopCount(header) {
  const classic = header.match(
    /^(?:let|var)\s+([A-Za-z_$]\w*)\s*=\s*(\d+)\s*;\s*\1\s*<\s*(\d+)\s*;\s*(?:\1\+\+|\+\+\1|\1\s*\+=\s*1)$/,
  );
  if (classic) return Number(classic[3]) - Number(classic[2]);
  const arrayFrom = header.match(
    /\bof\s+Array\.from\s*\(\s*\{\s*length\s*:\s*(\d+)\s*\}/,
  );
  if (arrayFrom) return Number(arrayFrom[1]);
  const literal = header.match(/\bof\s*\[([^\]]*)\]/);
  return literal
    ? splitTopLevel(literal[1]).filter(Boolean).length
    : null;
}

function inUnreachableBranch(module, position) {
  const code = maskSource(module.source);
  for (const match of code.matchAll(
    /\bif\s*\(\s*false\s*\)\s*\{|\bfor\s*\([^;]*;\s*false\s*;[^)]*\)\s*\{/g,
  )) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(code, opening, "{", "}");
    if (opening < position && position < closing) return true;
  }
  return false;
}

function buildAnalysis(workspace) {
  const prepared = prepareWorkspace(workspace);
  if (prepared.modules.length === 0) return null;
  const traceState = buildTraces(prepared);
  const resolver = createResolver(prepared, traceState);
  const operations = [];
  let order = 0;

  function addOwnerOperations(context, stack = new Set()) {
    if (stack.has(context.id)) return;
    const events = traceState.allCalls
      .filter(
        (call) =>
          call.owner === context.owner &&
          !inUnreachableBranch(call.module, call.index),
      )
      .sort((left, right) => left.index - right.index);
    for (const call of events) {
      if (call.target) {
        const child = traceState.traces.find(
          (candidate) =>
            candidate.owner === call.target &&
            candidate.root === context.root &&
            candidate.incoming === call,
        );
        if (child) addOwnerOperations(child, new Set(stack).add(context.id));
        continue;
      }
      const parts = call.name.split(".");
      if (parts.length < 2) continue;
      const method = parts.pop();
      const receiverExpression = parts.join(".");
      operations.push({
        ...call,
        argumentValues: call.arguments.map((argument) =>
          resolver.resolve(argument, context, call.index)
        ),
        context,
        method,
        order: order++,
        receiver: resolver.resolve(receiverExpression, context, call.index),
      });
    }
  }
  for (const root of traceState.roots) {
    const rootContext = traceState.traces.find(
      (context) => context.owner === root && context.root === root,
    );
    addOwnerOperations(rootContext);
  }
  return { operations, prepared, resolver, traceState };
}

function sameEnvironment(value, name) {
  return value?.kind === "environment" && value.name === name;
}

function entityKind(resource) {
  if (sameEnvironment(resource?.entity, "SERVICE_BUS_QUEUE_NAME")) {
    return "queue";
  }
  if (sameEnvironment(resource?.entity, "SERVICE_BUS_TOPIC_NAME")) {
    return resource.subscription ? "subscription" : "topic";
  }
  return null;
}

function sendOperations(analysis, kind) {
  return analysis.operations.filter(
    (operation) =>
      operation.method === "sendMessages" &&
      operation.awaited &&
      operation.receiver?.kind === "sender" &&
      entityKind(operation.receiver) === kind,
  );
}

function receiveOperations(analysis, kind) {
  return analysis.operations.filter(
    (operation) => {
      if (
        operation.method !== "receiveMessages" ||
        !operation.awaited ||
        operation.receiver?.kind !== "receiver" ||
        entityKind(operation.receiver) !== kind
      ) {
        return false;
      }
      const count = analysis.resolver.resolve(
        operation.arguments[0],
        operation.context,
        operation.index,
      );
      if (
        count?.kind === "number" &&
        (count.value <= 0 || count.value > 100)
      ) {
        return false;
      }
      const wait = objectPropertyFactAt(
        operation,
        operation.arguments[1] ?? "",
        "maxWaitTimeInMs",
      );
      const waitValue = wait
        ? analysis.resolver.resolve(
            wait.expression,
            operation.context,
            wait.position,
          )
        : analysis.resolver.resolve(
            operation.arguments[1] ?? "",
            operation.context,
            operation.index,
          )?.properties?.get("maxWaitTimeInMs");
      return waitValue?.kind === "number" && waitValue.value > 0;
    },
  );
}

function declarationForCall(operation) {
  const code = maskSource(operation.module.source, false);
  const prefix = code.slice(
    Math.max(operation.context.owner.bodyStart, operation.index - 500),
    operation.index,
  );
  return prefix.match(
    /(?:\b(?:const|let|var)\s+)?([A-Za-z_$]\w*)[^=;\n]*=\s*(?:await\s+)?$/,
  )?.[1] ?? null;
}

function consolePrintsBody(module, start, end, message) {
  return bodyPrintPositions(module, start, end, message).length > 0;
}

function bodyPrintPositions(module, start, end, message) {
  const fragment = maskSource(module.source.slice(start, end), false);
  const escaped = escapeRegExp(message);
  const pattern = new RegExp(
    `\\bconsole\\s*\\.\\s*(?:log|info)\\s*\\([\\s\\S]{0,300}?` +
      `\\b${escaped}\\s*\\.\\s*body\\b`,
    "g",
  );
  return [...fragment.matchAll(pattern)].map((match) => start + match.index);
}

function receivedMessagesSettled(analysis, receive) {
  const binding = declarationForCall(receive);
  if (!binding) return false;
  const code = maskSource(receive.module.source);
  const loopPattern = new RegExp(
    `\\bfor\\s*\\(\\s*(?:const|let|var)\\s+([A-Za-z_$]\\w*)\\s+of\\s+` +
      `${escapeRegExp(binding)}\\s*\\)\\s*\\{`,
    "g",
  );
  loopPattern.lastIndex = receive.end;
  const loop = loopPattern.exec(code);
  if (!loop) return false;
  const opening = loop.index + loop[0].lastIndexOf("{");
  const closing = matchingClosing(code, opening, "{", "}");
  const message = loop[1];
  const outputs = bodyPrintPositions(
    receive.module,
    opening + 1,
    closing,
    message,
  ).filter(
    (position) => !positionInsideExceptionalFlow(receive.module, position),
  );
  if (outputs.length === 0) return false;
  const flow = controlFlowInfo(receive.module, opening + 1, closing);
  const resolvedMaximum = analysis.resolver.resolve(
    receive.arguments[0],
    receive.context,
    receive.index,
  );
  const maximum =
    resolvedMaximum?.kind === "number" ? resolvedMaximum.value : null;
  const unconditionalBreak = [...code.slice(opening + 1, closing).matchAll(
    /\bbreak\s*;/g,
  )].some((match) => {
    const position = opening + 1 + match.index;
    const loopAtBreak = enclosingLoop(receive.module, position);
    return loopAtBreak?.bodyStart === opening + 1 &&
      flow.guardsAt(position).size === 0 &&
      !positionInsideExceptionalFlow(receive.module, position);
  });
  if ((maximum === null || maximum > 1) && unconditionalBreak) return false;
  const settlements = analysis.operations.filter(
    (operation) =>
      operation.module === receive.module &&
      opening < operation.index &&
      operation.index < closing &&
      ["completeMessage", "abandonMessage", "deadLetterMessage"].includes(
        operation.method,
      ) &&
      operation.awaited &&
      operation.receiver?.id === receive.receiver.id &&
      unwrap(operation.arguments[0]) === message &&
      !positionInsideExceptionalFlow(operation.module, operation.index),
  );
  const facts = settlements.map((operation) => ({
    operation,
    guards: flow.guardsAt(operation.index),
  }));
  if (
    facts.some((left, index) =>
      facts.slice(index + 1).some((right) =>
        pathsCompatible(left.guards, right.guards)
      )
    )
  ) {
    return false;
  }
  const outputFacts = outputs.map((position) => ({
    position,
    guards: flow.guardsAt(position),
  }));
  const completions = facts.filter(
    ({ operation }) => operation.method === "completeMessage",
  );
  return completions.length > 0 && completions.every(
    ({ operation, guards }) =>
      outputFacts.some(
        (output) =>
          output.position < operation.index &&
          pathCovers(output.guards, guards),
      ),
  );
}

function meaningfulFailureGuard(operation, resultName = null) {
  const source = operation.module.source;
  const code = maskSource(source);
  const after = code.slice(operation.end, Math.min(code.length, operation.end + 500));
  const directPrefix = code.slice(
    Math.max(operation.context.owner.bodyStart, operation.index - 80),
    operation.index,
  );
  const direct =
    /\bif\s*\(\s*!\s*$/.test(directPrefix) &&
    /^\s*\)\s*\{?[\s\S]{0,240}?\b(?:throw|return)\b/.test(
      after,
    );
  if (direct) return true;
  if (!resultName) return false;
  const escaped = escapeRegExp(resultName);
  return new RegExp(
    `\\bif\\s*\\(\\s*(?:!\\s*${escaped}\\b|${escaped}\\s*={2,3}\\s*false)` +
    `[^)]*\\)\\s*\\{?[\\s\\S]{0,240}?\\b(?:throw|return)\\b`,
  ).test(code.slice(operation.end, operation.context.owner.bodyEnd));
}

function controlFlowInfo(module, start, end) {
  const code = maskSource(module.source);
  const branches = [];
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    if (match.index < start || match.index >= end) continue;
    const conditionOpen = match.index + match[0].lastIndexOf("(");
    const conditionClose = matchingClosing(code, conditionOpen);
    if (conditionClose < 0) continue;
    let opening = conditionClose + 1;
    while (/\s/.test(code[opening] ?? "")) opening += 1;
    const braced = code[opening] === "{";
    const closing = braced
      ? matchingClosing(code, opening, "{", "}")
      : expressionEnd(code, opening);
    if (closing < 0) continue;
    const branch = {
      conditionEnd: conditionClose,
      conditionStart: conditionOpen + 1,
      falseEnd: -1,
      falseStart: -1,
      id: match.index,
      trueEnd: closing,
      trueStart: braced ? opening + 1 : opening,
    };
    let cursor = closing + 1;
    while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    if (code.slice(cursor, cursor + 4) === "else") {
      cursor += 4;
      while (/\s/.test(code[cursor] ?? "")) cursor += 1;
      if (code[cursor] === "{") {
        branch.falseStart = cursor + 1;
        branch.falseEnd = matchingClosing(code, cursor, "{", "}");
      } else {
        branch.falseStart = cursor;
        branch.falseEnd = expressionEnd(code, cursor);
      }
    }
    branches.push(branch);
  }
  const guardsAt = (position) => {
    const guards = new Map();
    for (const branch of branches) {
      if (branch.trueStart <= position && position < branch.trueEnd) {
        guards.set(branch.id, true);
      } else if (
        branch.falseStart <= position &&
        position < branch.falseEnd
      ) {
        guards.set(branch.id, false);
      }
    }
    return guards;
  };
  const terminations = [];
  const region = code.slice(start, end);
  for (const match of region.matchAll(/\b(?:throw|return)\b/g)) {
    const position = start + match.index;
    terminations.push({ guards: guardsAt(position), position });
  }
  return { branches, guardsAt, terminations };
}

function pathsCompatible(left, right) {
  return [...left].every(
    ([id, side]) => !right.has(id) || right.get(id) === side,
  );
}

function pathCovers(prior, later) {
  return [...prior].every(([id, side]) => later.get(id) === side);
}

function queueBatch(analysis) {
  const creates = analysis.operations.filter(
    (operation) =>
      operation.method === "createMessageBatch" &&
      operation.awaited &&
      operation.receiver?.kind === "sender" &&
      entityKind(operation.receiver) === "queue",
  );
  const queueSends = sendOperations(analysis, "queue").filter(
    (operation) => operation.argumentValues[0]?.kind === "batch",
  );
  if (queueSends.length === 0) return false;
  for (const send of queueSends) {
    const create = creates.find(
      (candidate) =>
        candidate.order < send.order &&
        candidate.receiver.id === send.receiver.id &&
        candidate.context.root === send.context.root &&
        (() => {
          const name = declarationForCall(candidate);
          return name &&
            analysis.resolver.resolve(
              name,
              candidate.context,
              candidate.end + 1,
            )?.id === send.argumentValues[0]?.id;
        })(),
    );
    if (!create) return false;
    const batchName = declarationForCall(create);
    if (!batchName) return false;
    const batch = create.context &&
      analysis.resolver.resolve(batchName, create.context, create.end + 1);
    if (
      batch?.id !== send.argumentValues[0]?.id ||
      create.receiver.id !== send.receiver.id
    ) {
      return false;
    }
    const adds = analysis.operations.filter(
      (operation) =>
        operation.method === "tryAddMessage" &&
        operation.receiver?.kind === "batch" &&
        operation.receiver.id === batch?.id &&
        operation.context.root === create.context.root &&
        operation.order > create.order &&
        operation.order < send.order,
    );
    if (adds.length === 0) return false;
    const flow = controlFlowInfo(
      create.module,
      create.index,
      send.end,
    );
    const addFacts = [];
    for (const add of adds) {
      const loop = enclosingLoop(add.module, add.index);
      const multiplier = loop ? loopCount(loop.header) : 1;
      const message = add.argumentValues[0];
      const newInsideLoop =
        !loop ||
        (
          message?.kind === "message" &&
          loop.bodyStart <= message.origin &&
          message.origin < loop.bodyEnd
        );
      const result = declarationForCall(add);
      if (
        multiplier === null ||
        multiplier <= 0 ||
        message?.kind !== "message" ||
        !newInsideLoop ||
        !meaningfulFailureGuard(add, result)
      ) {
        return false;
      }
      const guards = flow.guardsAt(add.index);
      for (const branch of flow.branches) {
        if (
          branch.conditionStart <= add.index &&
          add.index < branch.conditionEnd
        ) {
          const condition = maskSource(
            add.module.source.slice(
              branch.conditionStart,
              branch.conditionEnd,
            ),
            false,
          );
          if (
            /!\s*[A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*\s*\.\s*tryAddMessage/.test(
              condition,
            )
          ) {
            guards.set(branch.id, false);
          }
        }
      }
      addFacts.push({ add, guards, message, multiplier });
    }
    const sendGuards = flow.guardsAt(send.index);
    const branchIds = new Set([
      ...sendGuards.keys(),
      ...addFacts.flatMap(({ guards }) => [...guards.keys()]),
      ...flow.terminations.flatMap(({ guards }) => [...guards.keys()]),
    ]);
    const ids = [...branchIds];
    let reached = false;
    for (let mask = 0; mask < 2 ** ids.length; mask += 1) {
      const path = new Map(
        ids.map((id, index) => [id, Boolean(mask & (1 << index))]),
      );
      if (!pathCovers(sendGuards, path)) continue;
      if (
        flow.terminations.some(
          ({ guards, position }) =>
            position < send.index && pathCovers(guards, path),
        )
      ) {
        continue;
      }
      reached = true;
      const pathAdds = addFacts.filter(({ guards }) => pathCovers(guards, path));
      const count = pathAdds.reduce(
        (total, { multiplier }) => total + multiplier,
        0,
      );
      const explicitIds = pathAdds
        .filter(({ multiplier }) => multiplier === 1)
        .map(({ message }) => message.id);
      if (
        count !== 5 ||
        new Set(explicitIds).size !== explicitIds.length
      ) {
        return false;
      }
    }
    if (!reached) return false;
  }
  return true;
}

function objectInitializer(module, name, position) {
  const code = maskSource(module.source, false);
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+${escapeRegExp(name)}[^=;\\n]*=\\s*\\{`,
    "g",
  );
  let selected = null;
  for (const match of code.matchAll(pattern)) {
    if (match.index >= position) break;
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(code, opening, "{", "}");
    selected = module.source.slice(opening + 1, closing);
  }
  return selected;
}

function propertyExpression(object, property) {
  const code = maskSource(object, false);
  const match = new RegExp(
    `(?:^|,)\\s*${escapeRegExp(property)}\\s*:\\s*`,
    "m",
  ).exec(code);
  if (match) {
    const start = match.index + match[0].length;
    return object.slice(start, expressionEnd(code, start)).replace(/,\s*$/, "");
  }
  return new RegExp(`(?:^|,)\\s*${escapeRegExp(property)}\\s*(?=,|$)`)
      .test(code)
    ? property
    : null;
}

function objectPropertyFactAt(operation, expression, property) {
  const value = unwrap(expression);
  if (!/^[A-Za-z_$]\w*$/.test(value)) {
    const object = value.startsWith("{") && value.endsWith("}")
      ? value.slice(1, -1)
      : value;
    const propertyValue = propertyExpression(object, property);
    return propertyValue === null
      ? null
      : { expression: propertyValue, position: operation.index };
  }

  const source = operation.module.source;
  const code = maskSource(source, false);
  const variables = new Map();
  const objects = new Map();
  const events = [];
  const assignments =
    /\b(?:(?:const|let|var)\s+)?([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=(?!=|>)/g;
  for (const match of code.matchAll(assignments)) {
    if (
      match.index < operation.context.owner.bodyStart ||
      match.index >= operation.index ||
      ownerAt(operation.module, match.index) !== operation.context.owner
    ) {
      continue;
    }
    const equals = match.index + match[0].lastIndexOf("=");
    events.push({
      expression: source.slice(
        equals + 1,
        expressionEnd(code, equals + 1),
      ).trim(),
      index: match.index,
      kind: "assign",
      name: match[1],
    });
  }
  const mutations = new RegExp(
    `\\b([A-Za-z_$]\\w*)\\s*\\.\\s*${escapeRegExp(property)}` +
      `\\s*=(?!=|>)\\s*([^;\\n]+)`,
    "g",
  );
  for (const match of code.matchAll(mutations)) {
    if (
      match.index < operation.context.owner.bodyStart ||
      match.index >= operation.index ||
      ownerAt(operation.module, match.index) !== operation.context.owner
    ) {
      continue;
    }
    events.push({
      expression: source.slice(
        match.index + match[0].indexOf(match[2]),
        match.index + match[0].length,
      ).trim(),
      index: match.index,
      kind: "property",
      name: match[1],
    });
  }
  events.sort((left, right) => left.index - right.index);
  for (const event of events) {
    if (event.kind === "property") {
      const objectId = variables.get(event.name);
      if (objectId) {
        objects.get(objectId).set(property, {
          expression: unwrap(event.expression),
          position: event.index,
        });
      }
      continue;
    }
    const object = unwrap(event.expression);
    if (object.startsWith("{")) {
      const opening = event.expression.indexOf("{");
      const body = balancedText(event.expression, opening, "{", "}");
      const objectId = `object:${event.index}`;
      const properties = new Map();
      const propertyValue = propertyExpression(body, property);
      if (propertyValue !== null) {
        properties.set(property, {
          expression: unwrap(propertyValue),
          position: event.index,
        });
      }
      objects.set(objectId, properties);
      variables.set(event.name, objectId);
    } else if (/^[A-Za-z_$]\w*$/.test(object)) {
      variables.set(event.name, variables.get(object) ?? null);
    } else {
      variables.set(event.name, null);
    }
  }
  const objectId = variables.get(value);
  return objectId ? objects.get(objectId)?.get(property) ?? null : null;
}

function objectPropertyAt(operation, expression, property) {
  return objectPropertyFactAt(operation, expression, property)?.expression ??
    null;
}

function resolveHandler(analysis, operation, expression, property) {
  let object = unwrap(expression);
  if (/^[A-Za-z_$]\w*$/.test(object)) {
    object = objectInitializer(operation.module, object, operation.index) ?? "";
  }
  if (!object.startsWith("{")) object = `{${object}}`;
  const propertyValue = propertyExpression(
    object.slice(1, object.endsWith("}") ? -1 : undefined),
    property,
  );
  if (!propertyValue) return null;
  const name = unwrap(propertyValue);
  const callable = operation.module.callables.find(
    (candidate) =>
      candidate.kind === "function" && candidate.name === name,
  );
  if (callable) return callable;
  const arrow = propertyValue.match(
    /(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$]\w*))\s*(?::[^=]+)?=>\s*\{/,
  );
  if (!arrow) return null;
  const opening = propertyValue.indexOf("{", arrow.index);
  const body = balancedText(propertyValue, opening, "{", "}");
  return {
    bodyEnd: body.length,
    bodySource: body,
    bodyStart: 0,
    module: { source: body },
    parameters: splitTopLevel(arrow[1] ?? arrow[2] ?? "").map((parameter) =>
      parameter.match(/^([A-Za-z_$]\w*)/)?.[1]
    ).filter(Boolean),
  };
}

function handlerReportsError(handler) {
  const body = handler.bodySource ??
    handler.module.source.slice(handler.bodyStart, handler.bodyEnd);
  const parameter = handler.parameters[0];
  return Boolean(
    parameter &&
    new RegExp(
      `\\bconsole\\s*\\.\\s*(?:error|warn|log)\\s*\\([\\s\\S]{0,240}?` +
        `\\b${escapeRegExp(parameter)}(?:\\s*\\.\\s*error)?\\b`,
    ).test(maskSource(body, false)),
  );
}

function handlerProcessesMessage(analysis, handler, subscribe) {
  const body = handler.bodySource ??
    handler.module.source.slice(handler.bodyStart, handler.bodyEnd);
  const message = handler.parameters[0];
  if (!message) return false;
  const bodyModule = { source: body };
  const outputs = bodyPrintPositions(bodyModule, 0, body.length, message)
    .filter((position) => !positionInsideExceptionalFlow(bodyModule, position));
  if (outputs.length === 0) return false;
  const escaped = escapeRegExp(message);
  const completes = [...maskSource(body, false).matchAll(new RegExp(
    `\\bawait\\s+([A-Za-z_$]\\w*(?:\\.[A-Za-z_$]\\w*)*)` +
      `\\s*\\.\\s*completeMessage\\s*\\(\\s*${escaped}\\s*\\)`,
    "g",
  ))].filter((complete) =>
    !positionInsideExceptionalFlow(bodyModule, complete.index)
  );
  const flow = controlFlowInfo(bodyModule, 0, body.length);
  const complete = completes.find((candidate) =>
    outputs.some((output) =>
      output < candidate.index &&
      pathCovers(flow.guardsAt(output), flow.guardsAt(candidate.index))
    )
  );
  if (!complete) {
    return false;
  }
  if (handler.bodySource) {
    return /^(?:processor|receiver|this\.processor)$/.test(complete[1]);
  }
  const context = analysis.traceState.traces.find(
    (candidate) =>
      candidate.owner === handler &&
      candidate.root === subscribe.context.root,
  );
  const value = context
    ? analysis.resolver.resolve(complete[1], context, handler.bodyStart)
    : analysis.resolver.resolve(
        complete[1],
        subscribe.context,
        subscribe.index,
      );
  return value?.id === subscribe.receiver.id;
}

function boundedWaitBetween(analysis, subscribe, close) {
  return analysis.operations.some(
    (operation) =>
      operation.context.root === subscribe.context.root &&
      operation.order > subscribe.order &&
      operation.order < close.order &&
      operation.awaited &&
      /^(?:wait|delay|sleep|setTimeout)$/.test(operation.method) &&
      numericLiteral(operation.arguments[0]) > 0,
  ) || (() => {
    const source = subscribe.module.source.slice(subscribe.end, close.index);
    const code = maskSource(source, false);
    return (
      /\bawait\s+new\s+Promise\s*\([\s\S]*?setTimeout\s*\([^,]+,\s*[\d_]+\s*\)/.test(
        code,
      ) ||
      /\bawait\s+(?:wait|delay|sleep)\w*\s*\(\s*[\d_]+\s*\)/i.test(code)
    );
  })();
}

function processorHandlers(analysis) {
  const subscriptions = analysis.operations.filter(
    (operation) =>
      operation.method === "subscribe" &&
      operation.receiver?.kind === "receiver" &&
      entityKind(operation.receiver) === "queue",
  );
  for (const subscribe of subscriptions) {
    const messageHandler = resolveHandler(
      analysis,
      subscribe,
      subscribe.arguments[0],
      "processMessage",
    );
    const errorHandler = resolveHandler(
      analysis,
      subscribe,
      subscribe.arguments[0],
      "processError",
    );
    if (
      !messageHandler ||
      !errorHandler ||
      !subscribeDisablesAutoComplete(subscribe) ||
      !handlerProcessesMessage(analysis, messageHandler, subscribe) ||
      !handlerReportsError(errorHandler)
    ) {
      continue;
    }

    function subscribeDisablesAutoComplete(subscribe) {
      return unwrap(
        objectPropertyAt(
          subscribe,
          subscribe.arguments[1] ?? "",
          "autoCompleteMessages",
        ) ?? "",
      ) === "false";
    }
    const subscriptionName = declarationForCall(subscribe);
    if (!subscriptionName) continue;
    const subscription = analysis.resolver.resolve(
      subscriptionName,
      subscribe.context,
      subscribe.end + 1,
    );
    const closeSubscription = analysis.operations.find(
      (operation) =>
        operation.method === "close" &&
        operation.order > subscribe.order &&
        operation.receiver?.kind === "subscription" &&
        operation.receiver.id === subscription?.id,
    );
    const closeProcessor = analysis.operations.find(
      (operation) =>
        operation.method === "close" &&
        operation.receiver?.id === subscribe.receiver.id &&
        (
          operation.awaited ||
          positionInsideAllSettled(operation.module, operation.index)
        ),
    );
    if (
      closeSubscription &&
      (
        closeSubscription.awaited ||
        positionInsideAllSettled(
          closeSubscription.module,
          closeSubscription.index,
        )
      ) &&
      closeProcessor &&
      (
        closeProcessor.awaited ||
        positionInsideAllSettled(closeProcessor.module, closeProcessor.index)
      ) &&
      closeSubscription.order < closeProcessor.order &&
      boundedWaitBetween(analysis, subscribe, closeSubscription)
    ) {
      return true;
    }
  }
  return false;
}

function positionInsideFinally(module, position) {
  const code = maskSource(module.source);
  for (const match of code.matchAll(/\bfinally\s*\{/g)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(code, opening, "{", "}");
    if (opening < position && position < closing) return true;
  }
  return false;
}

function positionInsideExceptionalFlow(module, position) {
  const code = maskSource(module.source);
  for (const pattern of [
    /\bcatch(?:\s*\([^)]*\))?\s*\{/g,
    /\bfinally\s*\{/g,
  ]) {
    for (const match of code.matchAll(pattern)) {
      const opening = match.index + match[0].lastIndexOf("{");
      const closing = matchingClosing(code, opening, "{", "}");
      if (opening < position && position < closing) return true;
    }
  }
  return false;
}

function tryFinallyContainers(module) {
  const code = maskSource(module.source);
  const containers = [];
  for (const match of code.matchAll(/\btry\s*\{/g)) {
    const tryOpening = match.index + match[0].lastIndexOf("{");
    const tryClosing = matchingClosing(code, tryOpening, "{", "}");
    if (tryClosing < 0) continue;
    let cursor = tryClosing + 1;
    let finallyOpening = -1;
    let finallyClosing = -1;
    while (cursor < code.length) {
      while (/\s/.test(code[cursor] ?? "")) cursor += 1;
      if (code.slice(cursor, cursor + 5) === "catch") {
        const catchOpening = code.indexOf("{", cursor + 5);
        if (catchOpening < 0) break;
        cursor = matchingClosing(code, catchOpening, "{", "}") + 1;
        continue;
      }
      if (code.slice(cursor, cursor + 7) === "finally") {
        finallyOpening = code.indexOf("{", cursor + 7);
        finallyClosing = matchingClosing(
          code,
          finallyOpening,
          "{",
          "}",
        );
      }
      break;
    }
    if (finallyOpening >= 0 && finallyClosing >= 0) {
      containers.push({
        finallyClosing,
        finallyOpening,
        tryClosing,
        tryOpening,
      });
    }
  }
  return containers;
}

function operationRunsInFinally(operation, container, analysis) {
  if (
    operation.module === container.module &&
    container.finallyOpening < operation.index &&
    operation.index < container.finallyClosing
  ) {
    return true;
  }
  let context = operation.context;
  const seen = new Set();
  while (context?.incoming && !seen.has(context.id)) {
    seen.add(context.id);
    const call = context.incoming;
    if (
      call.module === container.module &&
      container.finallyOpening < call.index &&
      call.index < container.finallyClosing
    ) {
      return true;
    }
    context = analysis.traceState.traces.find(
      (candidate) =>
        candidate.owner === call.owner &&
        candidate.root === context.root,
    );
  }
  return false;
}

function resourceProtectedByClose(resource, close, analysis) {
  const locations = [];
  if (resource.module) {
    locations.push({
      context: resource.context,
      index: resource.origin,
      module: resource.module,
    });
  }
  let context = resource.context;
  const seen = new Set();
  while (context?.incoming && !seen.has(context.id)) {
    seen.add(context.id);
    locations.push({
      context,
      index: context.incoming.index,
      module: context.incoming.module,
    });
    context = analysis.traceState.traces.find(
      (candidate) =>
        candidate.owner === context.incoming.owner &&
        candidate.root === context.root,
    );
  }
  return locations.some((location) =>
    tryFinallyContainers(location.module)
      .filter(
        (container) =>
          container.tryOpening < location.index &&
          location.index < container.tryClosing,
      )
      .map((container) => ({ ...container, module: location.module }))
      .some((container) =>
        operationRunsInFinally(close, container, analysis)
      )
  );
}

function finallyContainers(module, position) {
  const code = maskSource(module.source);
  const containers = [];
  for (const match of code.matchAll(/\bfinally\s*\{/g)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(code, opening, "{", "}");
    if (opening < position && position < closing) containers.push(opening);
  }
  return containers;
}

function positionInsideAllSettled(module, position) {
  const code = maskSource(module.source);
  for (const match of code.matchAll(/\bPromise\s*\.\s*allSettled\s*\(/g)) {
    const opening = match.index + match[0].lastIndexOf("(");
    const closing = matchingClosing(code, opening);
    if (opening < position && position < closing) return true;
  }
  return false;
}

function insideFinally(operation, analysis) {
  if (positionInsideFinally(operation.module, operation.index)) return true;
  let context = operation.context;
  const seen = new Set();
  while (context?.incoming && !seen.has(context.id)) {
    seen.add(context.id);
    const call = context.incoming;
    if (positionInsideFinally(call.module, call.index)) return true;
    context = analysis.traceState.traces.find(
      (candidate) =>
        candidate.owner === call.owner &&
        candidate.root === context.root,
    );
  }
  return false;
}

function lifecycleValid(analysis) {
  const resources = new Map();
  for (const context of analysis.traceState.traces) {
    const code = maskSource(context.owner.module.source, false);
    const declarations =
      /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=(?!=|>)/g;
    for (const match of code.matchAll(declarations)) {
      if (
        match.index < context.owner.bodyStart ||
        match.index >= context.owner.bodyEnd ||
        ownerAt(context.owner.module, match.index) !== context.owner
      ) {
        continue;
      }
      const value = analysis.resolver.resolve(
        match[1],
        context,
        expressionEnd(code, match.index + match[0].length) + 1,
      );
      if (
        ["client", "sender", "receiver", "processor", "subscription"].includes(
          value?.kind,
        )
      ) {
        resources.set(value.id, value);
      }
    }
  }
  for (const operation of analysis.operations) {
    if (
      ["sendMessages", "receiveMessages", "subscribe"].includes(operation.method) &&
      operation.receiver?.id
    ) {
      resources.set(operation.receiver.id, operation.receiver);
    }
    if (
      ["createSender", "createReceiver", "createProcessor"].includes(
        operation.method,
      )
    ) {
      const name = declarationForCall(operation);
      const resource = name &&
        analysis.resolver.resolve(
          name,
          operation.context,
          operation.end + 1,
        );
      if (resource?.id) resources.set(resource.id, resource);
    }
    if (operation.method === "subscribe") {
      const name = declarationForCall(operation);
      const subscription = name && analysis.resolver.resolve(
        name,
        operation.context,
        operation.end + 1,
      );
      if (subscription?.id) resources.set(subscription.id, subscription);
    }
  }
  const clients = [...resources.values()].filter(
    (resource) => resource.kind === "client",
  );
  const closes = analysis.operations.filter(
    (operation) =>
      operation.method === "close" &&
      (
        operation.awaited ||
        positionInsideAllSettled(operation.module, operation.index)
      ) &&
      insideFinally(operation, analysis),
  );
  if (clients.length === 0) return false;
  const closeGroups = new Map();
  for (const close of closes) {
    const key = `${close.module.path ?? ""}:${close.context.root.id ?? close.context.root.name ?? "root"}`;
    if (!closeGroups.has(key)) closeGroups.set(key, []);
    closeGroups.get(key).push(close);
  }
  for (const group of closeGroups.values()) {
    const sequential = group.filter(
      (close) => !positionInsideAllSettled(close.module, close.index),
    );
    for (let index = 0; index < sequential.length; index += 1) {
      const left = sequential[index];
      const leftContainers = finallyContainers(left.module, left.index);
      for (const right of sequential.slice(index + 1)) {
        const rightContainers = finallyContainers(right.module, right.index);
        if (
          left.module === right.module &&
          leftContainers.length === rightContainers.length &&
          leftContainers.every(
            (container, containerIndex) =>
              container === rightContainers[containerIndex],
          )
        ) {
          return false;
        }
      }
    }
  }
  for (const client of clients) {
    const childIds = new Set(
      [...resources.values()]
        .filter((resource) => resource.clientId === client.id)
        .map((resource) => resource.id),
    );
    const clientLastUse = analysis.operations
      .filter(
        (operation) =>
          operation.method !== "close" &&
          (
            operation.receiver?.id === client.id ||
            childIds.has(operation.receiver?.id)
          ),
      )
      .reduce((last, operation) => Math.max(last, operation.order), -1);
    if (analysis.operations.some(
      (operation) =>
        operation.method === "close" &&
        operation.receiver?.id === client.id &&
        operation.order <= clientLastUse,
    )) {
      return false;
    }
    const clientClose = closes.find(
      (operation) => operation.receiver?.id === client.id,
    );
    if (!clientClose) return false;
    const children = [...resources.values()].filter(
      (resource) => resource.clientId === client.id,
    );
    for (const child of children) {
      const lastUse = analysis.operations
        .filter(
          (operation) =>
            operation.receiver?.id === child.id &&
            operation.method !== "close",
        )
        .reduce(
          (last, operation) => Math.max(last, operation.order),
          -1,
        );
      if (analysis.operations.some(
        (operation) =>
          operation.method === "close" &&
          operation.receiver?.id === child.id &&
          operation.order <= lastUse,
      )) {
        return false;
      }
      const childClose = closes.find(
        (operation) =>
          operation.receiver?.id === child.id &&
          operation.order < clientClose.order,
      );
      if (!childClose) return false;
      if (!resourceProtectedByClose(child, childClose, analysis)) return false;
      if (childClose.order <= lastUse) return false;
      for (const subscription of [...resources.values()].filter(
        (resource) =>
          resource.kind === "subscription" &&
          resource.receiverId === child.id,
      )) {
        const subscriptionClose = closes.find(
          (operation) => operation.receiver?.id === subscription.id,
        );
        if (!subscriptionClose || subscriptionClose.order >= childClose.order) {
          return false;
        }
      }
    }
  }
  return true;
}

function analyses(workspace) {
  const analysis = buildAnalysis(workspace);
  return analysis ? [analysis] : [];
}

const rules = {
  "prompt/packages": (workspace) => {
    if (sourceDocuments(workspace).length === 0) return false;
    const dependencies = activeDependencies(workspace.packageJson);
    return ["@azure/identity", "@azure/service-bus"].every(
      (name) => typeof dependencies[name] === "string",
    );
  },
  "prompt/environment-client": (workspace) =>
    analyses(workspace).some((analysis) =>
      analysis.operations.some((operation) =>
        ["sendMessages", "receiveMessages", "subscribe"].includes(
          operation.method,
        ) &&
        operation.receiver?.clientId
      )
    ),
  "prompt/queue-single": (workspace) =>
    analyses(workspace).some((analysis) =>
      sendOperations(analysis, "queue").some(
        (operation) =>
          operation.argumentValues[0]?.kind === "message" ||
          (
            /^\s*\{[\s\S]*\}\s*$/.test(operation.arguments[0] ?? "") &&
            /\bbody\s*:/.test(operation.arguments[0])
          ),
      )
    ),
  "prompt/queue-batch": (workspace) =>
    analyses(workspace).some(queueBatch),
  "prompt/queue-receive": (workspace) =>
    analyses(workspace).some((analysis) =>
      receiveOperations(analysis, "queue").some((receive) =>
        receivedMessagesSettled(analysis, receive)
      )
    ),
  "prompt/processor-handlers": (workspace) =>
    analyses(workspace).some(processorHandlers),
  "prompt/topic-send": (workspace) =>
    analyses(workspace).some((analysis) =>
      sendOperations(analysis, "topic").some(
        (operation) =>
          operation.argumentValues[0]?.kind === "message" ||
          /\bbody\s*:/.test(operation.arguments[0]),
      )
    ),
  "prompt/subscription-receive": (workspace) =>
    analyses(workspace).some((analysis) =>
      receiveOperations(analysis, "subscription").some((receive) =>
        sameEnvironment(
          receive.receiver.subscription,
          "SERVICE_BUS_SUBSCRIPTION_NAME",
        ) && receivedMessagesSettled(analysis, receive)
      )
    ),
  "prompt/client-lifecycle": (workspace) =>
    analyses(workspace).some(lifecycleValid),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  return rule(workspace);
}

export function ruleNames() {
  return Object.keys(rules);
}
