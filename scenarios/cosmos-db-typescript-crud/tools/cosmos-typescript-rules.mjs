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
    else if (code[index] === ";" && depth === 0) return index;
  }
  return code.length;
}

function propertyValueEnd(code, start) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if ("([{".includes(code[index])) depth += 1;
    else if (")]}".includes(code[index])) depth -= 1;
    else if ((code[index] === "," || code[index] === ";") && depth === 0) {
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
    const closing = matchingClosing(maskSource(value, false), 0);
    if (closing !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function runtimeCosmosClientReferences(source) {
  const references = [];
  const unmasked = maskSource(source, false);
  const code = maskSource(source);
  for (const match of unmasked.matchAll(
    /\bimport\s+(?!type\b)\{([^}]+)\}\s+from\s+(["'])@azure\/cosmos\2/g,
  )) {
    if (code.slice(match.index, match.index + 6) !== "import") continue;
    for (const item of splitTopLevel(match[1])) {
      const parsed = item.match(
        /^(?!type\b)CosmosClient(?:\s+as\s+([A-Za-z_$]\w*))?$/,
      );
      if (parsed) references.push(parsed[1] ?? "CosmosClient");
    }
  }
  for (const match of unmasked.matchAll(
    /\bimport\s+\*\s+as\s+([A-Za-z_$]\w*)\s+from\s+(["'])@azure\/cosmos\2/g,
  )) {
    if (code.slice(match.index, match.index + 6) === "import") {
      references.push(`${match[1]}.CosmosClient`);
    }
  }
  return references;
}

function propertyExpression(object, property) {
  const code = maskSource(object, false);
  const explicit = new RegExp(
    `(?:^|,)\\s*${escapeRegExp(property)}\\s*:\\s*`,
    "m",
  ).exec(code);
  if (explicit) {
    const start = explicit.index + explicit[0].length;
    return object.slice(start, propertyValueEnd(code, start)).trim();
  }
  return new RegExp(
    `(?:^|,)\\s*${escapeRegExp(property)}\\s*(?=,|$)`,
  ).test(code)
    ? property
    : null;
}

function assignments(source, name, before = source.length) {
  const code = maskSource(source, false);
  const matches = [];
  const pattern = new RegExp(
    `\\b(?:(?:const|let|var)\\s+)?${escapeRegExp(name)}` +
      `(?:\\s*:[^=;\\n]+)?\\s*=(?!=|>)`,
    "g",
  );
  for (const match of code.matchAll(pattern)) {
    if (match.index >= before) break;
    const equals = match.index + match[0].lastIndexOf("=");
    matches.push({
      expression: source.slice(equals + 1, expressionEnd(code, equals + 1)),
      index: match.index,
    });
  }
  return matches;
}

function resolveExpression(source, expression, before, seen = new Set()) {
  const value = unwrap(expression);
  if (/^(?:["'`])[\s\S]*(?:["'`])$/.test(value)) {
    return { kind: "literal", value: value.slice(1, -1) };
  }
  const environment = value.match(
    /^process\s*\.\s*env(?:\s*\.\s*([A-Za-z_$]\w*)|\s*\[\s*(["'])([^"']+)\2\s*\])$/,
  );
  if (environment) {
    return { kind: "environment", name: environment[1] ?? environment[3] };
  }
  const helper = value.match(/^([A-Za-z_$]\w*)\s*\(\s*(["'])([^"']+)\2\s*\)$/);
  if (helper) {
    const code = maskSource(source);
    const definition = new RegExp(
      `\\bfunction\\s+${escapeRegExp(helper[1])}\\s*\\(\\s*` +
        `([A-Za-z_$]\\w*)[^)]*\\)[^{]*\\{`,
    ).exec(code);
    if (definition) {
      const opening = definition.index + definition[0].lastIndexOf("{");
      const closing = matchingClosing(code, opening, "{", "}");
      const parameter = escapeRegExp(definition[1]);
      const body = code.slice(opening + 1, closing);
      if (
        new RegExp(
          `\\bprocess\\s*\\.\\s*env\\s*\\[\\s*${parameter}\\s*\\]`,
        ).test(body)
      ) {
        return { kind: "environment", name: helper[3] };
      }
    }
  }
  if (/^[A-Za-z_$]\w*$/.test(value) && !seen.has(value)) {
    const assignment = assignments(source, value, before).at(-1);
    if (assignment) {
      return resolveExpression(
        source,
        assignment.expression,
        assignment.index,
        new Set(seen).add(value),
      );
    }
  }
  return null;
}

function validClient(source) {
  const references = runtimeCosmosClientReferences(source);
  if (references.length === 0) return false;
  const code = maskSource(source);
  const pattern = new RegExp(
    `\\bnew\\s+(?:${references.map(escapeRegExp).join("|")})\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(pattern)) {
    const root = match[0].match(/\bnew\s+([A-Za-z_$]\w*)/)?.[1];
    const parameterShadow = [...code.matchAll(
      /\b(?:async\s+)?function\s+[A-Za-z_$]\w*\s*\(([^)]*)\)[^{]*\{/g,
    )].some((definition) => {
      const opening = definition.index + definition[0].lastIndexOf("{");
      const closing = matchingClosing(code, opening, "{", "}");
      return opening < match.index &&
        match.index < closing &&
        splitTopLevel(definition[1]).some((parameter) =>
          parameter.match(/^([A-Za-z_$]\w*)/)?.[1] === root
        );
    });
    if (
      root &&
      (
        parameterShadow ||
        new RegExp(
          `\\b(?:class|function|const|let|var)\\s+${escapeRegExp(root)}\\b`,
        ).test(code.slice(0, match.index))
      )
    ) {
      continue;
    }
    const opening = code.indexOf("(", match.index);
    const argument = unwrap(balancedText(source, opening));
    if (!argument.startsWith("{") || !argument.endsWith("}")) continue;
    const object = argument.slice(1, -1);
    const endpoint = propertyExpression(object, "endpoint");
    const key = propertyExpression(object, "key");
    if (
      endpoint &&
      key &&
      resolveExpression(source, endpoint, match.index)?.kind === "environment" &&
      resolveExpression(source, key, match.index)?.kind === "environment"
    ) {
      return true;
    }
  }
  return false;
}

function querySpecifications(source) {
  const code = maskSource(source, false);
  const specifications = [];
  for (const match of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:\s*SqlQuerySpec)?\s*=\s*\{/g,
  )) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingClosing(code, opening, "{", "}");
    if (closing === -1) continue;
    const body = source.slice(opening + 1, closing);
    const query = propertyExpression(body, "query");
    const parameters = propertyExpression(body, "parameters");
    if (query && parameters) {
      specifications.push({
        index: match.index,
        name: match[1],
        parameters,
        query,
      });
    }
  }
  return specifications;
}

function validParameterizedQuery(source) {
  const code = maskSource(source);
  for (const specification of querySpecifications(source)) {
    const queryText = resolveExpression(
      source,
      specification.query,
      specification.index,
    )?.value;
    if (!queryText) continue;
    const sql = queryText.match(
      /\bFROM\s+([A-Za-z_$]\w*)\s+WHERE\s+([A-Za-z_$]\w*)\.category\s*=\s*(@[A-Za-z_$]\w*)\b/i,
    );
    if (!sql || sql[1] !== sql[2]) continue;
    const parameters = unwrap(specification.parameters);
    if (!parameters.startsWith("[") || !parameters.endsWith("]")) continue;
    const entries = splitTopLevel(parameters.slice(1, -1));
    const matched = entries.some((entry) => {
      const object = unwrap(entry);
      if (!object.startsWith("{") || !object.endsWith("}")) return false;
      const body = object.slice(1, -1);
      const name = resolveExpression(
        source,
        propertyExpression(body, "name") ?? "",
        specification.index,
      )?.value;
      const value = resolveExpression(
        source,
        propertyExpression(body, "value") ?? "",
        specification.index,
      )?.value;
      return name === sql[3] && value === "electronics";
    });
    if (
      matched &&
      new RegExp(
        `\\.items\\s*\\.\\s*query(?:<[^>]+>)?\\s*\\(\\s*${escapeRegExp(specification.name)}\\s*\\)`,
      ).test(code)
    ) {
      return true;
    }
  }
  return false;
}

function itemReferences(source) {
  const code = maskSource(source, false);
  const references = [];
  const pattern =
    /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*([A-Za-z_$]\w*)\s*\.\s*item\s*\(/g;
  for (const match of code.matchAll(pattern)) {
    const opening = code.indexOf("(", match.index + match[0].length - 1);
    const argumentsList = splitTopLevel(balancedText(source, opening));
    if (argumentsList.length >= 2) {
      references.push({
        container: match[2],
        id: unwrap(argumentsList[0]),
        index: match.index,
        name: match[1],
        partition: unwrap(argumentsList[1]),
      });
    }
  }
  return references;
}

function callOnReference(source, reference, method) {
  const code = maskSource(source);
  const pattern = new RegExp(
    `\\b${escapeRegExp(reference.name)}\\s*\\.\\s*${method}` +
      `(?:<[^>]+>)?\\s*\\(`,
    "g",
  );
  const calls = [];
  for (const match of code.matchAll(pattern)) {
    const opening = code.indexOf("(", match.index + match[0].length - 1);
    calls.push({
      arguments: splitTopLevel(balancedText(source, opening)),
      awaited: /\bawait\s*$/.test(code.slice(Math.max(0, match.index - 30), match.index)),
      index: match.index,
    });
  }
  return calls;
}

function directItemCalls(source, method) {
  const code = maskSource(source);
  const pattern = new RegExp(
    `\\b([A-Za-z_$]\\w*)\\s*\\.\\s*item\\s*\\(`,
    "g",
  );
  const calls = [];
  for (const match of code.matchAll(pattern)) {
    const itemOpening = code.indexOf("(", match.index + match[0].length - 1);
    const itemClosing = matchingClosing(code, itemOpening);
    if (itemClosing === -1) continue;
    const tail = code.slice(itemClosing + 1);
    const methodMatch = new RegExp(
      `^\\s*\\.\\s*${method}(?:<[^>]+>)?\\s*\\(`,
    ).exec(tail);
    if (!methodMatch) continue;
    const opening = code.indexOf("(", itemClosing + 1 + methodMatch.index);
    calls.push({
      arguments: splitTopLevel(balancedText(source, opening)),
      awaited: /\bawait\s*$/.test(
        code.slice(Math.max(0, match.index - 30), match.index),
      ),
      container: match[1],
      index: match.index,
      itemArguments: splitTopLevel(balancedText(source, itemOpening)).map(unwrap),
    });
  }
  return calls;
}

function updateChangesItem(source, expression, itemName, before) {
  const value = unwrap(expression);
  if (value === itemName) {
    const mutation = new RegExp(
      `\\b${escapeRegExp(itemName)}\\s*\\.\\s*quantity\\s*` +
        `(?:=(?!=)|\\+=|-=|\\+\\+|--)`,
      "g",
    );
    return [...maskSource(source).matchAll(mutation)].some(
      (match) => match.index < before,
    );
  }
  if (/^[A-Za-z_$]\w*$/.test(value)) {
    const assignment = assignments(source, value, before).at(-1);
    return assignment
      ? updateChangesItem(source, assignment.expression, itemName, assignment.index)
      : false;
  }
  if (!value.startsWith("{") || !value.endsWith("}")) return false;
  const body = value.slice(1, -1);
  const parts = splitTopLevel(body);
  const spreadIndex = parts.findIndex(
    (part) => unwrap(part.replace(/^\.\.\./, "")) === itemName &&
      /^\s*\.\.\./.test(part),
  );
  const quantityIndex = parts.findIndex((part) =>
    /^\s*quantity\s*:/.test(maskSource(part, false))
  );
  if (spreadIndex === -1 || quantityIndex <= spreadIndex) return false;
  const quantity = propertyExpression(body, "quantity");
  if (quantity === null || unwrap(quantity) === `${itemName}.quantity`) {
    return false;
  }
  const original = assignments(source, itemName, before)
    .filter((assignment) => unwrap(assignment.expression).startsWith("{"))
    .at(0);
  const originalBody = original &&
    unwrap(original.expression).slice(1, -1);
  const originalQuantity = originalBody &&
    propertyExpression(originalBody, "quantity");
  return originalQuantity == null ||
    unwrap(originalQuantity) !== unwrap(quantity);
}

function validReplaceDelete(source) {
  const code = maskSource(source);
  for (const reference of itemReferences(source)) {
    const id = reference.id.match(/^([A-Za-z_$]\w*)\.id$/)?.[1];
    const partition =
      reference.partition.match(/^([A-Za-z_$]\w*)\.category$/)?.[1];
    if (!id || id !== partition) continue;
    const reads = callOnReference(source, reference, "read");
    const replaces = callOnReference(source, reference, "replace");
    const deletes = callOnReference(source, reference, "delete");
    for (const replace of replaces) {
      if (
        !replace.awaited ||
        replace.arguments.length === 0 ||
        !updateChangesItem(source, replace.arguments[0], id, replace.index)
      ) {
        continue;
      }
      if (
        reads.some((read) => read.awaited && read.index < replace.index) &&
        !deletes.some((remove) => remove.index < replace.index) &&
        deletes.some(
          (remove) => remove.awaited && replace.index < remove.index,
        ) &&
        (() => {
          const declarationEnd = code.indexOf(";", reference.index);
          return declarationEnd !== -1 &&
            !new RegExp(
              `\\b${escapeRegExp(reference.name)}\\s*=(?!=)`,
            ).test(code.slice(declarationEnd + 1, replace.index));
        })()
      ) {
        return true;
      }
    }
  }
  for (const replace of directItemCalls(source, "replace")) {
    const [idExpression, partitionExpression] = replace.itemArguments;
    const itemName = idExpression?.match(/^([A-Za-z_$]\w*)\.id$/)?.[1];
    if (
      !itemName ||
      partitionExpression !== `${itemName}.category` ||
      !replace.awaited ||
      !updateChangesItem(
        source,
        replace.arguments[0] ?? "",
        itemName,
        replace.index,
      )
    ) {
      continue;
    }
    const sameReference = (call) =>
      call.container === replace.container &&
      call.itemArguments[0] === idExpression &&
      call.itemArguments[1] === partitionExpression &&
      call.awaited;
    if (
      directItemCalls(source, "read").some(
        (read) => sameReference(read) && read.index < replace.index,
      ) &&
      directItemCalls(source, "delete").some(
        (remove) => sameReference(remove) && replace.index < remove.index,
      )
    ) {
      return true;
    }
  }
  return false;
}

const rules = {
  "prompt/cosmos-package": ({ packageJson }) => {
    try {
      return typeof JSON.parse(packageJson).dependencies?.["@azure/cosmos"] ===
        "string";
    } catch {
      return false;
    }
  },
  "prompt/cosmos-client": ({ source }) => validClient(source),
  "prompt/database-container": ({ source }) =>
    /\.databases\.createIfNotExists\s*\(\s*\{[\s\S]{0,160}?\bid\s*:\s*["']TestDB["']/.test(
      source,
    ) &&
    /\.containers\.createIfNotExists\s*\(\s*\{[\s\S]{0,240}?\bid\s*:\s*["']Items["'][\s\S]{0,240}?["']\/category["']/.test(
      source,
    ),
  "prompt/create-read": ({ source }) =>
    /\.items\.create(?:<[^>]+>)?\s*\(/.test(source) &&
    ["id", "category", "name", "quantity"].every((field) =>
      new RegExp(`\\b${field}\\b`).test(source)
    ) &&
    (
      /\.item\s*\([^)]*,[^)]*\)[\s\S]{0,120}?\.read(?:<[^>]+>)?\s*\(/.test(
        source,
      ) ||
      itemReferences(source).some((reference) =>
        callOnReference(source, reference, "read").some((call) => call.awaited)
      )
    ),
  "prompt/parameterized-query": ({ source }) =>
    validParameterizedQuery(source),
  "prompt/replace-delete": ({ source }) => validReplaceDelete(source),
  "prompt/status-error": ({ source }) =>
    /\bcatch\s*(?:\(|\.)/.test(source) &&
    /\.(?:code|statusCode)\b/.test(source),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  return Boolean(workspace.source.trim()) && rule(workspace);
}

export function ruleNames() {
  return Object.keys(rules);
}
