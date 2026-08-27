import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function collectProjectFiles(root, predicate) {
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(root, entry.name));
  const sourceRoot = join(root, "src");
  if (!existsSync(sourceRoot)) {
    return files;
  }

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "bin" && entry.name !== "obj") {
          visit(path);
        }
      } else if (predicate(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(sourceRoot);
  return files;
}

export function dotnetCodeOnly(source) {
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
    if (state === "raw-string") {
      if (source.startsWith('"""', index)) {
        result += '"""';
        index += 2;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "verbatim-string") {
      if (character === '"' && next === '"') {
        result += "  ";
        index += 1;
      } else if (character === '"') {
        result += character;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "string" || state === "character") {
      if (character === "\\") {
        result += "  ";
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        result += character;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
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
    } else if (source.startsWith('"$Default"', index)) {
      result += '"$Default"';
      index += '"$Default"'.length - 1;
    } else if (source.startsWith('"""', index)) {
      result += '"""';
      index += 2;
      state = "raw-string";
    } else if (character === '"') {
      result += character;
      state = source[index - 1] === "@" ? "verbatim-string" : "string";
    } else if (character === "'") {
      result += character;
      state = "character";
    } else {
      result += character;
    }
  }
  return result;
}

export function loadDotnetWorkspace(root) {
  const sourceFiles = collectProjectFiles(root, (name) => name.endsWith(".cs"));
  const projectFiles = collectProjectFiles(root, (name) =>
    name.endsWith(".csproj"),
  );

  return {
    sourceFiles,
    projectFiles,
    source: sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
    project: projectFiles
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  };
}

const checks = {
  "language/project-manifest": ({ projectFiles, project }) =>
    projectFiles.length > 0 && /<Project\s+Sdk="Microsoft\.NET\.Sdk"/.test(project),
  "language/current-azure-packages": ({ project }) =>
    /<PackageReference\s+Include="(?:Azure\.|Microsoft\.Azure\.Cosmos")/.test(
      project,
    ) &&
    !/(?:WindowsAzure\.Storage|Microsoft\.WindowsAzure|Microsoft\.Azure\.DocumentDB)/.test(
      project,
    ),
  "language/async-await": ({ source }) => /\bawait\b/.test(source),
  "language/client-lifecycle": ({ source }) =>
    clientsAreDisposed(source, "CosmosClient") &&
    clientsAreDisposed(source, "EventHubProducerClient") &&
    processorsAreStopped(source),
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clientBindings(source, type) {
  const escapedType = escapeRegExp(type);
  const names = new Set();
  const explicitConstructor = new RegExp(
    `\\b(?:${escapedType}|var)\\s+(\\w+)\\s*=\\s*new\\s+${escapedType}\\s*\\(`,
    "g",
  );
  const targetTypedConstructor = new RegExp(
    `\\b${escapedType}\\s+(\\w+)\\s*=\\s*new\\s*\\(`,
    "g",
  );

  for (const pattern of [explicitConstructor, targetTypedConstructor]) {
    for (const match of source.matchAll(pattern)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

function clientsAreDisposed(source, type) {
  if (!new RegExp(`\\b${escapeRegExp(type)}\\b`).test(source)) {
    return true;
  }

  const names = clientBindings(source, type);
  const asyncOnly = type === "EventHubProducerClient";
  return (
    names.length > 0 &&
    names.every((name) => {
      const escapedName = escapeRegExp(name);
      const structuredDisposal = new RegExp(
        asyncOnly
          ? `\\bawait\\s+using\\s+(?:var|${escapeRegExp(type)})\\s+${escapedName}\\s*=`
          : `\\busing\\s+(?:var|${escapeRegExp(type)})\\s+${escapedName}\\s*=`,
      ).test(source);
      const explicitDisposal = new RegExp(
        asyncOnly
          ? `\\b${escapedName}\\s*\\.\\s*(?:DisposeAsync|CloseAsync)\\s*\\(`
          : `\\b${escapedName}\\s*\\.\\s*Dispose\\s*\\(`,
      ).test(source);
      return structuredDisposal || explicitDisposal;
    })
  );
}

function processorsAreStopped(source) {
  if (!/\bEventProcessorClient\b/.test(source)) {
    return true;
  }

  const names = clientBindings(source, "EventProcessorClient");
  return (
    names.length > 0 &&
    names.every((name) =>
      new RegExp(
        `\\b${escapeRegExp(name)}\\s*\\.\\s*StopProcessingAsync\\s*\\(`,
      ).test(source),
    )
  );
}

export function evaluateDotnetCheck(name, workspace) {
  const check = checks[name];
  if (!check) {
    throw new Error(`Unknown .NET check: ${name}`);
  }
  return check({
    ...workspace,
    source: dotnetCodeOnly(workspace.source ?? ""),
  });
}

export function dotnetCheckNames() {
  return Object.keys(checks);
}
