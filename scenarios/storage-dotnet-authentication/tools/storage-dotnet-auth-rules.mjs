import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const defaultCredentialType =
  String.raw`(?:global::)?(?:Azure\.Identity\.)?DefaultAzureCredential`;
const tokenCredentialType =
  String.raw`(?:global::)?(?:Azure\.Core\.)?TokenCredential`;
const blobServiceClientType =
  String.raw`(?:global::)?(?:Azure\.Storage\.Blobs\.)?BlobServiceClient`;
const authenticatedOperation =
  String.raw`(?:GetAccountInfoAsync|GetPropertiesAsync)`;
const endpointSetting = "AZURE_STORAGE_BLOB_ENDPOINT_SETTING";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripXmlComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, " ");
}

function hasTopLevelType(source, type) {
  const pattern = new RegExp(
    String.raw`\b(?:class|record|struct|interface|enum)\s+${escapeRegExp(type)}\b`,
    "g",
  );
  let depth = 0;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    for (const character of source.slice(cursor, match.index)) {
      if (character === "{") depth += 1;
      else if (character === "}") depth = Math.max(0, depth - 1);
    }
    if (depth === 0) return true;
    cursor = match.index + match[0].length;
  }
  return false;
}

function namespaceDeclarations(source) {
  const declarations = [];
  for (const match of source.matchAll(
    /\bnamespace\s+([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*([;{])/g,
  )) {
    const name = match[1].replace(/\s+/g, "");
    if (match[2] === ";") {
      declarations.push({
        name,
        declarationStart: match.index,
        bodyStart: match.index + match[0].length,
        bodyEnd: source.length,
        block: false,
      });
      continue;
    }
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(source, open, "{", "}");
    if (close >= 0) {
      declarations.push({
        name,
        declarationStart: match.index,
        bodyStart: open + 1,
        bodyEnd: close,
        block: true,
      });
    }
  }

  declarations.sort(
    (left, right) => left.declarationStart - right.declarationStart,
  );
  for (const declaration of declarations) {
    const parent = declarations
      .filter(
        (candidate) =>
          candidate !== declaration &&
          candidate.block &&
          candidate.bodyStart <= declaration.declarationStart &&
          declaration.declarationStart < candidate.bodyEnd,
      )
      .sort(
        (left, right) =>
          (left.bodyEnd - left.bodyStart) -
          (right.bodyEnd - right.bodyStart),
      )[0];
    declaration.fullName = parent
      ? `${parent.fullName}.${declaration.name}`
      : declaration.name;
  }
  return declarations;
}

function locallyDeclaredSdkTypes(source, sdkTypes) {
  const declared = new Set();
  const namespaces = namespaceDeclarations(source);
  for (const [simple, namespace] of sdkTypes) {
    for (const declaration of namespaces) {
      if (
        declaration.fullName === namespace &&
        hasTopLevelType(
          source.slice(declaration.bodyStart, declaration.bodyEnd),
          simple,
        )
      ) {
        declared.add(`${namespace}.${simple}`);
      }
    }
  }
  return declared;
}

function normalizeSdkTypes(source) {
  const imports = new Set(
    [...source.matchAll(
      /\b(?:global\s+)?using\s+((?:global::)?[\w.]+)\s*;/g,
    )].map((match) => match[1].replace(/^global::/, "")),
  );
  const aliases = new Map(
    [...source.matchAll(
      /\b(?:global\s+)?using\s+(\w+)\s*=\s*((?:global::)?[\w.]+)\s*;/g,
    )].map((match) => [match[1], match[2].replace(/^global::/, "")]),
  );
  const localTypes = new Set(
    [...source.matchAll(
      /\b(?:class|record|struct|interface|enum)\s+(\w+)/g,
    )].map((match) => match[1]),
  );
  const sdkTypes = new Map([
    ["DefaultAzureCredential", "Azure.Identity"],
    ["CredentialUnavailableException", "Azure.Identity"],
    ["AuthenticationFailedException", "Azure.Identity"],
    ["BlobServiceClient", "Azure.Storage.Blobs"],
    ["Uri", "System"],
  ]);
  const localSdkTypes = locallyDeclaredSdkTypes(source, sdkTypes);

  let normalized = source;
  for (const [alias, target] of aliases) {
    const simple = target.split(".").at(-1);
    const namespace = target.slice(0, -(simple.length + 1));
    if (sdkTypes.get(simple) === namespace) {
      normalized = normalized.replace(
        new RegExp(String.raw`\b${escapeRegExp(alias)}\b`, "g"),
        `${namespace}.${simple}`,
      );
    } else if ([...sdkTypes].some(([name]) => name === alias)) {
      normalized = normalized.replace(
        new RegExp(String.raw`\b${escapeRegExp(alias)}\b`, "g"),
        `Invalid${alias}`,
      );
    }
  }
  for (const [alias, target] of aliases) {
    for (const [simple, namespace] of sdkTypes) {
      if (target === namespace) {
        normalized = normalized.replace(
          new RegExp(
            String.raw`\b${escapeRegExp(alias)}\s*\.\s*${simple}\b`,
            "g",
          ),
          `${namespace}.${simple}`,
        );
      }
    }
  }
  for (const [simple, namespace] of sdkTypes) {
    if (localSdkTypes.has(`${namespace}.${simple}`)) {
      normalized = normalized.replace(
        new RegExp(
          String.raw`(?<![\w.])(?:global::)?${escapeRegExp(namespace)}\s*\.\s*${escapeRegExp(simple)}\b`,
          "g",
        ),
        `Invalid${simple}`,
      );
    }
    if (
      simple !== "Uri" &&
      (!imports.has(namespace) || localTypes.has(simple))
    ) {
      normalized = normalized.replace(
        new RegExp(
          String.raw`(?<![\w.:])${escapeRegExp(simple)}\b`,
          "g",
        ),
        `Invalid${simple}`,
      );
    }
    if (simple === "Uri" && localTypes.has(simple)) {
      normalized = normalized.replace(
        /(?<![\w.:])Uri\b/g,
        "InvalidUri",
      );
    }
  }
  return normalized.replace(/\b(?:global::)?System\s*\.\s*Uri\b/g, "Uri");
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== "\n") characters[index] = " ";
  }
}

function withoutDeadCode(source) {
  const characters = [...source];
  const blockPatterns = [
    /\b(?:if|while)\s*\(\s*false\s*\)\s*\{/g,
    /\bfor\s*\([^;]*;\s*false\s*;[^)]*\)\s*\{/g,
  ];
  for (const pattern of blockPatterns) {
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

  const maskTerminatedRegion = (start, end) => {
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
        maskTerminatedRegion(index + 1, close);
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
  maskTerminatedRegion(0, characters.length);
  return characters.join("");
}

function normalizeTryCreate(source) {
  return source
    .replace(
    /\bif\s*\(\s*!\s*Uri\s*\.\s*TryCreate\s*\(\s*(\w+)\s*,\s*UriKind\s*\.\s*Absolute\s*,\s*out\s+(?:(?:var|Uri\??)\s+)?(\w+)\s*\)\s*\)\s*\{/g,
    "Uri $2 = new Uri($1, UriKind.Absolute); if (false) {",
    )
    .replace(
      /\bif\s*\(\s*Uri\s*\.\s*TryCreate\s*\(\s*(\w+)\s*,\s*UriKind\s*\.\s*Absolute\s*,\s*out\s+(?:(?:var|Uri\??)\s+)?(\w+)\s*\)\s*\)\s*\{/g,
      "{ Uri $2 = new Uri($1, UriKind.Absolute);",
    );
}

function resolveEndpointSettingConstants(source) {
  const resolved = new Set();
  let previousSize = -1;
  while (resolved.size !== previousSize) {
    previousSize = resolved.size;
    for (const match of source.matchAll(
      /\bconst\s+string\s+(\w+)\s*=\s*(\w+)\s*;/g,
    )) {
      if (
        match[2] === endpointSetting ||
        resolved.has(match[2])
      ) {
        resolved.add(match[1]);
      }
    }
  }
  if (resolved.size === 0) return source;
  const aliases = [...resolved].map(escapeRegExp).join("|");
  return source.replace(
    new RegExp(
      String.raw`((?:global::)?(?:System\s*\.\s*)?Environment\s*\.\s*GetEnvironmentVariable\s*\(\s*)(?:${aliases})(\s*\))`,
      "g",
    ),
    `$1${endpointSetting}$2`,
  );
}

function matchingDelimiter(source, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) {
      depth += 1;
    } else if (source[index] === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }

    }
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
  const methodPattern =
    /\b((?:(?:public|private|protected|internal|static|async|virtual|sealed|new|unsafe)\s+)*)((?:(?:(?:global::)?System\.Threading\.Tasks\.)?Task(?:\s*<[^>{}]+>)?|ValueTask(?:\s*<[^>{}]+>)?|void|int|string|bool|[A-Z]\w*(?:\s*<[^>{}]+>)?))\s+(\w+)\s*\(([^;{}]*)\)\s*\{/g;

  for (const match of source.matchAll(methodPattern)) {
    const openIndex = source.indexOf("{", match.index);
    const closeIndex = matchingDelimiter(source, openIndex, "{", "}");
    if (closeIndex >= 0) {
      methods.push({
        modifiers: match[1].trim().split(/\s+/).filter(Boolean),
        returnType: match[2].replace(/\s+/g, ""),
        name: match[3],
        parametersSource: match[4],
        parameterSources: splitArguments(match[4]),
        parameters: splitArguments(match[4])
          .map((parameter) =>
            /(?:^|\s)(\w+)\s*(?:=[\s\S]*)?$/.exec(parameter.trim())?.[1]
          )
          .filter(Boolean),
        start: match.index,
        bodyStart: openIndex + 1,
        bodyEnd: closeIndex,
        end: closeIndex + 1,
        body: source.slice(openIndex + 1, closeIndex),
      });
    }
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
          (left.end - left.start) - (right.end - right.start),
      )[0] ?? null;
    method.type = types
      .filter(
        (type) =>
          type.bodyStart <= method.start && method.end <= type.bodyEnd,
      )
      .sort(
        (left, right) =>
          (left.end - left.start) - (right.end - right.start),
      )[0] ?? null;
    method.id = `${method.start}:${method.returnType}:${method.name}(${method.parameterSources.join(",")})`;
  }
  return methods;
}

function maskedMethodBody(source, method, methods) {
  const characters = [...method.body];
  for (const nested of methods) {
    if (
      nested === method ||
      nested.start < method.bodyStart ||
      nested.end > method.bodyEnd
    ) {
      continue;
    }
    maskRange(
      characters,
      nested.start - method.bodyStart,
      nested.end - method.bodyStart,
    );
  }
  return withoutDeadCode(characters.join(""));
}

function invocationAccepts(method, argumentsSource) {
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

function methodAncestors(method) {
  const ancestors = [];
  let current = method;
  while (current !== null) {
    ancestors.push(current);
    current = current.parentMethod;
  }
  return ancestors;
}

function visibleMethods(methods, context, qualifier) {
  if (context === null) {
    return methods.filter((method) =>
      qualifier
        ? method.parentMethod === null &&
          method.type?.name === qualifier &&
          method.modifiers.includes("static")
        : method.parentMethod === null && method.type === null
    );
  }

  const ancestors = new Set(methodAncestors(context));
  return methods.filter((method) => {
    if (method.parentMethod !== null) {
      return !qualifier && ancestors.has(method.parentMethod);
    }
    if (context.type === null) {
      return !qualifier && method.type === null;
    }
    if (method.type !== context.type) return false;
    if (qualifier) {
      return qualifier === context.type.name
        ? method.modifiers.includes("static")
        : qualifier === "this" && !method.modifiers.includes("static");
    }
    return (
      !context.modifiers.includes("static") ||
      method.modifiers.includes("static")
    );
  });
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

  root = withoutDeadCode(root);
  const output = [root];
  const queue = [];
  const expansions = new Set();
  const enqueue = (method, argumentsSource = []) => {
    const key = `${method.id}:${JSON.stringify(argumentsSource)}`;
    if (expansions.has(key)) return;
    expansions.add(key);
    const bindings = method.parameters
      .map((parameter, index) =>
        argumentsSource[index]
          ? `var ${parameter} = ${argumentsSource[index]};`
          : ""
      )
      .filter(Boolean)
      .join("\n");
    const expanded = `${bindings}\n${maskedMethodBody(source, method, methods)}`;
    output.push(expanded);
    queue.push({ method, source: expanded });
  };
  const enqueueInvocations = (search, context) => {
    for (const invocation of search.matchAll(
      /\b(?:(\w+)\s*\.\s*)?(\w+)\s*(?:<[^;{}()]+>)?\s*\(/g,
    )) {
      const open = search.indexOf("(", invocation.index);
      const close = matchingDelimiter(search, open, "(", ")");
      if (close < 0) continue;
      const argumentsSource = splitArguments(search.slice(open + 1, close));
      for (const method of visibleMethods(methods, context, invocation[1])) {
        if (
          method.name === invocation[2] &&
          invocationAccepts(method, argumentsSource)
        ) {
          enqueue(method, argumentsSource);
        }
      }
    }
  };

  for (const method of methods.filter(
    (candidate) =>
      candidate.parentMethod === null &&
      candidate.type !== null &&
      isExecutableMain(candidate),
  )) {
    enqueue(method);
  }
  enqueueInvocations(root, null);
  for (let index = 0; index < queue.length; index += 1) {
    enqueueInvocations(queue[index].source, queue[index].method);
  }
  return output.join("\n");
}

function constructorDeclarations(source, type, declaredTypes = [type]) {
  const results = [];
  const explicit = new RegExp(
    String.raw`\b(?:var|${declaredTypes.join("|")})\s+(\w+)\s*=\s*new\s+${type}\s*\(`,
    "g",
  );
  const targetTyped = new RegExp(
    String.raw`\b(?:${declaredTypes.join("|")})\s+(\w+)\s*=\s*new\s*\(`,
    "g",
  );

  for (const pattern of [explicit, targetTyped]) {
    for (const match of source.matchAll(pattern)) {
      const openIndex = match.index + match[0].lastIndexOf("(");
      const closeIndex = matchingDelimiter(source, openIndex, "(", ")");
      if (closeIndex >= 0) {
        results.push({
          name: match[1],
          arguments: source.slice(openIndex + 1, closeIndex),
          start: match.index,
          end: closeIndex + 1,
        });
      }
    }
  }

  return results.filter(
    (candidate, index) =>
      results.findIndex(
        (other) =>
          other.name === candidate.name && other.start === candidate.start,
      ) === index,
  );
}

function credentialDeclarations(source) {
  return constructorDeclarations(source, defaultCredentialType, [
    defaultCredentialType,
    tokenCredentialType,
  ]);
}

function lookupBinding(scopes, name) {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) {
      return scopes[index].get(name);
    }
  }
  return null;
}

function aliasBinding(expression, scopes) {
  const alias = /^\s*\(?\s*(\w+)(?:\s*\.\s*\w+)*\s*\)?\s*$/.exec(
    expression,
  );
  return alias === null ? null : lookupBinding(scopes, alias[1]);
}

function operationProvenance(expression, scopes) {
  for (const match of expression.matchAll(
    new RegExp(
      String.raw`\bawait\s+(\w+)\s*\.\s*${authenticatedOperation}\s*\(`,
      "g",
    ),
  )) {
    const binding = lookupBinding(scopes, match[1]);
    if (
      binding?.kind === "client" &&
      binding.credentialProvenance &&
      binding.endpointProvenance
    ) {
      return true;
    }
  }
  return false;
}

function credentialProvenance(expression, scopes, targetTyped = false) {
  if (
    new RegExp(String.raw`\bnew\s+${defaultCredentialType}\s*\(`).test(
      expression,
    ) ||
    (targetTyped && /^\s*new\s*\(/.test(expression))
  ) {
    return true;
  }
  const alias = aliasBinding(expression, scopes);
  return alias?.kind === "credential" && alias.provenance;
}

function constructorArguments(expression, type, targetTyped = false) {
  const pattern = targetTyped
    ? /^\s*new\s*\(/
    : new RegExp(String.raw`^\s*new\s+${type}\s*\(`);
  const match = pattern.exec(expression);
  if (match === null) {
    return null;
  }
  const openIndex = expression.indexOf("(", match.index);
  const closeIndex = matchingDelimiter(expression, openIndex, "(", ")");
  return closeIndex < 0
    ? null
    : expression.slice(openIndex + 1, closeIndex);
}

function clientProvenance(expression, scopes, targetTyped = false) {
  const argumentsSource = constructorArguments(
    expression,
    blobServiceClientType,
    targetTyped,
  );
  if (argumentsSource === null) {
    const alias = aliasBinding(expression, scopes);
    return alias?.kind === "client"
      ? {
          credential: alias.credentialProvenance,
          endpoint: alias.endpointProvenance,
        }
      : { credential: false, endpoint: false };
  }
  const credential =
    new RegExp(String.raw`\bnew\s+${defaultCredentialType}\s*\(`).test(
      argumentsSource,
    ) ||
    (argumentsSource.match(/\b\w+\b/g) ?? []).some((name) => {
      const binding = lookupBinding(scopes, name);
      return binding?.kind === "credential" && binding.provenance;
    });
  const endpoint = (argumentsSource.match(/\b\w+\b/g) ?? []).some((name) => {
    const binding = lookupBinding(scopes, name);
    return binding?.kind === "endpoint" && binding.provenance;
  });
  return { credential, endpoint };
}

function valueProvenance(expression, scopes) {
  if (operationProvenance(expression, scopes)) {
    return true;
  }
  const alias = aliasBinding(expression, scopes);
  return alias?.kind === "value" && alias.provenance;
}

function bind(scopes, name, binding, declaration) {
  if (declaration) {
    scopes.at(-1).set(name, binding);
    return;
  }

  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    if (scopes[index].has(name)) {
      scopes[index].set(name, binding);
      return;
    }
  }
  scopes.at(-1).set(name, binding);
}

function inferredBinding(expression, scopes) {
  if (
    new RegExp(String.raw`^\s*new\s+${defaultCredentialType}\s*\(`).test(
      expression,
    )
  ) {
    return {
      kind: "credential",
      provenance: credentialProvenance(expression, scopes),
    };
  }
  if (
    new RegExp(String.raw`^\s*new\s+${blobServiceClientType}\s*\(`).test(
      expression,
    )
  ) {
    const provenance = clientProvenance(expression, scopes);
    return {
      kind: "client",
      credentialProvenance: provenance.credential,
      endpointProvenance: provenance.endpoint,
    };
  }
  const alias = aliasBinding(expression, scopes);
  if (alias !== null) {
    return { ...alias };
  }
  return {
    kind: "value",
    provenance: valueProvenance(expression, scopes),
  };
}

function outputHasProvenance(expression, scopes) {
  if (operationProvenance(expression, scopes)) {
    return true;
  }
  const identifiers = expression.match(/\b\w+\b/g) ?? [];
  return identifiers.some((name) => {
    const binding = lookupBinding(scopes, name);
    return binding?.kind === "value" && binding.provenance;
  });
}

function processIdentityStatement(statement, state) {
  const { scopes } = state;
  const tryCreate = new RegExp(
    String.raw`\bUri\s*\.\s*TryCreate\s*\(\s*(\w+)\s*,\s*UriKind\s*\.\s*Absolute\s*,\s*out\s+(?:(?:var|Uri\??)\s+)?(\w+)\s*\)`,
  ).exec(statement);
  if (tryCreate !== null) {
    const input = lookupBinding(scopes, tryCreate[1]);
    const provenance = input?.kind === "setting" && input.provenance;
    bind(
      scopes,
      tryCreate[2],
      {
        kind: "endpoint",
        provenance,
      },
      true,
    );
    state.endpointFound ||= provenance;
  }
  const output =
    /\bConsole\s*\.\s*(?:Write|WriteLine)\s*\(([\s\S]*)\)\s*$/.exec(
      statement,
    );
  if (output !== null) {
    state.outputFound ||= outputHasProvenance(output[1], scopes);
    return;
  }

  const credentialDeclaration = new RegExp(
    String.raw`^\s*(?:using\s+)?(${defaultCredentialType}|${tokenCredentialType})\s+(\w+)\s*=\s*([\s\S]+)$`,
  ).exec(statement);
  if (credentialDeclaration !== null) {
    bind(
      scopes,
      credentialDeclaration[2],
      {
        kind: "credential",
        provenance: credentialProvenance(
          credentialDeclaration[3],
          scopes,
          credentialDeclaration[1].endsWith("DefaultAzureCredential"),
        ),
      },
      true,
    );
    return;
  }

  const settingDeclaration =
    new RegExp(
      String.raw`^\s*(?:string\s*\?|string|var)\s+(\w+)\s*=\s*Environment\s*\.\s*GetEnvironmentVariable\s*\(\s*${endpointSetting}\s*\)\s*!?(?:\s*\?\?[\s\S]+)?$`,
    ).exec(statement);
  if (settingDeclaration !== null) {
    bind(
      scopes,
      settingDeclaration[1],
      { kind: "setting", provenance: true },
      true,
    );
    return;
  }

  const endpointDeclaration =
    /^\s*(?:Uri|var)\s+(\w+)\s*=\s*new\s+Uri\s*\(\s*(\w+)\s*!?\s*,\s*UriKind\s*\.\s*Absolute\s*\)$/.exec(
      statement,
    );
  if (endpointDeclaration !== null) {
    const input = lookupBinding(scopes, endpointDeclaration[2]);
    const provenance = input?.kind === "setting" && input.provenance;
    bind(
      scopes,
      endpointDeclaration[1],
      {
        kind: "endpoint",
        provenance,
      },
      true,
    );
    state.endpointFound ||= provenance;
    return;
  }

  const clientDeclaration = new RegExp(
    String.raw`^\s*(?:using\s+)?${blobServiceClientType}\s+(\w+)\s*=\s*([\s\S]+)$`,
  ).exec(statement);
  if (clientDeclaration !== null) {
    const provenance = clientProvenance(
      clientDeclaration[2],
      scopes,
      true,
    );
    bind(
      scopes,
      clientDeclaration[1],
      {
        kind: "client",
        credentialProvenance: provenance.credential,
        endpointProvenance: provenance.endpoint,
      },
      true,
    );
    state.associationFound ||=
      provenance.credential && provenance.endpoint;
    return;
  }

  const variableDeclaration =
    /^\s*(?:using\s+)?var\s+(\w+)\s*=\s*([\s\S]+)$/.exec(statement);
  if (variableDeclaration !== null) {
    const binding = inferredBinding(variableDeclaration[2], scopes);
    bind(scopes, variableDeclaration[1], binding, true);
    if (binding.kind === "client") {
      state.associationFound ||=
        binding.credentialProvenance && binding.endpointProvenance;
    }
    return;
  }

  const valueDeclaration = new RegExp(
    String.raw`^\s*(?:(?:global::)?(?:Azure\.)?Response\s*<[^;=]+>|(?:global::)?(?:Azure\.Storage\.Blobs\.Models\.)?AccountInfo)\s+(\w+)\s*=\s*([\s\S]+)$`,
  ).exec(statement);
  if (valueDeclaration !== null) {
    bind(
      scopes,
      valueDeclaration[1],
      {
        kind: "value",
        provenance: valueProvenance(valueDeclaration[2], scopes),
      },
      true,
    );
    return;
  }

  const assignment = /^\s*(\w+)\s*=\s*([\s\S]+)$/.exec(statement);
  if (assignment === null) {
    return;
  }
  const previous = lookupBinding(scopes, assignment[1]);
  let binding;
  if (previous?.kind === "credential") {
    binding = {
      kind: "credential",
      provenance: credentialProvenance(assignment[2], scopes),
    };
  } else if (previous?.kind === "client") {
    const provenance = clientProvenance(assignment[2], scopes);
    binding = {
      kind: "client",
      credentialProvenance: provenance.credential,
      endpointProvenance: provenance.endpoint,
    };
    state.associationFound ||=
      binding.credentialProvenance && binding.endpointProvenance;
  } else if (previous?.kind === "value") {
    binding = {
      kind: "value",
      provenance: valueProvenance(assignment[2], scopes),
    };
  } else {
    binding = inferredBinding(assignment[2], scopes);
  }
  bind(scopes, assignment[1], binding, false);
}

function analyzeIdentityBindings(source) {
  const state = {
    scopes: [new Map()],
    associationFound: false,
    endpointFound: false,
    outputFound: false,
  };
  let statement = "";
  let parentheses = 0;
  let brackets = 0;
  let initializerBraces = 0;

  for (const character of source) {
    if (character === "(") {
      parentheses += 1;
      statement += character;
    } else if (character === ")") {
      parentheses = Math.max(0, parentheses - 1);
      statement += character;
    } else if (character === "[") {
      brackets += 1;
      statement += character;
    } else if (character === "]") {
      brackets = Math.max(0, brackets - 1);
      statement += character;
    } else if (character === "{") {
      const initializer =
        parentheses > 0 ||
        brackets > 0 ||
        (initializerBraces > 0) ||
        (/=/.test(statement) && /\bnew\b/.test(statement));
      if (initializer) {
        initializerBraces += 1;
        statement += character;
      } else {
        statement = "";
        state.scopes.push(new Map());
      }
    } else if (character === "}") {
      if (initializerBraces > 0) {
        initializerBraces -= 1;
        statement += character;
      } else {
        statement = "";
        if (state.scopes.length > 1) {
          state.scopes.pop();
        }
      }
    } else if (
      character === ";" &&
      parentheses === 0 &&
      brackets === 0 &&
      initializerBraces === 0
    ) {
      processIdentityStatement(statement, state);
      statement = "";
    } else {
      statement += character;
    }
  }
  return state;
}

function accountOperation(source) {
  return analyzeIdentityBindings(source).outputFound;
}

function blockAt(source, openIndex) {
  const closeIndex = matchingDelimiter(source, openIndex, "{", "}");
  return closeIndex < 0
    ? null
    : {
        body: source.slice(openIndex + 1, closeIndex),
        start: openIndex,
        end: closeIndex + 1,
      };
}

function handledAuthException(header, body, type) {
  const match = new RegExp(
    String.raw`\b(?:global::)?(?:Azure\.Identity\.)?${type}\s+(\w+)\b`,
  ).exec(header);
  return (
    match !== null &&
    new RegExp(
      String.raw`Console\s*\.\s*(?:Error\s*\.\s*)?(?:Write|WriteLine)\s*\([^;]*\b${escapeRegExp(match[1])}\b`,
    ).test(body)
  );
}

function authenticatedAccountOperation(source, body, bodyStart) {
  for (const match of body.matchAll(
    new RegExp(
      String.raw`\bawait\b(\s*(?:\(\s*)*)(\w+)\s*\.\s*${authenticatedOperation}\s*\(`,
      "g",
    ),
  )) {
    const receiverOffset = "await".length + match[1].length;
    const operationIndex = bodyStart + match.index + receiverOffset;
    const binding = lookupBinding(
      analyzeIdentityBindings(source.slice(0, operationIndex)).scopes,
      match[2],
    );
    if (
      binding?.kind === "client" &&
      binding.credentialProvenance &&
      binding.endpointProvenance
    ) {
      return true;
    }
  }
  return false;
}

function hasAuthErrorHandling(source) {
  const tryPattern = /\btry\s*\{/g;
  for (const tryMatch of source.matchAll(tryPattern)) {
    const tryBlock = blockAt(source, source.indexOf("{", tryMatch.index));
    if (
      tryBlock === null ||
      !authenticatedAccountOperation(
        source,
        tryBlock.body,
        tryBlock.start + 1,
      )
    ) {
      continue;
    }

    const catches = [];
    let index = tryBlock.end;
    while (index < source.length) {
      while (/\s/.test(source[index] ?? "")) index += 1;
      const header = /^catch\s*\(([^)]*)\)\s*\{/.exec(source.slice(index));
      if (!header) break;
      const openIndex = index + header[0].lastIndexOf("{");
      const catchBlock = blockAt(source, openIndex);
      if (catchBlock === null) break;
      catches.push({ header: header[1], body: catchBlock.body });
      index = catchBlock.end;
    }

    const unavailable = catches.findIndex(({ header, body }) =>
      handledAuthException(
        header,
        body,
        "CredentialUnavailableException",
      ),
    );
    const failed = catches.findIndex(({ header, body }) =>
      handledAuthException(header, body, "AuthenticationFailedException"),
    );
    if (unavailable >= 0 && failed > unavailable) {
      return true;
    }
  }
  return false;
}

function hasAccountEndpoint(source) {
  return (
    !/\bInvalid(?:DefaultAzureCredential|BlobServiceClient)\b/.test(source) &&
    analyzeIdentityBindings(source).endpointFound
  );
}

function conditionAllowsTargetFramework(condition, targetFramework) {
  let expression = condition.trim();
  if (!expression) return true;
  if (/^true$/i.test(expression)) return true;
  if (/^false$/i.test(expression)) return false;

  while (
    expression.startsWith("(") &&
    expression.endsWith(")") &&
    matchingDelimiter(expression, 0, "(", ")") === expression.length - 1
  ) {
    expression = expression.slice(1, -1).trim();
  }
  const orParts = expression.split(/\s+or\s+/i);
  if (orParts.length > 1) {
    return orParts.some((part) =>
      conditionAllowsTargetFramework(part, targetFramework)
    );
  }
  const andParts = expression.split(/\s+and\s+/i);
  if (andParts.length > 1) {
    return andParts.every((part) =>
      conditionAllowsTargetFramework(part, targetFramework)
    );
  }
  if (!/\$\(\s*TargetFramework\s*\)/i.test(expression)) {
    return true;
  }

  const substituted = expression.replace(
    /\$\(\s*TargetFramework\s*\)/gi,
    targetFramework,
  );
  const comparison = /^\s*(.*?)\s*(==|!=)\s*(.*?)\s*$/.exec(substituted);
  if (comparison === null) return false;
  const unquote = (value) => {
    const trimmed = value.trim();
    return /^(['"])([\s\S]*)\1$/.exec(trimmed)?.[2] ?? trimmed;
  };
  const left = unquote(comparison[1]);
  const right = unquote(comparison[3]);
  return comparison[2] === "==" ? left === right : left !== right;
}

function enclosingItemGroupCondition(source, index) {
  let open = null;
  for (const match of source.slice(0, index).matchAll(
    /<(\/?)ItemGroup\b([^>]*)>/gi,
  )) {
    open = match[1] ? null : match[2];
  }
  if (open === null) return "";
  return /\bCondition\s*=\s*(["'])([\s\S]*?)\1/i.exec(open)?.[2] ?? "";
}

function exactPackage(project, name, version, targetFramework) {
  const source = activeProjectXml(project);
  const properties = new Map(
    [...source.matchAll(
      /<([A-Za-z_][\w.-]*)\b[^>]*>([^<]*)<\/\1\s*>/g,
    )].map((match) => [match[1].toLowerCase(), match[2].trim()]),
  );
  const resolveValue = (value) => {
    let unresolved = false;
    const resolved = value.replace(
      /\$\(([A-Za-z_][\w.-]*)\)/g,
      (_reference, property) => {
        const replacement = properties.get(property.toLowerCase());
        if (replacement === undefined) unresolved = true;
        return replacement ?? "";
      },
    );
    return unresolved ? null : resolved.trim();
  };
  for (const match of source.matchAll(
    /<PackageReference\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/PackageReference\s*>)/gi,
  )) {
    const before = source.slice(0, match.index);
    if (
      before.lastIndexOf("<ItemGroup") < before.lastIndexOf("</ItemGroup") ||
      before.lastIndexOf("<Target") > before.lastIndexOf("</Target")
    ) {
      continue;
    }
    const attributes = new Map(
      [...match[1].matchAll(
        /\b([A-Za-z_][\w.-]*)\s*=\s*(["'])([\s\S]*?)\2/g,
      )].map((attribute) => [attribute[1].toLowerCase(), attribute[3]]),
    );
    if (
      ![
        attributes.get("condition") ?? "",
        enclosingItemGroupCondition(source, match.index),
      ].every((condition) =>
        conditionAllowsTargetFramework(condition, targetFramework)
      )
    ) {
      continue;
    }
    const include = resolveValue(
      attributes.get("include") ??
      /<Include\b[^>]*>([^<]+)<\/Include>/i.exec(match[2] ?? "")?.[1] ??
      "",
    );
    const pinned = resolveValue(
      attributes.get("version") ??
      /<Version\b[^>]*>([^<]+)<\/Version>/i.exec(match[2] ?? "")?.[1] ??
      "",
    );
    if (
      include?.trim().toLowerCase() === name.toLowerCase() &&
      [version, `[${version}]`].includes(pinned?.trim())
    ) {
      return true;
    }
  }
  return false;
}

function activeProjectXml(project) {
  let source = stripXmlComments(project);
  let previous;
  do {
    previous = source;
    source = source.replace(
      /<(PropertyGroup|ItemGroup)\b(?=[^>]*\bCondition\s*=\s*["']\s*false\s*["'])[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    );
    source = source.replace(
      /<When\b(?=[^>]*\bCondition\s*=\s*["']\s*false\s*["'])[^>]*>[\s\S]*?<\/When\s*>/gi,
      " ",
    );
  } while (source !== previous);
  return source;
}

function validManifest(project) {
  const source = activeProjectXml(project);
  const target =
    /<TargetFramework\b[^>]*>\s*([^<]+)\s*<\/TargetFramework>/i.exec(
      source,
    )?.[1] ??
    /<TargetFrameworks\b[^>]*>\s*([^<]+)\s*<\/TargetFrameworks>/i.exec(
      source,
    )?.[1] ??
    "";
  const net8Targets = target.split(";").map((value) => value.trim()).filter(
    (value) =>
      /^net8\.0(?:-[a-z][a-z0-9]*(?:\.[0-9]+)*)?$/i.test(value),
  );
  return (
    /<Project\b[^>]*\bSdk\s*=\s*["']Microsoft\.NET\.Sdk["']/i.test(source) &&
    /<OutputType\b[^>]*>\s*Exe\s*<\/OutputType>/i.test(source) &&
    net8Targets.some((targetFramework) =>
      exactPackage(source, "Azure.Identity", "1.21.0", targetFramework) &&
      exactPackage(
        source,
        "Azure.Storage.Blobs",
        "12.29.2",
        targetFramework,
      )
    )
  );
}

function validMainParameters(parameters) {
  const value = parameters.trim();
  return (
    value === "" ||
    /^(?:(?:global::)?System\s*\.\s*)?String\s*\[\s*\]\s*\??\s+\w+$/i.test(
      value,
    ) ||
    /^string\s*\[\s*\]\s*\??\s+\w+$/i.test(value)
  );
}

function isExecutableMain(method) {
  return (
    method.name === "Main" &&
    method.modifiers.includes("static") &&
    /^(?:void|int|(?:System\.Threading\.Tasks\.)?Task(?:<int>)?)$/.test(
      method.returnType.replace(/^global::/, ""),
    ) &&
    validMainParameters(method.parametersSource)
  );
}

function hasApplicationEntryPoint(source) {
  const code = dotnetCodeOnly(source);
  const methods = methodDeclarations(code);
  if (
    methods.some(
      (method) =>
        method.parentMethod === null &&
        method.type !== null &&
        isExecutableMain(method),
    )
  ) {
    return true;
  }
  const typeRanges = typeDeclarations(code);
  let topLevel = code;
  for (const range of [...typeRanges].sort((a, b) => b.start - a.start)) {
    topLevel =
      topLevel.slice(0, range.start) +
      " ".repeat(range.end - range.start) +
      topLevel.slice(range.end);
  }
  for (const method of methods
    .filter(
      (candidate) =>
        candidate.parentMethod === null && candidate.type === null,
    )
    .sort((left, right) => right.start - left.start)) {
    topLevel =
      topLevel.slice(0, method.start) +
      " ".repeat(method.end - method.start) +
      topLevel.slice(method.end);
  }
  const executable = topLevel
    .replace(/\b(?:global\s+)?using\s+[^;]+;/g, " ")
    .replace(/\bnamespace\s+[\w.]+\s*;/g, " ")
    .replace(/^\s*#.*$/gm, " ")
    .trim();
  return executable !== "";
}

function applicationProjects(workspace) {
  if (Array.isArray(workspace.projects)) {
    const aggregateProject = workspace.projects
      .map(({ project }) => project)
      .join("\n");
    const aggregateSource = workspace.projects
      .map(({ source }) => source)
      .filter(Boolean)
      .join("\n");
    if (
      aggregateProject === workspace.project &&
      aggregateSource === workspace.source
    ) {
      return workspace.projects.filter(
        ({ project, source, sourceFiles }) =>
          validManifest(project ?? "") &&
          source?.trim() &&
          hasApplicationEntryPoint(source) &&
          (sourceFiles?.length ?? 0) > 0,
      );
    }
  }
  return validManifest(workspace.project ?? "") &&
      workspace.source?.trim() &&
      hasApplicationEntryPoint(workspace.source)
    ? [{
        project: workspace.project,
        source: workspace.source,
        sourceFiles: workspace.sourceFiles ?? ["<workspace>"],
      }]
    : [];
}

const rules = {
  "prompt/storage-packages": () => true,

  "prompt/account-endpoint": ({ source }) => hasAccountEndpoint(source),

  "prompt/default-azure-credential": ({ source }) =>
    credentialDeclarations(source).length > 0 ||
    new RegExp(String.raw`\bnew\s+${defaultCredentialType}\s*\(`).test(source),

  "prompt/credential-client-association": ({ source }) =>
    analyzeIdentityBindings(source).associationFound,

  "prompt/authenticated-operation": ({ source }) =>
    accountOperation(source),

  "prompt/auth-errors": ({ source }) => hasAuthErrorHandling(source),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }
  const projects = applicationProjects(workspace);
  if (projects.length === 0) return false;
  if (name === "prompt/storage-packages") return true;
  return projects.some((project) => {
    const protectedSource = (project.source ?? "").replace(
      /(["'])AZURE_STORAGE_BLOB_ENDPOINT\1/g,
      endpointSetting,
    );
    const source = reachableSource(
      normalizeTryCreate(
        resolveEndpointSettingConstants(
          normalizeSdkTypes(dotnetCodeOnly(protectedSource)),
        ),
      ),
    );
    return Boolean(rule({ ...project, source }));
  });
}

export function ruleNames() {
  return Object.keys(rules);
}

const ignoredDirectories = new Set([".git", ".vally", "bin", "obj"]);

function ignoredDirectory(name) {
  const value = name.toLowerCase();
  return ignoredDirectories.has(value) || /(?:^|[._-])tests?$/.test(value);
}

function projectIsTest(path) {
  const stem = path
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    .replace(/\.csproj$/i, "");
  return /(?:^|[._-])tests?$/.test(stem.toLowerCase());
}

function compileFiles(projectPath, project, sourcePaths) {
  const directory = dirname(projectPath);
  const candidates = sourcePaths.filter((path) => {
    const relativePath = relative(directory, path).replaceAll("\\", "/");
    return relativePath !== ".." && !relativePath.startsWith("../");
  });
  const defaultEnabled =
    !/<EnableDefaultItems\b[^>]*>\s*false\s*<\/EnableDefaultItems>/i.test(
      project,
    ) &&
    !/<EnableDefaultCompileItems\b[^>]*>\s*false\s*<\/EnableDefaultCompileItems>/i.test(
      project,
    );
  const active = new Set(defaultEnabled ? candidates : []);
  const matches = (path, pattern) => {
    const normalized = relative(directory, path).replaceAll("\\", "/");
    const expression = pattern
      .trim()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\0/g, ".*");
    return new RegExp(`^${expression}$`, "i").test(normalized);
  };
  for (const item of stripXmlComments(project).matchAll(
    /<Compile\b([^>]*?)(?:\/\s*>|>[\s\S]*?<\/Compile\s*>)/gi,
  )) {
    const attributes = new Map(
      [...item[1].matchAll(
        /\b([A-Za-z_][\w.-]*)\s*=\s*(["'])([\s\S]*?)\2/g,
      )].map((attribute) => [attribute[1].toLowerCase(), attribute[3]]),
    );
    if (/^false$/i.test(attributes.get("condition") ?? "")) continue;
    for (const pattern of (attributes.get("remove") ?? "").split(";").filter(Boolean)) {
      for (const path of candidates) if (matches(path, pattern)) active.delete(path);
    }
    for (const pattern of (attributes.get("include") ?? "").split(";").filter(Boolean)) {
      for (const path of candidates) if (matches(path, pattern)) active.add(path);
    }
  }
  return [...active].sort();
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
  const projects = projectPaths
    .filter((path) => !projectIsTest(path))
    .sort()
    .map((path) => {
      const project = readFileSync(path, "utf8");
      const active = compileFiles(path, project, sourcePaths);
      return {
        path: relative(rootPath, path).replaceAll("\\", "/"),
        project,
        source: active.map((file) => readFileSync(file, "utf8")).join("\n"),
        sourceFiles: active.map((file) =>
          relative(rootPath, file).replaceAll("\\", "/")
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
