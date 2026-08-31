const EXPECTED_REGION = "eastus";
const EXPECTED_TAG_KEY = "environment";
const EXPECTED_TAG_VALUE = "development";

const SDK_TYPES = {
  credentialBuilder: {
    name: "DefaultAzureCredentialBuilder",
    packageName: "com.azure.identity",
  },
  defaultAzureCredential: {
    name: "DefaultAzureCredential",
    packageName: "com.azure.identity",
  },
  azureProfile: {
    name: "AzureProfile",
    packageName: "com.azure.core.management.profile",
  },
  azureEnvironment: {
    name: "AzureEnvironment",
    packageName: "com.azure.core.management",
  },
  azureResourceManager: {
    name: "AzureResourceManager",
    packageName: "com.azure.resourcemanager",
  },
  resourceGroup: {
    name: "ResourceGroup",
    packageName: "com.azure.resourcemanager.resources.models",
  },
  accepted: {
    name: "Accepted",
    packageName: "com.azure.resourcemanager.resources.fluentcore.model",
  },
  syncPoller: {
    name: "SyncPoller",
    packageName: "com.azure.core.util.polling",
  },
  managementException: {
    name: "ManagementException",
    packageName: "com.azure.core.management.exception",
  },
  httpResponseException: {
    name: "HttpResponseException",
    packageName: "com.azure.core.exception",
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
      ["compile", "runtime"].includes(dependency.scope),
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
      !["implementation", "api", "runtimeOnly"].includes(tokens[index].value)
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

function mavenUsesJava17(project) {
  const properties = child(project, "properties");
  const values = new Map(
    (properties?.children ?? []).map((property) => [
      property.name,
      property.text.trim(),
    ]),
  );
  const release = values.get("maven.compiler.release");
  if (release === "17") return true;
  return (
    values.get("maven.compiler.source") === "17" &&
    values.get("maven.compiler.target") === "17"
  );
}

function gradleUsesJava17(build) {
  const code = build
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\r\n]*/g, " ");
  return (
    /\bsourceCompatibility\s*=\s*(?:JavaVersion\s*\.\s*VERSION_17|["']17["']|17)\b/.test(
      code,
    ) ||
    /\btargetCompatibility\s*=\s*(?:JavaVersion\s*\.\s*VERSION_17|["']17["']|17)\b/.test(
      code,
    ) ||
    /\blanguageVersion\s*(?:\.set\s*)?\(\s*JavaLanguageVersion\s*\.\s*of\s*\(\s*17\s*\)\s*\)/.test(
      code,
    ) ||
    /\boptions\s*\.\s*release\s*(?:\.set\s*)?\(\s*17\s*\)/.test(code)
  );
}

function hasRequiredManifest(build) {
  const expected = [
    "com.azure:azure-identity:1.18.5",
    "com.azure.resourcemanager:azure-resourcemanager:2.63.0",
  ];
  const document = xmlTree(build.replace(/<!--[\s\S]*?-->/g, " "));
  const mavenProjects = document.children.filter(
    (candidate) => candidate.name === "project",
  );
  const maven = mavenProjects.some((project) => {
    const dependencies = activeMavenDependencies(project);
    return mavenUsesJava17(project) && expected.every((coordinate) => {
      const [group, artifact, version] = coordinate.split(":");
      return dependencies.some(
        (dependency) =>
          dependency.group === group &&
          dependency.artifact === artifact &&
          dependency.version === version,
      );
    });
  });
  const gradle = activeGradleDependencies(build);
  return (
    maven ||
    (gradleUsesJava17(build) &&
      expected.every((coordinate) => gradle.includes(coordinate)))
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
      const target = [types.managementException, types.httpResponseException]
        .some((type) =>
          new RegExp(
            `(?:^|[\\s|])${type.pattern}(?:\\s|[|])`,
          ).test(` ${header} `)
        );
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
  const next = boolean !== null
    ? { kind: "boolean", value: boolean }
    : string ?? iterable;
  const primitiveDeclaration =
    /\b(?:boolean|Boolean|String|Iterable|Collection|List|Set)\b|\[\s*\]/.test(
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
    catchAlwaysPreserves(caught)
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
    nextInvocationId: 0,
    operations: [],
    outputs: [],
    outputCalls: [],
    waits: [],
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
          iterable?.kind === "resource-group-list" &&
          declarationTypeMatches(
            enhancedFor[1],
            runtime.types.resourceGroup,
          )
        ) {
          scope.declare(enhancedFor[2], {
            kind: "resource-group",
            origin: "list",
            clientId: iterable.clientId,
            listSequence: iterable.sequence,
            operationSequence: iterable.sequence,
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
      if (
        value?.kind === "azure-resource-manager" &&
        !declarationTypeMatches(
          assignment.declaredType,
          runtime.types.azureResourceManager,
        )
      ) {
        value = null;
      }
      if (
        value?.kind === "credential" &&
        !declarationTypeMatches(
          assignment.declaredType,
          runtime.types.defaultAzureCredential,
        )
      ) {
        value = null;
      }
      if (
        value?.kind === "azure-profile" &&
        !declarationTypeMatches(
          assignment.declaredType,
          runtime.types.azureProfile,
        )
      ) {
        value = null;
      }
      if (
        value?.kind === "resource-group" &&
        !declarationTypeMatches(
          assignment.declaredType,
          runtime.types.resourceGroup,
        )
      ) {
        value = null;
      }
      if (
        value?.kind === "accepted" &&
        !declarationTypeMatches(
          assignment.declaredType,
          runtime.types.accepted,
        )
      ) {
        value = null;
      }
      if (value?.kind === "poller") {
        value = {
          ...value,
          typed:
            value.typed &&
            declarationTypeMatches(
              assignment.declaredType,
              runtime.types.syncPoller,
            ),
        };
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
  const output = [
    /^(?:java\s*\.\s*lang\s*\.\s*)?System\s*\.\s*(?:out|err)\s*\.\s*(?:print|println|printf|format)\s*\(/,
    /^(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*\s*\.\s*(?:trace|debug|info|warn|warning|error|fatal|log)\s*\(/,
  ].map((pattern) => pattern.exec(statement.trim())).find(Boolean);
  if (output) {
    const open = statement.indexOf("(", output.index);
    const close = matchingIndex(statement, open);
    const argumentsList = splitTopLevel(statement.slice(open + 1, close));
    const argumentValues = argumentsList.map((argument) =>
      evaluateExpression(argument, scope, runtime, context)
    );
    const values = argumentValues
      .flatMap(javaSemanticParts)
      .filter(Boolean);
    const path = mergePaths(
      context.path,
      ...values.map((value) => value.path),
    );
    if (!path) return null;
    const sequence = ++runtime.facts.sequence;
    runtime.facts.outputCalls.push({
      arguments: argumentValues,
      values,
      sequence,
      path,
    });
    for (const value of values) {
      if (
        [
          "resource-group",
          "resource-group-property",
          "env",
          "string",
        ].includes(value.kind)
      ) {
        runtime.facts.outputs.push({ ...value, sequence, path });
      }
    }
    return null;
  }
  return evaluateExpression(statement, scope, runtime, context);
}

function javaSemanticParts(value) {
  return value?.kind === "composite"
    ? value.parts.flatMap(javaSemanticParts)
    : value
      ? [value]
      : [];
}

function combineJavaValues(values) {
  if (values.some((value) => !value)) return null;
  const parts = values.flatMap(javaSemanticParts);
  const path = mergePaths(...parts.map((part) => part.path));
  if (!path) return null;
  if (parts.every((part) => part.kind === "string")) {
    return {
      kind: "string",
      value: parts.map((part) => part.value).join(""),
      path,
    };
  }
  return { kind: "composite", parts, path };
}

function javaFormatArgumentIndexes(value) {
  const indexes = new Set();
  let sequential = 0;
  let previous = -1;
  for (const match of value.matchAll(
    /%(?:(\d+)\$)?([-#+ 0,(<]*)\d*(?:\.\d+)?[bBhHsScCdoxXeEfgGaAtT]/g,
  )) {
    const index = match[1]
      ? Number(match[1]) - 1
      : match[2].includes("<") && previous >= 0
        ? previous
        : sequential++;
    indexes.add(index);
    previous = index;
  }
  for (const match of value.matchAll(/\{(\d*)\}/g)) {
    indexes.add(match[1] ? Number(match[1]) : sequential++);
  }
  return indexes;
}

function combineJavaFormat(template, argumentsList) {
  if (template?.kind !== "string") return template;
  const referenced = Array.from(javaFormatArgumentIndexes(template.value))
    .map((index) => argumentsList[index])
    .filter(Boolean);
  return referenced.length > 0
    ? combineJavaValues([template, ...referenced])
    : template;
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

function legacyKeyVaultExpression(expression, scope, runtime, context) {
  const value = unwrapParentheses(expression.trim());
  if (!value) {
    return null;
  }

  const ternary = topLevelJavaTernary(value);
  if (ternary) {
    const condition = javaExpressionBoolean(ternary.condition, scope);
    if (condition === true) {
      return evaluateExpression(
        ternary.consequent,
        scope,
        runtime,
        context,
      );
    }
    if (condition === false) {
      return evaluateExpression(
        ternary.alternate,
        scope,
        runtime,
        context,
      );
    }
    const key =
      `${context.method?.id ?? "root"}:${context.position}:ternary`;
    const consequent = evaluateExpression(
      ternary.consequent,
      scope,
      runtime,
      javaExpressionPath(context, key, true),
    );
    const alternate = evaluateExpression(
      ternary.alternate,
      scope,
      runtime,
      javaExpressionPath(context, key, false),
    );
    return JSON.stringify(consequent) === JSON.stringify(alternate)
      ? consequent
      : null;
  }

  for (const operator of ["||", "&&"]) {
    const operatorIndex = topLevelJavaOperator(value, operator);
    if (operatorIndex === -1) continue;
    const leftText = value.slice(0, operatorIndex);
    const rightText = value.slice(operatorIndex + 2);
    let leftBoolean = javaExpressionBoolean(leftText, scope);
    const left = evaluateExpression(leftText, scope, runtime, context);
    if (leftBoolean === null && left?.kind === "boolean") {
      leftBoolean = left.value;
    }
    if (
      (operator === "&&" && leftBoolean === false) ||
      (operator === "||" && leftBoolean === true)
    ) {
      return left;
    }
    const rightContext = leftBoolean === null
      ? javaExpressionPath(
          context,
          `${context.method?.id ?? "root"}:${context.position}:short:${operatorIndex}`,
          operator === "&&",
        )
      : context;
    return evaluateExpression(rightText, scope, runtime, rightContext);
  }

  const additions = splitTopLevelAddition(value);
  if (additions.length > 0) {
    const parts = additions.map((part) =>
      evaluateExpression(part, scope, runtime, context)
    );
    return parts.every((part) => part?.kind === "string")
      ? {
          kind: "string",
          value: parts.map((part) => part.value).join(""),
        }
      : null;
  }

  const literal = literalValue(value);
  if (literal !== null) {
    return { kind: "string", value: literal };
  }
  if (/^(?:true|Boolean\s*\.\s*TRUE)$/.test(value)) {
    return { kind: "boolean", value: true };
  }
  if (/^(?:false|Boolean\s*\.\s*FALSE)$/.test(value)) {
    return { kind: "boolean", value: false };
  }
  if (/^(?:null|\d+(?:\.\d+)?)$/.test(value)) {
    return null;
  }
  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value);
  if (reference) {
    if (context.abstracts?.has(reference[1])) {
      const abstract = context.abstracts.get(reference[1]);
      if (abstract) return { ...abstract };
      const runtimeValue = scope.resolve(reference[1]);
      return ["boolean", "iterable", "string"].includes(runtimeValue?.kind)
        ? null
        : runtimeValue;
    }
    return scope.resolve(reference[1]);
  }

  const iterable = javaIterableValue(value, context.abstracts ?? new Map());
  if (iterable) return iterable;

  const keyVaultSecret = new RegExp(
    `^new\\s+${runtime.types.keyVaultSecret.pattern}\\s*\\(`,
  ).exec(value);
  if (keyVaultSecret) {
    const open = value.indexOf("(", keyVaultSecret.index);
    const close = matchingIndex(value, open);
    const argumentsList = splitTopLevel(value.slice(open + 1, close));
    const name = evaluateExpression(argumentsList[0] ?? "", scope, runtime, context);
    const secretValue = evaluateExpression(
      argumentsList[1] ?? "",
      scope,
      runtime,
      context,
    );
    return name?.kind === "string" && secretValue?.kind === "string"
      ? { kind: "key-vault-secret", name: name.value, value: secretValue.value }
      : null;
  }

  const credentialBuilder = new RegExp(
    `^new\\s+${runtime.types.credentialBuilder.pattern}\\s*\\(`,
  ).test(value);
  if (credentialBuilder) {
    return /\.build\s*\(\s*\)\s*$/.test(value)
      ? { kind: "credential", valid: true }
      : { kind: "credential-builder", valid: true };
  }
  const credentialBuild = callAt(value, "build");
  if (credentialBuild) {
    const builder = evaluateExpression(
      credentialBuild.receiver,
      scope,
      runtime,
      context,
    );
    if (builder?.kind === "credential-builder" && builder.valid) {
      return { kind: "credential", valid: true };
    }
  }

  const clientBuilder = new RegExp(
    `^new\\s+${runtime.types.secretClientBuilder.pattern}\\s*\\(`,
  ).test(value);
  if (clientBuilder) {
    const credentialCall = callAt(value, "credential");
    const credential = credentialCall
      ? evaluateExpression(
          credentialCall.arguments[0] ?? "",
          scope,
          runtime,
          context,
        )
      : null;
    if (/\.buildClient\s*\(\s*\)\s*$/.test(value)) {
      return credential?.kind === "credential" && credential.valid
        ? {
            kind: "client",
            valid: true,
            id: ++runtime.facts.nextClientId,
          }
        : null;
    }
    return { kind: "client-builder", valid: true, credential };
  }
  const buildClient = callAt(value, "buildClient");
  if (buildClient) {
    const builder = evaluateExpression(
      buildClient.receiver,
      scope,
      runtime,
      context,
    );
    if (
      builder?.kind === "client-builder" &&
      builder.valid &&
      builder.credential?.kind === "credential" &&
      builder.credential.valid
    ) {
      return {
        kind: "client",
        valid: true,
        id: ++runtime.facts.nextClientId,
      };
    }
  }

  const customConstruction =
    /^new\s+([A-Za-z_$][\w$]*)\s*\(/.exec(value);
  if (
    customConstruction &&
    runtime.methodsByName.has(customConstruction[1])
  ) {
    const open = value.indexOf("(", customConstruction.index);
    const close = matchingIndex(value, open);
    const constructor = (runtime.methodsByName.get(customConstruction[1]) ?? [])
      .find(
        (candidate) =>
          candidate.parameters.length ===
          splitTopLevel(value.slice(open + 1, close)).length,
      );
    const argumentsList = splitTopLevel(value.slice(open + 1, close)).map(
      (argument) => evaluateExpression(argument, scope, runtime, context),
    );
    if (constructor) {
      executeMethod(
        constructor,
        argumentsList,
        runtime,
        context.protection,
        context.path,
      );
    }
    const object = { kind: "object", className: customConstruction[1] };
    const suffix = value.slice(close + 1).trim();
    if (suffix) {
      return evaluateExpression(
        `constructed${suffix}`,
        {
          ...scope,
          resolve: (name) =>
            name === "constructed" ? object : scope.resolve(name),
        },
        runtime,
        context,
      );
    }
    return object;
  }

  for (const operation of [
    "setSecret",
    "getSecretWithResponse",
    "getSecret",
    "beginDeleteSecret",
    "purgeDeletedSecret",
    "waitForCompletion",
    "getValue",
  ]) {
    const call = callAt(value, operation);
    if (!call) {
      continue;
    }
    const receiver = evaluateExpression(call.receiver, scope, runtime, context);
    let result = null;

    if (
      ["setSecret", "getSecretWithResponse", "getSecret", "beginDeleteSecret", "purgeDeletedSecret"].includes(
        operation,
      ) &&
      receiver?.kind === "client" &&
      receiver.valid
    ) {
      const first = evaluateExpression(
        call.arguments[0] ?? "",
        scope,
        runtime,
        context,
      );
      if (operation === "setSecret") {
        const secret =
          first?.kind === "key-vault-secret"
            ? first
            : {
                kind: "key-vault-secret",
                name: first?.kind === "string" ? first.value : null,
                value:
                  evaluateExpression(
                    call.arguments[1] ?? "",
                    scope,
                    runtime,
                    context,
                  )?.value ?? null,
              };
        if (secret.name && secret.value) {
          const event = {
            operation: "set",
            clientId: receiver.id,
            name: secret.name,
            value: secret.value,
            sequence: ++runtime.facts.sequence,
            methodId: context.method?.id,
            position: context.position,
            protection: context.protection,
            path: context.path,
          };
          runtime.facts.operations.push(event);
          result = {
            kind: "key-vault-secret",
            name: secret.name,
            value: secret.value,
          };
        }
      } else if (
        (operation === "getSecret" || operation === "getSecretWithResponse") &&
        first?.kind === "string"
      ) {
        const event = {
          operation: "get",
          clientId: receiver.id,
          name: first.value,
          sequence: ++runtime.facts.sequence,
          methodId: context.method?.id,
          position: context.position,
          protection: context.protection,
          path: context.path,
        };
        runtime.facts.operations.push(event);
        result = {
          kind: operation === "getSecretWithResponse" ? "response" : "retrieved-secret",
          name: first.value,
          clientId: receiver.id,
          retrievalSequence: event.sequence,
          path: event.path,
        };
      } else if (
        operation === "beginDeleteSecret" &&
        first?.kind === "string"
      ) {
        const event = {
          operation: "delete",
          clientId: receiver.id,
          name: first.value,
          sequence: ++runtime.facts.sequence,
          methodId: context.method?.id,
          position: context.position,
          protection: context.protection,
          path: context.path,
        };
        runtime.facts.operations.push(event);
        result = {
          kind: "poller",
          typed: true,
          clientId: receiver.id,
          name: first.value,
          deleteSequence: event.sequence,
          path: event.path,
        };
      } else if (
        operation === "purgeDeletedSecret" &&
        first?.kind === "string"
      ) {
        const event = {
          operation: "purge",
          clientId: receiver.id,
          name: first.value,
          sequence: ++runtime.facts.sequence,
          methodId: context.method?.id,
          position: context.position,
          protection: context.protection,
          path: context.path,
        };
        runtime.facts.operations.push(event);
      }
    } else if (
      operation === "waitForCompletion" &&
      receiver?.kind === "poller" &&
      receiver.typed
    ) {
      const wait = {
        clientId: receiver.clientId,
        name: receiver.name,
        deleteSequence: receiver.deleteSequence,
        sequence: ++runtime.facts.sequence,
        path: mergePaths(receiver.path, context.path),
      };
      runtime.facts.waits.push(wait);
      result = { ...receiver, completed: true, waitSequence: wait.sequence };
    } else if (operation === "getValue") {
      if (receiver?.kind === "response") {
        result = { ...receiver, kind: "retrieved-secret" };
      } else if (receiver?.kind === "retrieved-secret") {
        result = { ...receiver, kind: "retrieved-value" };
      }
    }

    if (result && call.suffix) {
      return evaluateExpression(
        `result${call.suffix}`,
        {
          ...scope,
          resolve: (name) => (name === "result" ? result : scope.resolve(name)),
        },
        runtime,
        context,
      );
    }
    return result;
  }

  const call = methodCall(value);
  if (call) {
    const candidates = runtime.methodsByName.get(call.name) ?? [];
    const method =
      candidates.find(
        (candidate) => candidate.parameters.length === call.arguments.length,
      ) ?? candidates[0];
    if (method) {
      const argumentsList = call.arguments.map((argument) =>
        evaluateExpression(argument, scope, runtime, context),
      );
      return executeMethod(
        method,
        argumentsList,
        runtime,
        context.protection,
        context.path,
      );
    }
  }
  return null;
}

function sameAbstractValue(left, right) {
  return (
    left?.kind === right?.kind &&
    (left?.kind === "string"
      ? left.value === right.value
      : left?.kind === "env"
        ? left.name === right.name
        : false)
  );
}

function isResourceGroupName(value) {
  return value?.kind === "env" && value.name === "RESOURCE_GROUP_NAME";
}

function isSubscription(value) {
  return value?.kind === "env" && value.name === "AZURE_SUBSCRIPTION_ID";
}

function isRegion(value) {
  return (
    value?.kind === "string" && value.value.toLowerCase() === EXPECTED_REGION ||
    value?.kind === "env" && value.name === "AZURE_LOCATION"
  );
}

function evaluateExpression(expression, scope, runtime, context) {
  const value = unwrapParentheses(expression.trim());
  if (!value) return null;

  const ternary = topLevelJavaTernary(value);
  if (ternary) {
    const condition = javaExpressionBoolean(ternary.condition, scope);
    if (condition === true) {
      return evaluateExpression(ternary.consequent, scope, runtime, context);
    }
    if (condition === false) {
      return evaluateExpression(ternary.alternate, scope, runtime, context);
    }
    const key = `${context.method?.id ?? "root"}:${context.position}:ternary`;
    const consequent = evaluateExpression(
      ternary.consequent,
      scope,
      runtime,
      javaExpressionPath(context, key, true),
    );
    const alternate = evaluateExpression(
      ternary.alternate,
      scope,
      runtime,
      javaExpressionPath(context, key, false),
    );
    return JSON.stringify(consequent) === JSON.stringify(alternate)
      ? consequent
      : null;
  }

  for (const operator of ["||", "&&"]) {
    const operatorIndex = topLevelJavaOperator(value, operator);
    if (operatorIndex === -1) continue;
    const leftText = value.slice(0, operatorIndex);
    const rightText = value.slice(operatorIndex + 2);
    let leftBoolean = javaExpressionBoolean(leftText, scope);
    const left = evaluateExpression(leftText, scope, runtime, context);
    if (leftBoolean === null && left?.kind === "boolean") {
      leftBoolean = left.value;
    }
    if (
      operator === "&&" && leftBoolean === false ||
      operator === "||" && leftBoolean === true
    ) {
      return left;
    }
    const rightContext = leftBoolean === null
      ? javaExpressionPath(
          context,
          `${context.method?.id ?? "root"}:${context.position}:short:${operatorIndex}`,
          operator === "&&",
        )
      : context;
    return evaluateExpression(rightText, scope, runtime, rightContext);
  }

  const additions = splitTopLevelAddition(value);
  if (additions.length > 0) {
    const parts = additions.map((part) =>
      evaluateExpression(part, scope, runtime, context)
    );
    return combineJavaValues(parts);
  }

  const literal = literalValue(value);
  if (literal !== null) return { kind: "string", value: literal };
  if (/^(?:true|Boolean\s*\.\s*TRUE)$/.test(value)) {
    return { kind: "boolean", value: true };
  }
  if (/^(?:false|Boolean\s*\.\s*FALSE)$/.test(value)) {
    return { kind: "boolean", value: false };
  }
  if (/^(?:null|\d+(?:\.\d+)?)$/.test(value)) return null;

  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value);
  if (reference) {
    if (context.abstracts?.has(reference[1])) {
      const abstract = context.abstracts.get(reference[1]);
      if (abstract) return { ...abstract };
      const runtimeValue = scope.resolve(reference[1]);
      return ["boolean", "iterable", "string"].includes(runtimeValue?.kind)
        ? null
        : runtimeValue;
    }
    return scope.resolve(reference[1]);
  }

  const getenv =
    /^(?:java\s*\.\s*lang\s*\.\s*)?System\s*\.\s*getenv\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (getenv) {
    const name = evaluateExpression(getenv[1], scope, runtime, context);
    return name?.kind === "string"
      ? { kind: "env", name: name.value }
      : null;
  }

  const staticFormat =
    /^(?:(?:java\s*\.\s*lang\s*\.\s*)?String|(?:java\s*\.\s*text\s*\.\s*)?MessageFormat)\s*\.\s*format\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (staticFormat) {
    const argumentsList = splitTopLevel(staticFormat[1]).map((argument) =>
      evaluateExpression(argument, scope, runtime, context)
    );
    const templateIndex = argumentsList.findIndex(
      (argument) => argument?.kind === "string",
    );
    return templateIndex === -1
      ? null
      : combineJavaFormat(
          argumentsList[templateIndex],
          argumentsList.slice(templateIndex + 1),
        );
  }
  const formatted = callAt(value, "formatted");
  if (formatted && !formatted.suffix) {
    return combineJavaFormat(
      evaluateExpression(formatted.receiver, scope, runtime, context),
      formatted.arguments.map((argument) =>
        evaluateExpression(argument, scope, runtime, context)
      ),
    );
  }

  const azureEnvironment = new RegExp(
    `^${runtime.types.azureEnvironment.pattern}\\s*\\.\\s*AZURE$`,
  );
  if (azureEnvironment.test(value)) {
    return { kind: "azure-environment", valid: true };
  }

  const profileConstruction = new RegExp(
    `^new\\s+${runtime.types.azureProfile.pattern}\\s*\\(`,
  ).exec(value);
  if (profileConstruction) {
    const open = value.indexOf("(", profileConstruction.index);
    const close = matchingIndex(value, open);
    const environment = evaluateExpression(
      value.slice(open + 1, close),
      scope,
      runtime,
      context,
    );
    return environment?.kind === "azure-environment" && environment.valid
      ? { kind: "azure-profile", valid: true }
      : null;
  }

  const credentialBuilder = new RegExp(
    `^new\\s+${runtime.types.credentialBuilder.pattern}\\s*\\(`,
  ).test(value);
  if (credentialBuilder) {
    return /\.build\s*\(\s*\)\s*$/.test(value)
      ? { kind: "credential", valid: true }
      : { kind: "credential-builder", valid: true };
  }
  const credentialBuild = callAt(value, "build");
  if (credentialBuild) {
    const builder = evaluateExpression(
      credentialBuild.receiver,
      scope,
      runtime,
      context,
    );
    if (builder?.kind === "credential-builder" && builder.valid) {
      return { kind: "credential", valid: true };
    }
  }

  const authenticate = callAt(value, "authenticate");
  if (
    authenticate &&
    new RegExp(`^${runtime.types.azureResourceManager.pattern}$`).test(
      authenticate.receiver,
    )
  ) {
    const credential = evaluateExpression(
      authenticate.arguments[0] ?? "",
      scope,
      runtime,
      context,
    );
    const profile = evaluateExpression(
      authenticate.arguments[1] ?? "",
      scope,
      runtime,
      context,
    );
    const result =
      credential?.kind === "credential" &&
      credential.valid &&
      profile?.kind === "azure-profile" &&
      profile.valid
        ? { kind: "authenticated-manager", valid: true }
        : null;
    if (result && authenticate.suffix) {
      return evaluateExpression(
        `result${authenticate.suffix}`,
        {
          ...scope,
          resolve: (name) => name === "result"
            ? result
            : scope.resolve(name),
        },
        runtime,
        context,
      );
    }
    return result;
  }

  const withSubscription = callAt(value, "withSubscription");
  if (withSubscription) {
    const authenticated = evaluateExpression(
      withSubscription.receiver,
      scope,
      runtime,
      context,
    );
    const subscription = evaluateExpression(
      withSubscription.arguments[0] ?? "",
      scope,
      runtime,
      context,
    );
    const result =
      authenticated?.kind === "authenticated-manager" &&
      authenticated.valid &&
      isSubscription(subscription)
        ? {
            kind: "azure-resource-manager",
            valid: true,
            subscription,
            id: ++runtime.facts.nextClientId,
          }
        : null;
    if (result && withSubscription.suffix) {
      return evaluateExpression(
        `result${withSubscription.suffix}`,
        {
          ...scope,
          resolve: (name) => name === "result"
            ? result
            : scope.resolve(name),
        },
        runtime,
        context,
      );
    }
    return result;
  }

  for (const operation of [
    "resourceGroups",
    "define",
    "withRegion",
    "create",
    "list",
    "getByName",
    "update",
    "withTag",
    "apply",
    "deleteByName",
    "beginDeleteByName",
    "getSyncPoller",
    "waitForCompletion",
    "name",
    "id",
    "regionName",
    "tags",
  ]) {
    const call = callAt(value, operation);
    if (!call) continue;
    const receiver = evaluateExpression(call.receiver, scope, runtime, context);
    let result = null;

    if (
      operation === "resourceGroups" &&
      receiver?.kind === "azure-resource-manager" &&
      receiver.valid
    ) {
      result = {
        kind: "resource-groups",
        clientId: receiver.id,
        subscription: receiver.subscription,
      };
    } else if (
      operation === "define" &&
      receiver?.kind === "resource-groups"
    ) {
      const name = evaluateExpression(
        call.arguments[0] ?? "",
        scope,
        runtime,
        context,
      );
      if (isResourceGroupName(name)) {
        result = {
          kind: "resource-group-definition",
          clientId: receiver.clientId,
          name,
          path: context.path,
        };
      }
    } else if (
      operation === "withRegion" &&
      receiver?.kind === "resource-group-definition"
    ) {
      const region = evaluateExpression(
        call.arguments[0] ?? "",
        scope,
        runtime,
        context,
      );
      if (isRegion(region)) {
        receiver.region = region;
        result = receiver;
      }
    } else if (
      operation === "create" &&
      receiver?.kind === "resource-group-definition" &&
      isResourceGroupName(receiver.name) &&
      isRegion(receiver.region)
    ) {
      const event = {
        operation: "create",
        clientId: receiver.clientId,
        name: receiver.name,
        region: receiver.region,
        sequence: ++runtime.facts.sequence,
        protection: context.protection,
        path: mergePaths(receiver.path, context.path),
      };
      runtime.facts.operations.push(event);
      result = {
        kind: "resource-group",
        origin: "create",
        clientId: event.clientId,
        name: event.name,
        operationSequence: event.sequence,
        path: event.path,
      };
    } else if (
      operation === "list" &&
      receiver?.kind === "resource-groups"
    ) {
      const event = {
        operation: "list",
        clientId: receiver.clientId,
        sequence: ++runtime.facts.sequence,
        protection: context.protection,
        path: context.path,
      };
      runtime.facts.operations.push(event);
      result = {
        kind: "resource-group-list",
        clientId: event.clientId,
        sequence: event.sequence,
        path: event.path,
      };
    } else if (
      operation === "getByName" &&
      receiver?.kind === "resource-groups"
    ) {
      const name = evaluateExpression(
        call.arguments[0] ?? "",
        scope,
        runtime,
        context,
      );
      if (isResourceGroupName(name)) {
        const event = {
          operation: "get",
          clientId: receiver.clientId,
          name,
          sequence: ++runtime.facts.sequence,
          protection: context.protection,
          path: context.path,
        };
        runtime.facts.operations.push(event);
        result = {
          kind: "resource-group",
          origin: "get",
          clientId: event.clientId,
          name,
          operationSequence: event.sequence,
          path: event.path,
        };
      }
    } else if (
      operation === "update" &&
      receiver?.kind === "resource-group" &&
      ["get", "update"].includes(receiver.origin)
    ) {
      result = {
        kind: "resource-group-update",
        clientId: receiver.clientId,
        name: receiver.name,
        getSequence: receiver.operationSequence,
        path: mergePaths(receiver.path, context.path),
      };
    } else if (
      operation === "withTag" &&
      receiver?.kind === "resource-group-update"
    ) {
      const key = evaluateExpression(
        call.arguments[0] ?? "",
        scope,
        runtime,
        context,
      );
      const tagValue = evaluateExpression(
        call.arguments[1] ?? "",
        scope,
        runtime,
        context,
      );
      if (
        key?.kind === "string" &&
        key.value === EXPECTED_TAG_KEY &&
        tagValue?.kind === "string" &&
        tagValue.value === EXPECTED_TAG_VALUE
      ) {
        receiver.tagKey = key.value;
        receiver.tagValue = tagValue.value;
        result = receiver;
      }
    } else if (
      operation === "apply" &&
      receiver?.kind === "resource-group-update" &&
      receiver.tagKey === EXPECTED_TAG_KEY &&
      receiver.tagValue === EXPECTED_TAG_VALUE
    ) {
      const event = {
        operation: "update",
        clientId: receiver.clientId,
        name: receiver.name,
        key: receiver.tagKey,
        value: receiver.tagValue,
        getSequence: receiver.getSequence,
        sequence: ++runtime.facts.sequence,
        protection: context.protection,
        path: mergePaths(receiver.path, context.path),
      };
      runtime.facts.operations.push(event);
      result = {
        kind: "resource-group",
        origin: "update",
        clientId: event.clientId,
        name: event.name,
        operationSequence: event.sequence,
        path: event.path,
      };
    } else if (
      ["deleteByName", "beginDeleteByName"].includes(operation) &&
      receiver?.kind === "resource-groups"
    ) {
      const name = evaluateExpression(
        call.arguments[0] ?? "",
        scope,
        runtime,
        context,
      );
      if (isResourceGroupName(name)) {
        const event = {
          operation: "delete",
          mode: operation === "deleteByName" ? "blocking" : "poller",
          completed: operation === "deleteByName",
          clientId: receiver.clientId,
          name,
          sequence: ++runtime.facts.sequence,
          protection: context.protection,
          path: context.path,
        };
        runtime.facts.operations.push(event);
        result = operation === "deleteByName"
          ? { kind: "delete-completed", ...event }
          : {
              kind: "accepted",
              clientId: event.clientId,
              name,
              deleteSequence: event.sequence,
              path: event.path,
            };
      }
    } else if (
      operation === "getSyncPoller" &&
      receiver?.kind === "accepted"
    ) {
      result = {
        kind: "poller",
        typed: true,
        clientId: receiver.clientId,
        name: receiver.name,
        deleteSequence: receiver.deleteSequence,
        path: mergePaths(receiver.path, context.path),
      };
    } else if (
      operation === "waitForCompletion" &&
      receiver?.kind === "poller" &&
      receiver.typed
    ) {
      const event = {
        operation: "delete-completion",
        clientId: receiver.clientId,
        name: receiver.name,
        deleteSequence: receiver.deleteSequence,
        sequence: ++runtime.facts.sequence,
        path: mergePaths(receiver.path, context.path),
      };
      runtime.facts.operations.push(event);
      result = { kind: "delete-completed", ...event };
    } else if (
      ["name", "id", "regionName", "tags"].includes(operation) &&
      receiver?.kind === "resource-group"
    ) {
      result = {
        kind: "resource-group-property",
        property: operation,
        origin: receiver.origin,
        clientId: receiver.clientId,
        name: receiver.name,
        operationSequence:
          receiver.operationSequence ?? receiver.listSequence,
        path: receiver.path,
      };
    }

    if (result && call.suffix) {
      return evaluateExpression(
        `result${call.suffix}`,
        {
          ...scope,
          resolve: (name) => name === "result"
            ? result
            : scope.resolve(name),
        },
        runtime,
        context,
      );
    }
    return result;
  }

  const customConstruction =
    /^new\s+([A-Za-z_$][\w$]*)\s*\(/.exec(value);
  if (
    customConstruction &&
    runtime.methodsByName.has(customConstruction[1])
  ) {
    const open = value.indexOf("(", customConstruction.index);
    const close = matchingIndex(value, open);
    const constructor = (runtime.methodsByName.get(customConstruction[1]) ?? [])
      .find(
        (candidate) =>
          candidate.parameters.length ===
          splitTopLevel(value.slice(open + 1, close)).length,
      );
    const argumentsList = splitTopLevel(value.slice(open + 1, close)).map(
      (argument) => evaluateExpression(argument, scope, runtime, context),
    );
    if (constructor) {
      executeMethod(
        constructor,
        argumentsList,
        runtime,
        context.protection,
        context.path,
      );
    }
    const object = { kind: "object", className: customConstruction[1] };
    const suffix = value.slice(close + 1).trim();
    if (suffix) {
      return evaluateExpression(
        `constructed${suffix}`,
        {
          ...scope,
          resolve: (name) => name === "constructed"
            ? object
            : scope.resolve(name),
        },
        runtime,
        context,
      );
    }
    return object;
  }

  const call = methodCall(value);
  if (call) {
    const candidates = runtime.methodsByName.get(call.name) ?? [];
    const method =
      candidates.find(
        (candidate) => candidate.parameters.length === call.arguments.length,
      ) ?? candidates[0];
    if (method) {
      const argumentsList = call.arguments.map((argument) =>
        evaluateExpression(argument, scope, runtime, context)
      );
      return executeMethod(
        method,
        argumentsList,
        runtime,
        context.protection,
        context.path,
      );
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

function exactOperation(runtime, operation, name, value) {
  return runtime.facts.operations.find(
    (event) =>
      event.operation === operation &&
      event.name === name &&
      (value === undefined || event.value === value),
  );
}

function createEvent(runtime) {
  return runtime.facts.operations.find(
    (event) =>
      event.operation === "set" &&
      event.name === EXPECTED_SECRET_NAME &&
      event.value === EXPECTED_INITIAL_VALUE,
  );
}

function readFlows(runtime) {
  const creates = runtime.facts.operations.filter(
    (event) =>
      event.operation === "set" &&
      event.name === EXPECTED_SECRET_NAME &&
      event.value === EXPECTED_INITIAL_VALUE,
  );
  return creates.flatMap((created) =>
    runtime.facts.outputs
      .filter(
        (output) =>
          output.name === EXPECTED_SECRET_NAME &&
          output.clientId === created.clientId &&
          output.retrievalSequence > created.sequence &&
          output.sequence > output.retrievalSequence &&
          pathsCompatible(created, output),
      )
      .map((output) => ({ created, output })),
  );
}

function readOutput(runtime) {
  return readFlows(runtime)[0]?.output ?? null;
}

function updateFlows(runtime) {
  return readFlows(runtime).flatMap((flow) =>
    runtime.facts.operations
      .filter(
        (event) =>
          event.operation === "set" &&
          event.clientId === flow.output.clientId &&
          event.name === EXPECTED_SECRET_NAME &&
          event.value === EXPECTED_UPDATED_VALUE &&
          event.sequence > flow.output.sequence &&
          pathsCompatible(flow.created, flow.output, event),
      )
      .map((updated) => ({ ...flow, updated })),
  );
}

function updateEvent(runtime) {
  return updateFlows(runtime)[0]?.updated ?? null;
}

function deleteFlows(runtime) {
  return updateFlows(runtime).flatMap((flow) =>
    runtime.facts.operations
      .filter(
        (event) =>
          event.operation === "delete" &&
          event.clientId === flow.updated.clientId &&
          event.name === EXPECTED_SECRET_NAME &&
          event.sequence > flow.updated.sequence &&
          pathsCompatible(
            flow.created,
            flow.output,
            flow.updated,
            event,
          ),
      )
      .map((deleted) => ({ ...flow, deleted })),
  );
}

function deleteEvent(runtime) {
  return deleteFlows(runtime)[0]?.deleted ?? null;
}

function hasCompletedPurge(runtime) {
  return deleteFlows(runtime).some((flow) =>
    runtime.facts.waits.some(
      (waited) =>
        waited.clientId === flow.deleted.clientId &&
        waited.name === flow.deleted.name &&
        waited.deleteSequence === flow.deleted.sequence &&
        waited.sequence > flow.deleted.sequence &&
        pathsCompatible(
          flow.created,
          flow.output,
          flow.updated,
          flow.deleted,
          waited,
        ) &&
        runtime.facts.operations.some(
          (event) =>
            event.operation === "purge" &&
            event.clientId === flow.deleted.clientId &&
            event.name === flow.deleted.name &&
            event.sequence > waited.sequence &&
            pathsCompatible(
              flow.created,
              flow.output,
              flow.updated,
              flow.deleted,
              waited,
              event,
            ),
        ),
    ),
  );
}

function handlesHttpResponseException(runtime) {
  const globallySafe = Array.from(runtime.facts.protections.values())
    .filter((protection) =>
      runtime.facts.reachableMethods.has(protection.methodId) &&
      protection.reachable,
    )
    .every((protection) =>
      protection.catches.every((caught) => catchAlwaysPreserves(caught)),
    );
  if (!globallySafe) return false;
  const relevantOperations = runtime.facts.operations.filter((event) =>
    ["create", "list", "get", "update", "delete"].includes(event.operation),
  );
  for (const event of relevantOperations) {
    if (!event.protection) {
      continue;
    }
    const protection = runtime.facts.protections.get(event.protection);
    const target = protection?.catches.find((caught) => caught.target);
    if (
      target &&
      meaningfulCatch(target)
    ) {
      return true;
    }
  }
  return false;
}

function createFlows(runtime) {
  return runtime.facts.operations
    .filter(
      (event) =>
        event.operation === "create" &&
        isResourceGroupName(event.name) &&
        isRegion(event.region),
    )
    .map((created) => ({ created }));
}

function listFlows(runtime) {
  return createFlows(runtime).flatMap((flow) =>
    runtime.facts.operations
      .filter(
        (listed) =>
          listed.operation === "list" &&
          listed.clientId === flow.created.clientId &&
          listed.sequence > flow.created.sequence &&
          pathsCompatible(flow.created, listed),
      )
      .flatMap((listed) =>
        runtime.facts.outputs
          .filter(
            (output) =>
              output.origin === "list" &&
              output.clientId === listed.clientId &&
              output.operationSequence === listed.sequence &&
              output.sequence > listed.sequence &&
              pathsCompatible(flow.created, listed, output),
          )
          .map((listOutput) => ({ ...flow, listed, listOutput })),
      ),
  );
}

function getFlows(runtime) {
  return listFlows(runtime).flatMap((flow) =>
    runtime.facts.operations
      .filter(
        (retrieved) =>
          retrieved.operation === "get" &&
          retrieved.clientId === flow.created.clientId &&
          isResourceGroupName(retrieved.name) &&
          retrieved.sequence > flow.listOutput.sequence &&
          pathsCompatible(
            flow.created,
            flow.listed,
            flow.listOutput,
            retrieved,
          ),
      )
      .flatMap((retrieved) =>
        runtime.facts.outputs
          .filter(
            (output) =>
              output.origin === "get" &&
              output.clientId === retrieved.clientId &&
              output.operationSequence === retrieved.sequence &&
              output.sequence > retrieved.sequence &&
              pathsCompatible(
                flow.created,
                flow.listed,
                flow.listOutput,
                retrieved,
                output,
              ),
          )
          .map((getOutput) => ({
            ...flow,
            retrieved,
            getOutput,
          })),
      ),
  );
}

function updateFlowsForResourceGroup(runtime) {
  return getFlows(runtime).flatMap((flow) =>
    runtime.facts.operations
      .filter(
        (updated) =>
          updated.operation === "update" &&
          updated.clientId === flow.created.clientId &&
          isResourceGroupName(updated.name) &&
          updated.key === EXPECTED_TAG_KEY &&
          updated.value === EXPECTED_TAG_VALUE &&
          updated.getSequence === flow.retrieved.sequence &&
          updated.sequence > flow.getOutput.sequence &&
          pathsCompatible(
            flow.created,
            flow.listed,
            flow.listOutput,
            flow.retrieved,
            flow.getOutput,
            updated,
          ),
      )
      .flatMap((updated) =>
        runtime.facts.outputs
          .filter(
            (output) =>
              output.origin === "update" &&
              output.clientId === updated.clientId &&
              output.operationSequence === updated.sequence &&
              output.sequence > updated.sequence &&
              pathsCompatible(
                flow.created,
                flow.listed,
                flow.listOutput,
                flow.retrieved,
                flow.getOutput,
                updated,
                output,
              ),
          )
          .map((updateOutput) => ({
            ...flow,
            updated,
            updateOutput,
          })),
      ),
  );
}

function deleteFlowsForResourceGroup(runtime) {
  return updateFlowsForResourceGroup(runtime).flatMap((flow) =>
    runtime.facts.operations
      .filter(
        (deleted) =>
          deleted.operation === "delete" &&
          deleted.clientId === flow.created.clientId &&
          isResourceGroupName(deleted.name) &&
          deleted.sequence > flow.updateOutput.sequence &&
          pathsCompatible(
            flow.created,
            flow.listed,
            flow.listOutput,
            flow.retrieved,
            flow.getOutput,
            flow.updated,
            flow.updateOutput,
            deleted,
          ),
      )
      .flatMap((deleted) => {
        if (deleted.completed) {
          return [{ ...flow, deleted, completed: deleted }];
        }
        return runtime.facts.operations
          .filter(
            (completed) =>
              completed.operation === "delete-completion" &&
              completed.clientId === deleted.clientId &&
              sameAbstractValue(completed.name, deleted.name) &&
              completed.deleteSequence === deleted.sequence &&
              completed.sequence > deleted.sequence &&
              pathsCompatible(
                flow.created,
                flow.listed,
                flow.listOutput,
                flow.retrieved,
                flow.getOutput,
                flow.updated,
                flow.updateOutput,
                deleted,
                completed,
              ),
          )
          .map((completed) => ({ ...flow, deleted, completed }));
      }),
  );
}

function hasDeleteConfirmation(runtime) {
  return deleteFlowsForResourceGroup(runtime).some((flow) => {
    return runtime.facts.outputCalls.some(
      (output) => {
        if (
          output.sequence <= flow.completed.sequence ||
          !pathsCompatible(flow.completed, output)
        ) {
          return false;
        }
        const argumentParts = output.arguments.map(javaSemanticParts);
        const combinedArgument = argumentParts.some(
          (parts) =>
            parts.some((value) => isResourceGroupName(value)) &&
            parts.some(
              (value) =>
                value.kind === "string" &&
                /\bdelet(?:e|ed|ion)\b/i.test(value.value),
            ),
        );
        const parameterized = argumentParts.some(
          (parts, index) =>
            parts.some(
              (value) =>
                value.kind === "string" &&
                /\bdelet(?:e|ed|ion)\b/i.test(value.value) &&
                Array.from(javaFormatArgumentIndexes(value.value)).some(
                  (argumentIndex) =>
                    argumentParts[index + argumentIndex + 1]?.some(
                      (argument) => isResourceGroupName(argument),
                    ),
                ),
            ),
        );
        return combinedArgument || parameterized;
      },
    );
  });
}

const rules = {
  "prompt/source-manifest": ({ build }) => hasRequiredManifest(build),
  "prompt/authentication": ({ runtime }) =>
    runtime.facts.nextClientId > 0,
  "prompt/create-resource-group": ({ runtime }) =>
    createFlows(runtime).length > 0,
  "prompt/list-resource-groups": ({ runtime }) =>
    listFlows(runtime).length > 0,
  "prompt/get-resource-group": ({ runtime }) =>
    getFlows(runtime).length > 0,
  "prompt/update-resource-group": ({ runtime }) =>
    updateFlowsForResourceGroup(runtime).length > 0,
  "prompt/delete-resource-group": ({ runtime }) =>
    deleteFlowsForResourceGroup(runtime).length > 0,
  "prompt/delete-confirmation": ({ runtime }) =>
    hasDeleteConfirmation(runtime),
  "prompt/exception-handling": ({ runtime }) =>
    handlesHttpResponseException(runtime),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }
  const hasSource = Array.isArray(workspace.sourceFiles)
    ? workspace.sourceFiles.length > 0
    : Boolean(workspace.source?.trim());
  if (!hasSource) {
    return false;
  }

  const runtime =
    name === "prompt/source-manifest" ? null : flowFacts(workspace);
  return rule({
    ...workspace,
    build: workspace.build ?? "",
    runtime,
  });
}

export function ruleNames() {
  return Object.keys(rules);
}
