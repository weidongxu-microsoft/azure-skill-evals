const PINS = new Map([
  ["com.azure:azure-messaging-servicebus", "7.17.20"],
  ["com.azure:azure-identity", "1.18.5"],
  ["com.fasterxml.jackson.core:jackson-databind", "2.20.0"],
]);

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
    } else if (state === "string" || state === "character") {
      if (character === "\\") {
        output += preserveStrings ? `${character}${next ?? ""}` : "  ";
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
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
    } else if (character === '"') {
      output += preserveStrings ? character : " ";
      state = "string";
    } else if (character === "'") {
      output += preserveStrings ? character : " ";
      state = "character";
    } else output += character;
  }
  return output;
}

function closing(source, opening, left, right) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === left) depth += 1;
    else if (source[index] === right && --depth === 0) return index;
  }
  return -1;
}

function activeBody(body) {
  const code = mask(body, true);
  const result = [...code];
  for (const match of code.matchAll(/\bif\s*\(\s*(?:false|Boolean\.FALSE)\s*\)\s*\{/g)) {
    const opening = code.indexOf("{", match.index);
    const end = closing(code, opening, "{", "}");
    if (end < 0) continue;
    for (let index = match.index; index <= end; index += 1) {
      if (result[index] !== "\n") result[index] = " ";
    }
  }
  return result.join("");
}

function branchContexts(body, positions) {
  const code = mask(body, true);
  const contexts = positions.map(() => new Map());
  let branch = 0;
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const conditionOpen = match.index + match[0].lastIndexOf("(");
    const conditionClose = closing(code, conditionOpen, "(", ")");
    const trueOpen = code.indexOf("{", conditionClose);
    if (trueOpen < 0) continue;
    const trueClose = closing(code, trueOpen, "{", "}");
    if (trueClose < 0) continue;
    branch += 1;
    positions.forEach((position, index) => {
      if (trueOpen < position && position < trueClose) {
        contexts[index].set(branch, true);
      }
    });
    const tail = code.slice(trueClose + 1);
    const elseMatch = /^\s*else\s*\{/.exec(tail);
    if (!elseMatch) continue;
    const falseOpen = trueClose + 1 + elseMatch[0].lastIndexOf("{");
    const falseClose = closing(code, falseOpen, "{", "}");
    positions.forEach((position, index) => {
      if (falseOpen < position && position < falseClose) {
        contexts[index].set(branch, false);
      }
    });
  }
  return contexts;
}

function compatible(contexts) {
  for (let left = 0; left < contexts.length; left += 1) {
    for (let right = left + 1; right < contexts.length; right += 1) {
      for (const [branch, value] of contexts[left]) {
        if (contexts[right].has(branch) && contexts[right].get(branch) !== value) {
          return false;
        }
      }
    }
  }
  return true;
}

function methods(source) {
  const code = mask(source, true);
  const found = [];
  const pattern =
    /(?:^|[;{}])\s*(?:(?:public|private|protected|static|final|synchronized)\s+)*(?:<[^>{}]+>\s*)?(?:[\w$.[\]<>?,]+\s+)?([A-Za-z_$][\w$]*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^{]+)?\{/gm;
  for (const match of code.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const end = closing(code, opening, "{", "}");
    if (end < 0) continue;
    found.push({
      name: match[1],
      body: source.slice(opening + 1, end),
      code: code.slice(opening + 1, end),
      isMain: match[1] === "main" && /\bstatic\b/.test(match[0]),
    });
  }
  return found;
}

function reachableMethods(source) {
  const all = methods(source);
  const byName = new Map();
  for (const method of all) {
    if (!byName.has(method.name)) byName.set(method.name, []);
    byName.get(method.name).push(method);
  }
  const pending = all.filter((method) => method.isMain);
  const reachable = [];
  const seen = new Set();
  while (pending.length > 0) {
    const method = pending.pop();
    if (seen.has(method)) continue;
    seen.add(method);
    reachable.push(method);
    const body = activeBody(method.body);
    for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\(|::)/g)) {
      pending.push(...(byName.get(match[1]) ?? []));
    }
  }
  return { all, byName, reachable };
}

function closure(method, byName) {
  const pending = [method];
  const found = [];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    found.push(current);
    const body = activeBody(current.body);
    for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\(|::)/g)) {
      pending.push(...(byName.get(match[1]) ?? []));
    }
  }
  return found;
}

function exactDependencies(build) {
  const xml = build.replace(/<!--[\s\S]*?-->/g, " ");
  if (!/^\s*<project\b[\s\S]*<\/project>\s*$/i.test(xml)) return false;
  const active = xml
    .replace(/<dependencyManagement\b[\s\S]*?<\/dependencyManagement>/gi, " ")
    .replace(/<profiles\b[\s\S]*?<\/profiles>/gi, " ")
    .replace(/<build\b[\s\S]*?<\/build>/gi, " ");
  const dependencies = new Map();
  for (const match of active.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)) {
    const body = match[1];
    const group = /<groupId>\s*([^<]+)\s*<\/groupId>/i.exec(body)?.[1].trim();
    const artifact = /<artifactId>\s*([^<]+)\s*<\/artifactId>/i.exec(body)?.[1].trim();
    const version = /<version>\s*([^<]+)\s*<\/version>/i.exec(body)?.[1].trim();
    const scope = /<scope>\s*([^<]+)\s*<\/scope>/i.exec(body)?.[1].trim() ?? "compile";
    if (group && artifact && ["compile", "runtime"].includes(scope)) {
      dependencies.set(`${group}:${artifact}`, version);
    }
  }
  return [...PINS].every(([name, version]) => dependencies.get(name) === version);
}

function officialTypes(source) {
  const imports = new Set(
    [...mask(source, true).matchAll(/\bimport\s+([\w.]+)\s*;/g)]
      .map((match) => match[1]),
  );
  const local = new Set(
    [...mask(source).matchAll(/\b(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)/g)]
      .map((match) => match[1]),
  );
  const required = [
    "com.azure.identity.ManagedIdentityCredentialBuilder",
    "com.azure.messaging.servicebus.ServiceBusClientBuilder",
    "com.azure.messaging.servicebus.ServiceBusMessage",
    "com.azure.messaging.servicebus.ServiceBusMessageBatch",
    "com.azure.messaging.servicebus.ServiceBusReceivedMessage",
    "com.azure.messaging.servicebus.models.SubQueue",
  ];
  return required.every(
    (name) => imports.has(name) && !local.has(name.split(".").at(-1)),
  );
}

function facts(workspace) {
  const source = workspace.source ?? "";
  const graph = reachableMethods(source);
  return {
    source,
    graph,
    reachableCode: graph.reachable.map((method) => activeBody(method.body)).join("\n"),
    types: officialTypes(source),
  };
}

function orderModel(value) {
  const code = mask(value.source, true);
  const fields = ["orderId", "customerName", "product", "quantity", "totalPrice", "status"];
  const fieldMatch = fields.every((field) =>
    new RegExp(`\\b(?:String|int|Integer|double|Double|BigDecimal)\\s+${field}\\s*;`).test(code)
  );
  return (
    fieldMatch &&
    /\bnew\s+Order\s*\(/.test(value.reachableCode) &&
    /\bObjectMapper\b/.test(code) &&
    /\.writeValueAsString\s*\(/.test(code) &&
    /\.readValue\s*\(/.test(code) &&
    ["pending", "processing", "completed", "failed"].every((status) =>
      value.source.toLowerCase().includes(status)
    )
  );
}

function metadata(code) {
  return (
    /\.setCorrelationId\s*\([^)]*(?:orderId|getOrderId)\s*\(/.test(code) &&
    /\.setSessionId\s*\([^)]*(?:customerName|getCustomerName)\s*\(/.test(code) &&
    /\.setScheduledEnqueueTime\s*\(/.test(code) &&
    /\.plusSeconds\s*\(\s*30\s*\)/.test(code) &&
    /totalPrice|getTotalPrice/.test(code) &&
    /high/i.test(code)
  );
}

function sender(value, asynchronous) {
  let single = false;
  let batch = false;
  for (const method of value.graph.reachable) {
    const own = activeBody(method.body);
    const code = closure(method, value.graph.byName)
      .map((candidate) => activeBody(candidate.body)).join("\n");
    const correctClient = asynchronous
      ? /\bServiceBusSenderAsyncClient\b/.test(value.source) &&
        /\.sender\s*\(\s*\)[\s\S]*?\.queueName\s*\([\s\S]*?\.buildAsyncClient\s*\(/.test(
          value.reachableCode,
        )
      : /\bServiceBusSenderClient\b/.test(value.source) &&
        /\.sender\s*\(\s*\)[\s\S]*?\.queueName\s*\([\s\S]*?\.buildClient\s*\(/.test(
          value.reachableCode,
        );
    if (!correctClient || !metadata(code)) continue;
    if (/\.sendMessage\s*\(/.test(own) && !/createMessageBatch/.test(own)) {
      single ||= asynchronous
        ? /\breturn\b[\s\S]*\.sendMessage\s*\(/.test(own) ||
          /\.sendMessage\s*\([^;]+\.block\s*\(/.test(own)
        : !/\breturn\b[\s\S]*\.sendMessage\s*\(/.test(own) &&
          !/\.block\s*\(/.test(own);
    }
    if (asynchronous && /\breturn\b[\s\S]*createMessageBatch\s*\(/.test(own)) {
      const helper = value.graph.reachable
        .filter((candidate) => candidate.name !== method.name)
        .map((candidate) => activeBody(candidate.body))
        .find((body) =>
          /tryAddMessage\s*\(/.test(body) &&
          /\.sendMessages\s*\(\s*batch\s*\)/.test(body) &&
          /\.then\s*\(\s*sender\.createMessageBatch\s*\(\s*\)\s*\)/.test(body) &&
          /nextBatch\.tryAddMessage\s*\(/.test(body)
        );
      batch ||= Boolean(helper);
    } else if (
      !asynchronous &&
      /\bServiceBusMessageBatch\b/.test(own) &&
      /if\s*\(\s*!\s*batch\.tryAddMessage\s*\(/.test(own) &&
      /sender\.sendMessages\s*\(\s*batch\s*\)[\s\S]*batch\s*=\s*sender\.createMessageBatch\s*\(\s*\)[\s\S]*batch\.tryAddMessage\s*\(/.test(
        own,
      )
    ) {
      const positions = [
        own.indexOf("tryAddMessage"),
        own.indexOf("sendMessages"),
        own.lastIndexOf("createMessageBatch"),
        own.lastIndexOf("tryAddMessage"),
      ];
      batch = compatible(branchContexts(own, positions));
    }
  }
  return single && batch;
}

function sameMessageSettlement(code, asynchronous) {
  const declared = /\bServiceBusReceivedMessage\s+([A-Za-z_$][\w$]*)/.exec(code)?.[1];
  const message = declared ?? (/\.getMessage\s*\(\s*\)/.test(code) ? "message" : "");
  if (!message) return false;
  const complete = new RegExp(`\\.complete\\s*\\(\\s*${message}\\s*\\)|\\bcontext\\s*\\.\\s*complete\\s*\\(`).test(code);
  const deadLetter = new RegExp(`\\.deadLetter\\s*\\(\\s*${message}\\b|\\bcontext\\s*\\.\\s*deadLetter\\s*\\(`).test(code);
  const abandon = new RegExp(`\\.abandon\\s*\\(\\s*${message}\\s*\\)|\\bcontext\\s*\\.\\s*abandon\\s*\\(`).test(code);
  const deserialization = /\.fromJson\s*\(|\.readValue\s*\(/.test(code);
  const ordering = code.search(/\.fromJson\s*\(|\.readValue\s*\(/) < code.search(/\.complete\s*\(|context\s*\.\s*complete/);
  const reactive = !asynchronous || /\.flatMap|\.concatMap|Mono</.test(code);
  return complete && deadLetter && abandon && deserialization && ordering && reactive;
}

function processing(value, asynchronous) {
  for (const method of value.graph.reachable) {
    const own = activeBody(method.body);
    if (
      asynchronous
        ? !(
            /\.acceptNextSession\s*\(/.test(own) &&
            /\.receiveMessages\s*\(/.test(own) &&
            !/\.(?:send|publish)\w*\s*\(/.test(own)
          )
        : !(/\.sessionProcessor\s*\(/.test(own) && /\.processMessage\s*\(/.test(own))
    ) continue;
    const code = closure(method, value.graph.byName)
      .map((candidate) => activeBody(candidate.body)).join("\n");
    if (asynchronous) {
      if (
        /\.sessionReceiver\s*\(/.test(value.reachableCode) &&
        /\.buildAsyncClient\s*\(/.test(value.reachableCode) &&
        /\.acceptNextSession\s*\(/.test(code) &&
        /\.receiveMessages\s*\(/.test(code) &&
        sameMessageSettlement(code, true)
      ) return true;
    } else if (
      /\.sessionProcessor\s*\(/.test(code) &&
      /\.processMessage\s*\(/.test(code) &&
      /\.processError\s*\(/.test(code) &&
      /\.disableAutoComplete\s*\(/.test(code) &&
      /\.buildProcessorClient\s*\(/.test(code) &&
      sameMessageSettlement(code, false)
    ) return true;
  }
  return false;
}

function reprocessing(value, asynchronous) {
  for (const method of value.graph.reachable) {
    const own = activeBody(method.body);
    if (!/\.fromJson\s*\(|\.readValue\s*\(/.test(own)) continue;
    const message = /(?:for\s*\(\s*ServiceBusReceivedMessage\s+(\w+)|concatMap\s*\(\s*(\w+)\s*->)/.exec(
      own,
    );
    const messageName = message?.[1] ?? message?.[2];
    const orderName = messageName
      ? new RegExp(`\\b(\\w+)\\s*=\\s*Order\\.fromJson\\s*\\([^;]*\\b${messageName}\\b`).exec(
        own,
      )?.[1]
      : null;
    const send = orderName
      ? new RegExp(`\\.(?:send|publish)\\w*\\s*\\(\\s*${orderName}\\s*\\)`).exec(own)?.index ?? -1
      : -1;
    const complete = messageName
      ? new RegExp(`\\.complete\\s*\\(\\s*${messageName}\\s*\\)`).exec(own)?.index ?? -1
      : -1;
    const deadLetterClient =
      /SubQueue\s*\.\s*DEAD_LETTER_QUEUE/.test(value.reachableCode);
    const client = asynchronous
      ? deadLetterClient &&
        /\.buildAsyncClient\s*\(/.test(value.reachableCode) &&
        /\.acceptNextSession\s*\(/.test(own)
      : deadLetterClient &&
        /\.buildClient\s*\(/.test(value.reachableCode) &&
        /\.acceptNextSession\s*\(/.test(own);
    if (
      client &&
      send >= 0 &&
      complete > send &&
      compatible(branchContexts(own, [send, complete]))
    ) return true;
  }
  return false;
}

function errorClassification(value) {
  return value.graph.reachable.some((method) => {
    const code = closure(method, value.graph.byName)
      .map((candidate) => activeBody(candidate.body)).join("\n");
    return (
      /ServiceBusErrorContext|ServiceBusException/.test(code) &&
      /\.getEntityPath\s*\(/.test(code) &&
      /\.getErrorSource\s*\(/.test(code) &&
      /\.getException\s*\(|\.getMessage\s*\(/.test(code) &&
      (/\.isTransient\s*\(/.test(code) || /\.getReason\s*\(/.test(code)) &&
      /System\s*\.\s*err\s*\./.test(code)
    );
  });
}

function connectedDemo(value, state) {
  if (!Object.values(state).every(Boolean)) return false;
  const main = value.graph.reachable.find((method) => method.isMain);
  if (!main) return false;
  const code = activeBody(main.body);
  const methodKinds = (asynchronous) => {
    const choose = (predicate) => value.graph.reachable.find((method) =>
      predicate(activeBody(method.body)))?.name;
    return asynchronous
      ? [
          choose((body) => /\breturn\b[\s\S]*\.sendMessage\s*\(/.test(body)),
          choose((body) =>
            /^\s*return\s+\w+\.createMessageBatch\s*\(\s*\)/.test(body)
          ),
          choose((body) => /\.acceptNextSession\s*\(/.test(body) &&
            /\.receiveMessages\s*\(/.test(body) &&
            !/\.(?:send|publish)\w*\s*\(/.test(body)),
          choose((body) => /\.acceptNextSession\s*\(/.test(body) &&
            /\.(?:send|publish)\w*\s*\(/.test(body)),
        ]
      : [
          choose((body) => /\.sendMessage\s*\(/.test(body) &&
            !/\breturn\b[\s\S]*\.sendMessage\s*\(/.test(body)),
          choose((body) => /\bServiceBusMessageBatch\b/.test(body)),
          choose((body) => /\.start\s*\(\s*\)/.test(body) &&
            /\.stop\s*\(\s*\)/.test(body)),
          choose((body) => /\btry\s*\(\s*ServiceBusReceiverClient\b/.test(body)),
        ];
  };
  const syncNames = methodKinds(false);
  const asyncNames = methodKinds(true);
  if ([...syncNames, ...asyncNames].some((name) => !name)) return false;
  let cursor = -1;
  for (const name of syncNames) {
    cursor = code.indexOf(`.${name}(`, cursor + 1);
    if (cursor < 0) return false;
  }
  for (const name of asyncNames) {
    cursor = code.indexOf(`.${name}(`, cursor + 1);
    if (cursor < 0) return false;
  }
  return (
    value.source.includes('"SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE"') &&
    value.source.includes('"SERVICE_BUS_QUEUE_NAME"') &&
    /new\s+ManagedIdentityCredentialBuilder\s*\(\s*\)\s*\.build\s*\(\s*\)/.test(code) &&
    (code.match(/\.block\s*\(/g) ?? []).length >= 4 &&
    (/\btry\s*\(/.test(code) || (code.match(/\.close\s*\(/g) ?? []).length >= 4)
  );
}

const rules = {
  "prompt/sdk-dependencies": (workspace) => exactDependencies(workspace.build ?? ""),
  "prompt/order-model": (_, value) => value.types && orderModel(value),
  "prompt/sync-sender": (_, value) => value.types && sender(value, false),
  "prompt/async-sender": (_, value) => value.types && sender(value, true),
  "prompt/sync-processing-settlement": (_, value) => value.types && processing(value, false),
  "prompt/async-processing-settlement": (_, value) => value.types && processing(value, true),
  "prompt/dead-letter-reprocessing": (_, value) =>
    value.types && reprocessing(value, false) && reprocessing(value, true),
  "prompt/error-classification": (_, value) => value.types && errorClassification(value),
  "prompt/connected-demo": (_, value) => value.types && connectedDemo(value, {
    model: orderModel(value),
    syncSender: sender(value, false),
    asyncSender: sender(value, true),
    syncProcessing: processing(value, false),
    asyncProcessing: processing(value, true),
    reprocessing: reprocessing(value, false) && reprocessing(value, true),
    errors: errorClassification(value),
  }),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  if (!(workspace.sourceFiles?.length > 0 || workspace.source?.trim())) return false;
  return rule(workspace, name === "prompt/sdk-dependencies" ? null : facts(workspace));
}

export function ruleNames() {
  return Object.keys(rules);
}
