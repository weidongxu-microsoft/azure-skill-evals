import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const ARMSTORAGE =
  "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage";
const AZIDENTITY =
  "github.com/Azure/azure-sdk-for-go/sdk/azidentity";

const RULES = [
  "prompt/armstorage-module",
  "prompt/default-azure-credential",
  "prompt/accounts-client",
  "prompt/begin-create",
  "prompt/poll-until-done",
  "prompt/list-by-resource-group-pager",
  "prompt/get-properties",
  "prompt/update-account",
  "prompt/delete-account",
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
      } else {
        result += current === "\n" ? "\n" : " ";
      }
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
      } else {
        result += maskStrings && current !== "\n" ? " " : current;
      }
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
  if (
    new RegExp(
      `\\bimport\\s+(?:[A-Za-z_]\\w*|\\.|_)??\\s*"${escaped}"`,
    ).test(text)
  ) {
    return true;
  }
  return [...text.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)].some((match) =>
    new RegExp(
      `(?:^|\\n)\\s*(?:[A-Za-z_]\\w*|\\.|_)?\\s*"${escaped}"`,
    ).test(match[1]),
  );
}

function required(goMod, packageName) {
  const text = goMod.replace(/\/\/.*$/gm, "");
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|\\n)\\s*(?:require\\s+)?${escaped}\\s+v\\d`,
  ).test(text);
}

function callArguments(code, name) {
  const calls = [];
  const pattern = new RegExp(`\\b(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${name}\\s*\\(`, "g");
  for (const match of code.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    for (let index = opening; index < code.length; index += 1) {
      if (code[index] === "(") depth += 1;
      if (code[index] === ")") depth -= 1;
      if (depth === 0) {
        calls.push(code.slice(opening + 1, index));
        break;
      }
    }
  }
  return calls;
}

function assignedNames(code, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...code.matchAll(
    new RegExp(
      `\\b([A-Za-z_]\\w*)\\s*(?:,\\s*[A-Za-z_]\\w*)*\\s*:?=\\s*(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${escaped}\\s*\\(`,
      "g",
    ),
  )].map((match) => match[1]);
}

function callUses(code, callName, names) {
  return callArguments(code, callName).some((argumentsText) =>
    names.some((name) => new RegExp(`\\b${name}\\b`).test(argumentsText)),
  );
}

function pagerIteration(code) {
  return /\.\s*More\s*\(\s*\)/.test(code) &&
    /\.\s*NextPage\s*\(/.test(code);
}

export function ruleNames() {
  return [...RULES];
}

export function evaluateRule(rule, workspace) {
  if (!workspace.sourceFiles?.length || !workspace.source?.trim()) return false;
  const code = maskGo(workspace.source);
  const credentials = assignedNames(code, "NewDefaultAzureCredential");
  const checks = {
    "prompt/armstorage-module":
      imported(workspace.source, ARMSTORAGE) &&
      required(workspace.goMod, ARMSTORAGE),
    "prompt/default-azure-credential":
      imported(workspace.source, AZIDENTITY) &&
      callArguments(code, "NewDefaultAzureCredential").length > 0,
    "prompt/accounts-client":
      callArguments(code, "NewAccountsClient").some(
        (args) =>
          args.includes(",") &&
          credentials.some((name) => new RegExp(`\\b${name}\\b`).test(args)),
      ),
    "prompt/begin-create":
      callArguments(code, "BeginCreate").length > 0 &&
      /\bAccountCreateParameters\s*\{/.test(code) &&
      /\bSKU\s*:/.test(code) &&
      /\bKind\s*:/.test(code) &&
      /\bLocation\s*:/.test(code) &&
      /Standard_?LRS|SKUNameStandardLRS/i.test(code),
    "prompt/poll-until-done":
      callArguments(code, "PollUntilDone").length > 0,
    "prompt/list-by-resource-group-pager":
      callArguments(code, "NewListByResourceGroupPager").length > 0 &&
      pagerIteration(code),
    "prompt/get-properties":
      callArguments(code, "GetProperties").length > 0,
    "prompt/update-account":
      callArguments(code, "Update").length > 0 &&
      /\bAccountUpdateParameters\s*\{/.test(code),
    "prompt/delete-account":
      callArguments(code, "Delete").length > 0,
  };
  return checks[rule] === true;
}
