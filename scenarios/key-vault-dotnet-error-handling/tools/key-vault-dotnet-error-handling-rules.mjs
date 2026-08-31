import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const identityPackageVersion = "1.21.0";
const secretsPackageVersion = "4.11.0";
const sdkTypeNamespaces = new Map([
  ["DefaultAzureCredential", "Azure.Identity"],
  ["DeletedSecret", "Azure.Security.KeyVault.Secrets"],
  ["KeyVaultSecret", "Azure.Security.KeyVault.Secrets"],
  ["RequestFailedException", "Azure"],
  ["SecretClient", "Azure.Security.KeyVault.Secrets"],
  ["SecretClientOptions", "Azure.Security.KeyVault.Secrets"],
]);
const sdkTypes = [...sdkTypeNamespaces.keys()];
const operationNames = [
  "GetDeletedSecretAsync",
  "GetSecretAsync",
  "PurgeDeletedSecretAsync",
  "RecoverDeletedSecretAsync",
  "SetSecretAsync",
  "StartDeleteSecretAsync",
  "UpdateSecretPropertiesAsync",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      if (interpolated) {
        const text = value.replace(/\{[^{}]+\}/g, " ");
        literals.set(marker, text);
      } else {
        literals.set(marker, value);
      }
    }
    index = closeIndex;
  }
  return { code: characters.join(""), literals };
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
    const labels = [];
    let labelBraces = 0;
    let labelParentheses = 0;
    let labelBrackets = 0;
    for (let index = start; index < end; index += 1) {
      const character = characters[index];
      if (character === "{") labelBraces += 1;
      else if (character === "}") labelBraces -= 1;
      else if (character === "(") labelParentheses += 1;
      else if (character === ")") labelParentheses -= 1;
      else if (character === "[") labelBrackets += 1;
      else if (character === "]") labelBrackets -= 1;
      if (
        labelBraces === 0 &&
        labelParentheses === 0 &&
        labelBrackets === 0
      ) {
        const label = /^(?:case\b[^:]*|default)\s*:/.exec(
          characters.slice(index, end).join(""),
        );
        if (label) {
          labels.push({ start: index, end: index + label[0].length });
          index += label[0].length - 1;
        }
      }
    }
    if (labels.length > 0) {
      labels.forEach((label, index) =>
        maskTerminated(label.end, labels[index + 1]?.start ?? end)
      );
      return;
    }

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

function normalizeSdkTypes(source) {
  const { code, literals } = literalAwareCode(source);
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
      if (/\bCondition\s*=\s*["']\s*false\s*["']/i.test(property[2])) {
        continue;
      }
      properties.set(property[1].toLowerCase(), property[3].trim());
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
    const matches = references.filter(({ include }) =>
      include === name.toLowerCase()
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
          name: match[1],
          start: match.index,
        });
      }
    }
  }
  return results;
}

function analyzeBindings(source) {
  const retryConfigured = (text) =>
    /\bMaxRetries\s*=\s*[1-9]\d*/.test(text) &&
    /\b(?:Delay|MaxDelay|Mode|NetworkTimeout)\s*=/.test(text);

  const optionCandidates = constructorBindings(source, "SecretClientOptions");
  for (const match of source.matchAll(
    /\b(?:var|SdkSecretClientOptions)\s+(\w+)\s*=\s*new(?:\s+SdkSecretClientOptions)?\s*\{/g,
  )) {
    optionCandidates.push({
      arguments: "",
      name: match[1],
      start: match.index,
    });
  }
  const options = new Set();
  for (const option of optionCandidates) {
    const tail = source.slice(option.start, option.start + 1200);
    const initializerOpen = tail.indexOf("{");
    if (initializerOpen >= 0) {
      const initializerClose = matchingDelimiter(
        tail,
        initializerOpen,
        "{",
        "}",
      );
      const initializer =
        initializerClose >= 0
          ? tail.slice(initializerOpen + 1, initializerClose)
          : "";
      if (retryConfigured(initializer)) options.add(option.name);
    }
    const assignments = [
      ...source.matchAll(
        new RegExp(
          String.raw`\b${escapeRegExp(option.name)}\s*\.\s*Retry\s*\.\s*(MaxRetries|Delay|MaxDelay|Mode|NetworkTimeout)\s*=`,
          "g",
        ),
      ),
    ].map((match) => match[1]);
    if (
      assignments.includes("MaxRetries") &&
      assignments.some((name) => name !== "MaxRetries")
    ) {
      options.add(option.name);
    }
  }

  const credentials = new Set(
    constructorBindings(source, "DefaultAzureCredential").map(
      ({ name }) => name,
    ),
  );
  const clients = new Set();
  for (const client of constructorBindings(source, "SecretClient")) {
    const argumentsSource = splitArguments(client.arguments);
    const hasCredential = argumentsSource.some(
      (argument) =>
        credentials.has(argument.trim()) ||
        /\bnew\s+SdkDefaultAzureCredential\s*\(/.test(argument),
    );
    const hasOptions = argumentsSource.some((argument) =>
      options.has(argument.trim()) ||
      (
        /\bnew\s+SdkSecretClientOptions\b/.test(argument) &&
        retryConfigured(argument)
      )
    );
    if (hasCredential && hasOptions) {
      clients.add(client.name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(
      /\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*(\w+)\s*;/g,
    )) {
      if (clients.has(match[2]) && !clients.has(match[1])) {
        clients.add(match[1]);
        changed = true;
      }
      if (credentials.has(match[2]) && !credentials.has(match[1])) {
        credentials.add(match[1]);
        changed = true;
      }
      if (options.has(match[2]) && !options.has(match[1])) {
        options.add(match[1]);
        changed = true;
      }
    }
  }
  return { clients, credentials, options };
}

function operationsIn(source, bindings) {
  const operations = [];
  const operation = operationNames.join("|");
  for (const match of source.matchAll(
    new RegExp(
      String.raw`\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*await\s+(\w+)\s*\.\s*(${operation})(?:\s*<[^;{}()]+>)?\s*\(`,
      "g",
    ),
  )) {
    if (bindings.clients.has(match[2])) {
      operations.push({
        method: match[3],
        receiver: match[2],
        response: match[1],
      });
    }
  }
  for (const match of source.matchAll(
    new RegExp(
      String.raw`\bawait\s+(\w+)\s*\.\s*(${operation})(?:\s*<[^;{}()]+>)?\s*\(`,
      "g",
    ),
  )) {
    if (bindings.clients.has(match[1])) {
      operations.push({
        method: match[2],
        receiver: match[1],
        response: null,
      });
    }
  }
  return operations.filter(
    (candidate, index) =>
      operations.findIndex(
        (other) =>
          other.method === candidate.method &&
          other.receiver === candidate.receiver &&
          other.response === candidate.response,
      ) === index,
  );
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

const statusTokens = {
  403: String.raw`(?:HttpStatusCode\s*\.\s*Forbidden|\(\s*HttpStatusCode\s*\)\s*403|403)`,
  404: String.raw`(?:HttpStatusCode\s*\.\s*NotFound|\(\s*HttpStatusCode\s*\)\s*404|404)`,
  409: String.raw`(?:HttpStatusCode\s*\.\s*Conflict|\(\s*HttpStatusCode\s*\)\s*409|409)`,
  429: String.raw`(?:HttpStatusCode\s*\.\s*TooManyRequests|\(\s*HttpStatusCode\s*\)\s*429|429)`,
};

function requestFailureName(caught) {
  if (caught.type === "SdkRequestFailedException") return caught.name;
  if (!caught.name) return null;
  const match = new RegExp(
    String.raw`\b${escapeRegExp(caught.name)}\s+is\s+SdkRequestFailedException(?:\s+(\w+))?\b`,
  ).exec(caught.filter);
  return match?.[1] ?? (match ? caught.name : null);
}

function failureNames(caught) {
  const initial = requestFailureName(caught);
  if (!initial) return [];
  const names = new Set([initial]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of caught.body.matchAll(
      /\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*(\w+)\s*;/g,
    )) {
      if (names.has(match[2]) && !names.has(match[1])) {
        names.add(match[1]);
        changed = true;
      }
    }
  }
  return [...names];
}

function statusRegionForName(caught, status, failureName) {
  const name = escapeRegExp(failureName);
  const token = statusTokens[status];
  if (
    new RegExp(
      String.raw`\b${name}\s*\.\s*Status\b[\s\S]*?${token}|${token}[\s\S]*?\b${name}\s*\.\s*Status\b`,
    ).test(caught.filter)
  ) {
    return caught.body;
  }

  for (const switchMatch of caught.body.matchAll(
    new RegExp(
      String.raw`\bswitch\s*\(\s*${name}\s*\.\s*Status\s*\)\s*\{`,
      "g",
    ),
  )) {
    const open = caught.body.indexOf("{", switchMatch.index);
    const close = matchingDelimiter(caught.body, open, "{", "}");
    if (close < 0) continue;
    const switchBody = caught.body.slice(open + 1, close);
    const label = new RegExp(String.raw`\bcase\s+${token}\s*(?:when[^:]*)?:`);
    const match = label.exec(switchBody);
    if (!match) continue;
    const rest = switchBody.slice(match.index + match[0].length);
    const next = /\b(?:case\b[^:]*|default)\s*:/.exec(rest);
    return next ? rest.slice(0, next.index) : rest;
  }

  for (const ifMatch of caught.body.matchAll(/\bif\s*\(/g)) {
    const open = caught.body.indexOf("(", ifMatch.index);
    const close = matchingDelimiter(caught.body, open, "(", ")");
    if (close < 0) continue;
    const condition = caught.body.slice(open + 1, close);
    if (
      !new RegExp(
        String.raw`\b${name}\s*\.\s*Status\b[\s\S]*?${token}|${token}[\s\S]*?\b${name}\s*\.\s*Status\b`,
      ).test(condition)
    ) {
      continue;
    }
    let index = close + 1;
    while (/\s/.test(caught.body[index] ?? "")) index += 1;
    if (caught.body[index] === "{") {
      const block = blockAt(caught.body, index);
      if (block) return block.body;
    }
    const semicolon = caught.body.indexOf(";", index);
    if (semicolon >= 0) return caught.body.slice(index, semicolon + 1);
  }
  return null;
}

function statusRegion(caught, status) {
  for (const name of failureNames(caught)) {
    const region = statusRegionForName(caught, status, name);
    if (region !== null) return region;
  }
  return null;
}

function meaningfulStatusRegion(region) {
  return (
    region !== null &&
    /\b(?:Console|Debug|Trace|Log\w*)\b|\b(?:return|throw|continue)\b/.test(
      region,
    )
  );
}

function aliasesForProperty(source, object, property) {
  const aliases = new Set();
  const objectName = escapeRegExp(object);
  const propertyName = escapeRegExp(property);
  for (const match of source.matchAll(
    new RegExp(
      String.raw`\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*${objectName}\s*\.\s*${propertyName}\b`,
      "g",
    ),
  )) {
    aliases.add(match[1]);
  }
  return aliases;
}

function catchUsesProperty(caught, property) {
  return failureNames(caught).some((name) =>
    new RegExp(
      String.raw`\b${escapeRegExp(name)}\s*\.\s*${property}\b`,
    ).test(caught.body + caught.filter)
  );
}

function literalText(source, literals) {
  let text = "";
  for (const [marker, value] of literals) {
    if (source.includes(marker)) text += ` ${value}`;
  }
  for (const match of source.matchAll(
    /\b(?:var|string)\s+(\w+)\s*=\s*([^;]+);/g,
  )) {
    for (const [marker, value] of literals) {
      if (
        match[2].includes(marker) &&
        new RegExp(String.raw`\b${escapeRegExp(match[1])}\b`).test(source)
      ) {
        text += ` ${value}`;
      }
    }
  }
  return text.toLowerCase();
}

function diagnosticOutputText(region, literals) {
  let text = "";
  const pattern =
    /\b(?:(?:(?:(?:global::)?System\s*\.\s*)?Console(?:\s*\.\s*(?:Error|Out))?|(?:(?:global::)?System\s*\.\s*Diagnostics\s*\.\s*)?(?:Debug|Trace))\s*\.\s*(?:Write|WriteLine|Trace\w*)|\w+(?:\s*\.\s*\w+)*\s*\.\s*Log(?:Trace|Debug|Information|Warning|Error|Critical)?)\s*\(/g;
  for (const match of region.matchAll(pattern)) {
    const open = region.indexOf("(", match.index);
    const close = matchingDelimiter(region, open, "(", ")");
    if (close >= 0) {
      text += ` ${literalText(region.slice(open + 1, close), literals)}`;
    }
  }
  return text;
}

function outputHasTerms(region, literals, ...patterns) {
  const text = diagnosticOutputText(region, literals);
  return patterns.every((pattern) => pattern.test(text));
}

function workflowHasOperation(workflow, method) {
  return workflow.operations.some((operation) => operation.method === method);
}

function collectWorkflows(source, bindings, methods) {
  const workflows = [];
  for (const match of source.matchAll(/\btry\s*\{/g)) {
    const open = source.indexOf("{", match.index);
    const block = blockAt(source, open);
    if (!block) continue;
    const tryBody = expandInvocations(block.body, methods);
    const operations = operationsIn(tryBody, bindings);
    if (operations.length === 0) continue;
    const catches = attachedCatches(source, block.end)
      .filter((caught) => requestFailureName(caught) !== null)
      .map((caught) => ({
        ...caught,
        body: expandInvocations(caught.body, methods),
      }));
    if (catches.length === 0) continue;
    workflows.push({
      bindings,
      catches,
      methods,
      operations,
      source,
      tryBody,
      tryStart: match.index,
    });
  }
  return workflows;
}

function hasAccessDeniedDiagnosis(workflow, literals) {
  return workflow.catches.some((caught) => {
    const region = statusRegion(caught, 403);
    const expanded = region && expandInvocations(region, workflow.methods);
    return (
      meaningfulStatusRegion(region) &&
      outputHasTerms(
        expanded,
        literals,
        /\brbac\b/,
        /\baccess polic(?:y|ies)\b/,
      )
    );
  });
}

function hasVersionConflict(workflow, literals) {
  if (!workflowHasOperation(workflow, "SetSecretAsync")) return false;
  return workflow.catches.some((caught) => {
    const region = statusRegion(caught, 409);
    const expanded = region && expandInvocations(region, workflow.methods);
    return (
      meaningfulStatusRegion(region) &&
      outputHasTerms(
        expanded,
        literals,
        /\b(?:version|etag|concurr)/,
        /\b(?:conflict|race|changed)/,
      )
    );
  });
}

function hasThrottleHandling(workflow, literals) {
  return workflow.catches.some((caught) => {
    const region = statusRegion(caught, 429);
    const expanded = region && expandInvocations(region, workflow.methods);
    return (
      meaningfulStatusRegion(region) &&
      outputHasTerms(
        expanded,
        literals,
        /\b(?:throttl|rate limit|too many)/,
        /\b(?:retr|backoff|sdk)/,
      )
    );
  });
}

function hasNotFoundDiagnosis(workflow, literals) {
  if (!workflowHasOperation(workflow, "GetSecretAsync")) return false;
  const originalReceivers = new Set(
    workflow.operations
      .filter(({ method }) => method === "GetSecretAsync")
      .map(({ receiver }) => receiver),
  );
  for (const caught of workflow.catches) {
    const region = statusRegion(caught, 404);
    if (!meaningfulStatusRegion(region)) continue;
    const expanded = expandInvocations(region, workflow.methods);
    const nested = collectWorkflows(
      expanded,
      workflow.bindings,
      workflow.methods,
    );
    for (const candidate of nested) {
      const deletedLookup = candidate.operations.some(
        ({ method, receiver }) =>
          method === "GetDeletedSecretAsync" &&
          originalReceivers.has(receiver),
      );
      if (
        !deletedLookup ||
        !outputHasTerms(candidate.tryBody, literals, /\b(?:soft[- ]?deleted|deleted)\b/)
      ) {
        continue;
      }
      const missing = candidate.catches.some((nestedCatch) => {
        const missingRegion = statusRegion(nestedCatch, 404);
        return (
          meaningfulStatusRegion(missingRegion) &&
          outputHasTerms(
            missingRegion,
            literals,
            /\b(?:not found|does not exist|never existed|missing)\b/,
          )
        );
      });
      if (missing) return true;
    }
  }
  return false;
}

function hasSoftDeleteAndPurgeProtection(analysis) {
  const softDeletedName = analysis.workflows.some((workflow) => {
    if (!workflowHasOperation(workflow, "SetSecretAsync")) return false;
    return workflow.catches.some((caught) => {
      const region = statusRegion(caught, 409);
      const expanded = region && expandInvocations(region, workflow.methods);
      return (
        meaningfulStatusRegion(region) &&
        outputHasTerms(
          expanded,
          analysis.literals,
          /\b(?:soft[- ]?deleted|deleted)\b/,
          /\b(?:recoverable|recover)\b/,
        )
      );
    });
  });
  const purgeProtection = analysis.workflows.some((workflow) => {
    if (!workflowHasOperation(workflow, "PurgeDeletedSecretAsync")) {
      return false;
    }
    return workflow.catches.some((caught) =>
      [403, 409].some((status) => {
        const region = statusRegion(caught, status);
        const expanded = region && expandInvocations(
          region,
          workflow.methods,
        );
        return (
          meaningfulStatusRegion(region) &&
          outputHasTerms(
            expanded,
            analysis.literals,
            /\bpurge protection\b/,
          )
        );
      })
    );
  });
  return softDeletedName && purgeProtection;
}

function analyzeProject(project) {
  const normalized = normalizeSdkTypes(project.source);
  if (normalized === null) return null;
  const reachable = reachableSource(normalized.source);
  const bindings = analyzeBindings(reachable.source);
  const workflows = collectWorkflows(
    reachable.source,
    bindings,
    reachable.methods,
  );
  return { bindings, literals: normalized.literals, workflows };
}

const rules = {
  "prompt/key-vault-manifest": () => true,
  "prompt/configured-secret-client": ({ analysis }) =>
    analysis.bindings.clients.size > 0,
  "prompt/key-vault-operation": ({ analysis }) =>
    analysis.workflows.length > 0,
  "prompt/exception-details": ({ analysis }) =>
    analysis.workflows.some((workflow) =>
      ["Status", "ErrorCode"].every(
        (property) =>
          workflow.catches.some((caught) =>
            catchUsesProperty(caught, property)
          ),
      )
    ),
  "prompt/access-denied-diagnosis": ({ analysis }) =>
    analysis.workflows.some((workflow) =>
      hasAccessDeniedDiagnosis(workflow, analysis.literals)
    ),
  "prompt/not-found-vs-deleted": ({ analysis }) =>
    analysis.workflows.some((workflow) =>
      hasNotFoundDiagnosis(workflow, analysis.literals)
    ),
  "prompt/version-conflict": ({ analysis }) =>
    analysis.workflows.some((workflow) =>
      hasVersionConflict(workflow, analysis.literals)
    ),
  "prompt/throttling-retry": ({ analysis }) =>
    analysis.workflows.some((workflow) =>
      hasThrottleHandling(workflow, analysis.literals)
    ),
  "prompt/soft-delete-purge-protection": ({ analysis }) =>
    hasSoftDeleteAndPurgeProtection(analysis),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const projects = applicationProjects(workspace);
  if (projects.length === 0) return false;
  if (name === "prompt/key-vault-manifest") return true;
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
