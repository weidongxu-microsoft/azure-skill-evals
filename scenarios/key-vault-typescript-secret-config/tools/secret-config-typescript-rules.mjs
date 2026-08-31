const PINS = {
  "@azure/core-rest-pipeline": "1.25.0",
  "@azure/identity": "4.13.2",
  "@azure/keyvault-secrets": "4.11.2",
};

function mask(source, preserveStrings = false) {
  let output = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (character === "\n") {
        output += "\n";
        state = "code";
      } else output += " ";
    } else if (state === "block") {
      if (character === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else output += character === "\n" ? "\n" : " ";
    } else if (state === "single" || state === "double" || state === "template") {
      const end = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (character === "\\") {
        output += preserveStrings ? `${character}${next ?? ""}` : "  ";
        index += 1;
      } else if (character === end) {
        output += preserveStrings ? character : " ";
        state = "code";
      } else output += preserveStrings ? character : character === "\n" ? "\n" : " ";
    } else if (character === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line";
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block";
    } else if (character === "'") {
      output += preserveStrings ? character : " ";
      state = "single";
    } else if (character === '"') {
      output += preserveStrings ? character : " ";
      state = "double";
    } else if (character === "`") {
      output += preserveStrings ? character : " ";
      state = "template";
    } else output += character;
  }
  return output;
}

function closing(code, opening, left = "{", right = "}") {
  let depth = 0;
  for (let index = opening; index < code.length; index += 1) {
    if (code[index] === left) depth += 1;
    else if (code[index] === right && --depth === 0) return index;
  }
  return -1;
}

function callableList(source) {
  const code = mask(source, true);
  const found = [];
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{/g,
    /(?:^|[;{}])\s*(?:public|private|protected|static|async|readonly|\s)*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::\s*[^{=]+)?\{/gm,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const opening = match.index + match[0].lastIndexOf("{");
      const end = closing(code, opening);
      if (end < 0 || found.some((item) => item.opening === opening)) continue;
      found.push({
        name: match[1],
        opening,
        body: source.slice(opening + 1, end),
        isAsync: /\basync\b/.test(match[0]),
      });
    }
  }
  return found;
}

function activeBody(body) {
  const code = mask(body, true);
  let output = "";
  let depth = 0;
  for (let index = 0; index < code.length;) {
    const falseMatch = /^if\s*\(\s*false\s*\)\s*\{/.exec(code.slice(index));
    if (falseMatch) {
      const opening = index + falseMatch[0].lastIndexOf("{");
      const end = closing(code, opening);
      output += " ".repeat(end - index + 1);
      index = end + 1;
      continue;
    }
    const returnMatch = /^return\b[^;]*;/.exec(code.slice(index));
    if (returnMatch && depth === 0) {
      output += code.slice(index, index + returnMatch[0].length);
      break;
    }
    output += code[index];
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") depth -= 1;
    index += 1;
  }
  return output;
}

function reachable(source) {
  const all = callableList(source);
  const byName = new Map();
  for (const item of all) {
    if (!byName.has(item.name)) byName.set(item.name, []);
    byName.get(item.name).push(item);
  }
  const outside = mask(source, true).split("");
  for (const item of all) {
    outside.fill(" ", item.opening, item.opening + item.body.length + 2);
  }
  const queue = [];
  for (const match of outside.join("").matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    queue.push(...(byName.get(match[1]) ?? []));
  }
  if (queue.length === 0) queue.push(...(byName.get("main") ?? []));
  const result = new Set();
  while (queue.length > 0) {
    const item = queue.pop();
    if (result.has(item)) continue;
    result.add(item);
    for (const match of activeBody(item.body).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      queue.push(...(byName.get(match[1]) ?? []));
    }
  }
  return [...result];
}

function packagePins(workspace) {
  let manifest;
  try {
    manifest = JSON.parse(workspace.packageJson);
  } catch {
    return false;
  }
  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};
  return (
    Object.entries(PINS).every(([name, version]) => dependencies[name] === version) &&
    devDependencies.typescript === "5.9.2" &&
    devDependencies["@types/node"] === "26.2.0"
  );
}

function importBindings(source) {
  const bindings = new Map();
  const code = mask(source, true);
  for (const match of code.matchAll(/\bimport\s+(type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
    if (match[1]) continue;
    for (const item of match[2].split(",")) {
      const parts = item.trim().split(/\s+as\s+/);
      bindings.set(parts[1] ?? parts[0], `${match[3]}.${parts[0]}`);
    }
  }
  for (const match of code.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g)) {
    bindings.set(match[1], match[2]);
  }
  return bindings;
}

function official(source) {
  const imports = importBindings(source);
  const locals = new Set([...mask(source).matchAll(/\b(?:class|function)\s+([A-Za-z_$][\w$]*)/g)].map((item) => item[1]));
  const has = (qualified) => [...imports].some(([name, value]) =>
    value === qualified && !locals.has(name)
  );
  return {
    credential: has("@azure/identity.DefaultAzureCredential"),
    client: has("@azure/keyvault-secrets.SecretClient"),
    error: has("@azure/core-rest-pipeline.RestError"),
  };
}

function facts(workspace) {
  const source = workspace.documents?.map((document) => document.source).join("\n") ?? workspace.source ?? "";
  const methods = reachable(source);
  return {
    source,
    methods,
    code: methods.map((method) => activeBody(method.body)).join("\n"),
    imports: official(source),
  };
}

function configuration(data) {
  return data.imports.credential && data.imports.client &&
    /\bprocess\s*\.\s*env\s*(?:\.|\[)/.test(data.code) &&
    /\bnew\s+DefaultAzureCredential\s*\(/.test(data.code) &&
    /\bnew\s+SecretClient\s*\(/.test(data.code);
}

function provider(data) {
  if (!data.imports.client || !/\bSecretClient\b/.test(data.source)) return false;
  return data.methods.some((method) => {
    const code = activeBody(method.body);
    return /\.getSecret\s*\(\s*[^,()]+\s*,[\s\S]{0,240}?\bversion\b[\s\S]{0,240}?\)/.test(code) &&
      /\.properties\s*\.\s*expiresOn\b/.test(code);
  });
}

function notFound(data) {
  return data.imports.error && data.methods.some((method) => {
    const code = activeBody(method.body);
    return /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/.test(code) &&
      /\binstanceof\s+RestError\b/.test(code) &&
      /\.statusCode\s*===?\s*404\b/.test(code) &&
      /\breturn\b[^;]{0,240}\bdefault\w*/i.test(code) &&
      /\bthrow\s+[A-Za-z_$][\w$]*\s*;/.test(code);
  });
}

function cache(data) {
  const names = data.methods.map((method) => method.name.toLowerCase());
  const mapping = /\b(?:new\s+Map|Map\s*<|Record\s*<)/.test(data.source);
  const stores = /\.set\s*\(/.test(data.code) ||
    /\b[A-Za-z_$][\w$]*\s*\[[^\]]+\]\s*=/.test(data.code);
  const expiryRefresh = data.methods.some((method) => {
    const code = activeBody(method.body);
    return /\bDate\s*\.\s*now\s*\(\s*\)/.test(code) &&
      /\bwarningWindow\w*\b/.test(code) &&
      /\.expiresOn\b/.test(code) &&
      /\.\s*refresh\s*\(/.test(code);
  });
  return mapping && stores &&
    (/\bfor\s*\(/.test(data.code) || /\bPromise\s*\.\s*all\s*\(/.test(data.code)) &&
    expiryRefresh &&
    /\bwarning\w*/i.test(data.source) &&
    names.some((name) => /load|warm/.test(name)) &&
    names.some((name) => /refresh/.test(name));
}

function versionRotation(data) {
  return data.methods.some((method) => {
    const code = activeBody(method.body);
    return /\bawait\s+[\w$.]+\.setSecret\s*\(\s*[^,]+,\s*[^,]+,\s*\{[\s\S]*?\bexpiresOn\b/.test(code);
  });
}

function branchContexts(body, positions) {
  const code = mask(body, true);
  const contexts = positions.map(() => new Map());
  let id = 0;
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const condition = match.index + match[0].lastIndexOf("(");
    const conditionEnd = closing(code, condition, "(", ")");
    const trueOpen = code.indexOf("{", conditionEnd);
    if (trueOpen < 0) continue;
    const trueEnd = closing(code, trueOpen);
    id += 1;
    positions.forEach((position, index) => {
      if (trueOpen < position && position < trueEnd) contexts[index].set(id, true);
    });
    const alternative = /^\s*else\s*\{/.exec(code.slice(trueEnd + 1));
    if (alternative) {
      const falseOpen = trueEnd + 1 + alternative[0].lastIndexOf("{");
      const falseEnd = closing(code, falseOpen);
      positions.forEach((position, index) => {
        if (falseOpen < position && position < falseEnd) contexts[index].set(id, false);
      });
    }
  }
  return contexts;
}

function compatible(contexts) {
  for (let left = 0; left < contexts.length; left += 1) {
    for (let right = left + 1; right < contexts.length; right += 1) {
      for (const [id, value] of contexts[left]) {
        if (contexts[right].has(id) && contexts[right].get(id) !== value) return false;
      }
    }
  }
  return true;
}

function safeCleanup(data) {
  return data.methods.some((method) => {
    const code = activeBody(method.body);
    const beginMatch = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+([A-Za-z_$][\w$.]*)\.beginDeleteSecret\s*\(\s*([^)]+?)\s*\)/.exec(code);
    if (!beginMatch) return false;
    const normalize = (value) => value.replace(/\s+/g, "");
    const poller = beginMatch[1];
    const client = normalize(beginMatch[2]);
    const name = normalize(beginMatch[3]);
    const waitPattern = new RegExp(`\\bawait\\s+${poller}\\s*\\.\\s*pollUntilDone\\s*\\(`);
    const waitMatch = waitPattern.exec(code.slice(beginMatch.index + beginMatch[0].length));
    if (!waitMatch) return false;
    const wait = beginMatch.index + beginMatch[0].length + waitMatch.index;
    const purgePattern = /\bawait\s+([A-Za-z_$][\w$.]*)\.purgeDeletedSecret\s*\(\s*([^)]+?)\s*\)/g;
    purgePattern.lastIndex = wait;
    const purgeMatch = purgePattern.exec(code);
    if (!purgeMatch || normalize(purgeMatch[1]) !== client || normalize(purgeMatch[2]) !== name) return false;
    const setPattern = /\bawait\s+([A-Za-z_$][\w$.]*)\.setSecret\s*\(\s*([^,]+),/g;
    setPattern.lastIndex = purgeMatch.index + purgeMatch[0].length;
    const setMatch = setPattern.exec(code);
    if (!setMatch || normalize(setMatch[1]) !== client || normalize(setMatch[2]) !== name) return false;
    return compatible(branchContexts(code, [
      beginMatch.index,
      wait,
      purgeMatch.index,
      setMatch.index,
    ]));
  });
}

function connectedDemo(data, state) {
  if (!Object.values(state).every(Boolean)) return false;
  const code = data.code;
  const operations = [
    /\.\s*(?:bulkLoad|loadAll|warm\w*)\s*\(/,
    /\.\s*get\s*\(/,
    /\.\s*refresh\s*\(/,
    /\.\s*(?:refreshExpiring|checkExpiring|refreshNearExpiry)\s*\(/,
  ];
  return operations.every((pattern) => pattern.test(code)) &&
    data.methods.some((method) => /\bawait\b/.test(activeBody(method.body)));
}

const rules = {
  "prompt/packages": (workspace) => packagePins(workspace),
  "prompt/managed-identity-configuration": (_, data) => configuration(data),
  "prompt/versioned-provider": (_, data) => provider(data),
  "prompt/not-found-default": (_, data) => notFound(data),
  "prompt/expiry-aware-cache": (_, data) => cache(data),
  "prompt/version-based-rotation": (_, data) => versionRotation(data),
  "prompt/safe-delete-purge-recreate": (_, data) => safeCleanup(data),
  "prompt/connected-demo": (_, data) => connectedDemo(data, {
    configuration: configuration(data),
    provider: provider(data),
    notFound: notFound(data),
    cache: cache(data),
    versionRotation: versionRotation(data),
    cleanup: safeCleanup(data),
  }),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  if (!(workspace.sourceFiles?.length > 0 || workspace.source?.trim())) return false;
  return rule(workspace, facts(workspace));
}

export function ruleNames() {
  return Object.keys(rules);
}
