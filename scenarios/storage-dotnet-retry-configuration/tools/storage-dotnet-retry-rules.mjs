import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const identityPackageVersion = "1.21.0";
const blobsPackageVersion = "12.29.2";
const sdkTypeNamespaces = new Map([
  ["BlobClient", "Azure.Storage.Blobs"],
  ["BlobClientOptions", "Azure.Storage.Blobs"],
  ["BlobContainerClient", "Azure.Storage.Blobs"],
  ["BlobServiceClient", "Azure.Storage.Blobs"],
  ["DefaultAzureCredential", "Azure.Identity"],
  ["RequestFailedException", "Azure"],
  ["RetryMode", "Azure.Core"],
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
      literals.set(marker, value.replace(/\{[^{}]+\}/g, " "));
    }
    index = closeIndex;
  }
  return { code: characters.join(""), literals };
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
    /\b((?:(?:public|private|protected|internal|static|async|virtual|sealed|new|unsafe)\s+)*)((?:(?:(?:global::)?System\.Threading\.Tasks\.)?Task(?:\s*<[^>{}]+>)?|ValueTask(?:\s*<[^>{}]+>)?|void|int|string|bool|[A-Z]\w*(?:\s*<[^>{}]+>)?))\s+(\w+)\s*\(([^;{}]*)\)\s*(?:=>[^;]+;|\{)/g;

  for (const match of source.matchAll(pattern)) {
    if (!match[0].endsWith("{")) {
      const arrow = match[0].indexOf("=>");
      methods.push({
        modifiers: match[1].trim().split(/\s+/).filter(Boolean),
        returnType: match[2].replace(/\s+/g, ""),
        name: match[3],
        parameterSources: splitArguments(match[4]),
        parameters: splitArguments(match[4])
          .map((parameter) =>
            /(?:^|\s)(\w+)\s*(?:=[\s\S]*)?$/.exec(parameter.trim())?.[1]
          )
          .filter(Boolean),
        start: match.index,
        bodyStart: match.index + arrow + 2,
        bodyEnd: match.index + match[0].length - 1,
        end: match.index + match[0].length,
        body: match[0].slice(arrow + 2, -1),
      });
      continue;
    }
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
    const bindings = method.parameters
      .map((parameter, index) =>
        argumentsSource[index] ? `var ${parameter} = ${argumentsSource[index]};` : ""
      )
      .filter(Boolean)
      .join("\n");
    output.push(
      expandInvocations(
        `${bindings}\n${withoutDeadCode(method.body)}`,
        methods,
        new Set(seen).add(key),
      ),
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

function normalizeSdkTypes(source) {
  const { code, literals } = literalAwareCode(source);
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
      imports.has(sdkTypeNamespaces.get(type)) && !localTypes.has(type)
        ? `Sdk${type}`
        : `Invalid${type}`,
    );
  }
  return {
    literals,
    source: normalized.replace(
      /^\s*(?:global\s+)?using\s+(?:\w+\s*=\s*)?(?:global::)?[\w.]+\s*;\s*$/gm,
      " ",
    ),
  };
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

  const references = [];
  for (const itemGroup of source.matchAll(
    /<ItemGroup\b([^>]*)>([\s\S]*?)<\/ItemGroup\s*>/gi,
  )) {
    if (/\bCondition\s*=\s*["']\s*false\s*["']/i.test(itemGroup[1])) continue;
    for (const reference of itemGroup[2].matchAll(
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
    exact("Azure.Storage.Blobs", blobsPackageVersion)
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
  for (const pattern of [
    new RegExp(
      String.raw`\b(?:using\s+)?Sdk${type}\s+(\w+)\s*=\s*new(?:\s+Sdk${type})?\s*\(`,
      "g",
    ),
    new RegExp(
      String.raw`\b(?:using\s+)?var\s+(\w+)\s*=\s*new\s+Sdk${type}\s*\(`,
      "g",
    ),
  ]) {
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

function literalMarkers(literals, value) {
  return [...literals]
    .filter(([, text]) => text === value)
    .map(([marker]) => marker);
}

function settingBindings(source, literals, setting) {
  const markers = literalMarkers(literals, setting);
  const bindings = new Set();
  if (markers.length === 0) return bindings;
  const markerPattern = markers.map(escapeRegExp).join("|");
  for (const match of source.matchAll(
    new RegExp(
      String.raw`\b(?:var|string\??)\s+(\w+)\s*=\s*(?:(?:global::)?System\s*\.\s*)?Environment\s*\.\s*GetEnvironmentVariable\s*\(\s*"(?:${markerPattern})"\s*\)`,
      "g",
    ),
  )) {
    bindings.add(match[1]);
  }
  return bindings;
}

function timeSpanPattern(seconds) {
  const forms = [
    `TimeSpan\\s*\\.\\s*FromSeconds\\s*\\(\\s*${seconds}(?:\\.0+)?\\s*\\)`,
    `TimeSpan\\s*\\.\\s*FromMilliseconds\\s*\\(\\s*${seconds * 1000}(?:\\.0+)?\\s*\\)`,
    `TimeSpan\\s*\\.\\s*FromMinutes\\s*\\(\\s*${seconds / 60}(?:0*)?\\s*\\)`,
  ];
  return `(?:${forms.join("|")})`;
}

function exactRetryConfiguration(text) {
  return (
    /\bMode\s*=\s*SdkRetryMode\s*\.\s*Exponential\b/.test(text) &&
    /\bMaxRetries\s*=\s*5\b/.test(text) &&
    new RegExp(String.raw`\bDelay\s*=\s*${timeSpanPattern(1)}`).test(text) &&
    new RegExp(String.raw`\bMaxDelay\s*=\s*${timeSpanPattern(16)}`).test(text) &&
    new RegExp(
      String.raw`\bNetworkTimeout\s*=\s*${timeSpanPattern(30)}`,
    ).test(text)
  );
}

function optionBindings(source) {
  const candidates = constructorBindings(source, "BlobClientOptions");
  for (const match of source.matchAll(
    /\b(?:var|SdkBlobClientOptions)\s+(\w+)\s*=\s*new\s+SdkBlobClientOptions\s*\{/g,
  )) {
    candidates.push({
      arguments: "",
      end: match.index + match[0].length,
      name: match[1],
      start: match.index,
    });
  }
  for (const match of source.matchAll(
    /\bSdkBlobClientOptions\s+(\w+)\s*=\s*new\s*\(\s*\)/g,
  )) {
    candidates.push({
      arguments: "",
      end: match.index + match[0].length,
      name: match[1],
      start: match.index,
    });
  }
  const options = new Set();
  for (const candidate of candidates) {
    let declaration = source.slice(
      candidate.start,
      Math.min(source.length, candidate.end + 1600),
    );
    const initializerOpen = declaration.indexOf("{");
    if (initializerOpen >= 0) {
      const initializerClose = matchingDelimiter(
        declaration,
        initializerOpen,
        "{",
        "}",
      );
      if (initializerClose >= 0) {
        declaration = declaration.slice(0, initializerClose + 1);
      }
    } else {
      declaration = declaration.slice(0, declaration.indexOf(";") + 1);
    }
    const assignments = [
      ...source.matchAll(
        new RegExp(
          String.raw`\b${escapeRegExp(candidate.name)}\s*\.\s*Retry\s*\.\s*(?:Mode|MaxRetries|Delay|MaxDelay|NetworkTimeout)\s*=\s*[^;]+;`,
          "g",
        ),
      ),
    ].map((match) => match[0]).join("\n");
    if (exactRetryConfiguration(`${declaration}\n${assignments}`)) {
      options.add(candidate.name);
    }
  }
  return options;
}

function propagateAliases(source, sets) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(
      /\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*(\w+)\s*;/g,
    )) {
      for (const set of sets) {
        if (set.has(match[2]) && !set.has(match[1])) {
          set.add(match[1]);
          changed = true;
        }
      }
    }
  }
}

function analyzeBindings(source, literals) {
  const endpointSettings = settingBindings(
    source,
    literals,
    "AZURE_STORAGE_BLOB_ENDPOINT",
  );
  const containerSettings = settingBindings(
    source,
    literals,
    "AZURE_STORAGE_CONTAINER",
  );
  const blobSettings = settingBindings(
    source,
    literals,
    "AZURE_STORAGE_BLOB",
  );
  const endpoints = new Set();
  for (const match of source.matchAll(
    /\b(?:var|(?:global::)?System\s*\.\s*Uri)\s+(\w+)\s*=\s*new(?:\s+(?:(?:global::)?System\s*\.\s*)?Uri)?\s*\(\s*(\w+)\s*!?\s*,\s*UriKind\s*\.\s*Absolute\s*\)/g,
  )) {
    if (endpointSettings.has(match[2])) endpoints.add(match[1]);
  }
  for (const match of source.matchAll(
    /\bUri\s*\.\s*TryCreate\s*\(\s*(\w+)\s*,\s*UriKind\s*\.\s*Absolute\s*,\s*out\s+(?:(?:var|Uri\??)\s+)?(\w+)\s*\)/g,
  )) {
    if (endpointSettings.has(match[1])) endpoints.add(match[2]);
  }

  const credentials = new Set(
    constructorBindings(source, "DefaultAzureCredential").map(
      ({ name }) => name,
    ),
  );
  const options = optionBindings(source);
  propagateAliases(source, [
    endpointSettings,
    containerSettings,
    blobSettings,
    endpoints,
    credentials,
    options,
  ]);

  const services = new Set();
  for (const client of constructorBindings(source, "BlobServiceClient")) {
    const argumentsSource = splitArguments(client.arguments);
    const hasEndpoint = argumentsSource.some(
      (argument) =>
        endpoints.has(argument.trim()) ||
        [...endpointSettings].some((setting) =>
          new RegExp(
            String.raw`\bnew\s+(?:(?:global::)?System\s*\.\s*)?Uri\s*\(\s*${escapeRegExp(setting)}\s*!?\s*,\s*UriKind\s*\.\s*Absolute\s*\)`,
          ).test(argument)
        ),
    );
    const hasCredential = argumentsSource.some(
      (argument) =>
        credentials.has(argument.trim()) ||
        /\bnew\s+SdkDefaultAzureCredential\s*\(/.test(argument),
    );
    const hasOptions = argumentsSource.some(
      (argument) =>
        options.has(argument.trim()) ||
        (
          /\bnew\s+SdkBlobClientOptions\b/.test(argument) &&
          exactRetryConfiguration(argument)
        ),
    );
    if (hasEndpoint && hasCredential && hasOptions) services.add(client.name);
  }

  const containers = new Set();
  const blobs = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    propagateAliases(source, [services, containers, blobs]);
    for (const match of source.matchAll(
      /\b(?:var|SdkBlobContainerClient)\s+(\w+)\s*=\s*(\w+)\s*\.\s*GetBlobContainerClient\s*\(([\s\S]*?)\)\s*;/g,
    )) {
      if (
        services.has(match[2]) &&
        [...containerSettings].some((setting) =>
          new RegExp(String.raw`\b${escapeRegExp(setting)}\b`).test(match[3])
        ) &&
        !containers.has(match[1])
      ) {
        containers.add(match[1]);
        changed = true;
      }
    }
    for (const match of source.matchAll(
      /\b(?:var|SdkBlobClient)\s+(\w+)\s*=\s*(\w+)\s*\.\s*GetBlobClient\s*\(([\s\S]*?)\)\s*;/g,
    )) {
      if (
        containers.has(match[2]) &&
        [...blobSettings].some((setting) =>
          new RegExp(String.raw`\b${escapeRegExp(setting)}\b`).test(match[3])
        ) &&
        !blobs.has(match[1])
      ) {
        blobs.add(match[1]);
        changed = true;
      }
    }
  }
  return { blobs, services };
}

function uploadOperations(source, blobs) {
  const operations = [];
  for (const match of source.matchAll(
    /\bawait\s+(\w+)\s*\.\s*UploadAsync\s*\(/g,
  )) {
    if (!blobs.has(match[1])) continue;
    const open = source.indexOf("(", match.index + match[0].length - 1);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close >= 0) {
      operations.push({
        arguments: source.slice(open + 1, close),
        end: close + 1,
        receiver: match[1],
        start: match.index,
      });
    }
  }
  return operations;
}

function timeoutTokens(source) {
  const sources = new Set();
  for (const pattern of [
    /\b(?:using\s+)?(?:var|CancellationTokenSource)\s+(\w+)\s*=\s*new(?:\s+CancellationTokenSource)?\s*\(/g,
    /\b(?:using\s+)?(?:var|(?:global::)?System\s*\.\s*Threading\s*\.\s*CancellationTokenSource)\s+(\w+)\s*=\s*new\s+(?:(?:global::)?System\s*\.\s*Threading\s*\.\s*)?CancellationTokenSource\s*\(/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const open = source.indexOf("(", match.index + match[0].length - 1);
      const close = matchingDelimiter(source, open, "(", ")");
      if (
        close >= 0 &&
        new RegExp(String.raw`^\s*${timeSpanPattern(120)}\s*$`).test(
          source.slice(open + 1, close),
        )
      ) {
        sources.add(match[1]);
      }
    }
  }
  const tokens = new Set([...sources].map((name) => `${name}.Token`));
  for (const match of source.matchAll(
    /\b(?:var|CancellationToken)\s+(\w+)\s*=\s*(\w+)\s*\.\s*Token\s*;/g,
  )) {
    if (sources.has(match[2])) tokens.add(match[1]);
  }
  return tokens;
}

function operationUsesTimeout(operation, tokens) {
  return [...tokens].some((token) => {
    if (token.includes(".")) {
      const [source] = token.split(".");
      return new RegExp(
        String.raw`(?:\bcancellationToken\s*:\s*)?\b${escapeRegExp(source)}\s*\.\s*Token\b`,
      ).test(operation.arguments);
    }
    return new RegExp(
      String.raw`(?:\bcancellationToken\s*:\s*)?\b${escapeRegExp(token)}\b`,
    ).test(operation.arguments);
  });
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

function requestFailureName(caught) {
  if (caught.type === "SdkRequestFailedException") return caught.name;
  if (!caught.name) return null;
  const match = new RegExp(
    String.raw`\b${escapeRegExp(caught.name)}\s+is\s+SdkRequestFailedException(?:\s+(\w+))?\b`,
  ).exec(caught.filter);
  return match?.[1] ?? (match ? caught.name : null);
}

function collectWorkflows(source, bindings, methods) {
  const workflows = [];
  for (const match of source.matchAll(/\btry\s*\{/g)) {
    const open = source.indexOf("{", match.index);
    const block = blockAt(source, open);
    if (!block) continue;
    const tryBody = expandInvocations(block.body, methods);
    const operations = uploadOperations(tryBody, bindings.blobs);
    if (operations.length === 0) continue;
    const catches = attachedCatches(source, block.end)
      .filter((caught) => requestFailureName(caught) !== null)
      .map((caught) => ({
        ...caught,
        expanded: expandInvocations(`${caught.filter}\n${caught.body}`, methods),
      }));
    workflows.push({ catches, operations, tryBody });
  }
  return workflows;
}

const statusTokens = {
  400: String.raw`(?:HttpStatusCode\s*\.\s*BadRequest|\(\s*HttpStatusCode\s*\)\s*400|400)`,
  401: String.raw`(?:HttpStatusCode\s*\.\s*Unauthorized|\(\s*HttpStatusCode\s*\)\s*401|401)`,
  403: String.raw`(?:HttpStatusCode\s*\.\s*Forbidden|\(\s*HttpStatusCode\s*\)\s*403|403)`,
  404: String.raw`(?:HttpStatusCode\s*\.\s*NotFound|\(\s*HttpStatusCode\s*\)\s*404|404)`,
  408: String.raw`(?:HttpStatusCode\s*\.\s*RequestTimeout|\(\s*HttpStatusCode\s*\)\s*408|408)`,
  409: String.raw`(?:HttpStatusCode\s*\.\s*Conflict|\(\s*HttpStatusCode\s*\)\s*409|409)`,
  429: String.raw`(?:HttpStatusCode\s*\.\s*TooManyRequests|\(\s*HttpStatusCode\s*\)\s*429|429)`,
  500: String.raw`(?:HttpStatusCode\s*\.\s*InternalServerError|\(\s*HttpStatusCode\s*\)\s*500|500)`,
  502: String.raw`(?:HttpStatusCode\s*\.\s*BadGateway|\(\s*HttpStatusCode\s*\)\s*502|502)`,
  503: String.raw`(?:HttpStatusCode\s*\.\s*ServiceUnavailable|\(\s*HttpStatusCode\s*\)\s*503|503)`,
  504: String.raw`(?:HttpStatusCode\s*\.\s*GatewayTimeout|\(\s*HttpStatusCode\s*\)\s*504|504)`,
};

function hasStatuses(text, statuses) {
  return statuses.every((status) =>
    new RegExp(String.raw`\b${statusTokens[status]}\b`).test(text)
  );
}

function literalText(source, literals) {
  return [...literals]
    .filter(([marker]) => source.includes(marker))
    .map(([, value]) => value)
    .join(" ")
    .toLowerCase();
}

function hasFailureClassification(workflow, literals) {
  return workflow.catches.some((caught) => {
    const text = caught.expanded;
    const messages = literalText(text, literals);
    return (
      hasStatuses(text, [408, 429, 500, 502, 503, 504]) &&
      hasStatuses(text, [400, 401, 403, 404, 409]) &&
      /\b(?:if|switch)\b/.test(text) &&
      /\btransient\b/.test(messages) &&
      /\b(?:non-transient|authentication|authorization|credentials|request)\b/
        .test(messages)
    );
  });
}

function customConstructorBindings(source) {
  const result = [];
  for (const match of source.matchAll(
    /\b(?:var|(\w+))\s+(\w+)\s*=\s*new\s+(\w+)\s*\(/g,
  )) {
    const open = source.indexOf("(", match.index + match[0].length - 1);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close >= 0) {
      result.push({
        arguments: source.slice(open + 1, close),
        name: match[2],
        type: match[3],
      });
    }
  }
  for (const match of source.matchAll(
    /\b(\w+)\s+(\w+)\s*=\s*new\s*\(/g,
  )) {
    const open = source.indexOf("(", match.index + match[0].length - 1);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close >= 0) {
      result.push({
        arguments: source.slice(open + 1, close),
        name: match[2],
        type: match[1],
      });
    }
  }
  return result;
}

function exactCircuitSettings(text, argumentsSource) {
  const thresholdNames = [
    ...text.matchAll(
      /\b(\w*(?:threshold|limit)\w*)\s*=\s*3\b/gi,
    ),
  ].map((match) => match[1]);
  const directThreshold = /(?:>=|==)\s*3\b/.test(text);
  const namedThreshold = thresholdNames.some((name) =>
    new RegExp(
      String.raw`(?:>=|==)\s*${escapeRegExp(name)}\b|\b${escapeRegExp(name)}\s*(?:<=|==)`,
    ).test(text)
  );
  const constructorThreshold =
    splitArguments(argumentsSource).some((argument) => /^\s*3\s*$/.test(argument)) &&
    /(?:>=|==)\s*\w*(?:threshold|limit)\w*\b/i.test(text);

  const durationNames = [];
  for (const match of text.matchAll(
    new RegExp(
      String.raw`\b(\w*(?:duration|period|interval)\w*)\s*=\s*${timeSpanPattern(30)}`,
      "gi",
    ),
  )) {
    durationNames.push(match[1]);
  }
  const directDuration =
    new RegExp(
      String.raw`(?:<|<=|\+)\s*${timeSpanPattern(30)}|${timeSpanPattern(30)}\s*(?:>|>=|\+)`,
    ).test(text);
  const namedDuration = durationNames.some((name) =>
    new RegExp(
      String.raw`(?:<|<=|\+)\s*${escapeRegExp(name)}\b|\b${escapeRegExp(name)}\s*(?:>|>=|\+)`,
    ).test(text)
  );
  const constructorDuration =
    new RegExp(timeSpanPattern(30)).test(argumentsSource) &&
    /\b(?:duration|period|interval)\b/i.test(text);
  return (
    (directThreshold || namedThreshold || constructorThreshold) &&
    (directDuration || namedDuration || constructorDuration)
  );
}

function circuitMethodIsValid(method, type, methods, argumentsSource) {
  const expanded = expandInvocations(method.body, methods);
  const typeBody = type
    ? methods.source?.slice(type.bodyStart, type.bodyEnd) ?? ""
    : "";
  const settingsText = `${typeBody}\n${expanded}`;
  const circuitCatches = [];
  for (const match of method.body.matchAll(/\bcatch\b/g)) {
    const caught = catchAt(method.body, match.index);
    if (!caught) continue;
    const body = expandInvocations(caught.body, methods);
    const filter = expandInvocations(caught.filter, methods);
    const opensCircuit =
      /\b(?:opened|openUntil|blocked)\w*\s*=\s*(?:DateTimeOffset\s*\.\s*)?(?:UtcNow|GetUtcNow)\b/i
        .test(body);
    const transientGuard =
      hasStatuses(filter, [408, 429, 500, 502, 503, 504]) ||
      (
        /\b(?:IsTransient|transient\w*)\b/i.test(
          `${caught.filter}\n${caught.body}`,
        ) &&
        hasStatuses(`${filter}\n${body}`, [408, 429, 500, 502, 503, 504])
      );
    circuitCatches.push({
      opensCircuit,
      requestFailure: requestFailureName(caught) !== null,
      transientGuard,
    });
  }
  const guardedOpen = circuitCatches.some(
    (caught) =>
      caught.requestFailure && caught.transientGuard && caught.opensCircuit,
  );
  const unguardedOpen = circuitCatches.some(
    (caught) => caught.opensCircuit && !caught.transientGuard,
  );
  const checks = {
    settings: exactCircuitSettings(settingsText, argumentsSource),
    invokes: /\bawait\s+\w+\s*\(/.test(expanded),
    guardedOpen,
    unguardedOpen,
    increments: /(?:\+\+|\+=\s*1)\s*;/.test(expanded),
    clock: /\b(?:UtcNow|GetUtcNow)\b/.test(expanded),
    throws: /\bthrow\b/.test(expanded),
    state:
      /\b(?:opened|openUntil|blocked|breakDuration|BreakDuration)\w*\b/i.test(
        settingsText,
      ),
  };
  return (
    checks.settings &&
    checks.invokes &&
    checks.guardedOpen &&
    !checks.unguardedOpen &&
    checks.increments &&
    checks.clock &&
    checks.throws &&
    checks.state
  );
}

function hasCircuitBreaker(workflow, source, methods) {
  if (/\b(?:for|while)\s*\(/.test(workflow.tryBody)) return false;
  const types = typeDeclarations(source);
  for (const binding of customConstructorBindings(source)) {
    const type = types.find((candidate) => candidate.name === binding.type);
    if (!type) continue;
    for (const call of workflow.tryBody.matchAll(
      new RegExp(
        String.raw`\b${escapeRegExp(binding.name)}\s*\.\s*(\w+)\s*\(`,
        "g",
      ),
    )) {
      const open = workflow.tryBody.indexOf(
        "(",
        call.index + call[0].length - 1,
      );
      const close = matchingDelimiter(workflow.tryBody, open, "(", ")");
      if (close < 0) continue;
      const callBody = workflow.tryBody.slice(open + 1, close);
      if (
        !workflow.operations.some((operation) =>
          callBody.includes(
            workflow.tryBody.slice(operation.start, operation.end),
          )
        )
      ) {
        continue;
      }
      const candidates = methods.filter(
        (method) =>
          method.name === call[1] &&
          method.type?.name === binding.type,
      );
      if (
        candidates.some((method) =>
          circuitMethodIsValid(
            method,
            type,
            Object.assign(methods, { source }),
            binding.arguments,
          )
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function analyzeProject(project) {
  const normalized = normalizeSdkTypes(project.source);
  if (normalized === null) return null;
  const reachable = reachableSource(normalized.source);
  const bindings = analyzeBindings(reachable.source, normalized.literals);
  const operations = uploadOperations(reachable.source, bindings.blobs);
  const tokens = timeoutTokens(reachable.source);
  const workflows = collectWorkflows(
    reachable.source,
    bindings,
    reachable.methods,
  );
  return {
    bindings,
    literals: normalized.literals,
    methods: reachable.methods,
    normalizedSource: normalized.source,
    operations,
    tokens,
    workflows,
  };
}

const rules = {
  "prompt/storage-retry-manifest": () => true,
  "prompt/configured-upload-client": ({ analysis }) =>
    analysis.bindings.services.size > 0 &&
    analysis.bindings.blobs.size > 0 &&
    analysis.operations.length > 0,
  "prompt/operation-timeout": ({ analysis }) =>
    analysis.operations.some((operation) =>
      operationUsesTimeout(operation, analysis.tokens)
    ),
  "prompt/failure-classification": ({ analysis }) =>
    analysis.workflows.some((workflow) =>
      hasFailureClassification(workflow, analysis.literals)
    ),
  "prompt/circuit-breaker": ({ analysis }) =>
    analysis.workflows.some((workflow) =>
      hasCircuitBreaker(
        workflow,
        analysis.normalizedSource,
        analysis.methods,
      )
    ),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const projects = applicationProjects(workspace);
  if (projects.length !== 1) return false;
  if (name === "prompt/storage-retry-manifest") return true;
  const analysis = analyzeProject(projects[0]);
  return analysis !== null && Boolean(rule({ analysis }));
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
