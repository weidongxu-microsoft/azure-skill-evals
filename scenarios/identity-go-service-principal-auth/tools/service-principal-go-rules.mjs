import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const AZIDENTITY =
  "github.com/Azure/azure-sdk-for-go/sdk/azidentity";
const RULES = [
  "prompt/client-secret-credential",
  "prompt/credential-parameters",
  "prompt/credential-client-constructor",
  "prompt/environment-variables",
  "prompt/error-handling",
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

function callArguments(code, name) {
  const pattern = new RegExp(
    `\\b(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${name}\\s*\\(`,
    "g",
  );
  const results = [];
  for (const match of code.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    for (let index = opening; index < code.length; index += 1) {
      if (code[index] === "(") depth += 1;
      if (code[index] === ")") depth -= 1;
      if (depth === 0) {
        results.push(code.slice(opening + 1, index));
        break;
      }
    }
  }
  return results;
}

function topLevelArgumentCount(args) {
  let depth = 0;
  let current = "";
  const argumentsList = [];
  for (const character of args) {
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      if (current.trim()) argumentsList.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) argumentsList.push(current.trim());
  return argumentsList.length;
}

function credentialNames(code) {
  return [...code.matchAll(
    /\b([A-Za-z_]\w*)\s*(?:,\s*[A-Za-z_]\w*)*\s*:?=\s*(?:[A-Za-z_]\w*\s*\.\s*)?NewClientSecretCredential\s*\(/g,
  )].map((match) => match[1]);
}

function credentialPassedToClient(code) {
  const names = credentialNames(code);
  return [...code.matchAll(
    /\b(?:[A-Za-z_]\w*\s*\.\s*)?New(?:[A-Za-z_]\w*)?Client\s*\(/g,
  )]
    .some((match) => {
      const callName = match[0].match(/New(?:[A-Za-z_]\w*)?Client/)?.[0];
      if (!callName || callName === "NewClientSecretCredential") return false;
      return callArguments(code.slice(match.index), callName)
        .some((args) =>
          names.some((name) => new RegExp(`\\b${name}\\b`).test(args)),
        );
    });
}

export function ruleNames() {
  return [...RULES];
}

export function evaluateRule(rule, workspace) {
  if (!workspace.sourceFiles?.length || !workspace.source?.trim()) return false;
  const code = maskGo(workspace.source);
  const credentialCalls = callArguments(code, "NewClientSecretCredential");
  const checks = {
    "prompt/client-secret-credential":
      imported(workspace.source, AZIDENTITY) &&
      required(workspace.goMod, AZIDENTITY) &&
      credentialCalls.length > 0,
    "prompt/credential-parameters":
      credentialCalls.some((args) => topLevelArgumentCount(args) === 4),
    "prompt/credential-client-constructor":
      credentialPassedToClient(code),
    "prompt/environment-variables":
      /\bos\s*\.\s*Getenv\s*\(/.test(code),
    "prompt/error-handling":
      /\bif\s+[A-Za-z_]\w*\s*!=\s*nil\s*\{/.test(code) ||
      /\berrors\s*\.\s*As\s*\(/.test(code),
  };
  return checks[rule] === true;
}
