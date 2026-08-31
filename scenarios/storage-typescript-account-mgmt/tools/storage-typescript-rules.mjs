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

function balancedText(source, openingIndex, opening = "(", closing = ")") {
  const code = maskSource(source, false);
  let depth = 0;
  for (let index = openingIndex; index < code.length; index += 1) {
    if (code[index] === opening) depth += 1;
    if (code[index] === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(openingIndex + 1, index);
    }
  }
  return "";
}

function splitTopLevel(text) {
  const code = maskSource(text, false);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    if (")]}".includes(code[index])) depth -= 1;
    if (code[index] === "," && depth === 0) {
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
    if (")]}".includes(code[index])) depth -= 1;
    if (code[index] === ";" && depth === 0) return index;
  }
  return code.length;
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

function skipSpace(code, start) {
  let index = start;
  while (index < code.length && /\s/.test(code[index])) index += 1;
  return index;
}

function statementRange(code, start) {
  const bodyStart = skipSpace(code, start);
  if (code[bodyStart] === "{") {
    const closing = matchingClosing(code, bodyStart, "{", "}");
    return {
      contentEnd: closing === -1 ? code.length : closing,
      contentStart: bodyStart + 1,
      end: closing === -1 ? code.length : closing + 1,
    };
  }
  let depth = 0;
  for (let index = bodyStart; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    if (")]}".includes(code[index])) depth -= 1;
    if (code[index] === ";" && depth === 0) {
      return { contentEnd: index + 1, contentStart: bodyStart, end: index + 1 };
    }
  }
  return { contentEnd: code.length, contentStart: bodyStart, end: code.length };
}

function normalizedCondition(text) {
  let value = text.replace(/\s+/g, "");
  while (value.startsWith("(") && value.endsWith(")")) {
    const closing = matchingClosing(value, 0);
    if (closing !== value.length - 1) break;
    value = value.slice(1, -1);
  }
  let inverted = false;
  while (value.startsWith("!")) {
    inverted = !inverted;
    value = value.slice(1);
    while (value.startsWith("(") && value.endsWith(")")) {
      const closing = matchingClosing(value, 0);
      if (closing !== value.length - 1) break;
      value = value.slice(1, -1);
    }
  }
  return { inverted, value };
}

function triStateTypeScriptBoolean(
  expression,
  position,
  bindings,
  joins = [],
  seen = new Set(),
) {
  const tokens =
    expression.match(/&&|\|\||===|!==|==|!=|[()!]|[A-Za-z_$]\w*|[01]/g) ??
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
    if (token === "true" || token === "1") return true;
    if (token === "false" || token === "0") return false;
    if (!/^[A-Za-z_$]\w*$/.test(token ?? "")) return null;
    const join = joins
      .filter((candidate) =>
        candidate.name === token && candidate.position <= position
      )
      .at(-1);
    if (join) return join.boolean ?? join.value ?? null;
    const key = `${token}:${position}`;
    if (seen.has(key)) return null;
    const binding = bindings.resolve(token, position);
    const latest = bindings.latest(binding, position);
    if (!latest?.expression) return null;
    return triStateTypeScriptBoolean(
      latest.expression,
      latest.expressionStart ?? latest.index,
      bindings,
      joins,
      new Set(seen).add(key),
    );
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
    if (!["==", "!=", "===", "!=="].includes(operator)) return left;
    index += 1;
    const right = unary();
    if (left === null || right === null) return null;
    return ["==", "==="].includes(operator)
      ? left === right
      : left !== right;
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

function splitTypeScriptAddition(expression) {
  const code = maskSource(expression);
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    else if (")]}".includes(code[index])) depth -= 1;
    else if (code[index] === "+" && depth === 0) {
      if (code[index - 1] === "+" || code[index + 1] === "+") continue;
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (parts.length > 0) parts.push(expression.slice(start).trim());
  return parts;
}

function unwrapTypeScriptConstant(expression) {
  let value = expression.trim()
    .replace(/\s+as\s+const\s*$/, "")
    .replace(/!\s*$/, "")
    .trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    const close = matchingClosing(maskSource(value), 0);
    if (close !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function constantTypeScriptString(
  expression,
  position,
  bindings,
  joins = [],
  seen = new Set(),
) {
  const value = unwrapTypeScriptConstant(expression);
  const additions = splitTypeScriptAddition(value);
  if (additions.length > 0) {
    const parts = additions.map((part) =>
      constantTypeScriptString(part, position, bindings, joins, seen)
    );
    return parts.every(Boolean)
      ? {
          kind: "string",
          value: parts.map((part) => part.value).join(""),
        }
      : null;
  }
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  if (quoted) {
    try {
      return {
        kind: "string",
        value: quoted[1] === '"'
          ? JSON.parse(value)
          : quoted[2]
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, "\\")
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t"),
      };
    } catch {
      return null;
    }
  }
  if (value.startsWith("`") && value.endsWith("`")) {
    const body = value.slice(1, -1);
    let result = "";
    for (let index = 0; index < body.length; index += 1) {
      if (body[index] === "\\") {
        const escaped = body[index + 1] ?? "";
        result += { n: "\n", t: "\t", "`": "`", "\\": "\\" }[escaped] ??
          escaped;
        index += 1;
        continue;
      }
      if (body[index] !== "$" || body[index + 1] !== "{") {
        result += body[index];
        continue;
      }
      let depth = 1;
      let close = index + 2;
      for (; close < body.length && depth > 0; close += 1) {
        if (body[close] === "{") depth += 1;
        else if (body[close] === "}") depth -= 1;
      }
      if (depth !== 0) return null;
      const part = constantTypeScriptString(
        body.slice(index + 2, close - 1),
        position,
        bindings,
        joins,
        seen,
      );
      if (!part) return null;
      result += part.value;
      index = close - 1;
    }
    return { kind: "string", value: result };
  }
  if (!/^[A-Za-z_$]\w*$/.test(value)) return null;
  const joined = joins
    .filter((candidate) =>
      candidate.name === value && candidate.position <= position
    )
    .at(-1);
  if (joined && "string" in joined) return joined.string;
  const key = `${value}:${position}:string`;
  if (seen.has(key)) return null;
  const binding = bindings.resolve(value, position);
  const latest = bindings.latest(binding, position);
  if (!latest?.expression) return null;
  return constantTypeScriptString(
    latest.expression,
    latest.expressionStart ?? latest.index,
    bindings,
    joins,
    new Set(seen).add(key),
  );
}

function typeScriptIterableState(
  expression,
  position,
  bindings,
  joins = [],
  seen = new Set(),
) {
  const value = unwrapTypeScriptConstant(expression).replace(/\s+/g, "");
  if (value === "[]" || /^(?:new)?(?:Array|Set|Map)\(\)$/.test(value)) {
    return "empty";
  }
  if (
    /^\[[^\]]+\]$/.test(value) ||
    /^(?:new)?(?:Array|Set|Map)\([^)]*\S[^)]*\)$/.test(value)
  ) {
    return "nonempty";
  }
  if (!/^[A-Za-z_$]\w*$/.test(value)) return null;
  const joined = joins
    .filter((candidate) =>
      candidate.name === value && candidate.position <= position
    )
    .at(-1);
  if (joined && "iterable" in joined) return joined.iterable;
  const key = `${value}:${position}:iterable`;
  if (seen.has(key)) return null;
  const binding = bindings.resolve(value, position);
  const latest = bindings.latest(binding, position);
  if (!latest?.expression) return null;
  return typeScriptIterableState(
    latest.expression,
    latest.expressionStart ?? latest.index,
    bindings,
    joins,
    new Set(seen).add(key),
  );
}

function buildControlFlow(source, callables, bindings) {
  const code = maskSource(source);
  const branches = [];
  const branchGroups = [];
  const conditions = new Map();
  const joins = [];
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const conditionOpening = match.index + match[0].lastIndexOf("(");
    const conditionClosing = matchingClosing(code, conditionOpening);
    if (conditionClosing === -1) continue;
    const condition = normalizedCondition(
      source.slice(conditionOpening + 1, conditionClosing),
    );
    const owner = ownerAt(callables, match.index)?.id ?? "<top-level>";
    const key = `${owner}:${condition.value}`;
    conditions.set(
      key,
      condition.value,
    );
    const thenRange = statementRange(code, conditionClosing + 1);
    const constant = triStateTypeScriptBoolean(
      source.slice(conditionOpening + 1, conditionClosing),
      conditionOpening,
      bindings,
      joins,
    );
    const thenBranch = {
      end: thenRange.contentEnd,
      key,
      reachable: constant !== false,
      start: thenRange.contentStart,
      value: !condition.inverted,
    };
    branches.push(thenBranch);
    const afterThen = skipSpace(code, thenRange.end);
    let elseBranch = null;
    let totalEnd = thenRange.end;
    if (code.slice(afterThen).startsWith("else")) {
      const elseRange = statementRange(code, afterThen + 4);
      elseBranch = {
        end: elseRange.contentEnd,
        key,
        reachable: constant !== true,
        start: elseRange.contentStart,
        value: condition.inverted,
      };
      branches.push(elseBranch);
      totalEnd = elseRange.end;
    }
    branchGroups.push({
      constant,
      elseBranch,
      end: totalEnd,
      key,
      start: match.index,
      thenBranch,
    });

    const assignments = (range) => {
      const result = new Map();
      if (!range) return result;
      const fragment = code.slice(range.start, range.end);
      const pattern =
        /(?:\b(?:const|let|var)\s+)?([A-Za-z_$]\w*)\s*(?::[^=;\n]+)?=\s*([^;\n}]+)/g;
      for (const assignment of fragment.matchAll(pattern)) {
        const expressionOffset =
          assignment.index + assignment[0].lastIndexOf(assignment[2]);
        const expressionPosition = range.start + expressionOffset;
        const expression = source.slice(
          expressionPosition,
          expressionPosition + assignment[2].length,
        );
        result.set(
          assignment[1],
          {
            boolean: triStateTypeScriptBoolean(
              expression,
              expressionPosition,
              bindings,
              joins,
            ),
            iterable: typeScriptIterableState(
              expression,
              expressionPosition,
              bindings,
              joins,
            ),
            string: constantTypeScriptString(
              expression,
              expressionPosition,
              bindings,
              joins,
            ),
          },
        );
      }
      return result;
    };
    const thenAssignments = assignments(thenBranch);
    const elseAssignments = assignments(elseBranch);
    const names = new Set([
      ...thenAssignments.keys(),
      ...elseAssignments.keys(),
    ]);
    for (const name of names) {
      const base = {
        boolean: triStateTypeScriptBoolean(
          name,
          match.index,
          bindings,
          joins,
        ),
        iterable: typeScriptIterableState(
          name,
          match.index,
          bindings,
          joins,
        ),
        string: constantTypeScriptString(
          name,
          match.index,
          bindings,
          joins,
        ),
      };
      const values = (domain) => {
        const candidates = [];
        if (constant !== false) {
          candidates.push(
            thenAssignments.has(name)
              ? thenAssignments.get(name)[domain]
              : base[domain],
          );
        }
        if (constant !== true) {
          candidates.push(
            elseAssignments.has(name)
              ? elseAssignments.get(name)[domain]
              : base[domain],
          );
        }
        const first = JSON.stringify(candidates[0]);
        return candidates.length > 0 &&
            candidates.every((value) => JSON.stringify(value) === first)
          ? candidates[0]
          : null;
      };
      joins.push({
        boolean: values("boolean"),
        iterable: values("iterable"),
        name,
        position: totalEnd,
        string: values("string"),
      });
    }
  }

  const braceStack = [];
  const bracePairs = [];
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === "{") braceStack.push(index);
    if (code[index] === "}" && braceStack.length > 0) {
      bracePairs.push({ end: index, start: braceStack.pop() });
    }
  }
  const abrupt = [];
  for (const match of code.matchAll(/\b(?:return|throw|break|continue)\b/g)) {
    if (
      branches.some(
        (branch) => branch.start <= match.index && match.index < branch.end,
      )
    ) {
      continue;
    }
    const block = bracePairs
      .filter((pair) => pair.start < match.index && match.index < pair.end)
      .sort((left, right) => right.start - left.start)[0];
    if (!block) continue;
    let end = match.index + match[0].length;
    let depth = 0;
    for (; end < block.end; end += 1) {
      if ("([{".includes(code[end])) depth += 1;
      if (")]}".includes(code[end])) depth -= 1;
      if (code[end] === ";" && depth === 0) {
        end += 1;
        break;
      }
    }
    abrupt.push({ end: block.end, start: end });
  }

  const branchTerminates = (branch) => {
    if (!branch) return false;
    const fragment = code.slice(branch.start, branch.end);
    let depth = 0;
    for (const match of fragment.matchAll(/[{}]|\b(?:return|throw)\b/g)) {
      if (match[0] === "{") depth += 1;
      else if (match[0] === "}") depth -= 1;
      else if (depth === 0) return true;
    }
    return false;
  };
  for (const group of branchGroups) {
    const thenTerminates = branchTerminates(group.thenBranch);
    const elseTerminates = branchTerminates(group.elseBranch);
    if (!thenTerminates && !elseTerminates) continue;
    const parent = bracePairs
      .filter((pair) => pair.start < group.start && group.end <= pair.end)
      .sort((left, right) => right.start - left.start)[0];
    if (!parent) continue;
    if (
      (group.constant === true && thenTerminates) ||
      (group.constant === false && elseTerminates) ||
      (thenTerminates && elseTerminates)
    ) {
      abrupt.push({ end: parent.end, start: group.end });
      continue;
    }
    if (group.constant === null) {
      branches.push({
        end: parent.end,
        key: group.key,
        reachable: true,
        start: group.end,
        value: thenTerminates
          ? group.elseBranch?.value ?? !group.thenBranch.value
          : group.thenBranch.value,
      });
    }
  }

  const loops = [];
  for (const match of code.matchAll(/\b(?:while|for(?:\s+await)?)\s*\(/g)) {
    const conditionOpening = match.index + match[0].lastIndexOf("(");
    const conditionClosing = matchingClosing(code, conditionOpening);
    if (conditionClosing === -1) continue;
    const body = statementRange(code, conditionClosing + 1);
    const header = source.slice(conditionOpening + 1, conditionClosing);
    let conditionExpression = header;
    let constant;
    if (/^for\b/.test(match[0])) {
      const parts = splitControlHeader(header, ";");
      if (parts.length === 3) {
        conditionExpression = parts[1];
        constant = parts[1].trim() === ""
          ? true
          : triStateTypeScriptBoolean(
              parts[1],
              conditionOpening,
              bindings,
              joins,
            );
      } else {
        const iterable = header.split(/\b(?:of|in)\b/).at(-1) ?? "";
        const iterableState = typeScriptIterableState(
          iterable,
          conditionOpening,
          bindings,
          joins,
        );
        constant = iterableState === "empty" ? false : null;
        conditionExpression = iterable ?? header;
      }
    } else {
      constant = triStateTypeScriptBoolean(
        header,
        conditionOpening,
        bindings,
        joins,
      );
    }
    const owner = ownerAt(callables, match.index)?.id ?? "<top-level>";
    const key = `${owner}:loop:${match.index}`;
    conditions.set(key, conditionExpression);
    branches.push({
      end: body.contentEnd,
      key,
      reachable: constant !== false,
      start: body.contentStart,
      value: true,
    });
    loops.push({
      bodyEnd: body.contentEnd,
      bodyStart: body.contentStart,
      condition: source.slice(conditionOpening + 1, conditionClosing),
      conditionEnd: conditionClosing,
      conditionStart: conditionOpening + 1,
      end: body.end,
      start: match.index,
    });
  }

  for (let index = 0; index < code.length; index += 1) {
    if (
      code[index] !== "?" ||
      code[index + 1] === "." ||
      code[index + 1] === "?"
    ) {
      continue;
    }
    const colon = matchingTernaryColon(code, index);
    if (colon === -1) continue;
    const start = expressionBoundaryStart(code, index);
    const end = expressionBoundaryEnd(code, colon + 1);
    const conditionText = source.slice(start, index).trim()
      .replace(/^(?:return|throw|await)\s+/, "")
      .replace(/^.*=\s*/, "");
    if (!conditionText) continue;
    const condition = normalizedCondition(conditionText);
    const owner = ownerAt(callables, index)?.id ?? "<top-level>";
    const key = `${owner}:ternary:${index}:${condition.value}`;
    const constant = triStateTypeScriptBoolean(
      conditionText,
      start,
      bindings,
      joins,
    );
    conditions.set(key, condition.value);
    branches.push(
      {
        end: colon,
        key,
        reachable: constant !== false,
        start: index + 1,
        value: !condition.inverted,
      },
      {
        end,
        key,
        reachable: constant !== true,
        start: colon + 1,
        value: condition.inverted,
      },
    );
  }

  for (const match of code.matchAll(/&&|\|\|/g)) {
    const start = expressionBoundaryStart(code, match.index);
    const end = expressionBoundaryEnd(code, match.index + 2);
    const leftText = source.slice(start, match.index).trim()
      .replace(/^(?:return|throw|await)\s+/, "")
      .replace(/^.*=\s*/, "");
    if (!leftText) continue;
    const normalized = normalizedCondition(leftText);
    const owner = ownerAt(callables, match.index)?.id ?? "<top-level>";
    const key = `${owner}:short:${match.index}:${normalized.value}`;
    const constant = triStateTypeScriptBoolean(
      leftText,
      start,
      bindings,
      joins,
    );
    const requiresTrue = match[0] === "&&";
    conditions.set(key, normalized.value);
    branches.push({
      end,
      key,
      reachable:
        constant === null ||
        (requiresTrue ? constant === true : constant === false),
      start: match.index + 2,
      value: requiresTrue
        ? !normalized.inverted
        : normalized.inverted,
    });
  }

  for (const match of code.matchAll(/\btry\s*\{/g)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(code, opening, "{", "}");
    if (closing === -1) continue;
    const owner = ownerAt(callables, match.index)?.id ?? "<top-level>";
    const key = `${owner}:try:${match.index}`;
    const mayThrow = typeScriptMayThrow(
      code.slice(opening + 1, closing),
      callables,
      code,
    );
    branches.push({
      end: closing,
      key,
      reachable: true,
      start: opening + 1,
      value: "body",
    });
    let cursor = skipSpace(code, closing + 1);
    let catchIndex = 0;
    while (code.slice(cursor).startsWith("catch")) {
      const catchOpening = code.indexOf("{", cursor + 5);
      if (catchOpening === -1) break;
      const catchClosing = matchingClosing(code, catchOpening, "{", "}");
      if (catchClosing === -1) break;
      branches.push({
        end: catchClosing,
        key,
        reachable: mayThrow,
        start: catchOpening + 1,
        value: `catch:${catchIndex}`,
      });
      catchIndex += 1;
      cursor = skipSpace(code, catchClosing + 1);
    }
  }

  function context(position) {
    const constraints = new Map();
    let reachable = !abrupt.some(
      (range) => range.start <= position && position < range.end,
    );
    for (const branch of branches) {
      if (branch.start <= position && position < branch.end) {
        reachable &&= branch.reachable;
        const existing = constraints.get(branch.key);
        if (existing !== undefined && existing !== branch.value) {
          reachable = false;
        }
        constraints.set(branch.key, branch.value);
      }
    }
    return { constraints, reachable };
  }

  return {
    condition(key) {
      return conditions.get(key) ?? null;
    },
    context,
    joins,
    joinedValue(name, position, domain) {
      const joined = joins
        .filter((candidate) =>
          candidate.name === name && candidate.position <= position
        )
        .at(-1);
      return joined && domain in joined ? joined[domain] : undefined;
    },
    loopAt(position) {
      return loops
        .filter((loop) => loop.bodyStart <= position && position < loop.bodyEnd)
        .sort((left, right) => right.bodyStart - left.bodyStart)[0] ?? null;
    },
  };
}

function splitControlHeader(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if ("([{".includes(text[index])) depth += 1;
    else if (")]}".includes(text[index])) depth -= 1;
    else if (text[index] === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function expressionBoundaryStart(code, position) {
  let depth = 0;
  for (let index = position - 1; index >= 0; index -= 1) {
    if (")]}".includes(code[index])) depth += 1;
    else if ("([{".includes(code[index])) {
      if (depth === 0) return index + 1;
      depth -= 1;
    } else if (depth === 0 && /[;{}\n,]/.test(code[index])) {
      return index + 1;
    }
  }
  return 0;
}

function expressionBoundaryEnd(code, position) {
  let depth = 0;
  for (let index = position; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    else if (")]}".includes(code[index])) {
      if (depth === 0) return index;
      depth -= 1;
    } else if (depth === 0 && /[;{}\n,]/.test(code[index])) {
      return index;
    }
  }
  return code.length;
}

function matchingTernaryColon(code, question) {
  let nested = 0;
  let depth = 0;
  for (let index = question + 1; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    else if (")]}".includes(code[index])) {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (depth === 0 && code[index] === "?") nested += 1;
    else if (depth === 0 && code[index] === ":") {
      if (nested === 0) return index;
      nested -= 1;
    } else if (depth === 0 && /[;{}\n]/.test(code[index])) {
      return -1;
    }
  }
  return -1;
}

function typeScriptMayThrow(body, callables = [], fullCode = "", seen = new Set()) {
  const characters = [...body];
  for (const match of body.matchAll(
    /\b(?:if\s*\(\s*false\s*\)|for\s*\([^;]*;\s*false\s*;[^)]*\))\s*\{/g,
  )) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(body, opening, "{", "}");
    if (closing < 0) continue;
    for (let index = match.index; index <= closing; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  body = characters.join("");
  if (/\bthrow\b/.test(body)) return true;
  for (const match of body.matchAll(/\b([A-Za-z_$]\w*)\s*\(/g)) {
    if (["if", "for", "while", "switch", "catch"].includes(match[1])) {
      continue;
    }
    const candidates = callables.filter(
      (callable) =>
        callable.name === match[1] ||
        callable.name.endsWith(`.${match[1]}`),
    );
    if (candidates.length === 0) return true;
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      if (
        typeScriptMayThrow(
          fullCode.slice(candidate.bodyStart, candidate.bodyEnd),
          callables,
          fullCode,
          new Set(seen).add(candidate),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function mergePathContexts(...contexts) {
  const constraints = new Map();
  for (const context of contexts.filter(Boolean)) {
    if (!context.reachable) return null;
    for (const [key, value] of context.constraints) {
      const existing = constraints.get(key);
      if (existing !== undefined && existing !== value) return null;
      constraints.set(key, value);
    }
  }
  return { constraints, reachable: true };
}

function propertyValueEnd(code, start) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    if (")]}".includes(code[index])) {
      if (depth === 0) return index;
      depth -= 1;
    }
    if ((code[index] === "," || code[index] === ";") && depth === 0) {
      return index;
    }
  }
  return code.length;
}

function packageDependencies(packageJson) {
  try {
    const manifest = JSON.parse(packageJson);
    return manifest.dependencies ?? {};
  } catch {
    return {};
  }
}

function hasSource(workspace) {
  return typeof workspace.source === "string" && workspace.source.trim() !== "";
}

function importsFrom(source, moduleName) {
  const code = maskSource(source, false);
  const masked = maskSource(source);
  const modulePattern = escapeRegExp(moduleName);
  const named = new Map();
  const namespaces = new Set();
  const namedPattern = new RegExp(
    `\\bimport\\s*\\{([^}]+)\\}\\s*from\\s*["']${modulePattern}["']`,
    "g",
  );
  for (const match of code.matchAll(namedPattern)) {
    if (masked[match.index] !== "i") continue;
    for (const item of match[1].split(",")) {
      const parsed = item.trim().match(
        /^([A-Za-z_$]\w*)(?:\s+as\s+([A-Za-z_$]\w*))?$/,
      );
      if (parsed) named.set(parsed[1], parsed[2] ?? parsed[1]);
    }
  }
  const namespacePattern = new RegExp(
    `\\bimport\\s*\\*\\s*as\\s*([A-Za-z_$]\\w*)\\s*from\\s*["']${modulePattern}["']`,
    "g",
  );
  for (const match of code.matchAll(namespacePattern)) {
    if (masked[match.index] === "i") namespaces.add(match[1]);
  }
  return { named, namespaces };
}

function importTypeNames(source, moduleName, exportName) {
  const imports = importsFrom(source, moduleName);
  const names = new Set();
  const local = imports.named.get(exportName);
  if (local) names.add(local);
  for (const namespace of imports.namespaces) {
    names.add(`${namespace}.${exportName}`);
  }
  return names;
}

function matchingOpening(code, closingIndex) {
  let depth = 0;
  for (let index = closingIndex; index >= 0; index -= 1) {
    if (code[index] === ")") depth += 1;
    if (code[index] === "(") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parameterListBefore(source, code, end) {
  let closing = end - 1;
  while (closing >= 0 && /\s/.test(code[closing])) closing -= 1;
  if (code[closing] !== ")") {
    for (let index = closing; index >= 0; index -= 1) {
      if (";={}".includes(code[index])) return null;
      if (code[index] === ")") {
        if (!code.slice(index + 1, end).trim().startsWith(":")) return null;
        closing = index;
        break;
      }
    }
  }
  if (code[closing] !== ")") return null;
  const opening = matchingOpening(code, closing);
  return opening === -1
    ? null
    : { opening, parameters: source.slice(opening + 1, closing) };
}

function callableOpenings(source) {
  const code = maskSource(source);
  const openings = new Map();
  const controls = new Set(["catch", "for", "if", "switch", "while", "with"]);
  for (let brace = 0; brace < code.length; brace += 1) {
    if (code[brace] !== "{") continue;
    const prefix = code.slice(0, brace);
    const arrow = /=>\s*$/.exec(prefix);
    if (arrow) {
      const list = parameterListBefore(source, code, arrow.index);
      const single = prefix.slice(0, arrow.index).match(/([A-Za-z_$]\w*)\s*$/);
      openings.set(brace, list?.parameters ?? single?.[1] ?? "");
      continue;
    }
    const list = parameterListBefore(source, code, brace);
    if (!list) continue;
    const name = code.slice(0, list.opening).match(
      /([A-Za-z_$]\w*)\s*(?:<[^<>]*>)?\s*$/,
    )?.[1];
    if (name && !controls.has(name) && !/\bfor\s+await\s*$/.test(prefix)) {
      openings.set(brace, list.parameters);
    }
  }
  return openings;
}

function buildScopes(source) {
  const code = maskSource(source);
  const functionOpenings = callableOpenings(source);
  const root = {
    bindings: new Map(),
    end: source.length,
    functionScope: null,
    parent: null,
    start: 0,
  };
  root.functionScope = root;
  const scopes = [root];
  const stack = [root];
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === "{") {
      const parent = stack.at(-1);
      const scope = {
        bindings: new Map(),
        end: source.length,
        functionScope: null,
        parent,
        start: index + 1,
      };
      scope.functionScope = functionOpenings.has(index)
        ? scope
        : parent.functionScope;
      scopes.push(scope);
      stack.push(scope);
    } else if (code[index] === "}" && stack.length > 1) {
      stack.pop().end = index;
    }
  }
  return {
    at(position) {
      let selected = root;
      for (const scope of scopes) {
        if (
          scope.start <= position &&
          position < scope.end &&
          scope.start >= selected.start
        ) {
          selected = scope;
        }
      }
      return selected;
    },
    functionOpenings,
    root,
    scopes,
  };
}

function buildBindings(source, scopeIndex, imports) {
  const code = maskSource(source);
  const original = maskSource(source, false);
  const events = [];
  let nextId = 1;
  for (const imported of imports) {
    events.push({
      imported,
      index: imported.index,
      kind: "import",
      name: imported.local,
    });
  }
  const declarations =
    /\b(const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*(=)?/g;
  const declarationEquals = new Set();
  for (const match of code.matchAll(declarations)) {
    const equals = match[3] ? match.index + match[0].lastIndexOf("=") : -1;
    if (equals !== -1) declarationEquals.add(equals);
    events.push({
      declarationKind: match[1],
      equals,
      index: match.index,
      kind: "declaration",
      name: match[2],
    });
  }
  for (const [opening, parameters] of scopeIndex.functionOpenings) {
    for (const parameter of splitTopLevel(parameters)) {
      const name = parameter.match(/^(?:\.\.\.)?([A-Za-z_$]\w*)/)?.[1];
      if (name) {
        events.push({
          declarationKind: "let",
          equals: -1,
          index: opening + 1,
          kind: "parameter",
          name,
        });
      }
    }
  }
  const catches = /\bcatch\s*\(\s*([A-Za-z_$]\w*)[^)]*\)\s*\{/g;
  for (const match of code.matchAll(catches)) {
    events.push({
      declarationKind: "let",
      equals: -1,
      index: match.index + match[0].lastIndexOf("{") + 1,
      kind: "parameter",
      name: match[1],
    });
  }
  const assignments = /(?<![\w$.])([A-Za-z_$]\w*)\s*=(?!=|>)/g;
  for (const match of code.matchAll(assignments)) {
    const equals = match.index + match[0].lastIndexOf("=");
    if (!declarationEquals.has(equals)) {
      events.push({
        equals,
        index: match.index,
        kind: "assignment",
        name: match[1],
      });
    }
  }
  events.sort((left, right) =>
    left.index - right.index ||
    (left.kind === "import" ? -1 : left.kind === "declaration" ? 0 : 1),
  );

  function resolve(name, position) {
    if (!name) return null;
    for (let scope = scopeIndex.at(position); scope; scope = scope.parent) {
      const binding = scope.bindings.get(name);
      if (binding && binding.index <= position) return binding;
    }
    return null;
  }

  for (const event of events) {
    const lexicalScope = scopeIndex.at(event.index);
    const scope = event.declarationKind === "var"
        ? lexicalScope.functionScope
        : lexicalScope;
    let binding;
    if (["import", "declaration", "parameter"].includes(event.kind)) {
      binding = event.declarationKind === "var"
        ? scope.bindings.get(event.name)
        : null;
      if (!binding) {
        binding = {
          declarationKind: event.declarationKind ?? null,
          history: [],
          id: nextId++,
          imported: event.imported ?? null,
          index: event.index,
          kind: event.kind === "import" ? "import" : "local",
          name: event.name,
          scope,
        };
        scope.bindings.set(event.name, binding);
      } else if (event.kind !== "import") {
        binding.declarationKind = event.declarationKind;
        binding.kind = "local";
        binding.imported = null;
      }
    } else {
      binding = resolve(event.name, event.index);
    }
    if (!binding) continue;
    const start = event.equals + 1;
    binding.history.push({
      expression: event.equals === -1
        ? null
        : original.slice(start, expressionEnd(code, start)),
      expressionStart: start,
      index: event.index,
    });
  }

  return {
    latest(binding, position) {
      let latest = null;
      for (const entry of binding?.history ?? []) {
        if (entry.index > position) break;
        latest = entry;
      }
      return latest;
    },
    resolve,
  };
}

function extractCallables(source) {
  const code = maskSource(source);
  const callables = [];
  const sourceParameters = (match, fallback = "") => {
    const relative = match[0].indexOf("(");
    if (relative === -1) return fallback;
    const open = match.index + relative;
    const close = matchingClosing(code, open);
    return close === -1 ? fallback : source.slice(open + 1, close);
  };
  const add = (
    name,
    opening,
    parameters,
    kind = "function",
    owner = null,
    declarationStart = opening,
  ) => {
    const body = balancedText(source, opening, "{", "}");
    if (!body && source[opening + 1] !== "}") return;
    const parameterItems = splitTopLevel(parameters);
    const parsedParameters = parameterItems.map((item) =>
      item.match(/^(?:\.\.\.)?([A-Za-z_$]\w*)/)?.[1]
    );
    callables.push({
      bodyEnd: opening + body.length + 1,
      bodyStart: opening + 1,
      declarationStart,
      kind,
      name,
      owner,
      static: false,
      parameterDefaults: parameterItems
        .filter((_, index) => parsedParameters[index])
        .map((item) => {
          const equals = item.indexOf("=");
          return equals === -1 ? null : item.slice(equals + 1).trim();
        }),
      parameters: parsedParameters.filter(Boolean),
    });
  };

  const functions =
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$]\w*)\s*(?:<[^{};]*>)?\s*\(([^)]*)\)[^{]*\{/g;
  for (const match of code.matchAll(functions)) {
    add(
      match[1],
      match.index + match[0].lastIndexOf("{"),
      sourceParameters(match, match[2]),
      "function",
      null,
      match.index,
    );
  }
  const arrows =
    /\b(?:const|let|var)\s+([A-Za-z_$]\w*)[^=;\n]*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$]\w*))\s*(?::[^=]+)?=>\s*\{/g;
  for (const match of code.matchAll(arrows)) {
    add(
      match[1],
      match.index + match[0].lastIndexOf("{"),
      match[2] !== undefined
        ? sourceParameters(match, match[2])
        : match[3] ?? "",
      "function",
      null,
      match.index,
    );
  }

  const classRanges = [];
  const classes = /\bclass\s+([A-Za-z_$]\w*)[^{]*\{/g;
  for (const match of code.matchAll(classes)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const body = balancedText(source, opening, "{", "}");
    classRanges.push({
      end: opening + body.length + 1,
      name: match[1],
      start: opening + 1,
    });
  }
  const methods =
    /(?:^|[;,{}]\s*)(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+)*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$]\w*)\s*(?:<[^{};]*>)?\s*\(([^)]*)\)[^{;]*\{/gm;
  for (const match of code.matchAll(methods)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const classRange = classRanges
      .filter((range) => range.start <= opening && opening < range.end)
      .sort((left, right) => right.start - left.start)[0];
    if (classRange) {
      add(
        `${classRange.name}.${match[1]}`,
        opening,
        sourceParameters(match, match[2]),
        "class-method",
        classRange.name,
        match.index,
      );
      callables.at(-1).static = /\bstatic\b/.test(match[0]);
      continue;
    }
    const objectPrefix = code.slice(0, match.index).match(
      /\b(?:const|let|var)\s+([A-Za-z_$]\w*)[^=;\n]*=\s*\{[\s\S]*$/,
    );
    if (objectPrefix) {
      add(
        `${objectPrefix[1]}.${match[1]}`,
        opening,
        sourceParameters(match, match[2]),
        "object-method",
        objectPrefix[1],
        match.index,
      );
    }
  }
  return callables;
}

function ownerAt(callables, position) {
  let selected = null;
  for (const callable of callables) {
    if (
      callable.bodyStart <= position &&
      position < callable.bodyEnd &&
      (!selected || callable.bodyStart >= selected.bodyStart)
    ) {
      selected = callable;
    }
  }
  return selected;
}

function extractCalls(source, callables) {
  const code = maskSource(source);
  const calls = [];
  const pattern =
    /\b([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)*)\s*\(/g;
  const ignored = new Set([
    "catch", "for", "if", "new", "switch", "while",
    "console.log", "console.info", "console.error", "console.warn",
  ]);
  for (const match of code.matchAll(pattern)) {
    const name = match[1].replace(/\s+/g, "");
    if (ignored.has(name) || /\b(?:function|class)\s+$/.test(
      code.slice(Math.max(0, match.index - 20), match.index),
    )) {
      continue;
    }
    const opening = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(source, opening);
    const statementPrefix = code.slice(
      Math.max(
        0,
        Math.max(
          code.lastIndexOf(";", match.index - 1),
          code.lastIndexOf("{", match.index - 1),
          code.lastIndexOf("}", match.index - 1),
        ) + 1,
      ),
      match.index,
    );
    calls.push({
      arguments: splitTopLevel(argumentsText),
      awaited: /\bawait\s+(?:\(*\s*)*$/.test(statementPrefix),
      end: opening + argumentsText.length + 2,
      index: match.index,
      name,
      owner: ownerAt(callables, match.index),
      inlineClass: statementPrefix.match(
        /\bnew\s+([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)?)\s*\([^;{}]*\)\s*\.\s*$/,
      )?.[1] ?? null,
      returned: /\breturn\s+(?:await\s+)?(?:\(*\s*)*$/.test(statementPrefix),
    });
  }
  return calls;
}

function buildReachability(
  source,
  callables,
  calls,
  controlFlow,
  bindings,
  prepared,
) {
  const plainCallables = callables.filter((callable) =>
    callable.kind === "function"
  );
  const methodCallables = callables.filter((callable) =>
    ["class-method", "object-method"].includes(callable.kind)
  );
  const roots = callables.filter((callable) =>
    callable.kind === "module-root"
  );
  const ancestry = (owner) => {
    const result = [];
    for (let current = owner; current; current = current.lexicalOwner) {
      result.push(current);
    }
    return result;
  };
  const localCallable = (module, name, owner) => {
    const owners = new Map(
      ancestry(owner).map((candidate, index) => [candidate, index])
    );
    const candidates = plainCallables.filter((callable) =>
      callable.module === module &&
      callable.name === name &&
      owners.has(callable.lexicalOwner)
    );
    if (candidates.length === 0) return null;
    const nearest = Math.min(
      ...candidates.map((candidate) => owners.get(candidate.lexicalOwner))
    );
    const matches = candidates.filter((candidate) =>
      owners.get(candidate.lexicalOwner) === nearest
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const localClass = (module, name) => {
    const escaped = escapeRegExp(name);
    const code = maskSource(module.source);
    const matches = [...code.matchAll(
      new RegExp(
        `\\bclass\\s+${escaped}\\b(?:\\s+extends\\s+` +
          `([A-Za-z_$]\\w*(?:\\.[A-Za-z_$]\\w*)?))?`,
        "g",
      )
    )];
    if (matches.length !== 1) return null;
    const opening = code.indexOf("{", matches[0].index + matches[0][0].length);
    const closing = opening === -1
      ? -1
      : matchingClosing(code, opening, "{", "}");
    if (opening === -1 || closing === -1) return null;
    return {
      id: `${module.path}#<top-level>/class:${name}` +
        `@${matches[0].index}:${closing + 1}`,
      kind: "class",
      module,
      name,
      base: matches[0][1] ?? null,
      position: module.start + matches[0].index,
    };
  };
  const unique = (values) => {
    const byId = new Map(values.filter(Boolean).map((value) => [value.id, value]));
    return byId.size === 1 ? [...byId.values()][0] : null;
  };
  const exportedSymbol = (module, name, seen = new Set()) => {
    if (!module) return null;
    const key = `${module.path}:${name}`;
    if (seen.has(key)) return null;
    const nextSeen = new Set(seen).add(key);
    const entries = module.exports.get(name) ?? [];
    const symbols = [];
    for (const entry of entries) {
      if (entry.kind === "local") {
        symbols.push(
          localCallable(module, entry.local, roots.find((root) =>
            root.module === module
          )) ?? localClass(module, entry.local)
        );
      } else if (entry.target) {
        symbols.push(exportedSymbol(entry.target, entry.imported, nextSeen));
      }
    }
    if (name !== "default") {
      for (const target of module.exportStars) {
        symbols.push(exportedSymbol(target, name, nextSeen));
      }
    }
    return unique(symbols);
  };
  const importedSymbol = (binding, member = null) => {
    const imported = binding?.imported;
    if (binding?.kind !== "import" || !imported?.target) return null;
    if (imported.kind === "namespace") {
      return member ? exportedSymbol(imported.target, member) : null;
    }
    if (member) return null;
    return exportedSymbol(imported.target, imported.imported);
  };
  const symbolAt = (name, position, owner, member = null) => {
    const binding = bindings.resolve(name, position);
    if (binding?.kind === "import") return importedSymbol(binding, member);
    if (binding?.kind === "local") {
      const latest = bindings.latest(binding, position);
      if (!latest?.expression?.includes("=>")) return null;
    }
    if (member) return null;
    return localCallable(owner?.module, name, owner);
  };
  const classAt = (reference, position, owner) => {
    const parts = reference.split(".");
    if (parts.length === 2) {
      const imported = importedSymbol(bindings.resolve(parts[0], position), parts[1]);
      return imported?.name && imported.module
        ? localClass(imported.module, imported.name)
        : null;
    }
    const imported = importedSymbol(bindings.resolve(reference, position));
    if (imported?.name && imported.module) {
      return localClass(imported.module, imported.name);
    }
    return localClass(owner?.module, reference);
  };
  const methodFor = (
    classSymbol,
    method,
    staticCall,
    seen = new Set(),
  ) => {
    if (!classSymbol || seen.has(classSymbol.id)) return null;
    const own = methodCallables.filter((callable) =>
      callable.kind === "class-method" &&
      callable.module === classSymbol?.module &&
      callable.owner === classSymbol?.name &&
      callable.name === `${classSymbol.name}.${method}` &&
      callable.static === staticCall
    );
    if (own.length !== 0) return unique(own);
    if (!classSymbol.base) return null;
    const base = classAt(
      classSymbol.base,
      classSymbol.position,
      { module: classSymbol.module },
    );
    return methodFor(base, method, staticCall, new Set(seen).add(classSymbol.id));
  };
  const receiverClass = (name, position, owner, seen = new Set()) => {
    const binding = bindings.resolve(name, position);
    if (
      binding?.kind !== "local" ||
      binding.declarationKind !== "const" ||
      binding.history.length !== 1 ||
      seen.has(binding.id)
    ) {
      return null;
    }
    const latest = bindings.latest(binding, position);
    const expression = latest?.expression?.trim() ?? "";
    const instance = expression.match(
      /^new\s+([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)?)\s*\(/
    );
    if (instance) {
      return classAt(instance[1], latest.expressionStart, owner);
    }
    const alias = expression.match(/^([A-Za-z_$]\w*)$/);
    return alias
      ? receiverClass(
          alias[1],
          latest.expressionStart,
          owner,
          new Set(seen).add(binding.id),
        )
      : null;
  };
  function targetFor(call) {
    const parts = call.name.split(".");
    if (parts.length === 1) {
      if (call.inlineClass) {
        return methodFor(
          classAt(call.inlineClass, call.index, call.owner),
          call.name,
          false,
        );
      }
      return symbolAt(call.name, call.index, call.owner);
    }
    if (parts[0] === "this" && call.owner?.kind === "class-method") {
      return methodFor(
        localClass(call.owner.module, call.owner.owner),
        parts.at(-1),
        call.owner.static,
      );
    }
    if (parts.length === 2) {
      const [receiver, method] = parts;
      const namespaceTarget = symbolAt(
        receiver,
        call.index,
        call.owner,
        method,
      );
      if (namespaceTarget && namespaceTarget.kind !== "class") {
        return namespaceTarget;
      }
      const instanceClass = receiverClass(
        receiver,
        call.index,
        call.owner,
      );
      if (instanceClass) return methodFor(instanceClass, method, false);
      const object = unique(methodCallables.filter((callable) =>
        callable.kind === "object-method" &&
        callable.module === call.owner?.module &&
        callable.owner === receiver &&
        callable.name === `${receiver}.${method}`
      ));
      if (object) return object;
      return methodFor(
        classAt(receiver, call.index, call.owner),
        method,
        true,
      );
    }
    if (parts.length === 3) {
      const importedClass = importedSymbol(
        bindings.resolve(parts[0], call.index),
        parts[1],
      );
      if (importedClass?.kind === "class") {
        return methodFor(importedClass, parts[2], true);
      }
    }
    return null;
  }

  for (const call of calls) call.target = targetFor(call);
  const reachable = new Set();
  const incoming = new Map();
  const trace = [];
  const rootTraces = new Map();
  function visit(owner, root, inheritedAwait = false, stack = new Set()) {
    if (stack.has(owner.id)) return;
    reachable.add(owner);
    const nextStack = new Set(stack).add(owner.id);
    const ownerCalls = calls
      .filter((call) =>
        call.owner === owner && controlFlow.context(call.index).reachable
      )
      .sort((left, right) => left.index - right.index);
    for (const call of ownerCalls) {
      const target = call.target;
      const effectiveAwait = call.awaited ||
        (inheritedAwait && call.returned);
      const entry = { ...call, effectiveAwait, root, target };
      trace.push(entry);
      const entries = rootTraces.get(root) ?? [];
      entries.push(entry);
      rootTraces.set(root, entries);
      if (target) {
        const targetIncoming = incoming.get(target) ?? [];
        targetIncoming.push(entry);
        incoming.set(target, targetIncoming);
        visit(target, root, effectiveAwait, nextStack);
      }
    }
  }
  for (const root of roots.sort((left, right) =>
    left.module.path.localeCompare(right.module.path)
  )) {
    visit(root, root);
  }
  return { incoming, reachable, rootTraces, roots, trace };
}

function normalizeModulePath(path) {
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

function prepareWorkspace(workspace) {
  const documents = sourceDocuments(workspace).toSorted((left, right) =>
    left.path.localeCompare(right.path) ||
    left.source.localeCompare(right.source)
  );
  if (documents.length === 0) {
    return { imports: [], modules: [], source: "" };
  }
  const chunks = [];
  const modules = [];
  let position = 0;
  for (const document of documents) {
    const prefix = "{\n";
    const suffix = "\n}\n";
    chunks.push(prefix, document.source, suffix);
    const start = position + prefix.length;
    modules.push({
      end: start + document.source.length,
      exports: new Map(),
      exportStars: [],
      imports: new Map(),
      path: normalizeModulePath(document.path),
      source: document.source,
      start,
    });
    position += prefix.length + document.source.length + suffix.length;
  }
  const source = chunks.join("");
  const allImports = [];
  const moduleAt = (index) => modules.find(
    (module) => module.start <= index && index <= module.end
  ) ?? null;
  for (const module of modules) {
    const code = maskSource(module.source, false);
    const masked = maskSource(module.source);
    const importPattern =
      /\bimport\s+(type\s+)?([\s\S]*?)\s+from\s*(["'])([^"']+)\3\s*;?/g;
    for (const match of code.matchAll(importPattern)) {
      if (masked[match.index] !== "i" || match[1]) continue;
      const clause = match[2].trim();
      const specifier = match[4];
      const index = module.start + match.index;
      const add = (local, imported, kind) => {
        const entry = {
          imported,
          index,
          kind,
          local,
          module,
          specifier,
          target: null,
        };
        module.imports.set(local, entry);
        allImports.push(entry);
      };
      const namespace = /^\*\s+as\s+([A-Za-z_$]\w*)$/.exec(clause);
      if (namespace) {
        add(namespace[1], "*", "namespace");
        continue;
      }
      const namedOpening = clause.indexOf("{");
      if (namedOpening !== -1) {
        const namedClosing = clause.lastIndexOf("}");
        const before = clause.slice(0, namedOpening).replace(/,\s*$/, "").trim();
        if (before) add(before, "default", "default");
        for (const item of clause.slice(namedOpening + 1, namedClosing).split(",")) {
          const parsed = item.trim().match(
            /^([A-Za-z_$]\w*)(?:\s+as\s+([A-Za-z_$]\w*))?$/
          );
          if (parsed) add(parsed[2] ?? parsed[1], parsed[1], "named");
        }
        continue;
      }
      if (/^[A-Za-z_$]\w*$/.test(clause)) {
        add(clause, "default", "default");
      }
    }

    const addExport = (exported, entry) => {
      const entries = module.exports.get(exported) ?? [];
      entries.push(entry);
      module.exports.set(exported, entries);
    };
    for (const match of code.matchAll(
      /\bexport\s+(default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$]\w*)/g
    )) {
      addExport(match[1] ? "default" : match[2], {
        kind: "local",
        local: match[2],
      });
    }
    for (const match of code.matchAll(
      /\bexport\s+(?:const|let|var)\s+([A-Za-z_$]\w*)/g
    )) {
      addExport(match[1], { kind: "local", local: match[1] });
    }
    const exportList =
      /\bexport\s*\{([^}]+)\}(?:\s*from\s*(["'])([^"']+)\2)?\s*;?/g;
    for (const match of code.matchAll(exportList)) {
      for (const item of match[1].split(",")) {
        const parsed = item.trim().match(
          /^([A-Za-z_$]\w*)(?:\s+as\s+([A-Za-z_$]\w*))?$/
        );
        if (!parsed) continue;
        addExport(parsed[2] ?? parsed[1], match[3]
          ? { imported: parsed[1], kind: "reexport", specifier: match[3] }
          : { kind: "local", local: parsed[1] });
      }
    }
    for (const match of code.matchAll(
      /\bexport\s*\*\s*from\s*(["'])([^"']+)\1\s*;?/g
    )) {
      module.exportStars.push(match[2]);
    }
  }

  const byPath = new Map();
  for (const module of modules) {
    const entries = byPath.get(module.path) ?? [];
    entries.push(module);
    byPath.set(module.path, entries);
  }
  const resolveRelative = (from, specifier) => {
    if (!specifier.startsWith(".")) return null;
    const base = normalizeModulePath(
      `${moduleDirectory(from.path)}/${specifier}`
    );
    const mappings = [
      [".mjs", [".mts"]],
      [".cjs", [".cts"]],
      [".jsx", [".tsx"]],
      [".js", [".ts", ".tsx"]],
    ];
    const mapping = mappings.find(([runtime]) => base.endsWith(runtime));
    if (!mapping) return null;
    const stem = base.slice(0, -mapping[0].length);
    const matches = mapping[1].flatMap((extension) =>
      byPath.get(`${stem}${extension}`) ?? []
    );
    return matches.length === 1 ? matches[0] : null;
  };
  for (const imported of allImports) {
    imported.target = resolveRelative(imported.module, imported.specifier);
  }
  for (const module of modules) {
    for (const entries of module.exports.values()) {
      for (const entry of entries) {
        if (entry.kind === "reexport") {
          entry.target = resolveRelative(module, entry.specifier);
        }
      }
    }
    module.exportStars = module.exportStars.map((specifier) =>
      resolveRelative(module, specifier)
    ).filter(Boolean);
  }
  return { imports: allImports, moduleAt, modules, source };
}

function createAnalysis(workspace) {
  const prepared = workspace.prepared ?? prepareWorkspace(workspace);
  const source = prepared.source;
  const identity = importsFrom(source, "@azure/identity");
  const resources = importsFrom(source, "@azure/arm-storage");
  const rest = importsFrom(source, "@azure/core-rest-pipeline");
  const scopeIndex = buildScopes(source);
  const bindings = buildBindings(source, scopeIndex, prepared.imports);
  const callables = extractCallables(source);
  for (const module of prepared.modules) {
    callables.push({
      bodyEnd: module.end,
      bodyStart: module.start,
      declarationStart: module.start,
      id: `${module.path}#<top-level>`,
      kind: "module-root",
      module,
      name: `<top-level:${module.path}>`,
      owner: module.path,
      parameterDefaults: [],
      parameters: [],
    });
  }
  callables.sort((left, right) =>
    left.bodyStart - right.bodyStart || right.bodyEnd - left.bodyEnd
  );
  for (const callable of callables) {
    callable.module ??= prepared.moduleAt(callable.bodyStart);
    if (callable.kind === "module-root") continue;
    callable.lexicalOwner = ownerAt(
      callables.filter((candidate) => candidate !== callable),
      callable.bodyStart - 1,
    );
    callable.id = `${callable.module?.path ?? "<workspace>"}#` +
      `${callable.lexicalOwner?.id ?? "<top-level>"}/${callable.name}` +
      `@${callable.declarationStart - callable.module.start}:` +
      `${callable.bodyEnd - callable.module.start}`;
  }
  const calls = extractCalls(source, callables);
  const controlFlow = buildControlFlow(source, callables, bindings);
  const reachability = buildReachability(
    source,
    callables,
    calls,
    controlFlow,
    bindings,
    prepared,
  );
  const credentialTypes = importTypeNames(
    source,
    "@azure/identity",
    "DefaultAzureCredential",
  );
  const clientTypes = importTypeNames(
    source,
    "@azure/arm-storage",
    "StorageManagementClient",
  );
  const restErrorTypes = importTypeNames(
    source,
    "@azure/core-rest-pipeline",
    "RestError",
  );
  const cache = new Map();

  function importedTypeAt(typeName, position, names) {
    const normalized = typeName.replace(/\s+/g, "");
    if (!names.has(normalized)) return false;
    const [root, member] = normalized.split(".");
    const binding = bindings.resolve(root, position);
    if (binding?.kind !== "import") return false;
    const imported = binding.imported;
    const expectedModule = names === credentialTypes
      ? "@azure/identity"
      : names === clientTypes
        ? "@azure/arm-storage"
        : "@azure/core-rest-pipeline";
    const expectedExport = names === credentialTypes
      ? "DefaultAzureCredential"
      : names === clientTypes
        ? "StorageManagementClient"
        : "RestError";
    return imported?.specifier === expectedModule &&
      (
        imported.kind === "namespace"
          ? member === expectedExport
          : imported.imported === expectedExport
      );
  }

  function unwrap(expression) {
    let value = expression.trim();
    value = value.replace(/^\s*await\s+/, "").trim();
    value = value.replace(/\s+as\s+(?:const|[\w$.<>, [\]|]+)\s*$/s, "").trim();
    value = value.replace(/!\s*$/, "").trim();
    while (value.startsWith("(") && value.endsWith(")")) {
      const body = balancedText(value, 0);
      if (body.length + 2 !== value.length) break;
      value = body.trim();
    }
    return value;
  }

  function incomingArgument(owner, name, seen) {
    const parameterIndex = owner?.parameters.indexOf(name) ?? -1;
    if (parameterIndex === -1) return null;
    for (const incoming of reachability.incoming.get(owner) ?? []) {
      const argument =
        incoming.arguments[parameterIndex] ??
        owner.parameterDefaults?.[parameterIndex];
      if (!argument) continue;
      const value = resolveExpression(
        argument,
        incoming.index,
        incoming.owner,
        seen,
      );
      if (value) return value;
    }
    const fallback = owner?.parameterDefaults?.[parameterIndex];
    if (fallback) {
      return resolveExpression(
        fallback,
        owner.bodyStart,
        owner,
        seen,
      );
    }
    return null;
  }

  function analysisSourceIndex(fragment, position) {
    const found = source.indexOf(fragment, position);
    return found === -1 ? position : found;
  }

  function constructor(expression, position, owner, seen) {
    const match = unwrap(expression).match(
      /^new\s+([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*(?:<[^(){};]+>)?\s*\(/,
    );
    if (!match) return null;
    const opening = expression.indexOf("(", expression.indexOf(match[1]));
    const args = splitTopLevel(balancedText(expression, opening));
    if (importedTypeAt(match[1], position, credentialTypes)) {
      return { id: `credential:${position}:${match.index}`, kind: "credential" };
    }
    if (!importedTypeAt(match[1], position, clientTypes) || args.length < 2) {
      return null;
    }
    const credential = resolveExpression(args[0], position, owner, seen);
    const subscription = resolveExpression(args[1], position, owner, seen);
    return credential?.kind === "credential" &&
        subscription?.kind === "environment"
      ? {
          credentialId: credential.id,
          id: `client:${position}:${match.index}`,
          kind: "client",
          subscription: subscription.name,
        }
      : null;
  }

  function latestMemberExpression(member, position, owner) {
    const escaped = escapeRegExp(member);
    const code = maskSource(source);
    const original = maskSource(source, false);
    const pattern = new RegExp(
      `(?<![\\w$])${escaped}\\s*(?::[^=;\\n]+)?\\s*=(?!=|>)`,
      "g",
    );
    let latest = null;
    for (const match of code.matchAll(pattern)) {
      const matchOwner = ownerAt(callables, match.index);
      const sameObjectContext =
        member.startsWith("this.") &&
        owner?.owner &&
        matchOwner?.module === owner.module &&
        matchOwner?.owner === owner.owner;
      if (
        match.index <= position &&
        (member.startsWith("this.") ? sameObjectContext : true)
      ) {
        const equals = match.index + match[0].lastIndexOf("=");
        latest = {
          expression: original.slice(
            equals + 1,
            expressionEnd(code, equals + 1),
          ),
          position: equals + 1,
        };
      } else if (
        member.startsWith("this.") &&
        owner?.owner &&
        matchOwner?.module === owner.module &&
        matchOwner?.name === `${owner.owner}.constructor`
      ) {
        const equals = match.index + match[0].lastIndexOf("=");
        latest ??= {
          expression: original.slice(
            equals + 1,
            expressionEnd(code, equals + 1),
          ),
          position: equals + 1,
        };
      }
    }
    if (latest) return latest;

    if (member.startsWith("this.") && owner?.owner) {
      const field = member.slice(5);
      const classPattern = new RegExp(
        `\\bclass\\s+${escapeRegExp(owner.owner)}[^\\{]*\\{`,
      );
      const moduleCode = code.slice(owner.module.start, owner.module.end);
      const localClassMatch = classPattern.exec(moduleCode);
      const classMatch = localClassMatch && {
        ...localClassMatch,
        index: owner.module.start + localClassMatch.index,
      };
      if (classMatch) {
        const opening = classMatch.index + classMatch[0].lastIndexOf("{");
        const classBody = source.slice(
          opening + 1,
          opening + 1 + balancedText(source, opening, "{", "}").length,
        );
        const fieldPattern = new RegExp(
          `(?:^|[;}])\\s*(?:public\\s+|private\\s+|protected\\s+|readonly\\s+|static\\s+)*${escapeRegExp(field)}\\s*(?::[^=;]+)?=`,
          "m",
        );
        const fieldMatch = fieldPattern.exec(maskSource(classBody));
        if (fieldMatch) {
          const equals = opening + 1 + fieldMatch.index +
            fieldMatch[0].lastIndexOf("=");
          return {
            expression: source.slice(
              equals + 1,
              expressionEnd(code, equals + 1),
            ),
            position: equals + 1,
          };
        }

      }

      if (owner.kind === "object-method") {
        const objectPattern = new RegExp(
          `\\b(?:const|let|var)\\s+${escapeRegExp(owner.owner)}[^=;\\n]*=\\s*\\{`,
        );
        const localObjectMatch = objectPattern.exec(moduleCode);
        const objectMatch = localObjectMatch && {
          ...localObjectMatch,
          index: owner.module.start + localObjectMatch.index,
        };
        if (objectMatch) {
          const opening =
            objectMatch.index + objectMatch[0].lastIndexOf("{");
          const objectBody = source.slice(
            opening + 1,
            opening + 1 + balancedText(source, opening, "{", "}").length,
          );
          const propertyPattern = new RegExp(
            `(?:^|[,;])\\s*${escapeRegExp(field)}\\s*:\\s*`,
            "m",
          );
          const propertyMatch = propertyPattern.exec(maskSource(objectBody));
          if (propertyMatch) {
            const start = opening + 1 + propertyMatch.index +
              propertyMatch[0].length;
            return {
              expression: source.slice(start, propertyValueEnd(code, start)),
              position: start,
            };
          }
        }
      }
    }
    return null;
  }

  function resolveExpression(
    expression,
    position,
    owner = ownerAt(callables, position),
    seen = new Set(),
  ) {
    if (!expression) return null;
    const text = unwrap(expression);
    const key = `${position}:${owner?.id ?? "top"}:${text}`;
    if (seen.has(key)) return null;
    const nextSeen = new Set(seen).add(key);
    const dotEnvironment = text.match(
      /^process\s*\.\s*env\s*\.\s*([A-Za-z_$]\w*)$/,
    );
    if (dotEnvironment) {
      return { kind: "environment", name: dotEnvironment[1] };
    }
    const bracketEnvironment = text.match(
      /^process\s*\.\s*env\s*\[\s*([\s\S]+)\s*\]$/,
    );
    if (bracketEnvironment) {
      const name = resolveExpression(
        bracketEnvironment[1],
        position,
        owner,
        nextSeen,
      );
      return name?.kind === "string"
        ? { kind: "environment", name: name.value }
        : null;
    }
    const constantString = constantTypeScriptString(
      text,
      position,
      bindings,
      controlFlow.joins,
    );
    if (constantString) return constantString;
    const created = constructor(text, position, owner, nextSeen);
    if (created) return created;

    const operation = text.match(
      /^(?:await\s+)?([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*)\s*\.\s*(beginCreateAndWait|beginCreate|listByResourceGroup|getProperties|setServiceProperties|delete|listKeys|pollUntilDone)\s*\(/,
    );
    if (operation) {
      const opening = text.indexOf("(", operation.index);
      const args = splitTopLevel(balancedText(text, opening));
      const receiver = resolveExpression(
        operation[1],
        position,
        owner,
        nextSeen,
      );
      const name = resolveExpression(args[0], position, owner, nextSeen);
      if (
        ["storage-accounts", "blob-services", "poller"].includes(
          receiver?.kind,
        ) &&
        (
          ["listByResourceGroup", "pollUntilDone"].includes(operation[2]) ||
          name
        )
      ) {
        const origin = analysisSourceIndex(operation[0], position);
        return {
          clientId: receiver.clientId,
          kind: operation[2] === "beginCreate"
            ? "poller"
            : operation[2] === "listByResourceGroup"
              ? "resource-list"
              : "resource",
          name,
          origin,
        };
      }
    }

    const inlineResourceField = text.match(
      /^\(\s*await\s+([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*)\s*\.\s*(beginCreateAndWait|getProperties|setServiceProperties)\s*\(([\s\S]*)\)\s*\)\s*\.\s*([A-Za-z_$]\w*)$/,
    );
    if (inlineResourceField) {
      const receiver = resolveExpression(
        inlineResourceField[1],
        position,
        owner,
        nextSeen,
      );
      if (["storage-accounts", "blob-services"].includes(receiver?.kind)) {
        return {
          clientId: receiver.clientId,
          field: inlineResourceField[4],
          kind: "resource-field",
          origin: analysisSourceIndex(
            inlineResourceField[1],
            position,
          ),
        };
      }
    }

    const helperCall = text.match(
      /^([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*)\s*\(/,
    );
    if (helperCall) {
      const callIndex = analysisSourceIndex(helperCall[1], position);
      const invocation = reachability.trace.find((call) =>
        call.index === callIndex && call.target
      );
      if (invocation?.target) {
        const targetSource = source.slice(
          invocation.target.bodyStart,
          invocation.target.bodyEnd,
        );
        const targetCode = maskSource(
          targetSource,
        );
        const helperArguments = splitTopLevel(
          balancedText(text, text.indexOf("(")),
        );
        const returnMatch = /\breturn\s+([^;]+);/.exec(targetCode);
        const returnedExpression = returnMatch?.[1]?.trim() ?? "";
        for (
          let parameterIndex = 0;
          parameterIndex < invocation.target.parameters.length;
          parameterIndex += 1
        ) {
          const parameter = invocation.target.parameters[parameterIndex];
          const environmentAccess =
            `process\\s*\\.\\s*env\\s*\\[\\s*${escapeRegExp(parameter)}\\s*\\]`;
          const directReturn = new RegExp(
            `^${environmentAccess}(?:\\s*!|\\s+as\\s+string)?$`,
          ).test(returnedExpression);
          const returnedVariable = /^[A-Za-z_$]\w*$/.test(returnedExpression)
            ? returnedExpression
            : null;
          const safeAssignment = returnedVariable &&
            new RegExp(
              `\\b(?:const|let|var)\\s+${escapeRegExp(returnedVariable)}` +
                `(?:\\s*:[^=;\\n]+)?\\s*=\\s*${environmentAccess}` +
                `(?:\\s*!|\\s+as\\s+string)?\\s*;`,
            ).test(targetCode);
          if (!directReturn && !safeAssignment) continue;
          const environmentName = resolveExpression(
            helperArguments[parameterIndex] ??
              invocation.target.parameterDefaults[parameterIndex],
            callIndex,
            invocation.owner,
            nextSeen,
          );
          if (environmentName?.kind === "string") {
            return {
              kind: "environment",
              name: environmentName.value,
            };
          }
        }
        const returned = /\breturn\s+(?:await\s+)?/.exec(targetCode);
        if (returned) {
          const expressionStart =
            invocation.target.bodyStart + returned.index + returned[0].length;
          const result = resolveExpression(
            source.slice(
              expressionStart,
              expressionEnd(maskSource(source), expressionStart),
            ),
            expressionStart,
            invocation.target,
            nextSeen,
          );
          return result
            ? { ...result, invocationOrigin: callIndex }
            : null;
        }
      }
    }

    const member = text.match(
      /^((?:this|[A-Za-z_$]\w*)(?:\.[A-Za-z_$]\w*)+)$/,
    )?.[1];
    if (member) {
      const memberExpression = latestMemberExpression(member, position, owner);
      if (memberExpression) {
        return resolveExpression(
          memberExpression.expression,
          memberExpression.position,
          owner,
          nextSeen,
        );
      }
      const parts = member.split(".");
      const property = parts.pop();
      const base = parts.join(".");
      const baseValue = resolveExpression(base, position, owner, nextSeen);
      if (baseValue?.kind === "client" && property === "storageAccounts") {
        return {
          clientId: baseValue.id,
          kind: "storage-accounts",
          subscription: baseValue.subscription,
        };
      }
      if (baseValue?.kind === "client" && property === "blobServices") {
        return {
          clientId: baseValue.id,
          kind: "blob-services",
          subscription: baseValue.subscription,
        };
      }
      if (baseValue?.kind === "resource") {
        return { ...baseValue, field: property, kind: "resource-field" };
      }
      return null;
    }

    if (/^[A-Za-z_$]\w*$/.test(text)) {
      const parameter = incomingArgument(owner, text, nextSeen);
      if (parameter) return parameter;
      const binding = bindings.resolve(text, position);
      const latest = bindings.latest(binding, position);
      if (latest?.expression) {
        return resolveExpression(
          latest.expression,
          latest.expressionStart ?? latest.index,
          ownerAt(callables, latest.expressionStart ?? latest.index),
          nextSeen,
        );
      }
    }
    return null;
  }

  function isReachable(position) {
    const owner = ownerAt(callables, position);
    return controlFlow.context(position).reachable &&
      (owner === null || reachability.reachable.has(owner));
  }

  function isAwaited(call) {
    if (call.awaited) return true;
    if (!call.returned || !call.owner) return false;
    return (reachability.incoming.get(call.owner) ?? []).some(
      (incoming) => incoming.effectiveAwait,
    );
  }

  const targetMethods = new Set([
    "beginCreateAndWait",
    "beginCreate",
    "listByResourceGroup",
    "getProperties",
    "setServiceProperties",
    "delete",
    "listKeys",
    "pollUntilDone",
  ]);
  let operations = calls.filter((call) =>
    targetMethods.has(call.name.split(".").at(-1)) &&
    isReachable(call.index)
  ).map((call) => {
    const parts = call.name.split(".");
    const method = parts.pop();
    const receiverText = parts.join(".");
    return {
      ...call,
      awaited: isAwaited(call),
      method,
      path: controlFlow.context(call.index),
      receiver: resolveExpression(
        receiverText,
        call.index,
        call.owner,
      ),
      resolvedArguments: call.arguments.map((argument) =>
        resolveExpression(argument, call.index, call.owner)
      ),
    };
  });

  function invocationPath(path, owner, invocation) {
    if (!path || !owner || !invocation) return path;
    const parameterJoins = owner.parameters.map((parameter, index) => ({
      name: parameter,
      position: 0,
      value: triStateTypeScriptBoolean(
        invocation.arguments[index] ??
          owner.parameterDefaults?.[index] ??
          "",
        invocation.index,
        bindings,
      ),
    }));
    const constraints = new Map();
    for (const [key, choice] of path.constraints) {
      const expression = controlFlow.condition(key);
      const value = expression === null
        ? null
        : triStateTypeScriptBoolean(
            expression,
            Number.MAX_SAFE_INTEGER,
            bindings,
            parameterJoins,
          );
      if (value !== null) {
        if (value !== choice) return null;
        continue;
      }
      constraints.set(`${invocation.index}:${key}`, choice);
    }
    return { constraints, reachable: path.reachable };
  }

  operations = operations.flatMap((operation) => {
    const incoming = operation.owner
      ? reachability.incoming.get(operation.owner) ?? []
      : [];
    if (incoming.length === 0) {
      return [{
        ...operation,
        argumentExpressions: operation.arguments,
        invocationIndex: null,
        traceRoot: operation.owner?.kind === "module-root"
          ? operation.owner
          : null,
      }];
    }
    return incoming.map((invocation) => {
      const parameterValue = (expression) => {
        const parameterIndex = operation.owner.parameters.indexOf(
          expression.trim(),
        );
        if (parameterIndex === -1) {
          return resolveExpression(
            expression,
            operation.index,
            operation.owner,
          );
        }
        const argument =
          invocation.arguments[parameterIndex] ??
          operation.owner.parameterDefaults?.[parameterIndex];
        return resolveExpression(
          argument,
          invocation.index,
          invocation.owner,
        );
      };
      const receiverText = operation.name.split(".").slice(0, -1).join(".");
      const operationPath = invocationPath(
        operation.path,
        operation.owner,
        invocation,
      );
      if (!operationPath) return null;
      return {
        ...operation,
        argumentExpressions: operation.arguments.map((argument) => {
          const parameterIndex = operation.owner.parameters.indexOf(
            argument.trim(),
          );
          return parameterIndex === -1
            ? argument
            : invocation.arguments[parameterIndex] ??
              operation.owner.parameterDefaults?.[parameterIndex] ??
              argument;
        }),
        awaited: operation.awaited ||
          (operation.returned && invocation.effectiveAwait),
        invocationIndex: invocation.index,
        traceRoot: invocation.root,
        path: mergePathContexts(
          operationPath,
          controlFlow.context(invocation.index),
        ),
        receiver: parameterValue(receiverText),
        resolvedArguments: operation.arguments.map(parameterValue),
      };
    }).filter((operation) => operation?.path);
  });

  const operationOrder = new Map();
  function appendOwner(
    owner,
    root,
    nextOrder,
    inheritedAwait = false,
    stack = new Set(),
    invocationIndex = null,
  ) {
    const key = owner.id;
    if (stack.has(key)) return;
    const nextStack = new Set(stack).add(key);
    const events = [
      ...operations.filter((operation) =>
        operation.owner === owner &&
        operation.traceRoot === root &&
        operation.invocationIndex === invocationIndex
      )
        .map((operation) => ({ kind: "operation", operation })),
      ...calls.filter((call) => call.owner === owner)
        .map((call) => ({ call, kind: "call" })),
    ].sort((left, right) =>
      (left.operation?.index ?? left.call.index) -
      (right.operation?.index ?? right.call.index)
    );
    for (const event of events) {
      if (event.kind === "operation") {
        operationOrder.set(event.operation, nextOrder.value++);
        continue;
      }
      const traceCall = reachability.trace.find((entry) =>
        entry.root === root &&
        entry.index === event.call.index &&
        entry.owner === event.call.owner
      );
      const target = traceCall?.target;
      if (target) {
        appendOwner(
          target,
          root,
          nextOrder,
          event.call.awaited || (inheritedAwait && event.call.returned),
          nextStack,
          event.call.index,
        );
      }
    }
  }
  for (const root of reachability.roots) {
    appendOwner(root, root, { value: 0 });
  }

  return {
    bindings,
    callables,
    clientTypes,
    controlFlow,
    credentialTypes,
    imports: { identity, resources, rest },
    isReachable,
    operationOrder,
    operations,
    reachability,
    resolveExpression,
    restErrorTypes,
    scopeIndex,
    source,
  };
}

function operationMatches(operation, method, clientId, name, value = null) {
  return (
    operation.method === method &&
    operation.awaited &&
    operation.receiver?.kind === "client" &&
    (clientId === null || operation.receiver.id === clientId) &&
    operation.resolvedArguments[0]?.kind === "string" &&
    operation.resolvedArguments[0].value === name &&
    (
      value === null ||
      (
        operation.resolvedArguments[1]?.kind === "string" &&
        operation.resolvedArguments[1].value === value
      )
    )
  );
}

function lifecycle(analysis) {
  const ordered = [...analysis.operations]
    .filter((operation) => analysis.operationOrder.has(operation))
    .sort(
      (left, right) =>
        analysis.operationOrder.get(left) - analysis.operationOrder.get(right),
    );
  const orderOf = (operation) => analysis.operationOrder.get(operation);
  const later = (left, right) => orderOf(left) > orderOf(right);
  const best = { ordered, stage: 0 };

  function remember(state, stage) {
    if (stage > best.stage) Object.assign(best, state, { stage });
  }

  function completionWait(deletion, operation) {
    const pollerInvocation =
      operation.receiver?.invocationOrigin ??
      operation.invocationIndex ??
      null;
    if (
      !operation.awaited ||
      operation.receiver?.kind !== "poller" ||
      operation.receiver.clientId !== deletion.receiver.id ||
      operation.receiver.name !== "my-secret" ||
      operation.receiver.origin !== deletion.index ||
      pollerInvocation !== (deletion.invocationIndex ?? null)
    ) {
      return null;
    }
    if (operation.method === "pollUntilDone") {
      return { genuinePolling: true, loop: null };
    }
    if (operation.method !== "poll") return null;
    const loop = analysis.controlFlow.loopAt(operation.index);
    if (!loop) return null;
    const status = analysis.operations.find((candidate) =>
      candidate.method === "isDone" &&
      loop.conditionStart <= candidate.index &&
      candidate.index < loop.conditionEnd &&
      candidate.receiver?.kind === "poller" &&
      candidate.receiver.origin === deletion.index &&
      (
        candidate.receiver.invocationOrigin ??
        candidate.invocationIndex ??
        null
      ) === (deletion.invocationIndex ?? null)
    );
    if (!status) return null;
    const compact = loop.condition.replace(/\s+/g, "");
    const call = status.name.replace(/\s+/g, "");
    const provesIncomplete =
      compact.includes(`!${call}(`) ||
      compact.includes(`${call}()===false`) ||
      compact.includes(`${call}()==false`);
    const body = maskSource(
      analysis.source.slice(loop.bodyStart, loop.bodyEnd),
    );
    if (!provesIncomplete || /\bbreak\b/.test(body)) return null;
    return { genuinePolling: true, loop };
  }

  for (const create of ordered.filter((operation) =>
    operationMatches(
      operation,
      "setSecret",
      null,
      "my-secret",
      "my-secret-value",
    )
  )) {
    const clientId = create.receiver.id;
    const createPath = mergePathContexts(create.path);
    if (!createPath) continue;
    remember({ clientId, create, path: createPath }, 1);
    for (const read of ordered.filter((operation) =>
      later(operation, create) &&
      operationMatches(operation, "getSecret", clientId, "my-secret")
    )) {
      const readPath = mergePathContexts(createPath, read.path);
      if (!readPath) continue;
      remember({ clientId, create, path: readPath, read }, 2);
      for (const update of ordered.filter((operation) =>
        later(operation, read) &&
        operationMatches(
          operation,
          "setSecret",
          clientId,
          "my-secret",
          "updated-value",
        )
      )) {
        const updatePath = mergePathContexts(readPath, update.path);
        if (!updatePath) continue;
        remember({ clientId, create, path: updatePath, read, update }, 3);
        for (const deletion of ordered.filter((operation) =>
          later(operation, update) &&
          operationMatches(
            operation,
            "beginDeleteSecret",
            clientId,
            "my-secret",
          )
        )) {
          const deletionPath = mergePathContexts(updatePath, deletion.path);
          if (!deletionPath) continue;
          const priorDeletion = ordered.some((operation) =>
            later(operation, update) &&
            later(deletion, operation) &&
            operation.method === "beginDeleteSecret" &&
            operation.receiver?.id === clientId &&
            operation.resolvedArguments[0]?.value === "my-secret" &&
            mergePathContexts(deletionPath, operation.path)
          );
          if (priorDeletion) continue;
          const interveningSet = ordered.some((operation) =>
            later(operation, update) &&
            later(deletion, operation) &&
            operation.method === "setSecret" &&
            operation.receiver?.id === clientId &&
            operation.resolvedArguments[0]?.value === "my-secret" &&
            mergePathContexts(deletionPath, operation.path)
          );
          if (interveningSet) continue;
          remember({
            clientId,
            create,
            deletion,
            path: deletionPath,
            read,
            update,
          }, 4);
          for (const wait of ordered.filter((operation) =>
            later(operation, deletion) &&
            ["pollUntilDone", "poll"].includes(operation.method)
          )) {
            const waitPath = mergePathContexts(deletionPath, wait.path);
            const completion = waitPath && completionWait(deletion, wait);
            if (!completion) continue;
            const separateDeletion = ordered.some((operation) =>
              later(operation, deletion) &&
              later(wait, operation) &&
              operation.method === "beginDeleteSecret" &&
              operation.receiver?.id === clientId &&
              operation.resolvedArguments[0]?.value === "my-secret" &&
              mergePathContexts(waitPath, operation.path)
            );
            if (separateDeletion) continue;
            remember({
              clientId,
              create,
              deletion,
              genuinePolling: true,
              path: waitPath,
              read,
              update,
              wait,
            }, 5);
            for (const purge of ordered.filter((operation) =>
              later(operation, wait) &&
              operationMatches(
                operation,
                "purgeDeletedSecret",
                clientId,
                "my-secret",
              )
            )) {
              if (
                completion.loop &&
                completion.loop.bodyStart <= purge.index &&
                purge.index < completion.loop.bodyEnd
              ) {
                continue;
              }
              const purgePath = mergePathContexts(waitPath, purge.path);
              if (!purgePath) continue;
              return {
                clientId,
                create,
                deletion,
                genuinePolling: true,
                ordered,
                path: purgePath,
                purge,
                read,
                stage: 6,
                update,
                wait,
              };
            }
          }
        }
      }
    }
  }
  return best;
}

function printsRetrievedValue(analysis, lifecycleState) {
  if (!lifecycleState.read) return false;
  const orderOf = (operation) => analysis.operationOrder.get(operation);
  const eligibleReads = analysis.operations.filter((operation) =>
    analysis.operationOrder.has(operation) &&
    operationMatches(
      operation,
      "getSecret",
      lifecycleState.clientId,
      "my-secret",
    ) &&
    orderOf(operation) > orderOf(lifecycleState.create) &&
    (
      !lifecycleState.update ||
      orderOf(operation) < orderOf(lifecycleState.update)
    ) &&
    mergePathContexts(lifecycleState.path, operation.path)
  );
  const sameRead = (operation) =>
    eligibleReads.some((candidate) =>
      candidate.index === operation.index &&
      candidate.invocationIndex === operation.invocationIndex
    );
  const validPrintPosition = (position) => {
    if (
      !mergePathContexts(
        lifecycleState.path,
        analysis.controlFlow.context(position),
      )
    ) {
      return false;
    }
    const printOwner = ownerAt(analysis.callables, position);
    return !lifecycleState.update ||
      printOwner !== lifecycleState.update.owner ||
      position < lifecycleState.update.index;
  };
  const calls = analysis.source.matchAll(
    /\bconsole\s*\.\s*(?:log|info)\s*\(/g,
  );
  for (const match of calls) {
    if (
      !analysis.isReachable(match.index) ||
      !validPrintPosition(match.index)
    ) {
      continue;
    }
    const opening = match.index + match[0].lastIndexOf("(");
    const argument = balancedText(analysis.source, opening);
    const expressions = [
      argument,
      ...[...argument.matchAll(/\$\{([^}]+)\}/g)].map((item) => item[1]),
    ];
    for (const expression of expressions) {
      const candidates = [
        expression.trim(),
        ...splitTopLevel(expression),
        ...[...expression.matchAll(
          /\b([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)?)\b/g,
        )].map((item) => item[1]),
      ];
      if (candidates.some((candidate) => {
        const value = analysis.resolveExpression(candidate, match.index);
        return (
          value?.kind === "secret-value" &&
          value.clientId === lifecycleState.clientId &&
          value.name === "my-secret" &&
          eligibleReads.some((read) =>
            value.origin === read.index &&
            (
              value.invocationOrigin === undefined ||
              value.invocationOrigin === read.invocationIndex
            )
          )
        );
      })) {
        return true;
      }
    }
  }

  const code = maskSource(analysis.source);
  const destructuring =
    /\b(?:const|let|var)\s*\{\s*value(?:\s*:\s*([A-Za-z_$]\w*))?\s*\}\s*=\s*await\s+([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*)\s*\.\s*getSecret\s*\(/g;
  for (const match of code.matchAll(destructuring)) {
    if (!analysis.isReachable(match.index)) continue;
    const operation = analysis.operations.find((candidate) =>
      candidate.method === "getSecret" &&
      candidate.index >= match.index &&
      candidate.index < match.index + match[0].length &&
      candidate.receiver?.id === lifecycleState.clientId &&
      candidate.resolvedArguments[0]?.value === "my-secret" &&
      sameRead(candidate)
    );
    if (!operation) continue;
    const name = match[1] ?? "value";
    const outputPattern = new RegExp(
      `\\bconsole\\s*\\.\\s*(?:log|info)\\s*\\([\\s\\S]{0,300}?\\b${escapeRegExp(name)}\\b`,
      "g",
    );
    outputPattern.lastIndex = match.index + match[0].length;
    const output = outputPattern.exec(code);
    if (!output) continue;
    if (!sameRead(operation) || !validPrintPosition(output.index)) continue;
    const overwritePattern = new RegExp(
      `(?<![\\w$.])${escapeRegExp(name)}\\s*=(?!=|>)`,
      "g",
    );
    overwritePattern.lastIndex = match.index + match[0].length;
    const overwrite = overwritePattern.exec(code);
    if (!overwrite || overwrite.index > output.index) return true;
  }
  return false;
}

function environmentName(value) {
  return value?.kind === "environment" && typeof value.name === "string"
    ? value.name
    : null;
}

function sameEnvironmentValue(value, expected) {
  const name = environmentName(value);
  return name !== null && name === environmentName(expected);
}

function validLifecycleEnvironment(operation) {
  const subscription = operation.receiver?.subscription;
  const resourceGroup = operation.resolvedArguments[0];
  const account = operation.resolvedArguments[1];
  const names = [
    subscription,
    environmentName(resourceGroup),
    environmentName(account),
  ];
  return names.every(Boolean) && new Set(names).size === names.length;
}

function storageOperation(
  operation,
  method,
  receiverKind,
  clientId = null,
) {
  return operation.method === method &&
    operation.receiver?.kind === receiverKind &&
    (clientId === null || operation.receiver.clientId === clientId);
}

function objectArgument(analysis, operation, argumentIndex, seen = new Set()) {
  const expression = operation.argumentExpressions?.[argumentIndex]?.trim();
  if (!expression) return null;
  if (expression.startsWith("{") && expression.endsWith("}")) {
    return expression;
  }
  if (!/^[A-Za-z_$]\w*$/.test(expression)) return null;
  const key = `${operation.index}:${expression}`;
  if (seen.has(key)) return null;
  const binding = analysis.bindings.resolve(expression, operation.index);
  const latest = analysis.bindings.latest(binding, operation.index);
  if (!latest?.expression) return null;
  return objectArgument(
    analysis,
    {
      ...operation,
      argumentExpressions: operation.argumentExpressions.with(
        argumentIndex,
        latest.expression,
      ),
      index: latest.expressionStart ?? latest.index,
    },
    argumentIndex,
    new Set(seen).add(key),
  );
}

function objectPropertyExpression(object, name) {
  const escaped = escapeRegExp(name);
  const explicit = new RegExp(
    `(?:^|[{,])\\s*(?:${escaped}|["']${escaped}["'])\\s*:\\s*`,
  ).exec(maskSource(object));
  if (explicit) {
    const start = explicit.index + explicit[0].length;
    return object.slice(start, propertyValueEnd(maskSource(object), start))
      .trim();
  }
  return new RegExp(`(?:^|[{,])\\s*${escaped}\\s*(?=[,}])`)
      .test(maskSource(object))
    ? name
    : null;
}

function resolvedObjectArgument(analysis, operation, argumentIndex) {
  return objectArgument(analysis, operation, argumentIndex);
}

function nestedObject(analysis, operation, expression, argumentIndex) {
  if (!expression) return null;
  if (expression.startsWith("{") && expression.endsWith("}")) {
    return expression;
  }
  return objectArgument(
    analysis,
    {
      ...operation,
      argumentExpressions: operation.argumentExpressions.with(
        argumentIndex,
        expression,
      ),
    },
    argumentIndex,
  );
}

function correctCreateOptions(analysis, operation) {
  const object = resolvedObjectArgument(analysis, operation, 2);
  const expression = object && objectPropertyExpression(object, "location");
  const skuExpression = object && objectPropertyExpression(object, "sku");
  const sku = nestedObject(analysis, operation, skuExpression, 2);
  const skuName = sku && objectPropertyExpression(sku, "name");
  const kind = object && objectPropertyExpression(object, "kind");
  return Boolean(
    expression &&
    analysis.resolveExpression(expression, operation.index)?.value ===
      "eastus" &&
    skuName &&
    analysis.resolveExpression(skuName, operation.index)?.value ===
      "Standard_LRS" &&
    kind &&
    analysis.resolveExpression(kind, operation.index)?.value ===
      "StorageV2" &&
    !objectPropertyExpression(object, "accessTier"),
  );
}

function enablesVersioning(analysis, operation) {
  const object = resolvedObjectArgument(analysis, operation, 2);
  const enabled = object &&
    objectPropertyExpression(object, "isVersioningEnabled");
  return enabled
    ? triStateTypeScriptBoolean(
      enabled,
      operation.index,
      analysis.bindings,
      analysis.controlFlow.joins,
    ) === true
    : false;
}

function operationSequence(analysis) {
  return [...analysis.operations]
    .filter((operation) => analysis.operationOrder.has(operation))
    .sort((left, right) =>
      analysis.operationOrder.get(left) -
      analysis.operationOrder.get(right)
    );
}

function storageLifecycle(analysis) {
  const operations = operationSequence(analysis);
  let best = null;
  for (const root of analysis.reachability.roots) {
    const state = storageLifecycleTrace(
      analysis,
      operations.filter((operation) => operation.traceRoot === root),
    );
    if (state && (!best || state.stage > best.stage)) best = state;
  }
  return best;
}

function storageLifecycleTrace(analysis, operations) {
  const order = (operation) => analysis.operationOrder.get(operation);
  let best = null;
  const remember = (state) => {
    if (!best || state.stage > best.stage) best = state;
  };
  for (const create of operations) {
    if (
      !create.awaited ||
      !["beginCreateAndWait", "beginCreate"].includes(create.method) ||
      !storageOperation(create, create.method, "storage-accounts") ||
      !validLifecycleEnvironment(create) ||
      !correctCreateOptions(analysis, create)
    ) {
      continue;
    }
    const clientId = create.receiver.clientId;
    const createPath = mergePathContexts(create.path);
    if (!createPath) continue;
    const creation = creationCompletion(
      analysis,
      operations,
      create,
      createPath,
    );
    if (!creation) continue;
    const state = {
      clientId,
      create,
      createResult: creation.result,
      creation,
      operations,
      path: creation.path,
      stage: 1,
    };
    const afterCreation = (operation) =>
      order(operation) > order(creation.wait);
    const compatiblePath = (operation) =>
      mergePathContexts(creation.path, operation.path);
    const findOperation = (predicate) => {
      for (const operation of operations) {
        if (!afterCreation(operation) || !predicate(operation)) continue;
        const path = compatiblePath(operation);
        if (path) return { operation, path };
      }
      return null;
    };

    const list = findOperation((operation) =>
      storageOperation(
        operation,
        "listByResourceGroup",
        "storage-accounts",
        clientId,
      ) &&
      sameEnvironmentValue(
        operation.resolvedArguments[0],
        create.resolvedArguments[0],
      )
    );
    if (list) {
      state.list = list.operation;
      state.listPath = list.path;
      state.stage += 1;
    }

    const get = findOperation((operation) =>
      operation.awaited &&
      storageOperation(
        operation,
        "getProperties",
        "storage-accounts",
        clientId,
      ) &&
      sameEnvironmentValue(
        operation.resolvedArguments[0],
        create.resolvedArguments[0],
      ) &&
      sameEnvironmentValue(
        operation.resolvedArguments[1],
        create.resolvedArguments[1],
      )
    );
    if (get) {
      state.get = get.operation;
      state.getPath = get.path;
      state.stage += 1;
    }

    const versioning = findOperation((operation) =>
      operation.awaited &&
      storageOperation(
        operation,
        "setServiceProperties",
        "blob-services",
        clientId,
      ) &&
      sameEnvironmentValue(
        operation.resolvedArguments[0],
        create.resolvedArguments[0],
      ) &&
      sameEnvironmentValue(
        operation.resolvedArguments[1],
        create.resolvedArguments[1],
      ) &&
      enablesVersioning(analysis, operation)
    );
    if (versioning) {
      state.versioning = versioning.operation;
      state.versioningPath = versioning.path;
      state.stage += 1;
    }

    const deletion = findOperation((operation) =>
      operation.awaited &&
      storageOperation(
        operation,
        "delete",
        "storage-accounts",
        clientId,
      ) &&
      sameEnvironmentValue(
        operation.resolvedArguments[0],
        create.resolvedArguments[0],
      ) &&
      sameEnvironmentValue(
        operation.resolvedArguments[1],
        create.resolvedArguments[1],
      )
    );
    if (deletion) {
      state.deletion = deletion.operation;
      state.deletionPath = deletion.path;
      state.stage += 1;
    }
    remember(state);
  }
  return best;
}

function creationCompletion(
  analysis,
  operations,
  create,
  createPath,
) {
  const order = (operation) => analysis.operationOrder.get(operation);
  if (create.method === "beginCreateAndWait") {
    return {
      path: createPath,
      result: create,
      wait: create,
    };
  }
  for (const wait of operations) {
    if (
      order(wait) <= order(create) ||
      wait.method !== "pollUntilDone" ||
      !wait.awaited ||
      wait.receiver?.kind !== "poller" ||
      wait.receiver.clientId !== create.receiver.clientId ||
      wait.receiver.origin !== create.index ||
      (wait.receiver.invocationOrigin ?? wait.invocationIndex ?? null) !==
        (create.invocationIndex ?? null)
    ) {
      continue;
    }
    const path = mergePathContexts(createPath, wait.path);
    if (path) return { path, result: wait, wait };
  }
  return null;
}

function outputCalls(analysis) {
  const calls = [];
  for (const match of maskSource(analysis.source).matchAll(
    /\bconsole\s*\.\s*(?:log|info)\s*\(/g,
  )) {
    if (!analysis.isReachable(match.index)) continue;
    const opening = match.index + match[0].lastIndexOf("(");
    const owner = ownerAt(analysis.callables, match.index);
    const roots = owner?.kind === "module-root"
      ? new Set([owner])
      : new Set(
        analysis.reachability.trace
          .filter((call) => call.target === owner)
          .map((call) => call.root)
      );
    calls.push({
      argument: balancedText(analysis.source, opening),
      index: match.index,
      path: analysis.controlFlow.context(match.index),
      roots,
    });
  }
  return calls;
}

function outputCandidates(argument) {
  return [
    argument.trim(),
    ...splitTopLevel(argument),
    ...[...argument.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]),
    ...[...argument.matchAll(
      /\b([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)?)\b/g,
    )].map((match) => match[1]),
  ];
}

function printsOperationField(
  analysis,
  operation,
  lifecyclePath,
  allowedFields,
  nextOperation = null,
) {
  return outputCalls(analysis).some((output) => {
    if (!output.roots.has(operation.traceRoot)) return false;
    const outputOwner = ownerAt(analysis.callables, output.index);
    const afterOperation = outputOwner === operation.owner
      ? output.index > operation.index
      : operation.invocationIndex !== null &&
        output.index > operation.invocationIndex;
    const beforeNext = !nextOperation ||
      outputOwner !== nextOperation.owner ||
      output.index < nextOperation.index;
    return afterOperation && beforeNext &&
      mergePathContexts(lifecyclePath, output.path) &&
      outputCandidates(output.argument).some((candidate) => {
        const value = analysis.resolveExpression(candidate, output.index);
        return value?.kind === "resource-field" &&
          value.clientId === operation.receiver.clientId &&
          value.origin === operation.index &&
          allowedFields.has(value.field);
      });
  });
}

function iteratesAndPrintsList(analysis, operation, lifecyclePath) {
  const code = maskSource(analysis.source);
  const pattern =
    /\bfor\s+await\s*\(\s*(?:const|let|var)\s+([A-Za-z_$]\w*)\s+of\s+/g;
  for (const match of code.matchAll(pattern)) {
    const opening = code.indexOf("(", match.index);
    const closing = matchingClosing(code, opening);
    if (closing === -1) continue;
    const header = analysis.source.slice(opening + 1, closing);
    const ofIndex = header.search(/\bof\b/);
    if (ofIndex === -1) continue;
    const iterable = header.slice(ofIndex + 2).trim();
    const value = analysis.resolveExpression(iterable, opening + 1 + ofIndex);
    if (
      value?.kind !== "resource-list" ||
      value.clientId !== operation.receiver.clientId ||
      value.origin !== operation.index
    ) {
      continue;
    }
    const body = statementRange(code, closing + 1);
    const output = outputCalls(analysis).find((candidate) =>
      body.contentStart <= candidate.index &&
      candidate.index < body.contentEnd &&
      candidate.roots.has(operation.traceRoot) &&
      mergePathContexts(lifecyclePath, candidate.path) &&
      outputCandidates(candidate.argument).some((expression) => {
        const compact = expression.replace(/\s+/g, "");
        if (compact === `${match[1]}.name`) return true;
        if (!/^[A-Za-z_$]\w*$/.test(compact)) return false;
        const binding = analysis.bindings.resolve(compact, candidate.index);
        const latest = analysis.bindings.latest(binding, candidate.index);
        return latest &&
          latest.index >= body.contentStart &&
          latest.expression?.replace(/\s+/g, "") === `${match[1]}.name`;
      })
    );
    if (!output) continue;
    const beforeOutput = code.slice(body.contentStart, output.index);
    if (
      new RegExp(
        `(?<![\\w$.])${escapeRegExp(match[1])}\\s*=(?!=|>)`,
      ).test(beforeOutput)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function deletionConfirmation(analysis, state) {
  const completionIndex = state.deletion.index;
  return outputCalls(analysis).some((output) => {
    if (
      !output.roots.has(state.create.traceRoot) ||
      output.index <= completionIndex ||
      !mergePathContexts(state.deletionPath, output.path) ||
      !/\b(?:deleted|removed|deletion\s+complete)\b/i.test(output.argument)
    ) {
      return false;
    }
    return outputCandidates(output.argument).some((candidate) =>
      sameEnvironmentValue(
        analysis.resolveExpression(candidate, output.index),
        state.create.resolvedArguments[1],
      )
    );
  });
}

function analyses(workspace) {
  const prepared = prepareWorkspace(workspace);
  return prepared.modules.length === 0
    ? []
    : [createAnalysis({ ...workspace, prepared })];
}

function tryCatchBlocks(source) {
  const code = maskSource(source);
  const blocks = [];
  for (const match of code.matchAll(/\btry\s*\{/g)) {
    const tryOpening = match.index + match[0].lastIndexOf("{");
    const tryBody = balancedText(source, tryOpening, "{", "}");
    const tryEnd = tryOpening + tryBody.length + 2;
    let catchStart = skipSpace(code, tryEnd);
    if (!/^catch\b/.test(code.slice(catchStart))) continue;
    let cursor = skipSpace(code, catchStart + 5);
    let error = null;
    if (code[cursor] === "(") {
      const closing = matchingClosing(code, cursor);
      if (closing === -1) continue;
      const binding = source.slice(cursor + 1, closing).trim();
      error = /^([A-Za-z_$]\w*)(?:\s*:\s*[^)]+)?$/.exec(binding)?.[1] ??
        null;
      cursor = skipSpace(code, closing + 1);
    }
    if (code[cursor] !== "{") continue;
    const catchOpening = cursor;
    const body = balancedText(source, catchOpening, "{", "}");
    blocks.push({
      body,
      bodyStart: catchOpening + 1,
      catchEnd: catchOpening + body.length + 2,
      catchStart,
      error,
      index: match.index,
      tryBody,
      tryStart: tryOpening + 1,
      tryEnd,
    });
  }
  return blocks;
}

function stripExpressionParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith("(")) {
    const inner = balancedText(value, 0);
    if (inner.length + 2 !== value.length) break;
    value = inner.trim();
  }
  return value;
}

function caughtAliases(body, error) {
  const aliases = new Set(
    typeof error === "string"
      ? [error]
      : error ?? [],
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of maskSource(body).matchAll(
      /\bconst\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*([A-Za-z_$]\w*)\s*;/g,
    )) {
      if (aliases.has(match[2]) && !aliases.has(match[1])) {
        aliases.add(match[1]);
        changed = true;
      }
    }
  }
  return aliases;
}

function expressionUsesAlias(expression, aliases, detailsOnly = false) {
  return [...aliases].some((alias) => {
    const escaped = escapeRegExp(alias);
    const detail = new RegExp(
      `\\b${escaped}\\s*\\.\\s*(?:message|statusCode|code|name|stack)\\b`,
    );
    return detail.test(expression) ||
      (!detailsOnly && new RegExp(`\\b${escaped}\\b`).test(expression));
  });
}

function detailAliases(body, errorAliases) {
  const aliases = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of maskSource(body).matchAll(
      /\bconst\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*([^;]+);/g,
    )) {
      if (
        (
          expressionUsesAlias(match[2], errorAliases, true) ||
          expressionUsesAlias(match[2], aliases)
        ) &&
        !aliases.has(match[1])
      ) {
        aliases.add(match[1]);
        changed = true;
      }
    }
    for (const match of maskSource(body).matchAll(
      /\bconst\s*\{([^}]+)\}\s*=\s*([A-Za-z_$]\w*)\s*;/g,
    )) {
      if (!errorAliases.has(match[2])) continue;
      for (const item of match[1].split(",")) {
        const parsed = item.trim().match(
          /^(message|statusCode|code|name|stack)(?:\s*:\s*([A-Za-z_$]\w*))?$/,
        );
        const name = parsed?.[2] ?? parsed?.[1];
        if (name && !aliases.has(name)) {
          aliases.add(name);
          changed = true;
        }
      }
    }
  }
  return aliases;
}

function invocationAt(analysis, index) {
  return analysis.reachability.trace.find((call) =>
    call.index === index && call.target
  ) ?? null;
}

function bodyHasUsefulDiagnostic(
  body,
  errorAliases,
  analysis,
  bodyStart,
  seen = new Set(),
) {
  const details = detailAliases(body, errorAliases);
  const code = maskSource(body);
  const sink = /(?:^|\.)(?:log|error|warn|info|debug|trace|write|report|record|emit|capture|publish|observe)\w*$/i;
  const ignored = new Set(["if", "for", "while", "switch", "catch"]);
  const pattern =
    /\b([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)*)\s*\(/g;
  for (const match of code.matchAll(pattern)) {
    const name = match[1].replace(/\s+/g, "");
    if (ignored.has(name)) continue;
    const opening = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(body, opening);
    const exposesDetail =
      expressionUsesAlias(argumentsText, errorAliases) ||
      expressionUsesAlias(argumentsText, details);

    const invocation = invocationAt(analysis, bodyStart + match.index);
    if (invocation?.target && !seen.has(invocation.target)) {
      const helperAliases = new Set();
      const helperArguments = splitTopLevel(argumentsText);
      invocation.target.parameters.forEach((parameter, index) => {
        const argument = helperArguments[index] ?? "";
        if (
          expressionUsesAlias(argument, errorAliases) ||
          expressionUsesAlias(argument, details)
        ) {
          helperAliases.add(parameter);
        }
      });
      if (
        helperAliases.size > 0 &&
        bodyHasUsefulDiagnostic(
          analysis.source.slice(
            invocation.target.bodyStart,
            invocation.target.bodyEnd,
          ),
          helperAliases,
          analysis,
          invocation.target.bodyStart,
          new Set(seen).add(invocation.target),
        )
      ) {
        return true;
      }
      continue;
    }
    if (sink.test(name) && exposesDetail) return true;
  }
  return false;
}

function causalThrow(statement, aliases) {
  const raw = /^\s*throw\s+([\s\S]+?);?\s*$/.exec(statement)?.[1];
  if (!raw) return false;
  const expression = stripExpressionParentheses(raw);
  if (
    [...aliases].some((alias) =>
      new RegExp(`^${escapeRegExp(alias)}$`).test(expression)
    )
  ) {
    return true;
  }
  return [...aliases].some((alias) =>
    new RegExp(
      `\\{[\\s\\S]*\\bcause\\s*:\\s*\\(?\\s*${escapeRegExp(alias)}\\s*\\)?\\s*(?=,|\\})[\\s\\S]*\\}`,
    ).test(expression)
  );
}

function causalHelperCall(
  statement,
  aliases,
  analysis,
  statementStart,
  seen,
) {
  const code = maskSource(statement);
  const match = /^(?:return\s+)?(?:await\s+)?([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)*)\s*\(/.exec(
    code.trim(),
  );
  if (!match) return false;
  const localIndex = code.indexOf(match[1]);
  const invocation = invocationAt(analysis, statementStart + localIndex);
  if (!invocation?.target || seen.has(invocation.target)) return false;
  const opening = code.indexOf("(", localIndex + match[1].length);
  const argumentsText = balancedText(statement, opening);
  const args = splitTopLevel(argumentsText);
  const helperErrors = new Set();
  invocation.target.parameters.forEach((parameter, index) => {
    if (expressionUsesAlias(args[index] ?? "", aliases)) {
      helperErrors.add(parameter);
    }
  });
  if (helperErrors.size === 0) return false;
  return handlerAlwaysCausal(
    analysis.source.slice(
      invocation.target.bodyStart,
      invocation.target.bodyEnd,
    ),
    helperErrors,
    analysis,
    invocation.target.bodyStart,
    new Set(seen).add(invocation.target),
  );
}

function handlerAlwaysCausal(
  body,
  initialAliases,
  analysis,
  bodyStart,
  seen = new Set(),
) {
  const code = maskSource(body);
  const aliases = new Set(initialAliases);
  for (const alias of caughtAliases(body, initialAliases)) {
    aliases.add(alias);
  }

  const parseSequence = (start, end) => {
    let outcomes = new Set(["fall"]);
    let index = start;
    const combine = (next) => {
      const result = new Set(
        [...outcomes].filter((outcome) => outcome !== "fall"),
      );
      if (outcomes.has("fall")) {
        for (const outcome of next) result.add(outcome);
      }
      outcomes = result;
    };
    const skip = () => {
      while (index < end && /\s/.test(code[index])) index += 1;
    };
    const statement = () => {
      skip();
      if (index >= end) return new Set(["invalid"]);
      if (code[index] === ";") {
        index += 1;
        return new Set(["fall"]);
      }
      if (code[index] === "{") {
        const close = matchingClosing(code, index, "{", "}");
        if (close < 0 || close >= end) {
          index = end;
          return new Set(["invalid"]);
        }
        const nested = parseSequence(index + 1, close);
        index = close + 1;
        return nested;
      }
      if (/^if\b/.test(code.slice(index))) {
        index += 2;
        index = skipSpace(code, index);
        if (code[index] !== "(") return new Set(["invalid"]);
        const conditionEnd = matchingClosing(code, index);
        if (conditionEnd < 0 || conditionEnd >= end) {
          index = end;
          return new Set(["invalid"]);
        }
        const condition = code.slice(index + 1, conditionEnd)
          .replace(/\s+/g, "");
        index = conditionEnd + 1;
        const consequent = statement();
        skip();
        let alternate = new Set(["fall"]);
        if (/^else\b/.test(code.slice(index))) {
          index += 4;
          alternate = statement();
        }
        if (condition === "true") return consequent;
        if (condition === "false") return alternate;
        return new Set([...consequent, ...alternate]);
      }
      if (/^(?:while|for)\b/.test(code.slice(index))) {
        const keyword = code.slice(index).match(/^(?:while|for)\b/)[0];
        index += keyword.length;
        index = skipSpace(code, index);
        if (code[index] !== "(") return new Set(["invalid"]);
        const headerEnd = matchingClosing(code, index);
        if (headerEnd < 0 || headerEnd >= end) {
          index = end;
          return new Set(["invalid"]);
        }
        const header = code.slice(index + 1, headerEnd).replace(/\s+/g, "");
        index = headerEnd + 1;
        const nested = statement();
        if (
          header === "false" ||
          (keyword === "for" && /;false;/.test(header))
        ) {
          return new Set(["fall"]);
        }
        return new Set(["fall", ...nested]);
      }
      if (/^do\b/.test(code.slice(index))) {
        index += 2;
        const nested = statement();
        skip();
        if (/^while\b/.test(code.slice(index))) {
          index += 5;
          index = skipSpace(code, index);
          if (code[index] === "(") {
            const close = matchingClosing(code, index);
            index = close < 0 ? end : close + 1;
          }
          skip();
          if (code[index] === ";") index += 1;
        }
        return nested;
      }
      if (/^try\b/.test(code.slice(index))) {
        index += 3;
        index = skipSpace(code, index);
        if (code[index] !== "{") return new Set(["invalid"]);
        const tryEnd = matchingClosing(code, index, "{", "}");
        if (tryEnd < 0 || tryEnd >= end) {
          index = end;
          return new Set(["invalid"]);
        }
        const tryOutcomes = parseSequence(index + 1, tryEnd);
        index = tryEnd + 1;
        skip();
        let caught = null;
        if (/^catch\b/.test(code.slice(index))) {
          index += 5;
          index = skipSpace(code, index);
          if (code[index] === "(") {
            const close = matchingClosing(code, index);
            if (close < 0) return new Set(["invalid"]);
            index = close + 1;
          }
          index = skipSpace(code, index);
          if (code[index] !== "{") return new Set(["invalid"]);
          const catchEnd = matchingClosing(code, index, "{", "}");
          if (catchEnd < 0) return new Set(["invalid"]);
          caught = parseSequence(index + 1, catchEnd);
          index = catchEnd + 1;
        }
        const merged = new Set();
        if (tryOutcomes.has("fall")) merged.add("fall");
        if (tryOutcomes.has("unsafe")) merged.add("unsafe");
        if (tryOutcomes.has("safe")) {
          for (const outcome of caught ?? ["safe"]) merged.add(outcome);
        }
        skip();
        if (/^finally\b/.test(code.slice(index))) {
          index += 7;
          index = skipSpace(code, index);
          if (code[index] !== "{") return new Set(["invalid"]);
          const finallyEnd = matchingClosing(code, index, "{", "}");
          if (finallyEnd < 0) return new Set(["invalid"]);
          const finalOutcomes = parseSequence(index + 1, finallyEnd);
          index = finallyEnd + 1;
          const terminals = [...finalOutcomes].filter(
            (outcome) => outcome !== "fall",
          );
          return finalOutcomes.has("fall")
            ? new Set([...merged, ...terminals])
            : new Set(terminals);
        }
        return merged;
      }

      const statementStart = index;
      let depth = 0;
      for (; index < end; index += 1) {
        if ("([".includes(code[index])) depth += 1;
        else if (")]".includes(code[index])) depth -= 1;
        else if (code[index] === ";" && depth === 0) {
          index += 1;
          break;
        } else if (code[index] === "{" && depth === 0) {
          const close = matchingClosing(code, index, "{", "}");
          if (close < 0) {
            index = end;
            return new Set(["invalid"]);
          }
          index = close + 1;
          return new Set(["fall"]);
        }
      }
      const text = body.slice(statementStart, index).trim();
      if (/^throw\b/.test(maskSource(text))) {
        return new Set([causalThrow(text, aliases) ? "safe" : "unsafe"]);
      }
      if (
        /^process\s*\.\s*exitCode\s*=\s*1\s*;?\s*$/.test(
          maskSource(text),
        ) ||
        /^process\s*\.\s*exit\s*\(\s*1\s*\)\s*;?\s*$/.test(
          maskSource(text),
        )
      ) {
        return new Set(["failed"]);
      }
      if (/^return\b/.test(maskSource(text))) {
        return new Set([
          causalHelperCall(
            text,
            aliases,
            analysis,
            bodyStart + statementStart,
            seen,
          )
            ? "safe"
            : "unsafe",
        ]);
      }
      if (/^(?:break|continue)\b/.test(maskSource(text))) {
        return new Set(["unsafe"]);
      }
      if (
        causalHelperCall(
          text,
          aliases,
          analysis,
          bodyStart + statementStart,
          seen,
        )
      ) {
        return new Set(["safe"]);
      }
      return new Set(["fall"]);
    };

    while (index < end) {
      skip();
      if (index >= end) break;
      combine(statement());
    }
    return outcomes;
  };

  const outcomes = parseSequence(0, code.length);
  return outcomes.has("safe") &&
    [...outcomes].every((outcome) =>
      outcome === "safe" || outcome === "failed"
    );
}

function reachableCatchBlocks(analysis) {
  const fullCode = maskSource(analysis.source);
  return tryCatchBlocks(analysis.source).filter((block) =>
    analysis.isReachable(block.index) &&
    typeScriptMayThrow(
      maskSource(block.tryBody),
      analysis.callables,
      fullCode,
    )
  );
}

const lifecycleMethods = new Set([
  "beginCreateAndWait",
  "beginCreate",
  "pollUntilDone",
  "listByResourceGroup",
  "getProperties",
  "setServiceProperties",
  "delete",
]);

function callableReachesLifecycle(callable, analysis, seen = new Set()) {
  if (!callable || seen.has(callable)) return false;
  if (
    analysis.operations.some((operation) =>
      operation.owner === callable && lifecycleMethods.has(operation.method)
    )
  ) {
    return true;
  }
  return analysis.reachability.trace.some((call) =>
    call.owner === callable &&
    call.target &&
    callableReachesLifecycle(
      call.target,
      analysis,
      new Set(seen).add(callable),
    )
  );
}

function catchProtectsLifecycle(block, analysis) {
  if (
    analysis.operations.some((operation) =>
      block.tryStart <= operation.index &&
      operation.index < block.tryEnd &&
      lifecycleMethods.has(operation.method)
    )
  ) {
    return true;
  }
  return analysis.reachability.trace.some((call) =>
    block.tryStart <= call.index &&
    call.index < block.tryEnd &&
    call.target &&
    callableReachesLifecycle(call.target, analysis)
  );
}

function restErrorGuard(block, analysis, aliases) {
  if (analysis.restErrorTypes.size === 0) return false;
  const code = maskSource(block.body);
  for (const match of code.matchAll(
    /\b([A-Za-z_$]\w*)\s+instanceof\s+([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)?)/g,
  )) {
    if (!aliases.has(match[1])) continue;
    const type = match[2].replace(/\s+/g, "");
    if (!analysis.restErrorTypes.has(type)) continue;
    const root = type.split(".")[0];
    const binding = analysis.bindings.resolve(
      root,
      block.bodyStart + match.index,
    );
    const imported = binding?.imported;
    if (
      binding?.kind === "import" &&
      imported?.specifier === "@azure/core-rest-pipeline" &&
      (
        imported.kind === "namespace"
          ? type.split(".")[1] === "RestError"
          : imported.imported === "RestError"
      )
    ) {
      return true;
    }
  }
  return false;
}

function structuralErrorGuard(block, aliases) {
  const code = maskSource(block.body);
  return [...aliases].some((alias) => {
    const error = escapeRegExp(alias);
    return new RegExp(`\\b${error}\\s+instanceof\\s+Error\\b`).test(code) ||
      (
        new RegExp(
          `typeof\\s+${error}\\s*===?\\s*["']object["']`,
        ).test(code) &&
        new RegExp(`${error}\\s*!==?\\s*null`).test(code) &&
        new RegExp(
          `["'](?:statusCode|code|message)["']\\s+in\\s+${error}\\b`,
        ).test(code)
      );
  });
}

function errorHandlingSummary(analysis) {
  const catches = reachableCatchBlocks(analysis);
  const safe = !catches.some((block) => {
      if (!block.error) return true;
      const aliases = caughtAliases(block.body, block.error);
      return !handlerAlwaysCausal(
        block.body,
        aliases,
        analysis,
        block.bodyStart,
      );
    });
  const useful = safe && catches.some((block) => {
    if (!catchProtectsLifecycle(block, analysis)) return false;
    const aliases = caughtAliases(block.body, block.error);
    return (
      restErrorGuard(block, analysis, aliases) ||
      structuralErrorGuard(block, aliases)
    ) && bodyHasUsefulDiagnostic(
      block.body,
      aliases,
      analysis,
      block.bodyStart,
    );
  });
  return { safe, useful };
}

function meaningfulErrorHandling(workspace) {
  const prepared = prepareWorkspace(workspace);
  if (prepared.modules.length === 0) return false;
  const analysis = createAnalysis({ ...workspace, prepared });
  const summary = errorHandlingSummary(analysis);
  return summary.safe && summary.useful;
}

const rules = {
  "prompt/packages": (workspace) => {
    const documents = sourceDocuments(workspace);
    if (documents.length === 0) return false;
    const dependencies = activeDependencies(workspace.packageJson);
    const allAnalyses = analyses(workspace);
    const required = ["@azure/identity", "@azure/arm-storage"];
    if (!required.every((name) => typeof dependencies[name] === "string")) {
      return false;
    }
    return (
      allAnalyses.every((analysis) => analysis.restErrorTypes.size === 0) ||
      typeof dependencies["@azure/core-rest-pipeline"] === "string"
    );
  },
  "prompt/environment": (workspace) =>
    analyses(workspace).some((analysis) => {
      const state = storageLifecycle(analysis);
      return state?.create &&
        validLifecycleEnvironment(state.create) &&
        correctCreateOptions(analysis, state.create);
    }),
  "prompt/authenticated-client": (workspace) => {
    return analyses(workspace).some((analysis) =>
      analysis.operations.some(
        (operation) =>
          ["storage-accounts", "blob-services"].includes(
            operation.receiver?.kind,
          ) &&
          operation.receiver.clientId,
      )
    );
  },
  "prompt/create-and-output": (workspace) =>
    analyses(workspace).some((analysis) => {
      const state = storageLifecycle(analysis);
      return Boolean(state?.creation);
    }),
  "prompt/list-and-output": (workspace) =>
    analyses(workspace).some((analysis) => {
      const state = storageLifecycle(analysis);
      return Boolean(
        state?.list &&
        iteratesAndPrintsList(analysis, state.list, state.listPath),
      );
    }),
  "prompt/get-and-output": (workspace) =>
    analyses(workspace).some((analysis) => {
      const state = storageLifecycle(analysis);
      return Boolean(
        state?.get &&
        !analysis.operations.some((operation) =>
          operation.method === "listKeys"
        ) &&
        printsOperationField(
          analysis,
          state.get,
          state.getPath,
          new Set([
            "creationTime",
            "id",
            "kind",
            "location",
            "name",
            "primaryLocation",
            "provisioningState",
            "statusOfPrimary",
          ]),
        ),
      );
    }),
  "prompt/versioning-and-output": (workspace) =>
    analyses(workspace).some((analysis) => {
      const state = storageLifecycle(analysis);
      return Boolean(
        state?.versioning &&
        printsOperationField(
          analysis,
          state.versioning,
          state.versioningPath,
          new Set(["isVersioningEnabled"]),
        ),
      );
    }),
  "prompt/delete-and-confirm": (workspace) =>
    analyses(workspace).some((analysis) => {
      const state = storageLifecycle(analysis);
      return Boolean(
        state?.deletion &&
        deletionConfirmation(analysis, state),
      );
    }),
  "prompt/error-handling": (workspace) =>
    meaningfulErrorHandling(workspace),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  return rule(workspace);
}

export function ruleNames() {
  return Object.keys(rules);
}
