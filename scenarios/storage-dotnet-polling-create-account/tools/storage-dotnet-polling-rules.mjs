import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const identityPackageVersion = "1.21.0";
const resourceManagerPackageVersion = "1.7.0";
const sdkTypeNamespaces = new Map([
  ["ArmClient", "Azure.ResourceManager"],
  ["ArmOperation", "Azure"],
  ["CancellationTokenSource", "System.Threading"],
  ["DefaultAzureCredential", "Azure.Identity"],
  ["OperationCanceledException", "System"],
  ["RequestFailedException", "Azure"],
  ["Response", "Azure"],
  ["ResourceGroupCollection", "Azure.ResourceManager.Resources"],
  ["ResourceGroupResource", "Azure.ResourceManager.Resources"],
  ["StorageAccountCollection", "Azure.ResourceManager.Storage"],
  ["StorageAccountCreateOrUpdateContent", "Azure.ResourceManager.Storage.Models"],
  ["StorageAccountResource", "Azure.ResourceManager.Storage"],
  ["StorageKind", "Azure.ResourceManager.Storage.Models"],
  ["StorageSku", "Azure.ResourceManager.Storage.Models"],
  ["StorageSkuName", "Azure.ResourceManager.Storage.Models"],
  ["SubscriptionResource", "Azure.ResourceManager.Resources"],
  ["WaitUntil", "Azure"],
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
          /^(?:\s*(?:return|throw|break|continue)\b|\s*(?:(?:global::)?System\s*\.\s*)?Environment\s*\.\s*Exit\s*\()/.test(
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
        new RegExp(
          String.raw`\b${escapeRegExp(parameter)}\b(?!\s*:)`,
          "g",
        ),
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
    exact(
      "Azure.ResourceManager.Storage",
      resourceManagerPackageVersion,
    )
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

function declarations(source) {
  return [...source.matchAll(
    /\b(var|Sdk\w+(?:\s*<[^;=]+>)?|[\w.:<>?[\]]+)\s+(\w+)\s*=\s*([^;]+);/g,
  )].map((match) => ({
    type: match[1].replace(/\s+/g, ""),
    name: match[2],
    expression: match[3].trim(),
    index: match.index,
  }));
}

function constructorExpression(expression, type, declaredType = "") {
  const explicit = new RegExp(String.raw`\bnew\s+Sdk${type}\s*\(`)
    .exec(expression);
  const targetTyped =
    declaredType.replace(/\s+/g, "").startsWith(`Sdk${type}`) &&
    /\bnew\s*\(/.exec(expression);
  const match = explicit ?? targetTyped;
  if (!match) return null;
  const open = expression.indexOf("(", match.index);
  const close = matchingDelimiter(expression, open, "(", ")");
  if (close < 0) return null;
  return {
    arguments: splitArguments(expression.slice(open + 1, close)),
    tail: expression.slice(close + 1),
  };
}

function constructorBindings(source, type) {
  return declarations(source).flatMap((declaration) => {
    const constructor = constructorExpression(
      declaration.expression,
      type,
      declaration.type,
    );
    return constructor ? [{ ...declaration, ...constructor }] : [];
  });
}

function addSetAliases(source, sets) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations(source)) {
      const direct = /^(\w+)$/.exec(declaration.expression)?.[1];
      if (!direct) continue;
      for (const values of sets) {
        if (values.has(direct) && !values.has(declaration.name)) {
          values.add(declaration.name);
          changed = true;
        }
      }
    }
  }
}

function addMapAliases(source, maps) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations(source)) {
      const direct = /^(\w+)$/.exec(declaration.expression)?.[1];
      if (!direct) continue;
      for (const values of maps) {
        if (values.has(direct) && !values.has(declaration.name)) {
          values.set(declaration.name, values.get(direct));
          changed = true;
        }
      }
    }
  }
}

function expressionUsesName(expression, name) {
  return new RegExp(String.raw`\b${escapeRegExp(name)}\b`).test(expression);
}

function receiverCalls(expression, receiver, method) {
  return new RegExp(
    String.raw`\b${escapeRegExp(receiver)}\s*\.\s*${method}\s*\(`,
  ).test(expression);
}

function inputBindings(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  const bindings = (name) => new Set(
    declarations(code)
      .filter(({ expression }) =>
        new RegExp(
      String.raw`\bEnvironment\s*\.\s*GetEnvironmentVariable\s*\(\s*"${name}"\s*\)`,
        ).test(expression)
      )
      .map(({ name: variable }) => variable),
  );
  const locations = bindings("AZURE_LOCATION");
  for (const declaration of declarations(code)) {
    if (
      locations.has(declaration.name) &&
      !/\?\?\s*"eastus"/.test(declaration.expression)
    ) {
      locations.delete(declaration.name);
    }
  }
  return {
    accountNames: bindings("AZURE_STORAGE_ACCOUNT_NAME"),
    locations,
    resourceGroupNames: bindings("AZURE_RESOURCE_GROUP_NAME"),
    subscriptionIds: bindings("AZURE_SUBSCRIPTION_ID"),
  };
}

function inputContract(inputs) {
  return Object.values(inputs).every((values) => values.size > 0);
}

function resourcePaths(source, inputs) {
  addSetAliases(source, Object.values(inputs));

  const credentials = new Set(
    constructorBindings(source, "DefaultAzureCredential").map(
      ({ name }) => name,
    ),
  );
  addSetAliases(source, [credentials]);

  const armClients = new Map();
  for (const client of constructorBindings(source, "ArmClient")) {
    const credential = client.arguments.find((argument) =>
      [...credentials].some((name) => expressionUsesName(argument, name))
    );
    const subscription = client.arguments.find((argument) =>
      [...inputs.subscriptionIds].some((name) =>
        expressionUsesName(argument, name)
      )
    );
    const credentialName = [...credentials].find((name) =>
      expressionUsesName(credential ?? "", name)
    );
    if (credentialName && subscription) {
      armClients.set(client.name, { credential: credentialName });
    }
  }
  addMapAliases(source, [armClients]);

  const subscriptions = new Map();
  for (const declaration of declarations(source)) {
    for (const [client, path] of armClients) {
      if (
        /\bawait\b/.test(declaration.expression) &&
        receiverCalls(
          declaration.expression,
          client,
          "GetDefaultSubscriptionAsync",
        )
      ) {
        subscriptions.set(declaration.name, path);
      }
    }
  }
  addMapAliases(source, [subscriptions]);

  const groupCollections = new Map();
  for (const declaration of declarations(source)) {
    for (const [subscription, path] of subscriptions) {
      if (
        receiverCalls(
          declaration.expression,
          subscription,
          "GetResourceGroups",
        )
      ) {
        groupCollections.set(declaration.name, path);
      }
    }
  }
  addMapAliases(source, [groupCollections]);

  const resourceGroups = new Map();
  for (const declaration of declarations(source)) {
    for (const [groups, path] of groupCollections) {
      if (
        /\bawait\b/.test(declaration.expression) &&
        /\.Value\b/.test(declaration.expression) &&
        receiverCalls(declaration.expression, groups, "GetAsync") &&
        [...inputs.resourceGroupNames].some((name) =>
          expressionUsesName(declaration.expression, name)
        )
      ) {
        resourceGroups.set(declaration.name, path);
      }
    }
  }
  addMapAliases(source, [resourceGroups]);

  const accountCollections = new Map();
  for (const declaration of declarations(source)) {
    for (const [group, path] of resourceGroups) {
      if (receiverCalls(declaration.expression, group, "GetStorageAccounts")) {
        accountCollections.set(declaration.name, path);
      }
    }
  }
  addMapAliases(source, [accountCollections]);

  return {
    accountCollections,
    armClients,
    credentials,
    inputs,
    resourceGroups,
    subscriptions,
  };
}

function validSkuBindings(source) {
  const result = new Set();
  for (const binding of constructorBindings(source, "StorageSku")) {
    if (
      binding.arguments.length >= 1 &&
      /\bSdkStorageSkuName\s*\.\s*StandardLrs\b/.test(
        binding.arguments[0],
      )
    ) {
      result.add(binding.name);
    }
  }
  addSetAliases(source, [result]);
  return result;
}

function namedArgument(expression) {
  const match = /^\s*(\w+)\s*:\s*([\s\S]+)$/.exec(expression);
  return match ? { name: match[1].toLowerCase(), value: match[2].trim() } : null;
}

function orderedArgument(argumentsSource, index, name) {
  const named = argumentsSource
    .map(namedArgument)
    .find((argument) => argument?.name === name.toLowerCase());
  if (named) return named.value;
  if (argumentsSource.some(namedArgument)) {
    return argumentsSource[index] && !namedArgument(argumentsSource[index])
      ? argumentsSource[index]
      : "";
  }
  return argumentsSource[index] ?? "";
}

function validContentBindings(source, skus, inputLocations) {
  const locations = new Set(inputLocations);
  addSetAliases(source, [locations]);
  const result = new Set();
  for (const binding of constructorBindings(
    source,
    "StorageAccountCreateOrUpdateContent",
  )) {
    const sku = orderedArgument(binding.arguments, 0, "sku");
    const kind = orderedArgument(binding.arguments, 1, "kind");
    const location = orderedArgument(binding.arguments, 2, "location");
    const validSku = [...skus].some((name) =>
      expressionUsesName(sku, name)
    ) ||
      (
        /\bnew\s+SdkStorageSku\s*\(/.test(sku) &&
        /\bSdkStorageSkuName\s*\.\s*StandardLrs\b/.test(sku)
      );
    if (
      validSku &&
      /\bSdkStorageKind\s*\.\s*StorageV2\b/.test(kind) &&
      [...locations].some((name) => expressionUsesName(location, name)) &&
      binding.arguments.length >= 3
    ) {
      result.add(binding.name);
    }
  }
  addSetAliases(source, [result]);
  return result;
}

function invocationArguments(expression, method) {
  const match = new RegExp(String.raw`\b${method}\s*\(`).exec(expression);
  if (!match) return null;
  const open = expression.indexOf("(", match.index);
  const close = matchingDelimiter(expression, open, "(", ")");
  return close < 0
    ? null
    : splitArguments(expression.slice(open + 1, close));
}

function createOperations(source, paths, contents) {
  const operations = new Map();
  for (const declaration of declarations(source)) {
    const receiver = /\b(\w+)\s*\.\s*CreateOrUpdateAsync\s*\(/.exec(
      declaration.expression,
    )?.[1];
    if (
      !receiver ||
      !paths.accountCollections.has(receiver) ||
      !/\bawait\b/.test(declaration.expression)
    ) {
      continue;
    }
    const args = invocationArguments(
      declaration.expression,
      "CreateOrUpdateAsync",
    );
    if (
      !args ||
      !/\bSdkWaitUntil\s*\.\s*Started\b/.test(
        orderedArgument(args, 0, "waitUntil"),
      )
    ) {
      continue;
    }
    const content = [...contents].find((name) =>
      expressionUsesName(
        orderedArgument(args, 2, "data"),
        name,
      )
    );
    const accountName = [...paths.inputs.accountNames].find((name) =>
      expressionUsesName(
        orderedArgument(args, 1, "name"),
        name,
      )
    );
    if (!content || !accountName) continue;
    operations.set(declaration.name, {
      ...paths.accountCollections.get(receiver),
      accountName,
      content,
      createIndex: declaration.index,
    });
  }
  addMapAliases(source, [operations]);
  return operations;
}

function timeoutTokens(source) {
  const timeoutSources = new Set();
  for (const binding of constructorBindings(source, "CancellationTokenSource")) {
    if (
      binding.arguments.length > 0 ||
      new RegExp(
        String.raw`\b${escapeRegExp(binding.name)}\s*\.\s*CancelAfter\s*\(\s*[^)]`,
      ).test(source)
    ) {
      timeoutSources.add(binding.name);
    }
  }
  addSetAliases(source, [timeoutSources]);

  const tokens = new Set();
  for (const declaration of declarations(source)) {
    if (
      [...timeoutSources].some((sourceName) =>
        new RegExp(
          String.raw`\b${escapeRegExp(sourceName)}\s*\.\s*Token\b`,
        ).test(declaration.expression)
      )
    ) {
      tokens.add(declaration.name);
    }
  }
  addSetAliases(source, [tokens]);
  return { timeoutSources, tokens };
}

function usesTimeoutToken(expression, timeouts) {
  return [...timeouts.tokens].some((name) =>
    expressionUsesName(expression, name)
  ) ||
    [...timeouts.timeoutSources].some((name) =>
      new RegExp(
        String.raw`\b${escapeRegExp(name)}\s*\.\s*Token\b`,
      ).test(expression)
    );
}

function manuallyPolledOperations(source, operations, timeouts) {
  const result = new Map();
  for (const [operation, path] of operations) {
    const escaped = escapeRegExp(operation);
    const loop = new RegExp(
      String.raw`\bwhile\s*\(\s*(?:!\s*${escaped}\s*\.\s*HasCompleted|${escaped}\s*\.\s*HasCompleted\s*==\s*false)\s*\)\s*\{`,
      "g",
    );
    for (const match of source.matchAll(loop)) {
      const open = source.indexOf("{", match.index);
      const close = matchingDelimiter(source, open, "{", "}");
      if (close < 0 || match.index <= path.createIndex) continue;
      const body = source.slice(open + 1, close);
      const update = new RegExp(
        String.raw`\bawait\s+${escaped}\s*\.\s*UpdateStatusAsync\s*\(`,
      ).exec(body);
      if (!update) continue;
      const args = invocationArguments(
        body.slice(update.index),
        "UpdateStatusAsync",
      );
      const token = orderedArgument(args ?? [], 0, "cancellationToken");
      if (!usesTimeoutToken(token, timeouts)) continue;
      result.set(operation, {
        ...path,
        pollEnd: close,
        pollIndex: match.index,
      });
      break;
    }
  }
  addMapAliases(source, [result]);
  return result;
}

function completedOperations(source, polled, timeouts) {
  const result = new Map();
  for (const [operation, path] of polled) {
    const pattern = new RegExp(
      String.raw`\bawait\s+${escapeRegExp(operation)}\s*\.\s*WaitForCompletionAsync\s*\(`,
      "g",
    );
    for (const match of source.matchAll(pattern)) {
      const args = invocationArguments(
        source.slice(match.index),
        "WaitForCompletionAsync",
      );
      const token = orderedArgument(args ?? [], 0, "cancellationToken");
      if (
        match.index > path.pollEnd &&
        usesTimeoutToken(token, timeouts)
      ) {
        result.set(operation, { ...path, waitIndex: match.index });
        break;
      }
    }
  }
  addMapAliases(source, [result]);
  return result;
}

function createdAccountBindings(source, completed) {
  const completionResponses = new Map();
  for (const declaration of declarations(source)) {
    for (const [operation, path] of completed) {
      if (
        new RegExp(
          String.raw`\bawait\s+${escapeRegExp(operation)}\s*\.\s*WaitForCompletionAsync\s*\(`,
        ).test(declaration.expression)
      ) {
        completionResponses.set(declaration.name, path);
      }
    }
  }
  addMapAliases(source, [completionResponses]);

  const result = new Map();
  for (const declaration of declarations(source)) {
    for (const [operation, path] of completed) {
      if (
        declaration.index > path.waitIndex &&
        new RegExp(
          String.raw`\b${escapeRegExp(operation)}\s*\.\s*Value\b`,
        ).test(declaration.expression)
      ) {
        result.set(declaration.name, path);
      }
    }
    for (const [response, path] of completionResponses) {
      if (
        new RegExp(
          String.raw`\b${escapeRegExp(response)}\s*\.\s*Value\b`,
        ).test(declaration.expression)
      ) {
        result.set(declaration.name, path);
      }
    }
    for (const [operation, path] of completed) {
      if (
        new RegExp(
          String.raw`\bawait\s+${escapeRegExp(operation)}\s*\.\s*WaitForCompletionAsync\s*\([^)]*\)\s*\)\s*\.\s*Value\b`,
        ).test(declaration.expression)
      ) {
        result.set(declaration.name, path);
      }
    }
  }
  addMapAliases(source, [result]);
  return result;
}

function consoleArguments(source) {
  const result = [];
  for (const match of source.matchAll(
    /\bConsole\s*(?:\.\s*(?:Out|Error))?\s*\.\s*Write(?:Line)?\s*\(/g,
  )) {
    const open = source.indexOf("(", match.index);
    const close = matchingDelimiter(source, open, "(", ")");
    if (close >= 0) {
      result.push({
        expression: source.slice(open + 1, close),
        index: match.index,
      });
    }
  }
  return result;
}

function outputCreatedAccount(source, accounts) {
  const output = consoleArguments(source);
  for (const [account, path] of accounts) {
    const after = output.filter(({ index }) => index > path.waitIndex);
    const name = new RegExp(
      String.raw`\b${escapeRegExp(account)}\s*\.\s*Data\s*\.\s*Name\b`,
    );
    const property = new RegExp(
      String.raw`\b${escapeRegExp(account)}\s*\.\s*Data\s*\.\s*(?:Location|Kind|Sku)\b`,
    );
    if (
      after.some(({ expression }) => name.test(expression)) &&
      after.some(({ expression }) => property.test(expression))
    ) {
      return true;
    }
  }
  return false;
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
      /^\s*(SdkRequestFailedException|SdkOperationCanceledException)\s+(\w+)\s*$/
        .exec(header[1]);
    const filtered =
      /\bis\s+(SdkRequestFailedException|SdkOperationCanceledException)\s+(\w+)\b/
        .exec(header[2] ?? "");
    if (direct || filtered) {
      catches.push({
        body: source.slice(open + 1, close),
        type: (direct ?? filtered)[1],
        variable: (direct ?? filtered)[2],
      });
    }
    cursor = close + 1;
  }
  return catches;
}

function usefulRequestCatch(caught) {
  const variable = escapeRegExp(caught.variable);
  return (
    caught.type === "SdkRequestFailedException" &&
    new RegExp(String.raw`\b${variable}\s*\.\s*Status\b`).test(caught.body) &&
    new RegExp(
      String.raw`\b${variable}\s*\.\s*(?:ErrorCode|Message)\b`,
    ).test(caught.body) &&
    (
      consoleArguments(caught.body).length > 0 ||
      /\bthrow\b/.test(caught.body)
    )
  );
}

function usefulTimeoutCatch(caught) {
  if (caught.type !== "SdkOperationCanceledException") return false;
  const variable = escapeRegExp(caught.variable);
  return (
    consoleArguments(caught.body).some(({ expression }) =>
      new RegExp(
        String.raw`\b${variable}\s*\.\s*(?:Message|CancellationToken)\b`,
      ).test(expression)
    ) ||
    new RegExp(String.raw`\bthrow\b`).test(caught.body)
  );
}

function creationIsHandled(source, operations, accounts) {
  for (const match of source.matchAll(/\btry\s*\{/g)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(source, open, "{", "}");
    if (close < 0) continue;
    const hasOperation = [...operations.values()].some(
      ({ createIndex }) => open < createIndex && createIndex < close,
    );
    const hasAccount = [...accounts.values()].some(
      ({ waitIndex }) => open < waitIndex && waitIndex < close,
    );
    const catches = catchesAfter(source, close);
    if (
      hasOperation &&
      hasAccount &&
      catches.some(usefulRequestCatch) &&
      catches.some(usefulTimeoutCatch)
    ) {
      return true;
    }
  }
  return false;
}

function analyzeProject(project) {
  const normalized = normalizeSdkTypes(project.source);
  if (normalized === null) return null;
  const reachable = reachableSource(normalized);
  const inputs = inputBindings(project.source);
  const paths = resourcePaths(reachable.source, inputs);
  const skus = validSkuBindings(reachable.source);
  const contents = validContentBindings(
    reachable.source,
    skus,
    inputs.locations,
  );
  const operations = createOperations(reachable.source, paths, contents);
  const timeouts = timeoutTokens(reachable.source);
  const polled = manuallyPolledOperations(
    reachable.source,
    operations,
    timeouts,
  );
  const completed = completedOperations(
    reachable.source,
    polled,
    timeouts,
  );
  const accounts = createdAccountBindings(reachable.source, completed);
  return {
    accounts,
    completed,
    contents,
    inputContract: inputContract(inputs),
    operations,
    paths,
    polled,
    source: reachable.source,
    timeouts,
  };
}

const rules = {
  "prompt/storage-manifest": () => true,
  "prompt/credential-resource-path": ({ inputContract: inputs, paths }) =>
    inputs &&
    paths.credentials.size > 0 &&
    paths.armClients.size > 0 &&
    paths.subscriptions.size > 0 &&
    paths.resourceGroups.size > 0 &&
    paths.accountCollections.size > 0,
  "prompt/storage-account-content": ({ contents }) => contents.size > 0,
  "prompt/create-started-operation": ({ operations }) => operations.size > 0,
  "prompt/connected-manual-polling": ({ polled }) => polled.size > 0,
  "prompt/exact-operation-completion": ({ accounts, completed }) =>
    completed.size > 0 && accounts.size > 0,
  "prompt/created-account-output": ({ accounts, source }) =>
    outputCreatedAccount(source, accounts),
  "prompt/timeout-request-errors": ({ accounts, operations, source }) =>
    creationIsHandled(source, operations, accounts),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const projects = applicationProjects(workspace);
  if (projects.length === 0) return false;
  if (name === "prompt/storage-manifest") return true;
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
