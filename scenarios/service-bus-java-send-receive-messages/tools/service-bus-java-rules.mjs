const EXPECTED_ENVIRONMENT = {
  connection: "SERVICE_BUS_CONNECTION_STRING",
  queue: "SERVICE_BUS_QUEUE_NAME",
  topic: "SERVICE_BUS_TOPIC_NAME",
  subscription: "SERVICE_BUS_SUBSCRIPTION_NAME",
};

const SDK_TYPES = {
  ServiceBusClientBuilder: "com.azure.messaging.servicebus",
  ServiceBusMessage: "com.azure.messaging.servicebus",
  ServiceBusMessageBatch: "com.azure.messaging.servicebus",
  ServiceBusProcessorClient: "com.azure.messaging.servicebus",
  ServiceBusReceivedMessage: "com.azure.messaging.servicebus",
  ServiceBusReceiverClient: "com.azure.messaging.servicebus",
  ServiceBusSenderClient: "com.azure.messaging.servicebus",
  ServiceBusReceiveMode: "com.azure.messaging.servicebus.models",
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskJava(source, preserveStrings = true) {
  let result = "";
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        state = "code";
        result += "\n";
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
    if (state === "text-block") {
      if (source.startsWith('"""', index)) {
        result += preserveStrings ? '"""' : "   ";
        index += 2;
        state = "code";
      } else {
        result += preserveStrings
          ? character
          : character === "\n"
            ? "\n"
            : " ";
      }
      continue;
    }
    if (state === "string" || state === "character") {
      if (character === "\\") {
        result += preserveStrings
          ? `${character}${source[index + 1] ?? ""}`
          : "  ";
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        result += preserveStrings ? character : " ";
        state = "code";
      } else {
        result += preserveStrings
          ? character
          : character === "\n"
            ? "\n"
            : " ";
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
    } else if (source.startsWith('"""', index)) {
      result += preserveStrings ? '"""' : "   ";
      index += 2;
      state = "text-block";
    } else if (character === '"') {
      result += preserveStrings ? character : " ";
      state = "string";
    } else if (character === "'") {
      result += preserveStrings ? character : " ";
      state = "character";
    } else {
      result += character;
    }
  }
  return result;
}

function matchingIndex(text, start, opening = "(", closing = ")") {
  if (start < 0 || text[start] !== opening) {
    return -1;
  }
  let depth = 0;
  let state = "code";
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (state !== "code") {
      if (character === "\\") {
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') {
      state = "string";
    } else if (character === "'") {
      state = "character";
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitTopLevel(text, delimiter = ",") {
  const parts = [];
  let start = 0;
  let state = "code";
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state !== "code") {
      if (character === "\\") {
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') {
      state = "string";
    } else if (character === "'") {
      state = "character";
    } else if (character in depth) {
      depth[character] += 1;
    } else if (character in closing) {
      depth[closing[character]] -= 1;
    } else if (
      character === delimiter &&
      Object.values(depth).every((value) => value === 0)
    ) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function unwrap(expression) {
  let value = expression.trim();
  while (value.startsWith("(")) {
    const close = matchingIndex(value, 0);
    if (close !== value.length - 1) {
      break;
    }
    value = value.slice(1, -1).trim();
  }
  return value;
}

function statementEnd(text, start) {
  let state = "code";
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (state !== "code") {
      if (character === "\\") {
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') {
      state = "string";
    } else if (character === "'") {
      state = "character";
    } else if (character in depth) {
      depth[character] += 1;
    } else if (character in closing) {
      depth[closing[character]] -= 1;
    } else if (
      character === ";" &&
      Object.values(depth).every((value) => value === 0)
    ) {
      return index;
    }
  }
  return text.length;
}

function removeConstantDeadCode(body) {
  const characters = [...body];
  for (const match of body.matchAll(
    /\b(?:if|while)\s*\(\s*false\s*\)\s*\{/g,
  )) {
    const open = body.indexOf("{", match.index);
    const close = matchingIndex(body, open, "{", "}");
    if (close === -1) {
      continue;
    }
    for (let index = match.index; index <= close; index += 1) {
      if (characters[index] !== "\n") {
        characters[index] = " ";
      }
    }
  }
  const code = characters.join("");
  let depth = 0;
  let state = "code";
  let statementStart = 0;
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (state !== "code") {
      if (character === "\\") {
        index += 1;
      } else if (
        (state === "string" && character === '"') ||
        (state === "character" && character === "'")
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') {
      state = "string";
    } else if (character === "'") {
      state = "character";
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        statementStart = index + 1;
      }
    } else if (character === ";" && depth === 0) {
      const statement = code.slice(statementStart, index).trim();
      if (/^(?:return|throw)\b/.test(statement)) {
        return code.slice(0, index + 1);
      }
      statementStart = index + 1;
    }
  }
  return code;
}

function parameterNames(parameters) {
  if (!parameters.trim()) {
    return [];
  }
  return splitTopLevel(parameters).map((parameter) =>
    /([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?\s*$/.exec(
      parameter
        .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, "")
        .replace(/\bfinal\b/g, ""),
    )?.[1]
  ).filter(Boolean);
}

function parseMethods(code) {
  const methods = [];
  const pattern =
    /(?:^|[;{}])\s*(?:(?:public|protected|private|static|final|synchronized|native|abstract|strictfp)\s+)*(?:<[^;{}()]+>\s*)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*(?:\s*<[^;{}()]+>)?(?:\s*\[\s*\])?\s+([A-Za-z_$][\w$]*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^{}]+)?\{/gm;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    if (["if", "for", "while", "switch", "catch", "try"].includes(match[1])) {
      continue;
    }
    const open = code.indexOf("{", match.index + match[0].lastIndexOf("{"));
    const close = matchingIndex(code, open, "{", "}");
    if (close === -1) {
      continue;
    }
    methods.push({
      id: methods.length,
      name: match[1],
      parameters: parameterNames(match[2]),
      body: removeConstantDeadCode(code.slice(open + 1, close)),
      start: match.index,
    });
    pattern.lastIndex = close + 1;
  }
  return methods;
}

function directCalls(body, names) {
  const calls = [];
  for (const name of names) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "g");
    let match;
    while ((match = pattern.exec(body)) !== null) {
      const open = body.indexOf("(", match.index);
      const close = matchingIndex(body, open);
      if (close !== -1) {
        calls.push({
          name,
          arguments: splitTopLevel(body.slice(open + 1, close)),
          position: match.index,
        });
        pattern.lastIndex = close + 1;
      }
    }
  }
  return calls.sort((left, right) => left.position - right.position);
}

function activeContexts(methods) {
  const methodsByName = new Map();
  for (const method of methods) {
    const candidates = methodsByName.get(method.name) ?? [];
    candidates.push(method);
    methodsByName.set(method.name, candidates);
  }
  const contexts = [];
  const queue = (methodsByName.get("main") ?? []).map((method) => ({
    id: `main:${method.id}`,
    method,
    parent: null,
    bindings: new Map(),
    depth: 0,
  }));
  const visited = new Set();
  while (queue.length > 0) {
    const context = queue.shift();
    const signature =
      `${context.method.id}:` +
      [...context.bindings.values()].map((binding) => binding.expression).join("|");
    if (visited.has(signature) || context.depth > 12) {
      continue;
    }
    visited.add(signature);
    contexts.push(context);
    for (const call of directCalls(context.method.body, methodsByName.keys())) {
      const candidate = (methodsByName.get(call.name) ?? []).find(
        (method) => method.parameters.length === call.arguments.length,
      );
      if (!candidate || candidate.name === "main") {
        continue;
      }
      const bindings = new Map();
      candidate.parameters.forEach((parameter, index) => {
        bindings.set(parameter, {
          context,
          expression: call.arguments[index] ?? "",
        });
      });
      queue.push({
        id: `${context.id}>${candidate.id}@${call.position}`,
        method: candidate,
        parent: context,
        bindings,
        depth: context.depth + 1,
      });
    }
  }
  return { contexts, methodsByName };
}

function assignmentRecords(body) {
  const records = new Map();
  const pattern =
    /\b(?:(?:public|protected|private|static|final|volatile|transient)\s+)*(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;={}()]+>)?(?:\s*\[\s*\])?|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const end = statementEnd(body, pattern.lastIndex);
    records.set(match[1], {
      expression: body.slice(pattern.lastIndex, end).trim(),
      position: match.index,
    });
    pattern.lastIndex = end + 1;
  }

  for (const match of body.matchAll(
    /(?:^|[;{}])\s*(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
  )) {
    if (!records.has(match[1])) {
      records.set(match[1], {
        expression: match[2].trim(),
        position: match.index,
      });
    }
  }
  return records;
}

function assignmentHistory(body) {
  const records = new Map();
  const add = (name, expression, position) => {
    const entries = records.get(name) ?? [];
    entries.push({ expression: expression.trim(), position });
    records.set(name, entries);
  };
  const declarations =
    /\b(?:(?:public|protected|private|static|final|volatile|transient)\s+)*(?:[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;={}()]+>)?(?:\s*\[\s*\])?|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let declaration;
  while ((declaration = declarations.exec(body)) !== null) {
    const end = statementEnd(body, declarations.lastIndex);
    add(
      declaration[1],
      body.slice(declarations.lastIndex, end),
      declaration.index,
    );
    declarations.lastIndex = end + 1;
  }
  for (const match of body.matchAll(
    /(?:^|[;{}])\s*(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
  )) {
    add(match[1], match[2], match.index);
  }
  for (const entries of records.values()) {
    entries.sort((left, right) => left.position - right.position);
  }
  return records;
}

function returnExpressions(method) {
  return Array.from(
    method.body.matchAll(/\breturn\s+([^;]+);/g),
    (match) => match[1].trim(),
  );
}

function callInfo(expression, methodName) {
  const pattern = new RegExp(`\\.\\s*${escapeRegExp(methodName)}\\s*\\(`, "g");
  const match = pattern.exec(expression);
  if (!match) {
    return null;
  }
  const open = expression.indexOf("(", match.index);
  const close = matchingIndex(expression, open);
  if (close === -1) {
    return null;
  }
  return {
    receiver: expression.slice(0, match.index).trim(),
    arguments: splitTopLevel(expression.slice(open + 1, close)),
    suffix: expression.slice(close + 1).trim(),
    start: match.index,
    end: close + 1,
  };
}

function lastCallInfo(expression, methodName) {
  let found = null;
  const pattern = new RegExp(`\\.\\s*${escapeRegExp(methodName)}\\s*\\(`, "g");
  let match;
  while ((match = pattern.exec(expression)) !== null) {
    const open = expression.indexOf("(", match.index);
    const close = matchingIndex(expression, open);
    if (close === -1) {
      break;
    }
    found = {
      receiver: expression.slice(0, match.index).trim(),
      arguments: splitTopLevel(expression.slice(open + 1, close)),
      suffix: expression.slice(close + 1).trim(),
      start: match.index,
      end: close + 1,
    };
    pattern.lastIndex = close + 1;
  }
  return found;
}

function literal(expression) {
  const match = /^"((?:\\.|[^"\\])*)"$/.exec(unwrap(expression));
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return null;
  }
}

function createResolver(contexts, methodsByName, fields) {
  const assignments = new Map(
    contexts.map((context) => [context.id, assignmentRecords(context.method.body)]),
  );
  const histories = new Map(
    contexts.map((context) => [context.id, assignmentHistory(context.method.body)]),
  );
  const cache = new Map();
  let nextObject = 0;

  const resolve = (
    context,
    expression,
    seen = new Set(),
    position = Number.POSITIVE_INFINITY,
  ) => {
    const value = unwrap(expression);
    if (!value) {
      return null;
    }
    const stringValue = literal(value);
    if (stringValue !== null) {
      return { kind: "string", value: stringValue };
    }
    if (/^-?\d+$/.test(value)) {
      return { kind: "number", value: Number(value) };
    }
    if (boundedDuration(value)) {
      return { kind: "duration", bounded: true };
    }
    const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value);
    if (reference) {
      const name = reference[1];
      const record = (histories.get(context.id)?.get(name) ?? [])
        .filter((candidate) => candidate.position < position)
        .at(-1);
      const key = `${context.id}:${name}:${record?.position ?? position}`;
      if (cache.has(key)) {
        return cache.get(key);
      }
      if (seen.has(key)) {
        return null;
      }
      const nextSeen = new Set(seen).add(key);
      if (record) {
        const resolved = resolve(
          context,
          record.expression,
          nextSeen,
          record.position,
        );
        if (resolved && !resolved.id) {
          resolved.id = key;
        }
        cache.set(key, resolved);
        return resolved;
      }
      const binding = context.bindings.get(name);
      if (binding) {
        const resolved = resolve(
          binding.context,
          binding.expression,
          nextSeen,
        );
        cache.set(key, resolved);
        return resolved;
      }
      const field = fields.get(name);
      if (field) {
        const resolved = resolve(context, field.expression, nextSeen);
        cache.set(key, resolved);
        return resolved;
      }
      return null;
    }

    const getenv =
      /\bSystem\s*\.\s*getenv\s*\(\s*([^()]+)\s*\)/.exec(value);
    if (getenv) {
      const name = resolve(context, getenv[1], seen);
      return name?.kind === "string"
        ? { kind: "environment", name: name.value }
        : null;
    }

    const helperCall =
      /^(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(
        value,
      );
    if (helperCall && methodsByName.has(helperCall[1])) {
      const argumentsList = splitTopLevel(helperCall[2]);
      const method = (methodsByName.get(helperCall[1]) ?? []).find(
        (candidate) => candidate.parameters.length === argumentsList.length,
      );
      if (method) {
        const bindings = new Map();
        method.parameters.forEach((parameter, index) => {
          bindings.set(parameter, {
            context,
            expression: argumentsList[index] ?? "",
          });
        });
        const child = {
          id: `${context.id}:return:${method.id}:${value}`,
          method,
          parent: context,
          bindings,
        };
        assignments.set(child.id, assignmentRecords(method.body));
        histories.set(child.id, assignmentHistory(method.body));
        for (const returned of returnExpressions(method)) {
          const resolved = resolve(child, returned, seen);
          if (resolved) {
            return resolved;
          }
        }
      }
    }

    if (/\bnew\s+ServiceBusClientBuilder\s*\(\s*\)/.test(value)) {
      const configured = callInfo(value, "connectionString");
      return {
        kind: "root-builder",
        authentic: true,
        connection: configured
          ? resolve(context, configured.arguments[0] ?? "", seen)
          : null,
      };
    }

    for (const kind of ["sender", "receiver", "processor"]) {
      const selected = callInfo(value, kind);
      if (!selected) {
        continue;
      }
      const root = resolve(context, selected.receiver, seen);
      if (root?.kind !== "root-builder" || !root.authentic) {
        return null;
      }
      const queue = callInfo(value.slice(selected.end), "queueName");
      const topic = callInfo(value.slice(selected.end), "topicName");
      const subscription = callInfo(
        value.slice(selected.end),
        "subscriptionName",
      );
      const receiveMode = callInfo(value.slice(selected.end), "receiveMode");
      const maxWaitTime = callInfo(value.slice(selected.end), "maxWaitTime");
      const built =
        kind === "processor"
          ? /\.buildProcessorClient\s*\(\s*\)/.test(value)
          : /\.buildClient\s*\(\s*\)/.test(value);
      if (!built) {
        return null;
      }
      return {
        kind: `${kind}-client`,
        id: `object:${++nextObject}`,
        root,
        queue: queue
          ? resolve(context, queue.arguments[0] ?? "", seen)
          : null,
        topic: topic
          ? resolve(context, topic.arguments[0] ?? "", seen)
          : null,
        subscription: subscription
          ? resolve(context, subscription.arguments[0] ?? "", seen)
          : null,
        peekLock: Boolean(
          receiveMode &&
          /(?:ServiceBusReceiveMode\s*\.\s*)?PEEK_LOCK/.test(
            receiveMode.arguments[0] ?? "",
          ),
        ),
        autoCompleteDisabled:
          kind !== "processor" ||
          /\.disableAutoComplete\s*\(\s*\)/.test(value),
        boundedWait: Boolean(
          maxWaitTime &&
          (
            boundedDuration(maxWaitTime.arguments[0] ?? "") ||
            resolve(
              context,
              maxWaitTime.arguments[0] ?? "",
              seen,
            )?.kind === "duration"
          ),
        ),
        expression: value,
        context,
      };
    }

    if (/\bnew\s+ServiceBusMessage\s*\(/.test(value)) {
      const start = value.search(/\bnew\s+ServiceBusMessage\s*\(/);
      const open = value.indexOf("(", start);
      const close = matchingIndex(value, open);
      return {
        kind: "message",
        id: `object:${++nextObject}`,
        body: value.slice(open + 1, close).trim(),
      };
    }

    const batch = lastCallInfo(value, "createMessageBatch");
    if (batch) {
      const sender = resolve(context, batch.receiver, seen);
      return sender?.kind === "sender-client"
        ? {
            kind: "batch",
            id: `batch:${context.id}:${position}`,
            origin: position,
            sender,
          }
        : null;
    }

    const received = lastCallInfo(value, "receiveMessages");
    if (received) {
      const receiver = resolve(context, received.receiver, seen);
      const count = resolve(
        context,
        received.arguments[0] ?? "",
        seen,
      );
      const wait = resolve(
        context,
        received.arguments[1] ?? "",
        seen,
      );
      return receiver?.kind === "receiver-client"
        ? {
            bounded:
              (
                positiveInteger(received.arguments[0] ?? "") ||
                (count?.kind === "number" && count.value > 0)
              ) &&
              (
                boundedDuration(received.arguments[1] ?? "") ||
                wait?.kind === "duration" ||
                receiver.boundedWait
              ),
            kind: "received-stream",
            id: `object:${++nextObject}`,
            maxCount: count?.kind === "number" ? count.value : null,
            receiver,
          }
        : null;
    }

    if (/\bnew\s+CountDownLatch\s*\(\s*[1-9]\d*\s*\)/.test(value)) {
      return { kind: "signal", id: `object:${++nextObject}` };
    }

    return null;
  };

  const configureRootMutations = () => {
    for (const context of contexts) {
      const records = assignments.get(context.id);
      for (const name of records?.keys() ?? []) {
        const root = resolve(context, name);
        if (root?.kind !== "root-builder" || root.connection) {
          continue;
        }
        const mutation = new RegExp(
          `\\b${escapeRegExp(name)}\\s*\\.\\s*connectionString\\s*\\(([^;)]+)\\)`,
        ).exec(context.method.body);
        if (mutation) {
          root.connection = resolve(context, mutation[1]);
        }
      }
    }
  };
  configureRootMutations();
  return {
    assignments,
    resolve(context, expression, position = Number.POSITIVE_INFINITY) {
      return resolve(context, expression, new Set(), position);
    },
  };
}

function fieldAssignments(source, methods) {
  const fields = new Map();
  const pattern =
    /\b(?:(?:public|protected|private|static|final|volatile|transient)\s+)+(?:[A-Za-z_$][\w$]*(?:\s*<[^;={}()]+>)?)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (!methods.some((method) => method.start <= match.index &&
      match.index <= method.start + method.body.length)) {
      fields.set(match[1], { expression: match[2].trim() });
    }
  }
  return fields;
}

function sdkProvenance(code) {
  const imports = new Set(
    Array.from(
      code.matchAll(
        /\bimport\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$*][\w$*]*)*)\s*;/g,
      ),
      (match) => match[1].replace(/\s+/g, ""),
    ),
  );
  const localTypes = new Set(
    Array.from(
      code.matchAll(/\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/g),
      (match) => match[1],
    ),
  );
  return Object.entries(SDK_TYPES).every(([name, packageName]) =>
    !localTypes.has(name) &&
    (imports.has(`${packageName}.${name}`) ||
      imports.has(`${packageName}.*`) ||
      code.includes(`${packageName}.${name}`))
  );
}

function sameEnvironment(value, expected) {
  return value?.kind === "environment" && value.name === expected;
}

function positiveInteger(expression) {
  return /^[1-9]\d*$/.test(unwrap(expression).replaceAll("_", ""));
}

function boundedDuration(expression) {
  return /^Duration\s*\.\s*of(?:Millis|Seconds|Minutes)\s*\(\s*[1-9][\d_]*\s*\)$/.test(
    unwrap(expression),
  );
}

function allClientValues(analysis) {
  const values = [];
  for (const context of analysis.contexts) {
    for (const name of analysis.resolver.assignments.get(context.id)?.keys() ?? []) {
      const value = analysis.resolver.resolve(context, name);
      if (/-client$/.test(value?.kind ?? "")) {
        values.push({ name, value, context });
      }
    }
  }
  return values;
}

function callsIn(context, methodName) {
  const calls = [];
  const pattern = new RegExp(
    `\\b((?:this\\s*\\.\\s*)?[A-Za-z_$][\\w$]*)\\s*\\.\\s*${escapeRegExp(methodName)}\\s*\\(`,
    "g",
  );
  let match;
  while ((match = pattern.exec(context.method.body)) !== null) {
    const open = context.method.body.indexOf("(", match.index);
    const close = matchingIndex(context.method.body, open);
    if (close !== -1) {
      calls.push({
        receiverName: match[1].replace(/\s+/g, "").replace(/^this\./, ""),
        receiver: context.resolver.resolve(context, match[1], match.index),
        arguments: splitTopLevel(
          context.method.body.slice(open + 1, close),
        ),
        position: match.index,
        end: close + 1,
      });
      pattern.lastIndex = close + 1;
    }
  }
  return calls;
}

function queueSenders(analysis) {
  return analysis.clients.filter(({ value }) =>
    value.kind === "sender-client" &&
    sameEnvironment(value.queue, EXPECTED_ENVIRONMENT.queue) &&
    !value.topic
  );
}

function queueReceivers(analysis) {
  return analysis.clients.filter(({ value }) =>
    value.kind === "receiver-client" &&
    sameEnvironment(value.queue, EXPECTED_ENVIRONMENT.queue) &&
    !value.topic &&
    value.peekLock
  );
}

function messageSends(analysis, methodName) {
  return analysis.contexts.flatMap((context) =>
    callsIn({ ...context, resolver: analysis.resolver }, methodName).map(
      (call) => ({
        ...call,
        context,
        argument: analysis.resolver.resolve(
          context,
          call.arguments[0] ?? "",
          call.position,
        ),
      }),
    )
  );
}

function loopBodies(body) {
  const loops = [];
  const pattern = /\bfor\s*\(([^)]*)\)\s*\{/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const open = body.indexOf("{", match.index);
    const close = matchingIndex(body, open, "{", "}");
    if (close !== -1) {
      loops.push({
        header: match[1],
        body: body.slice(open + 1, close),
        bodyStart: open + 1,
        end: close,
        start: match.index,
      });
      pattern.lastIndex = close + 1;
    }
  }
  return loops;
}

function integerConstants(source) {
  const constants = new Map();
  for (const match of source.matchAll(
    /\b(?:static\s+)?final\s+(?:int|long)\s+(\w+)\s*=\s*(-?\d+)\s*;/g,
  )) {
    constants.set(match[1], Number(match[2]));
  }
  return constants;
}

function exactIterations(header, count, constants) {
  const parts = header.split(";");
  if (parts.length !== 3) {
    return false;
  }
  const initialized = parts[0].trim().match(
    /^(?:int|long|var)\s+(\w+)\s*=\s*([A-Z_]\w*|-?\d+)$/,
  );
  if (!initialized) {
    return false;
  }
  const [, variable, startText] = initialized;
  const compared = parts[1].trim().match(
    /^(\w+)\s*(<=|>=|<|>)\s*([A-Z_]\w*|-?\d+)$/,
  );
  if (!compared || compared[1] !== variable) {
    return false;
  }
  const number = (text) =>
    /^-?\d+$/.test(text) ? Number(text) : constants.get(text);
  const start = number(startText);
  const bound = number(compared[3]);
  const escaped = escapeRegExp(variable);
  const increasing = new RegExp(
    `^(?:${escaped}\\+\\+|\\+\\+${escaped}|${escaped}\\s*\\+=\\s*1)$`,
  ).test(parts[2].trim());
  const decreasing = new RegExp(
    `^(?:${escaped}--|--${escaped}|${escaped}\\s*-=\\s*1)$`,
  ).test(parts[2].trim());
  if (start === undefined || bound === undefined) {
    return false;
  }
  if (increasing && ["<", "<="].includes(compared[2])) {
    return bound - start + (compared[2] === "<=" ? 1 : 0) === count;
  }
  if (decreasing && [">", ">="].includes(compared[2])) {
    return start - bound + (compared[2] === ">=" ? 1 : 0) === count;
  }
  return false;
}

function regionAlwaysTerminates(body) {
  const code = maskJava(body, true);
  const branchIds = [...code.matchAll(/\bif\s*\(/g)].map(
    (match) => match.index,
  );
  const terminations = [...code.matchAll(/\b(?:throw|return)\b/g)].map(
    (match) => ({
      guards: javaBranchGuards(body, match.index),
      position: match.index,
    }),
  );
  if (terminations.length === 0) return false;
  if (branchIds.length > 16) return false;
  for (let mask = 0; mask < 2 ** branchIds.length; mask += 1) {
    const path = new Map(
      branchIds.map((id, index) => [id, Boolean(mask & (1 << index))]),
    );
    if (
      !terminations.some(({ guards }) =>
        [...guards].every(([id, side]) => path.get(id) === side)
      )
    ) {
      return false;
    }
  }
  return true;
}

function failureBranchThrows(body, conditionPattern) {
  const condition = conditionPattern.exec(body);
  if (!condition) {
    return false;
  }
  const open = body.indexOf("(", condition.index);
  const close = matchingIndex(body, open);
  if (close === -1) {
    return false;
  }
  let cursor = close + 1;
  while (/\s/.test(body[cursor] ?? "")) {
    cursor += 1;
  }
  if (body[cursor] === "{") {
    const end = matchingIndex(body, cursor, "{", "}");
    return end !== -1 &&
      regionAlwaysTerminates(body.slice(cursor + 1, end));
  }
  return /^(?:throw|return)\b[^;]*;/.test(body.slice(cursor));
}

function batchPopulation(analysis, batchEntry, send) {
  const constants = integerConstants(analysis.code);
  for (const context of analysis.contexts) {
    if (send.context.id !== context.id) {
      continue;
    }
    const latestCreation = batchEntry.value.origin;
    for (const loop of loopBodies(context.method.body)) {
      if (
        loop.start >= send.position ||
        latestCreation === undefined ||
        loop.start <= latestCreation ||
        !exactIterations(loop.header, 5, constants)
      ) {
        continue;
      }
      const aliases = assignmentRecords(loop.body);
      for (const [messageName, record] of aliases) {
        const message = analysis.resolver.resolve(
          {
            ...context,
            id: `${context.id}:loop:${loop.start}`,
            method: { ...context.method, body: loop.body },
          },
          record.expression,
        );
        if (message?.kind !== "message" || !message.body) {
          continue;
        }
        const addition = new RegExp(
          `\\b(\\w+)\\s*\\.\\s*tryAddMessage\\s*\\(\\s*${escapeRegExp(messageName)}\\s*\\)`,
        ).exec(loop.body);
        if (
          !addition ||
          analysis.resolver.resolve(
            context,
            addition[1],
            loop.bodyStart + addition.index,
          )?.id !==
            batchEntry.value.id
        ) {
          continue;
        }
        const batchAlias = addition[1];
        const direct = new RegExp(
          `if\\s*\\(\\s*!\\s*${escapeRegExp(batchAlias)}\\s*\\.\\s*tryAddMessage\\s*\\(\\s*${escapeRegExp(messageName)}\\s*\\)\\s*\\)`,
        );
        if (failureBranchThrows(loop.body, direct)) {
          if (
            ![...javaBranchGuards(context.method.body, loop.start)].every(
              ([id, side]) =>
                javaBranchGuards(context.method.body, send.position).get(id) ===
                  side,
            )
          ) {
            continue;
          }
          return true;
        }
        const result = new RegExp(
          `(?:boolean|Boolean|var)\\s+(\\w+)\\s*=\\s*${escapeRegExp(batchAlias)}\\s*\\.\\s*tryAddMessage\\s*\\(\\s*${escapeRegExp(messageName)}\\s*\\)`,
        ).exec(loop.body);
        if (
          result &&
          failureBranchThrows(
            loop.body,
            new RegExp(
              `if\\s*\\(\\s*!\\s*${escapeRegExp(result[1])}\\s*\\)`,
            ),
          )
        ) {
          if (
            ![...javaBranchGuards(context.method.body, loop.start)].every(
              ([id, side]) =>
                javaBranchGuards(context.method.body, send.position).get(id) ===
                  side,
            )
          ) {
            continue;
          }
          return true;
        }
      }
    }
  }
  return false;
}

function receivedLoops(analysis, receiverKind) {
  const results = [];
  for (const context of analysis.contexts) {
    const localAssignments = assignmentRecords(context.method.body);
    for (const loop of loopBodies(context.method.body)) {
      const enhanced = loop.header.match(
        /(?:ServiceBusReceivedMessage|var)\s+(\w+)\s*:\s*([\s\S]+)/,
      );
      if (!enhanced) {
        continue;
      }
      let stream = analysis.resolver.resolve(context, enhanced[2]);
      if (!stream && /^\w+$/.test(enhanced[2].trim())) {
        const record = localAssignments.get(enhanced[2].trim());
        stream = record
          ? analysis.resolver.resolve(context, record.expression)
          : null;
      }
      if (
        stream?.kind !== "received-stream" ||
        !stream.bounded ||
        !receiverKind(stream.receiver)
      ) {
        continue;
      }
      const nestedLoops = loopBodies(loop.body);
      const unconditionalBreak = [...loop.body.matchAll(/\bbreak\s*;/g)].some(
        (match) =>
          javaBranchGuards(loop.body, match.index).size === 0 &&
          !nestedLoops.some(
            (nested) =>
              nested.start < match.index && match.index < nested.end,
          ),
      );
      if (
        (stream.maxCount === null || stream.maxCount > 1) &&
        unconditionalBreak
      ) {
        continue;
      }
      const aliases = new Set([enhanced[1]]);
      for (const [name, record] of assignmentRecords(loop.body)) {
        if (aliases.has(unwrap(record.expression))) {
          aliases.add(name);
        }
      }
      const bodyReads = [];
      const settlements = [];
      for (const alias of aliases) {
        const bodyPattern = new RegExp(
          `\\b${escapeRegExp(alias)}\\s*\\.\\s*getBody\\s*\\(\\s*\\)`,
          "g",
        );
        for (const match of loop.body.matchAll(bodyPattern)) {
          if (javaPositionInsideExceptionalFlow(loop.body, match.index)) {
            continue;
          }
          const prefix = loop.body.slice(
            Math.max(0, match.index - 160),
            match.index,
          );
          if (/System\s*\.\s*out\s*\.\s*(?:print|println|printf)\s*\([^;]*$/.test(
            prefix,
          )) {
            bodyReads.push({ alias, position: match.index });
          } else {
            const assigned = Array.from(
              assignmentRecords(loop.body).entries(),
            ).find(([, record]) =>
              new RegExp(
                `\\b${escapeRegExp(alias)}\\s*\\.\\s*getBody\\s*\\(`,
              ).test(record.expression)
            );
            if (
              assigned &&
              new RegExp(
                `System\\s*\\.\\s*out\\s*\\.\\s*(?:print|println|printf)\\s*\\([^;]*\\b${escapeRegExp(assigned[0])}\\b`,
              ).test(loop.body)
            ) {
              bodyReads.push({ alias, position: match.index });
            }
          }
        }
        const completePattern = new RegExp(
          `\\b(\\w+)\\s*\\.\\s*(complete|abandon|deadLetter)` +
            `\\s*\\(\\s*${escapeRegExp(alias)}\\s*\\)`,
          "g",
        );
        for (const match of loop.body.matchAll(completePattern)) {
          if (javaPositionInsideExceptionalFlow(loop.body, match.index)) {
            continue;
          }
          const receiver = analysis.resolver.resolve(context, match[1]);
          settlements.push({
            alias,
            method: match[2],
            position: match.index,
            receiver,
          });
        }
      }
      results.push({
        stream,
        messageName: enhanced[1],
        bodyReads,
        settlements,
        body: loop.body,
      });
    }
  }
  return results;
}

function javaBranchGuards(body, position) {
  const code = maskJava(body, true);
  const guards = new Map();
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const conditionOpen = match.index + match[0].lastIndexOf("(");
    const conditionClose = matchingIndex(code, conditionOpen);
    if (conditionClose < 0) continue;
    let opening = conditionClose + 1;
    while (/\s/.test(code[opening] ?? "")) opening += 1;
    if (code[opening] !== "{") continue;
    const closing = matchingIndex(code, opening, "{", "}");
    if (opening < position && position < closing) {
      guards.set(match.index, true);
      continue;
    }
    let cursor = closing + 1;
    while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    if (code.slice(cursor, cursor + 4) !== "else") continue;
    cursor += 4;
    while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    if (code[cursor] !== "{") continue;
    const elseClose = matchingIndex(code, cursor, "{", "}");
    if (cursor < position && position < elseClose) {
      guards.set(match.index, false);
    }
  }
  return guards;
}

function javaPathsCompatible(left, right) {
  return [...left].every(
    ([id, side]) => !right.has(id) || right.get(id) === side,
  );
}

function javaPathCovers(prior, later) {
  return [...prior].every(([id, side]) => later.get(id) === side);
}

function javaPositionInsideExceptionalFlow(body, position) {
  const code = maskJava(body, true);
  for (const pattern of [
    /\bcatch\s*\([^)]*\)\s*\{/g,
    /\bfinally\s*\{/g,
  ]) {
    for (const match of code.matchAll(pattern)) {
      const opening = match.index + match[0].lastIndexOf("{");
      const closing = matchingIndex(code, opening, "{", "}");
      if (opening < position && position < closing) return true;
    }
  }
  return false;
}

function settlementFlowValid(flow) {
  const facts = flow.settlements.map((settlement) => ({
    ...settlement,
    guards: javaBranchGuards(flow.body, settlement.position),
  }));
  if (
    facts.some((left, index) =>
      facts.slice(index + 1).some((right) =>
        left.alias === right.alias &&
        left.receiver?.id === right.receiver?.id &&
        javaPathsCompatible(left.guards, right.guards)
      )
    )
  ) {
    return false;
  }
  return flow.bodyReads.some((read) =>
    facts.some(
      (settled) =>
        settled.method === "complete" &&
        settled.alias === read.alias &&
        settled.position > read.position &&
        settled.receiver?.id === flow.stream.receiver.id &&
        javaPathCovers(
          javaBranchGuards(flow.body, read.position),
          settled.guards,
        ),
    )
  );
}

function resolveHandler(analysis, context, argument) {
  const value = argument.trim();
  const arrow = value.indexOf("->");
  if (arrow !== -1) {
    const parameterText = value.slice(0, arrow).replace(/[()]/g, "").trim();
    return {
      parameter: parameterText.split(/\s+/).at(-1),
      body: value.slice(arrow + 2),
      context,
    };
  }
  const reference = /::\s*([A-Za-z_$][\w$]*)/.exec(value);
  if (reference) {
    const method = (analysis.methodsByName.get(reference[1]) ?? [])[0];
    if (!method) {
      return null;
    }
    const handlerContext =
      analysis.contexts.find((candidate) => candidate.method.id === method.id) ??
      {
        id: `handler:${method.id}`,
        method,
        parent: context,
        bindings: new Map(),
      };
    if (!analysis.resolver.assignments.has(handlerContext.id)) {
      analysis.resolver.assignments.set(
        handlerContext.id,
        assignmentRecords(method.body),
      );
    }
    return {
      parameter: method.parameters[0],
      body: method.body,
      context: handlerContext,
    };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    const record = analysis.resolver.assignments.get(context.id)?.get(value);
    return record
      ? resolveHandler(analysis, context, record.expression)
      : null;
  }
  return null;
}

function processorFacts(analysis) {
  const processors = analysis.clients.filter(
    ({ value }) =>
      value.kind === "processor-client" &&
      sameEnvironment(value.queue, EXPECTED_ENVIRONMENT.queue) &&
      value.peekLock,
  );
  return processors.map((entry) => {
    const expression = entry.value.expression;
    const messageCall = callInfo(expression, "processMessage");
    const errorCall = callInfo(expression, "processError");
    const messageHandler = messageCall
      ? resolveHandler(
          analysis,
          entry.value.context ?? entry.context,
          messageCall.arguments[0] ?? "",
        )
      : null;
    const errorHandler = errorCall
      ? resolveHandler(
          analysis,
          entry.value.context ?? entry.context,
          errorCall.arguments[0] ?? "",
        )
      : null;
    return { ...entry, messageHandler, errorHandler };
  });
}

function handlerIsValid(processor) {
  const message = processor.messageHandler;
  const error = processor.errorHandler;
  if (!message?.parameter || !error?.parameter) {
    return false;
  }
  const messageName = escapeRegExp(message.parameter);
  const messageAliases = new Set([message.parameter]);
  const errorAliases = new Set([error.parameter]);
  const receivedMessages = new Set();
  for (const [name, record] of assignmentRecords(message.body)) {
    if (
      [...messageAliases].some((alias) =>
        new RegExp(
          `^${escapeRegExp(alias)}\\s*\\.\\s*getMessage\\s*\\(\\s*\\)$`,
        ).test(record.expression)
      )
    ) {
      receivedMessages.add(name);
    }
    if (messageAliases.has(unwrap(record.expression))) {
      messageAliases.add(name);
    }
  }
  for (const [name, record] of assignmentRecords(error.body)) {
    if (errorAliases.has(unwrap(record.expression))) {
      errorAliases.add(name);
    }
  }
  const bodyPositions = [];
  const directMessageBody = new RegExp(
    `System\\s*\\.\\s*out\\s*\\.\\s*(?:print|println|printf)\\s*\\([\\s\\S]*?\\b${messageName}\\s*\\.\\s*getMessage\\s*\\(\\s*\\)\\s*\\.\\s*getBody\\s*\\(`,
    "g",
  );
  for (const match of message.body.matchAll(directMessageBody)) {
    if (!javaPositionInsideExceptionalFlow(message.body, match.index)) {
      bodyPositions.push(match.index);
    }
  }
  for (const alias of receivedMessages) {
    const aliasedMessageBody = new RegExp(
      `System\\s*\\.\\s*out\\s*\\.\\s*(?:print|println|printf)\\s*\\([\\s\\S]*?\\b${escapeRegExp(alias)}\\s*\\.\\s*getBody\\s*\\(`,
      "g",
    );
    for (const match of message.body.matchAll(aliasedMessageBody)) {
      if (!javaPositionInsideExceptionalFlow(message.body, match.index)) {
        bodyPositions.push(match.index);
      }
    }
  }
  const settlements = [];
  for (const alias of messageAliases) {
    const settle = new RegExp(
      `\\b${escapeRegExp(alias)}\\s*\\.\\s*(complete|abandon|deadLetter)` +
        `\\s*\\(`,
      "g",
    );
    for (const match of message.body.matchAll(settle)) {
      if (javaPositionInsideExceptionalFlow(message.body, match.index)) {
        continue;
      }
      settlements.push({
        alias,
        guards: javaBranchGuards(message.body, match.index),
        method: match[1],
        position: match.index,
      });
    }
  }
  if (
    settlements.some((left, index) =>
      settlements.slice(index + 1).some((right) =>
        left.alias === right.alias &&
        javaPathsCompatible(left.guards, right.guards)
      )
    )
  ) {
    return false;
  }
  const orderedCompletion = bodyPositions.some((bodyPosition) =>
    settlements.some(
      (settlement) =>
        settlement.method === "complete" &&
        settlement.position > bodyPosition &&
        javaPathCovers(
          javaBranchGuards(message.body, bodyPosition),
          settlement.guards,
        ),
    )
  );
  const reportsError = [...errorAliases].some((alias) =>
    new RegExp(
      `(?:System\\s*\\.\\s*err\\s*\\.\\s*(?:print|println|printf)\\s*\\([\\s\\S]*?\\b${escapeRegExp(alias)}\\s*\\.\\s*getException\\s*\\(|\\b${escapeRegExp(alias)}\\s*\\.\\s*getException\\s*\\(\\s*\\)\\s*\\.\\s*printStackTrace\\s*\\()`,
    ).test(error.body)
  );
  return (
    processor.value.autoCompleteDisabled &&
    orderedCompletion &&
    reportsError
  );
}

function rootConfigured(value) {
  return sameEnvironment(value?.root?.connection, EXPECTED_ENVIRONMENT.connection);
}

function processorLifecycle(analysis, processor) {
  const context = processor.context;
  const body = context.method.body;
  const name = processor.name;
  const start = body.search(
    new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*start\\s*\\(`),
  );
  const stop = body.search(
    new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*stop\\s*\\(`),
  );
  const close = body.search(
    new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*close\\s*\\(`),
  );
  if (
    !(start !== -1 && stop > start && close > stop) ||
    !stopAndCloseAreIndependent(body, name)
  ) {
    return false;
  }
  const middle = body.slice(start, stop);
  const wait = /\b(\w+)\s*\.\s*await\s*\(\s*(?:[1-9]\d*|[A-Z_]\w*)\s*,\s*TimeUnit\s*\.\s*\w+\s*\)/.exec(
    middle,
  );
  if (!wait) {
    return false;
  }
  const waitedSignal = analysis.resolver.resolve(context, wait[1]);
  if (waitedSignal?.kind !== "signal" || !processor.messageHandler) {
    return false;
  }
  const signalCalls = Array.from(
    processor.messageHandler.body.matchAll(
      /\b(\w+)\s*\.\s*(?:countDown|release)\s*\(\s*\)/g,
    ),
  );
  return signalCalls.some(
    (signal) =>
      analysis.resolver.resolve(
        processor.messageHandler.context,
        signal[1],
      )?.id === waitedSignal.id,
  );
}

function stopAndCloseAreIndependent(body, name) {
  const code = maskJava(body, true);
  for (const outer of code.matchAll(/\bfinally\s*\{/g)) {
    const outerOpen = outer.index + outer[0].lastIndexOf("{");
    const outerClose = matchingIndex(code, outerOpen, "{", "}");
    if (outerClose < 0) continue;
    const region = code.slice(outerOpen + 1, outerClose);
    const tryMatch = /\btry\s*\{/.exec(region);
    if (!tryMatch) continue;
    const tryOpen = outerOpen + 1 + tryMatch.index +
      tryMatch[0].lastIndexOf("{");
    const tryClose = matchingIndex(code, tryOpen, "{", "}");
    if (tryClose < 0) continue;
    let cursor = tryClose + 1;
    while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    const nested = /^finally\s*\{/.exec(code.slice(cursor));
    if (!nested) continue;
    const nestedOpen = cursor + nested[0].lastIndexOf("{");
    const nestedClose = matchingIndex(code, nestedOpen, "{", "}");
    const stopPattern = new RegExp(
      `\\b${escapeRegExp(name)}\\s*\\.\\s*stop\\s*\\(`,
    );
    const closePattern = new RegExp(
      `\\b${escapeRegExp(name)}\\s*\\.\\s*close\\s*\\(`,
    );
    if (
      nestedClose > nestedOpen &&
      stopPattern.test(code.slice(tryOpen + 1, tryClose)) &&
      closePattern.test(code.slice(nestedOpen + 1, nestedClose))
    ) {
      return true;
    }
  }
  return false;
}

function tryResourceNames(body) {
  const names = new Set();
  const pattern = /\btry\s*\(/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const open = body.indexOf("(", match.index);
    const close = matchingIndex(body, open);
    if (close === -1) {
      continue;
    }
    const resources = body.slice(open + 1, close);
    for (const resource of splitTopLevel(resources, ";")) {
      const declared = /\b([A-Za-z_$][\w$]*)\s*=/.exec(resource);
      if (declared) {
        names.add(declared[1]);
      } else if (/^[A-Za-z_$][\w$]*$/.test(resource.trim())) {
        names.add(resource.trim());
      }
    }
    pattern.lastIndex = close + 1;
  }
  return names;
}

function finallyClosed(body, name) {
  const pattern = /\bfinally\s*\{/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const open = body.indexOf("{", match.index);
    const close = matchingIndex(body, open, "{", "}");
    if (
      close !== -1 &&
      new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*close\\s*\\(`).test(
        body.slice(open + 1, close),
      )
    ) {
      return true;
    }
  }
  return false;
}

function clientsAreClosed(analysis) {
  const required = new Set(
    analysis.clients
      .filter(({ value }) => value.kind !== "processor-client")
      .map(({ value }) => value.id),
  );
  const closed = new Set();
  for (const context of analysis.contexts) {
    const resources = tryResourceNames(context.method.body);
    for (const name of analysis.resolver.assignments.get(context.id)?.keys() ?? []) {
      const value = analysis.resolver.resolve(context, name);
      if (
        /^(?:sender|receiver)-client$/.test(value?.kind ?? "") &&
        (resources.has(name) || finallyClosed(context.method.body, name))
      ) {
        closed.add(value.id);
      }
    }
  }
  return [...required].every((id) => closed.has(id));
}

function xmlTree(xml) {
  const root = { name: "#document", children: [], text: "" };
  const stack = [root];
  const tags = /<\s*(\/?)\s*([A-Za-z_][\w:.-]*)\b[^>]*?(\/?)\s*>/g;
  let cursor = 0;
  let match;
  while ((match = tags.exec(xml)) !== null) {
    stack.at(-1).text += xml.slice(cursor, match.index);
    cursor = tags.lastIndex;
    const name = match[2].split(":").at(-1);
    if (match[1]) {
      if (stack.length > 1 && stack.at(-1).name === name) {
        stack.pop();
      }
    } else {
      const node = { name, children: [], text: "" };
      stack.at(-1).children.push(node);
      if (!match[3]) {
        stack.push(node);
      }
    }
  }
  return root;
}

function child(node, name) {
  return node.children.find((candidate) => candidate.name === name);
}

function childText(node, name) {
  return child(node, name)?.text.trim() ?? "";
}

function compareVersions(left, right) {
  const leftParts = left.split(/[._-]/).map((part) => Number(part) || 0);
  const rightParts = right.split(/[._-]/).map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function jdkActivationIncludes17(declaration) {
  const value = declaration.trim();
  const range = /^([\[(])\s*([^,]*)\s*,\s*([^)\]]*)\s*([)\]])$/.exec(
    value,
  );
  if (range) {
    const lower =
      !range[2] ||
      compareVersions("17", range[2]) > 0 ||
      (range[1] === "[" && compareVersions("17", range[2]) === 0);
    const upper =
      !range[3] ||
      compareVersions("17", range[3]) < 0 ||
      (range[4] === "]" && compareVersions("17", range[3]) === 0);
    return lower && upper;
  }
  if (value.startsWith("!")) {
    return !"17".startsWith(value.slice(1).trim());
  }
  return "17".startsWith(value);
}

function activeMavenProfile(profile) {
  const activation = child(profile, "activation");
  if (!activation) {
    return false;
  }
  const conditions = [];
  const activeByDefault = childText(activation, "activeByDefault");
  if (activeByDefault) {
    conditions.push(activeByDefault.toLowerCase() === "true");
  }
  const jdk = childText(activation, "jdk");
  if (jdk) {
    conditions.push(jdkActivationIncludes17(jdk));
  }
  if (["property", "os", "file"].some((name) => child(activation, name))) {
    conditions.push(false);
  }
  return conditions.length > 0 && conditions.every(Boolean);
}

function activeMavenPackage(build) {
  const document = xmlTree(build.replace(/<!--[\s\S]*?-->/g, " "));
  return document.children
    .filter((node) => node.name === "project")
    .some((project) => {
      if (!["jar", "war", "ear"].includes(
        childText(project, "packaging") || "jar",
      )) {
        return false;
      }
      const activeProfiles = (
        child(project, "profiles")?.children ?? []
      ).filter(
        (node) => node.name === "profile" && activeMavenProfile(node),
      );
      const owners = [project, ...activeProfiles];
      const properties = new Map();
      for (const owner of owners) {
        for (const property of child(owner, "properties")?.children ?? []) {
          properties.set(property.name, property.text.trim());
        }
      }
      const resolve = (value) => {
        const property = /^\$\{([^}]+)\}$/.exec(value)?.[1];
        return property ? properties.get(property) ?? "" : value;
      };
      const dependencies = owners.flatMap((owner) =>
        (child(owner, "dependencies")?.children ?? []).filter(
          (node) => node.name === "dependency",
        )
      );
      const sdk = dependencies.some((dependency) =>
        childText(dependency, "groupId") === "com.azure" &&
        childText(dependency, "artifactId") ===
          "azure-messaging-servicebus" &&
        resolve(childText(dependency, "version")) === "7.17.20" &&
        !["test", "provided", "system"].includes(
          childText(dependency, "scope"),
        )
      );
      const release =
        properties.get("maven.compiler.release") ??
        properties.get("maven.compiler.source");
      return sdk && release === "17";
    });
}

function activeGradlePackage(build) {
  const code = build
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/\bif\s*\(\s*false\s*\)\s*\{[\s\S]*?\}/g, " ");
  const dependency =
    /\b(?:implementation|api|runtimeOnly)\s*(?:\(\s*)?["']com\.azure:azure-messaging-servicebus:7\.17\.20["']/.test(
      code,
    );
  const java17 =
    /(?:sourceCompatibility\s*=\s*(?:JavaVersion\.)?VERSION_17|JavaLanguageVersion\s*\.\s*of\s*\(\s*17\s*\)|jvmToolchain\s*\(\s*17\s*\))/.test(
      code,
    );
  return dependency && java17;
}

function hasPinnedPackage(build) {
  return activeMavenPackage(build) || activeGradlePackage(build);
}

export function analyzeWorkspace(workspace) {
  const source = workspace.source ?? "";
  const code = maskJava(source, true);
  const methods = parseMethods(code);
  const { contexts, methodsByName } = activeContexts(methods);
  const fields = fieldAssignments(code, methods);
  const resolver = createResolver(contexts, methodsByName, fields);
  const analysis = {
    code,
    source,
    methods,
    methodsByName,
    contexts,
    resolver,
    provenance: sdkProvenance(code),
  };
  analysis.clients = allClientValues(analysis);
  return analysis;
}

function environmentConfigured(analysis) {
  const values = [];
  for (const context of analysis.contexts) {
    for (const name of analysis.resolver.assignments.get(context.id)?.keys() ?? []) {
      const value = analysis.resolver.resolve(context, name);
      if (value?.kind === "environment") {
        values.push(value.name);
      }
    }
  }
  return (
    Object.values(EXPECTED_ENVIRONMENT).every((name) => values.includes(name)) &&
    analysis.clients.every(({ value }) => rootConfigured(value))
  );
}

function singleMessageSent(analysis) {
  const senders = new Set(queueSenders(analysis).map(({ value }) => value.id));
  return messageSends(analysis, "sendMessage").some(
    (send) =>
      senders.has(send.receiver?.id) &&
      send.argument?.kind === "message" &&
      Boolean(send.argument.body),
  );
}

function fiveMessageBatch(analysis) {
  const queueSenderIds = new Set(
    queueSenders(analysis).map(({ value }) => value.id),
  );
  const batches = [];
  for (const context of analysis.contexts) {
    for (const name of analysis.resolver.assignments.get(context.id)?.keys() ?? []) {
      const value = analysis.resolver.resolve(context, name);
      if (
        value?.kind === "batch" &&
        queueSenderIds.has(value.sender.id)
      ) {
        batches.push({ name, value, context });
      }
    }
  }
  const sends = messageSends(analysis, "sendMessages");
  const batchSends = sends.filter(
    (send) =>
      queueSenderIds.has(send.receiver?.id) &&
      send.argument?.kind === "batch",
  );
  return batchSends.length > 0 && batchSends.every((send) =>
    batches.some(
      (batch) =>
        batchPopulation(analysis, batch, send) &&
        send.receiver?.id === batch.value.sender.id &&
        send.argument?.id === batch.value.id,
    )
  );
}

function queueReceiveFlows(analysis) {
  return receivedLoops(
    analysis,
    (receiver) =>
      receiver.kind === "receiver-client" &&
      sameEnvironment(receiver.queue, EXPECTED_ENVIRONMENT.queue) &&
      !receiver.topic &&
      receiver.peekLock,
  );
}

function receiveBody(analysis) {
  return queueReceiveFlows(analysis).some(
    (flow) => flow.bodyReads.length > 0,
  );
}

function sameMessageSettlement(analysis) {
  return queueReceiveFlows(analysis).some(settlementFlowValid);
}

function hasProcessorHandlers(analysis) {
  return processorFacts(analysis).some(
    (processor) =>
      rootConfigured(processor.value) && handlerIsValid(processor),
  );
}

function topicSubscription(analysis) {
  const topicSenders = analysis.clients.filter(
    ({ value }) =>
      value.kind === "sender-client" &&
      sameEnvironment(value.topic, EXPECTED_ENVIRONMENT.topic) &&
      !value.queue,
  );
  const topicSenderIds = new Set(topicSenders.map(({ value }) => value.id));
  const topicSends = messageSends(analysis, "sendMessage").filter(
    (send) =>
      topicSenderIds.has(send.receiver?.id) &&
      send.argument?.kind === "message" &&
      Boolean(send.argument.body),
  );
  const queueMessageIds = new Set(
    messageSends(analysis, "sendMessage")
      .filter(
        (send) =>
          send.receiver?.kind === "sender-client" &&
          sameEnvironment(send.receiver.queue, EXPECTED_ENVIRONMENT.queue) &&
          !send.receiver.topic,
      )
      .map((send) => send.argument?.id)
      .filter(Boolean),
  );
  const flows = receivedLoops(
    analysis,
    (receiver) =>
      receiver.kind === "receiver-client" &&
      sameEnvironment(receiver.topic, EXPECTED_ENVIRONMENT.topic) &&
      sameEnvironment(
        receiver.subscription,
        EXPECTED_ENVIRONMENT.subscription,
      ) &&
      !receiver.queue &&
      receiver.peekLock,
  );
  return (
    topicSends.some((send) => !queueMessageIds.has(send.argument.id)) &&
    flows.some(settlementFlowValid)
  );
}

function clientLifecycle(analysis) {
  const processors = processorFacts(analysis).filter((processor) =>
    handlerIsValid(processor)
  );
  return (
    clientsAreClosed(analysis) &&
    processors.some((processor) => processorLifecycle(analysis, processor))
  );
}

const rules = {
  "prompt/sdk-package": ({ build }) => hasPinnedPackage(build),
  "prompt/environment-configuration": ({ analysis }) =>
    analysis.provenance && environmentConfigured(analysis),
  "prompt/single-message-send": ({ analysis }) =>
    analysis.provenance && singleMessageSent(analysis),
  "prompt/five-message-batch": ({ analysis }) =>
    analysis.provenance && fiveMessageBatch(analysis),
  "prompt/receive-body": ({ analysis }) =>
    analysis.provenance && receiveBody(analysis),
  "prompt/same-message-settlement": ({ analysis }) =>
    analysis.provenance && sameMessageSettlement(analysis),
  "prompt/processor-handlers": ({ analysis }) =>
    analysis.provenance && hasProcessorHandlers(analysis),
  "prompt/topic-subscription": ({ analysis }) =>
    analysis.provenance && topicSubscription(analysis),
  "prompt/client-lifecycle": ({ analysis }) =>
    analysis.provenance && clientLifecycle(analysis),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }
  const hasSource = Array.isArray(workspace.sourceFiles)
    ? workspace.sourceFiles.length > 0
    : Boolean(workspace.source?.trim());
  if (!hasSource) {
    return false;
  }
  return rule({
    ...workspace,
    build: workspace.build ?? "",
    analysis:
      name === "prompt/sdk-package" ? null : analyzeWorkspace(workspace),
  });
}

export function ruleNames() {
  return Object.keys(rules);
}
