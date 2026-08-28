import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".vally",
  "__tests__",
  "build",
  "dist",
  "node_modules",
  "spec",
  "test",
  "tests",
]);

const sourceExtension = /\.(?:c|m)?(?:js|ts)x?$/i;

function normalizedRelativePath(path) {
  if (typeof path !== "string" || !path || isAbsolute(path)) return null;
  const parts = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function isProductionSource(path) {
  const normalized = normalizedRelativePath(path);
  if (
    !normalized ||
    !sourceExtension.test(normalized) ||
    /\.d\.(?:c|m)?ts$/i.test(normalized)
  ) {
    return false;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => ignoredDirectories.has(segment.toLowerCase()))) {
    return false;
  }
  const name = segments.at(-1);
  return !/\.(?:test|spec)\.(?:c|m)?(?:js|ts)x?$/i.test(name);
}

function jsoncText(source) {
  let result = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      result += current;
      if (current === "\\") {
        result += next ?? "";
        index += 1;
      } else if (current === quote) {
        quote = "";
      }
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n") {
        result += " ";
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      while (
        index + 1 < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index + 1 >= source.length) return null;
      result += " ";
      continue;
    }
    if (current === ",") {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead])) {
        lookahead += 1;
      }
      if (source[lookahead] === "}" || source[lookahead] === "]") {
        result += " ";
        continue;
      }
    }
    result += current;
  }
  return quote ? null : result;
}

function stringArray(config, name) {
  if (!(name in config)) return { present: false, value: [] };
  if (
    !Array.isArray(config[name]) ||
    !config[name].every((value) => typeof value === "string" && value.trim())
  ) {
    return null;
  }
  const value = config[name].map(normalizedRelativePath);
  return value.every((path) => path !== null)
    ? { present: true, value }
    : null;
}

function globPattern(pattern) {
  if (!pattern) return globPattern("**/*");
  const hasWildcard = /[*?]/.test(pattern);
  const lastSegment = pattern.split("/").at(-1) ?? "";
  const directoryPattern = !hasWildcard && !lastSegment.includes(".");
  const value = directoryPattern ? `${pattern}/**/*` : pattern;
  let expression = "^";
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (current === "*" && value[index + 1] === "*") {
      index += 1;
      if (value[index + 1] === "/") {
        expression += "(?:.*/)?";
        index += 1;
      } else {
        expression += ".*";
      }
    } else if (current === "*") {
      expression += "[^/]*";
    } else if (current === "?") {
      expression += "[^/]";
    } else {
      expression += current.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function parseTsconfig(path) {
  try {
    const source = jsoncText(readFileSync(path, "utf8"));
    if (source === null) return null;
    const config = JSON.parse(source);
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      "extends" in config ||
      ("compilerOptions" in config &&
        (!config.compilerOptions ||
          typeof config.compilerOptions !== "object" ||
          Array.isArray(config.compilerOptions)))
    ) {
      return null;
    }
    const files = stringArray(config, "files");
    const include = stringArray(config, "include");
    const exclude = stringArray(config, "exclude");
    if (!files || !include || !exclude) return null;
    const rootDir = config.compilerOptions?.rootDir;
    if (
      rootDir !== undefined &&
      (typeof rootDir !== "string" || !rootDir.trim() || /[*?]/.test(rootDir))
    ) {
      return null;
    }
    const normalizedRootDir = rootDir === undefined
      ? ""
      : normalizedRelativePath(rootDir);
    if (normalizedRootDir === null) return null;
    return {
      exclude: exclude.value.map(globPattern),
      files: new Set(files.value),
      hasFiles: files.present,
      include: include.value.map(globPattern),
      hasInclude: include.present,
      rootDir: normalizedRootDir,
    };
  } catch {
    return null;
  }
}

function selectedByConfig(path, config) {
  if (
    config.rootDir &&
    path !== config.rootDir &&
    !path.startsWith(`${config.rootDir}/`)
  ) {
    return false;
  }
  if (config.exclude.some((pattern) => pattern.test(path))) return false;
  const exact = config.files.has(path);
  const included = config.include.some((pattern) => pattern.test(path));
  if (config.hasFiles || config.hasInclude) return exact || included;
  return true;
}

function collect(directory, root, documents, config) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name.toLowerCase())) {
        collect(join(directory, entry.name), root, documents, config);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const absolutePath = join(directory, entry.name);
    const path = relative(root, absolutePath).replaceAll("\\", "/");
    if (
      !isProductionSource(path) ||
      (config && !selectedByConfig(path, config))
    ) {
      continue;
    }
    documents.push({
      path,
      source: readFileSync(absolutePath, "utf8"),
    });
  }
}

export function loadSourceManifest(root) {
  const documents = [];
  const packagePath = join(root, "package.json");
  const tsconfigPath = join(root, "tsconfig.json");
  const hasTsconfig = existsSync(tsconfigPath);
  const config = hasTsconfig ? parseTsconfig(tsconfigPath) : undefined;
  if (config !== null) collect(root, root, documents, config);
  documents.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  return {
    documents,
    hasTsconfig,
    packageJson: existsSync(packagePath)
      ? readFileSync(packagePath, "utf8")
      : "",
    source: documents.map(({ source }) => source).join("\n"),
    sourceFiles: documents.map(({ path }) => path),
  };
}

export function sourceDocuments(workspace) {
  if (Array.isArray(workspace.documents)) {
    let eligible = null;
    if (Array.isArray(workspace.sourceFiles)) {
      const normalized = workspace.sourceFiles.map(normalizedRelativePath);
      if (
        normalized.some((path) => path === null) ||
        new Set(normalized).size !== normalized.length
      ) {
        return [];
      }
      eligible = new Set(normalized);
    }
    const documents = [];
    const paths = new Set();
    for (const document of workspace.documents) {
      if (
        !document ||
        typeof document.source !== "string" ||
        typeof document.path !== "string"
      ) {
        continue;
      }
      const path = normalizedRelativePath(document.path);
      if (
        !path ||
        !isProductionSource(path) ||
        (eligible && !eligible.has(path)) ||
        paths.has(path)
      ) {
        if (path && paths.has(path)) return [];
        continue;
      }
      paths.add(path);
      documents.push({ ...document, path });
    }
    return documents.toSorted((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
  }
  return typeof workspace.source === "string" && workspace.source.trim()
    ? [{ path: "<workspace>", source: workspace.source }]
    : [];
}

export function activeDependencies(packageJson) {
  try {
    const manifest = JSON.parse(packageJson);
    return manifest.dependencies &&
        typeof manifest.dependencies === "object" &&
        !Array.isArray(manifest.dependencies)
      ? manifest.dependencies
      : {};
  } catch {
    return {};
  }
}
