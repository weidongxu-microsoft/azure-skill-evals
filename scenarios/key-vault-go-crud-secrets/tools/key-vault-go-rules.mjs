import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const AZSECRETS =
  "github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets";
const AZIDENTITY =
  "github.com/Azure/azure-sdk-for-go/sdk/azidentity";
const AZCORE = "github.com/Azure/azure-sdk-for-go/sdk/azcore";
const RULES = [
  "prompt/azsecrets-module",
  "prompt/azidentity-module",
  "prompt/secrets-client",
  "prompt/secret-crud",
  "prompt/response-error",
];

export function loadGoWorkspace(root) {
  const sourceFiles = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".go"))
        .map((entry) => entry.name)
        .sort()
    : [];
  const read = (name) => {
    const filename = path.join(root, name);
    return existsSync(filename) ? readFileSync(filename, "utf8") : "";
  };
  return {
    sourceFiles,
    source: sourceFiles.map(read).join("\n"),
    goMod: read("go.mod"),
    goSum: read("go.sum"),
  };
}

function maskGo(source, maskStrings = true) {
  let result = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      result += current === "\n" ? "\n" : " ";
      if (current === "\n") state = "code";
    } else if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else result += current === "\n" ? "\n" : " ";
    } else if (state !== "code") {
      if (current === "\\" && state !== "raw") {
        result += maskStrings ? "  " : current + (next ?? "");
        index += 1;
      } else if (
        (state === "string" && current === '"') ||
        (state === "rune" && current === "'") ||
        (state === "raw" && current === "`")
      ) {
        result += maskStrings ? " " : current;
        state = "code";
      } else result += maskStrings && current !== "\n" ? " " : current;
    } else if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else {
      result += current;
      if (current === '"') state = "string";
      if (current === "'") state = "rune";
      if (current === "`") state = "raw";
    }
  }
  return result;
}

function imported(source, packageName) {
  const text = maskGo(source, false);
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\bimport\\s+(?:(?:[A-Za-z_]\\w*|\\.|_)\\s+)?"${escaped}"`,
  ).test(text) ||
    [...text.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)].some((match) =>
      new RegExp(
        `(?:^|\\n)\\s*(?:(?:[A-Za-z_]\\w*|\\.|_)\\s+)?"${escaped}"`,
      ).test(match[1]),
    );
}

function required(goMod, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|\\n)\\s*(?:require\\s+)?${escaped}\\s+v\\d`,
  ).test(goMod.replace(/\/\/.*$/gm, ""));
}

function calls(code, name) {
  return new RegExp(
    `\\b(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${name}\\s*\\(`,
  ).test(code);
}

function responseError(code, source) {
  return imported(source, AZCORE) &&
    /\*\s*(?:[A-Za-z_]\w*\s*\.\s*)?ResponseError\b/.test(code) &&
    (
      /\berrors\s*\.\s*As\s*\(/.test(code) ||
      /\.\s*\(\s*\*\s*(?:[A-Za-z_]\w*\s*\.\s*)?ResponseError\s*\)/.test(code)
    );
}

export function ruleNames() {
  return [...RULES];
}

export function evaluateRule(rule, workspace) {
  if (!workspace.sourceFiles?.length || !workspace.source?.trim()) return false;
  const code = maskGo(workspace.source);
  const checks = {
    "prompt/azsecrets-module":
      imported(workspace.source, AZSECRETS) &&
      required(workspace.goMod, AZSECRETS),
    "prompt/azidentity-module":
      imported(workspace.source, AZIDENTITY) &&
      required(workspace.goMod, AZIDENTITY),
    "prompt/secrets-client":
      calls(code, "NewClient"),
    "prompt/secret-crud":
      ["SetSecret", "GetSecret", "DeleteSecret", "PurgeDeletedSecret"]
        .every((name) => calls(code, name)),
    "prompt/response-error": responseError(code, workspace.source),
  };
  return checks[rule] === true;
}
