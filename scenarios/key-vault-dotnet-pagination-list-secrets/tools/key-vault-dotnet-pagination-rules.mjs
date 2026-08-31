import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const identityPackageVersion = "1.21.0";
const secretsPackageVersion = "4.11.0";
const sdkTypeNamespaces = new Map([
  ["AsyncPageable", "Azure"],
  ["DefaultAzureCredential", "Azure.Identity"],
  ["Page", "Azure"],
  ["Pageable", "Azure"],
  ["RequestFailedException", "Azure"],
  ["SecretClient", "Azure.Security.KeyVault.Secrets"],
  ["SecretProperties", "Azure.Security.KeyVault.Secrets"],
]);
const sdkTypes = [...sdkTypeNamespaces.keys()];

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
    /\b((?:(?:public|private|protected|internal|static|async|virtual|sealed|new|unsafe)\s+)*)((?:(?:(?:global::)?System\.Threading\.Tasks\.)?Task(?:\s*<[^>{}]+>)?|ValueTask(?:\s*<[^>{}]+>)?|void|int|string|bool|[A-Z]\w*(?:\s*<[^>{}]+>)?))\s+(\w+)\s*\(([^;{}]*)\)\s*\{/g;

  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf("{", match.index);
    const close = matchingDelimiter(source, open, "{", "}");
    if (close < 0) continue;
    const parameterSources = splitArguments(match[4]);
    methods.push({
      modifiers: match[1].trim().split(/\s+/).filter(Boolean),
      returnType: match[2].replace(/\s+/g, ""),
      name: match[3],
      parameterSources,
      parameters: parameterSources
        .map((parameter) =>
          /(?:^|\s)(\w+)\s*(?:=[\s\S]*)?$/.exec(parameter.trim())?.[1]
        )
        .filter(Boolean),
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
    const suffix = [...key].reduce(
      (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
      0,
    );
    let body = withoutDeadCode(method.body);
    const bindings = [];
    method.parameters.forEach((parameter, index) => {
      if (!argumentsSource[index]) return;
      const localName = `__vally_${suffix}_${parameter}`;
      body = body.replace(
        new RegExp(String.raw`\b${escapeRegExp(parameter)}\b`, "g"),
        localName,
      );
      bindings.push(`var ${localName} = ${argumentsSource[index]};`);
    });
    const expanded = `${bindings.join("\n")}\n${body}`;
    output.push(expandInvocations(expanded, methods, new Set(seen).add(key)));
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

function normalizeSdkTypes(source) {
  const code = dotnetCodeOnly(source);
  for (const [type, namespace] of sdkTypeNamespaces) {
    const namespacePattern = escapeRegExp(namespace).replaceAll("\\.", "\\s*\\.\\s*");
    if (
      new RegExp(String.raw`\bnamespace\s+${namespacePattern}\b`).test(code) &&
      new RegExp(
        String.raw`\b(?:class|record|struct|interface|enum)\s+${type}\b`,
      ).test(code)
    ) {
      return null;
    }
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
    if ([...sdkTypeNamespaces.values()].includes(target)) {
      for (const [type, namespace] of sdkTypeNamespaces) {
        if (namespace !== target) continue;
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
      target === `${sdkTypeNamespaces.get(simple)}.${simple}`
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
    const namespacePattern = escapeRegExp(sdkTypeNamespaces.get(type))
      .replaceAll("\\.", "\\s*\\.\\s*");
    normalized = normalized.replace(
      new RegExp(
        String.raw`(?<![\w.])(?:global::)?${namespacePattern}\s*\.\s*${type}\b`,
        "g",
      ),
      `Sdk${type}`,
    );
  }
  for (const type of sdkTypes) {
    normalized = normalized.replace(
      new RegExp(String.raw`(?<![\w.])${type}\b`, "g"),
      imports.has(sdkTypeNamespaces.get(type)) && !localTypes.has(type)
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

function projectProperties(source) {
  const properties = new Map();
  for (const group of source.matchAll(
    /<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup\s*>/gi,
  )) {
    if (/\bCondition\s*=\s*["']\s*false\s*["']/i.test(group[1])) continue;
    for (const property of group[2].matchAll(
      /<([A-Za-z_][\w.-]*)\b([^>]*)>([^<]*)<\/\1\s*>/g,
    )) {
      if (!/\bCondition\s*=\s*["']\s*false\s*["']/i.test(property[2])) {
        properties.set(property[1].toLowerCase(), property[3].trim());
      }
    }
  }
  return properties;
}

function resolveProjectValue(value, properties) {
  let result = value?.trim();
  if (!result) return result;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    let unresolved = false;
    const next = result.replace(/\$\(([^)]+)\)/g, (match, name) => {
      const replacement = properties.get(name.toLowerCase());
      if (replacement === undefined) {
        unresolved = true;
        return match;
      }
      return replacement;
    });
    result = next;
    if (!unresolved && !/\$\([^)]+\)/.test(result)) return result;
    if (next === value) break;
    value = next;
  }
  return /\$\([^)]+\)/.test(result) ? null : result;
}

function validManifest(project) {
  const source = activeProject(project);
  const properties = projectProperties(source);
  const target = resolveProjectValue(
    /<TargetFramework\b[^>]*>\s*([^<]+)\s*<\/TargetFramework>/i.exec(
      source,
    )?.[1] ??
    /<TargetFrameworks\b[^>]*>\s*([^<]+)\s*<\/TargetFrameworks>/i.exec(
      source,
    )?.[1] ??
    "",
    properties,
  ) ?? "";
  if (
    !/<Project\b[^>]*\bSdk\s*=\s*["']Microsoft\.NET\.Sdk["']/i.test(source) ||
    !/<OutputType\b[^>]*>\s*Exe\s*<\/OutputType>/i.test(source) ||
    !target.split(";").some((value) =>
      /^net8\.0(?:-[a-z][a-z0-9]*(?:\.[0-9]+)*)?$/i.test(value.trim())
    )
  ) {
    return false;
  }

  const references = [];
  for (const itemGroup of source.matchAll(
    /<ItemGroup\b([^>]*)>([\s\S]*?)<\/ItemGroup\s*>/gi,
  )) {
    if (/\bCondition\s*=\s*["']\s*false\s*["']/i.test(itemGroup[1])) continue;
    for (const reference of itemGroup[2].matchAll(
      /<PackageReference\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/PackageReference\s*>)/gi,
    )) {
      if (/\bCondition\s*=\s*["']\s*false\s*["']/i.test(reference[1])) continue;
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
      references.push({
        include: resolveProjectValue(include, properties)?.toLowerCase(),
        usable: !exclude.split(";").map((value) => value.trim().toLowerCase())
          .some((value) => value === "all" || value === "compile"),
        version: resolveProjectValue(version, properties),
      });
    }
  }
  const exact = (name, version) => {
    const matches = references.filter(
      ({ include }) => include === name.toLowerCase(),
    );
    return (
      matches.length > 0 &&
      matches.every(
        (reference) =>
          reference.usable &&
          [version, `[${version}]`].includes(reference.version),
      )
    );
  };
  return (
    exact("Azure.Identity", identityPackageVersion) &&
    exact("Azure.Security.KeyVault.Secrets", secretsPackageVersion)
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
    .replace(/^\s*#.*$/gm, " ")
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
      String.raw`\bSdk${type}\s+(\w+)\s*=\s*new(?:\s+Sdk${type})?\s*\(`,
      "g",
    ),
    new RegExp(
      String.raw`\bvar\s+(\w+)\s*=\s*new\s+Sdk${type}\s*\(`,
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
          name: match[1],
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

function configuredClients(source) {
  const credentials = new Set(
    constructorBindings(source, "DefaultAzureCredential").map(
      ({ name }) => name,
    ),
  );
  const clients = new Set();
  for (const client of constructorBindings(source, "SecretClient")) {
    if (
      splitArguments(client.arguments).some(
        (argument) =>
          credentials.has(argument.trim()) ||
          /\bnew\s+SdkDefaultAzureCredential\s*\(/.test(argument),
      )
    ) {
      clients.add(client.name);
    }
  }
  addAliases(source, [credentials, clients]);
  return clients;
}

function pageableBindings(source, clients) {
  const asyncPageables = new Set();
  const syncPageables = new Set();
  for (const match of source.matchAll(
    /\b(?:var|SdkAsyncPageable\s*<[^;=]+>)\s+(\w+)\s*=\s*(\w+)\s*\.\s*GetPropertiesOfSecretsAsync\s*\(/g,
  )) {
    if (clients.has(match[2])) asyncPageables.add(match[1]);
  }
  for (const match of source.matchAll(
    /\b(?:var|SdkPageable\s*<[^;=]+>)\s+(\w+)\s*=\s*(\w+)\s*\.\s*GetPropertiesOfSecrets\s*\(/g,
  )) {
    if (clients.has(match[2])) syncPageables.add(match[1]);
  }
  addAliases(source, [asyncPageables, syncPageables]);
  return { asyncPageables, syncPageables };
}

function expressionUses(values, expression) {
  return [...values].some((value) =>
    new RegExp(String.raw`\b${escapeRegExp(value)}\b`).test(expression)
  );
}

function directClientCall(expression, clients, method) {
  return [...clients].some((client) =>
    new RegExp(
      String.raw`\b${escapeRegExp(client)}\s*\.\s*${method}\s*\(`,
    ).test(expression)
  );
}

function positivePageSizeHint(expression) {
  const match = /\.AsPages\s*\(/.exec(expression);
  if (!match) return false;
  const open = expression.indexOf("(", match.index);
  const close = matchingDelimiter(expression, open, "(", ")");
  if (close < 0) return false;
  const args = splitArguments(expression.slice(open + 1, close));
  const named = args.find((argument) => /^\s*pageSizeHint\s*:/.test(argument));
  const value = named?.replace(/^\s*pageSizeHint\s*:\s*/, "") ?? args[1];
  return Boolean(
    value &&
    !/^(?:0|null|default(?:\s*\(\s*\))?)$/i.test(value.trim()),
  );
}

function loopsIn(source) {
  const loops = [];
  for (const match of source.matchAll(/\b(await\s+)?foreach\s*\(/g)) {
    const headerOpen = source.indexOf("(", match.index);
    const headerClose = matchingDelimiter(source, headerOpen, "(", ")");
    if (headerClose < 0) continue;
    let bodyOpen = headerClose + 1;
    while (/\s/.test(source[bodyOpen] ?? "")) bodyOpen += 1;
    if (source[bodyOpen] !== "{") continue;
    const bodyClose = matchingDelimiter(source, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    const header = source.slice(headerOpen + 1, headerClose);
    const binding = /(?:^|\s)(\w+)\s+in\s+([\s\S]+)$/.exec(header);
    if (!binding) continue;
    loops.push({
      async: Boolean(match[1]),
      body: source.slice(bodyOpen + 1, bodyClose),
      end: bodyClose + 1,
      expression: binding[2].trim(),
      item: binding[1],
      start: match.index,
    });
  }
  return loops;
}

function itemBodies(flow, methods) {
  const body = expandInvocations(flow.body, methods);
  if (!flow.pages) return [{ body, item: flow.item }];
  const values = new RegExp(
    String.raw`\b${escapeRegExp(flow.item)}\s*\.\s*Values\b`,
  );
  return loopsIn(body)
    .filter((loop) => !loop.async && values.test(loop.expression))
    .map((loop) => ({
      body: expandInvocations(loop.body, methods),
      item: loop.item,
    }));
}

function consoleArguments(source) {
  const result = [];
  for (const match of source.matchAll(
    /\bConsole\s*(?:\.\s*(?:Out|Error))?\s*\.\s*Write(?:Line)?\s*\(/g,
  )) {
    const open = source.indexOf("(", match.index);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close >= 0) result.push(source.slice(open + 1, close));
  }
  return result;
}

function propertyExpressions(source, item, property) {
  const items = new Set([item]);
  addAliases(source, [items]);
  const expressions = new Set(
    [...items].map((name) => `${name}.${property}`),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(
      /\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*([^;]+);/g,
    )) {
      if (
        [...expressions].some((expression) =>
          new RegExp(
            String.raw`\b${escapeRegExp(expression).replaceAll("\\.", "\\s*\\.\\s*")}\b`,
          ).test(match[2])
        ) &&
        !expressions.has(match[1])
      ) {
        expressions.add(match[1]);
        changed = true;
      }
    }
  }
  return expressions;
}

function printsProperties(itemBody) {
  const output = consoleArguments(itemBody.body).join("\n");
  return ["Name", "ContentType", "Enabled", "CreatedOn"].every((property) =>
    expressionUses(
      propertyExpressions(itemBody.body, itemBody.item, property),
      output,
    )
  );
}

function handlesDisabled(itemBody) {
  const items = new Set([itemBody.item]);
  addAliases(itemBody.body, [items]);
  return [...items].some((item) => {
    const enabled =
      `${escapeRegExp(item)}\\s*\\.\\s*Enabled`;
    return (
      new RegExp(
        String.raw`\bif\s*\([^)]*(?:!\s*${enabled}\b|${enabled}\s*(?:==|!=|is)\s*(?:false|true|null))`,
      ).test(itemBody.body) ||
      new RegExp(
        String.raw`\b${enabled}\s*(?:(?:==|!=|is)\s*(?:false|true|null)\s*)?\?`,
      ).test(itemBody.body) ||
      new RegExp(
        String.raw`(?:\bswitch\s*\(\s*${enabled}\s*\)|\b${enabled}\s+switch\s*\{)`,
      ).test(itemBody.body)
    );
  });
}

function analyzeFlows(source, methods, clients) {
  const pageables = pageableBindings(source, clients);
  return loopsIn(source).flatMap((loop) => {
    const pages = /\.AsPages\s*\(/.test(loop.expression);
    const asyncOrigin =
      directClientCall(
        loop.expression,
        clients,
        "GetPropertiesOfSecretsAsync",
      ) ||
      expressionUses(pageables.asyncPageables, loop.expression);
    const syncOrigin =
      directClientCall(loop.expression, clients, "GetPropertiesOfSecrets") ||
      expressionUses(pageables.syncPageables, loop.expression);
    let kind = null;
    if (loop.async && asyncOrigin && pages && positivePageSizeHint(loop.expression)) {
      kind = "async-pages";
    } else if (loop.async && asyncOrigin && !pages) {
      kind = "async-items";
    } else if (!loop.async && syncOrigin) {
      kind = "sync";
    }
    if (kind === null) return [];
    const flow = { ...loop, kind, pages };
    const itemEvidence = itemBodies(flow, methods);
    return [{
      ...flow,
      disabled: itemEvidence.length > 0 && itemEvidence.every(handlesDisabled),
      prints: itemEvidence.length > 0 && itemEvidence.every(printsProperties),
    }];
  });
}

function catchesAfter(source, tryClose) {
  const catches = [];
  let cursor = tryClose + 1;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    const header = /^catch\s*\(([^)]*)\)(?:\s*when\s*\(([^)]*)\))?\s*\{/.exec(
      source.slice(cursor),
    );
    if (!header) break;
    const open = cursor + header[0].lastIndexOf("{");
    const close = matchingDelimiter(source, open, "{", "}");
    if (close < 0) break;
    const direct =
      /^\s*SdkRequestFailedException\s+(\w+)\s*$/.exec(header[1]);
    const filtered =
      /\bis\s+SdkRequestFailedException\s+(\w+)\b/.exec(header[2] ?? "");
    if (direct || filtered) {
      catches.push({
        body: source.slice(open + 1, close),
        variable: (direct ?? filtered)[1],
      });
    }
    cursor = close + 1;
  }
  return catches;
}

function usefulCatch(caught, methods) {
  const expanded = expandInvocations(caught.body, methods);
  const aliases = new Set([caught.variable]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of expanded.matchAll(
      /\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*(\w+)\s*;/g,
    )) {
      if (aliases.has(match[2]) && !aliases.has(match[1])) {
        aliases.add(match[1]);
        changed = true;
      }
    }
  }
  return (
    [...aliases].some((name) =>
      new RegExp(
        String.raw`\b${escapeRegExp(name)}\s*\.\s*Status\b`,
      ).test(expanded)
    ) &&
    [...aliases].some((name) =>
      new RegExp(
        String.raw`\b${escapeRegExp(name)}\s*\.\s*(?:ErrorCode|Message)\b`,
      ).test(expanded)
    ) &&
    (
      consoleArguments(expanded).length > 0 ||
      /\bthrow\b/.test(expanded)
    )
  );
}

function paginationIsHandled(source, methods, clients) {
  const protectedKinds = new Set();
  for (const match of source.matchAll(/\btry\s*\{/g)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(source, open, "{", "}");
    if (close < 0) continue;
    const expanded = expandInvocations(source.slice(open + 1, close), methods);
    const kinds = new Set(
      analyzeFlows(expanded, methods, clients).map(({ kind }) => kind),
    );
    if (catchesAfter(source, close).some((caught) => usefulCatch(caught, methods))) {
      for (const kind of kinds) protectedKinds.add(kind);
    }
  }
  return ["async-items", "async-pages", "sync"].every((kind) =>
    protectedKinds.has(kind)
  );
}

function analyzeProject(project) {
  const normalized = normalizeSdkTypes(project.source);
  if (normalized === null) return null;
  const reachable = reachableSource(normalized);
  const clients = configuredClients(reachable.source);
  return {
    clients,
    flows: analyzeFlows(reachable.source, reachable.methods, clients),
    methods: reachable.methods,
    source: reachable.source,
  };
}

function hasKinds(analysis) {
  const kinds = new Set(analysis.flows.map(({ kind }) => kind));
  return ["async-items", "async-pages", "sync"].every((kind) =>
    kinds.has(kind)
  );
}

const rules = {
  "prompt/key-vault-manifest": () => true,
  "prompt/configured-secret-client": ({ clients }) => clients.size > 0,
  "prompt/async-item-iteration": ({ flows }) =>
    flows.some(({ kind }) => kind === "async-items"),
  "prompt/async-page-iteration": ({ flows }) =>
    flows.some(({ kind }) => kind === "async-pages"),
  "prompt/sync-iteration": ({ flows }) =>
    flows.some(({ kind }) => kind === "sync"),
  "prompt/secret-properties-output": (analysis) =>
    hasKinds(analysis) && analysis.flows.every(({ prints }) => prints),
  "prompt/disabled-secret-handling": (analysis) =>
    hasKinds(analysis) && analysis.flows.every(({ disabled }) => disabled),
  "prompt/pagination-error-handling": (analysis) =>
    paginationIsHandled(analysis.source, analysis.methods, analysis.clients),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const projects = applicationProjects(workspace);
  if (projects.length === 0) return false;
  if (name === "prompt/key-vault-manifest") return true;
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
