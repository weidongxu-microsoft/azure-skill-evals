import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

const ARMRESOURCES =
  "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources";
const AZIDENTITY =
  "github.com/Azure/azure-sdk-for-go/sdk/azidentity";
const RULES = [
  "prompt/armresources-module",
  "prompt/default-azure-credential",
  "prompt/resource-groups-client",
  "prompt/create-or-update",
  "prompt/list-pager",
  "prompt/get-resource-group",
  "prompt/begin-delete-poller",
  "prompt/tags-map",
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

function assignedNames(code, name) {
  return [...code.matchAll(
    new RegExp(
      `\\b([A-Za-z_]\\w*)\\s*(?:,\\s*[A-Za-z_]\\w*)*\\s*:?=\\s*(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${name}\\s*\\(`,
      "g",
    ),
  )].map((match) => match[1]);
}

function callUses(code, callName, names) {
  const pattern = new RegExp(
    `\\b(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${callName}\\s*\\(([^;]*)`,
  );
  const args = pattern.exec(code)?.[1] ?? "";
  return names.some((name) => new RegExp(`\\b${name}\\b`).test(args));
}

export function ruleNames() {
  return [...RULES];
}

export function evaluateRule(rule, workspace) {
  if (!workspace.sourceFiles?.length || !workspace.source?.trim()) return false;
  const code = maskGo(workspace.source);
  const credentials = assignedNames(code, "NewDefaultAzureCredential");
  const checks = {
    "prompt/armresources-module":
      imported(workspace.source, ARMRESOURCES) &&
      required(workspace.goMod, ARMRESOURCES),
    "prompt/default-azure-credential":
      imported(workspace.source, AZIDENTITY) &&
      calls(code, "NewDefaultAzureCredential"),
    "prompt/resource-groups-client":
      calls(code, "NewResourceGroupsClient") &&
      callUses(code, "NewResourceGroupsClient", credentials),
    "prompt/create-or-update":
      calls(code, "CreateOrUpdate") &&
      /\bResourceGroup\s*\{/.test(code) &&
      /\bLocation\s*:/.test(code),
    "prompt/list-pager":
      calls(code, "NewListPager") &&
      /\.\s*More\s*\(\s*\)/.test(code) &&
      /\.\s*NextPage\s*\(/.test(code),
    "prompt/get-resource-group": calls(code, "Get"),
    "prompt/begin-delete-poller":
      calls(code, "BeginDelete") &&
      calls(code, "PollUntilDone"),
    "prompt/tags-map":
      /\bTags\s*:\s*map\s*\[\s*string\s*\]\s*\*\s*string\s*\{/.test(code) ||
      /\bmap\s*\[\s*string\s*\]\s*\*\s*string\s*\{/.test(code),
  };
  return checks[rule] === true;
}
