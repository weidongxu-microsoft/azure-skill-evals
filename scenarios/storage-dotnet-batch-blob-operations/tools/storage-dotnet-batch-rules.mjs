import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const packageVersions = new Map([
  ["azure.identity", "1.21.0"],
  ["azure.storage.blobs", "12.29.2"],
  ["azure.storage.blobs.batch", "12.26.0"],
]);
const sdkTypeNamespaces = new Map([
  ["AccessTier", "Azure.Storage.Blobs.Models"],
  ["AggregateException", "System"],
  ["BlobBatch", "Azure.Storage.Blobs.Specialized"],
  ["BlobBatchClient", "Azure.Storage.Blobs.Specialized"],
  ["BlobContainerClient", "Azure.Storage.Blobs"],
  ["BlobServiceClient", "Azure.Storage.Blobs"],
  ["DefaultAzureCredential", "Azure.Identity"],
  ["DeleteSnapshotsOption", "Azure.Storage.Blobs.Models"],
  ["RequestFailedException", "Azure"],
  ["Response", "Azure"],
]);
const sdkTypes = [...sdkTypeNamespaces.keys()];
const operationNames = [
  "DeleteBlobsAsync",
  "SetBlobsAccessTierAsync",
  "SubmitBatchAsync",
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
        const statement = characters.slice(statementStart, index).join("");
        if (
          /^(?:\s*(?:return|throw)\b|\s*(?:(?:global::)?System\s*\.\s*)?Environment\s*\.\s*Exit\s*\()/.test(
            statement,
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
    const parameters = parameterSources
      .map((parameter) =>
        /(?:^|\s)(\w+)\s*(?:=[\s\S]*)?$/.exec(parameter.trim())?.[1]
      )
      .filter(Boolean);
    methods.push({
      modifiers: match[1].trim().split(/\s+/).filter(Boolean),
      returnType: match[2].replace(/\s+/g, ""),
      name: match[3],
      parameterSources,
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

function preserveRequiredLiterals(source) {
  const characters = [...dotnetCodeOnly(source)];
  for (const literal of [
    '"AZURE_STORAGE_BLOB_ENDPOINT"',
    '"AZURE_STORAGE_CONTAINER"',
    '"https://storage.azure.com/.default"',
  ]) {
    let index = source.indexOf(literal);
    while (index >= 0) {
      if (characters[index] === '"') {
        for (let offset = 0; offset < literal.length; offset += 1) {
          characters[index + offset] = literal[offset];
        }
      }
      index = source.indexOf(literal, index + literal.length);
    }
  }
  return characters.join("");
}

function normalizeSdkTypes(source) {
  const code = preserveRequiredLiterals(source);
  for (const [type, namespace] of sdkTypeNamespaces) {
    const namespacePattern = escapeRegExp(namespace)
      .replaceAll("\\.", "\\s*\\.\\s*");
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
      (
        imports.has(sdkTypeNamespaces.get(type)) ||
        sdkTypeNamespaces.get(type) === "System"
      ) && !localTypes.has(type)
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
    const next = result.replace(/\$\(([^)]+)\)/g, (match, name) =>
      properties.get(name.toLowerCase()) ?? match
    );
    result = next;
    if (!/\$\([^)]+\)/.test(result)) return result;
    if (next === value) break;
    value = next;
  }
  return null;
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
    ) ||
    /<Compile\b[^>]*\bRemove\s*=/i.test(source)
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

  for (const [name, version] of packageVersions) {
    const matches = references.filter(({ include }) => include === name);
    if (
      matches.length === 0 ||
      !matches.every(
        (reference) =>
          reference.usable &&
          [version, `[${version}]`].includes(reference.version),
      )
    ) {
      return false;
    }
  }
  return true;
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

function statementEnd(source, start) {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (
      character === ";" &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      return index;
    }
  }
  return -1;
}

function declarations(source) {
  const result = [];
  for (const match of source.matchAll(
    /\b(?:const\s+)?(?:using\s+)?(var|[\w.:<>?[\],]+)\s+(\w+)\s*=\s*/g,
  )) {
    const end = statementEnd(source, match.index + match[0].length);
    if (end >= 0) {
      result.push({
        type: match[1],
        name: match[2],
        expression: source.slice(match.index + match[0].length, end).trim(),
        start: match.index,
        end: end + 1,
      });
    }
  }
  return result;
}

function constructorArguments(expression, type) {
  const explicitType = type === "Uri"
    ? "(?:SdkUri|Uri)"
    : `Sdk${type}`;
  const match = new RegExp(
    String.raw`\bnew(?:\s+${explicitType})?\s*\(`,
  ).exec(expression);
  if (!match) return null;
  const open = expression.indexOf("(", match.index);
  const close = matchingDelimiter(expression, open, "(", ")");
  return close < 0 ? null : splitArguments(expression.slice(open + 1, close));
}

function invocationArguments(expression, receiver, method) {
  const match = new RegExp(
    String.raw`\b${escapeRegExp(receiver)}\s*\.\s*${method}\s*\(`,
  ).exec(expression);
  if (!match) return null;
  const open = expression.indexOf("(", match.index);
  const close = matchingDelimiter(expression, open, "(", ")");
  return close < 0 ? null : splitArguments(expression.slice(open + 1, close));
}

function referencesAny(expression, values) {
  return [...values].some((value) =>
    new RegExp(String.raw`\b${escapeRegExp(value)}\b`).test(expression)
  );
}

function integerValue(expression, constants) {
  let value = expression.replaceAll("_", "");
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const next = value.replace(/\b[A-Za-z_]\w*\b/g, (name) =>
      constants.has(name) ? String(constants.get(name)) : name
    );
    value = next;
    if (!/\b[A-Za-z_]\w*\b/.test(value)) break;
  }
  if (!/^[\d\s()+\-*/]+$/.test(value)) return null;
  try {
    const result = Function(`"use strict"; return (${value});`)();
    return Number.isSafeInteger(result) ? result : null;
  } catch {
    return null;
  }
}

function collectionCount(expression, constants) {
  for (const pattern of [
    /\bEnumerable\s*\.\s*Range\s*\([^,]+,\s*([^,)]+)\)/,
    /\.\s*Take\s*\(\s*([^)]+)\)/,
  ]) {
    const match = pattern.exec(expression);
    const value = match && integerValue(match[1], constants);
    if (value !== null) return value;
  }
  return null;
}

function analyzeBindings(source) {
  const entries = declarations(source);
  const constants = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (constants.has(entry.name)) continue;
      const value = integerValue(entry.expression, constants);
      if (value !== null) {
        constants.set(entry.name, value);
        changed = true;
      }
    }
  }

  const endpointSettings = new Set();
  const containerSettings = new Set();
  const absoluteUris = new Set();
  const credentials = new Set();
  const services = new Set();
  const containers = new Set();
  const batchClients = new Set();
  const uriCollections = new Map();
  const singleUris = new Set();
  const chunks = new Map();
  const batches = new Map();
  const customResponses = new Map();

  for (const entry of entries) {
    if (
      /\bEnvironment\s*\.\s*GetEnvironmentVariable\s*\(\s*"AZURE_STORAGE_BLOB_ENDPOINT"\s*\)/.test(
        entry.expression,
      )
    ) {
      endpointSettings.add(entry.name);
    }
    if (
      /\bEnvironment\s*\.\s*GetEnvironmentVariable\s*\(\s*"AZURE_STORAGE_CONTAINER"\s*\)/.test(
        entry.expression,
      )
    ) {
      containerSettings.add(entry.name);
    }
  }

  for (const match of source.matchAll(
    /\bUri\s*\.\s*TryCreate\s*\(\s*(\w+)\s*,\s*UriKind\s*\.\s*Absolute\s*,\s*out\s+(?:var|SdkUri|Uri\??)\s+(\w+)/g,
  )) {
    if (endpointSettings.has(match[1])) absoluteUris.add(match[2]);
  }
  for (const entry of entries) {
    const args = constructorArguments(entry.expression, "Uri");
    if (
      args &&
      referencesAny(args[0] ?? "", endpointSettings) &&
      /\bUriKind\s*\.\s*Absolute\b/.test(args[1] ?? "")
    ) {
      absoluteUris.add(entry.name);
    }
    if (
      /\bnew\s+SdkDefaultAzureCredential\s*\(/.test(entry.expression) ||
      (
        entry.type === "SdkDefaultAzureCredential" &&
        /^\s*new\s*\(/.test(entry.expression)
      )
    ) {
      credentials.add(entry.name);
    }
  }

  for (let iteration = 0; iteration < 12; iteration += 1) {
    for (const entry of entries) {
      const expression = entry.expression;
      if (absoluteUris.has(expression)) absoluteUris.add(entry.name);
      if (credentials.has(expression)) credentials.add(entry.name);
      if (services.has(expression)) services.add(entry.name);
      if (containers.has(expression)) containers.add(entry.name);
      if (batchClients.has(expression)) batchClients.add(entry.name);
      if (uriCollections.has(expression)) {
        uriCollections.set(entry.name, uriCollections.get(expression));
      }
      if (singleUris.has(expression)) singleUris.add(entry.name);

      if (
        /\bnew\s+SdkBlobServiceClient\s*\(/.test(expression) ||
        (
          entry.type === "SdkBlobServiceClient" &&
          /^\s*new\s*\(/.test(expression)
        )
      ) {
        const args = constructorArguments(expression, "BlobServiceClient") ?? [];
        if (
          referencesAny(args[0] ?? "", absoluteUris) &&
          referencesAny(args[1] ?? "", credentials)
        ) {
          services.add(entry.name);
        }
      }
      if (
        /\bnew\s+SdkBlobBatchClient\s*\(/.test(expression) ||
        (
          entry.type === "SdkBlobBatchClient" &&
          /^\s*new\s*\(/.test(expression)
        )
      ) {
        const args = constructorArguments(expression, "BlobBatchClient") ?? [];
        if (
          referencesAny(args[0] ?? "", absoluteUris) &&
          referencesAny(args[1] ?? "", credentials)
        ) {
          batchClients.add(entry.name);
        }
      }
      for (const service of services) {
        if (invocationArguments(expression, service, "GetBlobBatchClient")) {
          batchClients.add(entry.name);
        }
        const containerArgs = invocationArguments(
          expression,
          service,
          "GetBlobContainerClient",
        );
        if (
          containerArgs &&
          referencesAny(containerArgs[0] ?? "", containerSettings)
        ) {
          containers.add(entry.name);
        }
      }
      for (const container of containers) {
        const target =
          new RegExp(
            String.raw`\b${escapeRegExp(container)}\s*\.\s*GetBlobClient\s*\(`,
          ).test(expression) &&
          /\.\s*Uri\b/.test(expression);
        if (target) {
          const count = collectionCount(expression, constants);
          if (count !== null || /\b(?:ToArray|ToList)\s*\(/.test(expression)) {
            uriCollections.set(entry.name, {
              connected: true,
              count,
            });
          } else {
            singleUris.add(entry.name);
          }
        }
      }
      for (const client of batchClients) {
        if (invocationArguments(expression, client, "CreateBatch")) {
          batches.set(entry.name, client);
        }
      }
      for (const [batch, client] of batches) {
        for (const method of ["DeleteBlob", "SetBlobAccessTier"]) {
          const args = invocationArguments(expression, batch, method);
          if (!args) continue;
          const targetConnected =
            referencesAny(args[0] ?? "", singleUris) ||
            referencesAny(args[0] ?? "", uriCollections.keys()) ||
            [...containers].some((container) =>
              new RegExp(
                String.raw`\b${escapeRegExp(container)}\s*\.\s*GetBlobClient\s*\(`,
              ).test(args[0] ?? "")
            );
          const tierCorrect =
            method !== "SetBlobAccessTier" ||
            /\bSdkAccessTier\s*\.\s*Cool\b/.test(args[1] ?? "");
          if (targetConnected && tierCorrect) {
            customResponses.set(entry.name, {
              batch,
              client,
              method,
              start: entry.start,
            });
          }
        }
      }
    }
  }

  for (const match of source.matchAll(
    /\bforeach\s*\(\s*(?:var|[\w.:<>?[\],]+)\s+(\w+)\s+in\s+(\w+)\s*\.\s*Chunk\s*\(\s*([^)]+)\)/g,
  )) {
    const origin = uriCollections.get(match[2]);
    const size = integerValue(match[3], constants);
    if (origin?.connected && size !== null) {
      chunks.set(match[1], { ...origin, size });
    }
  }

  return {
    absoluteUris,
    batchClients,
    batches,
    chunks,
    constants,
    containers,
    credentials,
    customResponses,
    endpointSettings,
    services,
    singleUris,
    uriCollections,
  };
}

function operationsIn(source, bindings) {
  const operations = [];
  const operation = operationNames.join("|");
  const pattern = new RegExp(
    String.raw`(?:(?:var|SdkResponse\s*\[\]|[\w.:<>?[\],]+)\s+(\w+)\s*=\s*)?await\s+(\w+)\s*\.\s*(${operation})\s*\(`,
    "g",
  );
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf("(", match.index + match[0].length - 1);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close < 0) continue;
    const args = splitArguments(source.slice(open + 1, close));
    if (!bindings.batchClients.has(match[2])) continue;
    operations.push({
      args,
      end: close + 1,
      method: match[3],
      receiver: match[2],
      response: match[1] ?? null,
      start: match.index,
    });
  }
  return operations;
}

function blockAt(source, openIndex) {
  const close = matchingDelimiter(source, openIndex, "{", "}");
  return close < 0
    ? null
    : {
        body: source.slice(openIndex + 1, close),
        start: openIndex,
        end: close + 1,
      };
}

function catchAt(source, start) {
  if (!/^catch\b/.test(source.slice(start))) return null;
  let index = start + 5;
  while (/\s/.test(source[index] ?? "")) index += 1;
  if (source[index] !== "(") return null;
  const headerClose = matchingDelimiter(source, index, "(", ")");
  if (headerClose < 0) return null;
  const header = source.slice(index + 1, headerClose);
  index = headerClose + 1;
  while (/\s/.test(source[index] ?? "")) index += 1;
  let filter = "";
  if (/^when\b/.test(source.slice(index))) {
    index += 4;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "(") return null;
    const filterClose = matchingDelimiter(source, index, "(", ")");
    if (filterClose < 0) return null;
    filter = source.slice(index + 1, filterClose);
    index = filterClose + 1;
  }
  while (/\s/.test(source[index] ?? "")) index += 1;
  if (source[index] !== "{") return null;
  const block = blockAt(source, index);
  const parsed = /^\s*(\w+)(?:\s+(\w+))?\s*$/.exec(header);
  return block && parsed
    ? {
        body: block.body,
        end: block.end,
        filter,
        name: parsed[2] ?? null,
        start,
        type: parsed[1],
      }
    : null;
}

function attachedCatches(source, blockEnd) {
  const catches = [];
  let index = blockEnd;
  while (index < source.length) {
    while (/\s/.test(source[index] ?? "")) index += 1;
    const caught = catchAt(source, index);
    if (!caught) break;
    catches.push(caught);
    index = caught.end;
  }
  return catches;
}

function collectWorkflows(source, bindings, methods) {
  const workflows = [];
  for (const match of source.matchAll(/\btry\s*\{/g)) {
    const open = source.indexOf("{", match.index);
    const block = blockAt(source, open);
    if (!block) continue;
    const body = expandInvocations(block.body, methods);
    const operations = operationsIn(body, bindings);
    if (operations.length === 0) continue;
    workflows.push({
      body,
      catches: attachedCatches(source, block.end).map((caught) => ({
        ...caught,
        body: expandInvocations(caught.body, methods),
      })),
      operations,
    });
  }
  return workflows;
}

function catchType(caught, type) {
  if (caught.type === `Sdk${type}`) return caught.name;
  if (!caught.name) return null;
  const match = new RegExp(
    String.raw`\b${escapeRegExp(caught.name)}\s+is\s+Sdk${type}(?:\s+(\w+))?\b`,
  ).exec(caught.filter);
  return match?.[1] ?? (match ? caught.name : null);
}

function propertyUsed(source, name, property) {
  return new RegExp(
    String.raw`\b${escapeRegExp(name)}\s*\.\s*${property}\b`,
  ).test(source);
}

function aggregateHandled(caught) {
  const aggregate = catchType(caught, "AggregateException");
  if (
    !aggregate ||
    !new RegExp(
      String.raw`\b${escapeRegExp(aggregate)}(?:\s*\.\s*Flatten\s*\(\s*\))?\s*\.\s*InnerExceptions\b`,
    ).test(caught.body)
  ) {
    return false;
  }
  const requestNames = new Set();
  for (const match of caught.body.matchAll(
    /\b(?:foreach\s*\(\s*)?SdkRequestFailedException\s+(\w+)/g,
  )) {
    requestNames.add(match[1]);
  }
  for (const match of caught.body.matchAll(
    /\b(\w+)\s+is\s+SdkRequestFailedException(?:\s+(\w+))?/g,
  )) {
    requestNames.add(match[2] ?? match[1]);
  }
  return [...requestNames].some(
    (name) =>
      propertyUsed(caught.body, name, "Status") &&
      propertyUsed(caught.body, name, "ErrorCode"),
  );
}

function requestFailureHandled(caught) {
  const name = catchType(caught, "RequestFailedException");
  return (
    name !== null &&
    propertyUsed(caught.body, name, "Status") &&
    propertyUsed(caught.body, name, "ErrorCode")
  );
}

function statusUsedAfter(source, response, start) {
  const tail = source.slice(start);
  const direct = new RegExp(
      String.raw`\b${escapeRegExp(response)}\s*(?:\[[^\]]+\])?\s*\.\s*Status\b`,
      "g",
    );
  if (
    [...tail.matchAll(direct)].some((match) =>
      pathsCompatible(source, start, start + match.index)
    )
  ) {
    return true;
  }
  const aliases = new Set([response]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of tail.matchAll(
      /\b(?:var|[\w.:<>?[\],]+)\s+(\w+)\s*=\s*(\w+)\s*;/g,
    )) {
      if (aliases.has(match[2]) && !aliases.has(match[1])) {
        aliases.add(match[1]);
        changed = true;
      }
    }
  }
  for (const collection of aliases) {
    for (const match of tail.matchAll(
      new RegExp(
        String.raw`\bforeach\s*\(\s*(?:var|SdkResponse)\s+(\w+)\s+in\s+${escapeRegExp(collection)}\s*\)`,
        "g",
      ),
    )) {
      const remainder = tail.slice(match.index);
      const status = new RegExp(
        String.raw`\b${escapeRegExp(match[1])}\s*\.\s*Status\b`,
      ).exec(remainder);
      if (
        status &&
        pathsCompatible(
          source,
          start,
          start + match.index + status.index,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function conditionalBranches(source) {
  const branches = [];
  for (const match of source.matchAll(/\bif\s*\(/g)) {
    const conditionOpen = source.indexOf("(", match.index);
    const conditionClose = matchingDelimiter(source, conditionOpen, "(", ")");
    if (conditionClose < 0) continue;
    let cursor = conditionClose + 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "{") continue;
    const thenBlock = blockAt(source, cursor);
    if (!thenBlock) continue;
    cursor = thenBlock.end;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (!/^else\b/.test(source.slice(cursor))) continue;
    cursor += 4;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "{") continue;
    const elseBlock = blockAt(source, cursor);
    if (!elseBlock) continue;
    branches.push({
      thenStart: thenBlock.start,
      thenEnd: thenBlock.end,
      elseStart: elseBlock.start,
      elseEnd: elseBlock.end,
    });
  }
  return branches;
}

function pathsCompatible(source, left, right) {
  return conditionalBranches(source).every((branch) => {
    const leftThen = branch.thenStart <= left && left < branch.thenEnd;
    const leftElse = branch.elseStart <= left && left < branch.elseEnd;
    const rightThen = branch.thenStart <= right && right < branch.thenEnd;
    const rightElse = branch.elseStart <= right && right < branch.elseEnd;
    return !(leftThen && rightElse) && !(leftElse && rightThen);
  });
}

function collectionFor(argument, bindings) {
  const name = /^(\w+)$/.exec(argument.trim())?.[1];
  if (!name) return null;
  return bindings.chunks.get(name) ?? bindings.uriCollections.get(name) ?? null;
}

function analyzeProject(project) {
  const normalized = normalizeSdkTypes(project.source);
  if (normalized === null) return null;
  const reachable = reachableSource(normalized);
  const bindings = analyzeBindings(reachable.source);
  const operations = operationsIn(reachable.source, bindings);
  const workflows = collectWorkflows(
    reachable.source,
    bindings,
    reachable.methods,
  );
  return {
    bindings,
    normalized,
    operations,
    reachable,
    workflows,
  };
}

function hasAuthenticatedClient(analysis) {
  return (
    analysis.bindings.endpointSettings.size > 0 &&
    analysis.bindings.absoluteUris.size > 0 &&
    analysis.bindings.credentials.size > 0 &&
    analysis.bindings.batchClients.size > 0 &&
    analysis.bindings.containers.size > 0 &&
    /"https:\/\/storage\.azure\.com\/\.default"/.test(
      analysis.reachable.source,
    ) &&
    !/\.\s*GetToken(?:Async)?\s*\(/.test(analysis.reachable.source)
  );
}

function hasDeleteBatches(analysis) {
  return analysis.operations.some((operation) => {
    if (operation.method !== "DeleteBlobsAsync" || !operation.response) {
      return false;
    }
    const collection = collectionFor(operation.args[0] ?? "", analysis.bindings);
    return (
      collection?.connected &&
      collection.count === 500 &&
      collection.size !== undefined &&
      collection.size <= 256 &&
      statusUsedAfter(
        analysis.reachable.source,
        operation.response,
        operation.end,
      )
    );
  });
}

function hasTierBatch(analysis) {
  return analysis.operations.some((operation) => {
    if (
      operation.method !== "SetBlobsAccessTierAsync" ||
      !operation.response ||
      !/\bSdkAccessTier\s*\.\s*Cool\b/.test(operation.args[1] ?? "")
    ) {
      return false;
    }
    const collection = collectionFor(operation.args[0] ?? "", analysis.bindings);
    return (
      collection?.connected &&
      collection.count === 200 &&
      (collection.size === undefined || collection.size <= 256) &&
      statusUsedAfter(
        analysis.reachable.source,
        operation.response,
        operation.end,
      )
    );
  });
}

function hasCustomBatchResponses(analysis) {
  for (const operation of analysis.operations) {
    if (operation.method !== "SubmitBatchAsync") continue;
    const batch = /^(\w+)$/.exec(operation.args[0] ?? "")?.[1];
    if (!batch) continue;
    const client = analysis.bindings.batches.get(batch);
    if (client !== operation.receiver) continue;
    const responses = [...analysis.bindings.customResponses]
      .filter(([, value]) =>
        value.batch === batch &&
        value.client === client &&
        value.start < operation.start &&
        pathsCompatible(
          analysis.reachable.source,
          value.start,
          operation.start,
        )
      );
    const customOperationCount = [
      ...analysis.reachable.source.matchAll(
        new RegExp(
          String.raw`\b${escapeRegExp(batch)}\s*\.\s*(?:DeleteBlob|SetBlobAccessTier)\s*\(`,
          "g",
        ),
      ),
    ].filter(
      (match) =>
        match.index < operation.start &&
        pathsCompatible(
          analysis.reachable.source,
          match.index,
          operation.start,
        ),
    ).length;
    if (
      responses.length > 0 &&
      responses.length === customOperationCount &&
      responses.every(([name]) =>
        statusUsedAfter(analysis.reachable.source, name, operation.end)
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasPartialFailureHandling(analysis) {
  return ["DeleteBlobsAsync", "SetBlobsAccessTierAsync"].every((method) =>
    analysis.workflows.some(
      (workflow) =>
        workflow.operations.some((operation) => operation.method === method) &&
        workflow.catches.some(aggregateHandled) &&
        workflow.catches.some(requestFailureHandled),
    )
  );
}

function hasBatchLimits(analysis) {
  const values = [...analysis.bindings.constants.values()];
  const hasChunk = [...analysis.bindings.chunks.values()].some(
    ({ count, size }) => count === 500 && size > 0 && size <= 256,
  );
  return hasChunk && values.includes(256) && values.includes(4 * 1024 * 1024);
}

const rules = {
  "prompt/storage-batch-manifest": () => true,
  "prompt/authenticated-batch-client": ({ analysis }) =>
    hasAuthenticatedClient(analysis),
  "prompt/delete-batches": ({ analysis }) => hasDeleteBatches(analysis),
  "prompt/tier-batch": ({ analysis }) => hasTierBatch(analysis),
  "prompt/custom-batch-responses": ({ analysis }) =>
    hasCustomBatchResponses(analysis),
  "prompt/partial-failure-handling": ({ analysis }) =>
    hasPartialFailureHandling(analysis),
  "prompt/batch-limits": ({ analysis }) => hasBatchLimits(analysis),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const projects = applicationProjects(workspace);
  if (projects.length === 0) return false;
  if (name === "prompt/storage-batch-manifest") return true;
  return projects.some((project) => {
    const analysis = analyzeProject(project);
    return analysis !== null && Boolean(rule({ analysis }));
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
