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
  const interpolationStates = [];
  let interpolationDepth = 0;

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
    if (
      state === "interpolated-string" ||
      state === "interpolated-verbatim-string"
    ) {
      const verbatim = state === "interpolated-verbatim-string";
      if (character === "{" && next === "{") {
        result += "  ";
        index += 1;
      } else if (character === "{") {
        result += " ";
        interpolationStates.push(state);
        interpolationDepth = 1;
        state = "interpolation";
      } else if (character === '"' && verbatim && next === '"') {
        result += "  ";
        index += 1;
      } else if (character === '"' || (!verbatim && character === "\\")) {
        result += character === '"' ? '"' : "  ";
        if (character === "\\") {
          index += 1;
        } else {
          state = "code";
        }
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "interpolation") {
      if (character === "{") {
        interpolationDepth += 1;
        result += character;
      } else if (character === "}") {
        interpolationDepth -= 1;
        result += interpolationDepth === 0 ? " " : character;
        if (interpolationDepth === 0) {
          state = interpolationStates.pop();
        }
      } else if (character === '"') {
        result += character;
        state = "interpolation-string";
      } else if (character === "'") {
        result += character;
        state = "interpolation-character";
      } else {
        result += character;
      }
      continue;
    }
    if (state === "interpolation-string" || state === "interpolation-character") {
      if (character === "\\") {
        result += "  ";
        index += 1;
      } else if (
        (state === "interpolation-string" && character === '"') ||
        (state === "interpolation-character" && character === "'")
      ) {
        result += character;
        state = "interpolation";
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
    } else if (
      source.startsWith('$@"', index) ||
      source.startsWith('@$"', index)
    ) {
      result += source.slice(index, index + 3);
      index += 2;
      state = "interpolated-verbatim-string";
    } else if (source.startsWith('$"', index)) {
      result += '$"';
      index += 1;
      state = "interpolated-string";
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
    processorsAreStopped(source) &&
    serviceBusResourcesAreDisposed(source),
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

function matchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function serviceBusFactoryBindings(source, client, type, method) {
  const escapedClient = escapeRegExp(client);
  const escapedType = escapeRegExp(type);
  const result = new Set();
  const patterns = [
    new RegExp(
      `\\b(?:${escapedType}|var)\\s+(\\w+)\\s*=\\s*${escapedClient}\\s*\\.\\s*${method}\\s*\\(`,
      "g",
    ),
    new RegExp(
      `\\b${escapedType}\\s+(\\w+)\\s*=\\s*${escapedClient}\\s*\\.\\s*${method}\\s*\\(`,
      "g",
    ),
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) result.add(match[1]);
  }
  return [...result];
}

function serviceBusDisposalPosition(source, type, name) {
  const escapedType = escapeRegExp(type);
  const escapedName = escapeRegExp(name);
  const structured = new RegExp(
    `\\bawait\\s+using\\s+(?:var|${escapedType})\\s+${escapedName}\\s*=`,
  ).exec(source);
  const disposals = [
    ...source.matchAll(
      new RegExp(
        `\\bawait\\s+${escapedName}\\s*\\.\\s*DisposeAsync\\s*\\(`,
        "g",
      ),
    ),
  ];
  const lastUse = [
    ...source.matchAll(
      new RegExp(
        `\\b${escapedName}\\s*\\.\\s*(?!DisposeAsync\\b)\\w+(?:Async)?\\s*\\(`,
        "g",
      ),
    ),
  ].at(-1)?.index ?? -1;
  if (disposals.some((disposal) => disposal.index <= lastUse)) return -1;
  if (structured) {
    return source.length * 2 - structured.index;
  }
  if (disposals.length === 0) return -1;
  return disposals.find((disposal) => disposal.index > lastUse)?.index ?? -1;
}

function serviceBusProcessorIsStopped(source, processor) {
  const escaped = escapeRegExp(processor);
  const start = new RegExp(
    `\\bawait\\s+${escaped}\\s*\\.\\s*StartProcessingAsync\\s*\\(`,
  ).exec(source);
  if (!start) return false;
  const wait = new RegExp(
    `\\b(?:await\\s+Task\\s*\\.\\s*Delay|await\\s+\\w+(?:\\.\\w+)*\\s*\\.\\s*WaitForCancellationAsync|Console\\s*\\.\\s*Read(?:Line|Key))\\s*\\(`,
    "g",
  );
  const stop = new RegExp(
    `\\bawait\\s+${escaped}\\s*\\.\\s*StopProcessingAsync\\s*\\(`,
    "g",
  );
  for (const finallyMatch of source.matchAll(/\bfinally\s*\{/g)) {
    const open = source.indexOf("{", finallyMatch.index);
    const close = matchingBrace(source, open);
    if (close < 0) continue;
    const body = source.slice(open + 1, close);
    const stopped = stop.exec(body);
    stop.lastIndex = 0;
    if (!stopped || finallyMatch.index <= start.index) continue;
    wait.lastIndex = start.index + start[0].length;
    const waited = wait.exec(source);
    wait.lastIndex = 0;
    if (waited && waited.index < finallyMatch.index) return true;
  }
  return false;
}

function serviceBusResourcesAreDisposed(source) {
  if (!/\bServiceBus(?:Client|Sender|Receiver|Processor)\b/.test(source)) {
    return true;
  }
  const clients = clientBindings(source, "ServiceBusClient");
  if (
    clients.length === 0 ||
    !clients.every(
      (name) => serviceBusDisposalPosition(
        source,
        "ServiceBusClient",
        name,
      ) >= 0,
    )
  ) {
    return false;
  }

  const resources = [];
  for (const client of clients) {
    for (const [type, method] of [
      ["ServiceBusSender", "CreateSender"],
      ["ServiceBusReceiver", "CreateReceiver"],
      ["ServiceBusProcessor", "CreateProcessor"],
    ]) {
      for (const name of serviceBusFactoryBindings(
        source,
        client,
        type,
        method,
      )) {
        resources.push({ client, name, type });
      }
    }
  }
  if (
    resources.length === 0 ||
    !resources.every(({ client, name, type }) => {
      const resourceDisposal = serviceBusDisposalPosition(source, type, name);
      const clientDisposal = serviceBusDisposalPosition(
        source,
        "ServiceBusClient",
        client,
      );
      return resourceDisposal >= 0 && resourceDisposal < clientDisposal;
    })
  ) {
    return false;
  }
  return resources
    .filter(({ type }) => type === "ServiceBusProcessor")
    .every(({ name }) => serviceBusProcessorIsStopped(source, name));
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
