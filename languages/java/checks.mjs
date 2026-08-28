import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

function collectJavaFiles(root) {
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".java"))
    .map((entry) => join(root, entry.name));
  const sourceRoot = join(root, "src", "main", "java");
  if (!existsSync(sourceRoot)) {
    return files;
  }

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.name.endsWith(".java")) {
        files.push(path);
      }
    }
  };
  visit(sourceRoot);
  return files;
}

export function loadJavaWorkspace(root) {
  const sourceFiles = collectJavaFiles(root);
  const buildFiles = ["pom.xml", "build.gradle", "build.gradle.kts"]
    .map((name) => join(root, name))
    .filter(existsSync);
  const buildManifests = buildFiles.map((path) => ({
    name: basename(path),
    content: readFileSync(path, "utf8"),
  }));

  return {
    sourceFiles,
    buildFiles,
    source: sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
    buildManifests,
    build: buildManifests.map(({ content }) => content).join("\n"),
  };
}

function manifests({ buildFiles = [], buildManifests, build = "" }) {
  if (Array.isArray(buildManifests)) {
    return buildManifests.map((manifest) => ({
      name: basename(manifest.name ?? manifest.path ?? ""),
      content: manifest.content ?? "",
    }));
  }
  if (buildFiles.length <= 1) {
    return [{
      name: basename(buildFiles[0] ?? "pom.xml"),
      content: build,
    }];
  }
  return [];
}

function stripXmlSection(xml, name) {
  return xml.replace(
    new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, "gi"),
    " ",
  );
}

function xmlValue(xml, name) {
  return new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i")
    .exec(xml)?.[1].trim() ?? "";
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

function java17ProfileIsActive(profile) {
  const activation = xmlValue(profile, "activation");
  if (!activation) return false;
  const predicates = [];
  const activeByDefault = xmlValue(activation, "activeByDefault");
  if (activeByDefault) {
    predicates.push(/^true$/i.test(activeByDefault));
  }
  const jdk = xmlValue(activation, "jdk");
  if (jdk) {
    predicates.push(jdkActivationMatchesJava17(jdk));
  }
  if (/<(?:property|os|file)\b/i.test(activation)) {
    predicates.push(false);
  }
  return predicates.length > 0 && predicates.every(Boolean);
}

function mavenDependencies(content) {
  const xml = content.replace(/<!--[\s\S]*?-->/g, " ");
  if (
    !/^\s*<project\b[\s\S]*<\/project>\s*$/i.test(xml) ||
    (xml.match(/<project(?:\s|>)/gi) ?? []).length !== 1
  ) {
    return null;
  }
  const packaging = xmlValue(xml, "packaging") || "jar";
  if (!["jar", "war", "ear"].includes(packaging)) return [];

  const profiles = Array.from(
    xml.matchAll(/<profile\b[^>]*>([\s\S]*?)<\/profile>/gi),
    (match) => match[1],
  );
  let active = stripXmlSection(xml, "profiles");
  for (const profile of profiles.filter(java17ProfileIsActive)) {
    active += `\n${profile}`;
  }
  active = stripXmlSection(
    stripXmlSection(active, "dependencyManagement"),
    "build",
  );

  const properties = new Map();
  for (const block of active.matchAll(
    /<properties\b[^>]*>([\s\S]*?)<\/properties>/gi,
  )) {
    for (const property of block[1].matchAll(
      /<([A-Za-z_][\w.-]*)\b[^>]*>([^<]*)<\/\1>/g,
    )) {
      properties.set(property[1], property[2].trim());
    }
  }
  const resolve = (value) => {
    const property = /^\$\{([^}]+)\}$/.exec(value)?.[1];
    return property ? properties.get(property) ?? "" : value;
  };

  return Array.from(
    active.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi),
    (match) => ({
      group: xmlValue(match[1], "groupId"),
      artifact: xmlValue(match[1], "artifactId"),
      version: resolve(xmlValue(match[1], "version")),
      scope: xmlValue(match[1], "scope") || "compile",
    }),
  ).filter(({ scope }) => ["compile", "runtime"].includes(scope));
}

function maskGradleComments(content) {
  let result = "";
  let state = "code";
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        result += "\n";
        state = "code";
      } else {
        result += " ";
      }
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
    } else if (state === "string") {
      result += character;
      if (character === "\\") {
        result += next ?? "";
        index += 1;
      } else if (character === '"') {
        state = "code";
      }
    } else if (state === "single-string") {
      result += character;
      if (character === "\\") {
        result += next ?? "";
        index += 1;
      } else if (character === "'") {
        state = "code";
      }
    } else if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else {
      result += character;
      if (character === '"') state = "string";
      if (character === "'") state = "single-string";
    }
  }
  return result;
}

function matchingBrace(content, open) {
  let depth = 0;
  let quote = "";
  for (let index = open; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}" && --depth === 0) {
      return index;
    }
  }
  return -1;
}

function maskInactiveGradle(content) {
  const result = [...content];
  for (const match of content.matchAll(/\bif\s*\(\s*false\s*\)\s*\{/g)) {
    const open = content.indexOf("{", match.index);
    const close = matchingBrace(content, open);
    if (close < 0) continue;
    for (let index = match.index; index <= close; index += 1) {
      if (result[index] !== "\n") result[index] = " ";
    }
  }
  for (const match of content.matchAll(/\bif\s*\(\s*true\s*\)\s*\{/g)) {
    const open = content.indexOf("{", match.index);
    const close = matchingBrace(content, open);
    if (close < 0) continue;
    const suffix = content.slice(close + 1);
    const elseMatch = /^\s*else\s*\{/.exec(suffix);
    if (!elseMatch) continue;
    const elseOpen = content.indexOf("{", close + 1);
    const elseClose = matchingBrace(content, elseOpen);
    if (elseClose < 0) continue;
    for (let index = close + 1; index <= elseClose; index += 1) {
      if (result[index] !== "\n") result[index] = " ";
    }
  }
  return result.join("");
}

function maskGradleBlocks(content, names) {
  const result = [...content];
  const pattern = new RegExp(`\\b(?:${names.join("|")})\\s*\\{`, "g");
  for (const match of content.matchAll(pattern)) {
    const open = content.indexOf("{", match.index);
    const close = matchingBrace(content, open);
    if (close < 0) continue;
    for (let index = match.index; index <= close; index += 1) {
      if (result[index] !== "\n") result[index] = " ";
    }
  }
  return result.join("");
}

function gradleDependencies(content) {
  const code = maskGradleBlocks(
    maskInactiveGradle(maskGradleComments(content)),
    ["buildscript", "pluginManagement"],
  );
  if (!/\b(?:plugins|java|dependencies)\s*\{/.test(code)) return null;
  const dependencies = [];
  for (const match of code.matchAll(/\bdependencies\s*\{/g)) {
    const open = code.indexOf("{", match.index);
    const close = matchingBrace(code, open);
    if (close < 0) continue;
    const block = code.slice(open + 1, close);
    for (const dependency of block.matchAll(
      /\b(?:api|implementation|runtimeOnly)\s*(?:\(\s*)?["']([^"']+)["']/g,
    )) {
      const [group = "", artifact = "", version = ""] =
        dependency[1].split(":");
      dependencies.push({ group, artifact, version, scope: "runtime" });
    }
  }
  return dependencies;
}

function activeDependencies(manifest) {
  if (manifest.name === "pom.xml") {
    return mavenDependencies(manifest.content);
  }
  if (["build.gradle", "build.gradle.kts"].includes(manifest.name)) {
    return gradleDependencies(manifest.content);
  }
  return null;
}

const PACKAGE_ARTIFACTS = [
  [
    "com.azure.messaging.eventhubs.checkpointstore.blob",
    "azure-messaging-eventhubs-checkpointstore-blob",
  ],
  ["com.azure.resourcemanager.storage", "azure-resourcemanager-storage"],
  [
    "com.azure.security.keyvault.secrets",
    "azure-security-keyvault-secrets",
  ],
  ["com.azure.data.appconfiguration", "azure-data-appconfiguration"],
  ["com.azure.messaging.eventhubs", "azure-messaging-eventhubs"],
  ["com.azure.messaging.servicebus", "azure-messaging-servicebus"],
  ["com.azure.resourcemanager", "azure-resourcemanager"],
  ["com.azure.identity", "azure-identity"],
  ["com.azure.cosmos", "azure-cosmos"],
];

function requiredArtifacts(source) {
  const imports = Array.from(
    source.matchAll(/\bimport\s+(com\.azure\.[\w.]+)/g),
    (match) => match[1],
  );
  const required = new Set();
  for (const imported of imports) {
    const artifact = PACKAGE_ARTIFACTS.find(([prefix]) =>
      imported === prefix || imported.startsWith(`${prefix}.`)
    )?.[1];
    if (artifact) required.add(artifact);
  }
  if (
    imports.some((value) => value.startsWith("com.azure.storage.blob.")) &&
    !required.has("azure-messaging-eventhubs-checkpointstore-blob")
  ) {
    required.add("azure-storage-blob");
  }
  return required;
}

function hasCurrentDependencies(workspace) {
  const required = requiredArtifacts(workspace.source ?? "");
  return manifests(workspace).some((manifest) => {
    const dependencies = activeDependencies(manifest);
    if (!dependencies) return false;
    const current = dependencies.filter(({ group }) =>
      group === "com.azure" || group.startsWith("com.azure.")
    );
    const legacy = dependencies.some(({ group }) =>
      group === "com.microsoft.azure" ||
      group.startsWith("com.microsoft.azure.")
    );
    return (
      !legacy &&
      current.length > 0 &&
      [...required].every((artifact) =>
        current.some((dependency) => dependency.artifact === artifact)
      )
    );
  });
}

const checks = {
  "language/build-manifest": (workspace) =>
    manifests(workspace).some((manifest) =>
      activeDependencies(manifest) !== null
    ),
  "language/current-azure-dependencies": hasCurrentDependencies,
  "language/current-imports": ({ source }) =>
    /\bimport\s+com\.azure\./.test(source) &&
    !/\bimport\s+(?:com\.microsoft\.azure|com\.azure\.[^;]*\.implementation\.)/.test(
      source,
    ),
  "language/client-builder": ({ source }) =>
    /\b\w+ClientBuilder\s*\(\s*\)/.test(source) &&
    /\.build(?:Async)?Client\s*\(\s*\)/.test(source),
};

export function evaluateJavaCheck(name, workspace) {
  const check = checks[name];
  if (!check) {
    throw new Error(`Unknown Java check: ${name}`);
  }
  return check(workspace);
}

export function javaCheckNames() {
  return Object.keys(checks);
}
