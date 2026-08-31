const PINS = [
  ["azure-identity", "1.18.5"],
  ["azure-storage-blob", "12.35.1"],
  ["azure-security-keyvault-keys", "4.11.2"],
];

const SDK_TYPE_PACKAGES = {
  BinaryData: "com.azure.core.util",
  BlobAsyncClient: "com.azure.storage.blob",
  BlobClient: "com.azure.storage.blob",
  BlobServiceAsyncClient: "com.azure.storage.blob",
  BlobServiceClient: "com.azure.storage.blob",
  BlobServiceClientBuilder: "com.azure.storage.blob",
  BlobStorageException: "com.azure.storage.blob.models",
  CryptographyAsyncClient: "com.azure.security.keyvault.keys.cryptography",
  CryptographyClient: "com.azure.security.keyvault.keys.cryptography",
  CryptographyClientBuilder: "com.azure.security.keyvault.keys.cryptography",
  DefaultAzureCredential: "com.azure.identity",
  DefaultAzureCredentialBuilder: "com.azure.identity",
  HttpResponseException: "com.azure.core.exception",
  KeyClient: "com.azure.security.keyvault.keys",
  KeyClientBuilder: "com.azure.security.keyvault.keys",
  KeyWrapAlgorithm: "com.azure.security.keyvault.keys.cryptography.models",
};

const CLIENT_BUILDERS = {
  BlobAsyncClient: ["BlobServiceClientBuilder", "buildAsyncClient"],
  BlobClient: ["BlobServiceClientBuilder", "buildClient"],
  CryptographyAsyncClient: ["CryptographyClientBuilder", "buildAsyncClient"],
  CryptographyClient: ["CryptographyClientBuilder", "buildClient"],
  KeyClient: ["KeyClientBuilder", "buildClient"],
};

function hasCompatibleSourceFiles(sourceFiles) {
  return Array.isArray(sourceFiles) &&
    sourceFiles.length > 0 &&
    sourceFiles.every((path) =>
      typeof path === "string" &&
      /\.java$/i.test(path) &&
      !/(?:^|[\\/])(?:\.vally|target|node_modules)(?:[\\/]|$)/i.test(path) &&
      (!/[\\/]/.test(path) || /(?:^|[\\/])src[\\/]main[\\/]java[\\/]/i.test(path)));
}

function codeOnly(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  const masked = [...code];
  for (const match of code.matchAll(/\bif\s*\(\s*false\s*\)\s*\{/g)) {
    let depth = 0;
    for (let index = match.index; index < code.length; index += 1) {
      if (code[index] === "{") depth += 1;
      if (code[index] === "}" && --depth === 0) {
        for (let position = match.index; position <= index; position += 1) {
          if (masked[position] !== "\n") masked[position] = " ";
        }
        break;
      }
    }
  }
  return masked.join("");
}

function executableCode(source) {
  const masked = [...source];
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        state = "code";
      } else {
        masked[index] = " ";
      }
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        masked[index] = " ";
        masked[index + 1] = " ";
        index += 1;
        state = "code";
      } else if (character !== "\n") {
        masked[index] = " ";
      }
    } else if (state === "string" || state === "character") {
      if (character === "\\") {
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        state = "code";
      }
    } else if (character === "/" && next === "/") {
      masked[index] = " ";
      masked[index + 1] = " ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      masked[index] = " ";
      masked[index + 1] = " ";
      index += 1;
      state = "block-comment";
    } else if (character === '"') {
      state = "string";
    } else if (character === "'") {
      state = "character";
    }
  }

  const code = masked.join("");
  const active = [...code];
  for (const match of code.matchAll(/\bif\s*\(\s*(true|false)\s*\)\s*\{/g)) {
    const open = code.indexOf("{", match.index);
    const close = matchingBrace(code, open);
    if (close < 0) continue;
    if (match[1] === "false") {
      for (let index = match.index; index <= close; index += 1) {
        if (active[index] !== "\n") active[index] = " ";
      }
      continue;
    }
    const elseMatch = /^\s*else\s*\{/.exec(code.slice(close + 1));
    if (!elseMatch) continue;
    const elseOpen = code.indexOf("{", close + 1);
    const elseClose = matchingBrace(code, elseOpen);
    if (elseClose < 0) continue;
    for (let index = close + 1; index <= elseClose; index += 1) {
      if (active[index] !== "\n") active[index] = " ";
    }
  }
  for (const region of mainControlRegions(code)) {
    const inactive = region.value === false
      ? [region.consequentStart, region.consequentEnd]
      : region.value === true && region.alternateStart >= 0
        ? [region.alternateStart, region.alternateEnd]
        : null;
    if (!inactive) continue;
    for (let index = inactive[0]; index < inactive[1]; index += 1) {
      if (active[index] !== "\n") active[index] = " ";
    }
  }
  return active.join("");
}

function hasImports(source, names) {
  return names.every((name) => hasOfficialSdkType(source, name));
}

function hasOfficialSdkType(source, name) {
  const packageName = SDK_TYPE_PACKAGES[name];
  if (!packageName) return false;
  const packagePattern = packageName.replace(/\./g, "\\.");
  const code = maskStringContents(source);
  return new RegExp(
    `\\bimport\\s+${packagePattern}\\.${name}\\s*;`,
  ).test(code) || new RegExp(`\\b${packagePattern}\\.${name}\\b`).test(code);
}

function classBodies(code) {
  const classes = [];
  for (const match of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g)) {
    let depth = 0;
    for (let index = match.index + match[0].length - 1; index < code.length; index += 1) {
      if (code[index] === "{") depth += 1;
      if (code[index] === "}" && --depth === 0) {
        classes.push({
          name: match[1],
          start: match.index,
          end: index + 1,
          body: code.slice(match.index, index + 1),
        });
        break;
      }
    }
  }
  return classes;
}

function activeDependency(build, artifact, version) {
  const maven = new RegExp(
    `<dependency\\b[^>]*>[\\s\\S]*?<groupId>com\\.azure<\\/groupId>[\\s\\S]*?<artifactId>${artifact}<\\/artifactId>[\\s\\S]*?<version>${version}<\\/version>[\\s\\S]*?<\\/dependency>`,
  );
  const gradle = new RegExp(
    `\\b(?:implementation|api)\\s*\\(?\\s*["']com\\.azure:${artifact}:${version}["']`,
  );
  return maven.test(build) || gradle.test(build);
}

function hasPinnedDependencies(build) {
  return PINS.every(([artifact, version]) => activeDependency(build, artifact, version));
}

function securityViolations(source, code) {
  return /\b(?:SecretClient|SecretClientBuilder|getSecret)\b/.test(code) ||
    /\b[A-Za-z_$][\w$]*(?:crypto|cryptography)[\w$]*\s*\.\s*encrypt(?:Async)?\s*\(/i.test(code) ||
    /\b(?:AES\/(?:CBC|ECB)|DES|RSA\/ECB)\b/.test(source) ||
    /\b(?:ChaCha20|ChaCha20-Poly1305)\b/.test(source) ||
    /\bBase64\b[\s\S]{0,100}\bencodeToString\s*\(\s*(?:dek|dataKey)\b/i.test(code) ||
    /\b(?:Files|FileOutputStream|writeString|write)\s*\.[\s\S]{0,100}\b(?:dek|dataKey)\b/i.test(code) ||
    /(?:metadata|setMetadata)[\s\S]{0,160}\b(?:dek|dataKey)\b[\s\S]{0,100}Base64[\s\S]{0,100}encodeToString\s*\(\s*(?:dek|dataKey)\b/i.test(code);
}

function requiredSync(source, code) {
  const methods = methodBodies(code);
  return hasImports(source, [
    "KeyClient", "CryptographyClient", "BlobClient", "BlobStorageException",
  ]) &&
    /\bKeyClientBuilder\b[\s\S]{0,500}\.buildClient\s*\(/.test(code) &&
    /\bCryptographyClientBuilder\b[\s\S]{0,500}\.buildClient\s*\(/.test(code) &&
    hasRealCryptoTypes(code) &&
    allCipherTransformationsAreAesGcm(methods, code) &&
    methods.some((method) => syncWorkflow(method, methods, code));
}

function matchingBrace(code, open) {
  return matchingDelimiter(code, open, "{", "}");
}

function matchingDelimiter(code, open, left, right) {
  let depth = 0;
  let quote = "";
  for (let index = open; index < code.length; index += 1) {
    const character = code[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = "";
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === left) {
      depth += 1;
    } else if (character === right && --depth === 0) {
      return index;
    }
  }
  return -1;
}

function matchingParen(code, open) {
  return matchingDelimiter(code, open, "(", ")");
}

function splitArguments(argumentsText) {
  if (!argumentsText.trim()) return [];
  const argumentsList = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < argumentsText.length; index += 1) {
    const character = argumentsText[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      argumentsList.push(argumentsText.slice(start, index).trim());
      start = index + 1;
    }
  }
  argumentsList.push(argumentsText.slice(start).trim());
  return argumentsList;
}

function maskStringContents(code) {
  const masked = [...code];
  let quote = "";
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (!quote) {
      if (character === '"' || character === "'") quote = character;
      continue;
    }
    if (character === "\\") {
      if (masked[index] !== "\n") masked[index] = " ";
      if (masked[index + 1] && masked[index + 1] !== "\n") {
        masked[index + 1] = " ";
      }
      index += 1;
    } else if (character === quote) {
      quote = "";
    } else if (character !== "\n") {
      masked[index] = " ";
    }
  }
  return masked.join("");
}

function callsNamed(code, name) {
  const calls = [];
  const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
  const structuralCode = maskStringContents(code);
  for (const match of structuralCode.matchAll(pattern)) {
    const open = structuralCode.indexOf("(", match.index);
    const close = matchingParen(structuralCode, open);
    if (close < 0) continue;
    const argsStart = open + 1;
    const argsText = code.slice(argsStart, close);
    calls.push({
      start: match.index,
      open,
      close,
      end: close + 1,
      argsStart,
      argsText,
      args: splitArguments(argsText),
    });
  }
  return calls;
}

function methodBodies(code) {
  const methods = [];
  const pattern = /\b(?:(?:public|protected|private|static|final|synchronized)\s+)*(?:<[^{}()]*>\s+)?(?:[A-Za-z_$][\w$]*(?:<[^{}()]*>)?(?:\s*\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*\(([^{};()]*)\)\s*(?:throws\s+[^{]+)?\{/g;
  for (const match of code.matchAll(pattern)) {
    if (/\bclass\s+[A-Za-z_$][\w$]*\s*\(/.test(match[0])) continue;
    const open = code.indexOf("{", match.index);
    const close = matchingBrace(code, open);
    if (close < 0) continue;
    methods.push({
      name: match[1],
      parameters: match[2],
      start: match.index,
      end: close + 1,
      body: code.slice(open + 1, close),
    });
  }
  return methods;
}

function parameterNames(parameters) {
  return splitArguments(parameters)
    .map((parameter) => /([A-Za-z_$][\w$]*)\s*$/.exec(parameter)?.[1])
    .filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assignmentValue(name, scope, code, before = scope.body.length) {
  const pattern = new RegExp(
    `(?:\\b(?:final\\s+)?(?:[A-Za-z_$][\\w$<>.\\[\\]]*|var)\\s+)?\\b${escapeRegExp(name)}\\s*=\\s*([^;]+);`,
    "g",
  );
  let value = "";
  for (const match of scope.body.slice(0, before).matchAll(pattern)) {
    value = match[1].trim();
  }
  if (value) return value;
  for (const match of code.matchAll(pattern)) {
    value = match[1].trim();
  }
  return value;
}

function simplifyExpression(expression) {
  let value = expression.trim();
  while (true) {
    const withoutCast = value.replace(
      /^\(\s*[A-Za-z_$][\w$<>.\[\]]*\s*\)\s*/,
      "",
    );
    const wrapped = /^\(([\s\S]*)\)$/.exec(withoutCast);
    const next = wrapped ? wrapped[1].trim() : withoutCast;
    if (next === value) return value;
    value = next;
  }
}

function resolvesExpression(expression, scope, methods, code, matcher, seen = new Set()) {
  const value = simplifyExpression(expression);
  if (matcher(value)) return true;
  const helper = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(\s*\)$/.exec(value);
  if (helper) {
    const key = `method:${helper[1]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return methods
      .filter((method) => method.name === helper[1])
      .some((method) => {
        const returned = /\breturn\s+([^;]+);/.exec(method.body)?.[1];
        return returned && resolvesExpression(
          returned, method, methods, code, matcher, seen,
        );
      });
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    const key = `variable:${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const assigned = assignmentValue(value, scope, code);
    return assigned && resolvesExpression(
      assigned, scope, methods, code, matcher, seen,
    );
  }
  return false;
}

function expressionDependsOn(expression, name, scope, code, seen = new Set()) {
  if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(expression)) return true;
  const value = simplifyExpression(expression);
  const identifiers = /^[A-Za-z_$][\w$]*$/.test(value)
    ? [value]
    : Array.from(value.matchAll(/\b([A-Za-z_$][\w$]*)\b/g), (match) => match[1]);
  return identifiers.some((identifier) => {
    if (seen.has(identifier)) return false;
    seen.add(identifier);
    const assigned = assignmentValue(identifier, scope, code);
    return assigned && expressionDependsOn(assigned, name, scope, code, seen);
  });
}

function assignmentRecords(name, scope, before = scope.body.length) {
  const pattern = new RegExp(
    `(?:\\b(?:final\\s+)?(?:[A-Za-z_$][\\w$<>.\\[\\]]*|var)\\s+)?(?<![\\w$.])${escapeRegExp(name)}\\s*=\\s*([^;]+);`,
    "g",
  );
  return Array.from(scope.body.slice(0, before).matchAll(pattern), (match) => ({
    end: match.index + match[0].length,
    start: match.index,
    value: match[1].trim(),
  }));
}

function assignmentRecordBefore(name, scope, before = scope.body.length) {
  return assignmentRecords(name, scope, before).at(-1) ?? null;
}

function valueOrigin(method, name, sourceEnd) {
  const assignment = assignmentRecords(name, method)
    .find((record) => record.start <= sourceEnd && sourceEnd <= record.end);
  return {
    expression: name,
    identityName: name,
    start: assignment?.end ?? sourceEnd,
  };
}

function initialValueOrigin(method, name) {
  const assignment = assignmentRecords(name, method).at(0);
  return {
    expression: name,
    identityName: name,
    start: assignment?.end ?? 0,
  };
}

function compactCode(value) {
  return value.replace(/\s+/g, "");
}

function exactInvocation(expression) {
  const value = simplifyExpression(expression);
  const structural = maskStringContents(value);
  const end = structural.trimEnd().length - 1;
  for (let open = structural.indexOf("("); open >= 0; open = structural.indexOf("(", open + 1)) {
    if (matchingParen(structural, open) !== end) continue;
    const prefix = structural.slice(0, open).trimEnd();
    const method = /([A-Za-z_$][\w$]*)\s*$/.exec(prefix);
    if (!method) return null;
    const receiver = value.slice(0, method.index).replace(/\.\s*$/, "").trim();
    if (/\bnew$/.test(receiver)) return null;
    return {
      args: splitArguments(value.slice(open + 1, end)),
      end: end + 1,
      name: method[1],
      receiver,
      start: method.index,
      value,
    };
  }
  return null;
}

function exactMethodCall(expression, name) {
  const call = exactInvocation(expression);
  return call?.name === name && call.receiver ? call : null;
}

function exactConstructorCall(expression, name) {
  const value = simplifyExpression(expression);
  const structural = maskStringContents(value);
  const pattern = new RegExp(
    `^new\\s+(?:(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*)${escapeRegExp(name)}\\s*\\(`,
  );
  const match = pattern.exec(structural);
  if (!match) return null;
  const open = structural.indexOf("(", match.index);
  const close = matchingParen(structural, open);
  if (close !== structural.trimEnd().length - 1) return null;
  return {
    args: splitArguments(value.slice(open + 1, close)),
    end: close + 1,
    start: match.index,
    value,
  };
}

function expressionPreservesIdentity(
  expression,
  names,
  methods,
  code,
  helperSeen,
  seen = new Set(),
) {
  const value = simplifyExpression(expression);
  if (names.has(value)) return true;

  const invocation = exactInvocation(value);
  if (!invocation) return false;
  const state = `${invocation.name}:${compactCode(value)}`;
  if (seen.has(state)) return false;
  seen.add(state);

  if (
    ["getEncryptedKey", "getKey", "toBytes"].includes(invocation.name) &&
    invocation.args.length === 0 &&
    expressionPreservesIdentity(
      invocation.receiver,
      names,
      methods,
      code,
      helperSeen,
      new Set(seen),
    )
  ) {
    return true;
  }

  return methods
    .filter((candidate) => candidate.name === invocation.name)
    .some((candidate) =>
      transparentParameterIndexes(candidate, methods, code, new Set(helperSeen))
        .some((parameter) =>
          invocation.args[parameter] &&
          expressionPreservesIdentity(
            invocation.args[parameter],
            names,
            methods,
            code,
            helperSeen,
            new Set(seen),
          )));
}

function directIdentityAliases(
  method,
  name,
  before,
  methods = [],
  code = "",
  helperSeen = new Set(),
) {
  const names = new Set([name]);
  const assignments = Array.from(
    method.body.slice(0, before).matchAll(
      /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
    ),
    (match) => ({ name: match[1], value: match[2].trim() }),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments) {
      if (
        !names.has(assignment.name) &&
        expressionPreservesIdentity(
          assignment.value,
          names,
          methods,
          code,
          helperSeen,
        )
      ) {
        names.add(assignment.name);
        changed = true;
      }
    }
  }
  return names;
}

function identityValueWasAltered(
  method,
  name,
  after,
  before,
  methods = [],
  code = "",
  helperSeen = new Set(),
) {
  if (!name || after >= before) return false;
  const mutationKey = `mutation:${method.start}:${name}`;
  if (helperSeen.has(mutationKey)) return false;
  const mutationSeen = new Set(helperSeen);
  mutationSeen.add(mutationKey);
  const segment = maskStringContents(method.body.slice(after, before));
  const aliases = directIdentityAliases(
    method,
    name,
    before,
    methods,
    code,
    mutationSeen,
  );
  for (const alias of aliases) {
    const escaped = escapeRegExp(alias);
    const bytes = `${escaped}(?:\\s*\\.\\s*(?:getEncryptedKey|getKey|toBytes)\\s*\\(\\s*\\))?`;
    if (
      new RegExp(
        `(?<![\\w$.])${bytes}\\s*\\[[^\\]]*\\]\\s*(?:[+\\-*/%&|^]?=|\\+\\+|--)`,
      ).test(segment) ||
      new RegExp(
        `(?:\\+\\+|--)\\s*(?<![\\w$.])${bytes}\\s*\\[[^\\]]*\\]`,
      ).test(segment) ||
      new RegExp(
        `(?<![\\w$.])${escaped}\\s*(?:[+\\-*/%&|^]|<<|>>|>>>)=`,
      ).test(segment) ||
      new RegExp(
        `(?<![\\w$.])${escaped}\\s*(?:\\+\\+|--)`,
      ).test(segment) ||
      new RegExp(
        `\\b(?:java\\s*\\.\\s*util\\s*\\.\\s*)?Arrays\\s*\\.\\s*(?:fill|setAll|parallelSetAll|sort|parallelSort)\\s*\\(\\s*${escaped}\\b`,
      ).test(segment) ||
      new RegExp(
        `\\bSystem\\s*\\.\\s*arraycopy\\s*\\(\\s*[^,;]+\\s*,\\s*[^,;]+\\s*,\\s*${bytes}\\b`,
      ).test(segment) ||
      new RegExp(
        `\\b(?:java\\s*\\.\\s*nio\\s*\\.\\s*)?ByteBuffer\\s*\\.\\s*wrap\\s*\\(\\s*${bytes}\\s*\\)(?:\\s*\\.\\s*(?:slice|duplicate|position|limit|order|mark|reset|rewind|flip|clear|compact)\\s*\\([^)]*\\))*\\s*\\.\\s*(?:put|putInt|putLong)\\s*\\(`,
      ).test(segment) ||
      new RegExp(
        `(?<![\\w$.])${bytes}\\s*\\.\\s*(?:put|putAll|clear|remove|replace|set|write|reset|flip|rewind|compact)\\s*\\(`,
      ).test(segment) ||
      new RegExp(
        `\\b(?:alter|change|corrupt|modify|mutate|overwrite|reverse|rotate|scramble|shuffle|xor)\\w*\\s*\\([^;)]*\\b${escaped}\\b`,
        "i",
      ).test(segment)
    ) {
      return true;
    }
  }
  return userDefinedCallMutatesIdentity(
    method,
    aliases,
    after,
    before,
    methods,
    code,
    mutationSeen,
  );
}

function expressionReferencesIdentity(expression, aliases) {
  return [...aliases].some((alias) =>
    new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(expression));
}

function userDefinedCallMutatesIdentity(
  method,
  aliases,
  after,
  before,
  methods,
  code,
  seen,
) {
  if (methods.length === 0) return false;
  const structural = maskStringContents(method.body);
  for (const match of structural.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (
      ["catch", "for", "if", "switch", "synchronized", "while"].includes(name) ||
      !methods.some((candidate) => candidate.name === name)
    ) {
      continue;
    }
    const open = structural.indexOf("(", match.index);
    const close = matchingParen(structural, open);
    if (close < 0 || match.index < after || close >= before) continue;
    const argumentsList = splitArguments(method.body.slice(open + 1, close));
    for (const candidate of methods.filter((item) => item.name === name)) {
      for (const parameter of parameterNames(candidate.parameters)) {
        const index = parameterNames(candidate.parameters).indexOf(parameter);
        const argument = argumentsList[index];
        if (
          argument &&
          expressionReferencesIdentity(argument, aliases) &&
          methodMutatesParameter(candidate, parameter, methods, code, seen)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function methodMutatesParameter(method, parameter, methods, code, seen) {
  const mutationKey = `mutation:${method.start}:${parameter}`;
  if (seen.has(mutationKey)) return false;
  return identityValueWasAltered(
    method,
    parameter,
    0,
    method.body.length,
    methods,
    code,
    new Set(seen),
  );
}

function passThroughHelperHasUnsafeValueUse(
  method,
  parameter,
  methods,
  code,
  seen,
) {
  const aliases = directIdentityAliases(
    method,
    parameter,
    method.body.length,
    methods,
    code,
    seen,
  );
  const structural = maskStringContents(method.body);
  const allowed = new Set(["print", "printf", "println", "requireNonNull"]);
  for (const match of structural.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (["catch", "for", "if", "switch", "synchronized", "while"].includes(name)) {
      continue;
    }
    const open = structural.indexOf("(", match.index);
    const close = matchingParen(structural, open);
    if (close < 0) continue;
    const argumentsList = splitArguments(method.body.slice(open + 1, close));
    const referencesValue = (expression) =>
      [...aliases].some((alias) =>
        new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(expression));
    if (!argumentsList.some(referencesValue)) continue;
    if (allowed.has(name)) continue;

    const forwardsValue = methods
      .filter((candidate) => candidate.name === name)
      .some((candidate) =>
        transparentParameterIndexes(candidate, methods, code, new Set(seen))
          .some((index) => referencesValue(argumentsList[index] ?? "")));
    if (!forwardsValue) return true;
  }
  return false;
}

function methodReturnsParameterUnchanged(
  method,
  parameter,
  methods,
  code,
  seen = new Set(),
) {
  const key = `${method.start}:${parameter}`;
  if (seen.has(key)) return false;
  seen.add(key);
  if (passThroughHelperHasUnsafeValueUse(method, parameter, methods, code, seen)) {
    return false;
  }
  const returns = Array.from(method.body.matchAll(/\breturn\s+([\s\S]*?);/g));
  if (returns.length === 0) return false;
  const parameterOrigin = {
    expression: parameter,
    identityName: parameter,
    start: 0,
  };
  return returns.every((match) =>
    strictlyDerivesValue(
      match[1],
      [parameterOrigin],
      method,
      methods,
      code,
      match.index,
      match.index,
      new Set(),
      null,
      seen,
    ));
}

function transparentParameterIndexes(method, methods, code, seen = new Set()) {
  return parameterNames(method.parameters)
    .map((parameter, index) =>
      methodReturnsParameterUnchanged(method, parameter, methods, code, new Set(seen))
        ? index
        : -1)
    .filter((index) => index >= 0);
}

function strictlyDerivesValue(
  expression,
  origins,
  scope,
  methods,
  code,
  position = scope.body.length,
  lookupBefore = position,
  seen = new Set(),
  extraDirectMatch = null,
  helperSeen = new Set(),
) {
  const value = simplifyExpression(expression);
  if (!value) return false;
  const state = `${scope.start}:${value}:${lookupBefore}`;
  if (seen.has(state)) return false;
  seen.add(state);

  for (const origin of origins) {
    if (value !== origin.expression) continue;
    const reassignment = assignmentRecordBefore(value, scope, lookupBefore);
    if (reassignment && reassignment.end > origin.start) {
      return strictlyDerivesValue(
        reassignment.value,
        origins,
        scope,
        methods,
        code,
        position,
        reassignment.start,
        seen,
        extraDirectMatch,
        helperSeen,
      );
    }
    return !identityValueWasAltered(
      scope,
      origin.identityName ?? origin.expression,
      origin.start,
      position,
      methods,
      code,
      helperSeen,
    );
  }

  if (extraDirectMatch?.(value, position)) return true;

  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    const assignment = assignmentRecordBefore(value, scope, lookupBefore);
    if (!assignment || identityValueWasAltered(
      scope,
      value,
      assignment.end,
      position,
      methods,
      code,
      helperSeen,
    )) {
      return false;
    }
    return strictlyDerivesValue(
      assignment.value,
      origins,
      scope,
      methods,
      code,
      position,
      assignment.start,
      seen,
      extraDirectMatch,
      helperSeen,
    );
  }

  const invocation = exactInvocation(value);
  if (!invocation) return false;
  return methods
    .filter((candidate) => candidate.name === invocation.name)
    .some((candidate) =>
      transparentParameterIndexes(candidate, methods, code, helperSeen)
        .some((parameter) =>
          invocation.args[parameter] &&
          strictlyDerivesValue(
            invocation.args[parameter],
            origins,
            scope,
            methods,
            code,
            position,
            lookupBefore,
            new Set(seen),
            extraDirectMatch,
            helperSeen,
          )));
}

function generatedValueEnd(method, name) {
  return callsNamed(method.body, "nextBytes")
    .filter((call) =>
      call.args.length === 1 && simplifyExpression(call.args[0]) === name)
    .at(-1)?.end ?? 0;
}

function matchesSelectedCall(actual, expected, method) {
  return actual &&
    actual.args.length === expected.args.length &&
    compactCode(actual.receiver) === compactCode(receiverOfCall(method, expected)) &&
    actual.args.every((argument, index) =>
      compactCode(argument) === compactCode(expected.args[index]));
}

function exactOperationResult(
  expression,
  operationName,
  operation,
  accessor,
  method,
  methods,
  code,
  position,
) {
  return strictlyDerivesValue(
    expression,
    [],
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value) => {
      const result = accessor
        ? exactMethodCall(value, accessor)
        : exactMethodCall(value, operationName);
      if (!result || (accessor && result.args.length !== 0)) return false;
      const operationExpression = accessor ? result.receiver : value;
      return matchesSelectedCall(
        exactMethodCall(operationExpression, operationName),
        operation,
        method,
      );
    },
  );
}

function assignmentIsExactOperationResult(
  method,
  name,
  operationName,
  operation,
  accessor,
  methods,
  code,
) {
  const assignment = assignmentRecords(name, method)
    .find((record) => record.start <= operation.end && operation.end <= record.end);
  return !assignment || exactOperationResult(
    assignment.value,
    operationName,
    operation,
    accessor,
    method,
    methods,
    code,
    assignment.end,
  );
}

function resolvesNumber(expression, expected, scope, methods, code) {
  return resolvesExpression(
    expression, scope, methods, code,
    (value) => new RegExp(`^${expected}$`).test(value.trim()),
  );
}

function dataKeyVariables(method, methods, code) {
  const keys = [];
  for (const match of method.body.matchAll(
    /\b(?:byte\s*\[\s*\]|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+byte\s*\[\s*([^\]]+)\s*\]\s*;/g,
  )) {
    const name = match[1];
    if (
      resolvesNumber(match[2], 32, method, methods, code) &&
      new RegExp(`\\b(?:\\w+|new\\s+SecureRandom\\s*\\(\\))\\s*\\.\\s*nextBytes\\s*\\(\\s*${escapeRegExp(name)}\\s*\\)`).test(method.body)
    ) {
      keys.push(name);
    }
  }
  return keys;
}

function ivVariables(method, methods, code) {
  const ivs = [];
  for (const match of method.body.matchAll(
    /\b(?:byte\s*\[\s*\]|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+byte\s*\[\s*([^\]]+)\s*\]\s*;/g,
  )) {
    const name = match[1];
    if (
      resolvesNumber(match[2], 12, method, methods, code) &&
      new RegExp(`\\b(?:\\w+|new\\s+SecureRandom\\s*\\(\\))\\s*\\.\\s*nextBytes\\s*\\(\\s*${escapeRegExp(name)}\\s*\\)`).test(method.body)
    ) {
      ivs.push(name);
    }
  }
  return ivs;
}

function cipherDefinitions(method, methods, code) {
  return callsNamed(method.body, "getInstance")
    .filter((call) => /(?:\bCipher|\bjavax\.crypto\.Cipher)\s*\.\s*$/.test(
      method.body.slice(Math.max(0, call.start - 100), call.start),
    ))
    .map((call) => {
      const assigned = /(?:\bCipher|\bjavax\.crypto\.Cipher|\bvar)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:javax\.crypto\.)?Cipher\s*\.\s*$/.exec(
        method.body.slice(Math.max(0, call.start - 160), call.start),
      )?.[1];
      return {
        ...call,
        variable: assigned,
        aesGcm: resolvesExpression(
          call.args[0] ?? "", method, methods, code,
          (value) => /^"AES\/GCM\/NoPadding"$/.test(value.trim()),
        ),
      };
    })
    .filter(({ variable, aesGcm }) => variable && aesGcm);
}

function callsOnVariable(method, name, variable) {
  return callsNamed(method.body, name).filter((call) =>
    new RegExp(`\\b${escapeRegExp(variable)}\\s*\\.\\s*$`).test(
      method.body.slice(Math.max(0, call.start - 100), call.start),
    ));
}

function cipherOperations(method, methods, code, mode, key, iv) {
  const operations = [];
  for (const cipher of cipherDefinitions(method, methods, code)) {
    const init = callsOnVariable(method, "init", cipher.variable).find((call) =>
      call.start > cipher.end &&
      new RegExp(`\\b(?:Cipher|javax\\.crypto\\.Cipher)\\s*\\.\\s*${mode}\\b`).test(call.args[0] ?? "") &&
      /\b(?:SecretKeySpec|javax\.crypto\.spec\.SecretKeySpec)\b/.test(call.args.join(", ")) &&
      /\b(?:GCMParameterSpec|javax\.crypto\.spec\.GCMParameterSpec)\b/.test(call.args.join(", ")) &&
      (!key || expressionDependsOn(call.args.slice(1).join(", "), key, method, code)) &&
      (!iv || expressionDependsOn(call.args.slice(1).join(", "), iv, method, code)),
    );
    if (!init) continue;
    const doFinal = callsOnVariable(method, "doFinal", cipher.variable).find((call) =>
      call.start > init.end,
    );
    if (!doFinal) continue;
    const output = callResultVariable(method, doFinal);
    operations.push({ cipher, init, doFinal, output });
  }
  return operations;
}

function cipherOperation(method, methods, code, mode, key, iv) {
  return cipherOperations(method, methods, code, mode, key, iv)[0] ?? null;
}

function exactValueFromOrigin(
  expression,
  origin,
  method,
  methods,
  code,
  position,
) {
  return strictlyDerivesValue(
    expression,
    [origin],
    method,
    methods,
    code,
    position,
  );
}

function exactAccessorValue(
  expression,
  accessor,
  origin,
  method,
  methods,
  code,
  position,
) {
  const origins = [origin];
  return strictlyDerivesValue(
    expression,
    origins,
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value, useAt) => {
      const call = exactMethodCall(value, accessor);
      return Boolean(
        call &&
        call.args.length === 0 &&
        strictlyDerivesValue(
          call.receiver,
          origins,
          method,
          methods,
          code,
          useAt,
        ),
      );
    },
  );
}

function exactGeneratedValue(
  expression,
  generated,
  method,
  methods,
  code,
  position,
) {
  return exactValueFromOrigin(
    expression,
    valueOrigin(method, generated, generatedValueEnd(method, generated)),
    method,
    methods,
    code,
    position,
  );
}

function exactPlaintextInput(
  expression,
  plaintext,
  method,
  methods,
  code,
  position,
) {
  const origin = {
    expression: plaintext,
    identityName: plaintext,
    start: 0,
  };
  const origins = [origin];
  return strictlyDerivesValue(
    expression,
    origins,
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value, useAt) => {
      const call = exactMethodCall(value, "getBytes");
      return Boolean(
        call &&
        call.args.length === 1 &&
        isUtf8Charset(call.args[0], method, methods, code) &&
        strictlyDerivesValue(
          call.receiver,
          origins,
          method,
          methods,
          code,
          useAt,
        ),
      );
    },
  );
}

function exactWrappedDek(
  expression,
  wrapped,
  method,
  methods,
  code,
  wrapEnd,
  position,
) {
  const wrap = callsNamed(method.body, "wrapKey")
    .find((call) => call.end === wrapEnd);
  if (
    wrap &&
    !assignmentIsExactOperationResult(
      method,
      wrapped,
      "wrapKey",
      wrap,
      "getEncryptedKey",
      methods,
      code,
    )
  ) {
    return false;
  }
  return exactAccessorValue(
    expression,
    "getEncryptedKey",
    valueOrigin(method, wrapped, wrapEnd),
    method,
    methods,
    code,
    position,
  );
}

function exactUnwrappedDek(
  expression,
  unwrapped,
  method,
  methods,
  code,
  unwrapEnd,
  position,
) {
  const unwrap = callsNamed(method.body, "unwrapKey")
    .find((call) => call.end === unwrapEnd);
  if (
    unwrap &&
    !assignmentIsExactOperationResult(
      method,
      unwrapped,
      "unwrapKey",
      unwrap,
      "getKey",
      methods,
      code,
    )
  ) {
    return false;
  }
  return exactAccessorValue(
    expression,
    "getKey",
    valueOrigin(method, unwrapped, unwrapEnd),
    method,
    methods,
    code,
    position,
  );
}

function isBase64Encoder(receiver) {
  return /^(?:java\.util\.)?Base64\.getEncoder\(\)$/.test(compactCode(receiver));
}

function isBase64Decoder(receiver) {
  return /^(?:java\.util\.)?Base64\.getDecoder\(\)$/.test(compactCode(receiver));
}

function exactBase64EncodingFrom(
  expression,
  sourceMatches,
  method,
  methods,
  code,
  position,
) {
  return strictlyDerivesValue(
    expression,
    [],
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value) => {
      const call = exactMethodCall(value, "encodeToString");
      return Boolean(
        call &&
        call.args.length === 1 &&
        isBase64Encoder(call.receiver) &&
        sourceMatches(call.args[0], position),
      );
    },
  );
}

function exactStringLiteral(expression, expected, method, methods, code, position) {
  return strictlyDerivesValue(
    expression,
    [],
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value) => value === `"${expected}"`,
  );
}

function exactMetadataContainer(
  expression,
  metadata,
  method,
  methods,
  code,
  position,
) {
  const origins = [initialValueOrigin(method, metadata)];
  return strictlyDerivesValue(
    expression,
    origins,
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value, useAt) => {
      const call = exactMethodCall(value, "getMetadata");
      return Boolean(
        call &&
        call.args.length === 0 &&
        strictlyDerivesValue(
          call.receiver,
          origins,
          method,
          methods,
          code,
          useAt,
        ),
      );
    },
  );
}

function exactMetadataField(
  expression,
  key,
  metadata,
  method,
  methods,
  code,
  position,
) {
  return strictlyDerivesValue(
    expression,
    [],
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value, useAt) => {
      const call = exactMethodCall(value, "get");
      return Boolean(
        call &&
        call.args.length === 1 &&
        exactStringLiteral(call.args[0], key, method, methods, code, useAt) &&
        exactMetadataContainer(
          call.receiver,
          metadata,
          method,
          methods,
          code,
          useAt,
        ),
      );
    },
  );
}

function exactBase64MetadataValue(
  expression,
  key,
  metadata,
  method,
  methods,
  code,
  position,
) {
  return strictlyDerivesValue(
    expression,
    [],
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value, useAt) => {
      const call = exactMethodCall(value, "decode");
      return Boolean(
        call &&
        call.args.length === 1 &&
        isBase64Decoder(call.receiver) &&
        exactMetadataField(
          call.args[0],
          key,
          metadata,
          method,
          methods,
          code,
          useAt,
        ),
      );
    },
  );
}

function exactSecretKeySpec(
  expression,
  sourceMatches,
  method,
  methods,
  code,
  position,
) {
  return strictlyDerivesValue(
    expression,
    [],
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value) => {
      const constructor = exactConstructorCall(value, "SecretKeySpec");
      return Boolean(
        constructor &&
        constructor.args.length >= 2 &&
        sourceMatches(constructor.args[0], position),
      );
    },
  );
}

function exactGcmParameterSpec(
  expression,
  sourceMatches,
  method,
  methods,
  code,
  position,
) {
  return strictlyDerivesValue(
    expression,
    [],
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value) => {
      const constructor = exactConstructorCall(value, "GCMParameterSpec");
      return Boolean(
        constructor &&
        constructor.args.length >= 2 &&
        sourceMatches(constructor.args[1], position),
      );
    },
  );
}

function cipherInitUsesExactSecretKey(
  init,
  sourceMatches,
  method,
  methods,
  code,
) {
  return init.args.slice(1).some((argument) =>
    exactSecretKeySpec(
      argument,
      sourceMatches,
      method,
      methods,
      code,
      init.start,
    ));
}

function cipherInitUsesExactGcmParameter(
  init,
  sourceMatches,
  method,
  methods,
  code,
) {
  return init.args.slice(1).some((argument) =>
    exactGcmParameterSpec(
      argument,
      sourceMatches,
      method,
      methods,
      code,
      init.start,
    ));
}

function exactDownloadedCiphertext(
  expression,
  downloaded,
  method,
  methods,
  code,
  downloadEnd,
  position,
  downloadCall = null,
) {
  const origins = downloaded
    ? [valueOrigin(method, downloaded, downloadEnd)]
    : [];
  if (downloaded && downloadCall) {
    const direct = assignmentIsExactOperationResult(
      method,
      downloaded,
      "downloadContent",
      downloadCall,
      null,
      methods,
      code,
    );
    const bytes = assignmentIsExactOperationResult(
      method,
      downloaded,
      "downloadContent",
      downloadCall,
      "toBytes",
      methods,
      code,
    );
    if (!direct && !bytes) return false;
  }
  return strictlyDerivesValue(
    expression,
    origins,
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value, useAt) => {
      const call = exactMethodCall(value, "toBytes");
      if (!call || call.args.length !== 0) return false;
      if (
        origins.length > 0 &&
        strictlyDerivesValue(
          call.receiver,
          origins,
          method,
          methods,
          code,
          useAt,
        )
      ) {
        return true;
      }
      const download = exactMethodCall(call.receiver, "downloadContent");
      return Boolean(
        download &&
        download.args.length === 0 &&
        (
          !downloadCall ||
          compactCode(download.receiver) === compactCode(
            receiverOfCall(method, downloadCall),
          )
        ),
      );
    },
  );
}

function exactCipherOperationOutput(
  expression,
  operation,
  method,
  methods,
  code,
  position,
) {
  const origins = operation.output
    ? [valueOrigin(method, operation.output, operation.doFinal.end)]
    : [];
  if (
    operation.output &&
    !assignmentIsExactOperationResult(
      method,
      operation.output,
      "doFinal",
      operation.doFinal,
      null,
      methods,
      code,
    )
  ) {
    return false;
  }
  return strictlyDerivesValue(
    expression,
    origins,
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value) => {
      const call = exactMethodCall(value, "doFinal");
      return Boolean(
        call &&
        compactCode(call.receiver) === compactCode(operation.cipher.variable) &&
        call.args.length === operation.doFinal.args.length &&
        call.args.every((argument, index) =>
          compactCode(argument) === compactCode(operation.doFinal.args[index])),
      );
    },
  );
}

function isUtf8Charset(expression, method, methods, code) {
  return resolvesExpression(
    expression,
    method,
    methods,
    code,
    (value) =>
      /^(?:java\.nio\.charset\.)?StandardCharsets\.UTF_8$/.test(value.trim()) ||
      /^"UTF-8"$/.test(value.trim()),
  );
}

function exactDecryptedValue(
  expression,
  operation,
  method,
  methods,
  code,
  position,
) {
  return strictlyDerivesValue(
    expression,
    [],
    method,
    methods,
    code,
    position,
    position,
    new Set(),
    (value, useAt) => {
      if (
        exactCipherOperationOutput(
          value,
          operation,
          method,
          methods,
          code,
          useAt,
        )
      ) {
        return true;
      }
      const constructor = exactConstructorCall(value, "String");
      return Boolean(
        constructor &&
        constructor.args.length >= 2 &&
        exactCipherOperationOutput(
          constructor.args[0],
          operation,
          method,
          methods,
          code,
          useAt,
        ) &&
        isUtf8Charset(constructor.args[1], method, methods, code),
      );
    },
  );
}

function returnsExactCipherOutput(method, operation, methods, code, from = 0) {
  return Array.from(method.body.matchAll(/\breturn\s+([\s\S]*?);/g))
    .some((match) =>
      match.index >= from &&
      exactCipherOperationOutput(
        match[1],
        operation,
        method,
        methods,
        code,
        match.index,
      ));
}

function returnsExactDecryptedValue(method, operation, methods, code, from = 0) {
  return Array.from(method.body.matchAll(/\breturn\s+([\s\S]*?);/g))
    .some((match) =>
      match.index >= from &&
      exactDecryptedValue(
        match[1],
        operation,
        method,
        methods,
        code,
        match.index,
      ));
}

function hasRealCryptoTypes(code) {
  const structuralCode = maskStringContents(code);
  return !/\b(?:class|interface|record)\s+(?:Cipher|GCMParameterSpec|SecretKeySpec|SecureRandom|BlobClient|BlobAsyncClient|CryptographyClient|CryptographyAsyncClient|KeyClient)\b/.test(
    structuralCode,
  );
}

function allCipherTransformationsAreAesGcm(methods, code) {
  return methods.every((method) =>
    callsNamed(method.body, "getInstance")
      .filter((call) => /(?:\bCipher|\bjavax\.crypto\.Cipher)\s*\.\s*$/.test(
        method.body.slice(Math.max(0, call.start - 100), call.start),
      ))
      .every((call) => resolvesExpression(
        call.args[0] ?? "", method, methods, code,
        (value) => /^"AES\/GCM\/NoPadding"$/.test(value.trim()),
      )));
}

function callResultVariable(method, call) {
  const prefix = method.body.slice(0, call.start);
  const statementStart = Math.max(
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("{"),
    prefix.lastIndexOf("}"),
  ) + 1;
  return /\b([A-Za-z_$][\w$]*)\s*=\s*[\s\S]*$/.exec(
    prefix.slice(statementStart),
  )?.[1];
}

function expressionContainsText(expression, text, scope, methods, code, seen = new Set()) {
  if (expression.includes(`"${text}"`)) return true;
  for (const identifier of expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const name = identifier[1];
    if (seen.has(name)) continue;
    seen.add(name);
    if (resolvesExpression(
      name, scope, methods, code, (value) => value.trim() === `"${text}"`,
    )) {
      return true;
    }
  }
  return false;
}

function metadataEntriesBefore(method, before, methods, code) {
  return callsNamed(method.body, "put")
    .filter((call) => call.end <= before)
    .map((call) => ({
      call,
      owner: /\b([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(
        method.body.slice(Math.max(0, call.start - 100), call.start),
      )?.[1],
    }))
    .filter(({ owner, call }) => owner && call.args.length >= 2)
    .map(({ owner, call }) => ({
      call,
      owner,
      key: call.args[0],
      value: call.args[1],
    }));
}

function exposesRawDek(expression, dek, scope, code, seen = new Set()) {
  if (new RegExp(`\\b${escapeRegExp(dek)}\\b`).test(expression)) return true;
  return Array.from(expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g))
    .some((match) => {
      const name = match[1];
      if (seen.has(name)) return false;
      seen.add(name);
      const assigned = assignmentValue(name, scope, code);
      return assigned &&
        !/\bwrapKey\s*\(/.test(assigned) &&
        exposesRawDek(assigned, dek, scope, code, seen);
    });
}

function metadataForUpload(
  method, methods, code, upload, wrapped, dek, iv, cryptoCall, cryptoType,
) {
  const entries = metadataEntriesBefore(method, upload.start, methods, code);
  const owners = new Set(entries.map(({ owner }) => owner));
  for (const owner of owners) {
    const metadata = entries.filter((entry) => entry.owner === owner);
    const entryFor = (key) => metadata
      .filter((entry) =>
        exactStringLiteral(
          entry.key,
          key,
          method,
          methods,
          code,
          entry.call.start,
        ))
      .at(-1);
    const wrappedEntry = entryFor("wrapped-dek");
    const ivEntry = entryFor("iv");
    const keyIdEntry = entryFor("vault-key-id");
    if (
      !wrappedEntry ||
      !ivEntry ||
      !keyIdEntry ||
      !exactBase64EncodingFrom(
        wrappedEntry.value,
        (value, useAt) =>
          exactWrappedDek(
            value,
            wrapped,
            method,
            methods,
            code,
            cryptoCall.end,
            useAt,
          ),
        method,
        methods,
        code,
        wrappedEntry.call.start,
      ) ||
      !exactBase64EncodingFrom(
        ivEntry.value,
        (value, useAt) =>
          exactGeneratedValue(value, iv, method, methods, code, useAt),
        method,
        methods,
        code,
        ivEntry.call.start,
      ) ||
      !isActualVaultKeyId(keyIdEntry.value, method, methods, code) ||
      !cryptoCallUsesActualKeyId(
        method,
        cryptoCall,
        keyIdEntry.value,
        cryptoType,
        methods,
        code,
      ) ||
      metadata.some((entry) => exposesRawDek(entry.value, dek, method, code)) ||
      !expressionDependsOn(upload.args.join(", "), owner, method, code)
    ) {
      continue;
    }
    return owner;
  }
  return "";
}

function flowValueIsReassigned(method, value, after, before) {
  if (!value || after >= before) return false;
  const pattern = new RegExp(
    `\\b${escapeRegExp(value)}\\s*=(?!=)`,
    "g",
  );
  return pattern.test(method.body.slice(after, before));
}

function uploadCarriesCiphertext(
  upload, ciphertext, method, code, encryptionEnd = -1,
) {
  if (!ciphertext) return false;
  const origin = valueOrigin(method, ciphertext, encryptionEnd);
  const argumentsText = upload.args.join(", ");
  const binaryData = callsNamed(argumentsText, "fromBytes").some((call) =>
    /\bBinaryData\s*\.\s*$/.test(
      argumentsText.slice(Math.max(0, call.start - 100), call.start),
    ) &&
    call.args.length === 1 &&
    exactValueFromOrigin(
      call.args[0],
      origin,
      method,
      methodBodies(code),
      code,
      upload.start,
    ));
  return binaryData ||
    callsNamed(argumentsText, "ByteArrayInputStream").some((call) =>
      /\bnew\s+(?:java\.io\.)?ByteArrayInputStream\s*$/.test(
        argumentsText.slice(Math.max(0, call.start - 100), call.start),
      ) &&
      call.args.length === 1 &&
      exactValueFromOrigin(
        call.args[0],
        origin,
        method,
        methodBodies(code),
        code,
        upload.start,
      ));
}

function persistsRawDek(method, dek, code) {
  return ["encodeToString", "write", "writeString", "setMetadata"]
    .some((name) => callsNamed(method.body, name).some((call) =>
      call.args.some((argument) => exposesRawDek(argument, dek, method, code)))) ||
    callsNamed(method.body, "put").some((call) =>
      call.args.slice(1).some((argument) =>
        exposesRawDek(argument, dek, method, code)));
}

function returnMakesPositionUnreachable(body, position) {
  for (const match of body.matchAll(/\breturn\b/g)) {
    if (match.index >= position) continue;
    const terminator = body.indexOf(";", match.index);
    if (terminator < 0 || terminator >= position) continue;
    let depth = 0;
    for (let index = 0; index < match.index; index += 1) {
      if (body[index] === "{") depth += 1;
      if (body[index] === "}") depth -= 1;
    }
    let end = body.length;
    let currentDepth = depth;
    for (let index = terminator + 1; index < body.length; index += 1) {
      if (body[index] === "{") currentDepth += 1;
      if (body[index] === "}" && --currentDepth < depth) {
        end = index;
        break;
      }
    }
    if (position < end) return true;
  }
  return false;
}

function hasGuaranteedReturnBefore(body, position) {
  for (const match of body.matchAll(/\bif\s*\(\s*true\s*\)\s*\{/g)) {
    const open = body.indexOf("{", match.index);
    const close = matchingBrace(body, open);
    if (
      close >= 0 &&
      close < position &&
      /\breturn\b/.test(body.slice(open + 1, close))
    ) {
      return true;
    }
  }
  return false;
}

function hasBypassReturn(
  method, before, plaintext, code, allowsReactiveError = false,
) {
  for (const match of method.body.slice(0, before).matchAll(
    /\breturn\s+([\s\S]*?);/g,
  )) {
    const value = match[1];
    if (
      !allowsReactiveError ||
      !/\bMono\s*\.\s*error\s*\(/.test(value)
    ) {
      return true;
    }
    if (expressionDependsOn(value, plaintext, method, code)) return true;
  }
  return returnMakesPositionUnreachable(method.body, before) ||
    hasGuaranteedReturnBefore(method.body, before);
}

function hasConstantReactiveResult(method) {
  return /\.\s*thenReturn\s*\(/.test(method.body) ||
    /\.\s*map\s*\(\s*\w+\s*->\s*"(?:\\.|[^"\\])*"\s*\)/.test(method.body);
}

function encryptionOperation(method, methods, code, plaintext, dek, iv) {
  for (const operation of cipherOperations(
    method, methods, code, "ENCRYPT_MODE", dek, iv,
  )) {
    if (
      operation.output &&
      exactPlaintextInput(
        operation.doFinal.args[0] ?? "",
        plaintext,
        method,
        methods,
        code,
        operation.doFinal.start,
      ) &&
      exactCipherOperationOutput(
        operation.output,
        operation,
        method,
        methods,
        code,
        operation.doFinal.end,
      ) &&
      cipherInitUsesExactSecretKey(
        operation.init,
        (value, useAt) =>
          exactGeneratedValue(value, dek, method, methods, code, useAt),
        method,
        methods,
        code,
      ) &&
      cipherInitUsesExactGcmParameter(
        operation.init,
        (value, useAt) =>
          exactGeneratedValue(value, iv, method, methods, code, useAt),
        method,
        methods,
        code,
      )
    ) {
      return { ...operation, flowStart: operation.cipher.start, flowEnd: operation.doFinal.end };
    }
  }

  for (const helper of methods) {
    const parameters = parameterNames(helper.parameters);
    if (parameters.length < 3) continue;
    const helperOperation = cipherOperation(
      helper, methods, code, "ENCRYPT_MODE", parameters[1], parameters[2],
    );
    if (
      !helperOperation ||
      !exactPlaintextInput(
        helperOperation.doFinal.args[0] ?? "",
        parameters[0],
        helper,
        methods,
        code,
        helperOperation.doFinal.start,
      ) ||
      !cipherInitUsesExactSecretKey(
        helperOperation.init,
        (value, useAt) =>
          exactValueFromOrigin(
            value,
            {
              expression: parameters[1],
              identityName: parameters[1],
              start: 0,
            },
            helper,
            methods,
            code,
            useAt,
          ),
        helper,
        methods,
        code,
      ) ||
      !cipherInitUsesExactGcmParameter(
        helperOperation.init,
        (value, useAt) =>
          exactValueFromOrigin(
            value,
            {
              expression: parameters[2],
              identityName: parameters[2],
              start: 0,
            },
            helper,
            methods,
            code,
            useAt,
          ),
        helper,
        methods,
        code,
      ) ||
      !returnsExactCipherOutput(helper, helperOperation, methods, code)
    ) {
      continue;
    }
    for (const call of callsNamed(method.body, helper.name)) {
      const output = callResultVariable(method, call);
      if (
        output &&
        exactPlaintextInput(
          call.args[0] ?? "",
          plaintext,
          method,
          methods,
          code,
          call.start,
        ) &&
        exactGeneratedValue(
          call.args[1] ?? "",
          dek,
          method,
          methods,
          code,
          call.start,
        ) &&
        exactGeneratedValue(
          call.args[2] ?? "",
          iv,
          method,
          methods,
          code,
          call.start,
        )
      ) {
        return { output, flowStart: call.start, flowEnd: call.end };
      }
    }
  }
  return null;
}

function expressionIsExactCallResult(
  expression,
  name,
  expectedArguments,
  method,
  methods,
  code,
  seen = new Set(),
) {
  const invocation = exactInvocation(expression);
  if (!invocation) return false;
  if (
    invocation.name === name &&
    invocation.args.length === expectedArguments.length &&
    invocation.args.every((argument, index) =>
      compactCode(argument) === compactCode(expectedArguments[index]))
  ) {
    return true;
  }

  const state = `${invocation.name}:${compactCode(expression)}`;
  if (seen.has(state)) return false;
  seen.add(state);
  return methods
    .filter((candidate) => candidate.name === invocation.name)
    .some((candidate) =>
      transparentParameterIndexes(candidate, methods, code)
        .some((parameter) =>
          invocation.args[parameter] &&
          expressionIsExactCallResult(
            invocation.args[parameter],
            name,
            expectedArguments,
            method,
            methods,
            code,
            seen,
          )));
}

function scopeReturnsExactDecryptedValue(
  method,
  start,
  end,
  operation,
  methods,
  code,
) {
  const body = method.body.slice(start, end).trim();
  if (body.startsWith("{")) {
    const returns = Array.from(body.matchAll(/\breturn\s+([\s\S]*?);/g));
    return returns.length > 0 && returns.every((match) =>
      exactDecryptedValue(
        match[1],
        operation,
        method,
        methods,
        code,
        start + match.index,
      ));
  }
  return exactDecryptedValue(body, operation, method, methods, code, start);
}

function scopeReturnsExactDecryptCall(
  method,
  start,
  end,
  call,
  methods,
  code,
) {
  const body = method.body.slice(start, end).trim();
  const matches = body.startsWith("{")
    ? Array.from(body.matchAll(/\breturn\s+([\s\S]*?);/g), (match) => match[1])
    : [body];
  return matches.length > 0 && matches.every((expression) =>
    expressionIsExactCallResult(
      expression,
      "decrypt",
      call.args,
      method,
      methods,
      code,
    ));
}

function decryptsDownloadedValue(
  method,
  methods,
  code,
  start,
  end,
  ciphertext,
  dek,
  metadata,
  downloadEnd = start,
  unwrapEnd = start,
  downloadCall = null,
) {
  for (const operation of cipherOperations(
    method, methods, code, "DECRYPT_MODE", dek, null,
  )) {
    if (
      operation.init.start > start &&
      operation.doFinal.end <= end &&
      exactDownloadedCiphertext(
        operation.doFinal.args[0] ?? "",
        ciphertext,
        method,
        methods,
        code,
        downloadEnd,
        operation.doFinal.start,
        downloadCall,
      ) &&
      cipherInitUsesExactSecretKey(
        operation.init,
        (value, useAt) =>
          exactUnwrappedDek(
            value,
            dek,
            method,
            methods,
            code,
            unwrapEnd,
            useAt,
          ),
        method,
        methods,
        code,
      ) &&
      cipherInitUsesExactGcmParameter(
        operation.init,
        (value, useAt) =>
          exactBase64MetadataValue(
            value,
            "iv",
            metadata,
            method,
            methods,
            code,
            useAt,
          ),
        method,
        methods,
        code,
      ) &&
      (
        returnsExactDecryptedValue(
          method,
          operation,
          methods,
          code,
          start,
        ) ||
        scopeReturnsExactDecryptedValue(
          method,
          start,
          end,
          operation,
          methods,
          code,
        )
      )
    ) {
      return true;
    }
  }

  for (const call of callsNamed(method.body, "decrypt")) {
    if (call.start < start || call.end > end) continue;
    const helper = methods.find((candidate) =>
      candidate.name === method.body.slice(call.start, call.open).trim(),
    );
    const parameters = helper && parameterNames(helper.parameters);
    if (
      !helper ||
      parameters.length < 3 ||
      !exactDownloadedCiphertext(
        call.args[0] ?? "",
        ciphertext,
        method,
        methods,
        code,
        downloadEnd,
        call.start,
        downloadCall,
      ) ||
      !exactUnwrappedDek(
        call.args[1] ?? "",
        dek,
        method,
        methods,
        code,
        unwrapEnd,
        call.start,
      ) ||
      !exactBase64MetadataValue(
        call.args[2] ?? "",
        "iv",
        metadata,
        method,
        methods,
        code,
        call.start,
      )
    ) {
      continue;
    }
    const helperOperation = cipherOperation(
      helper, methods, code, "DECRYPT_MODE", parameters[1], parameters[2],
    );
    if (
      !helperOperation ||
      !exactDownloadedCiphertext(
        helperOperation.doFinal.args[0] ?? "",
        parameters[0],
        helper,
        methods,
        code,
        0,
        helperOperation.doFinal.start,
      ) ||
      !cipherInitUsesExactSecretKey(
        helperOperation.init,
        (value, useAt) =>
          exactValueFromOrigin(
            value,
            {
              expression: parameters[1],
              identityName: parameters[1],
              start: 0,
            },
            helper,
            methods,
            code,
            useAt,
          ),
        helper,
        methods,
        code,
      ) ||
      !cipherInitUsesExactGcmParameter(
        helperOperation.init,
        (value, useAt) =>
          exactValueFromOrigin(
            value,
            {
              expression: parameters[2],
              identityName: parameters[2],
              start: 0,
            },
            helper,
            methods,
            code,
            useAt,
          ),
        helper,
        methods,
        code,
      ) ||
      !returnsExactDecryptedValue(helper, helperOperation, methods, code) ||
      !scopeReturnsExactDecryptCall(method, start, end, call, methods, code)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function usesRsaOaep(expression, method, methods, code) {
  return resolvesExpression(
    expression, method, methods, code,
    (value) => /^KeyWrapAlgorithm\.RSA_OAEP(?:_256)?$/.test(value.trim()),
  );
}

function localAssignmentValue(name, method, before = method.body.length) {
  const simple = name.replace(/^this\s*\.\s*/, "");
  const pattern = new RegExp(
    `(?:\\b(?:final\\s+)?(?:[A-Za-z_$][\\w$<>.\\[\\]]*|var)\\s+)?\\b${escapeRegExp(simple)}\\s*=\\s*([^;]+);`,
    "g",
  );
  let value = "";
  for (const match of method.body.slice(0, before).matchAll(pattern)) {
    value = match[1].trim();
  }
  return value;
}

function clientBuilderFor(type) {
  return CLIENT_BUILDERS[type] ?? [];
}

function methodBuildsOfficialClient(method, type, code) {
  const [builder, buildMethod] = clientBuilderFor(type);
  if (!builder || !hasOfficialSdkType(code, builder)) return false;
  const constructor = new RegExp(
    `\\bnew\\s+(?:(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*)${builder}\\s*\\(`,
  );
  return constructor.test(method.body) &&
    new RegExp(`\\.\\s*${buildMethod}\\s*\\(`).test(method.body);
}

function factoryCallBuildsClient(expression, type, method, methods, code) {
  const [builder, buildMethod] = clientBuilderFor(type);
  if (!builder || !hasOfficialSdkType(code, builder)) return false;
  const directBuilder = new RegExp(
    `\\bnew\\s+(?:(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*)${builder}\\s*\\([\\s\\S]*?\\.\\s*${buildMethod}\\s*\\(`,
  );
  if (directBuilder.test(expression)) return true;

  return methods.some((candidate) =>
    methodBuildsOfficialClient(candidate, type, code) &&
    callsNamed(expression, candidate.name).length > 0 &&
    candidate !== method);
}

function isOfficialClientReference(
  expression, type, method, methods, code, seen = new Set(),
) {
  const value = simplifyExpression(expression);
  const simple = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (!simple) return factoryCallBuildsClient(value, type, method, methods, code);
  const key = `${method.start}:${type}:${simple}`;
  if (seen.has(key)) return false;
  seen.add(key);

  const packageName = SDK_TYPE_PACKAGES[type];
  if (!packageName || !hasOfficialSdkType(code, type)) return false;
  const typePattern = `(?:${escapeRegExp(type)}|${packageName.replace(/\./g, "\\.")}\\.${escapeRegExp(type)})`;
  const declaration = new RegExp(
    `\\b(?:final\\s+)?${typePattern}(?:\\s*<[^;=(){}]+>)?(?:\\s*\\[\\s*\\])?\\s+${escapeRegExp(simple)}\\b`,
  );
  if (declaration.test(method.parameters) || declaration.test(method.body)) {
    return true;
  }
  const fieldDeclaration = new RegExp(
    `\\b(?:public|protected|private)(?:\\s+(?:static|final|volatile|transient))*\\s+${typePattern}(?:\\s*<[^;=(){}]+>)?(?:\\s*\\[\\s*\\])?\\s+${escapeRegExp(simple)}\\s*(?:;|=)`,
  );
  if (fieldDeclaration.test(code)) return true;

  const assigned = localAssignmentValue(simple, method);
  if (assigned && factoryCallBuildsClient(assigned, type, method, methods, code)) {
    return true;
  }

  if (/^this\s*\./.test(value)) {
    return declaration.test(code);
  }
  return false;
}

function receiverOfCall(method, call) {
  const prefix = method.body.slice(0, call.start).replace(/\s+$/, "");
  return /((?:this\s*\.\s*)?[A-Za-z_$][\w$]*)\s*\.$/.exec(prefix)?.[1] ?? "";
}

function callUsesOfficialClient(method, call, type, methods, code) {
  const receiver = receiverOfCall(method, call);
  return receiver &&
    isOfficialClientReference(receiver, type, method, methods, code);
}

function isKeyResultExpression(expression, method, methods, code, seen = new Set()) {
  const value = simplifyExpression(expression);
  const key = `${method.start}:key:${value}`;
  if (seen.has(key)) return false;
  seen.add(key);

  for (const call of callsNamed(value, "getKey")) {
    const prefix = value.slice(0, call.start).replace(/\.\s*$/, "").trim();
    if (isOfficialClientReference(prefix, "KeyClient", method, methods, code)) {
      return true;
    }
  }

  const name = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (!name) return false;
  const assigned = localAssignmentValue(name, method);
  return assigned
    ? isKeyResultExpression(assigned, method, methods, code, seen)
    : false;
}

function isActualVaultKeyId(
  expression, method, methods, code, seen = new Set(),
) {
  const value = simplifyExpression(expression);
  const key = `${method.start}:key-id:${value}`;
  if (seen.has(key)) return false;
  seen.add(key);

  for (const call of callsNamed(value, "getId")) {
    if (call.end !== value.length) continue;
    const keyExpression = value.slice(0, call.start).replace(/\.\s*$/, "").trim();
    if (isKeyResultExpression(keyExpression, method, methods, code)) {
      return true;
    }
  }

  const name = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (name) {
    const assigned = localAssignmentValue(name, method);
    if (assigned && isActualVaultKeyId(assigned, method, methods, code, seen)) {
      return true;
    }

    const parameter = parameterNames(method.parameters).indexOf(name);
    if (parameter >= 0) {
      for (const caller of methods) {
        if (caller === method) continue;
        for (const call of callsNamed(caller.body, method.name)) {
          if (
            call.args[parameter] &&
            isActualVaultKeyId(call.args[parameter], caller, methods, code, seen)
          ) {
            return true;
          }
        }
      }
    }
  }

  const helper = /^(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)$/.exec(value);
  if (!helper) return false;
  return methods
    .filter((candidate) => candidate.name === helper[1] && candidate !== method)
    .some((candidate) => {
      const returned = /\breturn\s+([^;]+);/.exec(candidate.body)?.[1];
      return returned && isActualVaultKeyId(returned, candidate, methods, code, seen);
    });
}

function expressionsShareValue(left, right, method, methods, code) {
  const resolveAlias = (expression, seen = new Set()) => {
    const value = simplifyExpression(expression);
    const name = /^[A-Za-z_$][\w$]*$/.test(value) ? value : "";
    if (!name || seen.has(name)) return value;
    const assigned = localAssignmentValue(name, method);
    if (!assigned) return value;
    seen.add(name);
    return resolveAlias(assigned, seen);
  };
  const normalizedLeft = resolveAlias(left);
  const normalizedRight = resolveAlias(right);
  if (normalizedLeft === normalizedRight) return true;
  if (/^[A-Za-z_$][\w$]*$/.test(normalizedRight)) {
    return expressionDependsOn(normalizedLeft, normalizedRight, method, code);
  }
  if (/^[A-Za-z_$][\w$]*$/.test(normalizedLeft)) {
    return expressionDependsOn(normalizedRight, normalizedLeft, method, code);
  }
  return false;
}

function factoryBindsKeyIdentifier(
  expression, keyId, type, method, methods, code,
) {
  const keyIdentifier = callsNamed(expression, "keyIdentifier").at(-1);
  if (
    keyIdentifier?.args[0] &&
    expressionsShareValue(
      keyIdentifier.args[0], keyId, method, methods, code,
    )
  ) {
    return true;
  }

  for (const candidate of methods) {
    if (!methodBuildsOfficialClient(candidate, type, code)) continue;
    for (const call of callsNamed(expression, candidate.name)) {
      const identifier = callsNamed(candidate.body, "keyIdentifier").at(-1);
      const parameter = parameterNames(candidate.parameters)
        .findIndex((name) =>
          expressionDependsOn(identifier?.args[0] ?? "", name, candidate, code));
      if (
        parameter >= 0 &&
        call.args[parameter] &&
        expressionsShareValue(call.args[parameter], keyId, method, methods, code)
      ) {
        return true;
      }
    }
  }
  return false;
}

function cryptoCallUsesActualKeyId(
  method, cryptoCall, keyId, type, methods, code,
) {
  if (!callUsesOfficialClient(method, cryptoCall, type, methods, code)) {
    return false;
  }
  const receiver = receiverOfCall(method, cryptoCall);
  const assigned = localAssignmentValue(receiver, method, cryptoCall.start);
  if (
    assigned &&
    factoryBindsKeyIdentifier(assigned, keyId, type, method, methods, code)
  ) {
    return true;
  }

  const parameter = parameterNames(method.parameters).indexOf(receiver);
  if (parameter < 0) return false;
  return methods.some((caller) =>
    caller !== method &&
    callsNamed(caller.body, method.name).some((call) =>
      call.args[parameter] &&
      factoryBindsKeyIdentifier(
        call.args[parameter],
        keyId,
        type,
        caller,
        methods,
        code,
      )));
}

function syncWorkflow(method, methods, code) {
  const parameters = parameterNames(method.parameters);
  for (const plaintext of parameters) {
    for (const dek of dataKeyVariables(method, methods, code)) {
      for (const iv of ivVariables(method, methods, code)) {
        const encrypted = encryptionOperation(
          method, methods, code, plaintext, dek, iv,
        );
        if (
          !encrypted ||
          hasBypassReturn(method, encrypted.flowStart, plaintext, code) ||
          returnMakesPositionUnreachable(method.body, encrypted.flowStart) ||
          persistsRawDek(method, dek, code)
        ) {
          continue;
        }

        for (const wrap of callsNamed(method.body, "wrapKey")) {
          const wrapped = callResultVariable(method, wrap);
          if (
            !wrapped ||
            wrap.start < encrypted.flowEnd ||
            !callUsesOfficialClient(
              method, wrap, "CryptographyClient", methods, code,
            ) ||
            !usesRsaOaep(wrap.args[0] ?? "", method, methods, code) ||
            !exactGeneratedValue(
              wrap.args[1] ?? "",
              dek,
              method,
              methods,
              code,
              wrap.start,
            )
          ) {
            continue;
          }

          for (const upload of callsNamed(method.body, "uploadWithResponse").concat(
            callsNamed(method.body, "upload"),
          )) {
            if (
              upload.start < wrap.end ||
              !callUsesOfficialClient(
                method, upload, "BlobClient", methods, code,
              ) ||
              !uploadCarriesCiphertext(
                upload, encrypted.output, method, code, encrypted.flowEnd,
              ) ||
              !metadataForUpload(
                method,
                methods,
                code,
                upload,
                wrapped,
                dek,
                iv,
                wrap,
                "CryptographyClient",
              )
            ) {
              continue;
            }

            for (const properties of callsNamed(method.body, "getProperties")) {
              const metadata = callResultVariable(method, properties);
              if (
                !metadata ||
                properties.start < upload.end ||
                !callUsesOfficialClient(
                  method, properties, "BlobClient", methods, code,
                ) ||
                !assignmentIsExactOperationResult(
                  method,
                  metadata,
                  "getProperties",
                  properties,
                  null,
                  methods,
                  code,
                ) &&
                !assignmentIsExactOperationResult(
                  method,
                  metadata,
                  "getProperties",
                  properties,
                  "getMetadata",
                  methods,
                  code,
                )
              ) {
                continue;
              }

              for (const unwrap of callsNamed(method.body, "unwrapKey")) {
                const unwrapped = callResultVariable(method, unwrap);
                if (
                  !unwrapped ||
                  unwrap.start < properties.end ||
                  !callUsesOfficialClient(
                    method, unwrap, "CryptographyClient", methods, code,
                  ) ||
                  !usesRsaOaep(unwrap.args[0] ?? "", method, methods, code) ||
                  !exactBase64MetadataValue(
                    unwrap.args[1] ?? "",
                    "wrapped-dek",
                    metadata,
                    method,
                    methods,
                    code,
                    unwrap.start,
                  )
                ) {
                  continue;
                }

                const download = callsNamed(method.body, "downloadContent").find((call) =>
                  call.start > unwrap.end,
                );
                if (
                  !download ||
                  !callUsesOfficialClient(
                    method, download, "BlobClient", methods, code,
                  ) ||
                  !decryptsDownloadedValue(
                    method,
                    methods,
                    code,
                    unwrap.end,
                    method.body.length,
                    callResultVariable(method, download),
                    unwrapped,
                    metadata,
                    download.end,
                    unwrap.end,
                    download,
                  )
                ) {
                  continue;
                }
                return calledFromMain(method, methods, code, false) &&
                  workflowStepsAreUnconditional(method, [
                    encrypted.flowStart,
                    wrap.start,
                    upload.start,
                    properties.start,
                    unwrap.start,
                    download.start,
                  ]);
              }
            }
          }
        }
      }
    }
  }
  return false;
}

function lambdaScope(code, call) {
  const match = /^\s*(?:\(\s*)?([A-Za-z_$][\w$]*)\s*(?:\)\s*)?->/.exec(
    call.argsText,
  );
  if (!match) return null;
  const arrow = call.argsStart + match.index + match[0].lastIndexOf("->");
  let start = arrow + 2;
  while (/\s/.test(code[start] ?? "")) start += 1;
  if (code[start] === "{") {
    const close = matchingBrace(code, start);
    if (close < 0) return null;
    return { parameter: match[1], start: start + 1, end: close };
  }
  return { parameter: match[1], start, end: call.close };
}

function continuationAfter(method, from, names = ["flatMap"]) {
  const allowed = new Set(names);
  for (const call of callsNamed(method.body, "flatMap").concat(
    ...names.filter((name) => name !== "flatMap").map((name) =>
      callsNamed(method.body, name)),
  ).sort((left, right) => left.start - right.start)) {
    if (call.start <= from) continue;
    if (method.body.slice(from, call.start).includes(";")) return null;
    if (!allowed.has(method.body.slice(call.start, call.open).trim())) continue;
    const scope = lambdaScope(method.body, call);
    if (scope) return { ...scope, call };
  }
  return null;
}

function scopeReturnsExactParameter(scope, method, methods, code) {
  const origin = {
    expression: scope.parameter,
    identityName: scope.parameter,
    start: scope.start,
  };
  const body = method.body.slice(scope.start, scope.end).trim();
  const values = body.startsWith("{")
    ? Array.from(body.matchAll(/\breturn\s+([\s\S]*?);/g), (match) => match[1])
    : [body];
  return values.length > 0 && values.every((value) =>
    exactValueFromOrigin(value, origin, method, methods, code, scope.start));
}

function scopeReturnsExactReactiveParameter(scope, method, methods, code) {
  const origin = {
    expression: scope.parameter,
    identityName: scope.parameter,
    start: scope.start,
  };
  const body = method.body.slice(scope.start, scope.end).trim();
  const values = body.startsWith("{")
    ? Array.from(body.matchAll(/\breturn\s+([\s\S]*?);/g), (match) => match[1])
    : [body];
  return values.length > 0 && values.every((value) => {
    const call = exactMethodCall(value, "just");
    return Boolean(
      call &&
      compactCode(call.receiver) === "Mono" &&
      call.args.length === 1 &&
      exactValueFromOrigin(
        call.args[0],
        origin,
        method,
        methods,
        code,
        scope.start,
      ),
    );
  });
}

function reactiveResultPreservesDecryption(
  method,
  downloadScope,
  methods,
  code,
) {
  const operators = [
    "concatMap",
    "flatMap",
    "handle",
    "map",
    "switchIfEmpty",
    "then",
    "thenReturn",
    "transform",
    "zipWith",
  ];
  for (const name of operators) {
    for (const call of callsNamed(method.body, name)) {
      if (call.start <= downloadScope.call.end) continue;
      const scope = lambdaScope(method.body, call);
      if (
        name === "map" &&
        scope &&
        scopeReturnsExactParameter(scope, method, methods, code)
      ) {
        continue;
      }
      if (
        name === "flatMap" &&
        scope &&
        scopeReturnsExactReactiveParameter(scope, method, methods, code)
      ) {
        continue;
      }
      return false;
    }
  }
  return true;
}

function ownerClass(code, method) {
  return classBodies(code).find(({ start, end }) =>
    start <= method.start && method.end <= end,
  )?.name;
}

function callInvocation(caller, methodName, position) {
  const end = caller.body.indexOf(";", position) + 1 || caller.body.length;
  return {
    main: caller,
    position,
    statement: caller.body.slice(position, end),
    call: callsNamed(caller.body, methodName).find((candidate) =>
      position <= candidate.start && candidate.end <= end),
  };
}

function callPositionsFor(method, callers, code) {
  const owner = ownerClass(code, method);
  if (!owner) return [];
  const positions = [];
  for (const caller of callers) {
    const structuralBody = maskStringContents(caller.body);
    const direct = new RegExp(
      `\\bnew\\s+${escapeRegExp(owner)}\\s*\\([^;]{0,1000}?\\)\\s*\\.\\s*${escapeRegExp(method.name)}\\s*\\(`,
      "g",
    );
    positions.push(...Array.from(
      structuralBody.matchAll(direct),
      (match) => callInvocation(caller, method.name, match.index),
    ));

    const localConstruction = new RegExp(
      `\\b(?:${escapeRegExp(owner)}|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${escapeRegExp(owner)}\\s*\\(`,
      "g",
    );
    for (const construction of structuralBody.matchAll(localConstruction)) {
      const call = new RegExp(
        `\\b${escapeRegExp(construction[1])}\\s*\\.\\s*${escapeRegExp(method.name)}\\s*\\(`,
        "g",
      ).exec(structuralBody.slice(construction.index + construction[0].length));
      if (!call) continue;
      const position = construction.index + construction[0].length + call.index;
      positions.push(callInvocation(caller, method.name, position));
    }
  }
  return positions;
}

function mainCallPositions(method, methods, code) {
  return callPositionsFor(
    method,
    methods.filter(({ name }) => name === "main"),
    code,
  );
}

function helperReturnsWorkflowInvocation(helper, invocation, code) {
  if (!invocation.call) return false;
  return Array.from(helper.body.matchAll(/\breturn\s+([\s\S]*?);/g))
    .some((match) => {
      const expressionStart = match.index + match[0].indexOf(match[1]);
      const expressionEnd = expressionStart + match[1].length;
      if (
        expressionStart <= invocation.call.start &&
        invocation.call.end <= expressionEnd
      ) {
        return true;
      }
      const result = callResultVariable(helper, invocation.call);
      return result &&
        expressionDependsOn(match[1], result, helper, code);
    });
}

function workflowInvocationsFromMain(method, methods, code) {
  const mains = methods.filter((candidate) =>
    candidate.name === "main" && ownerClass(code, candidate) === "Main");
  const direct = callPositionsFor(method, mains, code);
  const indirect = [];
  for (const helper of methods) {
    if (helper.name === "main") continue;
    const workflowCalls = callPositionsFor(method, [helper], code)
      .filter((invocation) =>
        helperReturnsWorkflowInvocation(helper, invocation, code));
    if (workflowCalls.length === 0) continue;
    for (const main of mains) {
      for (const helperCall of callsNamed(main.body, helper.name)) {
        const invocation = callInvocation(main, helper.name, helperCall.start);
        for (const workflowCall of workflowCalls) {
          const keyIdParameter = parameterNames(method.parameters)
            .findIndex((name) => /(?:vault)?key(?:id|identifier)/i.test(name));
          indirect.push({
            ...invocation,
            keyIdActual: keyIdParameter < 0 ||
              Boolean(
                workflowCall.call?.args[keyIdParameter] &&
                isActualVaultKeyId(
                  workflowCall.call.args[keyIdParameter],
                  helper,
                  methods,
                  code,
                ),
              ),
            workflowCall,
          });
        }
      }
    }
  }
  return [...direct, ...indirect];
}

function calledFromMain(method, methods, code, requiresBlock) {
  return workflowInvocationsFromMain(method, methods, code).some(({ statement }) =>
    !requiresBlock || /\.block\s*\(\s*\)/.test(statement));
}

function asyncWorkflow(method, methods, code) {
  if (
    !/\bwrapKey\s*\(/.test(method.body) ||
    !/\bunwrapKey\s*\(/.test(method.body) ||
    !/\b(?:uploadWithResponse|upload)\s*\(/.test(method.body) ||
    !/\bdownloadContent\s*\(/.test(method.body) ||
    !calledFromMain(method, methods, code, true) ||
    hasConstantReactiveResult(method)
  ) {
    return false;
  }

  for (const plaintext of parameterNames(method.parameters)) {
    for (const dek of dataKeyVariables(method, methods, code)) {
      for (const iv of ivVariables(method, methods, code)) {
        const encrypted = encryptionOperation(
          method, methods, code, plaintext, dek, iv,
        );
        if (
          !encrypted ||
          hasBypassReturn(method, encrypted.flowStart, plaintext, code, true) ||
          returnMakesPositionUnreachable(method.body, encrypted.flowStart) ||
          persistsRawDek(method, dek, code)
        ) {
          continue;
        }

        for (const wrap of callsNamed(method.body, "wrapKey")) {
          if (
            wrap.start < encrypted.flowEnd ||
            !callUsesOfficialClient(
              method, wrap, "CryptographyAsyncClient", methods, code,
            ) ||
            !usesRsaOaep(wrap.args[0] ?? "", method, methods, code) ||
            !exactGeneratedValue(
              wrap.args[1] ?? "",
              dek,
              method,
              methods,
              code,
              wrap.start,
            )
          ) {
            continue;
          }
          const wrapScope = continuationAfter(method, wrap.end);
          if (!wrapScope) continue;
          const upload = callsNamed(method.body, "uploadWithResponse")
            .concat(callsNamed(method.body, "upload"))
            .find((call) =>
              wrapScope.start <= call.start && call.end <= wrapScope.end &&
              callUsesOfficialClient(
                method, call, "BlobAsyncClient", methods, code,
              ) &&
              uploadCarriesCiphertext(
                call, encrypted.output, method, code, encrypted.flowEnd,
              ),
            );
          if (
            !upload ||
            !metadataForUpload(
              method,
              methods,
              code,
              upload,
              wrapScope.parameter,
              dek,
              iv,
              wrap,
              "CryptographyAsyncClient",
            )
          ) {
            continue;
          }

          const uploadScope = continuationAfter(method, upload.end);
          if (!uploadScope) continue;
          const unwrap = callsNamed(method.body, "unwrapKey").find((call) =>
            uploadScope.start <= call.start && call.end <= uploadScope.end &&
            callUsesOfficialClient(
              method, call, "CryptographyAsyncClient", methods, code,
            ) &&
            usesRsaOaep(call.args[0] ?? "", method, methods, code) &&
            exactBase64MetadataValue(
              call.args[1] ?? "",
              "wrapped-dek",
              uploadScope.parameter,
              method,
              methods,
              code,
              call.start,
            ),
          );
          if (!unwrap) continue;

          const unwrapScope = continuationAfter(method, unwrap.end);
          if (!unwrapScope) continue;
          const download = callsNamed(method.body, "downloadContent").find((call) =>
            unwrapScope.start <= call.start &&
            call.end <= unwrapScope.end &&
            callUsesOfficialClient(
              method, call, "BlobAsyncClient", methods, code,
            ),
          );
          if (!download) continue;
          const downloadScope = continuationAfter(method, download.end, ["map", "flatMap"]);
          if (
            !downloadScope ||
            !reactiveResultPreservesDecryption(
              method,
              downloadScope,
              methods,
              code,
            ) ||
            !decryptsDownloadedValue(
              method,
              methods,
              code,
              downloadScope.start,
              downloadScope.end,
              downloadScope.parameter,
              unwrapScope.parameter,
              uploadScope.parameter,
              download.end,
              unwrap.end,
              download,
            )
          ) {
            continue;
          }
          return workflowStepsAreUnconditional(method, [
            encrypted.flowStart,
            wrap.start,
            upload.start,
            unwrap.start,
            download.start,
          ], false);
        }
      }
    }
  }
  return false;
}

function requiredAsync(source, code) {
  const methods = methodBodies(code);
  const structuralCode = maskStringContents(code);
  return hasImports(source, ["CryptographyAsyncClient", "BlobAsyncClient"]) &&
    hasRealCryptoTypes(code) &&
    allCipherTransformationsAreAesGcm(methods, code) &&
    (/\bimport\s+javax\.crypto\.Cipher\s*;/.test(structuralCode) ||
      /\bjavax\.crypto\.Cipher\b/.test(structuralCode)) &&
    (/\bimport\s+javax\.crypto\.spec\.GCMParameterSpec\s*;/.test(structuralCode) ||
      /\bjavax\.crypto\.spec\.GCMParameterSpec\b/.test(structuralCode)) &&
    (/\bimport\s+java\.security\.SecureRandom\s*;/.test(structuralCode) ||
      /\bjava\.security\.SecureRandom\b/.test(structuralCode)) &&
    /\bCryptographyClientBuilder\b[\s\S]{0,500}\.buildAsyncClient\s*\(/.test(structuralCode) &&
    /\bBlobServiceClientBuilder\b[\s\S]{0,500}\.buildAsyncClient\s*\(/.test(structuralCode) &&
    methods.some((method) => asyncWorkflow(method, methods, code));
}

function metadataRoundTrip(code) {
  const methods = methodBodies(code);
  return hasRealCryptoTypes(code) &&
    allCipherTransformationsAreAesGcm(methods, code) &&
    methods.some((method) => syncWorkflow(method, methods, code)) &&
    methods.some((method) => asyncWorkflow(method, methods, code));
}

function errorsAreHandled(code) {
  const catches = [...code.matchAll(/catch\s*\(\s*([^)]+)\s+(\w+)\s*\)\s*\{([\s\S]*?)\}/g)];
  const inspectsAndPreserves = (body, exception) =>
    (new RegExp(
      `\\b${exception}\\s*\\.\\s*get(?:StatusCode|ErrorCode|Message)\\s*\\(`,
    ).test(body) ||
      new RegExp(
        `\\b${exception}\\s*\\.\\s*getResponse\\s*\\(\\s*\\)\\s*\\.\\s*getStatusCode\\s*\\(`,
      ).test(body)) &&
    (new RegExp(`\\bthrow\\s+${exception}\\s*;`).test(body) ||
      new RegExp(`\\breturn\\s+${exception}\\s*;`).test(body) ||
      new RegExp(`\\b(?:throw|return)\\s+new\\s+\\w+[^;]*\\b${exception}\\b`).test(body));
  const catchesType = (type) => catches.some((match) =>
    match[1].includes(type) && inspectsAndPreserves(match[3], match[2]));
  const mapsType = (type) => callsNamed(code, "onErrorMap").some((call) => {
    if (!new RegExp(`\\b${type}\\s*\\.\\s*class`).test(call.args[0] ?? "")) {
      return false;
    }
    const exception = /\b([A-Za-z_$][\w$]*)\s*->/.exec(call.args[1] ?? "")?.[1];
    return exception && inspectsAndPreserves(call.args[1], exception);
  });
  const handlesKeyVault = (predicate) =>
    predicate("HttpResponseException") || predicate("KeyVaultErrorException");
  return catchesType("BlobStorageException") &&
    handlesKeyVault(catchesType) &&
    mapsType("BlobStorageException") &&
    handlesKeyVault(mapsType);
}

function skipWhitespace(code, start) {
  let index = start;
  while (/\s/.test(code[index] ?? "")) index += 1;
  return index;
}

function startsWithWord(code, index, word) {
  return code.slice(index, index + word.length) === word &&
    !/[\w$]/.test(code[index - 1] ?? "") &&
    !/[\w$]/.test(code[index + word.length] ?? "");
}

function javaStatementEnd(code, start) {
  const first = skipWhitespace(code, start);
  if (first >= code.length) return -1;
  if (code[first] === "{") {
    const close = matchingBrace(code, first);
    return close < 0 ? -1 : close + 1;
  }

  if (startsWithWord(code, first, "if")) {
    const open = code.indexOf("(", first + 2);
    const close = matchingParen(code, open);
    if (open < 0 || close < 0) return -1;
    const consequent = javaStatementEnd(code, close + 1);
    if (consequent < 0) return -1;
    const alternateStart = skipWhitespace(code, consequent);
    if (!startsWithWord(code, alternateStart, "else")) return consequent;
    return javaStatementEnd(code, alternateStart + 4);
  }

  if (
    startsWithWord(code, first, "while") ||
    startsWithWord(code, first, "for") ||
    startsWithWord(code, first, "synchronized")
  ) {
    const open = code.indexOf("(", first);
    const close = matchingParen(code, open);
    return open < 0 || close < 0 ? -1 : javaStatementEnd(code, close + 1);
  }

  if (startsWithWord(code, first, "try")) {
    let cursor = skipWhitespace(code, first + 3);
    if (code[cursor] === "(") {
      const resources = matchingParen(code, cursor);
      if (resources < 0) return -1;
      cursor = skipWhitespace(code, resources + 1);
    }
    if (code[cursor] !== "{") return -1;
    let end = matchingBrace(code, cursor);
    if (end < 0) return -1;
    end += 1;
    while (true) {
      cursor = skipWhitespace(code, end);
      if (startsWithWord(code, cursor, "catch")) {
        const open = code.indexOf("(", cursor + 5);
        const close = matchingParen(code, open);
        if (open < 0 || close < 0) return -1;
        end = javaStatementEnd(code, close + 1);
      } else if (startsWithWord(code, cursor, "finally")) {
        end = javaStatementEnd(code, cursor + 7);
      } else {
        return end;
      }
      if (end < 0) return -1;
    }
  }

  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = first; index < code.length; index += 1) {
    const character = code[index];
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
      return index + 1;
    }
  }
  return -1;
}

function unwrapParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith("(")) {
    const close = matchingParen(value, 0);
    if (close !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function splitTopLevelOperator(expression, operator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (
      depth === 0 &&
      expression.slice(index, index + operator.length) === operator
    ) {
      parts.push(expression.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (parts.length === 0) return [];
  parts.push(expression.slice(start).trim());
  return parts;
}

function staticJavaValue(expression, bindings, seen = new Set()) {
  const value = unwrapParentheses(expression);
  if (/^(?:true|Boolean\.TRUE)$/i.test(value)) return true;
  if (/^(?:false|Boolean\.FALSE)$/i.test(value)) return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^"(?:\\.|[^"\\])*"$/.test(value)) return value;
  if (/^[A-Za-z_$][\w$]*$/.test(value) && !seen.has(value)) {
    const bound = bindings.get(value);
    if (bound !== undefined) {
      seen.add(value);
      return staticJavaValue(bound, bindings, seen);
    }
  }
  return null;
}

function staticJavaBoolean(expression, bindings, seen = new Set()) {
  const value = unwrapParentheses(expression);
  if (value.startsWith("!")) {
    const result = staticJavaBoolean(value.slice(1), bindings, seen);
    return result === null ? null : !result;
  }

  for (const operator of ["||", "&&"]) {
    const values = splitTopLevelOperator(value, operator);
    if (values.length === 0) continue;
    const results = values.map((part) => staticJavaBoolean(part, bindings, seen));
    if (operator === "||") {
      if (results.includes(true)) return true;
      if (results.every((result) => result === false)) return false;
    } else {
      if (results.includes(false)) return false;
      if (results.every((result) => result === true)) return true;
    }
    return null;
  }

  for (const operator of ["==", "!="]) {
    const values = splitTopLevelOperator(value, operator);
    if (values.length !== 2) continue;
    const left = staticJavaValue(values[0], bindings, seen);
    const right = staticJavaValue(values[1], bindings, seen);
    if (left === null || right === null) return null;
    return operator === "==" ? left === right : left !== right;
  }

  const constant = staticJavaValue(value, bindings, seen);
  return typeof constant === "boolean" ? constant : null;
}

function booleanBindingsBefore(body, before) {
  const bindings = new Map();
  const declarations = /\b(?:final\s+)?(?:boolean|Boolean|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
  for (const match of body.slice(0, before).matchAll(declarations)) {
    bindings.set(match[1], match[2].trim());
  }
  return bindings;
}

function loopCondition(header) {
  const separators = splitTopLevelOperator(header, ";");
  return separators.length >= 3 ? separators[1] : "";
}

function mainControlRegions(body) {
  const structural = maskStringContents(body);
  const regions = [];
  const controls = /\b(if|while|for)\s*\(/g;
  let sequence = 0;
  for (const match of structural.matchAll(controls)) {
    const kind = match[1];
    const open = structural.indexOf("(", match.index);
    const close = matchingParen(structural, open);
    if (open < 0 || close < 0) continue;
    const consequentStart = skipWhitespace(structural, close + 1);
    const consequentEnd = javaStatementEnd(structural, consequentStart);
    if (consequentEnd < 0) continue;
    const alternateWord = skipWhitespace(structural, consequentEnd);
    const alternateStart = startsWithWord(structural, alternateWord, "else")
      ? skipWhitespace(structural, alternateWord + 4)
      : -1;
    const alternateEnd = alternateStart < 0
      ? -1
      : javaStatementEnd(structural, alternateStart);
    const rawCondition = body.slice(open + 1, close);
    const condition = kind === "for" ? loopCondition(rawCondition) : rawCondition;
    regions.push({
      alternateEnd,
      alternateStart,
      consequentEnd,
      consequentStart,
      id: `branch-${sequence += 1}`,
      kind,
      value: condition
        ? staticJavaBoolean(condition, booleanBindingsBefore(body, match.index))
        : null,
    });
  }
  return regions;
}

function pathForMainPosition(position, regions) {
  const path = new Map();
  for (const region of regions) {
    let choice = null;
    if (region.consequentStart <= position && position < region.consequentEnd) {
      choice = true;
    } else if (
      region.alternateStart >= 0 &&
      region.alternateStart <= position &&
      position < region.alternateEnd
    ) {
      choice = false;
    }
    if (choice === null) continue;
    if (region.value !== null && region.value !== choice) return null;
    if (region.value === null) path.set(region.id, choice);
  }
  return path;
}

function workflowStepsAreUnconditional(
  method, positions, rejectPrematureReturns = true,
) {
  const regions = mainControlRegions(method.body);
  if (positions.some((position) => {
    const path = pathForMainPosition(position, regions);
    return path === null || path.size > 0;
  })) {
    return false;
  }
  if (!rejectPrematureReturns) return true;

  const finalStep = Math.max(...positions);
  return !Array.from(
    maskStringContents(method.body).matchAll(
      /\b(?:return|throw)\b|\bSystem\s*\.\s*exit\s*\(|\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exit\s*\(/g,
    ),
  ).some((match) => {
    const end = method.body.indexOf(";", match.index);
    return (
      match.index < finalStep &&
      (end < 0 || end < finalStep) &&
      pathForMainPosition(match.index, regions) !== null
    );
  });
}

function pathMatchesAssignment(path, assignment) {
  return path !== null &&
    [...path].every(([id, choice]) => assignment.get(id) === choice);
}

function callsNamedAny(method, names) {
  return names.flatMap((name) => callsNamed(method.body, name));
}

function printCalls(method) {
  return callsNamedAny(method, ["print", "printf", "println"]);
}

function expressionContainsActualVaultKeyId(expression, method, methods, code) {
  if (isActualVaultKeyId(expression, method, methods, code)) return true;
  return Array.from(expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g))
    .some((match) =>
      isActualVaultKeyId(match[1], method, methods, code) &&
      expressionDependsOn(expression, match[1], method, code));
}

function topLevelConcatenationParts(expression) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = "";
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (character === "+" && depth === 0) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (parts.length === 0) return [];
  parts.push(expression.slice(start).trim());
  return parts;
}

function isDisplayLabel(expression, method, methods, code) {
  return resolvesExpression(
    expression,
    method,
    methods,
    code,
    (value) => /^"(?:\\.|[^"\\])*"$/.test(value.trim()),
  );
}

function printsExactValue(
  expression,
  origin,
  method,
  methods,
  code,
  position,
  sourceMatches = (value, useAt) =>
    exactValueFromOrigin(value, origin, method, methods, code, useAt),
) {
  if (sourceMatches(expression, position)) return true;
  const parts = topLevelConcatenationParts(expression);
  return parts.length >= 2 &&
    sourceMatches(parts.at(-1), position) &&
    parts.slice(0, -1).every((part) => isDisplayLabel(part, method, methods, code));
}

function printsResultFromMain(main, invocation, label, regions, methods, code) {
  const result = invocation.call && callResultVariable(main, invocation.call);
  if (!result) return false;
  const origin = valueOrigin(main, result, invocation.call.end);
  return printCalls(main).some((print) =>
    print.start > invocation.call.end &&
    pathForMainPosition(print.start, regions) !== null &&
    hasStringLabel(print.args.join(", "), label) &&
    print.args.some((argument) =>
      printsExactValue(
        argument,
        origin,
        main,
        methods,
        code,
        print.start,
      )));
}

function printsActualKeyIdFromMain(main, methods, code, regions) {
  return printCalls(main).some((print) =>
    pathForMainPosition(print.start, regions) !== null &&
    hasStringLabel(print.args.join(", "), "key") &&
    expressionContainsActualVaultKeyId(print.args.join(", "), main, methods, code));
}

function invocationUsesActualVaultKeyId(invocation, method, methods, code) {
  if (Object.hasOwn(invocation, "keyIdActual")) {
    return invocation.keyIdActual;
  }
  const keyIdParameter = parameterNames(method.parameters)
    .findIndex((name) => /(?:vault)?key(?:id|identifier)/i.test(name));
  return keyIdParameter >= 0 &&
    invocation.call?.args[keyIdParameter] &&
    isActualVaultKeyId(
      invocation.call.args[keyIdParameter],
      invocation.main,
      methods,
      code,
    );
}

function printsWrappedResult(method, methods, code) {
  const regions = mainControlRegions(method.body);
  return callsNamed(method.body, "wrapKey").some((wrap) => {
    const wrapped = callResultVariable(method, wrap);
    const origin = wrapped && valueOrigin(method, wrapped, wrap.end);
    return wrapped && printCalls(method).some((print) =>
      print.start > wrap.end &&
      pathForMainPosition(print.start, regions)?.size === 0 &&
      hasStringLabel(print.args.join(", "), "wrapped") &&
      print.args.some((argument) =>
        printsExactValue(
          argument,
          origin,
          method,
          methods,
          code,
          print.start,
          (value, useAt) =>
            exactBase64EncodingFrom(
              value,
              (encoded, encodedAt) =>
                exactWrappedDek(
                  encoded,
                  wrapped,
                  method,
                  methods,
                  code,
                  wrap.end,
                  encodedAt,
                ),
              method,
              methods,
              code,
              useAt,
            ),
        )));
  });
}

function mainCompletesBothWorkflows(main, syncCalls, asyncCalls) {
  const regions = mainControlRegions(main.body);
  const events = [
    ...syncCalls.map((call) => ({ kind: "sync", position: call.position })),
    ...asyncCalls.map((call) => ({ kind: "async", position: call.position })),
    ...Array.from(
      maskStringContents(main.body).matchAll(
        /\b(?:return|throw)\b|\bSystem\s*\.\s*exit\s*\(|\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exit\s*\(/g,
      ),
      (match) => ({ kind: "terminate", position: match.index }),
    ),
  ];
  const relevantRegions = regions.filter((region) =>
    events.some((event) =>
      region.consequentStart <= event.position &&
      event.position < region.consequentEnd ||
      region.alternateStart >= 0 &&
      region.alternateStart <= event.position &&
      event.position < region.alternateEnd));
  const dynamicBranches = relevantRegions
    .filter((region) => region.value === null)
    .map((region) => region.id);
  if (dynamicBranches.length > 10) return false;

  for (let mask = 0; mask < 2 ** dynamicBranches.length; mask += 1) {
    const assignment = new Map(
      dynamicBranches.map((id, index) => [id, Boolean(mask & (1 << index))]),
    );
    const active = events.filter((event) =>
      pathMatchesAssignment(
        pathForMainPosition(event.position, relevantRegions),
        assignment,
      ));
    const firstTermination = active
      .filter(({ kind }) => kind === "terminate")
      .reduce(
        (first, event) => Math.min(first, event.position),
        Number.POSITIVE_INFINITY,
      );
    const sync = active.filter((event) =>
      event.kind === "sync" && event.position < firstTermination);
    const asynchronous = active.filter((event) =>
      event.kind === "async" && event.position < firstTermination);
    if (!sync.some((left) =>
      asynchronous.some((right) => left.position < right.position))) {
      return false;
    }
  }
  return true;
}

function hasStringLabel(expression, label) {
  return Array.from(
    expression.matchAll(/"(?:\\.|[^"\\])*"/g),
    (match) => match[0],
  ).some((value) => new RegExp(label, "i").test(value));
}

function connectedDemo(code) {
  if (!/\bpublic\s+static\s+void\s+main\s*\(\s*String\s*\[\s*\]\s+\w+\s*\)/.test(code)) {
    return false;
  }
  const methods = methodBodies(code);
  const syncMethods = methods.filter((method) => syncWorkflow(method, methods, code));
  const asyncMethods = methods.filter((method) => asyncWorkflow(method, methods, code));
  return methods.filter((method) =>
    method.name === "main" && ownerClass(code, method) === "Main"
  ).some((main) => {
    const regions = mainControlRegions(main.body);
    for (const sync of syncMethods) {
      for (const async of asyncMethods) {
        const syncCalls = workflowInvocationsFromMain(sync, methods, code)
          .filter(({ main: candidate }) => candidate === main);
        const asyncCalls = workflowInvocationsFromMain(async, methods, code)
          .filter(({ main: candidate, statement }) =>
            candidate === main && /\.block\s*\(\s*\)/.test(statement))
          .filter((invocation) =>
            invocationUsesActualVaultKeyId(invocation, async, methods, code));
        if (
          syncCalls.length === 0 ||
          asyncCalls.length === 0 ||
          !mainCompletesBothWorkflows(main, syncCalls, asyncCalls) ||
          !printsActualKeyIdFromMain(main, methods, code, regions) ||
          !printsWrappedResult(sync, methods, code)
        ) {
          continue;
        }
        if (syncCalls.some((syncCall) =>
          asyncCalls.some((asyncCall) =>
            syncCall.position < asyncCall.position &&
            printsResultFromMain(
              main, syncCall, "decrypt|plain", regions, methods, code,
            ) &&
            printsResultFromMain(
              main, asyncCall, "decrypt|plain", regions, methods, code,
            )))) {
          return true;
        }
      }
    }
    return false;
  });
}

const rules = {
  "prompt/sdk-dependencies": ({ build, active }) =>
    hasPinnedDependencies(build) && connectedDemo(active),
  "prompt/client-configuration": ({ active, code }) =>
    hasImports(active, ["DefaultAzureCredentialBuilder", "BlobServiceClientBuilder", "KeyClientBuilder"]) &&
    /System\.getenv\s*\(\s*\w+\s*\)/.test(code) &&
    active.includes('"AZURE_STORAGE_ACCOUNT_URL"') &&
    active.includes('"AZURE_KEY_VAULT_URL"') &&
    (code.match(/\bnew\s+DefaultAzureCredentialBuilder\s*\(/g) ?? []).length === 1 &&
    /\bcredential\s*\(\s*\w+\s*\)/.test(code) &&
    !/\b(?:SecretClient|SecretClientBuilder|getSecret)\b/.test(code) &&
    connectedDemo(active),
  "prompt/sync-envelope-encryption": ({ active, code }) =>
    requiredSync(active, active) &&
    !securityViolations(active, code) &&
    connectedDemo(active),
  "prompt/async-envelope-encryption": ({ active, code }) =>
    requiredAsync(active, active) &&
    !securityViolations(active, code) &&
    connectedDemo(active),
  "prompt/encrypted-blob-metadata": ({ active, code }) =>
    metadataRoundTrip(active) &&
    !securityViolations(active, code) &&
    connectedDemo(active),
  "prompt/error-handling": ({ active, code }) =>
    errorsAreHandled(code) && connectedDemo(active),
  "prompt/connected-demo": ({ active }) => connectedDemo(active),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  if (!hasCompatibleSourceFiles(workspace.sourceFiles)) return false;
  const source = workspace.source ?? "";
  const code = codeOnly(source);
  const active = executableCode(source);
  return rule({ ...workspace, source, active, code });
}

export function ruleNames() {
  return Object.keys(rules);
}
