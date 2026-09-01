import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function collectTopLevelGoFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".go") &&
        !entry.name.endsWith("_test.go"),
    )
    .map((entry) => join(root, entry.name));
}

export function loadGoWorkspace(root) {
  const sourceFiles = collectTopLevelGoFiles(root);
  const goModPath = join(root, "go.mod");
  const hasGoMod = existsSync(goModPath);

  return {
    sourceFiles,
    source: sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
    hasGoMod,
    goMod: hasGoMod ? readFileSync(goModPath, "utf8") : "",
  };
}

export function goCodeOnly(source) {
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
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
    } else if (state === "quoted") {
      result += character === "\n" ? "\n" : " ";
      if (character === "\\") {
        result += " ";
        index += 1;
      } else if (character === '"') {
        state = "code";
      }
    } else if (state === "raw") {
      result += character === "\n" ? "\n" : " ";
      if (character === "`") state = "code";
    } else if (state === "rune") {
      result += character === "\n" ? "\n" : " ";
      if (character === "\\") {
        result += " ";
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
      if (character === '"') state = "quoted";
      if (character === "`") state = "raw";
      if (character === "'") state = "rune";
    }
  }
  return result;
}

function goModuleIsValid(goMod) {
  const active = goMod.replace(/\/\/.*$/gm, " ");
  return /^\s*module\s+\S+/m.test(active) && /^\s*go\s+\d+\.\d+/m.test(active);
}

function requiredAzureModules(source) {
  const modules = new Set();
  for (const match of source.matchAll(
    /["`](github\.com\/Azure\/azure-sdk-for-go\/sdk\/[^"`]+)["`]/g,
  )) {
    const path = match[1];
    const suffix = path.slice(
      "github.com/Azure/azure-sdk-for-go/sdk/".length,
    );
    const parts = suffix.split("/");
    let length = 1;
    if (parts[0] === "resourcemanager") length = 3;
    if (parts[0] === "security" || parts[0] === "storage") length = 3;
    modules.add(
      `github.com/Azure/azure-sdk-for-go/sdk/${
        parts.slice(0, length).join("/")
      }`,
    );
  }
  return modules;
}

function currentAzureModules({ source, goMod }) {
  const imports = requiredAzureModules(source);
  if (imports.size === 0) return false;
  if (
    /github\.com\/Azure\/azure-sdk-for-go\/(?!sdk\/)/.test(source) ||
    /github\.com\/Azure\/azure-sdk-for-go\s+v/.test(goMod)
  ) {
    return false;
  }
  return [...imports].every((module) => {
    const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)${escaped}\\s+v\\d+`, "m").test(goMod);
  });
}

function returnedErrorsAreHandled(source) {
  const code = goCodeOnly(source);
  return (
    /(?:^|[;\n{])\s*(?:[\w.]+\s*,\s*)?err\s*:?=/.test(code) &&
    /\bif\s+err\s*!=\s*nil\s*\{/.test(code) &&
    /\b(?:return\b[^}\n]*\berr\b|fmt\.Errorf\s*\(|errors\.(?:As|Is)\s*\()/.test(
      code,
    )
  );
}

function propagatesContext(source) {
  const code = goCodeOnly(source);
  const declaresContext =
    /\bctx\s*:=\s*context\.(?:Background|TODO|With\w+)\s*\(/.test(code) ||
    /\bctx\s+context\.Context\b/.test(code);
  return declaresContext && /\.\w+\s*\(\s*ctx(?:\s*[,)]|\s*\.\.\.)/.test(code);
}

function iteratesPager(source) {
  const code = goCodeOnly(source);
  const variable = /\b(\w+)\s*:=\s*[\w.]+\.New\w*Pager\s*\(/.exec(code)?.[1];
  if (!variable) return false;
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`\\b${escaped}\\.More\\s*\\(\\s*\\)`).test(code) &&
    new RegExp(`\\b${escaped}\\.NextPage\\s*\\(\\s*ctx\\s*\\)`).test(code)
  );
}

function usesPoller(source) {
  const code = goCodeOnly(source);
  const variable =
    /\b(\w+)\s*,\s*err\s*:=\s*[\w.]+\.Begin\w+\s*\(\s*ctx/.exec(code)?.[1];
  if (!variable) return false;
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b${escaped}\\.PollUntilDone\\s*\\(\\s*ctx\\s*,`,
  ).test(code);
}

const checks = {
  "language/go-module-manifest": ({ goMod }) => goModuleIsValid(goMod),
  "language/current-azure-modules": currentAzureModules,
  "language/returned-error-handling": ({ source }) =>
    returnedErrorsAreHandled(source),
  "language/context-propagation": ({ source }) => propagatesContext(source),
  "language/pager-iteration": ({ source }) => iteratesPager(source),
  "language/poller-usage": ({ source }) => usesPoller(source),
};

const aliases = {
  "language/go-module": "language/go-module-manifest",
  "language/module-manifest": "language/go-module-manifest",
  "language/error-handling": "language/returned-error-handling",
};

export function evaluateGoCheck(name, workspace) {
  const canonical = aliases[name] ?? name;
  const check = checks[canonical];
  if (!check) {
    throw new Error(`Unknown Go check: ${name}`);
  }
  return check(workspace);
}

export function goCheckNames() {
  return Object.keys(checks);
}
