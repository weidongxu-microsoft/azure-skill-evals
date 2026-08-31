const SDK_TYPES = {
  credentialBuilder: {
    name: "DefaultAzureCredentialBuilder",
    packageName: "com.azure.identity",
  },
  blobServiceClient: {
    name: "BlobServiceClient",
    packageName: "com.azure.storage.blob",
  },
  blobServiceAsyncClient: {
    name: "BlobServiceAsyncClient",
    packageName: "com.azure.storage.blob",
  },
  blobServiceClientBuilder: {
    name: "BlobServiceClientBuilder",
    packageName: "com.azure.storage.blob",
  },
  blobContainerClient: {
    name: "BlobContainerClient",
    packageName: "com.azure.storage.blob",
  },
  blobContainerAsyncClient: {
    name: "BlobContainerAsyncClient",
    packageName: "com.azure.storage.blob",
  },
  blobClient: {
    name: "BlobClient",
    packageName: "com.azure.storage.blob",
  },
  blobAsyncClient: {
    name: "BlobAsyncClient",
    packageName: "com.azure.storage.blob",
  },
  blobItem: {
    name: "BlobItem",
    packageName: "com.azure.storage.blob.models",
  },
  blobStorageException: {
    name: "BlobStorageException",
    packageName: "com.azure.storage.blob.models",
  },
  requestRetryOptions: {
    name: "RequestRetryOptions",
    packageName: "com.azure.storage.common.policy",
  },
  retryPolicyType: {
    name: "RetryPolicyType",
    packageName: "com.azure.storage.common.policy",
  },
  httpLogOptions: {
    name: "HttpLogOptions",
    packageName: "com.azure.core.http.policy",
  },
  httpLogDetailLevel: {
    name: "HttpLogDetailLevel",
    packageName: "com.azure.core.http.policy",
  },
  timeoutPolicy: {
    name: "TimeoutPolicy",
    packageName: "com.azure.core.http.policy",
  },
  parallelTransferOptions: {
    name: "ParallelTransferOptions",
    packageName: "com.azure.storage.blob.models",
  },
  blobUploadFromFileOptions: {
    name: "BlobUploadFromFileOptions",
    packageName: "com.azure.storage.blob.options",
  },
  blobDownloadToFileOptions: {
    name: "BlobDownloadToFileOptions",
    packageName: "com.azure.storage.blob.options",
  },
  blobRequestConditions: {
    name: "BlobRequestConditions",
    packageName: "com.azure.storage.blob.models",
  },
  blobLeaseClientBuilder: {
    name: "BlobLeaseClientBuilder",
    packageName: "com.azure.storage.blob.specialized",
  },
  blobLeaseClient: {
    name: "BlobLeaseClient",
    packageName: "com.azure.storage.blob.specialized",
  },
  blobLeaseAsyncClient: {
    name: "BlobLeaseAsyncClient",
    packageName: "com.azure.storage.blob.specialized",
  },
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskJava(source, preserveStrings) {
  let result = "";
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        result += "\n";
        state = "code";
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "text-block") {
      if (source.startsWith('"""', index)) {
        result += preserveStrings ? '"""' : "   ";
        index += 2;
        state = "code";
      } else {
        result += preserveStrings
          ? character
          : character === "\n"
            ? "\n"
            : " ";
      }
      continue;
    }

    if (state === "string" || state === "character") {
      if (character === "\\") {
        result += preserveStrings
          ? `${character}${source[index + 1] ?? ""}`
          : "  ";
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        result += preserveStrings ? character : " ";
        state = "code";
      } else {
        result += preserveStrings
          ? character
          : character === "\n"
            ? "\n"
            : " ";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else if (source.startsWith('"""', index)) {
      result += preserveStrings ? '"""' : "   ";
      index += 2;
      state = "text-block";
    } else if (character === '"') {
      result += preserveStrings ? character : " ";
      state = "string";
    } else if (character === "'") {
      result += preserveStrings ? character : " ";
      state = "character";
    } else {
      result += character;
    }
  }

  return result;
}

function matchingIndex(text, start, opening = "(", closing = ")") {
  if (start < 0 || text[start] !== opening) {
    return -1;
  }
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === opening) {
      depth += 1;
    } else if (text[index] === closing) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitTopLevel(text) {
  const values = [];
  let start = 0;
  const depth = { "(": 0, "[": 0, "{": 0, "<": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  let state = "code";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state === "string" || state === "character") {
      if (character === "\\") {
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') {
      state = "string";
    } else if (character === "'") {
      state = "character";
    } else if (character in depth) {
      if (
        character !== "<" ||
        /[\w$?.\]]/.test(text[index - 1] ?? "") &&
          /[\w$?@]/.test(text[index + 1] ?? "")
      ) {
        depth[character] += 1;
      }
    } else if (character in closing) {
      depth[closing[character]] -= 1;
    } else if (character === ">" && depth["<"] > 0) {
      depth["<"] -= 1;
    } else if (
      character === "," &&
      Object.values(depth).every((value) => value === 0)
    ) {
      values.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  const last = text.slice(start).trim();
  if (last || values.length > 0) {
    values.push(last);
  }
  return values;
}

function unwrapParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith("(")) {
    const close = matchingIndex(value, 0);
    if (close !== value.length - 1) {
      break;
    }
    value = value.slice(1, -1).trim();
  }
  return value;
}

function xmlTree(xml) {
  const root = { name: "#document", children: [], text: "" };
  const stack = [root];
  const tags = /<\s*(\/?)\s*([A-Za-z_][\w:.-]*)\b[^>]*?(\/?)\s*>/g;
  let cursor = 0;
  let match;
  while ((match = tags.exec(xml)) !== null) {
    stack.at(-1).text += xml.slice(cursor, match.index);
    cursor = tags.lastIndex;
    const name = match[2].split(":").at(-1);
    if (match[1]) {
      if (stack.length > 1 && stack.at(-1).name === name) {
        stack.pop();
      }
    } else {
      const node = { name, children: [], text: "", parent: stack.at(-1) };
      stack.at(-1).children.push(node);
      if (!match[3]) {
        stack.push(node);
      }
    }
  }
  stack.at(-1).text += xml.slice(cursor);
  return root;
}

function child(node, name) {
  return node.children.find((candidate) => candidate.name === name);
}

function childText(node, name) {
  return child(node, name)?.text.trim() ?? "";
}

function compareJavaVersions(left, right) {
  const leftParts = left.split(/[._-]/).map((part) => Number(part) || 0);
  const rightParts = right.split(/[._-]/).map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function jdkActivationMatchesJava17(declaration) {
  const value = declaration.trim();
  const range = /^([\[(])\s*([^,]*)\s*,\s*([^)\]]*)\s*([)\]])$/.exec(
    value,
  );
  if (range) {
    const lowerMatches =
      !range[2] ||
      compareJavaVersions("17", range[2]) > 0 ||
      (range[1] === "[" && compareJavaVersions("17", range[2]) === 0);
    const upperMatches =
      !range[3] ||
      compareJavaVersions("17", range[3]) < 0 ||
      (range[4] === "]" && compareJavaVersions("17", range[3]) === 0);
    return lowerMatches && upperMatches;
  }
  if (value.startsWith("!")) {
    return !"17".startsWith(value.slice(1).trim());
  }
  return "17".startsWith(value);
}

function mavenProfileIsActive(profile) {
  const activation = child(profile, "activation");
  if (!activation) return false;
  const predicates = [];
  const activeByDefault = childText(activation, "activeByDefault");
  if (activeByDefault) {
    predicates.push(activeByDefault.toLowerCase() === "true");
  }
  const jdk = childText(activation, "jdk");
  if (jdk) predicates.push(jdkActivationMatchesJava17(jdk));
  if (["property", "os", "file"].some((name) => child(activation, name))) {
    predicates.push(false);
  }
  return predicates.length > 0 && predicates.every(Boolean);
}

function dependencyNodes(container) {
  return (child(container, "dependencies")?.children ?? []).filter(
    (candidate) => candidate.name === "dependency",
  );
}

function activeMavenDependencies(project) {
  const packaging = childText(project, "packaging") || "jar";
  if (!["jar", "war", "ear"].includes(packaging)) {
    return [];
  }
  const activeProfiles = (
    child(project, "profiles")?.children.filter(
      (candidate) =>
        candidate.name === "profile" && mavenProfileIsActive(candidate),
    ) ?? []
  );
  const properties = new Map();
  for (const owner of [project, ...activeProfiles]) {
    for (const property of child(owner, "properties")?.children ?? []) {
      properties.set(property.name, property.text.trim());
    }
  }
  const resolve = (value) => {
    const property = /^\$\{([^}]+)\}$/.exec(value)?.[1];
    return property ? properties.get(property) ?? "" : value;
  };
  return [project, ...activeProfiles]
    .flatMap(dependencyNodes)
    .map((dependency) => ({
      group: childText(dependency, "groupId"),
      artifact: childText(dependency, "artifactId"),
      version: resolve(childText(dependency, "version")),
      scope: childText(dependency, "scope") || "compile",
    }))
    .filter((dependency) =>
      ["compile", "runtime"].includes(dependency.scope)
    );
}

function tokenizeGradle(build) {
  const tokens = [];
  for (let index = 0; index < build.length; ) {
    if (build.startsWith("//", index)) {
      index = build.indexOf("\n", index + 2);
      if (index === -1) break;
    } else if (build.startsWith("/*", index)) {
      const close = build.indexOf("*/", index + 2);
      index = close === -1 ? build.length : close + 2;
    } else if (build[index] === "\n" || build[index] === "\r") {
      if (tokens.at(-1)?.value !== ";") {
        tokens.push({ kind: "punctuation", value: ";" });
      }
      if (build[index] === "\r" && build[index + 1] === "\n") index += 1;
      index += 1;
    } else if (/\s/.test(build[index])) {
      index += 1;
    } else if (
      ["&&", "||", "==", "!="].includes(build.slice(index, index + 2))
    ) {
      tokens.push({
        kind: "punctuation",
        value: build.slice(index, index + 2),
      });
      index += 2;
    } else if (/[$A-Za-z_]/.test(build[index])) {
      const value = /^[$A-Za-z_][\w$]*/.exec(build.slice(index))[0];
      tokens.push({ kind: "identifier", value });
      index += value.length;
    } else if (/\d/.test(build[index])) {
      const value = /^\d+(?:\.\d+)?/.exec(build.slice(index))[0];
      tokens.push({ kind: "number", value });
      index += value.length;
    } else if (build[index] === '"' || build[index] === "'") {
      const quote = build[index];
      let value = "";
      index += 1;
      while (index < build.length && build[index] !== quote) {
        if (build[index] === "\\" && index + 1 < build.length) {
          value += build[index + 1];
          index += 2;
        } else {
          value += build[index];
          index += 1;
        }
      }
      tokens.push({ kind: "string", value });
      index += index < build.length ? 1 : 0;
    } else {
      tokens.push({ kind: "punctuation", value: build[index] });
      index += 1;
    }
  }
  return tokens;
}

function matchingToken(tokens, start, open = "(", close = ")") {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === open) depth += 1;
    if (tokens[index].value === close && --depth === 0) return index;
  }
  return -1;
}

function staticGradleBoolean(tokens, start, end, bindings = new Map()) {
  let index = start;
  const combine = (left, right, operator) => {
    if (operator === "&&") {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : null;
    }
    if (left === true || right === true) return true;
    return left === false && right === false ? false : null;
  };
  const primary = () => {
    if (tokens[index]?.value === "(") {
      index += 1;
      const value = disjunction();
      if (tokens[index]?.value !== ")") return null;
      index += 1;
      return value;
    }
    const token = tokens[index++];
    if (!token) return null;
    if (token.value === "Boolean" && tokens[index]?.value === ".") {
      const member = tokens[index + 1]?.value;
      index += 2;
      if (member === "TRUE") return true;
      if (member === "FALSE") return false;
      return null;
    }
    if (token.value === "true" || token.value === "1") return true;
    if (token.value === "false" || token.value === "0") return false;
    return token.kind === "identifier"
      ? bindings.get(token.value) ?? null
      : null;
  };
  const unary = () => {
    if (tokens[index]?.value === "!") {
      index += 1;
      const value = unary();
      return value === null ? null : !value;
    }
    return primary();
  };
  const equality = () => {
    const left = unary();
    const operator = tokens[index]?.value;
    if (!["==", "!="].includes(operator)) return left;
    index += 1;
    const right = unary();
    if (left === null || right === null) return null;
    return operator === "==" ? left === right : left !== right;
  };
  const conjunction = () => {
    let value = equality();
    while (tokens[index]?.value === "&&") {
      index += 1;
      value = combine(value, equality(), "&&");
    }
    return value;
  };
  function disjunction() {
    let value = conjunction();
    while (tokens[index]?.value === "||") {
      index += 1;
      value = combine(value, conjunction(), "||");
    }
    return value;
  }
  const value = disjunction();
  return index === end ? value : null;
}

function inactiveGradleTokens(tokens) {
  const inactive = new Set();
  const bindings = new Map();
  const markStatement = (start) => {
    if (tokens[start]?.value === "{") {
      const close = matchingToken(tokens, start, "{", "}");
      for (let index = start; index <= close; index += 1) inactive.add(index);
      return close;
    }
    let end = start;
    while (end < tokens.length && tokens[end].value !== ";") end += 1;
    for (let index = start; index <= end; index += 1) inactive.add(index);
    return end;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const declaration = ["def", "boolean", "Boolean", "var", "val"].includes(
      tokens[index]?.value,
    );
    const nameIndex = declaration ? index + 1 : index;
    if (
      !inactive.has(index) &&
      tokens[nameIndex]?.kind === "identifier" &&
      tokens[nameIndex + 1]?.value === "="
    ) {
      let end = nameIndex + 2;
      while (
        end < tokens.length &&
        ![";", "{", "}"].includes(tokens[end].value)
      ) {
        end += 1;
      }
      bindings.set(
        tokens[nameIndex].value,
        staticGradleBoolean(tokens, nameIndex + 2, end, bindings),
      );
      index = Math.max(index, end - 1);
      continue;
    }
    if (tokens[index]?.value !== "if" || tokens[index + 1]?.value !== "(") {
      continue;
    }
    const conditionEnd = matchingToken(tokens, index + 1);
    if (conditionEnd === -1) continue;
    const condition = staticGradleBoolean(
      tokens,
      index + 2,
      conditionEnd,
      bindings,
    );
    const consequentStart = conditionEnd + 1;
    const consequentEnd =
      condition === false
        ? markStatement(consequentStart)
        : tokens[consequentStart]?.value === "{"
          ? matchingToken(tokens, consequentStart, "{", "}")
          : consequentStart;
    if (
      condition === true &&
      tokens[consequentEnd + 1]?.value === "else"
    ) {
      markStatement(consequentEnd + 2);
    }
  }
  return inactive;
}

function activeGradleDependencies(build) {
  const tokens = tokenizeGradle(build);
  const inactive = inactiveGradleTokens(tokens);
  const ancestors = [];
  const blocks = [];
  for (let index = 0; index < tokens.length; index += 1) {
    ancestors[index] = blocks.slice();
    if (tokens[index].value === "{") {
      let previous = index - 1;
      while (tokens[previous]?.value === ";") previous -= 1;
      blocks.push(tokens[previous]?.value ?? "");
    } else if (tokens[index].value === "}") {
      blocks.pop();
    }
  }
  const dependencies = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      inactive.has(index) ||
      tokens[index].kind !== "identifier" ||
      !["implementation", "api", "compile"].includes(tokens[index].value)
    ) {
      continue;
    }
    const parents = ancestors[index];
    if (
      !parents.includes("dependencies") ||
      parents.some((name) =>
        ["buildscript", "pluginManagement", "plugins"].includes(name),
      )
    ) {
      continue;
    }
    let coordinate = tokens[index + 1];
    if (coordinate?.value === "(") coordinate = tokens[index + 2];
    if (coordinate?.kind === "string") dependencies.push(coordinate.value);
  }
  return dependencies;
}

function compatibleAzureVersion(artifact, version) {
  if (
    !/^\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z]+)*$/.test(version) ||
    /(?:snapshot|latest|dev|\+)$/i.test(version)
  ) {
    return false;
  }
  const major = Number(version.split(".")[0]);
  return artifact === "azure-storage-blob" ? major >= 12 : major >= 1;
}

function hasCompatibleDependencies(build) {
  const expected = [
    "azure-identity",
    "azure-storage-blob",
  ];
  const document = xmlTree(build.replace(/<!--[\s\S]*?-->/g, " "));
  const mavenProjects = document.children.filter(
    (candidate) => candidate.name === "project",
  );
  const maven = mavenProjects.some((project) => {
    const dependencies = activeMavenDependencies(project);
    return expected.every((artifact) => {
      return dependencies.some(
        (dependency) =>
          dependency.group === "com.azure" &&
          dependency.artifact === artifact &&
          compatibleAzureVersion(artifact, dependency.version),
      );
    });
  });
  const gradle = activeGradleDependencies(build);
  return maven || expected.every((artifact) =>
    gradle.some((coordinate) => {
      const [group, candidate, version] = coordinate.split(":");
      return (
        group === "com.azure" &&
        candidate === artifact &&
        compatibleAzureVersion(artifact, version ?? "")
      );
    })
  );
}

function sdkContext(code) {
  const imports = Array.from(
    code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$*][\w$*]*)*)\s*;/g),
    (match) => match[1].replace(/\s+/g, ""),
  );
  const localTypes = new Set(
    Array.from(
      code.matchAll(/\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g),
      (match) => match[1],
    ),
  );

  const types = {};
  for (const [key, type] of Object.entries(SDK_TYPES)) {
    const qualifiedName = `${type.packageName}.${type.name}`;
    const conflictingImport = imports.some(
      (value) => value.endsWith(`.${type.name}`) && value !== qualifiedName,
    );
    const simpleAllowed =
      !localTypes.has(type.name) &&
      !conflictingImport &&
      (imports.includes(qualifiedName) ||
        imports.includes(`${type.packageName}.*`));
    const qualifiedPattern = qualifiedName
      .split(".")
      .map(escapeRegExp)
      .join("\\s*\\.\\s*");
    types[key] = {
      ...type,
      simpleAllowed,
      pattern: simpleAllowed
        ? `(?:${qualifiedPattern}|${escapeRegExp(type.name)})`
        : qualifiedPattern,
    };
  }
  return types;
}

function parameterNames(parameters) {
  if (!parameters.trim()) {
    return [];
  }
  return splitTopLevel(parameters).map((parameter) => {
    const withoutAnnotations = parameter
      .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, "")
      .replace(/\bfinal\b/g, "");
    return /([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?\s*$/.exec(
      withoutAnnotations,
    )?.[1];
  });
}

function parseMethods(code, sourceWithStrings) {
  const methods = [];
  const classNames = Array.from(
    code.matchAll(/\b(?:class|record|enum)\s+([A-Za-z_$][\w$]*)/g),
    (match) => match[1],
  );
  const pattern =
    /(?:^|[;{}])\s*(?:(?:public|protected|private|static|final|synchronized|native|abstract|strictfp)\s+)*(?:<[^;{}()]+>\s*)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*(?:\s*<[^;{}()]+>)?(?:\s*\[\s*\])?\s+([A-Za-z_$][\w$]*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^{}]+)?\{/gm;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    if (
      ["if", "for", "while", "switch", "catch", "try", "new"].includes(
        match[1],
      )
    ) {
      continue;
    }
    const open = code.indexOf("{", match.index + match[0].lastIndexOf("{"));
    const close = matchingIndex(code, open, "{", "}");
    if (close === -1) {
      continue;
    }
    methods.push({
      id: methods.length,
      name: match[1],
      parameters: parameterNames(match[2]).filter(Boolean),
      start: match.index,
      bodyStart: open + 1,
      bodyEnd: close,
      code: code.slice(open + 1, close),
      source: sourceWithStrings.slice(open + 1, close),
    });
    pattern.lastIndex = close + 1;
  }
  for (const className of classNames) {
    const constructorPattern = new RegExp(
      `\\b(?:(?:public|protected|private)\\s+)?${escapeRegExp(className)}\\s*\\(([^;{}]*)\\)\\s*(?:throws\\s+[^{}]+)?\\{`,
      "g",
    );
    let constructorMatch;
    while ((constructorMatch = constructorPattern.exec(code)) !== null) {
      const open = code.indexOf(
        "{",
        constructorMatch.index + constructorMatch[0].lastIndexOf("{"),
      );
      const close = matchingIndex(code, open, "{", "}");
      if (
        close === -1 ||
        methods.some((method) => method.bodyStart === open + 1)
      ) {
        continue;
      }
      methods.push({
        id: methods.length,
        name: className,
        parameters: parameterNames(constructorMatch[1]).filter(Boolean),
        start: constructorMatch.index,
        bodyStart: open + 1,
        bodyEnd: close,
        code: code.slice(open + 1, close),
        source: sourceWithStrings.slice(open + 1, close),
      });
      constructorPattern.lastIndex = close + 1;
    }
  }
  methods.sort((left, right) => left.start - right.start);
  methods.forEach((method, index) => {
    method.id = index;
  });
  return methods;
}

function triStateJavaBoolean(expression, values) {
  const tokens =
    expression.match(
      /&&|\|\||==|!=|[()!]|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g,
    ) ?? [];
  let index = 0;
  const combine = (left, right, operator) => {
    if (operator === "&&") {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : null;
    }
    if (left === true || right === true) return true;
    return left === false && right === false ? false : null;
  };
  const primary = () => {
    if (tokens[index] === "(") {
      index += 1;
      const value = disjunction();
      if (tokens[index] !== ")") return null;
      index += 1;
      return value;
    }
    const token = (tokens[index++] ?? "").replace(/\s+/g, "");
    if (["true", "Boolean.TRUE"].includes(token)) return true;
    if (["false", "Boolean.FALSE"].includes(token)) return false;
    return values.get(token) ?? null;
  };
  const unary = () => {
    if (tokens[index] === "!") {
      index += 1;
      const value = unary();
      return value === null ? null : !value;
    }
    return primary();
  };
  const equality = () => {
    const left = unary();
    const operator = tokens[index];
    if (!["==", "!="].includes(operator)) return left;
    index += 1;
    const right = unary();
    if (left === null || right === null) return null;
    return operator === "==" ? left === right : left !== right;
  };
  const conjunction = () => {
    let value = equality();
    while (tokens[index] === "&&") {
      index += 1;
      value = combine(value, equality(), "&&");
    }
    return value;
  };
  function disjunction() {
    let value = conjunction();
    while (tokens[index] === "||") {
      index += 1;
      value = combine(value, conjunction(), "||");
    }
    return value;
  }
  const value = disjunction();
  return index === tokens.length ? value : null;
}

function javaBooleanAssignment(statement, values) {
  const match =
    /^(?:(?:final\s+)?(?:boolean|Boolean|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/.exec(
      statement.trim(),
    );
  if (!match) return;
  values.set(match[1], triStateJavaBoolean(match[2], values));
}

function mergeJavaBooleans(base, branches) {
  const merged = new Map(base);
  for (const name of base.keys()) {
    const values = branches.map((branch) => branch.booleans.get(name) ?? null);
    merged.set(
      name,
      values.every((value) => value === values[0]) ? values[0] : null,
    );
  }
  return merged;
}

function commonJavaPath(paths) {
  if (paths.length === 0) return new Map();
  const result = new Map(paths[0]);
  for (const path of paths.slice(1)) {
    for (const [id, choice] of result) {
      if (path.get(id) !== choice) result.delete(id);
    }
  }
  return result;
}

function javaLoopCondition(header, values, abstracts = new Map()) {
  const open = header.indexOf("(");
  const close = matchingIndex(header, open);
  if (open === -1 || close === -1) return null;
  const body = header.slice(open + 1, close).trim();
  let depth = 0;
  let separator = -1;
  for (let index = 0; index < body.length; index += 1) {
    if ("([{<".includes(body[index])) depth += 1;
    else if (")]}".includes(body[index]) || body[index] === ">") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && body[index] === ":") {
      const iterable = javaIterableValue(body.slice(index + 1), abstracts);
      return iterable?.value === "empty" ? false : null;
    } else if (depth === 0 && body[index] === ";") {
      if (separator === -1) separator = index;
      else {
        const condition = body.slice(separator + 1, index).trim();
        return condition === ""
          ? true
          : triStateJavaBoolean(condition, values);
      }
    }
  }
  return null;
}

function orderedStatements(method) {
  const events = [];
  const branchConditions = new Map();
  let start = 0;
  let parentheses = 0;
  let scope = 0;
  const frames = [{
    active: true,
    abstracts: new Map(),
    booleans: new Map(),
    normal: true,
    path: new Map(),
  }];
  const pendingIf = new Map();

  const conditionValue = (header, values) => {
    const open = header.indexOf("(");
    const close = matchingIndex(header, open);
    if (open === -1 || close === -1) return null;
    return triStateJavaBoolean(header.slice(open + 1, close), values);
  };
  const finishPending = (level, alternate = null) => {
    const pending = pendingIf.get(level);
    if (!pending) return;
    const branches = [];
    if (pending.condition !== false && pending.consequent.normal) {
      branches.push(pending.consequent);
    }
    if (alternate) {
      if (pending.condition !== true && alternate.normal) {
        branches.push(alternate);
      }
    } else if (pending.condition !== true) {
      const path = new Map(pending.path);
      if (pending.condition === null) path.set(pending.id, false);
      branches.push({
        abstracts: new Map(pending.abstractBase),
        booleans: new Map(pending.base),
        normal: true,
        path,
      });
    }
    const parent = frames.at(-1);
    if (branches.length === 0) {
      parent.normal = false;
    } else {
      parent.abstracts = mergeJavaAbstracts(
        pending.abstractBase,
        branches,
      );
      parent.booleans = mergeJavaBooleans(pending.base, branches);
      parent.path = commonJavaPath(branches.map((branch) => branch.path));
    }
    pendingIf.delete(level);
  };

  for (let index = 0; index < method.code.length; index += 1) {
    const character = method.code[index];
    if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      parentheses -= 1;
    } else if (character === "{" && parentheses === 0) {
      const header = method.code.slice(start, index).trim();
      const isElse = /^else\b/.test(header);
      const isIf = /^(?:else\s+)?if\s*\(/.test(header);
      const isLoop = /^(?:while|for)\s*\(/.test(header);
      const previous = isElse ? pendingIf.get(scope) : null;
      if (!isElse) finishPending(scope);
      const parent = frames.at(-1);
      const path = new Map(parent.path);
      if (previous && previous.condition === null) {
        path.set(previous.id, false);
      }
      const condition = isLoop
        ? javaLoopCondition(
            header,
            previous?.base ?? parent.booleans,
            previous?.abstractBase ?? parent.abstracts,
          )
        : isIf
          ? conditionValue(header, previous?.base ?? parent.booleans)
          : null;
      const branchId = isIf || isLoop
        ? `${method.id}:${method.bodyStart + index}`
        : null;
      if (branchId) {
        const open = header.indexOf("(");
        const close = matchingIndex(header, open);
        branchConditions.set(branchId, header.slice(open + 1, close));
      }
      if (branchId && condition === null) {
        path.set(branchId, true);
      }
      const unreachable =
        (isIf || isLoop) && condition === false ||
        previous?.condition === true;
      scope += 1;
      frames.push({
        active: parent.active && parent.normal && !unreachable,
        abstracts: new Map(previous?.abstractBase ?? parent.abstracts),
        booleans: new Map(previous?.base ?? parent.booleans),
        normal: true,
        path,
        branchId,
        condition,
        branchKind: isIf ? "if" : isElse ? "else" : "",
        abstractBase: new Map(previous?.abstractBase ?? parent.abstracts),
        base: new Map(previous?.base ?? parent.booleans),
        previous,
      });
      events.push({
        type: "enter",
        scope,
        active: frames.at(-1).active,
        path: new Map(path),
        code: header,
        source: method.source.slice(start, index).trim(),
        position: method.bodyStart + start,
      });
      start = index + 1;
    } else if (character === "}" && parentheses === 0) {
      const frame = frames.at(-1);
      events.push({
        type: "exit",
        scope,
        active: frame.active,
        path: new Map(frame.path),
      });
      frames.pop();
      const parent = frames.at(-1);
      start = index + 1;
      scope -= 1;
      if (frame.branchKind === "if") {
        pendingIf.set(scope, {
          abstractBase: frame.abstractBase,
          base: frame.base,
          consequent: {
            abstracts: frame.abstracts,
            booleans: frame.booleans,
            normal: frame.normal,
            path: frame.path,
          },
          id: frame.branchId,
          condition: frame.condition,
          path: parent.path,
        });
      } else if (frame.branchKind === "else") {
        finishPending(scope, {
          abstracts: frame.abstracts,
          booleans: frame.booleans,
          normal: frame.normal,
          path: frame.path,
        });
      } else if (frame.normal) {
        parent.abstracts = frame.abstracts;
        parent.booleans = frame.booleans;
      }
    } else if (character === ";" && parentheses === 0) {
      const statementCode = method.code.slice(start, index).trim();
      const statementSource = method.source.slice(start, index).trim();
      const current = frames.at(-1);
      const isElse = /^else\b/.test(statementCode);
      const isIf = /^(?:else\s+)?if\s*\(/.test(statementCode);
      const previous = isElse ? pendingIf.get(scope) : null;
      if (!isElse) finishPending(scope);
      const statementPath = new Map(current.path);
      if (previous?.condition === null) {
        statementPath.set(previous.id, false);
      }
      const condition = isIf
        ? conditionValue(
            statementCode,
            previous?.base ?? current.booleans,
          )
        : null;
      const branchId = isIf
        ? `${method.id}:${method.bodyStart + start}`
        : null;
      if (branchId) {
        const open = statementCode.indexOf("(");
        const close = matchingIndex(statementCode, open);
        branchConditions.set(
          branchId,
          statementCode.slice(open + 1, close),
        );
      }
      if (branchId && condition === null) {
        statementPath.set(branchId, true);
      }
      events.push({
        type: "statement",
        scope,
        active:
          current.active &&
          current.normal &&
          condition !== false &&
          previous?.condition !== true,
        path: statementPath,
        code: statementCode,
        source: statementSource,
        position: method.bodyStart + start,
        abstracts: new Map(current.abstracts),
      });
      if (isIf) {
        const close = matchingIndex(statementCode, statementCode.indexOf("("));
        const consequentCode = statementCode.slice(close + 1).trim();
        const consequentBooleans = new Map(current.booleans);
        const consequentAbstracts = new Map(current.abstracts);
        javaBooleanAssignment(consequentCode, consequentBooleans);
        javaAbstractAssignment(
          statementSource.slice(
            matchingIndex(statementCode, statementCode.indexOf("(")) + 1,
          ).trim(),
          consequentAbstracts,
        );
        pendingIf.set(scope, {
          abstractBase: new Map(current.abstracts),
          base: new Map(current.booleans),
          consequent: {
            abstracts: consequentAbstracts,
            booleans: consequentBooleans,
            normal: !/^(?:return|throw)\b/.test(consequentCode),
            path: statementPath,
          },
          id: branchId,
          condition,
          path: current.path,
        });
        finishPending(scope);
      } else {
        javaBooleanAssignment(statementCode, current.booleans);
        javaAbstractAssignment(statementSource, current.abstracts);
        if (/^(?:return|throw)\b/.test(statementCode)) current.normal = false;
      }
      start = index + 1;
    }
  }
  finishPending(scope);
  events.branchConditions = branchConditions;
  return events;
}

function mergePaths(...paths) {
  const result = new Map();
  for (const path of paths) {
    for (const [branch, choice] of path ?? []) {
      if (result.has(branch) && result.get(branch) !== choice) {
        return null;
      }
      result.set(branch, choice);
    }
  }
  return result;
}

function pathsCompatible(...values) {
  return mergePaths(...values.map((value) => value?.path ?? value)) !== null;
}

function parseTryBlocks(method, types, methodsByName) {
  const blocks = [];
  const pattern = /\btry\b/g;
  let match;
  while ((match = pattern.exec(method.code)) !== null) {
    let cursor = match.index + match[0].length;
    cursor += method.code.slice(cursor).match(/^\s*/)[0].length;
    if (method.code[cursor] === "(") {
      cursor = matchingIndex(method.code, cursor) + 1;
      if (cursor === 0) {
        continue;
      }
      cursor += method.code.slice(cursor).match(/^\s*/)[0].length;
    }
    if (method.code[cursor] !== "{") {
      continue;
    }
    const bodyEnd = matchingIndex(method.code, cursor, "{", "}");
    if (bodyEnd === -1) {
      continue;
    }

    const catches = [];
    let catchCursor = bodyEnd + 1;
    while (catchCursor < method.code.length) {
      catchCursor += method.code.slice(catchCursor).match(/^\s*/)[0].length;
      if (!method.code.startsWith("catch", catchCursor)) {
        break;
      }
      const headerOpen = method.code.indexOf("(", catchCursor + 5);
      const headerClose = matchingIndex(method.code, headerOpen);
      const catchOpen = method.code.indexOf("{", headerClose);
      const catchClose = matchingIndex(method.code, catchOpen, "{", "}");
      if (
        headerOpen === -1 ||
        headerClose === -1 ||
        catchOpen === -1 ||
        catchClose === -1
      ) {
        break;
      }
      const header = method.code.slice(headerOpen + 1, headerClose);
      const bodyCode = method.code.slice(catchOpen + 1, catchClose);
      const bodySource = method.source.slice(catchOpen + 1, catchClose);
      const target = new RegExp(
        `(?:^|[\\s|])${types.blobStorageException.pattern}(?:\\s|[|])`,
      ).test(` ${header} `);
      catches.push({
        start: method.bodyStart + catchOpen + 1,
        end: method.bodyStart + catchClose,
        header,
        bodyCode,
        bodySource,
        target,
        exactTarget: target && !header.includes("|"),
      });
      catchCursor = catchClose + 1;
    }
    blocks.push({
      id: `${method.id}:${match.index}`,
      methodId: method.id,
      start: method.bodyStart + cursor + 1,
      end: method.bodyStart + bodyEnd,
      mayThrow: javaTryBodyMayThrow(
        method.code.slice(cursor + 1, bodyEnd),
        methodsByName,
      ),
      catches,
    });
    pattern.lastIndex = match.index + match[0].length;
  }
  return blocks;
}

function javaTryBodyMayThrow(body, methodsByName, seen = new Set()) {
  const characters = [...body];
  for (const match of body.matchAll(
    /\b(?:if\s*\(\s*false\s*\)|for\s*\([^;]*;\s*false\s*;[^)]*\))\s*\{/g,
  )) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = matchingIndex(body, opening, "{", "}");
    if (closing < 0) continue;
    for (let index = match.index; index <= closing; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  body = characters.join("");
  if (/\bthrow\b/.test(body)) return true;
  for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (
      ["if", "for", "while", "switch", "catch", "synchronized"].includes(
        match[1],
      )
    ) continue;
    const candidates = methodsByName?.get(match[1]) ?? [];
    if (candidates.length === 0) return true;
    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      if (
        javaTryBodyMayThrow(
          candidate.code,
          methodsByName,
          new Set(seen).add(candidate.id),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function declarationTypeMatches(type, sdkType) {
  if (!type || /\bvar\s*$/.test(type)) {
    return true;
  }
  return new RegExp(`(?:^|[\\s<])${sdkType.pattern}(?:\\s|<|$)`).test(type);
}

function parseAssignment(code, source) {
  const compound = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*(?:\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<=|>>=|>>>=)/.exec(
    code,
  );
  if (compound) {
    return { name: compound[1], compound: true, declaration: false };
  }

  let operator = -1;
  let depth = 0;
  for (let index = 0; index < code.length; index += 1) {
    if ("([{<".includes(code[index])) {
      depth += 1;
    } else if (")]}>".includes(code[index])) {
      depth -= 1;
    } else if (
      code[index] === "=" &&
      depth === 0 &&
      code[index - 1] !== "=" &&
      code[index + 1] !== "=" &&
      !["!", "<", ">"].includes(code[index - 1])
    ) {
      operator = index;
      break;
    }
  }
  if (operator === -1) {
    return null;
  }

  const left = code.slice(0, operator).trim();
  const sourceOperator = source.indexOf("=");
  const expression = source.slice(sourceOperator + 1).trim();
  const field = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(left);
  if (field) {
    return {
      name: field[1],
      expression,
      declaration: false,
      declaredType: "",
      explicitField: /^this\s*\./.test(left),
    };
  }

  const declaration =
    /^(?:(?:public|protected|private|static|final|volatile|transient)\s+)*(.+?)\s+([A-Za-z_$][\w$]*)$/.exec(
      left,
    );
  if (!declaration || /\b(?:if|while|for|switch|return|throw)\b/.test(left)) {
    return null;
  }
  return {
    name: declaration[2],
    expression,
    declaration: true,
    declaredType: declaration[1].trim(),
  };
}

function literalValue(expression) {
  const value = unwrapParentheses(expression);
  const textBlock = /^"""([\s\S]*)"""$/.exec(value);
  if (textBlock) {
    const body = textBlock[1]
      .replace(/^\r?\n/, "")
      .replace(/\r\n/g, "\n");
    const nonblank = body.split("\n").filter((line) => line.trim() !== "");
    const indent = nonblank.length === 0
      ? 0
      : Math.min(
          ...nonblank.map((line) => /^\s*/.exec(line)?.[0].length ?? 0),
        );
    return body
      .split("\n")
      .map((line) => line.slice(Math.min(indent, line.length)))
      .join("\n")
      .replace(/\\s/g, " ")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  const match = /^"((?:\\.|[^"\\])*)"$/.exec(value);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function callAt(expression, methodName) {
  const pattern = new RegExp(`\\.\\s*${escapeRegExp(methodName)}\\s*\\(`, "g");
  const match = pattern.exec(expression);
  if (!match) {
    return null;
  }

  const open = expression.indexOf("(", match.index);
  const close = matchingIndex(expression, open);
  if (close === -1) {
    return null;
  }
  return {
    receiver: expression.slice(0, match.index).trim(),
    arguments: splitTopLevel(expression.slice(open + 1, close)),
    suffix: expression.slice(close + 1).trim(),
  };
}

function splitTopLevelAddition(expression) {
  const parts = [];
  let start = 0;
  let state = "code";
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (state === "string" || state === "character") {
      if (character === "\\") {
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') {
      state = "string";
    } else if (character === "'") {
      state = "character";
    } else if (character in depth) {
      depth[character] += 1;
    } else if (character in closing) {
      depth[closing[character]] -= 1;
    } else if (
      character === "+" &&
      Object.values(depth).every((value) => value === 0)
    ) {
      parts.push(expression.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (parts.length > 0) {
    parts.push(expression.slice(start).trim());
  }
  return parts;
}

function javaIterableValue(expression, values) {
  const value = unwrapParentheses(expression).replace(/\s+/g, "");
  if (/^(?:this\.)?[A-Za-z_$][\w$]*$/.test(value)) {
    const resolved = values.get(value.replace(/^this\./, ""));
    return resolved?.kind === "iterable" ? { ...resolved } : null;
  }
  if (
    /^(?:List|Set|java\.util\.(?:List|Set))\.of\(\)$/.test(value) ||
    /^(?:Collections|java\.util\.Collections)\.empty(?:List|Set)\(\)$/.test(
      value,
    ) ||
    /^new[\w$.<>,?]+\[\](?:\{\}|\{,\})$/.test(value) ||
    /^new[\w$.<>,?]+\[0\]$/.test(value)
  ) {
    return { kind: "iterable", value: "empty" };
  }
  if (
    /^(?:List|Set|java\.util\.(?:List|Set))\.of\(.+\)$/.test(value) ||
    /^new[\w$.<>,?]+\[\](?:\{[^}]+\})$/.test(value) ||
    /^new[\w$.<>,?]+\[[1-9]\d*\]$/.test(value)
  ) {
    return { kind: "iterable", value: "nonempty" };
  }
  return null;
}

function javaConstantString(expression, values) {
  const value = unwrapParentheses(expression);
  const literal = literalValue(value);
  if (literal !== null) return { kind: "string", value: literal };
  const additions = splitTopLevelAddition(value);
  if (additions.length > 0) {
    const parts = additions.map((part) => javaConstantString(part, values));
    return parts.every((part) => part?.kind === "string")
      ? {
          kind: "string",
          value: parts.map((part) => part.value).join(""),
        }
      : null;
  }
  const reference =
    /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  const resolved = reference ? values.get(reference) : null;
  return resolved?.kind === "string" ? { ...resolved } : null;
}

function javaMapValue(expression, values) {
  const value = unwrapParentheses(expression).replace(/\s+/g, "");
  if (
    /^(?:Map|java\.util\.Map)\.of\(\)$/.test(value) ||
    /^(?:Collections|java\.util\.Collections)\.emptyMap\(\)$/.test(value)
  ) {
    return { kind: "map", value: "empty" };
  }
  if (
    /^(?:Map|java\.util\.Map)\.of\(.+\)$/.test(value) ||
    /^(?:Collections|java\.util\.Collections)\.singletonMap\(.+\)$/.test(value)
  ) {
    return { kind: "map", value: "nonempty" };
  }
  if (/^new(?:java\.util\.)?(?:HashMap|LinkedHashMap|TreeMap)(?:<[^>]+>)?\(\)$/.test(value)) {
    return { kind: "map", value: "unknown" };
  }
  const reference =
    /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  const resolved = reference ? values.get(reference) : null;
  return resolved?.kind === "map" ? { ...resolved } : null;
}

function javaAbstractAssignment(statement, values) {
  const assignment = parseAssignment(maskJava(statement, false), statement);
  if (!assignment || assignment.compound) return;
  const boolean = triStateJavaBoolean(assignment.expression, {
    get(name) {
      const value = values.get(name.replace(/\s+/g, ""));
      return value?.kind === "boolean" ? value.value : null;
    },
  });
  const string = javaConstantString(assignment.expression, values);
  const iterable = javaIterableValue(assignment.expression, values);
  const map = javaMapValue(assignment.expression, values);
  const next = boolean !== null
    ? { kind: "boolean", value: boolean }
    : string ?? iterable ?? map;
  const primitiveDeclaration =
    /\b(?:boolean|Boolean|String|Iterable|Collection|List|Set|Map)\b|\[\s*\]/.test(
      assignment.declaredType ?? "",
    );
  if (next || values.has(assignment.name) || primitiveDeclaration) {
    values.set(assignment.name, next);
  }
}

function mergeJavaAbstracts(base, branches) {
  const merged = new Map(base);
  for (const name of base.keys()) {
    const values = branches.map((branch) => branch.abstracts.get(name) ?? null);
    const first = JSON.stringify(values[0]);
    merged.set(
      name,
      values.every((value) => JSON.stringify(value) === first)
        ? values[0]
        : null,
    );
  }
  return merged;
}

function methodCall(expression) {
  const value = unwrapParentheses(expression);
  const direct = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(value);
  if (direct) {
    return { name: direct[1], arguments: splitTopLevel(direct[2]) };
  }
  const qualified =
    /^(?:new\s+[A-Za-z_$][\w$]*\s*\([^)]*\)|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  return qualified
    ? { name: qualified[1], arguments: splitTopLevel(qualified[2]) }
    : null;
}

function meaningfulCatch(caught) {
  const parameter = /\b([A-Za-z_$][\w$]*)\s*$/.exec(caught.header)?.[1];
  if (!parameter) {
    return false;
  }
  const parameterPattern = escapeRegExp(parameter);
  const reports = (
    new RegExp(
      `\\b(?:java\\s*\\.\\s*lang\\s*\\.\\s*)?System\\s*\\.\\s*(?:out|err)\\s*\\.\\s*(?:print|println|printf|format)\\s*\\([^;{}]*\\b${parameterPattern}\\b`,
    ).test(caught.bodySource) ||
    new RegExp(
      `\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:trace|debug|info|warn|warning|error|fatal|log)\\s*\\([^;{}]*\\b${parameterPattern}\\b`,
    ).test(caught.bodySource) ||
    new RegExp(
      `\\b[A-Za-z_$][\\w$]*\\s*\\([^;{}]*\\b${parameterPattern}\\b[^;{}]*\\)`,
    ).test(caught.bodySource)
  );
  return (
    reports &&
    (catchAlwaysPreserves(caught) ||
      caught.exactTarget && catchAlwaysHandles(caught))
  );
}

function catchEvents(caught) {
  return orderedStatements({
    id: "catch",
    bodyStart: 0,
    code: caught.bodyCode,
    source: caught.bodySource,
  }).filter((event) => event.type === "statement" && event.active);
}

function catchAssignments(events) {
  const branches = Array.from(
    new Set(events.flatMap((event) => Array.from(event.path.keys()))),
  );
  if (branches.length > 12) return null;
  return Array.from({ length: 2 ** branches.length }, (_, mask) =>
    new Map(
      branches.map((branch, index) => [
        branch,
        Boolean(mask & (1 << index)),
      ]),
    ),
  );
}

function catchStatement(event) {
  return event.code
    .replace(/^(?:else\s+)?(?:if|while|for)\s*\([\s\S]*\)\s*/, "")
    .replace(/^else\s+/, "")
    .trim();
}

function catchAlwaysPreserves(caught) {
  const parameter = /\b([A-Za-z_$][\w$]*)\s*$/.exec(caught.header)?.[1];
  if (!parameter) {
    return false;
  }
  const events = catchEvents(caught);
  const assignments = catchAssignments(events);
  if (!assignments) return false;
  for (const path of assignments) {
    const reachable = events.filter((event) => pathsCompatible(event, path));
    const aliases = new Set([parameter]);
    const usesAlias = (expression) =>
      Array.from(aliases).some((alias) => {
        const match = new RegExp(
          `(?<![\\w$.])${escapeRegExp(alias)}\\b`,
        ).exec(expression);
        return match &&
          !/^\s*\./.test(expression.slice(match.index + match[0].length));
      });
    let safelyTerminated = false;
    for (const event of reachable) {
      const statement = catchStatement(event);
      const assignment = parseAssignment(statement, statement);
      if (assignment && !assignment.compound) {
        if (usesAlias(assignment.expression)) {
          aliases.add(assignment.name);
        } else {
          aliases.delete(assignment.name);
        }
        continue;
      }
      if (/^return\b/.test(statement)) {
        safelyTerminated = false;
        break;
      }
      if (/^throw\b/.test(statement)) {
        safelyTerminated = usesAlias(statement.replace(/^throw\s+/, ""));
        break;
      }
    }
    if (!safelyTerminated) return false;
  }
  return true;
}

function catchAlwaysHandles(caught) {
  const parameter = /\b([A-Za-z_$][\w$]*)\s*$/.exec(caught.header)?.[1];
  if (!parameter) return false;
  const parameterPattern = escapeRegExp(parameter);
  const reports = new RegExp(
    `(?:\\bSystem\\s*\\.\\s*(?:out|err)\\s*\\.\\s*(?:print|println|printf|format)|\\b[A-Za-z_$][\\w$]*\\s*\\.\\s*(?:trace|debug|info|warn|warning|error|fatal|log))\\s*\\([^;{}]*\\b${parameterPattern}\\b`,
  );
  const events = catchEvents(caught);
  const assignments = catchAssignments(events);
  if (!assignments) return false;
  return assignments.every((path) => {
    let reported = false;
    for (const event of events.filter((candidate) =>
      pathsCompatible(candidate, path)
    )) {
      const statement = catchStatement(event);
      if (/^(?:return|throw)\b/.test(statement)) return false;
      if (reports.test(statement)) reported = true;
    }
    return reported;
  });
}

function createRuntime(source, code, sourceWithStrings) {
  const types = sdkContext(code);
  const methods = parseMethods(code, sourceWithStrings);
  const methodsByName = new Map();
  for (const method of methods) {
    const existing = methodsByName.get(method.name) ?? [];
    existing.push(method);
    methodsByName.set(method.name, existing);
  }
  for (const method of methods) {
    method.events = orderedStatements(method);
    method.branchConditions = method.events.branchConditions;
    method.tries = parseTryBlocks(method, types, methodsByName);
    for (const protection of method.tries) {
      protection.reachable = protection.mayThrow && method.events.some(
        (event) =>
          event.type === "statement" &&
          event.active &&
          protection.start <= event.position &&
          event.position <= protection.end,
      );
    }
  }
  const facts = {
    sequence: 0,
    nextClientId: 0,
    nextContainerId: 0,
    nextBlobId: 0,
    nextLeaseId: 0,
    nextInvocationId: 0,
    operations: [],
    outputs: [],
    waits: [],
    serviceClients: [],
    reachableMethods: new Set(),
    protections: new Map(),
  };
  for (const method of methods) {
    for (const protection of method.tries) {
      facts.protections.set(protection.id, protection);
    }
  }

  const fields = new Map();
  const fieldPattern =
    /\b(?:(?:public|protected|private|static|final|volatile|transient)\s+)*(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*(?:\s*<[^;={}()]+>)?(?:\s*\[\s*\])?\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;

  const runtime = {
    source,
    code,
    sourceWithStrings,
    types,
    methodsByName,
    facts,
    fields,
    activeCalls: new Set(),
  };

  const fieldScope = {
    scopes: [fields],
    resolve: (name) => fields.get(name),
    assign: (name, value) => fields.set(name, value),
    declare: (name, value) => fields.set(name, value),
  };
  let fieldMatch;
  while ((fieldMatch = fieldPattern.exec(sourceWithStrings)) !== null) {
    if (
      methods.some(
        (method) =>
          method.bodyStart <= fieldMatch.index && fieldMatch.index < method.bodyEnd,
      )
    ) {
      continue;
    }
    const value = evaluateExpression(fieldMatch[2], fieldScope, runtime, {
      method: null,
      position: fieldMatch.index,
      protection: null,
    });
    fieldScope.declare(fieldMatch[1], value);
  }

  for (const main of methodsByName.get("main") ?? []) {
    executeMethod(main, [], runtime, null, new Map());
  }
  return runtime;
}

function executionScope(runtime, parameters, argumentsList) {
  const scopes = [runtime.fields, new Map()];
  for (let index = 0; index < parameters.length; index += 1) {
    scopes.at(-1).set(parameters[index], argumentsList[index] ?? null);
  }
  return {
    scopes,
    resolve(name) {
      const simple = name.replace(/^this\s*\.\s*/, "");
      for (let index = scopes.length - 1; index >= 0; index -= 1) {
        if (scopes[index].has(simple)) {
          return scopes[index].get(simple);
        }
      }
      return null;
    },
    assign(name, value) {
      const simple = name.replace(/^this\s*\.\s*/, "");
      if (/^this\s*\./.test(name)) {
        runtime.fields.set(simple, value);
        return;
      }
      for (let index = scopes.length - 1; index >= 0; index -= 1) {
        if (scopes[index].has(simple)) {
          scopes[index].set(simple, value);
          return;
        }
      }
      scopes.at(-1).set(simple, value);
    },
    declare(name, value) {
      scopes.at(-1).set(name, value);
    },
  };
}

function currentProtection(method, position, inherited) {
  return (
    method.tries
      .filter((candidate) => candidate.start <= position && position <= candidate.end)
      .at(-1)?.id ??
    inherited
  );
}

function executeMethod(
  method,
  argumentsList,
  runtime,
  inheritedProtection,
  inheritedPath,
) {
  const callKey = `${method.id}:${argumentsList.map((value) => value?.kind ?? "").join(",")}`;
  if (runtime.activeCalls.has(callKey) || runtime.activeCalls.size > 20) {
    return null;
  }
  runtime.activeCalls.add(callKey);
  runtime.facts.reachableMethods.add(method.id);
  const invocationId = ++runtime.facts.nextInvocationId;
  const scope = executionScope(runtime, method.parameters, argumentsList);
  let returned = null;
  const terminatedPaths = [];
  const initialParameters = new Map(
    method.parameters.map((parameter, index) => [
      parameter,
      argumentsList[index] ?? null,
    ]),
  );

  for (const event of method.events) {
    if (event.type === "enter") {
      scope.scopes.push(new Map());
      const enhancedFor =
        /^for\s*\(\s*(?:final\s+)?(.+?)\s+([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)\)$/.exec(
          event.source ?? "",
        );
      if (enhancedFor && event.active) {
        const iterable = evaluateExpression(
          enhancedFor[3],
          scope,
          runtime,
          {
            abstracts: new Map(),
            method,
            position: event.position,
            protection: currentProtection(
              method,
              event.position,
              inheritedProtection,
            ),
            path: mergePaths(inheritedPath, event.path),
          },
        );
        if (
          iterable?.kind === "blob-list" &&
          declarationTypeMatches(enhancedFor[1], runtime.types.blobItem)
        ) {
          scope.declare(enhancedFor[2], {
            kind: "blob-item",
            clientId: iterable.clientId,
            containerId: iterable.containerId,
            listSequence: iterable.sequence,
            path: iterable.path,
          });
        }
      }
      continue;
    }
    if (event.type === "exit") {
      if (scope.scopes.length > 2) {
        scope.scopes.pop();
      }
      continue;
    }
    if (!event.active || !event.source) {
      continue;
    }
    const localPath = new Map();
    let runtimeUnreachable = false;
    for (const [branch, choice] of event.path ?? []) {
      const expression = method.branchConditions?.get(branch);
      const dependsOnParameter = method.parameters.some((parameter) =>
        new RegExp(`\\b${escapeRegExp(parameter)}\\b`).test(expression ?? "") &&
        scope.resolve(parameter) === initialParameters.get(parameter)
      );
      const runtimeCondition = expression && dependsOnParameter
        ? triStateJavaBoolean(expression, {
            get(name) {
              const value = scope.resolve(name);
              return value?.kind === "boolean" ? value.value : null;
            },
          })
        : null;
      if (runtimeCondition !== null) {
        if (runtimeCondition !== choice) {
          runtimeUnreachable = true;
          break;
        }
        continue;
      }
      localPath.set(`${invocationId}:${branch}`, choice);
    }
    if (runtimeUnreachable) continue;
    for (const protection of method.tries) {
      if (
        protection.start <= event.position &&
        event.position <= protection.end
      ) {
        localPath.set(`${invocationId}:try:${protection.id}`, "body");
      }
      const catchIndex = protection.catches.findIndex(
        (caught) =>
          caught.start <= event.position && event.position <= caught.end,
      );
      if (catchIndex !== -1) {
        if (!protection.mayThrow) {
          runtimeUnreachable = true;
          break;
        }
        localPath.set(
          `${invocationId}:try:${protection.id}`,
          `catch:${catchIndex}`,
        );
      }
    }
    if (runtimeUnreachable) continue;
    const path = mergePaths(inheritedPath, localPath);
    if (!path) continue;
    if (
      terminatedPaths.some((terminated) =>
        Array.from(terminated).every(
          ([branch, choice]) => path.get(branch) === choice,
        )
      )
    ) {
      continue;
    }
    const protection = currentProtection(
      method,
      event.position,
      inheritedProtection,
    );
    let statementCode = event.code
      .replace(/^(?:else\s+)?(?:if|while|for|switch)\s*\([\s\S]*\)\s*/, "")
      .replace(/^else\s+/, "")
      .trim();
    let statementSource = event.source;
    const sourcePrefix =
      /^(?:else\s+)?(?:if|while|for|switch)\s*\([\s\S]*\)\s*/.exec(
        statementSource,
      )?.[0];
    if (sourcePrefix) {
      statementSource = statementSource.slice(sourcePrefix.length).trim();
    }
    statementSource = statementSource.replace(/^else\s+/, "");
    if (/^return\b/.test(statementCode)) {
      returned = evaluateExpression(
        statementSource.replace(/^return\b/, ""),
        scope,
        runtime,
        {
          abstracts: event.abstracts,
          method,
          position: event.position,
          protection,
          path,
        },
      );
      terminatedPaths.push(path);
      continue;
    }
    if (/^throw\b/.test(statementCode)) {
      evaluateExpression(
        statementSource.replace(/^throw\b/, ""),
        scope,
        runtime,
        {
          abstracts: event.abstracts,
          method,
          position: event.position,
          protection,
          path,
        },
      );
      terminatedPaths.push(path);
      continue;
    }

    const assignment = parseAssignment(statementCode, statementSource);
    if (assignment?.compound) {
      scope.assign(assignment.name, null);
      continue;
    }
    if (assignment) {
      let value = evaluateExpression(assignment.expression, scope, runtime, {
        abstracts: event.abstracts,
        method,
        position: event.position,
        protection,
        path,
      });
      const expectedType = {
        "service-client": value?.async
          ? runtime.types.blobServiceAsyncClient
          : runtime.types.blobServiceClient,
        "container-client": value?.async
          ? runtime.types.blobContainerAsyncClient
          : runtime.types.blobContainerClient,
        "blob-client": value?.async
          ? runtime.types.blobAsyncClient
          : runtime.types.blobClient,
        "blob-item": runtime.types.blobItem,
      }[value?.kind];
      if (
        expectedType &&
        assignment.declaration &&
        !declarationTypeMatches(assignment.declaredType, expectedType)
      ) {
        value = null;
      }
      if (assignment.declaration) {
        scope.declare(assignment.name, value);
      } else if (assignment.explicitField) {
        runtime.fields.set(assignment.name, value);
      } else {
        scope.assign(assignment.name, value);
      }
      continue;
    }

    evaluateStatement(statementSource, scope, runtime, {
      abstracts: event.abstracts,
      method,
      position: event.position,
      protection,
      path,
    });
  }
  runtime.activeCalls.delete(callKey);
  return returned;
}

function evaluateStatement(statement, scope, runtime, context) {
  for (const builderMethod of [
    "credential",
    "endpoint",
    "retryOptions",
    "httpLogOptions",
  ]) {
    const call = callAt(statement, builderMethod);
    if (!call) continue;
    const receiver = scope.resolve(call.receiver);
    if (receiver?.kind !== "service-client-builder") continue;
    const argument = evaluateExpression(
      call.arguments[0] ?? "", scope, runtime, context,
    );
    if (builderMethod === "credential") receiver.credential = argument;
    else if (builderMethod === "endpoint") receiver.endpoint = argument;
    else if (builderMethod === "retryOptions") receiver.retryOptions = argument;
    else receiver.httpLogOptions = argument;
    return receiver;
  }

  const output =
    /^(?:java\s*\.\s*lang\s*\.\s*)?System\s*\.\s*(?:out|err)\s*\.\s*(?:print|println|printf|format)\s*\(/.exec(
      statement.trim(),
    );
  if (output) {
    const open = statement.indexOf("(", output.index);
    const close = matchingIndex(statement, open);
    const argumentsList = splitTopLevel(statement.slice(open + 1, close));
    for (const argument of argumentsList) {
      const candidates = [argument, ...splitTopLevelAddition(argument)];
      for (const candidate of candidates) {
        const value = evaluateExpression(candidate, scope, runtime, context);
        if (!["blob-name", "blob-size"].includes(value?.kind)) continue;
        const path = mergePaths(value.path, context.path);
        if (!path) continue;
        runtime.facts.outputs.push({
          ...value,
          sequence: ++runtime.facts.sequence,
          path,
        });
      }
    }
    return null;
  }
  return evaluateExpression(statement, scope, runtime, context);
}

function topLevelJavaOperator(expression, operator) {
  let state = "code";
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closes = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (state !== "code") {
      if (character === "\\") index += 1;
      else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') state = "string";
    else if (character === "'") state = "character";
    else if (character in depth) depth[character] += 1;
    else if (character in closes) depth[closes[character]] -= 1;
    else if (
      Object.values(depth).every((value) => value === 0) &&
      expression.startsWith(operator, index)
    ) {
      return index;
    }
  }
  return -1;
}

function topLevelJavaTernary(expression) {
  const question = topLevelJavaOperator(expression, "?");
  if (question === -1) return null;
  let nested = 0;
  for (let index = question + 1; index < expression.length; index += 1) {
    const suffix = expression.slice(index);
    const character = expression[index];
    if (character === "?") nested += 1;
    else if (character === ":" && nested-- === 0) {
      return {
        alternate: expression.slice(index + 1),
        condition: expression.slice(0, question),
        consequent: expression.slice(question + 1, index),
      };
    }
    if (/^["']/.test(suffix)) {
      const quote = character;
      for (index += 1; index < expression.length; index += 1) {
        if (expression[index] === "\\") index += 1;
        else if (expression[index] === quote) break;
      }
    }
  }
  return null;
}

function javaExpressionBoolean(expression, scope) {
  return triStateJavaBoolean(expression, {
    get(name) {
      const value = scope.resolve(name.replace(/\s+/g, ""));
      return value?.kind === "boolean" ? value.value : null;
    },
  });
}

function javaExpressionPath(context, key, choice) {
  return {
    ...context,
    path: mergePaths(context.path, new Map([[key, choice]])),
  };
}

function completedCall(receiver, suffix) {
  return (
    !receiver?.async ||
    /\.\s*(?:block|blockLast|subscribe)\s*\(/.test(suffix) ||
    /\.\s*(?:then|thenMany|flatMap|concatMap|map|doOn(?:Next|Success|Error|Terminate))\s*\(/.test(
      suffix,
    )
  );
}

function endpointValue(value) {
  return value?.kind === "string" || value?.kind === "env";
}

function guardedContainerCreate(context, scope, receiverExpression, receiver) {
  const simple = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(
    receiverExpression.trim(),
  )?.[1];
  for (const [key, choice] of context.path ?? []) {
    const original = key.replace(/^\d+:/, "");
    const condition = (context.method?.branchConditions?.get(original) ?? "")
      .replace(/\s+/g, "");
    if (!condition) continue;
    if (simple) {
      const escaped = escapeRegExp(simple);
      if (choice && new RegExp(`^!${escaped}\\.exists\\(\\)$`).test(condition)) return true;
      if (!choice && new RegExp(`^${escaped}\\.exists\\(\\)$`).test(condition)) return true;
    }
    const variable = /^!?([A-Za-z_$][\w$]*)$/.exec(condition);
    if (!variable) continue;
    const checked = scope.resolve(variable[1]);
    const missing = condition.startsWith("!") ? choice : !choice;
    if (missing && checked?.kind === "exists-check" &&
        checked.containerId === receiver.id) return true;
  }
  return false;
}

function operationEvent(runtime, context, details) {
  const event = {
    ...details,
    sequence: ++runtime.facts.sequence,
    methodId: context.method?.id,
    position: context.position,
    protection: context.protection,
    path: context.path,
  };
  runtime.facts.operations.push(event);
  return event;
}

function serviceClientEvent(runtime, context, details) {
  const event = {
    ...details,
    sequence: ++runtime.facts.sequence,
    methodId: context.method?.id,
    position: context.position,
    protection: context.protection,
    path: context.path,
  };
  runtime.facts.serviceClients.push(event);
  return event;
}

function evaluateExpression(expression, scope, runtime, context) {
  const value = unwrapParentheses(expression.trim());
  if (!value) return null;

  const ternary = topLevelJavaTernary(value);
  if (ternary) {
    const condition = javaExpressionBoolean(ternary.condition, scope);
    if (condition === true) return evaluateExpression(ternary.consequent, scope, runtime, context);
    if (condition === false) return evaluateExpression(ternary.alternate, scope, runtime, context);
    const key = `${context.method?.id ?? "root"}:${context.position}:ternary`;
    const consequent = evaluateExpression(
      ternary.consequent, scope, runtime, javaExpressionPath(context, key, true),
    );
    const alternate = evaluateExpression(
      ternary.alternate, scope, runtime, javaExpressionPath(context, key, false),
    );
    return JSON.stringify(consequent) === JSON.stringify(alternate) ? consequent : null;
  }

  for (const operator of ["||", "&&"]) {
    const index = topLevelJavaOperator(value, operator);
    if (index === -1) continue;
    const leftText = value.slice(0, index);
    const rightText = value.slice(index + 2);
    let leftBoolean = javaExpressionBoolean(leftText, scope);
    const left = evaluateExpression(leftText, scope, runtime, context);
    if (leftBoolean === null && left?.kind === "boolean") leftBoolean = left.value;
    if ((operator === "&&" && leftBoolean === false) ||
        (operator === "||" && leftBoolean === true)) return left;
    const rightContext = leftBoolean === null
      ? javaExpressionPath(context,
          `${context.method?.id ?? "root"}:${context.position}:short:${index}`,
          operator === "&&")
      : context;
    return evaluateExpression(rightText, scope, runtime, rightContext);
  }

  const additions = splitTopLevelAddition(value);
  if (additions.length > 0) {
    const parts = additions.map((part) => evaluateExpression(part, scope, runtime, context));
    if (parts.every((part) => part?.kind === "string")) {
      return { kind: "string", value: parts.map((part) => part.value).join("") };
    }
    return parts.find((part) => ["blob-name", "blob-size"].includes(part?.kind)) ?? null;
  }

  const literal = literalValue(value);
  if (literal !== null) return { kind: "string", value: literal };
  if (/^(?:true|Boolean\s*\.\s*TRUE)$/.test(value)) return { kind: "boolean", value: true };
  if (/^(?:false|Boolean\s*\.\s*FALSE)$/.test(value)) return { kind: "boolean", value: false };
  if (/^\d+(?:\.\d+)?[dDfFlL]?$/.test(value)) {
    return { kind: "number", value: Number(value.replace(/[dDfFlL]$/, "")) };
  }
  if (/^null$/.test(value)) return null;

  const environment =
    /^(?:java\s*\.\s*lang\s*\.\s*)?System\s*\.\s*getenv\s*\(/.exec(
      value,
    );
  if (environment) {
    const open = value.indexOf("(", environment.index);
    const close = matchingIndex(value, open);
    const name = evaluateExpression(
      value.slice(open + 1, close),
      scope,
      runtime,
      context,
    );
    if (name?.kind === "string") {
      return { kind: "env", name: name.value };
    }
    if (close === open + 1) {
      const result = { kind: "environment" };
      const suffix = value.slice(close + 1).trim();
      return suffix
        ? evaluateExpression(
            `environment${suffix}`,
            {
              ...scope,
              resolve: (identifier) =>
                identifier === "environment"
                  ? result
                  : scope.resolve(identifier),
            },
            runtime,
            context,
          )
        : result;
    }
  }

  const environmentGet = callAt(value, "get");
  if (environmentGet) {
    const receiver = evaluateExpression(
      environmentGet.receiver,
      scope,
      runtime,
      context,
    );
    const name = evaluateExpression(
      environmentGet.arguments[0] ?? "",
      scope,
      runtime,
      context,
    );
    if (receiver?.kind === "environment" && name?.kind === "string") {
      return { kind: "env", name: name.value };
    }
  }
  const environmentDefault = callAt(value, "getOrDefault");
  if (environmentDefault) {
    const receiver = evaluateExpression(
      environmentDefault.receiver,
      scope,
      runtime,
      context,
    );
    const fallback = evaluateExpression(
      environmentDefault.arguments[1] ?? "",
      scope,
      runtime,
      context,
    );
    if (receiver?.kind === "environment" && fallback?.kind === "string") {
      return fallback;
    }
  }

  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value);
  if (reference) {
    if (context.abstracts?.has(reference[1])) {
      const abstract = context.abstracts.get(reference[1]);
      if (abstract) return { ...abstract };
      const runtimeValue = scope.resolve(reference[1]);
      return ["boolean", "iterable", "string", "map"].includes(runtimeValue?.kind)
        ? null : runtimeValue;
    }
    return scope.resolve(reference[1]);
  }

  for (const method of ["strip", "trim"]) {
    const call = callAt(value, method);
    if (!call) continue;
    const receiver = evaluateExpression(
      call.receiver,
      scope,
      runtime,
      context,
    );
    if (["string", "env"].includes(receiver?.kind)) {
      return receiver;
    }
  }

  const iterable = javaIterableValue(value, context.abstracts ?? new Map());
  if (iterable) return iterable;
  const map = javaMapValue(value, context.abstracts ?? new Map());
  if (map) return map;

  if (/^(?:java\s*\.\s*time\s*\.\s*)?Duration\s*\.\s*of(?:Millis|Seconds|Minutes|Hours)\s*\(/.test(value)) {
    return { kind: "duration" };
  }

  if (new RegExp(
    `^(?:${runtime.types.retryPolicyType.pattern})\\s*\\.\\s*EXPONENTIAL$`,
  ).test(value)) {
    return { kind: "retry-policy-type", value: "EXPONENTIAL" };
  }

  if (new RegExp(
    `^(?:${runtime.types.httpLogDetailLevel.pattern})\\s*\\.\\s*[A-Z_]+$`,
  ).test(value)) {
    return { kind: "http-log-level" };
  }
  if (new RegExp(
    `^(?:${runtime.types.httpLogDetailLevel.pattern})\\s*\\.\\s*valueOf\\s*\\(`,
  ).test(value)) {
    return { kind: "http-log-level" };
  }

  const pathCall = /^(?:(?:java\s*\.\s*nio\s*\.\s*file\s*\.)?Path\s*\.\s*of|(?:java\s*\.\s*nio\s*\.\s*file\s*\.)?Paths\s*\.\s*get)\s*\(/.exec(value);
  if (pathCall) {
    const open = value.indexOf("(", pathCall.index);
    const close = matchingIndex(value, open);
    const path = evaluateExpression(value.slice(open + 1, close), scope, runtime, context);
    if (path?.kind === "string") return { kind: "path", value: path.value };
  }

  const fileData = /^(?:com\s*\.\s*azure\s*\.\s*core\s*\.\s*util\s*\.\s*)?BinaryData\s*\.\s*fromFile\s*\(/.exec(value);
  if (fileData) {
    const open = value.indexOf("(", fileData.index);
    const close = matchingIndex(value, open);
    const path = evaluateExpression(value.slice(open + 1, close), scope, runtime, context);
    const pathValue = path?.kind === "path" ? path.value : path?.value;
    return pathValue ? { kind: "file-data", path: pathValue } : null;
  }

  const stream = /^(?:java\s*\.\s*nio\s*\.\s*file\s*\.)?Files\s*\.\s*new(Input|Output)Stream\s*\(/.exec(value);
  if (stream) {
    const open = value.indexOf("(", stream.index);
    const close = matchingIndex(value, open);
    const path = evaluateExpression(value.slice(open + 1, close), scope, runtime, context);
    const pathValue = path?.kind === "path" ? path.value : path?.value;
    return pathValue ? {
      kind: stream[1] === "Input" ? "file-data" : "file-output",
      path: pathValue,
    } : null;
  }

  const toStringCall = callAt(value, "toString");
  if (toStringCall) {
    const receiver = evaluateExpression(toStringCall.receiver, scope, runtime, context);
    if (receiver?.kind === "path") {
      return { kind: "string", value: receiver.value };
    }
    if (receiver?.kind === "string") {
      return { ...receiver };
    }
  }

  if (new RegExp(`^new\\s+${runtime.types.requestRetryOptions.pattern}\\s*\\(`).test(value)) {
    const open = value.indexOf("(");
    const close = matchingIndex(value, open);
    const args = splitTopLevel(value.slice(open + 1, close));
    const policy = evaluateExpression(args[0] ?? "", scope, runtime, context);
    const maxTries = evaluateExpression(args[1] ?? "", scope, runtime, context);
    const tryTimeout = evaluateExpression(args[2] ?? "", scope, runtime, context);
    const retryDelay = evaluateExpression(args[3] ?? "", scope, runtime, context);
    const maxRetryDelay = evaluateExpression(args[4] ?? "", scope, runtime, context);
    return {
      kind: "retry-options",
      exponential: policy?.kind === "retry-policy-type" && policy.value === "EXPONENTIAL",
      hasMaxTries:
        maxTries?.kind === "number" ||
        !/^(?:null|\s*)$/.test(args[1] ?? ""),
      hasTryTimeout: ["duration", "number"].includes(tryTimeout?.kind),
      hasRetryDelay: ["duration", "number"].includes(retryDelay?.kind),
      hasMaxRetryDelay: ["duration", "number"].includes(maxRetryDelay?.kind),
    };
  }

  if (new RegExp(`^new\\s+${runtime.types.httpLogOptions.pattern}\\s*\\(`).test(value)) {
    const level = callAt(value, "setLogLevel");
    const logLevel = level
      ? evaluateExpression(level.arguments[0] ?? "", scope, runtime, context)
      : null;
    return {
      kind: "http-log-options",
      enabled:
        logLevel?.kind === "http-log-level" ||
        Boolean(level && !/^(?:null|\s*)$/.test(level.arguments[0] ?? "")),
    };
  }

  if (new RegExp(`^new\\s+${runtime.types.timeoutPolicy.pattern}\\s*\\(`).test(value)) {
    const open = value.indexOf("(");
    const close = matchingIndex(value, open);
    const timeout = evaluateExpression(
      value.slice(open + 1, close),
      scope,
      runtime,
      context,
    );
    return {
      kind: "timeout-policy",
      configured: timeout?.kind === "duration",
    };
  }

  if (new RegExp(`^new\\s+${runtime.types.parallelTransferOptions.pattern}\\s*\\(`).test(value)) {
    return {
      kind: "parallel-transfer-options",
      configured:
        /\.\s*setBlockSize(?:Long)?\s*\(/.test(value) ||
        /\.\s*setMaxConcurrency\s*\(/.test(value) ||
        /\.\s*setMaxSingleUploadSize(?:Long)?\s*\(/.test(value),
    };
  }

  if (new RegExp(`^new\\s+${runtime.types.blobRequestConditions.pattern}\\s*\\(`).test(value)) {
    const leaseIdCall = callAt(value, "setLeaseId");
    const leaseId = leaseIdCall
      ? evaluateExpression(leaseIdCall.arguments[0] ?? "", scope, runtime, context)
      : null;
    const ifNoneMatchCall = callAt(value, "setIfNoneMatch");
    const ifNoneMatch = ifNoneMatchCall
      ? evaluateExpression(ifNoneMatchCall.arguments[0] ?? "", scope, runtime, context)
      : null;
    const ifMatchCall = callAt(value, "setIfMatch");
    const ifMatch = ifMatchCall
      ? evaluateExpression(ifMatchCall.arguments[0] ?? "", scope, runtime, context)
      : null;
    return {
      kind: "request-conditions",
      leaseId,
      ifNoneMatch: ifNoneMatch?.kind === "string" && ifNoneMatch.value === "*",
      ifMatch,
    };
  }

  if (new RegExp(`^new\\s+${runtime.types.blobUploadFromFileOptions.pattern}\\s*\\(`).test(value)) {
    const open = value.indexOf("(");
    const close = matchingIndex(value, open);
    const filePath = evaluateExpression(value.slice(open + 1, close), scope, runtime, context);
    const parallelTransferCall = callAt(value, "setParallelTransferOptions");
    const metadataCall = callAt(value, "setMetadata");
    const tagsCall = callAt(value, "setTags");
    const requestConditionsCall = callAt(value, "setRequestConditions");
    return {
      kind: "upload-options",
      filePath:
        filePath?.kind === "path" ? filePath.value
        : filePath?.kind === "string" ? filePath.value
        : null,
      parallelTransfer:
        evaluateExpression(
          parallelTransferCall?.arguments[0] ?? "",
          scope,
          runtime,
          context,
        )?.kind === "parallel-transfer-options",
      metadata:
        evaluateExpression(
          metadataCall?.arguments[0] ?? "",
          scope,
          runtime,
          context,
        )?.kind === "map",
      tags:
        evaluateExpression(
          tagsCall?.arguments[0] ?? "",
          scope,
          runtime,
          context,
        )?.kind === "map",
      requestConditions: evaluateExpression(
        requestConditionsCall?.arguments[0] ?? "",
        scope,
        runtime,
        context,
      ),
    };
  }

  if (new RegExp(`^new\\s+${runtime.types.blobDownloadToFileOptions.pattern}\\s*\\(`).test(value)) {
    const open = value.indexOf("(");
    const close = matchingIndex(value, open);
    const filePath = evaluateExpression(value.slice(open + 1, close), scope, runtime, context);
    return {
      kind: "download-options",
      filePath:
        filePath?.kind === "path" ? filePath.value
        : filePath?.kind === "string" ? filePath.value
        : null,
    };
  }

  if (new RegExp(`^new\\s+${runtime.types.credentialBuilder.pattern}\\s*\\(`).test(value)) {
    return /\.build\s*\(\s*\)\s*$/.test(value)
      ? { kind: "credential", valid: true }
      : { kind: "credential-builder", valid: true };
  }
  const credentialBuild = callAt(value, "build");
  if (credentialBuild) {
    const builder = evaluateExpression(credentialBuild.receiver, scope, runtime, context);
    if (builder?.kind === "credential-builder" && builder.valid) {
      return { kind: "credential", valid: true };
    }
  }

  if (new RegExp(`^new\\s+${runtime.types.blobServiceClientBuilder.pattern}\\s*\\(`).test(value)) {
    const credentialCall = callAt(value, "credential");
    const endpointCall = callAt(value, "endpoint");
    const retryOptionsCall = callAt(value, "retryOptions");
    const httpLogOptionsCall = callAt(value, "httpLogOptions");
    const timeoutPolicyCall = callAt(value, "addPolicy");
    const credential = credentialCall
      ? evaluateExpression(credentialCall.arguments[0] ?? "", scope, runtime, context) : null;
    const endpoint = endpointCall
      ? evaluateExpression(endpointCall.arguments[0] ?? "", scope, runtime, context) : null;
    const retryOptions = retryOptionsCall
      ? evaluateExpression(retryOptionsCall.arguments[0] ?? "", scope, runtime, context)
      : null;
    const httpLogOptions = httpLogOptionsCall
      ? evaluateExpression(httpLogOptionsCall.arguments[0] ?? "", scope, runtime, context)
      : null;
    const timeoutPolicy = timeoutPolicyCall
      ? evaluateExpression(
          timeoutPolicyCall.arguments[0] ?? "",
          scope,
          runtime,
          context,
        )
      : null;
    const asyncClient = /\.buildAsyncClient\s*\(\s*\)\s*$/.test(value);
    const syncClient = /\.buildClient\s*\(\s*\)\s*$/.test(value);
    if (syncClient || asyncClient) {
      if (credential?.kind === "credential" && credential.valid && endpointValue(endpoint)) {
        const client = {
          kind: "service-client",
          valid: true,
          async: asyncClient,
          id: ++runtime.facts.nextClientId,
          endpoint,
          retryOptions,
          httpLogOptions,
          timeoutPolicy,
        };
        serviceClientEvent(runtime, context, {
          clientId: client.id,
          async: client.async,
          endpoint,
          retryOptions,
          httpLogOptions,
          timeoutPolicy,
        });
        return client;
      }
      return null;
    }
    return {
      kind: "service-client-builder",
      valid: true,
      credential,
      endpoint,
      retryOptions,
      httpLogOptions,
      timeoutPolicy,
    };
  }

  for (const buildMethod of ["buildClient", "buildAsyncClient"]) {
    const call = callAt(value, buildMethod);
    if (!call) continue;
    const builder = evaluateExpression(call.receiver, scope, runtime, context);
    if (builder?.kind === "service-client-builder" && builder.valid &&
        builder.credential?.kind === "credential" && builder.credential.valid &&
        endpointValue(builder.endpoint)) {
      const client = {
        kind: "service-client",
        valid: true,
        async: buildMethod === "buildAsyncClient",
        id: ++runtime.facts.nextClientId,
        endpoint: builder.endpoint,
        retryOptions: builder.retryOptions,
        httpLogOptions: builder.httpLogOptions,
        timeoutPolicy: builder.timeoutPolicy,
      };
      serviceClientEvent(runtime, context, {
        clientId: client.id,
        async: client.async,
        endpoint: client.endpoint,
        retryOptions: client.retryOptions,
        httpLogOptions: client.httpLogOptions,
        timeoutPolicy: client.timeoutPolicy,
      });
      return client;
    }
  }

  for (const method of ["getBlobContainerClient", "getBlobContainerAsyncClient"]) {
    const call = callAt(value, method);
    if (!call) continue;
    const receiver = evaluateExpression(call.receiver, scope, runtime, context);
    const name = evaluateExpression(call.arguments[0] ?? "", scope, runtime, context);
    if (receiver?.kind === "service-client" && receiver.valid && name?.kind === "string") {
      return { kind: "container-client", valid: true,
        async: receiver.async || method.includes("Async"),
        id: ++runtime.facts.nextContainerId, clientId: receiver.id, name: name.value };
    }
  }

  for (const method of ["getBlobClient", "getBlobAsyncClient"]) {
    const blobCall = callAt(value, method);
    if (!blobCall) continue;
    const receiver = evaluateExpression(
      blobCall.receiver,
      scope,
      runtime,
      context,
    );
    const name = evaluateExpression(
      blobCall.arguments[0] ?? "",
      scope,
      runtime,
      context,
    );
    if (receiver?.kind === "container-client" && receiver.valid && name?.kind === "string") {
      return { kind: "blob-client", valid: true, async: receiver.async,
        id: ++runtime.facts.nextBlobId, clientId: receiver.clientId,
        containerId: receiver.id, containerName: receiver.name, name: name.value };
    }
  }

  if (new RegExp(`^new\\s+${runtime.types.blobLeaseClientBuilder.pattern}\\s*\\(`).test(value)) {
    const blobClientCall = callAt(value, "blobClient");
    const blobAsyncClientCall = callAt(value, "blobAsyncClient");
    const leaseIdCall = callAt(value, "leaseId");
    const target = blobClientCall
      ? evaluateExpression(blobClientCall.arguments[0] ?? "", scope, runtime, context)
      : blobAsyncClientCall
        ? evaluateExpression(blobAsyncClientCall.arguments[0] ?? "", scope, runtime, context)
        : null;
    const leaseId = leaseIdCall
      ? evaluateExpression(leaseIdCall.arguments[0] ?? "", scope, runtime, context)
      : null;
    return {
      kind: "lease-client-builder",
      async: Boolean(blobAsyncClientCall),
      blob: target?.kind === "blob-client" ? target : null,
      leaseId,
    };
  }

  for (const buildMethod of ["buildClient", "buildAsyncClient"]) {
    const call = callAt(value, buildMethod);
    if (!call) continue;
    const builder = evaluateExpression(call.receiver, scope, runtime, context);
    if (builder?.kind === "lease-client-builder" && builder.blob) {
      return {
        kind: "lease-client",
        async: buildMethod === "buildAsyncClient",
        blobId: builder.blob.id,
        containerId: builder.blob.containerId,
        clientId: builder.blob.clientId,
        containerName: builder.blob.containerName,
        name: builder.blob.name,
        configuredLeaseId: builder.leaseId,
      };
    }
  }

  for (const operation of ["createIfNotExists", "exists", "create", "listBlobs",
    "uploadFromFile", "uploadFromFileWithResponse", "upload", "uploadWithResponse",
    "downloadToFile", "downloadToFileWithResponse", "downloadStream",
    "deleteIfExists", "delete", "acquireLease", "releaseLease",
    "getName", "getProperties", "getContentLength",
    "toIterable", "collectList", "block", "blockLast"]) {
    const call = callAt(value, operation);
    if (!call) continue;
    const receiver = evaluateExpression(call.receiver, scope, runtime, context);
    let result = null;

    if (receiver?.kind === "container-client" && receiver.valid) {
      if (operation === "exists") {
        result = { kind: "exists-check", value: null, async: receiver.async, clientId: receiver.clientId,
          containerId: receiver.id, name: receiver.name };
      } else if (operation === "createIfNotExists" && completedCall(receiver, call.suffix)) {
        const event = operationEvent(runtime, context, { operation: "ensure-container",
          async: receiver.async, clientId: receiver.clientId, containerId: receiver.id, name: receiver.name });
        result = { kind: "container-result", ...event };
      } else if (operation === "create" && completedCall(receiver, call.suffix) &&
          guardedContainerCreate(context, scope, call.receiver, receiver)) {
        const event = operationEvent(runtime, context, { operation: "ensure-container",
          async: receiver.async, clientId: receiver.clientId, containerId: receiver.id, name: receiver.name });
        result = { kind: "container-result", ...event };
      } else if (operation === "listBlobs") {
        const event = operationEvent(runtime, context, { operation: "list",
          async: receiver.async, clientId: receiver.clientId, containerId: receiver.id, name: receiver.name });
        result = { kind: "blob-list", ...event };
      } else if (["deleteIfExists", "delete"].includes(operation) &&
          completedCall(receiver, call.suffix)) {
        const event = operationEvent(runtime, context, { operation: "delete-container",
          async: receiver.async, completed: true, clientId: receiver.clientId,
          containerId: receiver.id, name: receiver.name });
        result = { kind: "delete-result", ...event };
      }
    } else if (receiver?.kind === "blob-client" && receiver.valid) {
      if (["uploadFromFile", "uploadFromFileWithResponse"].includes(operation) &&
          completedCall(receiver, call.suffix)) {
        const options = operation === "uploadFromFileWithResponse"
          ? evaluateExpression(call.arguments[0] ?? "", scope, runtime, context)
          : null;
        const path = options?.kind === "upload-options"
          ? options.filePath
          : evaluateExpression(call.arguments[0] ?? "", scope, runtime, context)?.value;
        if (path) {
          const event = operationEvent(runtime, context, {
            operation: "upload",
            async: receiver.async,
            clientId: receiver.clientId,
            containerId: receiver.containerId,
            blobId: receiver.id,
            containerName: receiver.containerName,
            name: receiver.name,
            filePath: path,
            parallelTransfer: Boolean(options?.parallelTransfer),
            metadata: Boolean(options?.metadata),
            tags: Boolean(options?.tags),
            leaseId: options?.requestConditions?.leaseId ?? null,
            ifNoneMatch: Boolean(options?.requestConditions?.ifNoneMatch),
            ifMatch: options?.requestConditions?.ifMatch ?? null,
          });
          result = { kind: "upload-result", ...event };
        }
      } else if (["upload", "uploadWithResponse"].includes(operation) &&
          completedCall(receiver, call.suffix)) {
        const options = operation === "uploadWithResponse"
          ? evaluateExpression(call.arguments[0] ?? "", scope, runtime, context)
          : null;
        const data = operation === "uploadWithResponse"
          ? null
          : evaluateExpression(call.arguments[0] ?? "", scope, runtime, context);
        const path = options?.kind === "upload-options"
          ? options.filePath
          : data?.kind === "file-data"
            ? data.path
            : null;
        if (path) {
          const event = operationEvent(runtime, context, {
            operation: "upload",
            async: receiver.async,
            clientId: receiver.clientId,
            containerId: receiver.containerId,
            blobId: receiver.id,
            containerName: receiver.containerName,
            name: receiver.name,
            filePath: path,
            parallelTransfer: Boolean(options?.parallelTransfer),
            metadata: Boolean(options?.metadata),
            tags: Boolean(options?.tags),
            leaseId: options?.requestConditions?.leaseId ?? null,
            ifNoneMatch: Boolean(options?.requestConditions?.ifNoneMatch),
            ifMatch: options?.requestConditions?.ifMatch ?? null,
          });
          result = { kind: "upload-result", ...event };
        }
      } else if (operation === "downloadToFile" && completedCall(receiver, call.suffix)) {
        const path = evaluateExpression(call.arguments[0] ?? "", scope, runtime, context);
        const filePath = path?.kind === "path" ? path.value : path?.value;
        if (filePath) {
          const event = operationEvent(runtime, context, {
            operation: "download",
            async: receiver.async,
            clientId: receiver.clientId,
            containerId: receiver.containerId,
            blobId: receiver.id,
            containerName: receiver.containerName,
            name: receiver.name,
            filePath,
          });
          result = { kind: "download-result", ...event };
        }
      } else if (operation === "downloadToFileWithResponse" &&
          completedCall(receiver, call.suffix)) {
        const options = evaluateExpression(call.arguments[0] ?? "", scope, runtime, context);
        if (options?.kind === "download-options" && options.filePath) {
          const event = operationEvent(runtime, context, {
            operation: "download",
            async: receiver.async,
            clientId: receiver.clientId,
            containerId: receiver.containerId,
            blobId: receiver.id,
            containerName: receiver.containerName,
            name: receiver.name,
            filePath: options.filePath,
          });
          result = { kind: "download-result", ...event };
        }
      } else if (operation === "downloadStream" && completedCall(receiver, call.suffix)) {
        const output = evaluateExpression(call.arguments[0] ?? "", scope, runtime, context);
        if (output?.kind === "file-output") {
          const event = operationEvent(runtime, context, {
            operation: "download",
            async: receiver.async,
            clientId: receiver.clientId,
            containerId: receiver.containerId,
            blobId: receiver.id,
            containerName: receiver.containerName,
            name: receiver.name,
            filePath: output.path,
          });
          result = { kind: "download-result", ...event };
        }
      } else if (["deleteIfExists", "delete"].includes(operation) &&
          completedCall(receiver, call.suffix)) {
        const event = operationEvent(runtime, context, {
          operation: "delete-blob",
          async: receiver.async,
          completed: true,
          clientId: receiver.clientId,
          containerId: receiver.containerId,
          blobId: receiver.id,
          containerName: receiver.containerName,
          name: receiver.name,
        });
        result = { kind: "delete-result", ...event };
      }
    } else if (receiver?.kind === "lease-client") {
      if (operation === "acquireLease" && completedCall(receiver, call.suffix)) {
        const leaseId = receiver.configuredLeaseId?.kind === "string"
          ? receiver.configuredLeaseId.value
          : `lease-${++runtime.facts.nextLeaseId}`;
        const event = operationEvent(runtime, context, {
          operation: "acquire-lease",
          async: receiver.async,
          clientId: receiver.clientId,
          containerId: receiver.containerId,
          blobId: receiver.blobId,
          containerName: receiver.containerName,
          name: receiver.name,
          leaseId,
        });
        result = { kind: "lease-id", value: leaseId, ...event };
      } else if (operation === "releaseLease" && completedCall(receiver, call.suffix)) {
        const event = operationEvent(runtime, context, {
          operation: "release-lease",
          async: receiver.async,
          clientId: receiver.clientId,
          containerId: receiver.containerId,
          blobId: receiver.blobId,
          containerName: receiver.containerName,
          name: receiver.name,
          leaseId: receiver.configuredLeaseId?.kind === "string"
            ? receiver.configuredLeaseId.value
            : null,
        });
        result = { kind: "lease-release-result", ...event };
      }
    } else if (receiver?.kind === "blob-item") {
      if (operation === "getName") result = { ...receiver, kind: "blob-name" };
      else if (operation === "getProperties") result = { ...receiver, kind: "blob-properties" };
    } else if (receiver?.kind === "blob-properties" && operation === "getContentLength") {
      result = { ...receiver, kind: "blob-size" };
    } else if (receiver?.kind === "blob-list" &&
        ["toIterable", "collectList", "block", "blockLast"].includes(operation)) {
      result = receiver;
    }

    const eTagCall = callAt(value, "getETag");
    if (eTagCall) {
      const receiver = evaluateExpression(
        eTagCall.receiver,
        scope,
        runtime,
        context,
      );
      if (receiver?.kind === "blob-properties") {
        return { ...receiver, kind: "etag" };
      }
    }

    const leaseIdCall = callAt(value, "getLeaseId");
    if (leaseIdCall) {
      const receiver = evaluateExpression(
        leaseIdCall.receiver,
        scope,
        runtime,
        context,
      );
      if (receiver?.kind === "lease-client") {
        return {
          kind: "lease-id",
          value: receiver.configuredLeaseId?.value ??
            `lease-${receiver.blobId}`,
          ...receiver,
        };
      }
    }

    if (result && call.suffix) {
      return evaluateExpression(`result${call.suffix}`,
        { ...scope, resolve: (name) => name === "result" ? result : scope.resolve(name) },
        runtime, context);
    }
    if (result) {
      return result;
    }
  }

  const construction = /^new\s+([A-Za-z_$][\w$]*)\s*\(/.exec(value);
  if (construction && runtime.methodsByName.has(construction[1])) {
    const open = value.indexOf("(", construction.index);
    const close = matchingIndex(value, open);
    const candidates = runtime.methodsByName.get(construction[1]) ?? [];
    const args = splitTopLevel(value.slice(open + 1, close));
    const constructor = candidates.find((candidate) => candidate.parameters.length === args.length);
    const values = args.map((argument) => evaluateExpression(argument, scope, runtime, context));
    if (constructor) executeMethod(constructor, values, runtime, context.protection, context.path);
    const object = { kind: "object", className: construction[1] };
    const suffix = value.slice(close + 1).trim();
    if (suffix) return evaluateExpression(`constructed${suffix}`,
      { ...scope, resolve: (name) => name === "constructed" ? object : scope.resolve(name) },
      runtime, context);
    return object;
  }

  const method = methodCall(value);
  if (method) {
    const candidates = runtime.methodsByName.get(method.name) ?? [];
    const target = candidates.find((candidate) => candidate.parameters.length === method.arguments.length)
      ?? candidates[0];
    if (target) {
      const args = method.arguments.map((argument) => evaluateExpression(argument, scope, runtime, context));
      return executeMethod(target, args, runtime, context.protection, context.path);
    }
  }
  return null;
}

function flowFacts(workspace) {
  const source = workspace.source ?? "";
  const code = maskJava(source, false);
  const sourceWithStrings = maskJava(source, true);
  return createRuntime(source, code, sourceWithStrings);
}

function containerNameOf(event) {
  return event.containerName ?? event.name ?? null;
}

function sameLifecycle(left, right) {
  return left.clientId === right.clientId &&
    containerNameOf(left) === containerNameOf(right) &&
    pathsCompatible(left, right);
}

function sameBlobLifecycle(left, right) {
  return sameLifecycle(left, right) &&
    left.name === right.name;
}

function sameBlobTarget(left, right) {
  return containerNameOf(left) === containerNameOf(right) &&
    left.name === right.name &&
    pathsCompatible(left, right);
}

function serviceClientFor(runtime, event) {
  return runtime.facts.serviceClients.find((client) =>
    client.clientId === event.clientId &&
    client.async === event.async &&
    pathsCompatible(client, event)
  );
}

function secureServiceClient(client) {
  return Boolean(
    client &&
    client.endpoint?.kind === "env" &&
    client.endpoint.name,
  );
}

function configuredRetryAndLogging(client) {
  return Boolean(
    client &&
    client.retryOptions?.kind === "retry-options" &&
    client.retryOptions.exponential &&
    client.retryOptions.hasMaxTries &&
    (
      client.retryOptions.hasTryTimeout ||
      (
        client.timeoutPolicy?.kind === "timeout-policy" &&
        client.timeoutPolicy.configured
      )
    ) &&
    client.retryOptions.hasRetryDelay &&
    client.httpLogOptions?.kind === "http-log-options" &&
    client.httpLogOptions.enabled,
  );
}

function crudFlows(runtime, async) {
  const flows = [];
  const operations = runtime.facts.operations.filter((event) => event.async === async);
  for (const upload of operations.filter((event) => event.operation === "upload")) {
    for (const listed of operations.filter((event) =>
      event.operation === "list" &&
      event.sequence > upload.sequence &&
      sameLifecycle(upload, event)
    )) {
      if (!pathsCompatible(upload, listed)) continue;
      for (const download of operations.filter((event) =>
        event.operation === "download" &&
        event.sequence > listed.sequence &&
        sameBlobLifecycle(upload, event)
      )) {
        if (!pathsCompatible(upload, listed, download)) continue;
        for (const overwrite of operations.filter((event) =>
          event.operation === "upload" &&
          event.sequence > download.sequence &&
          sameBlobLifecycle(download, event)
        )) {
          if (!pathsCompatible(
            upload,
            listed,
            download,
            overwrite,
          )) {
            continue;
          }
          for (const blobDelete of operations.filter((event) =>
            event.operation === "delete-blob" &&
            event.completed &&
            event.sequence > overwrite.sequence &&
            sameBlobLifecycle(overwrite, event)
          )) {
            if (!pathsCompatible(
              upload,
              listed,
              download,
              overwrite,
              blobDelete,
            )) {
              continue;
            }
            flows.push({
              async,
              upload,
              listed,
              download,
              overwrite,
              blobDelete,
            });
          }
        }
      }
    }
  }
  return flows;
}

function flowStart(flow) {
  return flow.upload.sequence;
}

function flowEnd(flow) {
  return flow.blobDelete.sequence;
}

function hasForbiddenAuthenticationSource(source) {
  const code = maskJava(source ?? "", false);
  return (
    /\.\s*connectionString\s*\(/.test(code) ||
    /\bStorageSharedKeyCredential\b/.test(code) ||
    /\bAzureNamedKeyCredential\b/.test(code) ||
    /\baccountKey\b/.test(code)
  );
}

function hasReactiveChain(runtime) {
  const reachable = Array.from(runtime.methodsByName.values()).flat()
    .filter((method) => runtime.facts.reachableMethods.has(method.id))
    .map((method) => method.source);
  return reachable.some((source) =>
    /\.(?:then|flatMap|thenMany)\s*\(/.test(source) &&
    /\.block\s*\(\s*\)/.test(source),
  );
}

function classRanges(runtime) {
  const ranges = [];
  for (const match of runtime.code.matchAll(
    /\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g,
  )) {
    const open = runtime.code.indexOf("{", match.index);
    const close = matchingIndex(runtime.code, open, "{", "}");
    if (close < 0) continue;
    ranges.push({
      name: match[1],
      start: match.index,
      end: close + 1,
      code: runtime.code.slice(open + 1, close),
    });
  }
  return ranges;
}

function structuralCrudFlow(runtime, async) {
  const clientType = async
    ? /\bBlob(?:Service|Container)AsyncClient\b/
    : /\bBlob(?:Service|Container)Client\b/;
  const disallowed = async ? /$a/ : /\bBlob(?:Service|Container)AsyncClient\b/;
  const owner = classRanges(runtime).find((candidate) =>
    clientType.test(candidate.code) &&
    !disallowed.test(candidate.code) &&
    /\.uploadFromFile(?:WithResponse)?\s*\(/.test(candidate.code) &&
    /\.listBlobs\s*\(/.test(candidate.code)
  );
  if (!owner) return null;

  const methods = Array.from(runtime.methodsByName.values()).flat()
    .filter((method) =>
      owner.start < method.start &&
      method.bodyEnd < owner.end
    );
  const upload = methods.find((method) =>
    /\.uploadFromFile(?:WithResponse)?\s*\(/.test(method.code) &&
    /\bBlobUploadFromFileOptions\b/.test(method.code)
  );
  const download = methods.find((method) =>
    /\.downloadToFile(?:WithResponse)?\s*\(/.test(method.code)
  );
  const listed = methods.find((method) =>
    /\.listBlobs\s*\(/.test(method.code)
  );
  const deleted = methods.find((method) =>
    /\.(?:deleteIfExists|delete)\s*\(/.test(method.code)
  );
  const overwrite = methods.find((method) =>
    /\.setIfMatch\s*\(/.test(method.code) &&
    /\.setLeaseId\s*\(/.test(method.code) &&
    upload &&
    new RegExp(`\\b${escapeRegExp(upload.name)}\\s*\\(`).test(method.code)
  );
  if (!upload || !download || !listed || !deleted || !overwrite) {
    return null;
  }

  const demo = Array.from(runtime.methodsByName.values()).flat().find(
    (method) => {
      if (!runtime.facts.reachableMethods.has(method.id)) return false;
      const construction = new RegExp(
        `\\b${escapeRegExp(owner.name)}\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${escapeRegExp(owner.name)}\\s*\\(`,
      ).exec(method.code);
      if (!construction) return false;
      const receiver = escapeRegExp(construction[1]);
      const calls = [
        upload.name,
        download.name,
        overwrite.name,
        deleted.name,
      ].map((name) => {
        const pattern = new RegExp(
          `\\b${receiver}\\s*\\.\\s*${escapeRegExp(name)}\\s*\\(`,
          "g",
        );
        const matches = Array.from(method.code.matchAll(pattern));
        return matches.map((match) => {
          const open = method.code.indexOf("(", match.index);
          const close = matchingIndex(method.code, open);
          return {
            position: match.index,
            args: splitTopLevel(method.code.slice(open + 1, close)),
          };
        });
      });
      const blobArguments = calls.map((entries) => entries[0]?.args[0]
        ?.replace(/\s+/g, ""));
      if (
        blobArguments.some((argument) => !argument) ||
        !blobArguments.every((argument) => argument === blobArguments[0])
      ) {
        return false;
      }
      const positions = [
        upload.name,
        listed.name,
        download.name,
        overwrite.name,
        deleted.name,
      ].map((name) =>
        method.code.search(
          new RegExp(`\\b${receiver}\\s*\\.\\s*${escapeRegExp(name)}\\s*\\(`),
        )
      );
      if (async && positions[3] >= 0) {
        const beforeOverwrite = method.code.slice(0, positions[3]);
        const deferred = Array.from(
          beforeOverwrite.matchAll(
            /\bMono\s*<[^>]+>\s+([A-Za-z_$][\w$]*)\s*=/g,
          ),
        ).at(-1)?.[1];
        if (deferred) {
          const chained = method.code.search(
            new RegExp(
              `\\.\\s*then\\s*\\(\\s*${escapeRegExp(deferred)}\\s*\\)`,
            ),
          );
          if (chained >= 0) positions[3] = chained;
        }
      }
      return (
        positions.every((position) => position >= 0) &&
        positions.every((position, index) =>
          index === 0 || positions[index - 1] < position
        ) &&
        /\.acquireLease\s*\(/.test(method.code)
      );
    },
  );
  if (!demo) return null;
  return {
    async,
    owner,
    upload,
    download,
    listed,
    overwrite,
    deleted,
    demo,
  };
}

function structuralParallelUpload(flow) {
  return Boolean(
    flow &&
    /\bParallelTransferOptions\b/.test(flow.upload.code) &&
    /\.setParallelTransferOptions\s*\(/.test(flow.upload.code) &&
    /\.setTags\s*\(/.test(flow.upload.code),
  );
}

function structuralLeaseOverwrite(flow) {
  return Boolean(
    flow &&
    /\.acquireLease\s*\(/.test(flow.demo.code) &&
    /\.setIfMatch\s*\(/.test(flow.overwrite.code) &&
    /\.setLeaseId\s*\(/.test(flow.overwrite.code),
  );
}

function structuralReactiveDemo(runtime, sync, async) {
  if (!sync || !async) return false;
  return runtime.methodsByName.get("main")?.some((main) => {
    const syncCall = main.code.search(
      new RegExp(`\\b${escapeRegExp(sync.demo.name)}\\s*\\(`),
    );
    const asyncCall = main.code.search(
      new RegExp(`\\b${escapeRegExp(async.demo.name)}\\s*\\(`),
    );
    return (
      syncCall >= 0 &&
      asyncCall > syncCall &&
      (
        /\.\s*block\s*\(\s*\)/.test(main.code.slice(asyncCall)) ||
        /\.\s*block\s*\(\s*\)/.test(async.demo.code)
      ) &&
      /\.(?:then|flatMap|thenMany)\s*\(/.test(async.demo.code)
    );
  }) ?? false;
}

function hasReachableLeaseOverwrite(runtime, async) {
  const eventLinked = crudFlows(runtime, async).some((flow) => {
    const overwriteLease = flow.overwrite.leaseId?.value;
    return runtime.facts.operations.some((event) =>
      event.operation === "acquire-lease" &&
      event.async === async &&
      event.sequence < flow.overwrite.sequence &&
      sameBlobLifecycle(event, flow.overwrite) &&
      pathsCompatible(event, flow.overwrite) &&
      overwriteLease &&
      event.leaseId === overwriteLease
    );
  });
  if (eventLinked) return true;

  const methods = Array.from(runtime.methodsByName.values()).flat()
    .filter((method) => runtime.facts.reachableMethods.has(method.id))
    .filter((method) => method.name ===
      (async ? "overwriteWithLeaseAsync" : "overwriteWithLease"));
  const hasLeaseSource = methods.some((method) =>
    /\.\s*acquireLease\s*\(/.test(method.code) &&
    /\.setRequestConditions\s*\([\s\S]*?\.setLeaseId\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(
      method.code,
    ),
  );
  const hasOverwrite = crudFlows(runtime, async).some((flow) =>
    ["string", "lease-id"].includes(flow.overwrite.leaseId?.kind),
  );
  return hasLeaseSource && hasOverwrite;
}

function catchUsesStatusCode(caught) {
  const parameter = /\b([A-Za-z_$][\w$]*)\s*$/.exec(caught.header)?.[1];
  return Boolean(parameter && new RegExp(
    `\\b${escapeRegExp(parameter)}\\s*\\.\\s*getStatusCode\\s*\\(`,
  ).test(caught.bodyCode));
}

function handlesBlobStorageException(runtime) {
  const globallySafe = Array.from(runtime.facts.protections.values())
    .filter((protection) => runtime.facts.reachableMethods.has(protection.methodId) &&
      protection.reachable)
    .every((protection) =>
      protection.catches.every((caught) => catchAlwaysPreserves(caught)));
  if (!globallySafe) return false;
  const relevant = runtime.facts.operations.filter((event) => [
    "ensure-container", "upload", "list", "download",
    "delete-blob", "delete-container",
  ].includes(event.operation));
  return relevant.length > 0 && relevant.every((event) => {
    if (!event.protection) return false;
    const protection = runtime.facts.protections.get(event.protection);
    const target = protection?.catches.find((caught) => caught.target);
    return Boolean(
      target &&
      meaningfulCatch(target) &&
      catchAlwaysPreserves(target) &&
      catchUsesStatusCode(target),
    );
  });
}

const rules = {
  "prompt/sdk-dependencies": ({ build }) =>
    hasCompatibleDependencies(build),
  "prompt/secure-configuration": ({ runtime, source }) =>
    !hasForbiddenAuthenticationSource(source) &&
    runtime.facts.serviceClients.some(
      (client) => !client.async && secureServiceClient(client),
    ) &&
    runtime.facts.serviceClients.some(
      (client) => client.async && secureServiceClient(client),
    ),
  "prompt/retry-timeout-logging": ({ runtime }) =>
    runtime.facts.serviceClients.some(
      (client) => !client.async && configuredRetryAndLogging(client),
    ) &&
    runtime.facts.serviceClients.some(
      (client) => client.async && configuredRetryAndLogging(client),
    ),
  "prompt/sync-service-operations": ({ runtime }) =>
    crudFlows(runtime, false).length > 0 ||
    Boolean(structuralCrudFlow(runtime, false)),
  "prompt/async-service-operations": ({ runtime }) =>
    crudFlows(runtime, true).length > 0 ||
    Boolean(structuralCrudFlow(runtime, true)),
  "prompt/parallel-upload-and-tags": ({ runtime }) => {
    const sync = crudFlows(runtime, false).some((flow) =>
      flow.upload.parallelTransfer && flow.upload.tags,
    );
    const async = crudFlows(runtime, true).some((flow) =>
      flow.upload.parallelTransfer && flow.upload.tags,
    );
    return (
      (sync && async) ||
      (
        structuralParallelUpload(structuralCrudFlow(runtime, false)) &&
        structuralParallelUpload(structuralCrudFlow(runtime, true))
      )
    );
  },
  "prompt/lease-overwrite": ({ runtime }) =>
    (
      hasReachableLeaseOverwrite(runtime, false) &&
      hasReachableLeaseOverwrite(runtime, true)
    ) ||
    (
      structuralLeaseOverwrite(structuralCrudFlow(runtime, false)) &&
      structuralLeaseOverwrite(structuralCrudFlow(runtime, true))
    ),
  "prompt/reactive-demo-flow": ({ runtime }) => {
    const firstSync = crudFlows(runtime, false)
      .sort((left, right) => flowStart(left) - flowStart(right))[0];
    const firstAsync = crudFlows(runtime, true)
      .sort((left, right) => flowStart(left) - flowStart(right))[0];
    return Boolean(
      firstSync &&
      firstAsync &&
      flowStart(firstSync) < flowStart(firstAsync) &&
      flowEnd(firstSync) < flowStart(firstAsync) &&
      hasReactiveChain(runtime),
    ) || structuralReactiveDemo(
      runtime,
      structuralCrudFlow(runtime, false),
      structuralCrudFlow(runtime, true),
    );
  },
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const hasSource = Array.isArray(workspace.sourceFiles)
    ? workspace.sourceFiles.length > 0
    : Boolean(workspace.source?.trim());
  if (!hasSource) return false;
  const runtime = name === "prompt/sdk-dependencies" ? null : flowFacts(workspace);
  return rule({ ...workspace, build: workspace.build ?? "", runtime });
}

export function ruleNames() {
  return Object.keys(rules);
}
