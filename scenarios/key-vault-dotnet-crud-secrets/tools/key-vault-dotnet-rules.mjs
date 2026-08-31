import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const sdkNamespaces = new Map([
  ["DefaultAzureCredential", "Azure.Identity"],
  ["DeleteSecretOperation", "Azure.Security.KeyVault.Secrets"],
  ["KeyVaultSecret", "Azure.Security.KeyVault.Secrets"],
  ["RequestFailedException", "Azure"],
  ["Response", "Azure"],
  ["SecretClient", "Azure.Security.KeyVault.Secrets"],
  ["Uri", "System"],
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchingDelimiter(source, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close && --depth === 0) return index;
  }
  return -1;
}

function stripOuterParentheses(expression) {
  let result = expression.trim();
  while (result.startsWith("(")) {
    const close = matchingDelimiter(result, 0, "(", ")");
    if (close !== result.length - 1) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function splitArguments(source) {
  const result = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (
      character === "," &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      result.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = source.slice(start).trim();
  if (final) result.push(final);
  return result;
}

function namedArgument(expression) {
  const match = /^\s*(\w+)\s*:\s*([\s\S]+)$/.exec(expression);
  return match
    ? { name: match[1].toLowerCase(), expression: match[2].trim() }
    : { name: null, expression: expression.trim() };
}

function literalAwareCode(source) {
  const characters = [...dotnetCodeOnly(source)];
  const literals = new Map();
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      index += 1;
      state = "line-comment";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 1;
      state = "block-comment";
      continue;
    }
    if (character === "'") {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === "'") break;
      }
      continue;
    }
    if (character !== '"') continue;

    const interpolated =
      source[index - 1] === "$" ||
      (source[index - 1] === "@" && source[index - 2] === "$") ||
      (source[index - 1] === "$" && source[index - 2] === "@");
    if (source.startsWith('"""', index)) {
      const delimiter = source.startsWith('"""', index) ? '"""' : '"';
      const closeIndex = source.indexOf(delimiter, index + delimiter.length);
      if (closeIndex >= 0) index = closeIndex + delimiter.length - 1;
      continue;
    }

    const verbatim = source[index - 1] === "@";
    const contentStart = index + 1;
    let value = "";
    let closeIndex = -1;
    for (let cursor = contentStart; cursor < source.length; cursor += 1) {
      if (verbatim && source[cursor] === '"' && source[cursor + 1] === '"') {
        value += '"';
        cursor += 1;
      } else if (!verbatim && source[cursor] === "\\") {
        const escaped = source[cursor + 1] ?? "";
        value +=
          { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' }[escaped] ??
          escaped;
        cursor += 1;
      } else if (source[cursor] === '"') {
        closeIndex = cursor;
        break;
      } else {
        value += source[cursor];
      }
    }
    if (closeIndex < 0) continue;
    const width = closeIndex - contentStart;
    if (width > 0) {
      let marker = `L${literals.size}`.padEnd(width, "_").slice(0, width);
      if (interpolated) {
        const visible = [...marker];
        const rawContent = source.slice(contentStart, closeIndex);
        for (const match of rawContent.matchAll(/\{([^{}]+)\}/g)) {
          visible[match.index] = " ";
          for (let offset = 0; offset < match[1].length; offset += 1) {
            visible[match.index + 1 + offset] = match[1][offset];
          }
          visible[match.index + match[0].length - 1] = " ";
        }
        marker = visible.join("");
      }
      for (let offset = 0; offset < width; offset += 1) {
        characters[contentStart + offset] = marker[offset];
      }
      if (interpolated) {
        const parts = [];
        let text = "";
        for (let cursor = 0; cursor < value.length; cursor += 1) {
          if (value[cursor] === "{" && value[cursor + 1] === "{") {
            text += "{";
            cursor += 1;
          } else if (value[cursor] === "}" && value[cursor + 1] === "}") {
            text += "}";
            cursor += 1;
          } else if (value[cursor] === "{") {
            if (text) parts.push({ kind: "text", value: text });
            text = "";
            const close = value.indexOf("}", cursor + 1);
            if (close < 0) {
              parts.push({ kind: "dynamic" });
              break;
            }
            parts.push({
              expression: value.slice(cursor + 1, close).split(/[,:]/, 1)[0],
              kind: "expression",
            });
            cursor = close;
          } else {
            text += value[cursor];
          }
        }
        if (text) parts.push({ kind: "text", value: text });
        literals.set(marker, { interpolation: parts });
      } else {
        literals.set(marker, value);
      }
    }
    index = closeIndex;
  }
  return { code: characters.join(""), literals };
}

function typeContext(code) {
  const aliases = new Map();
  const imports = new Set();
  for (const match of code.matchAll(
    /\b(?:global\s+)?using\s+(\w+)\s*=\s*((?:global::)?[\w.]+)\s*;/g,
  )) {
    aliases.set(match[1], match[2].replace(/^global::/, ""));
  }
  for (const match of code.matchAll(
    /\b(?:global\s+)?using\s+((?:global::)?[\w.]+)\s*;/g,
  )) {
    imports.add(match[1].replace(/^global::/, ""));
  }
  const localTypes = new Set(
    [...code.matchAll(
      /\b(?:class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+(\w+)/g,
    )].map((match) => match[1]),
  );
  return { aliases, imports, localTypes };
}

function canonicalType(type, types) {
  if (!type) return null;
  let normalized = type
    .replace(/\s+/g, "")
    .replace(/^global::/, "")
    .replace(/[?[\]]+$/g, "")
    .replace(/<[\s\S]*>$/, "");
  const first = normalized.split(/[.:]/)[0];
  if (types.aliases.has(first)) {
    normalized = normalized.replace(first, types.aliases.get(first));
  }
  if (types.aliases.has(normalized)) normalized = types.aliases.get(normalized);
  const simple = normalized.split(/[.:]/).at(-1);
  const namespace = sdkNamespaces.get(simple);
  if (!namespace) return null;
  if (normalized === `${namespace}.${simple}`) return simple;
  if (normalized !== simple) return null;
  if (simple === "Uri") {
    return types.localTypes.has(simple) ? null : simple;
  }
  return types.imports.has(namespace) && !types.localTypes.has(simple)
    ? simple
    : null;
}

function accessPath(expression) {
  const normalized = stripOuterParentheses(expression)
    .replace(/\s+/g, "")
    .replace(/^this\./, "");
  return /^\w+(?:\.\w+)*$/.test(normalized) ? normalized : null;
}

function typeRanges(code) {
  const ranges = [];
  const pattern =
    /\b(?:class|struct|record(?:\s+(?:class|struct))?)\s+(\w+)[^{;]*\{/g;
  for (const match of code.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(code, open, "{", "}");
    if (close >= 0) {
      let start = match.index;
      while (start > 0 && !/[;{}\n]/.test(code[start - 1])) start -= 1;
      ranges.push({ name: match[1], start, open, close });
    }
  }
  return ranges;
}

function containingType(ranges, index) {
  return ranges
    .filter((range) => range.open < index && index < range.close)
    .sort((left, right) => right.open - left.open)[0]?.name ?? null;
}

function methodDefinitions(code, ranges) {
  const methods = new Map();
  const ignored = new Set([
    "catch",
    "do",
    "else",
    "for",
    "foreach",
    "if",
    "lock",
    "switch",
    "using",
    "while",
  ]);
  const pattern =
    /\b((?:(?:public|private|protected|internal|static|virtual|override|sealed|new|unsafe|extern|async|partial)\s+)*)(?:([\w.:<>\[\]?]+)\s+)?(\w+)\s*\(([^()]*)\)\s*(=>|\{)/g;
  let id = 0;
  for (const match of code.matchAll(pattern)) {
    if (ignored.has(match[3])) continue;
    const owner = containingType(ranges, match.index);
    const isConstructor = owner !== null && match[3] === owner && !match[2];
    if (!match[2] && !isConstructor) continue;
    const parameters = splitArguments(match[4]).map((parameter) => {
      const withoutAttributes = parameter.replace(/\[[^\]]*\]/g, "").trim();
      const equals = withoutAttributes.indexOf("=");
      const declaration = equals < 0
        ? withoutAttributes
        : withoutAttributes.slice(0, equals).trim();
      const parsed =
        /(?:(?:this|ref|out|in|params)\s+)*([\w.:<>\[\]?]+)\s+(\w+)$/.exec(
          declaration,
        );
      return {
        defaultExpression:
          equals < 0 ? null : withoutAttributes.slice(equals + 1).trim(),
        name: parsed?.[2] ?? null,
        type: parsed?.[1] ?? null,
      };
    }).filter(({ name }) => name !== null);
    let body;
    let bodyStart;
    let bodyEnd;
    if (match[5] === "{") {
      const open = match.index + match[0].lastIndexOf("{");
      const close = matchingDelimiter(code, open, "{", "}");
      if (close < 0) continue;
      body = code.slice(open + 1, close);
      bodyStart = open + 1;
      bodyEnd = close;
    } else {
      const start = match.index + match[0].length;
      let end = start;
      let depth = 0;
      for (; end < code.length; end += 1) {
        if (code[end] === "(") depth += 1;
        else if (code[end] === ")") depth -= 1;
        else if (code[end] === ";" && depth === 0) break;
      }
      body = `return ${code.slice(start, end)};`;
      bodyStart = start;
      bodyEnd = end;
    }
    const definition = {
      async: /\basync\b/.test(match[1]) || /\b(?:Task|ValueTask)\b/.test(match[2] ?? ""),
      body,
      bodyStart,
      bodyEnd,
      id: ++id,
      name: match[3],
      owner,
      parameters,
      returnType: match[2] ?? owner,
      start: match.index,
    };
    const overloads = methods.get(definition.name) ?? [];
    overloads.push(definition);
    methods.set(definition.name, overloads);
  }
  return methods;
}

function fieldTypes(code, ranges, methods, types) {
  const result = new Map();
  const methodRanges = [...methods.values()].flat();
  for (const range of ranges) {
    const fields = new Map();
    const body = [...code.slice(range.open + 1, range.close)];
    for (const method of methodRanges.filter(
      (candidate) =>
        candidate.start > range.open && candidate.bodyEnd < range.close,
    )) {
      const start = Math.max(0, method.start - range.open - 1);
      const end = Math.min(body.length, method.bodyEnd - range.open);
      for (let index = start; index <= end; index += 1) body[index] = " ";
    }
    const fieldCode = body.join("");
    for (const match of fieldCode.matchAll(
      /\b(?:public|private|protected|internal|static|readonly|required|volatile|new)\s+((?:global::)?[\w.:<>?[\]]+)\s+(\w+)\s*(?=[=;{])/g,
    )) {
      fields.set(match[2], canonicalType(match[1], types) ?? match[1]);
    }
    result.set(range.name, fields);
  }
  return result;
}

class Environment {
  constructor(parent = null, receiver = null) {
    this.parent = parent;
    this.receiver = receiver ?? parent?.receiver ?? null;
    this.values = new Map();
  }

  declare(name, value) {
    this.values.set(name, value);
  }

  lookupLocal(name) {
    if (this.values.has(name)) return this.values.get(name);
    if (this.parent) return this.parent.lookupLocal(name);
    return null;
  }

  lookup(expression) {
    const path = accessPath(expression);
    if (!path) return null;
    const segments = path.split(".");
    let value;
    if (segments[0] === "this") {
      value = this.receiver;
      segments.shift();
    } else {
      value = this.lookupLocal(segments.shift());
      if (!value && this.receiver?.members?.has(path.split(".")[0])) {
        value = this.receiver.members.get(path.split(".")[0]);
      }
    }
    for (const segment of segments) {
      if (!value?.members) return null;
      value = value.members.get(segment);
    }
    return value ?? null;
  }

  assign(expression, value) {
    const path = accessPath(expression);
    if (!path) return;
    const segments = path.split(".");
    if (segments[0] === "this") segments.shift();
    if (segments.length > 1) {
      let target =
        this.lookupLocal(segments[0]) ??
        this.receiver?.members?.get(segments[0]) ??
        null;
      for (const segment of segments.slice(1, -1)) {
        if (!target?.members) return;
        target = target.members.get(segment);
      }
      target?.members?.set(segments.at(-1), value);
      return;
    }
    const name = segments[0];
    for (let scope = this; scope; scope = scope.parent) {
      if (scope.values.has(name)) {
        scope.values.set(name, value);
        return;
      }
    }
    if (this.receiver?.members?.has(name)) {
      this.receiver.members.set(name, value);
    } else {
      this.values.set(name, value);
    }
  }

  clone() {
    const cloned = new Environment(
      this.parent?.clone() ?? null,
      this.receiver,
    );
    for (const [name, value] of this.values) {
      cloned.values.set(name, cloneValue(value));
    }
    return cloned;
  }

  replaceWith(other) {
    this.values = new Map(
      Array.from(other.values, ([name, value]) => [
        name,
        cloneValue(value),
      ]),
    );
    if (this.parent && other.parent) {
      this.parent.replaceWith(other.parent);
    }
  }
}

function unknown(declaredType = null) {
  return { kind: "unknown", declaredType };
}

function cloneValue(value) {
  return value && value.kind !== "object" ? { ...value } : value;
}

function wholeInvocation(expression) {
  let value = stripOuterParentheses(expression.trim().replace(/!+$/, ""));
  let awaited = false;
  if (/^await\b/.test(value)) {
    awaited = true;
    value = stripOuterParentheses(value.replace(/^await\b/, "").trim());
  }
  const match =
    /^((?:global::)?[A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*)*)\s*\(/.exec(
      value,
    );
  if (!match) return null;
  const open = value.indexOf("(", match.index);
  const close = matchingDelimiter(value, open, "(", ")");
  if (close < 0 || value.slice(close + 1).trim() !== "") return null;
  const path = match[1].replace(/::/g, ".");
  const pieces = path.split(".");
  return {
    arguments: splitArguments(value.slice(open + 1, close)),
    awaited,
    method: pieces.at(-1),
    receiver: pieces.slice(0, -1).join("."),
  };
}

function orderedArguments(rawArguments, names) {
  const values = new Array(names.length).fill(null);
  let positional = 0;
  for (const raw of rawArguments) {
    const argument = namedArgument(raw);
    let index;
    if (argument.name) {
      index = names.indexOf(argument.name);
      if (index < 0 || values[index] !== null) return null;
    } else {
      while (values[positional] !== null) positional += 1;
      index = positional;
      positional += 1;
    }
    if (index >= values.length) return null;
    values[index] = argument.expression;
  }
  return values;
}

function constructor(expression, expectedType, state) {
  const value = stripOuterParentheses(expression);
  const match = /^new\s*([\w:.]+)?\s*\(/.exec(value);
  if (!match) return null;
  const open = value.indexOf("(", match.index);
  const close = matchingDelimiter(value, open, "(", ")");
  if (close < 0) return null;
  const explicit = match[1];
  return {
    arguments: splitArguments(value.slice(open + 1, close)),
    rawType: explicit ?? expectedType,
    type: explicit
      ? canonicalType(explicit, state.types)
      : canonicalType(expectedType, state.types),
  };
}

function literalValue(expression, state, environment, context) {
  const marker =
    /^(?:\$@|@\$|\$|@)?"([^"]+)"$/.exec(expression.trim())?.[1];
  if (!marker || !state.literals.has(marker)) return null;
  const stored = state.literals.get(marker);
  if (typeof stored === "string") return { kind: "string", value: stored };
  if (!stored?.interpolation) return null;
  let value = "";
  for (const part of stored.interpolation) {
    if (part.kind === "text") {
      value += part.value;
      continue;
    }
    if (part.kind !== "expression") return null;
    const resolved = evaluateExpression(
      part.expression,
      null,
      environment,
      state,
      context,
    );
    if (resolved?.kind === "string" && resolved.value !== null) {
      value += resolved.value;
    } else {
      return null;
    }
  }
  return { kind: "string", value };
}

function splitTopLevelAddition(expression) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if ("([{".includes(expression[index])) depth += 1;
    else if (")]}".includes(expression[index])) depth -= 1;
    else if (expression[index] === "+" && depth === 0) {
      if (expression[index - 1] === "+" || expression[index + 1] === "+") {
        continue;
      }
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (parts.length > 0) parts.push(expression.slice(start).trim());
  return parts;
}

function csharpIterableValue(expression, environment) {
  const value = stripOuterParentheses(expression).replace(/\s+/g, "");
  const reference = accessPath(value);
  if (reference) {
    const resolved = environment.lookup(reference);
    return resolved?.kind === "iterable" ? cloneValue(resolved) : unknown();
  }
  if (
    value === "[]" ||
    /^(?:Array|System\.Array)\.Empty<[^>]+>\(\)$/.test(value) ||
    /^(?:Enumerable|System\.Linq\.Enumerable)\.Empty<[^>]+>\(\)$/.test(
      value,
    ) ||
    /^new(?:\[\]|[\w.:<>?,]+\[\])\{\}$/.test(value) ||
    /^new(?:List|HashSet)<[^>]+>\(\)$/.test(value)
  ) {
    return { kind: "iterable", value: "empty" };
  }
  if (
    /^\[[^\]]+\]$/.test(value) ||
    /^new(?:\[\]|[\w.:<>?,]+\[\])\{[^}]+\}$/.test(value) ||
    /^new(?:List|HashSet)<[^>]+>(?:\(\))?\{[^}]+\}$/.test(value)
  ) {
    return { kind: "iterable", value: "nonempty" };
  }
  return unknown();
}

function propertyValue(expression, environment) {
  const normalized = stripOuterParentheses(expression).replace(/\s+/g, "");
  const match = /^(.+)\.(Value|HasCompleted|Status|ErrorCode|Message)$/.exec(
    normalized,
  );
  if (!match) return null;
  const parent = propertyValue(match[1], environment) ?? environment.lookup(match[1]);
  if (!parent) return null;
  if (match[2] === "Value") {
    if (parent.kind === "secret-response") {
      return {
        kind: "secret",
        clientId: parent.clientId,
        name: parent.name,
        retrieved: parent.retrieved,
        value: parent.value,
      };
    }
    if (parent.kind === "secret") {
      return {
        kind: "secret-value",
        clientId: parent.clientId,
        name: parent.name,
        retrieved: parent.retrieved,
        value: parent.value,
      };
    }
  }
  if (match[2] === "HasCompleted" && parent.kind === "delete-operation") {
    return { kind: "delete-status", operationId: parent.operationId };
  }
  return unknown();
}

function stringIdentity(value) {
  return value?.kind === "string" ? value.value : null;
}

function operationEvent(state, event, context) {
  state.events.push({
    ...event,
    order: state.events.length,
    origin: context.origin,
    path: context.path ?? [],
    loop: context.loop ?? null,
    site: context.site ?? context.origin,
  });
}

function branchPath(path, id, choice) {
  return [...(path ?? []), { choice, id }];
}

function mergePaths(left = [], right = []) {
  const choices = new Map(left.map(({ choice, id }) => [id, choice]));
  for (const { choice, id } of right) {
    if (choices.has(id) && choices.get(id) !== choice) return null;
    choices.set(id, choice);
  }
  return [...choices].map(([id, choice]) => ({ choice, id }));
}

function commonPath(paths) {
  if (paths.length === 0) return [];
  const common = new Map(
    (paths[0] ?? []).map(({ id, choice }) => [id, choice]),
  );
  for (const path of paths.slice(1)) {
    const choices = new Map(
      (path ?? []).map(({ id, choice }) => [id, choice]),
    );
    for (const [id, choice] of common) {
      if (choices.get(id) !== choice) common.delete(id);
    }
  }
  return [...common].map(([id, choice]) => ({ id, choice }));
}

function mergeRuntimeValues(values) {
  if (values.length === 0) return unknown();
  const signature = (value) => {
    if (value === null || value === undefined) return "null";
    if (value.kind === "object") return `object:${value.objectId}`;
    return JSON.stringify(value);
  };
  const first = signature(values[0]);
  return values.every((value) => signature(value) === first)
    ? cloneValue(values[0])
    : unknown(
        values.map((value) => value?.declaredType).find(Boolean) ?? null,
      );
}

function mergeEnvironments(base, environments) {
  const merged = base.clone();
  const mergeScope = (target, candidates) => {
    for (const name of target.values.keys()) {
      target.values.set(
        name,
        mergeRuntimeValues(
          candidates.map((candidate) =>
            candidate?.values.has(name)
              ? candidate.values.get(name)
              : target.values.get(name),
          ),
        ),
      );
    }
    if (target.parent) {
      mergeScope(
        target.parent,
        candidates.map((candidate) => candidate?.parent),
      );
    }
  };
  mergeScope(merged, environments);
  return merged;
}

function triStateCondition(condition, environment) {
  const tokens =
    condition.match(/&&|\|\||==|!=|[()!]|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g) ??
    [];
  let index = 0;
  const combine = (left, right, operator) => {
    if (operator === "&&") {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : null;
    }
    if (left === true || right === true) return true;
    return left === false && right === false ? false : null;
  };
  const primary = () => {
    if (tokens[index] === "(") {
      index += 1;
      const value = disjunction();
      if (tokens[index] !== ")") return null;
      index += 1;
      return value;
    }
    const token = tokens[index++];
    if (/^true$/i.test(token ?? "")) return true;
    if (/^false$/i.test(token ?? "")) return false;
    const value = token ? environment.lookup(token) : null;
    return value?.kind === "boolean" ? value.value : null;
  };
  const unary = () => {
    if (tokens[index] === "!") {
      index += 1;
      const value = unary();
      return value === null ? null : !value;
    }
    return primary();
  };
  const equality = () => {
    const left = unary();
    const operator = tokens[index];
    if (!["==", "!="].includes(operator)) return left;
    index += 1;
    const right = unary();
    if (left === null || right === null) return null;
    return operator === "==" ? left === right : left !== right;
  };
  const conjunction = () => {
    let value = equality();
    while (tokens[index] === "&&") {
      index += 1;
      value = combine(value, equality(), "&&");
    }
    return value;
  };
  function disjunction() {
    let value = conjunction();
    while (tokens[index] === "||") {
      index += 1;
      value = combine(value, conjunction(), "||");
    }
    return value;
  }
  const value = disjunction();
  return index === tokens.length ? value : null;
}

function bindAbsoluteUriTryCreate(
  condition,
  environment,
  state,
  context,
) {
  const expression = stripOuterParentheses(
    condition.replace(/^\s*!\s*/, ""),
  );
  const invocation =
    /^((?:global::)?[\w.:]+)\s*\.\s*TryCreate\s*\(([\s\S]*)\)$/.exec(
      expression,
    );
  if (
    !invocation ||
    canonicalType(invocation[1], state.types) !== "Uri"
  ) {
    return;
  }
  const argumentsList = splitArguments(invocation[2]);
  if (
    argumentsList.length < 3 ||
    !/\bUriKind\s*\.\s*Absolute\b/.test(argumentsList[1])
  ) {
    return;
  }
  const output =
    /^\s*out\s+(?:(?:var|(?:global::)?[\w.:<>?]+)\s+)?(\w+)\s*$/.exec(
      argumentsList[2],
    );
  const input = evaluateExpression(
    argumentsList[0],
    null,
    environment,
    state,
    context,
  );
  const validInput =
    input?.kind === "string" &&
    (
      input.value?.startsWith("env:") ||
      /^https?:\/\//i.test(input.value ?? "")
    );
  if (output && validInput) {
    environment.declare(output[1], {
      kind: "uri",
      absolute: true,
      source: input.value,
    });
  }
}

function constantCondition(condition, environment) {
  return triStateCondition(condition, environment);
}

function controlCondition(prefix, keyword) {
  const match = new RegExp(`^${keyword}\\b`).exec(prefix.trim());
  if (!match) return null;
  const open = prefix.indexOf("(", match.index + match[0].length);
  if (open < 0) return null;
  const close = matchingDelimiter(prefix, open, "(", ")");
  if (close < 0 || prefix.slice(close + 1).trim() !== "") return null;
  return prefix.slice(open + 1, close);
}

function csharpForCondition(header, environment) {
  let depth = 0;
  let start = 0;
  const parts = [];
  for (let index = 0; index < header.length; index += 1) {
    if ("([{".includes(header[index])) depth += 1;
    else if (")]}".includes(header[index])) depth -= 1;
    else if (header[index] === ";" && depth === 0) {
      parts.push(header.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(header.slice(start));
  if (parts.length !== 3) return null;
  return parts[1].trim() === ""
    ? true
    : constantCondition(parts[1], environment);
}

function csharpForeachCondition(header, environment) {
  let depth = 0;
  let separator = -1;
  for (let index = 0; index < header.length; index += 1) {
    if ("([{<".includes(header[index])) depth += 1;
    else if (")]}".includes(header[index]) || header[index] === ">") {
      depth = Math.max(0, depth - 1);
    } else if (header[index] === "i" && depth === 0) {
      const match = /^\bin\b/.exec(header.slice(index));
      if (match) {
        separator = index + match[0].length;
        break;
      }
    }
  }
  if (separator === -1) return null;
  const iterable = csharpIterableValue(header.slice(separator), environment);
  return iterable.kind === "iterable" && iterable.value === "empty"
    ? false
    : null;
}

function csharpTryBodyMayThrow(body, state, seen = new Set()) {
  const characters = [...body];
  for (const match of body.matchAll(
    /\b(?:if\s*\(\s*false\s*\)|for\s*\([^;]*;\s*false\s*;[^)]*\))\s*\{/g,
  )) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingDelimiter(body, opening, "{", "}");
    if (closing < 0) continue;
    for (let index = match.index; index <= closing; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  body = characters.join("");
  if (/\bthrow\b/.test(body)) return true;
  for (const match of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    if (
      ["if", "for", "foreach", "while", "switch", "catch", "lock", "using"]
        .includes(match[1])
    ) continue;
    const candidates = state?.methods?.get(match[1]) ?? [];
    if (candidates.length === 0) return true;
    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      if (
        csharpTryBodyMayThrow(
          candidate.body,
          state,
          new Set(seen).add(candidate.id),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function invokeSdk(invocation, environment, state, context) {
  const receiver = environment.lookup(invocation.receiver);
  if (receiver?.kind === "secret-client" && receiver.valid) {
    const asyncMethod = invocation.method.endsWith("Async");
    if (asyncMethod && !invocation.awaited) return unknown();
    const method = invocation.method.replace(/Async$/, "");
    if (method === "SetSecret") {
      const ordered = orderedArguments(invocation.arguments, [
        "name",
        "value",
        "cancellationtoken",
      ]);
      let name;
      let value;
      if (ordered?.[0] !== null && ordered?.[1] !== null) {
        name = stringIdentity(
          evaluateExpression(ordered[0], null, environment, state, context),
        );
        value = stringIdentity(
          evaluateExpression(ordered[1], null, environment, state, context),
        );
      } else if (invocation.arguments.length > 0) {
        const secret = evaluateExpression(
          namedArgument(invocation.arguments[0]).expression,
          "KeyVaultSecret",
          environment,
          state,
          context,
        );
        if (secret?.kind === "secret") {
          name = secret.name;
          value = secret.value;
        }
      }
      operationEvent(
        state,
        { kind: "set", clientId: receiver.clientId, name, value },
        context,
      );
      return {
        kind: "secret-response",
        clientId: receiver.clientId,
        name,
        retrieved: false,
        value,
      };
    }
    if (method === "GetSecret") {
      const ordered = orderedArguments(invocation.arguments, [
        "name",
        "version",
        "cancellationtoken",
      ]);
      const name = ordered?.[0]
        ? stringIdentity(
            evaluateExpression(ordered[0], null, environment, state, context),
          )
        : null;
      operationEvent(
        state,
        { kind: "get", clientId: receiver.clientId, name },
        context,
      );
      return {
        kind: "secret-response",
        clientId: receiver.clientId,
        name,
        retrieved: true,
        value: null,
      };
    }
    if (method === "StartDeleteSecret") {
      const ordered = orderedArguments(invocation.arguments, [
        "name",
        "cancellationtoken",
      ]);
      const name = ordered?.[0]
        ? stringIdentity(
            evaluateExpression(ordered[0], null, environment, state, context),
          )
        : null;
      const operationId = ++state.nextOperationId;
      operationEvent(
        state,
        {
          kind: "delete-start",
          clientId: receiver.clientId,
          name,
          operationId,
        },
        context,
      );
      return {
        kind: "delete-operation",
        clientId: receiver.clientId,
        name,
        operationId,
      };
    }
    if (method === "PurgeDeletedSecret") {
      const ordered = orderedArguments(invocation.arguments, [
        "name",
        "cancellationtoken",
      ]);
      const name = ordered?.[0]
        ? stringIdentity(
            evaluateExpression(ordered[0], null, environment, state, context),
          )
        : null;
      operationEvent(
        state,
        { kind: "purge", clientId: receiver.clientId, name },
        context,
      );
      return unknown();
    }
  }
  if (receiver?.kind === "delete-operation") {
    const asyncMethod = invocation.method.endsWith("Async");
    if (asyncMethod && !invocation.awaited) return unknown();
    const method = invocation.method.replace(/Async$/, "");
    if (method === "WaitForCompletion") {
      operationEvent(
        state,
        {
          kind: "wait",
          operationId: receiver.operationId,
          receiver: invocation.receiver,
        },
        context,
      );
      return receiver;
    }
    if (method === "UpdateStatus") {
      operationEvent(
        state,
        {
          kind: "poll",
          operationId: receiver.operationId,
          receiver: invocation.receiver,
        },
        context,
      );
      return receiver;
    }
  }
  return null;
}

function invokeHelper(invocation, environment, state, context) {
  const simpleReceiver = invocation.receiver.split(".").at(-1);
  const receiver = environment.lookup(invocation.receiver);
  const candidates = state.methods.get(invocation.method) ?? [];
  const definitions = candidates.filter((definition) => {
    const required = definition.parameters.filter(
      (parameter) => parameter.defaultExpression === null,
    ).length;
    if (
      invocation.arguments.length < required ||
      invocation.arguments.length > definition.parameters.length
    ) {
      return false;
    }
    if (receiver?.kind === "object") return definition.owner === receiver.type;
    if (definition.owner && simpleReceiver === definition.owner) {
      return true;
    }
    return definition.owner === null || invocation.receiver === "";
  });
  if (definitions.length === 0) return null;

  let merged = unknown();
  for (const definition of definitions) {
    if (definition.async && !invocation.awaited) continue;
    const key = `${definition.id}:${receiver?.objectId ?? "static"}`;
    if (state.activeMethods.has(key)) continue;
    const callEnvironment = new Environment(null, receiver?.kind === "object" ? receiver : null);
    const parameterValues = new Array(definition.parameters.length).fill(
      unknown(),
    );
    definition.parameters.forEach((parameter, index) => {
      if (parameter.defaultExpression !== null) {
        parameterValues[index] = evaluateExpression(
          parameter.defaultExpression,
          parameter.type,
          environment,
          state,
          context,
        );
      }
    });
    let positional = 0;
    for (const raw of invocation.arguments) {
      const argument = namedArgument(raw);
      let index;
      if (argument.name) {
        index = definition.parameters.findIndex(
          (parameter) => parameter.name.toLowerCase() === argument.name,
        );
      } else {
        index = positional;
        positional += 1;
      }
      if (index >= 0) {
        parameterValues[index] = evaluateExpression(
          argument.expression,
          definition.parameters[index].type,
          environment,
          state,
          context,
        );
      }
    }
    definition.parameters.forEach((parameter, index) => {
      callEnvironment.declare(parameter.name, parameterValues[index]);
    });
    state.activeMethods.add(key);
    const flow = executeRegion(
      definition.body,
      definition.bodyStart,
      callEnvironment,
      state,
      {
        branchScope: `${context.branchScope ?? "root"}/${context.origin}:${definition.id}`,
        loop: context.loop,
        path: context.path,
        site: context.site ?? context.origin,
      },
    );
    state.activeMethods.delete(key);
    if (flow.value) merged = flow.value;
  }
  return merged;
}

function evaluateExpression(
  expression,
  expectedType,
  environment,
  state,
  context,
) {
  let value = stripOuterParentheses(namedArgument(expression).expression)
    .replace(/!+$/, "")
    .trim();
  const configuredAwait =
    /^await\s+([\s\S]+)\s*\.\s*ConfigureAwait\s*\(\s*(?:true|false)\s*\)$/.exec(
      value,
    );
  if (configuredAwait) value = `await ${configuredAwait[1]}`;

  const ternary = topLevelCsharpTernary(value);
  if (ternary) {
    const condition = constantCondition(ternary.condition, environment);
    if (condition === true) {
      return evaluateExpression(
        ternary.consequent,
        expectedType,
        environment,
        state,
        context,
      );
    }
    if (condition === false) {
      return evaluateExpression(
        ternary.alternate,
        expectedType,
        environment,
        state,
        context,
      );
    }
    const id = `${context.branchScope ?? "root"}:ternary:${context.origin}`;
    return mergeRuntimeValues([
      evaluateExpression(
        ternary.consequent,
        expectedType,
        environment,
        state,
        csharpExpressionPath(context, id, true),
      ),
      evaluateExpression(
        ternary.alternate,
        expectedType,
        environment,
        state,
        csharpExpressionPath(context, id, false),
      ),
    ]);
  }

  for (const operator of ["||", "&&"]) {
    const operatorIndex = topLevelCsharpOperator(value, operator);
    if (operatorIndex === -1) continue;
    const leftText = value.slice(0, operatorIndex);
    const rightText = value.slice(operatorIndex + 2);
    let leftBoolean = constantCondition(leftText, environment);
    const left = evaluateExpression(
      leftText,
      null,
      environment,
      state,
      context,
    );
    if (leftBoolean === null && left?.kind === "boolean") {
      leftBoolean = left.value;
    }
    if (
      (operator === "&&" && leftBoolean === false) ||
      (operator === "||" && leftBoolean === true)
    ) {
      return left;
    }
    const rightContext = leftBoolean === null
      ? csharpExpressionPath(
          context,
          `${context.branchScope ?? "root"}:short:${context.origin}:${operatorIndex}`,
          operator === "&&",
        )
      : context;
    return evaluateExpression(
      rightText,
      expectedType,
      environment,
      state,
      rightContext,
    );
  }

  const additions = splitTopLevelAddition(value);
  if (additions.length > 0) {
    const parts = additions.map((part) =>
      evaluateExpression(part, null, environment, state, context)
    );
    return parts.every(
        (part) => part?.kind === "string" && part.value !== null,
      )
      ? {
          kind: "string",
          value: parts.map((part) => part.value).join(""),
        }
      : unknown("string");
  }

  const literal = literalValue(value, state, environment, context);
  if (literal) return literal;
  const boolean = triStateCondition(value, environment);
  if (boolean !== null) return { kind: "boolean", value: boolean };

  const trailingValue = /^([\s\S]+)\s*\.\s*Value\s*$/.exec(value);
  if (trailingValue) {
    const parent = evaluateExpression(
      trailingValue[1],
      null,
      environment,
      state,
      context,
    );
    if (parent?.kind === "secret-response") {
      return {
        kind: "secret",
        clientId: parent.clientId,
        name: parent.name,
        retrieved: parent.retrieved,
        value: parent.value,
      };
    }
    if (parent?.kind === "secret") {
      return {
        kind: "secret-value",
        clientId: parent.clientId,
        name: parent.name,
        retrieved: parent.retrieved,
        value: parent.value,
      };
    }
  }

  const property = propertyValue(value, environment);
  if (property) return property;

  const reference = accessPath(value);
  if (reference) return cloneValue(environment.lookup(reference)) ?? unknown();

  const iterable = csharpIterableValue(value, environment);
  if (iterable.kind === "iterable") return iterable;

  const invocation = wholeInvocation(value);
  if (invocation) {
    const sdk = invokeSdk(invocation, environment, state, context);
    if (sdk !== null) {
      if (
        canonicalType(expectedType, state.types) === "KeyVaultSecret" &&
        sdk.kind === "secret-response"
      ) {
        return {
          kind: "secret",
          clientId: sdk.clientId,
          name: sdk.name,
          retrieved: sdk.retrieved,
          value: sdk.value,
        };
      }
      return sdk;
    }
    const helper = invokeHelper(invocation, environment, state, context);
    if (helper !== null) return helper;
  }

  const created = constructor(value, expectedType, state);
  if (created) {
    const type = created.type;
    if (type === "DefaultAzureCredential") {
      state.credentialFound = true;
      return { kind: "credential" };
    }
    if (type === "Uri") {
      return created.arguments.length > 0
        ? { kind: "uri" }
        : unknown("Uri");
    }
    if (type === "SecretClient") {
      const values = created.arguments.map((argument) =>
        evaluateExpression(argument, null, environment, state, context),
      );
      const valid =
        values.some((argument) => argument?.kind === "uri") &&
        values.some((argument) => argument?.kind === "credential");
      if (!valid) return { kind: "secret-client", valid: false };
      const client = {
        kind: "secret-client",
        clientId: ++state.nextClientId,
        valid: true,
      };
      state.clientFound = true;
      return client;
    }
    if (type === "KeyVaultSecret") {
      const ordered = orderedArguments(created.arguments, ["name", "value"]);
      return {
        kind: "secret",
        name: ordered?.[0]
          ? stringIdentity(
              evaluateExpression(
                ordered[0],
                null,
                environment,
                state,
                context,
              ),
            )
          : null,
        retrieved: false,
        value: ordered?.[1]
          ? stringIdentity(
              evaluateExpression(
                ordered[1],
                null,
                environment,
                state,
                context,
              ),
            )
          : null,
      };
    }

    const rawType = created.rawType?.replace(/^global::/, "").split(".").at(-1);
    if (rawType && state.ranges.some((range) => range.name === rawType)) {
      const object = {
        kind: "object",
        members: new Map(),
        objectId: ++state.nextObjectId,
        type: rawType,
      };
      for (const [name, declaredType] of state.fields.get(rawType) ?? []) {
        object.members.set(name, unknown(declaredType));
      }
      const constructors = (state.methods.get(rawType) ?? []).filter(
        (definition) =>
          definition.owner === rawType &&
          definition.parameters.length === created.arguments.length,
      );
      for (const definition of constructors) {
        const invocation = {
          arguments: created.arguments,
          awaited: false,
          method: rawType,
          receiver: "",
        };
        const temporary = new Environment();
        temporary.declare("__instance", object);
        invokeHelper(
          { ...invocation, receiver: "__instance" },
          temporary,
          state,
          context,
        );
      }
      return object;
    }
  }

  const environmentRead =
    /^(?:System\s*\.\s*)?Environment\s*\.\s*GetEnvironmentVariable\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (environmentRead) {
    const variable = stringIdentity(
      evaluateExpression(
        environmentRead[1],
        null,
        environment,
        state,
        context,
      ),
    );
    return {
      kind: "string",
      value: variable ? `env:${variable}` : null,
    };
  }
  return unknown(canonicalType(expectedType, state.types) ?? expectedType);
}

function recordOutput(expression, environment, state, context) {
  for (const [marker, literal] of state.literals) {
    if (!expression.includes(marker) || !literal?.interpolation) continue;
    for (const part of literal.interpolation) {
      if (part.kind === "expression") {
        recordOutput(part.expression, environment, state, context);
      }
    }
  }
  const direct = evaluateExpression(
    expression,
    null,
    environment,
    state,
    context,
  );
  if (direct?.kind === "secret-value" && direct.retrieved) {
    operationEvent(
      state,
      {
        kind: "output",
        clientId: direct.clientId,
        name: direct.name,
        retrieved: true,
      },
      context,
    );
    return;
  }
  const compact = expression.replace(/\s+/g, "");
  const visible = [];
  for (let scope = environment; scope; scope = scope.parent) {
    visible.push(...scope.values);
  }
  if (environment.receiver?.members) {
    visible.push(...environment.receiver.members);
  }
  for (const [name, binding] of visible) {
    const reference = escapeRegExp(name);
    if (
      binding?.kind === "secret-value" &&
      binding.retrieved &&
      new RegExp(`\\b${reference}\\b`).test(expression)
    ) {
      operationEvent(
        state,
        {
          kind: "output",
          clientId: binding.clientId,
          name: binding.name,
          retrieved: true,
        },
        context,
      );
      return;
    }
    if (
      binding?.kind === "secret-response" &&
      binding.retrieved &&
      new RegExp(`\\b${reference}\\.Value\\.Value\\b`).test(compact)
    ) {
      operationEvent(
        state,
        {
          kind: "output",
          clientId: binding.clientId,
          name: binding.name,
          retrieved: true,
        },
        context,
      );
      return;
    }
    if (
      binding?.kind === "secret" &&
      binding.retrieved &&
      new RegExp(`\\b${reference}\\.Value\\b`).test(compact)
    ) {
      operationEvent(
        state,
        {
          kind: "output",
          clientId: binding.clientId,
          name: binding.name,
          retrieved: true,
        },
        context,
      );
      return;
    }
  }
}

function processStatement(statement, environment, state, context) {
  const trimmed = statement
    .replace(/^(?:[A-Za-z_]\w*\s*:\s*)+/, "")
    .trim();
  if (!trimmed) return null;

  if (/^(?:return|throw)\s*$/.test(trimmed)) {
    return { normal: false, value: null };
  }
  const returned = /^return\s+([\s\S]+)$/.exec(trimmed);
  if (returned) {
    return {
      normal: false,
      value: evaluateExpression(
        returned[1],
        null,
        environment,
        state,
        context,
      ),
    };
  }
  if (/^throw\b/.test(trimmed)) {
    evaluateExpression(
      trimmed.replace(/^throw\b/, ""),
      null,
      environment,
      state,
      context,
    );
    return { normal: false, value: null };
  }

  const output =
    /^(?:(?:System\s*\.\s*)?Console\s*\.\s*(?:Error\s*\.\s*|Out\s*\.\s*)?(?:Write|WriteLine)|(?:System\s*\.\s*Diagnostics\s*\.\s*)?(?:Debug|Trace)\s*\.\s*(?:Write|WriteLine|Trace\w*)|(?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*\s*\.\s*Log(?:Trace|Debug|Information|Warning|Error|Critical)?)\s*\(([\s\S]*)\)$/.exec(
      trimmed,
    );
  if (output) {
    recordOutput(output[1], environment, state, context);
    return null;
  }

  const declaration =
    /^(?:(?:public|private|protected|internal|static|readonly|volatile|required|new|unsafe|const|await|using)\s+)*(var|(?:global::)?[\w.:<>?[\]]+)\s+(\w+)\s*=\s*([\s\S]+)$/.exec(
      trimmed,
    );
  if (declaration) {
    const explicitType =
      declaration[1] === "var" ? null : declaration[1];
    const binding = evaluateExpression(
      declaration[3],
      explicitType,
      environment,
      state,
      context,
    );
    if (explicitType && binding?.kind === "unknown") {
      binding.declaredType = canonicalType(explicitType, state.types) ?? explicitType;
    }
    environment.declare(declaration[2], binding);
    return null;
  }

  const assignment =
    /^((?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*)\s*=\s*([\s\S]+)$/.exec(
      trimmed,
    );
  if (assignment) {
    const previous = environment.lookup(assignment[1]);
    environment.assign(
      assignment[1],
      evaluateExpression(
        assignment[2],
        previous?.declaredType ?? null,
        environment,
        state,
        context,
      ),
    );
    return null;
  }

  evaluateExpression(trimmed, null, environment, state, context);
  return null;
}

function topLevelCsharpOperator(expression, operator) {
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closes = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character in depth) depth[character] += 1;
    else if (character in closes) depth[closes[character]] -= 1;
    else if (
      Object.values(depth).every((value) => value === 0) &&
      expression.startsWith(operator, index)
    ) {
      return index;
    }
  }
  return -1;
}

function topLevelCsharpTernary(expression) {
  const question = topLevelCsharpOperator(expression, "?");
  if (question === -1) return null;
  let nested = 0;
  for (let index = question + 1; index < expression.length; index += 1) {
    if (expression[index] === "?") nested += 1;
    else if (expression[index] === ":" && nested-- === 0) {
      return {
        alternate: expression.slice(index + 1),
        condition: expression.slice(0, question),
        consequent: expression.slice(question + 1, index),
      };
    }
  }
  return null;
}

function csharpExpressionPath(context, id, choice) {
  return {
    ...context,
    path: branchPath(context.path, id, choice),
  };
}

function executeRegion(source, baseOffset, environment, state, inherited = {}) {
  let start = 0;
  let index = 0;
  let parentheses = 0;
  let brackets = 0;
  let pendingIf = null;
  let pendingTry = null;
  let currentPath = inherited.path ?? [];
  const finishIf = (alternate = null) => {
    if (!pendingIf) return true;
    const branches = [];
    if (
      pendingIf.condition !== false &&
      pendingIf.consequent.flow.normal
    ) {
      branches.push(pendingIf.consequent);
    }
    if (alternate) {
      if (pendingIf.condition !== true && alternate.flow.normal) {
        branches.push(alternate);
      }
    } else if (pendingIf.condition !== true) {
      branches.push({
        environment: pendingIf.base.clone(),
        flow: { normal: true, value: null },
        path:
          pendingIf.condition === null
            ? branchPath(pendingIf.path, pendingIf.id, false)
            : pendingIf.path,
      });
    }
    if (branches.length === 0) {
      pendingIf = null;
      return false;
    }
    environment.replaceWith(
      mergeEnvironments(
        pendingIf.base,
        branches.map((branch) => branch.environment),
      ),
    );
    currentPath = commonPath(branches.map((branch) => branch.path));
    pendingIf = null;
    return true;
  };
  while (index < source.length) {
    const character = source[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (
      character === "{" &&
      parentheses === 0 &&
      brackets === 0
    ) {
      const close = matchingDelimiter(source, index, "{", "}");
      if (close < 0) break;
      const prefix = source.slice(start, index).trim();
      const initializer =
        /=/.test(prefix) &&
        (/\bnew\b/.test(prefix) || /\bwith\s*$/.test(prefix));
      if (initializer) {
        if (!finishIf()) return { normal: false, value: null };
        index = close;
      } else {
        const isCatch = /^catch(?:\s|\(|$)/.test(prefix);
        const isTry = /^try\s*$/.test(prefix);
        const ifCondition = controlCondition(prefix, "if");
        const whileCondition = controlCondition(prefix, "while");
        const forCondition = controlCondition(prefix, "for");
        const foreachCondition = controlCondition(prefix, "foreach");
        const isElse = /^else\s*$/.test(prefix);
        if (!isElse && !finishIf()) {
          return { normal: false, value: null };
        }
        let execute = !isCatch;
        let nestedContext = { ...inherited, path: currentPath };

        if (isTry) {
          const id = `${inherited.branchScope ?? "root"}:try:${baseOffset + start}`;
          const path = branchPath(currentPath, id, true);
          const flow = executeRegion(
            source.slice(index + 1, close),
            baseOffset + index + 1,
            new Environment(environment),
            state,
            { ...inherited, path },
          );
          pendingTry = {
            catchIndex: 0,
            id,
            mayThrow: csharpTryBodyMayThrow(
              source.slice(index + 1, close),
              state,
            ),
            path: currentPath,
          };
          if (!flow.normal) return flow;
          execute = false;
        } else if (isCatch) {
          execute = Boolean(pendingTry?.mayThrow);
          if (execute) {
            nestedContext = {
              ...inherited,
              path: branchPath(
                pendingTry.path,
                pendingTry.id,
                `catch:${pendingTry.catchIndex}`,
              ),
            };
          }
          if (pendingTry) pendingTry.catchIndex += 1;
        } else if (ifCondition !== null) {
          bindAbsoluteUriTryCreate(
            ifCondition,
            environment,
            state,
            {
              branchScope: inherited.branchScope,
              loop: inherited.loop,
              origin: baseOffset + start,
              path: currentPath,
              site: inherited.site ?? baseOffset + start,
            },
          );
          const condition = constantCondition(ifCondition, environment);
          const branch = {
            condition,
            id: `${inherited.branchScope ?? "root"}:${baseOffset + start}`,
          };
          execute = condition !== false;
          if (condition === null) {
            nestedContext = {
              ...inherited,
              path: branchPath(currentPath, branch.id, true),
            };
          }
          const branchBase = environment.clone();
          const flow = execute
            ? executeRegion(
                source.slice(index + 1, close),
                baseOffset + index + 1,
                new Environment(branchBase),
                state,
                nestedContext,
              )
            : { normal: false, value: null };
          pendingIf = {
            ...branch,
            base: environment.clone(),
            consequent: {
              environment: branchBase,
              flow,
              path: nestedContext.path,
            },
            path: currentPath,
          };
          execute = false;
        } else if (isElse && pendingIf) {
          execute = pendingIf.condition !== true;
          const branchBase = pendingIf.base.clone();
          if (pendingIf.condition === null) {
            nestedContext = {
              ...inherited,
              path: branchPath(pendingIf.path, pendingIf.id, false),
            };
          }
          const flow = execute
            ? executeRegion(
                source.slice(index + 1, close),
                baseOffset + index + 1,
                new Environment(branchBase),
                state,
                nestedContext,
              )
            : { normal: false, value: null };
          if (!finishIf({
            environment: branchBase,
            flow,
            path: nestedContext.path,
          })) {
            return { normal: false, value: null };
          }
          execute = false;
        } else if (
          whileCondition !== null ||
          forCondition !== null ||
          foreachCondition !== null
        ) {
          const header =
            whileCondition ?? forCondition ?? foreachCondition;
          const condition = whileCondition !== null
            ? constantCondition(header, environment)
            : forCondition !== null
              ? csharpForCondition(header, environment)
              : csharpForeachCondition(header, environment);
          execute = condition !== false;
          if (execute) {
            const branchId =
              `${inherited.branchScope ?? "root"}:loop:${baseOffset + start}`;
            const path = condition === null
              ? branchPath(currentPath, branchId, true)
              : currentPath;
            nestedContext = { ...nestedContext, path };
            const statusExpression =
              whileCondition?.replace(/^\s*!\s*/, "") ?? "";
            const status = whileCondition === null
              ? null
              : evaluateExpression(
                  statusExpression,
                  null,
                  environment,
                  state,
                  {
                    origin: baseOffset + start,
                    ...inherited,
                  },
                );
            nestedContext = {
              ...nestedContext,
              loop: {
                body: source.slice(index + 1, close),
                completionOperationId:
                  /^\s*!/.test(whileCondition ?? "") &&
                  status?.kind === "delete-status"
                    ? status.operationId
                    : null,
                path,
              },
            };
          }
        }

        if (execute) {
          const flow = executeRegion(
            source.slice(index + 1, close),
            baseOffset + index + 1,
            new Environment(environment),
            state,
            nestedContext,
          );
          if (!flow.normal) return flow;
        }
        start = close + 1;
        index = close;
      }
    } else if (
      character === ";" &&
      parentheses === 0 &&
      brackets === 0
    ) {
      const statement = source.slice(start, index);
      const singleIf = controlCondition(statement.trim(), "if");
      if (!singleIf && !finishIf()) {
        return { normal: false, value: null };
      }
      const leading = statement.search(/\S/);
      const origin = baseOffset + start + Math.max(0, leading);
      if (singleIf !== null) {
        bindAbsoluteUriTryCreate(
          singleIf,
          environment,
          state,
          {
            branchScope: inherited.branchScope,
            loop: inherited.loop,
            origin,
            path: currentPath,
            site: inherited.site ?? origin,
          },
        );
        const close = matchingDelimiter(statement, statement.indexOf("("), "(", ")");
        const consequent = statement.slice(close + 1);
        const condition = constantCondition(singleIf, environment);
        const id = `${inherited.branchScope ?? "root"}:${origin}`;
        const base = environment.clone();
        const consequentEnvironment = base.clone();
        const consequentPath =
          condition === null ? branchPath(currentPath, id, true) : currentPath;
        const flow =
          condition === false
            ? { normal: false, value: null }
            : processStatement(
                consequent,
                consequentEnvironment,
                state,
                {
                  branchScope: inherited.branchScope,
                  loop: inherited.loop,
                  origin,
                  path: consequentPath,
                  site: inherited.site ?? origin,
                },
              ) ?? { normal: true, value: null };
        pendingIf = {
          base,
          condition,
          consequent: {
            environment: consequentEnvironment,
            flow,
            path: consequentPath,
          },
          id,
          path: currentPath,
        };
        if (!finishIf()) return { normal: false, value: flow.value };
        start = index + 1;
        index += 1;
        continue;
      }
      const flow = processStatement(statement, environment, state, {
        branchScope: inherited.branchScope,
        loop: inherited.loop,
        origin,
        path: currentPath,
        site: inherited.site ?? origin,
      });
      if (flow && !flow.normal) return flow;
      start = index + 1;
    }
    index += 1;
  }
  if (!finishIf()) return { normal: false, value: null };
  return { normal: true, value: null };
}

function maskRanges(source, ranges) {
  const characters = [...source];
  for (const range of ranges) {
    for (let index = range.start; index <= range.end; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

function analyze(source) {
  const { code, literals } = literalAwareCode(source);
  const types = typeContext(code);
  const ranges = typeRanges(code);
  const methods = methodDefinitions(code, ranges);
  const fields = fieldTypes(code, ranges, methods, types);
  const state = {
    activeMethods: new Set(),
    clientFound: false,
    code,
    credentialFound: false,
    events: [],
    fields,
    literals,
    methods,
    nextClientId: 0,
    nextObjectId: 0,
    nextOperationId: 0,
    ranges,
    types,
  };

  const rootRanges = ranges.map((range) => ({
    start: range.start,
    end: range.close,
  }));
  const topLevelMethods = [...methods.values()].flat()
    .filter((method) => method.owner === null)
    .map((method) => ({ start: method.start, end: method.bodyEnd }));
  const root = maskRanges(code, [...rootRanges, ...topLevelMethods]);
  executeRegion(root, 0, new Environment(), state);

  for (const main of methods.get("Main") ?? []) {
    const environment = new Environment();
    main.parameters.forEach((parameter) =>
      environment.declare(parameter.name, unknown(parameter.type)),
    );
    executeRegion(main.body, main.bodyStart, environment, state);
  }
  return state;
}

function lifecycle(analysis) {
  const eventsAfter = (event, predicate, path) =>
    analysis.events
      .filter(
        (candidate) =>
          candidate.order > event.order &&
          predicate(candidate) &&
          mergePaths(path, candidate.path) !== null,
      )
      .map((candidate) => ({
        event: candidate,
        path: mergePaths(path, candidate.path),
      }));
  let best = { create: null };
  const promote = (level, flow) => {
    if ((best.level ?? 0) < level) best = { ...flow, level };
  };

  for (const create of analysis.events.filter(
    (event) =>
      event.kind === "set" &&
      event.name === "my-secret" &&
      event.value === "my-secret-value",
  )) {
    const createFlow = { create };
    promote(1, createFlow);
    for (const getStep of eventsAfter(
      create,
      (event) =>
        event.kind === "get" &&
        event.clientId === create.clientId &&
        event.name === create.name,
      create.path,
    )) {
      for (const outputStep of eventsAfter(
        getStep.event,
        (event) =>
          event.kind === "output" &&
          event.clientId === getStep.event.clientId &&
          event.name === getStep.event.name &&
          event.retrieved,
        getStep.path,
      )) {
        const readFlow = {
          ...createFlow,
          get: getStep.event,
          output: outputStep.event,
        };
        promote(2, readFlow);
        for (const updateStep of eventsAfter(
          outputStep.event,
          (event) =>
            event.kind === "set" &&
            event.clientId === create.clientId &&
            event.name === create.name &&
            event.value === "updated-value",
          outputStep.path,
        )) {
          const updateFlow = { ...readFlow, update: updateStep.event };
          promote(3, updateFlow);
          for (const deleteStep of eventsAfter(
            updateStep.event,
            (event) =>
              event.kind === "delete-start" &&
              event.clientId === create.clientId &&
              event.name === create.name,
            updateStep.path,
          )) {
            for (const waitStep of eventsAfter(
              deleteStep.event,
              (event) =>
                ["wait", "poll"].includes(event.kind) &&
                event.operationId === deleteStep.event.operationId &&
                (event.kind === "wait" || pollingCompletes(event)),
              deleteStep.path,
            )) {
              for (const purgeStep of eventsAfter(
                waitStep.event,
                (event) =>
                  event.kind === "purge" &&
                  event.clientId === create.clientId &&
                  event.name === create.name,
                waitStep.path,
              )) {
                promote(4, {
                  ...updateFlow,
                  deletion: deleteStep.event,
                  purge: purgeStep.event,
                  wait: waitStep.event,
                });
              }
            }
          }
        }
      }
    }
  }
  return best;
}

function pollingCompletes(event) {
  if (
    !event.loop ||
    event.loop.completionOperationId !== event.operationId ||
    /\b(?:break|continue|goto|return|throw)\b/.test(event.loop.body)
  ) {
    return false;
  }
  return mergePaths(event.loop.path, event.path)?.length ===
    event.loop.path.length;
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

function csharpThrowIsCausal(statement, caughtName) {
  if (/^\s*throw\s*;\s*$/.test(statement)) return true;
  const expression = /^\s*throw\s+([\s\S]+);\s*$/.exec(statement)?.[1];
  if (!expression || !caughtName) return false;
  const name = escapeRegExp(caughtName);
  if (new RegExp(`^\\s*${name}\\s*$`).test(stripOuterParentheses(expression))) {
    return true;
  }
  return new RegExp(
    String.raw`(?:\(|,)\s*(?:\w+\s*:\s*)?\b${name}\b\s*(?=,|\))`,
  ).test(expression);
}

function labelsInScope(source, start, end, ancestors) {
  const labels = new Set();
  let invalid = false;
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < end; index += 1) {
    const character = source[index];
    if (character === "{" && parentheses === 0 && brackets === 0) {
      const close = matchingDelimiter(source, index, "{", "}");
      if (close < 0 || close >= end) break;
      index = close;
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    if (parentheses > 0 || brackets > 0) continue;
    const match = /^([A-Za-z_]\w*)\s*:/.exec(source.slice(index, end));
    if (!match || ["case", "default"].includes(match[1])) continue;
    const prefix = source.slice(start, index).trimEnd();
    const previous = prefix.at(-1);
    const canStart =
      !prefix || ";{}:)".includes(previous) || /\b(?:do|else)\s*$/.test(prefix);
    if (!canStart) continue;
    if (labels.has(match[1]) || ancestors.some((scope) => scope.has(match[1]))) {
      invalid = true;
    }
    labels.add(match[1]);
    index += match[0].length - 1;
  }
  return { labels, invalid };
}

function csharpHandlerAlwaysCausal(body, caughtName) {
  if (/\bgoto\b/.test(body)) return false;
  const labelScopes = [];

  const outcomes = (start, end) => {
    const registered = labelsInScope(body, start, end, labelScopes);
    labelScopes.push(registered.labels);
    let result = new Set(["fall"]);
    let index = start;
    const sequence = (next) => {
      const combined = new Set([...result].filter((value) => value !== "fall"));
      if (result.has("fall")) {
        for (const value of next) combined.add(value);
      }
      result = combined;
    };
    const skipWhitespace = () => {
      while (index < end && /\s/.test(body[index])) index += 1;
    };
    const conditionKind = (condition) => {
      const value = stripOuterParentheses(condition)
        .replace(/\s+/g, "")
        .toLowerCase();
      if (value === "true") return true;
      if (value === "false") return false;
      return null;
    };
    const loopOutcomes = (nested, condition, canSkip, executesOnce = false) => {
      const values = new Set(
        [...nested].filter((value) =>
          ["safe", "unsafe", "invalid"].includes(value),
        ),
      );
      if (condition === false && !executesOnce) {
        return new Set([
          "fall",
          ...[...nested].filter((value) => value === "invalid"),
        ]);
      }
      if (nested.has("break")) values.add("fall");
      if (
        condition !== true &&
        (canSkip || nested.has("fall") || nested.has("continue"))
      ) {
        values.add("fall");
      }
      return values;
    };
    const parenthesized = () => {
      skipWhitespace();
      if (body[index] !== "(") return null;
      const close = matchingDelimiter(body, index, "(", ")");
      if (close < 0 || close >= end) return null;
      const value = body.slice(index + 1, close);
      index = close + 1;
      return value;
    };
    const forCondition = (header) => {
      let startIndex = 0;
      let depth = 0;
      const exactParts = [];
      for (let cursor = 0; cursor < header.length; cursor += 1) {
        const character = header[cursor];
        if ("([{".includes(character)) depth += 1;
        else if (")]}".includes(character)) depth -= 1;
        else if (character === ";" && depth === 0) {
          exactParts.push(header.slice(startIndex, cursor));
          startIndex = cursor + 1;
        }
      }
      exactParts.push(header.slice(startIndex));
      if (exactParts.length !== 3) return "ambiguous";
      return exactParts[1].trim() === ""
        ? true
        : conditionKind(exactParts[1]);
    };

    const statement = () => {
      skipWhitespace();
      if (index >= end) return new Set(["unsafe"]);
      if (body[index] === ";") {
        index += 1;
        return new Set(["fall"]);
      }
      const labels = new Set();
      let hasLabel = false;
      let duplicateLabel = false;
      while (true) {
        const label = /^([A-Za-z_]\w*)\s*:/.exec(body.slice(index));
        if (!label) break;
        hasLabel = true;
        if (labels.has(label[1])) duplicateLabel = true;
        labels.add(label[1]);
        index += label[0].length;
        skipWhitespace();
      }
      if (hasLabel) {
        const labelsLoop = /^(?:while|foreach|for|do)\b/.test(body.slice(index));
        const nested = statement();
        if (duplicateLabel) return new Set(["invalid"]);
        return labelsLoop ? nested : new Set(["unsafe"]);
      }
      if (body[index] === "{") {
        const close = matchingDelimiter(body, index, "{", "}");
        if (close < 0 || close >= end) {
          index = end;
          return new Set(["unsafe"]);
        }
        const nested = outcomes(index + 1, close);
        index = close + 1;
        return nested;
      }
      if (/^while\b/.test(body.slice(index))) {
        index += 5;
        const condition = parenthesized();
        if (condition === null) return new Set(["unsafe"]);
        const kind = conditionKind(condition);
        return loopOutcomes(statement(), kind, kind === null);
      }
      if (/^foreach\b/.test(body.slice(index))) {
        index += 7;
        if (parenthesized() === null) return new Set(["unsafe"]);
        return loopOutcomes(statement(), null, true);
      }
      if (/^for\b/.test(body.slice(index))) {
        index += 3;
        const header = parenthesized();
        if (header === null) return new Set(["unsafe"]);
        const kind = forCondition(header);
        const nested = statement();
        return kind === "ambiguous"
          ? new Set(["unsafe"])
          : loopOutcomes(nested, kind, kind === null);
      }
      if (/^do\b/.test(body.slice(index))) {
        index += 2;
        const nested = statement();
        skipWhitespace();
        if (!/^while\b/.test(body.slice(index))) return new Set(["unsafe"]);
        index += 5;
        const condition = parenthesized();
        if (condition === null) return new Set(["unsafe"]);
        skipWhitespace();
        if (body[index] === ";") index += 1;
        return loopOutcomes(nested, conditionKind(condition), false, true);
      }
      if (/^if\b/.test(body.slice(index))) {
        index += 2;
        const condition = parenthesized();
        if (condition === null) return new Set(["unsafe"]);
        const consequent = statement();
        skipWhitespace();
        let alternate = new Set(["fall"]);
        if (/^else\b/.test(body.slice(index))) {
          index += 4;
          alternate = statement();
        }
        const kind = conditionKind(condition);
        if (kind === true) return consequent;
        if (kind === false) return alternate;
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
          const close = matchingDelimiter(body, index, "{", "}");
          if (close < 0 || close >= end) {
            index = end;
            return new Set(["unsafe"]);
          }
          const nested = outcomes(index + 1, close);
          index = close + 1;
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
          csharpThrowIsCausal(text, caughtName) ? "safe" : "unsafe",
        ]);
      }
      if (/^(?:return|goto)\b/.test(text)) return new Set(["unsafe"]);
      if (/^break\b/.test(text)) {
        return new Set([/^break\s*;\s*$/.test(text) ? "break" : "invalid"]);
      }
      if (/^continue\b/.test(text)) {
        return new Set([
          /^continue\s*;\s*$/.test(text) ? "continue" : "invalid",
        ]);
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
    if (registered.invalid) result.add("invalid");
    labelScopes.pop();
    return result;
  };

  const result = outcomes(0, body.length);
  return result.size === 1 && result.has("safe");
}

function catchAt(code, start) {
  if (!/^catch\b/.test(code.slice(start))) return null;
  let index = start + 5;
  while (/\s/.test(code[index] ?? "")) index += 1;
  let header = "";
  if (code[index] === "(") {
    const close = matchingDelimiter(code, index, "(", ")");
    if (close < 0) return null;
    header = code.slice(index + 1, close);
    index = close + 1;
  }
  while (/\s/.test(code[index] ?? "")) index += 1;
  let filter = "";
  if (/^when\b/.test(code.slice(index))) {
    index += 4;
    while (/\s/.test(code[index] ?? "")) index += 1;
    if (code[index] !== "(") return null;
    const close = matchingDelimiter(code, index, "(", ")");
    if (close < 0) return null;
    filter = code.slice(index + 1, close);
    index = close + 1;
  }
  while (/\s/.test(code[index] ?? "")) index += 1;
  if (code[index] !== "{") return null;
  const block = blockAt(code, index);
  if (!block) return null;
  const parsed = /^\s*((?:global::)?[\w.:]+)(?:\s+(\w+))?\s*$/.exec(header);
  return {
    body: block.body,
    caughtName: parsed?.[2] ?? null,
    end: block.end,
    filter,
    start,
    type: parsed?.[1] ?? null,
  };
}

function allCatches(code) {
  const result = [];
  for (const match of code.matchAll(/\bcatch\b/g)) {
    const caught = catchAt(code, match.index);
    if (caught) result.push(caught);
  }
  return result;
}

function exactRequestFailedCatch(caught, types) {
  if (canonicalType(caught.type, types) === "RequestFailedException") {
    return true;
  }
  if (!caught.caughtName || !caught.filter) return false;
  const name = escapeRegExp(caught.caughtName);
  const match = new RegExp(
    `^\\s*\\(?\\s*${name}\\s+is\\s+((?:global::)?[\\w.:]+)(?:\\s+\\w+)?\\s*\\)?\\s*$`,
  ).exec(caught.filter);
  return (
    match !== null &&
    canonicalType(match[1], types) === "RequestFailedException"
  );
}

function usefulRequestCatch(caught) {
  if (!caught.caughtName) return false;
  const name = escapeRegExp(caught.caughtName);
  return new RegExp(
    String.raw`\b(?:(?:System\s*\.\s*)?Console\s*\.\s*(?:Error\s*\.\s*|Out\s*\.\s*)?(?:Write|WriteLine)|(?:System\s*\.\s*Diagnostics\s*\.\s*)?(?:Debug|Trace)\s*\.\s*(?:Write|WriteLine|Trace\w*)|(?:this\s*\.\s*)?\w+(?:\s*\.\s*\w+)*\s*\.\s*Log(?:Trace|Debug|Information|Warning|Error|Critical)?)\s*\([^;]*\b${name}\s*(?:\.\s*(?:Message|Status|ErrorCode|ToString)\b)?`,
  ).test(caught.body);
}

function attachedCatches(code, blockEnd) {
  const catches = [];
  let index = blockEnd;
  while (index < code.length) {
    while (/\s/.test(code[index] ?? "")) index += 1;
    const caught = catchAt(code, index);
    if (!caught) break;
    catches.push(caught);
    index = caught.end;
  }
  return catches;
}

function hasRequestFailedHandling(analysis) {
  const catches = allCatches(analysis.code);
  let meaningful = false;
  const protectedCatches = new Set();
  const reachableCatches = new Set();
  for (const match of analysis.code.matchAll(/\btry\s*\{/g)) {
    const block = blockAt(
      analysis.code,
      analysis.code.indexOf("{", match.index),
    );
    if (!block) continue;
    if (csharpTryBodyMayThrow(block.body, analysis)) {
      for (const caught of attachedCatches(analysis.code, block.end)) {
        reachableCatches.add(caught.start);
      }
    }
    const relevant = analysis.events.some(
      (event) =>
        ["set", "get", "delete-start", "purge"].includes(event.kind) &&
        block.start < event.site &&
        event.site < block.end,
    );
    if (!relevant) continue;
    for (const caught of attachedCatches(analysis.code, block.end)) {
      if (
        exactRequestFailedCatch(caught, analysis.types) &&
        (usefulRequestCatch(caught) ||
          csharpHandlerAlwaysCausal(caught.body, caught.caughtName))
      ) {
        meaningful = true;
        protectedCatches.add(caught.start);
      }
    }
  }
  if (!meaningful) return false;
  return catches.every(
    (caught) =>
      !reachableCatches.has(caught.start) ||
      protectedCatches.has(caught.start) ||
      csharpHandlerAlwaysCausal(caught.body, caught.caughtName),
  );
}

function projectDocuments(project) {
  const withoutComments = project.replace(/<!--[\s\S]*?-->/g, " ");
  return [
    ...withoutComments.matchAll(
      /<(?:\w+:)?Project\b[^>]*>[\s\S]*?<\/(?:\w+:)?Project\s*>/gi,
    ),
  ].map((match) => match[0]);
}

function xmlAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(
    /\b([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g,
  )) {
    attributes.set(match[1].toLowerCase(), match[3].trim());
  }
  return attributes;
}

function xmlChildValue(source, name) {
  return new RegExp(
    String.raw`<(?:\w+:)?${name}\b[^>]*>([^<]*)<\/(?:\w+:)?${name}\s*>`,
    "i",
  ).exec(source)?.[1]?.trim();
}

function staticConditionValue(condition) {
  if (condition === undefined) return null;
  const tokens =
    condition.match(
      /"(?:[^"]|"")*"|'(?:[^']|'')*'|==|!=|&&|\|\||[()!]|[^\s()!&|=]+/g,
    ) ?? [];
  let index = 0;
  const literal = (token) => {
    if (token === undefined) return { known: false };
    const quoted =
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'));
    const value = quoted ? token.slice(1, -1) : token;
    if (/[$%@]\(/.test(value)) return { known: false };
    if (/^(?:true|false)$/i.test(value)) {
      return { known: true, value: value.toLowerCase() === "true" };
    }
    if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      return { known: true, value: Number(value) };
    }
    return quoted ? { known: true, value } : { known: false };
  };
  const boolean = (value) => {
    if (!value.known) return null;
    if (typeof value.value === "boolean") return value.value;
    if (typeof value.value === "number") return value.value !== 0;
    return null;
  };
  const combine = (left, right, operator) => {
    if (operator === "and") {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : null;
    }
    if (left === true || right === true) return true;
    return left === false && right === false ? false : null;
  };
  const primary = () => {
    if (tokens[index] === "(") {
      index += 1;
      const value = disjunction();
      if (tokens[index] !== ")") return { known: false };
      index += 1;
      return { known: value !== null, value };
    }
    const value = literal(tokens[index]);
    index += 1;
    return value;
  };
  const comparison = () => {
    const left = primary();
    const operator = tokens[index];
    if (!["==", "!="].includes(operator)) return boolean(left);
    index += 1;
    const right = primary();
    if (!left.known || !right.known) return null;
    return operator === "==" ? left.value === right.value : left.value !== right.value;
  };
  const unary = () => {
    if (/^(?:!|not)$/i.test(tokens[index] ?? "")) {
      index += 1;
      const value = unary();
      return value === null ? null : !value;
    }
    return comparison();
  };
  const conjunction = () => {
    let value = unary();
    while (/^(?:and|&&)$/i.test(tokens[index] ?? "")) {
      index += 1;
      value = combine(value, unary(), "and");
    }
    return value;
  };
  function disjunction() {
    let value = conjunction();
    while (/^(?:or|\|\|)$/i.test(tokens[index] ?? "")) {
      index += 1;
      value = combine(value, conjunction(), "or");
    }
    return value;
  }
  const result = disjunction();
  return index === tokens.length ? result : null;
}

function staticConditionIsFalse(condition) {
  return staticConditionValue(condition) === false;
}

function staticallyDisabledAncestor(document, referenceIndex) {
  const stack = [];
  const tagPattern = /<\/?(?:\w+:)?(Project|PropertyGroup|ItemGroup)\b[^>]*>/gi;
  for (const match of document.matchAll(tagPattern)) {
    if (match.index >= referenceIndex) break;
    if (/^<\//.test(match[0])) stack.pop();
    else if (!/\/\s*>$/.test(match[0])) {
      stack.push(xmlAttributes(match[0]).get("condition"));
    }
  }
  return stack.some(staticConditionIsFalse);
}

function staticallyDisabledChooseBranch(document, referenceIndex) {
  const chooses = [];
  const stack = [];
  const tags = /<\/?(?:\w+:)?(Choose|When|Otherwise)\b[^>]*>/gi;
  for (const match of document.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    if (/^<\//.test(match[0])) {
      const position = stack.map(({ tag: name }) => name).lastIndexOf(tag);
      if (position === -1) continue;
      const closed = stack[position];
      closed.end = match.index + match[0].length;
      stack.length = position;
      continue;
    }
    const entry = {
      condition: xmlAttributes(match[0]).get("condition"),
      end: document.length,
      start: match.index,
      tag,
    };
    if (tag === "choose") {
      entry.branches = [];
      chooses.push(entry);
    } else {
      const parent = [...stack].reverse().find(({ tag: name }) => name === "choose");
      parent?.branches.push(entry);
    }
    if (!/\/\s*>$/.test(match[0])) stack.push(entry);
  }
  return chooses.some((choose) => {
    if (!(choose.start <= referenceIndex && referenceIndex < choose.end)) {
      return false;
    }
    const branch = choose.branches.find(
      (candidate) =>
        candidate.start <= referenceIndex && referenceIndex < candidate.end,
    );
    if (!branch) return false;
    let selectionClosed = false;
    for (const candidate of choose.branches) {
      if (candidate === branch) {
        return (
          selectionClosed ||
          (candidate.tag === "when" &&
            staticConditionValue(candidate.condition) === false)
        );
      }
      if (
        !selectionClosed &&
        candidate.tag === "when" &&
        staticConditionValue(candidate.condition) === true
      ) {
        selectionClosed = true;
      }
    }
    return false;
  });
}

function activeProperties(document) {
  const properties = new Map();
  for (const group of document.matchAll(
    /<(?:\w+:)?PropertyGroup\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?PropertyGroup\s*>/gi,
  )) {
    if (
      staticConditionIsFalse(xmlAttributes(group[1]).get("condition")) ||
      staticallyDisabledAncestor(document, group.index) ||
      staticallyDisabledChooseBranch(document, group.index)
    ) {
      continue;
    }
    for (const property of group[2].matchAll(
      /<(?:\w+:)?([A-Za-z_][\w.-]*)\b([^>]*)>([^<]*)<\/(?:\w+:)?\1\s*>/gi,
    )) {
      const bodyOffset = group[0].indexOf(group[2]);
      const absoluteIndex = group.index + bodyOffset + property.index;
      const condition = xmlAttributes(property[2]).get("condition");
      if (
        staticConditionIsFalse(condition) ||
        staticallyDisabledChooseBranch(document, absoluteIndex)
      ) {
        continue;
      }
      properties.set(property[1].toLowerCase(), property[3].trim());
    }
  }
  return properties;
}

function resolveMsbuildValue(value, properties, resolving = new Set()) {
  let unresolved = false;
  const resolved = value.replace(
    /\$\(([A-Za-z_][\w.-]*)\)/g,
    (_reference, propertyName) => {
      const key = propertyName.toLowerCase();
      if (resolving.has(key) || !properties.has(key)) {
        unresolved = true;
        return "";
      }
      const nested = resolveMsbuildValue(
        properties.get(key),
        properties,
        new Set([...resolving, key]),
      );
      if (nested === null) {
        unresolved = true;
        return "";
      }
      return nested;
    },
  );
  return unresolved || /\$\([^)]+\)/.test(resolved) ? null : resolved.trim();
}

function hasNet8Target(properties) {
  const values = [];
  for (const name of ["targetframework", "targetframeworks"]) {
    if (!properties.has(name)) continue;
    const resolved = resolveMsbuildValue(
      properties.get(name),
      properties,
      new Set([name]),
    );
    if (resolved === null) return false;
    values.push(...resolved.split(";").map((value) => value.trim()));
  }
  return values.some((value) =>
    /^net8\.0(?:-[a-z][a-z0-9]*(?:\.[0-9]+)*)?$/i.test(value),
  );
}

function activePackageReferences(document, properties) {
  const references = [];
  for (const match of document.matchAll(
    /<(?:\w+:)?PackageReference\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?PackageReference\s*>)/gi,
  )) {
    const attributes = xmlAttributes(match[1]);
    const body = match[2] ?? "";
    const condition =
      attributes.get("condition") ?? xmlChildValue(body, "Condition");
    const excludeAssets =
      attributes.get("excludeassets") ?? xmlChildValue(body, "ExcludeAssets");
    const includeAssets =
      attributes.get("includeassets") ?? xmlChildValue(body, "IncludeAssets");
    const excluded = new Set(
      (excludeAssets ?? "").split(";").map((value) => value.trim().toLowerCase()),
    );
    const included = new Set(
      (includeAssets ?? "all").split(";").map((value) => value.trim().toLowerCase()),
    );
    if (
      !isProjectItem(document, match.index) ||
      staticConditionIsFalse(condition) ||
      staticallyDisabledAncestor(document, match.index) ||
      staticallyDisabledChooseBranch(document, match.index) ||
      excluded.has("all") ||
      excluded.has("compile") ||
      included.has("none") ||
      (!included.has("all") && !included.has("compile"))
    ) {
      continue;
    }
    const include =
      attributes.get("include") ?? xmlChildValue(body, "Include");
    const version =
      attributes.get("version") ?? xmlChildValue(body, "Version");
    references.push({
      include: include ? resolveMsbuildValue(include, properties) : null,
      version: version ? resolveMsbuildValue(version, properties) : null,
    });
  }
  return references;
}

function isProjectItem(document, referenceIndex) {
  const stack = [];
  const tags = /<\/?(?:\w+:)?([A-Za-z_][\w.-]*)\b[^>]*>/gi;
  for (const match of document.matchAll(tags)) {
    if (match.index >= referenceIndex) break;
    const name = match[1].toLowerCase();
    if (/^<\//.test(match[0])) {
      const position = stack.lastIndexOf(name);
      if (position >= 0) stack.length = position;
    } else if (!/\/\s*>$/.test(match[0])) {
      stack.push(name);
    }
  }
  if (stack.at(-1) !== "itemgroup") return false;
  return stack.slice(0, -1).every((name) =>
    ["project", "choose", "when", "otherwise"].includes(name),
  );
}

function compatiblePackage(references, name, major) {
  return references.some(
    (reference) => {
      if (reference.include?.toLowerCase() !== name.toLowerCase()) {
        return false;
      }
      const version = /^\[?(\d+)\.\d+\.\d+(?:\.\d+)?\]?$/.exec(
        reference.version ?? "",
      );
      return version !== null && Number(version[1]) === major;
    },
  );
}

function msbuildTree(document) {
  const root = {
    attributes: new Map(),
    children: [],
    name: "#document",
    text: "",
  };
  const stack = [root];
  const tags =
    /<\s*(\/?)\s*(?:\w+:)?([A-Za-z_][\w.-]*)\b([^>]*?)(\/?)\s*>/g;
  let cursor = 0;
  let match;
  while ((match = tags.exec(document)) !== null) {
    stack.at(-1).text += document.slice(cursor, match.index);
    cursor = tags.lastIndex;
    const name = match[2].toLowerCase();
    if (match[1]) {
      const position = stack
        .map((node) => node.name)
        .lastIndexOf(name);
      if (position > 0) stack.length = position;
      continue;
    }
    const node = {
      attributes: xmlAttributes(match[3]),
      children: [],
      name,
      text: "",
    };
    stack.at(-1).children.push(node);
    if (!match[4]) stack.push(node);
  }
  stack.at(-1).text += document.slice(cursor);
  return root;
}

function cloneMsbuildState(state) {
  return {
    properties: new Map(state.properties),
    references: state.references.map((reference) => ({ ...reference })),
  };
}

function msbuildCondition(condition, properties) {
  if (condition === undefined) return true;
  const expanded = resolveMsbuildValue(condition, properties);
  return expanded === null ? null : staticConditionValue(expanded);
}

function evaluateMsbuildDocument(document) {
  const tree = msbuildTree(document);
  const processConditional = (node, state, body) => {
    const condition = msbuildCondition(
      node.attributes.get("condition"),
      state.properties,
    );
    if (condition === false) return [state];
    const executed = body(cloneMsbuildState(state));
    return condition === true ? executed : [state, ...executed];
  };
  const processNodes = (nodes, states, packageReferencesAllowed = false) => {
    let current = states;
    for (const node of nodes) {
      current = current.flatMap((state) =>
        processNode(node, state, packageReferencesAllowed)
      );
    }
    return current;
  };
  const processChoose = (node, state) => {
    let remaining = [state];
    const selected = [];
    let otherwise = null;
    for (const branch of node.children) {
      if (branch.name === "otherwise") {
        otherwise = branch;
        continue;
      }
      if (branch.name !== "when") continue;
      const nextRemaining = [];
      for (const candidate of remaining) {
        const condition = msbuildCondition(
          branch.attributes.get("condition"),
          candidate.properties,
        );
        if (condition !== false) {
          selected.push(
            ...processNodes(
              branch.children,
              [cloneMsbuildState(candidate)],
            ),
          );
        }
        if (condition !== true) nextRemaining.push(candidate);
      }
      remaining = nextRemaining;
    }
    if (otherwise) {
      selected.push(
        ...remaining.flatMap((candidate) =>
          processNodes(
            otherwise.children,
            [cloneMsbuildState(candidate)],
          )
        ),
      );
      remaining = [];
    }
    return [...selected, ...remaining];
  };
  const processNode = (
    node,
    state,
    packageReferencesAllowed = false,
  ) => {
    if (["target", "usingtask"].includes(node.name)) return [state];
    if (node.name === "choose") return processChoose(node, state);
    if (node.name === "propertygroup") {
      return processConditional(node, state, (candidate) =>
        processNodes(node.children, [candidate])
      );
    }
    if (node.name === "itemgroup") {
      return processConditional(node, state, (candidate) =>
        processNodes(
          node.children.filter(
            (childNode) => childNode.name === "packagereference",
          ),
          [candidate],
          true,
        )
      );
    }
    if (node.name === "packagereference") {
      if (!packageReferencesAllowed) return [state];
      return processConditional(node, state, (candidate) => {
        const childValue = (name) =>
          node.children.find((childNode) => childNode.name === name)
            ?.text.trim();
        const excludeAssets =
          node.attributes.get("excludeassets") ??
          childValue("excludeassets") ??
          "";
        const includeAssets =
          node.attributes.get("includeassets") ??
          childValue("includeassets") ??
          "all";
        const excluded = new Set(
          excludeAssets
            .split(";")
            .map((value) => value.trim().toLowerCase()),
        );
        const included = new Set(
          includeAssets
            .split(";")
            .map((value) => value.trim().toLowerCase()),
        );
        if (
          excluded.has("all") ||
          excluded.has("compile") ||
          included.has("none") ||
          (!included.has("all") && !included.has("compile"))
        ) {
          return [candidate];
        }
        const include =
          node.attributes.get("include") ?? childValue("include");
        const version =
          node.attributes.get("version") ?? childValue("version");
        candidate.references.push({
          include: include
            ? resolveMsbuildValue(include, candidate.properties)
            : null,
          version: version
            ? resolveMsbuildValue(version, candidate.properties)
            : null,
        });
        return [candidate];
      });
    }
    if (
      node.children.length === 0 &&
      !["project", "when", "otherwise"].includes(node.name)
    ) {
      return processConditional(node, state, (candidate) => {
        const value = resolveMsbuildValue(
          node.text.trim(),
          candidate.properties,
        );
        candidate.properties.set(
          node.name,
          value ?? node.text.trim(),
        );
        return [candidate];
      });
    }
    return processNodes(node.children, [state]);
  };
  return processNodes(tree.children, [{
    properties: new Map(),
    references: [],
  }]);
}

function hasRequiredManifest(project) {
  return projectDocuments(project).some((document) => {
    return evaluateMsbuildDocument(document).some(
      ({ properties, references }) =>
        compatiblePackage(references, "Azure.Identity", 1) &&
        compatiblePackage(
          references,
          "Azure.Security.KeyVault.Secrets",
          4,
        ),
    );
  });
}

export function loadWorkspace(root) {
  const sourceFiles = [];
  const projectFiles = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".vally" || entry.name === "bin" || entry.name === "obj") {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".cs")) sourceFiles.push(path);
      else if (entry.name.endsWith(".csproj")) projectFiles.push(path);
    }
  };
  visit(root);
  return {
    projectFiles,
    sourceFiles,
    project: projectFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
    source: sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
  };
}

const rules = {
  "prompt/key-vault-manifest": ({ project }) => hasRequiredManifest(project),
  "prompt/default-azure-credential": ({ analysis }) =>
    analysis.credentialFound,
  "prompt/secret-client": ({ analysis }) => analysis.clientFound,
  "prompt/create-secret": ({ lifecycle: flow }) => Boolean(flow.create),
  "prompt/get-print-secret": ({ lifecycle: flow }) =>
    Boolean(flow.get && flow.output),
  "prompt/update-secret": ({ lifecycle: flow }) => Boolean(flow.update),
  "prompt/delete-wait-purge": ({ lifecycle: flow }) =>
    Boolean(flow.deletion && flow.wait && flow.purge),
  "prompt/request-failed-error": ({ analysis }) =>
    hasRequestFailedHandling(analysis),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const source = workspace.source ?? "";
  if (source.trim() === "") return false;
  if (name === "prompt/key-vault-manifest") {
    return Boolean(rule({ project: workspace.project ?? "" }));
  }
  const analysis = analyze(source);
  return Boolean(rule({ analysis, lifecycle: lifecycle(analysis) }));
}

export function ruleNames() {
  return Object.keys(rules);
}
