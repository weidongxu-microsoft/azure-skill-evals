import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const cosmosPackageVersion = "3.62.1";
const cosmosNamespace = "Microsoft.Azure.Cosmos";
const sdkTypes = [
  "Container",
  "CosmosClient",
  "CosmosClientOptions",
  "CosmosException",
  "FeedResponse",
  "ItemResponse",
  "PartitionKey",
  "ResponseMessage",
];
const operationNames = [
  "CreateItemAsync",
  "DeleteItemAsync",
  "PatchItemAsync",
  "ReadItemAsync",
  "ReadNextAsync",
  "ReplaceItemAsync",
  "UpsertItemAsync",
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
  const code = dotnetCodeOnly(source);
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
      if (
        include?.trim().toLowerCase() === "microsoft.azure.cosmos" &&
        [cosmosPackageVersion, `[${cosmosPackageVersion}]`].includes(
          version?.trim(),
        ) &&
        !exclude.split(";").map((value) => value.trim().toLowerCase())
          .some((value) => value === "all" || value === "compile")
      ) {
        return true;
      }
    }
  }
  return false;
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
  const options = new Set();
  for (const match of source.matchAll(
    /\b(?:var|SdkCosmosClientOptions)\s+(\w+)\s*=\s*new(?:\s+SdkCosmosClientOptions)?(?:\s*\(\s*\))?\s*\{([\s\S]*?)\}/g,
  )) {
    if (
      /MaxRetryAttemptsOnRateLimitedRequests\s*=\s*[1-9]\d*/.test(match[2])
    ) {
      options.add(match[1]);
    }
  }
  for (const option of constructorBindings(source, "CosmosClientOptions")) {
    const tail = source.slice(option.start, option.start + 800);
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
      if (
        /MaxRetryAttemptsOnRateLimitedRequests\s*=\s*[1-9]\d*/.test(
          initializer,
        )
      ) {
        options.add(option.name);
      }
    }
  }
  for (const assignment of source.matchAll(
    /\b(\w+)\s*\.\s*MaxRetryAttemptsOnRateLimitedRequests\s*=\s*([1-9]\d*)\s*;/g,
  )) {
    options.add(assignment[1]);
  }

  const clients = new Set();
  for (const client of constructorBindings(source, "CosmosClient")) {
    const argumentsSource = splitArguments(client.arguments);
    if (
      argumentsSource.some((argument) => options.has(argument.trim())) ||
      /MaxRetryAttemptsOnRateLimitedRequests\s*=\s*[1-9]\d*/.test(
        client.arguments,
      )
    ) {
      clients.add(client.name);
    }
  }

  const databases = new Set();
  const containers = new Set();
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
      if (databases.has(match[2]) && !databases.has(match[1])) {
        databases.add(match[1]);
        changed = true;
      }
      if (containers.has(match[2]) && !containers.has(match[1])) {
        containers.add(match[1]);
        changed = true;
      }
    }
    for (const match of source.matchAll(
      /\b(?:var|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*(\w+)\s*\.\s*GetDatabase\s*\(/g,
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
  return { clients, containers, options };
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
    if (bindings.containers.has(match[2])) {
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
    if (bindings.containers.has(match[1])) {
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
  404: String.raw`(?:HttpStatusCode\s*\.\s*NotFound|\(\s*HttpStatusCode\s*\)\s*404|404)`,
  409: String.raw`(?:HttpStatusCode\s*\.\s*Conflict|\(\s*HttpStatusCode\s*\)\s*409|409)`,
  429: String.raw`(?:HttpStatusCode\s*\.\s*TooManyRequests|\(\s*HttpStatusCode\s*\)\s*429|429)`,
};

function statusRegion(caught, status) {
  if (!caught.name || caught.type !== "SdkCosmosException") return null;
  const name = escapeRegExp(caught.name);
  const token = statusTokens[status];
  if (
    new RegExp(
      String.raw`\b${name}\s*\.\s*StatusCode\b[\s\S]*?${token}|${token}[\s\S]*?\b${name}\s*\.\s*StatusCode\b`,
    ).test(caught.filter)
  ) {
    return caught.body;
  }

  for (const switchMatch of caught.body.matchAll(
    new RegExp(
      String.raw`\bswitch\s*\(\s*${name}\s*\.\s*StatusCode\s*\)\s*\{`,
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
        String.raw`\b${name}\s*\.\s*StatusCode\b[\s\S]*?${token}|${token}[\s\S]*?\b${name}\s*\.\s*StatusCode\b`,
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
  return (
    caught.name !== null &&
    new RegExp(
      String.raw`\b${escapeRegExp(caught.name)}\s*\.\s*${property}\b`,
    ).test(caught.body + caught.filter)
  );
}

function boundedLoopContaining(source, position) {
  for (const match of source.matchAll(/\b(for|while)\s*\(/g)) {
    const headerOpen = source.indexOf("(", match.index);
    const headerClose = matchingDelimiter(source, headerOpen, "(", ")");
    if (headerClose < 0) continue;
    let bodyOpen = headerClose + 1;
    while (/\s/.test(source[bodyOpen] ?? "")) bodyOpen += 1;
    if (source[bodyOpen] !== "{") continue;
    const bodyClose = matchingDelimiter(source, bodyOpen, "{", "}");
    if (!(bodyOpen < position && position < bodyClose)) continue;
    const header = source.slice(headerOpen + 1, headerClose);
    if (match[1] === "for") {
      const parts = header.split(";");
      if (parts.length === 3 && parts[1].trim() && !/^true$/i.test(parts[1].trim())) {
        return true;
      }
    } else if (
      header.trim() &&
      !/^true$/i.test(header.trim()) &&
      /\b(?:attempt|tries|retries|count|max)\w*\b/i.test(header)
    ) {
      return true;
    }
  }
  return false;
}

function hasRetry(workflow) {
  for (const caught of workflow.catches) {
    const region = statusRegion(caught, 429);
    if (!region || !caught.name) continue;
    const expanded = expandInvocations(region, workflow.methods);
    const aliases = aliasesForProperty(
      expanded,
      caught.name,
      "RetryAfter",
    );
    const delay = [...expanded.matchAll(
      /\bawait\s+(?:(?:global::)?System\s*\.\s*Threading\s*\.\s*Tasks\s*\.\s*)?Task\s*\.\s*Delay\s*\(/g,
    )].some((match) => {
      const open = expanded.indexOf("(", match.index);
      const close = matchingDelimiter(expanded, open, "(", ")");
      if (close < 0) return false;
      const argument = expanded.slice(open + 1, close);
      return (
        new RegExp(
          String.raw`\b${escapeRegExp(caught.name)}\s*\.\s*RetryAfter\b`,
        ).test(argument) ||
        [...aliases].some((alias) =>
          new RegExp(String.raw`\b${escapeRegExp(alias)}\b`).test(argument)
        )
      );
    });
    if (!delay) continue;

    if (
      /\bcontinue\s*;/.test(expanded) &&
      boundedLoopContaining(workflow.source, workflow.tryStart)
    ) {
      return true;
    }
    const repeated = operationsIn(expanded, workflow.bindings).some(
      (operation) =>
        workflow.operations.some(
          (original) =>
            original.receiver === operation.receiver &&
            original.method === operation.method,
        ),
    );
    if (repeated) return true;
  }
  return false;
}

function hasRequestCharge(workflow) {
  for (const operation of workflow.operations) {
    if (!operation.response) continue;
    const direct = new RegExp(
      String.raw`\b${escapeRegExp(operation.response)}\s*(?:\.\s*Headers)?\s*\.\s*RequestCharge\b`,
    );
    if (!direct.test(workflow.tryBody)) continue;
    const aliases = aliasesForProperty(
      workflow.tryBody,
      operation.response,
      "RequestCharge",
    );
    for (const invocation of workflow.tryBody.matchAll(
      /\b(?:Console(?:\s*\.\s*(?:Error|Out))?|Debug|Trace|\w+\s*\.\s*Log\w*)\s*\.\s*\w+\s*\(/g,
    )) {
      const open = workflow.tryBody.indexOf("(", invocation.index);
      const close = matchingDelimiter(workflow.tryBody, open, "(", ")");
      if (close < 0) continue;
      const argument = workflow.tryBody.slice(open + 1, close);
      if (
        direct.test(argument) ||
        [...aliases].some((alias) =>
          new RegExp(String.raw`\b${escapeRegExp(alias)}\b`).test(argument)
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function analyzeProject(project) {
  const normalized = normalizeSdkTypes(project.source);
  if (normalized === null) return null;
  const reachable = reachableSource(normalized);
  const bindings = analyzeBindings(reachable.source);
  const workflows = [];
  for (const match of reachable.source.matchAll(/\btry\s*\{/g)) {
    const open = reachable.source.indexOf("{", match.index);
    const block = blockAt(reachable.source, open);
    if (!block) continue;
    const tryBody = expandInvocations(block.body, reachable.methods);
    const operations = operationsIn(tryBody, bindings);
    if (operations.length === 0) continue;
    const catches = attachedCatches(reachable.source, block.end)
      .filter((caught) => caught.type === "SdkCosmosException")
      .map((caught) => ({
        ...caught,
        body: expandInvocations(caught.body, reachable.methods),
      }));
    if (catches.length === 0) continue;
    workflows.push({
      bindings,
      catches,
      methods: reachable.methods,
      operations,
      source: reachable.source,
      tryBody,
      tryStart: match.index,
    });
  }
  return { bindings, workflows };
}

const rules = {
  "prompt/cosmos-manifest": () => true,
  "prompt/client-retry-options": ({ analysis }) =>
    analysis.bindings.clients.size > 0,
  "prompt/cosmos-operation": ({ analysis }) =>
    analysis.workflows.length > 0,
  "prompt/exception-details": ({ analysis }) =>
    analysis.workflows.some((workflow) =>
      ["StatusCode", "SubStatusCode", "RetryAfter", "Diagnostics"].every(
        (property) =>
          workflow.catches.some((caught) =>
            catchUsesProperty(caught, property)
          ),
      )
    ),
  "prompt/throttling-retry": ({ analysis }) =>
    analysis.workflows.some((workflow) => hasRetry(workflow)),
  "prompt/not-found-conflict": ({ analysis }) =>
    analysis.workflows.some(
      (workflow) =>
        workflow.catches.some((caught) =>
          meaningfulStatusRegion(statusRegion(caught, 404))
        ) &&
        workflow.catches.some((caught) =>
          meaningfulStatusRegion(statusRegion(caught, 409))
        ),
    ),
  "prompt/request-charge": ({ analysis }) =>
    analysis.workflows.some((workflow) => hasRequestCharge(workflow)),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const projects = applicationProjects(workspace);
  if (projects.length === 0) return false;
  if (name === "prompt/cosmos-manifest") return true;
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
