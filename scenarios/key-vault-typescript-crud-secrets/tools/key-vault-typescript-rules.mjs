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
    const owner = ownerAt(callables, match.index)?.name ?? "<top-level>";
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
    const owner = ownerAt(callables, match.index)?.name ?? "<top-level>";
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
    const owner = ownerAt(callables, index)?.name ?? "<top-level>";
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
    const owner = ownerAt(callables, match.index)?.name ?? "<top-level>";
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
    const owner = ownerAt(callables, match.index)?.name ?? "<top-level>";
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
    if (")]}".includes(code[index])) depth -= 1;
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

function buildBindings(source, scopeIndex, importedLocals) {
  const code = maskSource(source);
  const original = maskSource(source, false);
  const events = [];
  let nextId = 1;
  for (const name of importedLocals) {
    events.push({ index: 0, kind: "import", name });
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
    const scope = event.kind === "import"
      ? scopeIndex.root
      : event.declarationKind === "var"
        ? lexicalScope.functionScope
        : lexicalScope;
    let binding;
    if (["import", "declaration", "parameter"].includes(event.kind)) {
      binding = event.declarationKind === "var"
        ? scope.bindings.get(event.name)
        : null;
      if (!binding) {
        binding = {
          history: [],
          id: nextId++,
          index: event.index,
          kind: event.kind === "import" ? "import" : "local",
          name: event.name,
          scope,
        };
        scope.bindings.set(event.name, binding);
      } else if (event.kind !== "import") {
        binding.kind = "local";
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
  const add = (name, opening, parameters, kind = "function", owner = null) => {
    const body = balancedText(source, opening, "{", "}");
    if (!body && source[opening + 1] !== "}") return;
    const parameterItems = splitTopLevel(parameters);
    const parsedParameters = parameterItems.map((item) =>
      item.match(/^(?:\.\.\.)?([A-Za-z_$]\w*)/)?.[1]
    );
    callables.push({
      bodyEnd: opening + body.length + 1,
      bodyStart: opening + 1,
      kind,
      name,
      owner,
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
    const classRange = classRanges.find(
      (range) => range.start <= match.index && match.index < range.end,
    );
    if (classRange) {
      add(
        `${classRange.name}.${match[1]}`,
        opening,
        sourceParameters(match, match[2]),
        "class-method",
        classRange.name,
      );
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
        /\bnew\s+([A-Za-z_$]\w*)\s*\([^;{}]*\)\s*\.\s*$/,
      )?.[1] ?? null,
      returned: /\breturn\s+(?:await\s+)?(?:\(*\s*)*$/.test(statementPrefix),
    });
  }
  return calls;
}

function buildReachability(source, callables, calls, controlFlow) {
  const instances = new Map();
  const code = maskSource(source);
  const instancePattern =
    /\b(?:const|let|var)\s+([A-Za-z_$]\w*)[^=;\n]*=\s*new\s+([A-Za-z_$]\w*)\s*\(/g;
  for (const match of code.matchAll(instancePattern)) {
    instances.set(match[1], match[2]);
  }
  const byName = new Map(callables.map((callable) => [callable.name, callable]));
  function targetFor(call) {
    if (byName.has(call.name)) return byName.get(call.name);
    if (call.inlineClass) {
      return byName.get(`${call.inlineClass}.${call.name}`) ?? null;
    }
    if (call.name.startsWith("this.") && call.owner?.owner) {
      return byName.get(`${call.owner.owner}.${call.name.slice(5)}`) ?? null;
    }
    const [receiver, method] = call.name.split(".");
    if (instances.has(receiver)) {
      return byName.get(`${instances.get(receiver)}.${method}`) ?? null;
    }
    return null;
  }

  const reachable = new Set();
  const incoming = new Map();
  const trace = [];
  function visit(owner, inheritedAwait = false, stack = new Set()) {
    const key = owner?.name ?? "<top-level>";
    if (stack.has(key)) return;
    if (owner) reachable.add(owner);
    const nextStack = new Set(stack).add(key);
    const ownerCalls = calls
      .filter((call) =>
        call.owner === owner && controlFlow.context(call.index).reachable
      )
      .sort((left, right) => left.index - right.index);
    for (const call of ownerCalls) {
      const target = targetFor(call);
      const effectiveAwait = call.awaited ||
        (inheritedAwait && call.returned);
      if (target) {
        const entries = incoming.get(target) ?? [];
        entries.push({ ...call, effectiveAwait });
        incoming.set(target, entries);
        visit(target, effectiveAwait, nextStack);
      }
      trace.push({ ...call, effectiveAwait, target });
    }
  }
  visit(null);
  return { incoming, reachable, trace };
}

function createAnalysis(workspace) {
  const source = workspace.source;
  const identity = importsFrom(source, "@azure/identity");
  const keyVault = importsFrom(source, "@azure/keyvault-secrets");
  const rest = importsFrom(source, "@azure/core-rest-pipeline");
  const importedLocals = new Set([
    ...identity.named.values(),
    ...identity.namespaces,
    ...keyVault.named.values(),
    ...keyVault.namespaces,
    ...rest.named.values(),
    ...rest.namespaces,
  ]);
  const scopeIndex = buildScopes(source);
  const bindings = buildBindings(source, scopeIndex, importedLocals);
  const callables = extractCallables(source);
  const calls = extractCalls(source, callables);
  const controlFlow = buildControlFlow(source, callables, bindings);
  const reachability = buildReachability(
    source,
    callables,
    calls,
    controlFlow,
  );
  const credentialTypes = importTypeNames(
    source,
    "@azure/identity",
    "DefaultAzureCredential",
  );
  const clientTypes = importTypeNames(
    source,
    "@azure/keyvault-secrets",
    "SecretClient",
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
    const root = normalized.split(".")[0];
    return bindings.resolve(root, position)?.kind === "import";
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
    const credential = resolveExpression(args[1], position, owner, seen);
    return credential?.kind === "credential"
      ? {
          credentialId: credential.id,
          id: `client:${position}:${match.index}`,
          kind: "client",
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
      const classMatch = classPattern.exec(code);
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
        const objectMatch = objectPattern.exec(code);
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
    const key = `${position}:${owner?.name ?? "top"}:${text}`;
    if (seen.has(key)) return null;
    const nextSeen = new Set(seen).add(key);
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
      /^(?:await\s+)?([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*)\s*\.\s*(getSecret|beginDeleteSecret)\s*\(/,
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
      if (receiver?.kind === "client" && name?.kind === "string") {
        const origin = analysisSourceIndex(operation[0], position);
        return {
          clientId: receiver.id,
          kind: operation[2] === "getSecret" ? "secret" : "poller",
          name: name.value,
          origin,
        };
      }
    }

    const inlineSecretValue = text.match(
      /^\(\s*await\s+([A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*)\s*\.\s*getSecret\s*\(([\s\S]*)\)\s*\)\s*\.\s*value$/,
    );
    if (inlineSecretValue) {
      const receiver = resolveExpression(
        inlineSecretValue[1],
        position,
        owner,
        nextSeen,
      );
      const name = resolveExpression(
        inlineSecretValue[2],
        position,
        owner,
        nextSeen,
      );
      if (receiver?.kind === "client" && name?.kind === "string") {
        return {
          clientId: receiver.id,
          kind: "secret-value",
          name: name.value,
          origin: analysisSourceIndex(
            inlineSecretValue[1],
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
        const targetCode = maskSource(
          source.slice(
            invocation.target.bodyStart,
            invocation.target.bodyEnd,
          ),
        );
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
      /^((?:this|[A-Za-z_$]\w*)\.[A-Za-z_$]\w*)$/,
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
      const [base, property] = member.split(".");
      const baseValue = resolveExpression(base, position, owner, nextSeen);
      if (baseValue?.kind === "secret" && property === "value") {
        return { ...baseValue, kind: "secret-value" };
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
    "setSecret",
    "getSecret",
    "beginDeleteSecret",
    "purgeDeletedSecret",
    "pollUntilDone",
    "poll",
    "isDone",
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
    if (incoming.length === 0) return [{ ...operation, invocationIndex: null }];
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
        awaited: operation.awaited ||
          (operation.returned && invocation.effectiveAwait),
        invocationIndex: invocation.index,
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
  let nextOrder = 0;
  function appendOwner(
    owner,
    inheritedAwait = false,
    stack = new Set(),
    invocationIndex = null,
  ) {
    const key = owner?.name ?? "<top-level>";
    if (stack.has(key)) return;
    const nextStack = new Set(stack).add(key);
    const events = [
      ...operations.filter((operation) =>
        operation.owner === owner &&
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
        operationOrder.set(event.operation, nextOrder++);
        continue;
      }
      const target = event.call.target ??
        reachability.trace.find((entry) =>
          entry.index === event.call.index && entry.owner === event.call.owner
        )?.target;
      if (target) {
        appendOwner(
          target,
          event.call.awaited || (inheritedAwait && event.call.returned),
          nextStack,
          event.call.index,
        );
      }
    }
  }
  appendOwner(null);

  return {
    bindings,
    callables,
    clientTypes,
    controlFlow,
    credentialTypes,
    imports: { identity, keyVault, rest },
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

function tryCatchBlocks(source) {
  const code = maskSource(source);
  const blocks = [];
  for (const match of code.matchAll(/\btry\s*\{/g)) {
    const tryOpening = match.index + match[0].lastIndexOf("{");
    const tryBody = balancedText(source, tryOpening, "{", "}");
    const tryEnd = tryOpening + tryBody.length + 2;
    const catchMatch = code.slice(tryEnd).match(
      /^\s*catch\s*\(\s*([A-Za-z_$]\w*)(?:\s*:\s*[^)]+)?\)\s*\{/,
    );
    if (!catchMatch) continue;
    const catchOpening =
      tryEnd + catchMatch.index + catchMatch[0].lastIndexOf("{");
    blocks.push({
      body: balancedText(source, catchOpening, "{", "}"),
      bodyStart: catchOpening + 1,
      error: catchMatch[1],
      index: match.index,
      tryBody,
      tryStart: tryOpening + 1,
      tryEnd,
    });
  }
  return blocks;
}

function catchReportsFailure(block) {
  const code = maskSource(block.body);
  const source = maskSource(block.body, false);
  const error = escapeRegExp(block.error);
  for (const match of code.matchAll(
    /\bconsole\s*\.\s*(?:error|warn|log|info)\s*\(/g,
  )) {
    const opening = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(source, opening);
    if (
      new RegExp(
        `\\b${error}(?:\\s*\\.\\s*(?:message|statusCode|code|name|stack))?\\b`,
      ).test(maskSource(argumentsText, false)) ||
      /\b(?:error|fail(?:ed|ure)?|key\s+vault|secret)\b/i.test(argumentsText)
    ) {
      return true;
    }
  }
  return false;
}

function meaningfulTryCatchHandling(analysis) {
  const blocks = tryCatchBlocks(analysis.source).filter(
    (block) =>
      typeScriptMayThrow(
        maskSource(block.tryBody),
        analysis.callables,
        maskSource(analysis.source),
      ) &&
      analysis.controlFlow.context(block.index).reachable,
  );
  return blocks.some((block) => {
    const wrapsLifecycleDirectly =
      ["setSecret", "getSecret", "beginDeleteSecret"].some((method) =>
        new RegExp(`\\.${method}\\s*\\(`).test(maskSource(block.tryBody))
      );
    const wrapsLifecycleHelper = analysis.reachability.trace.some((call) =>
      block.tryStart <= call.index &&
      call.index < block.tryEnd &&
      call.target &&
      analysis.operations.some((operation) =>
        operation.owner === call.target &&
        ["setSecret", "getSecret", "beginDeleteSecret"].includes(
          operation.method,
        )
      )
    );
    const wrapsLifecycle = wrapsLifecycleDirectly || wrapsLifecycleHelper;
    return wrapsLifecycle && catchReportsFailure(block);
  });
}

const rules = {
  "prompt/packages": (workspace) => {
    if (!hasSource(workspace)) return false;
    const dependencies = packageDependencies(workspace.packageJson);
    const analysis = createAnalysis(workspace);
    const required = ["@azure/identity", "@azure/keyvault-secrets"];
    if (!required.every((name) => typeof dependencies[name] === "string")) {
      return false;
    }
    return (
      analysis.restErrorTypes.size === 0 ||
      typeof dependencies["@azure/core-rest-pipeline"] === "string"
    );
  },
  "prompt/authenticated-client": (workspace) => {
    if (!hasSource(workspace)) return false;
    const analysis = createAnalysis(workspace);
    return analysis.operations.some(
      (operation) => operation.receiver?.kind === "client",
    );
  },
  "prompt/create-secret": (workspace) => {
    if (!hasSource(workspace)) return false;
    return Boolean(lifecycle(createAnalysis(workspace)).create);
  },
  "prompt/read-and-print": (workspace) => {
    if (!hasSource(workspace)) return false;
    const analysis = createAnalysis(workspace);
    const state = lifecycle(analysis);
    return Boolean(state.read) && printsRetrievedValue(analysis, state);
  },
  "prompt/update-secret": (workspace) => {
    if (!hasSource(workspace)) return false;
    return Boolean(lifecycle(createAnalysis(workspace)).update);
  },
  "prompt/delete-and-wait": (workspace) => {
    if (!hasSource(workspace)) return false;
    const state = lifecycle(createAnalysis(workspace));
    return Boolean(state.deletion && state.wait && state.genuinePolling);
  },
  "prompt/purge-after-delete": (workspace) => {
    if (!hasSource(workspace)) return false;
    return Boolean(lifecycle(createAnalysis(workspace)).purge);
  },
  "prompt/rest-error": (workspace) => {
    if (!hasSource(workspace)) return false;
    return meaningfulTryCatchHandling(createAnalysis(workspace));
  },
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  return rule(workspace);
}

export function ruleNames() {
  return Object.keys(rules);
}
