import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const cosmosPackageVersion = "3.62.1";
const newtonsoftPackageVersion = "13.0.4";
const cosmosNamespace = "Microsoft.Azure.Cosmos";
const sdkTypes = [
  "Container",
  "CosmosClient",
  "Database",
  "FeedIterator",
  "FeedResponse",
  "QueryDefinition",
  "QueryRequestOptions",
];

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
      const closeIndex = source.indexOf('"""', index + 3);
      if (closeIndex >= 0) index = closeIndex + 2;
      continue;
    }

    const verbatim = source[index - 1] === "@";
    const contentStart = index + 1;
    let value = "";
    let closeIndex = -1;
    let interpolationDepth = 0;
    for (let cursor = contentStart; cursor < source.length; cursor += 1) {
      if (verbatim && source[cursor] === '"' && source[cursor + 1] === '"') {
        value += '"';
        cursor += 1;
      } else if (
        interpolated &&
        source[cursor] === "{" &&
        source[cursor + 1] !== "{"
      ) {
        interpolationDepth += 1;
        value += source[cursor];
      } else if (
        interpolated &&
        source[cursor] === "}" &&
        source[cursor + 1] !== "}" &&
        interpolationDepth > 0
      ) {
        interpolationDepth -= 1;
        value += source[cursor];
      } else if (
        interpolated &&
        interpolationDepth > 0 &&
        source[cursor] === '"'
      ) {
        value += source[cursor];
        for (cursor += 1; cursor < source.length; cursor += 1) {
          value += source[cursor];
          if (source[cursor] === "\\") {
            cursor += 1;
            value += source[cursor] ?? "";
          } else if (source[cursor] === '"') {
            break;
          }
        }
      } else if (!verbatim && source[cursor] === "\\") {
        const escaped = source[cursor + 1] ?? "";
        value +=
          { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' }[escaped] ??
          escaped;
        cursor += 1;
      } else if (source[cursor] === '"' && interpolationDepth === 0) {
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
      if (!interpolated) literals.set(marker, value);
    }
    index = closeIndex;
  }
  return { code: characters.join(""), literals };
}

function literalValue(expression, literals) {
  for (const [marker, value] of literals) {
    if (expression.includes(marker)) return value;
  }
  return null;
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n") characters[index] = " ";
  }
}

function withoutDeadCode(source) {
  const characters = [...source];
  for (const pattern of [
    /\b(?:if|while)\s*\(\s*false\s*\)\s*\{/g,
    /\bfor\s*\([^;]*;\s*false\s*;[^)]*\)\s*\{/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const open = match.index + match[0].lastIndexOf("{");
      const close = matchingDelimiter(source, open, "{", "}");
      if (close >= 0) maskRange(characters, match.index, close + 1);
    }
  }
  for (const match of source.matchAll(
    /\bif\s*\(\s*false\s*\)\s*([^;{}]*;)/g,
  )) {
    maskRange(characters, match.index, match.index + match[0].length);
  }

  const maskTerminated = (start, end) => {
    let statementStart = start;
    let parentheses = 0;
    let brackets = 0;
    for (let index = start; index < end; index += 1) {
      const character = characters[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") parentheses -= 1;
      else if (character === "[") brackets += 1;
      else if (character === "]") brackets -= 1;
      else if (character === "{" && parentheses === 0 && brackets === 0) {
        const close = matchingDelimiter(characters.join(""), index, "{", "}");
        if (close < 0 || close >= end) break;
        maskTerminated(index + 1, close);
        index = close;
        statementStart = close + 1;
      } else if (
        character === ";" &&
        parentheses === 0 &&
        brackets === 0
      ) {
        if (
          /^(?:\s*(?:return|throw)\b|\s*(?:(?:global::)?System\s*\.\s*)?Environment\s*\.\s*Exit\s*\()/.test(
            characters.slice(statementStart, index).join(""),
          )
        ) {
          maskRange(characters, index + 1, end);
          return;
        }
        statementStart = index + 1;
      }
    }
  };
  maskTerminated(0, characters.length);
  return characters.join("");
}

function typeDeclarations(source) {
  const types = [];
  for (const match of source.matchAll(
    /\b(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|ref|new|unsafe)\s+)*(?:class|record|struct|interface|enum)\s+(\w+)[^{;]*\{/g,
  )) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(source, open, "{", "}");
    if (close >= 0) {
      types.push({
        name: match[1],
        start: match.index,
        bodyStart: open + 1,
        bodyEnd: close,
        end: close + 1,
      });
    }
  }
  return types;
}

function methodDeclarations(source) {
  const methods = [];
  const pattern =
    /\b((?:(?:public|private|protected|internal|static|async|virtual|sealed|new|unsafe)\s+)*)((?:(?:(?:global::)?System\.Threading\.Tasks\.)?Task(?:\s*<[^>{}]+>)?|ValueTask(?:\s*<[^>{}]+>)?|void|int|string\??|bool|double|[A-Z]\w*(?:\s*<[^>{}]+>)?))\s+(\w+)\s*\(([^;{}]*)\)\s*\{/g;

  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf("{", match.index);
    const close = matchingDelimiter(source, open, "{", "}");
    if (close < 0) continue;
    const parameters = splitArguments(match[4])
      .map((parameter) =>
        /(?:^|\s)(\w+)\s*(?:=[\s\S]*)?$/.exec(parameter.trim())?.[1]
      )
      .filter(Boolean);
    methods.push({
      modifiers: match[1].trim().split(/\s+/).filter(Boolean),
      returnType: match[2].replace(/\s+/g, ""),
      name: match[3],
      parameterSources: splitArguments(match[4]),
      parameters,
      start: match.index,
      bodyStart: open + 1,
      bodyEnd: close,
      end: close + 1,
      body: source.slice(open + 1, close),
    });
  }

  const types = typeDeclarations(source);
  for (const method of methods) {
    method.parentMethod = methods
      .filter(
        (candidate) =>
          candidate !== method &&
          candidate.bodyStart <= method.start &&
          method.end <= candidate.bodyEnd,
      )
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      )[0] ?? null;
    method.type = types
      .filter(
        (type) =>
          type.bodyStart <= method.start && method.end <= type.bodyEnd,
      )
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      )[0] ?? null;
  }
  return methods;
}

function validMain(method) {
  const parameters = method.parameterSources.join(",").trim();
  return (
    method.name === "Main" &&
    method.modifiers.includes("static") &&
    /^(?:void|int|(?:System\.Threading\.Tasks\.)?Task(?:<int>)?)$/.test(
      method.returnType.replace(/^global::/, ""),
    ) &&
    (
      parameters === "" ||
      /^(?:(?:global::)?System\.)?String\[\]\??\s+\w+$/i.test(parameters) ||
      /^string\[\]\??\s+\w+$/i.test(parameters)
    )
  );
}

function methodAccepts(method, argumentsSource) {
  const required = method.parameterSources.filter(
    (parameter) => !/=/.test(parameter) && !/\bparams\b/.test(parameter),
  ).length;
  const maximum = method.parameterSources.some((parameter) =>
    /\bparams\b/.test(parameter)
  )
    ? Number.POSITIVE_INFINITY
    : method.parameterSources.length;
  return argumentsSource.length >= required && argumentsSource.length <= maximum;
}

function calledMethods(text, methods) {
  const result = [];
  for (const invocation of text.matchAll(
    /\b(?:(\w+)\s*\.\s*)?(\w+)\s*(?:<[^;{}()]+>)?\s*\(/g,
  )) {
    const open = text.indexOf("(", invocation.index);
    const close = matchingDelimiter(text, open, "(", ")");
    if (close < 0) continue;
    const argumentsSource = splitArguments(text.slice(open + 1, close));
    for (const method of methods) {
      if (
        method.name === invocation[2] &&
        methodAccepts(method, argumentsSource)
      ) {
        result.push({ argumentsSource, method });
      }
    }
  }
  return result;
}

function expandInvocations(text, methods, seen = new Set()) {
  const output = [withoutDeadCode(text)];
  for (const { argumentsSource, method } of calledMethods(text, methods)) {
    const key = `${method.start}:${JSON.stringify(argumentsSource)}`;
    if (seen.has(key)) continue;
    const bindings = method.parameters
      .map((parameter, index) =>
        argumentsSource[index] ? `var ${parameter} = ${argumentsSource[index]};` : ""
      )
      .filter(Boolean)
      .join("\n");
    const expanded = `${bindings}\n${withoutDeadCode(method.body)}`;
    output.push(
      expandInvocations(expanded, methods, new Set(seen).add(key)),
    );
  }
  return output.join("\n");
}

function reachableSource(source) {
  const methods = methodDeclarations(source);
  let root = source;
  for (const method of [...methods].sort(
    (left, right) => right.start - left.start,
  )) {
    root =
      root.slice(0, method.start) +
      " ".repeat(method.end - method.start) +
      root.slice(method.end);
  }
  const seeds = [withoutDeadCode(root)];
  for (const method of methods.filter(
    (candidate) =>
      candidate.parentMethod === null &&
      candidate.type !== null &&
      validMain(candidate),
  )) {
    seeds.push(withoutDeadCode(method.body));
  }
  return {
    methods,
    source: expandInvocations(seeds.join("\n"), methods),
  };
}

function normalizeSdkTypes(code) {
  if (
    /\bnamespace\s+Microsoft\s*\.\s*Azure\s*\.\s*Cosmos\b/.test(code) &&
    new RegExp(
      String.raw`\b(?:class|record|struct|interface|enum)\s+(?:${sdkTypes.join("|")})\b`,
    ).test(code)
  ) {
    return null;
  }

  const imports = new Set(
    [...code.matchAll(
      /\b(?:global\s+)?using\s+((?:global::)?[\w.]+)\s*;/g,
    )].map((match) => match[1].replace(/^global::/, "")),
  );
  const aliases = new Map(
    [...code.matchAll(
      /\b(?:global\s+)?using\s+(\w+)\s*=\s*((?:global::)?[\w.]+)\s*;/g,
    )].map((match) => [match[1], match[2].replace(/^global::/, "")]),
  );
  const localTypes = new Set(
    [...code.matchAll(
      /\b(?:class|record|struct|interface|enum)\s+(\w+)/g,
    )].map((match) => match[1]),
  );

  let normalized = code;
  for (const [alias, target] of aliases) {
    if (target === cosmosNamespace) {
      for (const type of sdkTypes) {
        normalized = normalized.replace(
          new RegExp(
            String.raw`\b${escapeRegExp(alias)}\s*\.\s*${type}\b`,
            "g",
          ),
          `Sdk${type}`,
        );
      }
      continue;
    }
    const simple = target.split(".").at(-1);
    if (
      sdkTypes.includes(simple) &&
      target === `${cosmosNamespace}.${simple}`
    ) {
      normalized = normalized.replace(
        new RegExp(String.raw`\b${escapeRegExp(alias)}\b`, "g"),
        `Sdk${simple}`,
      );
    } else if (sdkTypes.includes(alias)) {
      normalized = normalized.replace(
        new RegExp(String.raw`\b${escapeRegExp(alias)}\b`, "g"),
        `Invalid${alias}`,
      );
    }
  }

  for (const type of sdkTypes) {
    normalized = normalized.replace(
      new RegExp(
        String.raw`(?<![\w.])(?:global::)?Microsoft\s*\.\s*Azure\s*\.\s*Cosmos\s*\.\s*${type}\b`,
        "g",
      ),
      `Sdk${type}`,
    );
  }
  for (const type of sdkTypes) {
    normalized = normalized.replace(
      new RegExp(String.raw`(?<![\w.])${type}\b`, "g"),
      imports.has(cosmosNamespace) && !localTypes.has(type)
        ? `Sdk${type}`
        : `Invalid${type}`,
    );
  }
  return normalized.replace(
    /^\s*(?:global\s+)?using\s+(?:\w+\s*=\s*)?(?:global::)?[\w.]+\s*;\s*$/gm,
    " ",
  );
}

function activeProject(project) {
  let source = project.replace(/<!--[\s\S]*?-->/g, " ");
  let previous;
  do {
    previous = source;
    source = source.replace(
      /<(PropertyGroup|ItemGroup)\b(?=[^>]*\bCondition\s*=\s*["']\s*false\s*["'])[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    );
  } while (source !== previous);
  return source;
}

function validManifest(project) {
  const source = activeProject(project);
  const target =
    /<TargetFramework\b[^>]*>\s*([^<]+)\s*<\/TargetFramework>/i.exec(
      source,
    )?.[1] ??
    /<TargetFrameworks\b[^>]*>\s*([^<]+)\s*<\/TargetFrameworks>/i.exec(
      source,
    )?.[1] ??
    "";
  const net8 = target.split(";").some((value) =>
    /^net8\.0(?:-[a-z][a-z0-9]*(?:\.[0-9]+)*)?$/i.test(value.trim())
  );
  if (
    !/<Project\b[^>]*\bSdk\s*=\s*["']Microsoft\.NET\.Sdk["']/i.test(source) ||
    !/<OutputType\b[^>]*>\s*Exe\s*<\/OutputType>/i.test(source) ||
    !net8
  ) {
    return false;
  }

  const pins = new Set();
  for (const reference of source.matchAll(
    /<PackageReference\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/PackageReference\s*>)/gi,
  )) {
    if (/\bCondition\s*=\s*["']\s*false\s*["']/i.test(reference[1])) {
      continue;
    }
    const include =
      /\bInclude\s*=\s*(["'])([^"']+)\1/i.exec(reference[1])?.[2] ??
      /<Include\b[^>]*>([^<]+)<\/Include>/i.exec(reference[2] ?? "")?.[1];
    const version =
      /\bVersion\s*=\s*(["'])([^"']+)\1/i.exec(reference[1])?.[2] ??
      /<Version\b[^>]*>([^<]+)<\/Version>/i.exec(reference[2] ?? "")?.[1];
    const exclude =
      /\bExcludeAssets\s*=\s*(["'])([^"']+)\1/i.exec(reference[1])?.[2] ??
      /<ExcludeAssets\b[^>]*>([^<]+)<\/ExcludeAssets>/i.exec(
        reference[2] ?? "",
      )?.[1] ??
      "";
    const packageName = include?.trim().toLowerCase();
    const expectedVersion = new Map([
      ["microsoft.azure.cosmos", cosmosPackageVersion],
      ["newtonsoft.json", newtonsoftPackageVersion],
    ]).get(packageName);
    if (
      expectedVersion &&
      [expectedVersion, `[${expectedVersion}]`].includes(version?.trim()) &&
      !exclude.split(";").map((value) => value.trim().toLowerCase())
        .some((value) => value === "all" || value === "compile")
    ) {
      pins.add(packageName);
    }
  }
  return (
    pins.has("microsoft.azure.cosmos") &&
    pins.has("newtonsoft.json")
  );
}

function hasEntryPoint(source) {
  const code = dotnetCodeOnly(source);
  const methods = methodDeclarations(code);
  if (methods.some((method) => method.type !== null && validMain(method))) {
    return true;
  }

  let topLevel = code;
  for (const range of [...typeDeclarations(code)].sort(
    (left, right) => right.start - left.start,
  )) {
    topLevel =
      topLevel.slice(0, range.start) +
      " ".repeat(range.end - range.start) +
      topLevel.slice(range.end);
  }
  for (const method of methods
    .filter((candidate) => candidate.type === null)
    .sort((left, right) => right.start - left.start)) {
    topLevel =
      topLevel.slice(0, method.start) +
      " ".repeat(method.end - method.start) +
      topLevel.slice(method.end);
  }
  return topLevel
    .replace(/\b(?:global\s+)?using\s+[^;]+;/g, " ")
    .replace(/\bnamespace\s+[\w.]+\s*;/g, " ")
    .trim() !== "";
}

function applicationProjects(workspace) {
  const projects = Array.isArray(workspace.projects)
    ? workspace.projects
    : [{
        project: workspace.project ?? "",
        source: workspace.source ?? "",
        sourceFiles: workspace.sourceFiles ?? [],
      }];
  return projects.filter(
    ({ project, source, sourceFiles }) =>
      validManifest(project) &&
      source?.trim() &&
      (sourceFiles?.length ?? 0) > 0 &&
      hasEntryPoint(source),
  );
}

function constructorBindings(source, type) {
  const results = [];
  const patterns = [
    new RegExp(
      String.raw`\b(?:using\s+)?Sdk${type}\s+(\w+)\s*=\s*new(?:\s+Sdk${type})?\s*\(`,
      "g",
    ),
    new RegExp(
      String.raw`\b(?:using\s+)?var\s+(\w+)\s*=\s*new\s+Sdk${type}\s*\(`,
      "g",
    ),
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const open = source.indexOf("(", match.index + match[0].length - 1);
      const close = matchingDelimiter(source, open, "(", ")");
      if (close >= 0) {
        results.push({
          arguments: source.slice(open + 1, close),
          end: close + 1,
          name: match[1],
          start: match.index,
        });
      }
    }
  }
  return results;
}

function addAliases(source, sets) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(
      /\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*(\w+)\s*;/g,
    )) {
      for (const values of sets) {
        if (values.has(match[2]) && !values.has(match[1])) {
          values.add(match[1]);
          changed = true;
        }
      }
    }
  }
}

function analyzeResourceBindings(source) {
  const clients = new Set(
    constructorBindings(source, "CosmosClient").map(({ name }) => name),
  );
  const databases = new Set();
  const containers = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    addAliases(source, [clients, databases, containers]);
    for (const match of source.matchAll(
      /\b(?:var|SdkDatabase|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*(\w+)\s*\.\s*GetDatabase\s*\(/g,
    )) {
      if (clients.has(match[2]) && !databases.has(match[1])) {
        databases.add(match[1]);
        changed = true;
      }
    }
    for (const match of source.matchAll(
      /\b(?:var|SdkContainer|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*(\w+)\s*\.\s*GetContainer\s*\(/g,
    )) {
      if (
        (clients.has(match[2]) || databases.has(match[2])) &&
        !containers.has(match[1])
      ) {
        containers.add(match[1]);
        changed = true;
      }
    }
    for (const match of source.matchAll(
      /\b(?:var|SdkContainer|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*(\w+)\s*\.\s*GetDatabase\s*\([^;]+?\)\s*\.\s*GetContainer\s*\(/g,
    )) {
      if (clients.has(match[2]) && !containers.has(match[1])) {
        containers.add(match[1]);
        changed = true;
      }
    }
  }
  return { clients, containers };
}

function withParameters(expression, literals) {
  const parameters = new Map();
  for (const match of expression.matchAll(/\.WithParameter\s*\(/g)) {
    const open = expression.indexOf("(", match.index);
    const close = matchingDelimiter(expression, open, "(", ")");
    if (close < 0) continue;
    const args = splitArguments(expression.slice(open + 1, close));
    const name = literalValue(args[0] ?? "", literals);
    const value = literalValue(args[1] ?? "", literals);
    if (name !== null && value !== null) parameters.set(name, value);
  }
  return parameters;
}

function queryFromExpression(expression, queryDefinitions, literals) {
  const trimmed = expression.trim();
  if (/^\w+$/.test(trimmed)) return queryDefinitions.get(trimmed) ?? null;
  const constructor = /\bnew(?:\s+SdkQueryDefinition)?\s*\(/.exec(trimmed);
  if (!constructor) return null;
  const open = trimmed.indexOf("(", constructor.index);
  const close = matchingDelimiter(trimmed, open, "(", ")");
  if (close < 0) return null;
  const sql = literalValue(trimmed.slice(open + 1, close), literals);
  return sql === null
    ? null
    : { sql, parameters: withParameters(trimmed.slice(close + 1), literals) };
}

function analyzeQueryDefinitions(source, literals) {
  const definitions = new Map();
  for (const binding of constructorBindings(source, "QueryDefinition")) {
    const sql = literalValue(binding.arguments, literals);
    if (sql === null) continue;
    const statementEnd = source.indexOf(";", binding.end);
    const tail = source.slice(
      binding.end,
      statementEnd < 0 ? binding.end : statementEnd,
    );
    definitions.set(binding.name, {
      sql,
      parameters: withParameters(tail, literals),
    });
  }
  for (const match of source.matchAll(/\b(\w+)\s*\.\s*WithParameter\s*\(/g)) {
    const definition = definitions.get(match[1]);
    if (!definition) continue;
    const open = source.indexOf("(", match.index);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close < 0) continue;
    const args = splitArguments(source.slice(open + 1, close));
    const name = literalValue(args[0] ?? "", literals);
    const value = literalValue(args[1] ?? "", literals);
    if (name !== null && value !== null) {
      definition.parameters.set(name, value);
    }
  }
  addAliases(source, [new Set(definitions.keys())]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(
      /\b(?:var|SdkQueryDefinition)\s+(\w+)\s*=\s*(\w+)\s*;/g,
    )) {
      if (definitions.has(match[2]) && !definitions.has(match[1])) {
        definitions.set(match[1], definitions.get(match[2]));
        changed = true;
      }
    }
  }
  return definitions;
}

function validCategoryQuery(query) {
  if (!query) return false;
  const match =
    /\bSELECT\s+\*\s+FROM\s+([A-Za-z_]\w*)\s+WHERE\s+\1\s*\.\s*category\s*=\s*(?:\(\s*)?(@[A-Za-z_]\w*|'electronics')/i.exec(
      query.sql,
    );
  if (!match) return false;
  if (match[2].toLowerCase() === "'electronics'") return true;
  const parameter = [...query.parameters.entries()].find(
    ([name]) => name.toLowerCase() === match[2].toLowerCase(),
  );
  return parameter?.[1].toLowerCase() === "electronics";
}

function analyzeOptions(source) {
  const options = new Set();
  for (const match of source.matchAll(
    /\b(?:var|SdkQueryRequestOptions)\s+(\w+)\s*=\s*new(?:\s+SdkQueryRequestOptions)?(?:\s*\(\s*\))?\s*\{([\s\S]*?)\}/g,
  )) {
    if (/\bMaxItemCount\s*=\s*50\b/.test(match[2])) {
      options.add(match[1]);
    }
  }
  for (const binding of constructorBindings(source, "QueryRequestOptions")) {
    const statementEnd = source.indexOf(";", binding.end);
    const statement = source.slice(
      binding.start,
      statementEnd < 0 ? binding.end : statementEnd,
    );
    if (/\bMaxItemCount\s*=\s*50\b/.test(statement)) {
      options.add(binding.name);
    }
  }
  for (const match of source.matchAll(
    /\b(\w+)\s*\.\s*MaxItemCount\s*=\s*50\s*;/g,
  )) {
    options.add(match[1]);
  }
  addAliases(source, [options]);
  return options;
}

function pageSizeIs50(expression, options) {
  return (
    [...options].some((name) =>
      new RegExp(String.raw`\b${escapeRegExp(name)}\b`).test(expression)
    ) ||
    /\bnew\s+SdkQueryRequestOptions\b[\s\S]*?\{[\s\S]*?\bMaxItemCount\s*=\s*50\b[\s\S]*?\}/.test(
      expression,
    )
  );
}

function argumentValue(args, names, position) {
  for (const argument of args.map(namedArgument)) {
    if (argument.name && names.includes(argument.name)) {
      return argument.expression;
    }
  }
  const positional = args.map(namedArgument).filter(({ name }) => name === null);
  return positional[position]?.expression ?? "";
}

function iteratorBindings(
  source,
  resources,
  queryDefinitions,
  options,
  literals,
) {
  const iterators = [];
  const pattern =
    /\b(?:using\s+)?(?:var|SdkFeedIterator\s*<[^;=]+>)\s+(\w+)\s*=\s*(\w+)\s*\.\s*GetItemQueryIterator(?:\s*<[^;{}()]+>)?\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    if (!resources.containers.has(match[2])) continue;
    const open = source.indexOf("(", match.index + match[0].length - 1);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close < 0) continue;
    const args = splitArguments(source.slice(open + 1, close));
    const queryExpression = argumentValue(
      args,
      ["querydefinition", "querytext"],
      0,
    );
    const continuationExpression = argumentValue(
      args,
      ["continuationtoken"],
      1,
    );
    const optionsExpression = argumentValue(
      args,
      ["requestoptions"],
      2,
    );
    const query = queryFromExpression(
      queryExpression,
      queryDefinitions,
      literals,
    );
    iterators.push({
      continuationExpression,
      end: close + 1,
      name: match[1],
      pageSize50: pageSizeIs50(optionsExpression, options),
      query,
      queryValid: validCategoryQuery(query),
      start: match.index,
    });
  }
  return iterators;
}

function consoleUses(source, expressions) {
  for (const match of source.matchAll(
    /\bConsole\s*(?:\.\s*(?:Out|Error))?\s*\.\s*Write(?:Line)?\s*\(/g,
  )) {
    const open = source.indexOf("(", match.index);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close < 0) continue;
    const argument = source.slice(open + 1, close);
    if (
      expressions.some((expression) =>
        new RegExp(String.raw`\b${escapeRegExp(expression)}\b`).test(argument)
      )
    ) {
      return true;
    }
  }
  return false;
}

function aliasesForProperty(source, object, property) {
  const aliases = new Set();
  const expressions = new Set([`${object}.${property}`]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of [
      /\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*([^;]+);/g,
      /(?<![\w.])(\w+)\s*=\s*([^=;][^;]*);/g,
    ]) {
      for (const match of source.matchAll(pattern)) {
        if (
          [...expressions].some((expression) =>
            new RegExp(
              String.raw`\b${escapeRegExp(expression).replaceAll("\\.", "\\s*\\.\\s*")}\b`,
            ).test(match[2])
          ) &&
          !aliases.has(match[1])
        ) {
          aliases.add(match[1]);
          expressions.add(match[1]);
          changed = true;
        }
      }
    }
  }
  return aliases;
}

function helperReturnsExternalToken(
  method,
  argumentsSource,
  externalTokens,
) {
  const externalParameters = new Set();
  method.parameters.forEach((parameter, index) => {
    if (
      argumentsSource[index] &&
      expressionUsesBinding(argumentsSource[index], externalTokens)
    ) {
      externalParameters.add(parameter);
    }
  });
  if (externalParameters.size === 0) return false;

  const returns = [...method.body.matchAll(/\breturn\s+([^;]+);/g)]
    .map((match) => match[1].trim())
    .filter((expression) => !/^(?:null|default(?:\s*\(\s*\))?)$/i.test(expression));
  return (
    returns.length > 0 &&
    returns.every((expression) =>
      expressionUsesBinding(expression, externalParameters)
    )
  );
}

function externalTokenBindings(source, methods) {
  const tokens = new Set(["args"]);
  for (const match of source.matchAll(
    /\b(?:var|string\??)\s+(\w+)\s*=\s*([^;]+);/g,
  )) {
    if (
      /\bargs\s*\[|\bEnvironment\s*\.\s*GetEnvironmentVariable\s*\(|\bFile\s*\.\s*ReadAllText|\bConsole\s*\.\s*ReadLine\s*\(/.test(
        match[2],
      )
    ) {
      tokens.add(match[1]);
    }
  }
  let changed = true;
  while (changed) {
    const before = tokens.size;
    addAliases(source, [tokens]);
    for (const match of source.matchAll(
      /\b(?:var|string\??)\s+(\w+)\s*=\s*(\w+)\s*\(([^;]*)\)\s*;/g,
    )) {
      const argumentsSource = splitArguments(match[3]);
      if (
        methods.some(
          (method) =>
            method.name === match[2] &&
            methodAccepts(method, argumentsSource) &&
            helperReturnsExternalToken(method, argumentsSource, tokens),
        )
      ) {
        tokens.add(match[1]);
      }
    }
    changed = tokens.size !== before;
  }
  return tokens;
}

function expressionUsesBinding(expression, bindings) {
  return [...bindings].some((name) =>
    new RegExp(String.raw`\b${escapeRegExp(name)}\b`).test(expression)
  );
}

function initializedBefore(source, name, position) {
  const prefix = source.slice(Math.max(0, position - 4000), position);
  return new RegExp(
    String.raw`\b(?:double|decimal|float|var)\s+${escapeRegExp(name)}\s*=\s*(?:0(?:\.0+)?[dDfFmM]?|default)\s*;`,
  ).test(prefix);
}

function requestChargeTracking(source, methods, loop, page) {
  const body = expandInvocations(loop.body, methods);
  const aliases = aliasesForProperty(body, page, "RequestCharge");
  const charges = [
    `${page}.RequestCharge`,
    ...aliases,
  ];
  const accumulators = new Set();
  for (const charge of charges) {
    const escaped = escapeRegExp(charge).replaceAll("\\.", "\\s*\\.\\s*");
    for (const match of body.matchAll(
      new RegExp(
        String.raw`\b(\w+)\s*\+=\s*${escaped}\b|\b(\w+)\s*=\s*(?:\2\s*\+\s*${escaped}|${escaped}\s*\+\s*\2)\b`,
        "g",
      ),
    )) {
      accumulators.add(match[1] ?? match[2]);
    }
  }

  const suffix = source.slice(loop.end, loop.end + 3000);
  for (const accumulator of accumulators) {
    if (
      initializedBefore(source, accumulator, loop.start) &&
      (
        consoleUses(suffix, [accumulator]) ||
        new RegExp(
          String.raw`\breturn\s+(?:new\s+\w+\s*\([^;]*\b)?${escapeRegExp(accumulator)}\b`,
        ).test(suffix)
      )
    ) {
      return true;
    }
  }

  for (const charge of charges) {
    const escaped = escapeRegExp(charge).replaceAll("\\.", "\\s*\\.\\s*");
    for (const match of body.matchAll(
      new RegExp(String.raw`\b(\w+)\s*\.\s*Add\s*\(\s*${escaped}\s*\)`, "g"),
    )) {
      const collection = match[1];
      if (
        new RegExp(
          String.raw`\b${escapeRegExp(collection)}\s*\.\s*Sum\s*\(\s*\)`,
        ).test(suffix)
      ) {
        return true;
      }
    }
  }
  return false;
}

function loopForIterator(source, methods, iterator) {
  for (const match of source.matchAll(/\b(?:while|for)\s*\(/g)) {
    const headerOpen = source.indexOf("(", match.index);
    const headerClose = matchingDelimiter(source, headerOpen, "(", ")");
    if (headerClose < 0) continue;
    const condition = source.slice(headerOpen + 1, headerClose);
    if (
      !new RegExp(
        String.raw`\b${escapeRegExp(iterator.name)}\s*\.\s*HasMoreResults\b`,
      ).test(condition)
    ) {
      continue;
    }
    let bodyOpen = headerClose + 1;
    while (/\s/.test(source[bodyOpen] ?? "")) bodyOpen += 1;
    if (source[bodyOpen] !== "{") continue;
    const bodyClose = matchingDelimiter(source, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    const body = source.slice(bodyOpen + 1, bodyClose);
    const pagePattern = new RegExp(
      String.raw`\b(?:var|SdkFeedResponse\s*<[^;=]+>)\s+(\w+)\s*=\s*await\s+${escapeRegExp(iterator.name)}\s*\.\s*ReadNextAsync\s*\(`,
    );
    const page = pagePattern.exec(body)?.[1];
    if (!page) continue;
    const expandedBody = expandInvocations(body, methods);
    const continuationAliases = aliasesForProperty(
      expandedBody,
      page,
      "ContinuationToken",
    );
    const continuationExpressions = [
      `${page}.ContinuationToken`,
      ...continuationAliases,
    ];
    return {
      body,
      end: bodyClose + 1,
      page,
      printsContinuation: consoleUses(
        expandedBody,
        continuationExpressions,
      ),
      requestChargeTotal: requestChargeTracking(
        source,
        methods,
        {
          body,
          end: bodyClose + 1,
          start: match.index,
        },
        page,
      ),
      start: match.index,
      tokenBindings: continuationAliases,
    };
  }
  return null;
}

function analyzeProject(project) {
  const literalAware = literalAwareCode(project.source);
  const normalized = normalizeSdkTypes(literalAware.code);
  if (normalized === null) return null;
  const reachable = reachableSource(normalized);
  const resources = analyzeResourceBindings(reachable.source);
  const queryDefinitions = analyzeQueryDefinitions(
    reachable.source,
    literalAware.literals,
  );
  const options = analyzeOptions(reachable.source);
  const externalTokens = externalTokenBindings(
    reachable.source,
    reachable.methods,
  );
  const workflows = iteratorBindings(
    reachable.source,
    resources,
    queryDefinitions,
    options,
    literalAware.literals,
  ).map((iterator) => ({
    ...iterator,
    loop: loopForIterator(reachable.source, reachable.methods, iterator),
  }));

  for (const workflow of workflows) {
    workflow.resumes =
      workflow.continuationExpression.trim() !== "" &&
      !/^(?:null|default(?:\s*\(\s*\))?)$/i.test(
        workflow.continuationExpression.trim(),
      ) &&
      (
        expressionUsesBinding(
          workflow.continuationExpression,
          externalTokens,
        ) ||
        workflows.some(
          (candidate) =>
            candidate !== workflow &&
            candidate.query?.sql === workflow.query?.sql &&
            candidate.loop &&
            candidate.loop.end < workflow.start &&
            expressionUsesBinding(
              workflow.continuationExpression,
              candidate.loop.tokenBindings,
            ),
        )
      );
  }
  return { workflows };
}

function coreWorkflow(workflow) {
  return workflow.queryValid && workflow.pageSize50 && workflow.loop !== null;
}

const rules = {
  "prompt/cosmos-manifest": () => true,
  "prompt/category-query": ({ workflows }) =>
    workflows.some(({ queryValid }) => queryValid),
  "prompt/page-size": ({ workflows }) =>
    workflows.some(
      (workflow) => workflow.queryValid && workflow.pageSize50,
    ),
  "prompt/feed-pagination": ({ workflows }) =>
    workflows.some((workflow) => coreWorkflow(workflow)),
  "prompt/continuation-resume": ({ workflows }) =>
    workflows.some(
      (workflow) =>
        coreWorkflow(workflow) &&
        workflow.loop.printsContinuation &&
        workflow.resumes,
    ),
  "prompt/request-charge-total": ({ workflows }) =>
    workflows.some(
      (workflow) =>
        coreWorkflow(workflow) && workflow.loop.requestChargeTotal,
    ),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const projects = applicationProjects(workspace);
  if (projects.length === 0) return false;
  if (name === "prompt/cosmos-manifest") return true;
  return projects.some((project) => {
    const analysis = analyzeProject(project);
    return analysis !== null && Boolean(rule(analysis));
  });
}

export function ruleNames() {
  return Object.keys(rules);
}

const ignoredDirectories = new Set([
  ".git",
  ".vally",
  "bin",
  "node_modules",
  "obj",
]);

function ignoredDirectory(name) {
  const value = name.toLowerCase();
  return ignoredDirectories.has(value) || /(?:^|[._-])tests?$/.test(value);
}

export function loadWorkspace(root) {
  const rootPath = resolve(root);
  const sourcePaths = [];
  const projectPaths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectory(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.toLowerCase().endsWith(".cs")) sourcePaths.push(path);
      else if (entry.name.toLowerCase().endsWith(".csproj")) {
        projectPaths.push(path);
      }
    }
  };
  visit(rootPath);

  const projects = projectPaths.sort().map((path) => {
    const directory = dirname(path);
    const nestedProjectDirectories = projectPaths
      .filter(
        (candidate) =>
          candidate !== path &&
          relative(directory, dirname(candidate))
            .replaceAll("\\", "/")
            .match(/^(?!\.\.)(?!$)/),
      )
      .map((candidate) => dirname(candidate));
    const ownedSources = sourcePaths.filter((sourcePath) => {
      const relation = relative(directory, sourcePath).replaceAll("\\", "/");
      return (
        relation !== ".." &&
        !relation.startsWith("../") &&
        !nestedProjectDirectories.some((nested) => {
          const nestedRelation = relative(nested, sourcePath)
            .replaceAll("\\", "/");
          return nestedRelation !== ".." && !nestedRelation.startsWith("../");
        })
      );
    });
    return {
      path: relative(rootPath, path).replaceAll("\\", "/"),
      project: readFileSync(path, "utf8"),
      source: ownedSources
        .sort()
        .map((sourcePath) => readFileSync(sourcePath, "utf8"))
        .join("\n"),
      sourceFiles: ownedSources.map((sourcePath) =>
        relative(rootPath, sourcePath).replaceAll("\\", "/")
      ),
    };
  });
  return {
    projects,
    projectFiles: projectPaths,
    sourceFiles: [...new Set(projects.flatMap(({ sourceFiles }) => sourceFiles))],
    project: projects.map(({ project }) => project).join("\n"),
    source: projects.map(({ source }) => source).filter(Boolean).join("\n"),
  };
}
