import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

const sdkNamespaces = new Map([
  ["DefaultAzureCredential", "Azure.Identity"],
  ["ServiceBusClient", "Azure.Messaging.ServiceBus"],
  ["ServiceBusMessage", "Azure.Messaging.ServiceBus"],
  ["ServiceBusMessageBatch", "Azure.Messaging.ServiceBus"],
  ["ServiceBusProcessor", "Azure.Messaging.ServiceBus"],
  ["ServiceBusProcessorOptions", "Azure.Messaging.ServiceBus"],
  ["ServiceBusReceivedMessage", "Azure.Messaging.ServiceBus"],
  ["ServiceBusReceiver", "Azure.Messaging.ServiceBus"],
  ["ServiceBusSender", "Azure.Messaging.ServiceBus"],
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchingDelimiter(source, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close && --depth === 0) return index;
  }
  return -1;
}

function stripOuterParentheses(expression) {
  let result = expression.trim();
  while (result.startsWith("(")) {
    const close = matchingDelimiter(result, 0, "(", ")");
    if (close !== result.length - 1) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function splitArguments(source) {
  const result = [];
  let start = 0;
  const depth = { "(": 0, "[": 0, "{": 0, "<": 0 };
  const closes = { ")": "(", "]": "[", "}": "{", ">": "<" };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character in depth) depth[character] += 1;
    else if (character in closes) {
      depth[closes[character]] = Math.max(0, depth[closes[character]] - 1);
    } else if (
      character === "," &&
      Object.values(depth).every((value) => value === 0)
    ) {
      result.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = source.slice(start).trim();
  if (final) result.push(final);
  return result;
}

function namedArgument(expression) {
  const match = /^\s*(\w+)\s*:\s*([\s\S]+)$/.exec(expression);
  return match
    ? { name: match[1], expression: match[2].trim() }
    : { name: null, expression: expression.trim() };
}

function orderedArguments(rawArguments, names) {
  const values = new Array(names.length).fill(null);
  let positional = 0;
  for (const raw of rawArguments) {
    const argument = namedArgument(raw);
    let index;
    if (argument.name !== null) {
      index = names.findIndex(
        (name) => name.toLowerCase() === argument.name.toLowerCase(),
      );
      if (index < 0 || values[index] !== null) return null;
    } else {
      while (values[positional] !== null) positional += 1;
      index = positional++;
    }
    if (index >= values.length) return null;
    values[index] = argument.expression;
  }
  return values;
}

function bindHelperArguments(rawArguments, parameters) {
  const values = new Array(parameters.length).fill(null);
  let positional = 0;
  let sawNamed = false;

  for (const raw of rawArguments) {
    const argument = namedArgument(raw);
    let index;
    if (argument.name === null) {
      if (sawNamed) return null;
      index = positional++;
    } else {
      sawNamed = true;
      index = parameters.findIndex(
        (parameter) => parameter.name === argument.name,
      );
    }
    if (index < 0 || index >= values.length || values[index] !== null) {
      return null;
    }
    values[index] = { expression: argument.expression, usesDefault: false };
  }

  for (let index = 0; index < parameters.length; index += 1) {
    if (values[index] !== null) continue;
    const defaultExpression = parameters[index].defaultExpression;
    if (defaultExpression === null) return null;
    values[index] = { expression: defaultExpression, usesDefault: true };
  }
  return values;
}

function literalAwareCode(source) {
  const characters = [...dotnetCodeOnly(source)];
  const literals = new Map();
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      index += 1;
      state = "line-comment";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 1;
      state = "block-comment";
      continue;
    }
    if (character === "'") {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === "'") break;
      }
      continue;
    }
    if (character !== '"') continue;

    if (source.startsWith('"""', index)) {
      const close = source.indexOf('"""', index + 3);
      if (close >= 0) index = close + 2;
      continue;
    }
    const verbatim = source[index - 1] === "@";
    const interpolated =
      source[index - 1] === "$" ||
      (source[index - 1] === "@" && source[index - 2] === "$") ||
      (source[index - 1] === "$" && source[index - 2] === "@");
    const contentStart = index + 1;
    let value = "";
    let close = -1;
    for (let cursor = contentStart; cursor < source.length; cursor += 1) {
      if (verbatim && source[cursor] === '"' && source[cursor + 1] === '"') {
        value += '"';
        cursor += 1;
      } else if (!verbatim && source[cursor] === "\\") {
        value += source[cursor + 1] ?? "";
        cursor += 1;
      } else if (source[cursor] === '"') {
        close = cursor;
        break;
      } else {
        value += source[cursor];
      }
    }
    if (close < 0) continue;
    const width = close - contentStart;
    if (width > 0) {
      let marker = `L${literals.size}`.padEnd(width, "_").slice(0, width);
      if (interpolated) {
        const visible = [...marker];
        const raw = source.slice(contentStart, close);
        for (const match of raw.matchAll(/\{([^{}]+)\}/g)) {
          visible[match.index] = " ";
          for (let offset = 0; offset < match[1].length; offset += 1) {
            visible[match.index + 1 + offset] = match[1][offset];
          }
          visible[match.index + match[0].length - 1] = " ";
        }
        marker = visible.join("");
      }
      for (let offset = 0; offset < width; offset += 1) {
        characters[contentStart + offset] = marker[offset];
      }
      literals.set(marker, value);
    }
    index = close;
  }
  return { code: characters.join(""), literals };
}

function typeContext(code) {
  const aliases = new Map();
  const imports = new Set();
  for (const match of code.matchAll(
    /\b(?:global\s+)?using\s+(\w+)\s*=\s*((?:global::)?[\w.]+)\s*;/g,
  )) {
    aliases.set(match[1], match[2].replace(/^global::/, ""));
  }
  for (const match of code.matchAll(
    /\b(?:global\s+)?using\s+((?:global::)?[\w.]+)\s*;/g,
  )) {
    imports.add(match[1].replace(/^global::/, ""));
  }
  const localTypes = new Set(
    [...code.matchAll(
      /\b(?:class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+(\w+)/g,
    )].map((match) => match[1]),
  );
  return { aliases, imports, localTypes };
}

function canonicalType(type, types) {
  if (!type) return null;
  let normalized = type
    .replace(/\s+/g, "")
    .replace(/^global::/, "")
    .replace(/[?[\]]+$/g, "")
    .replace(/<[\s\S]*>$/, "");
  const first = normalized.split(/[.:]/)[0];
  if (types.aliases.has(first)) {
    normalized = normalized.replace(first, types.aliases.get(first));
  }
  if (types.aliases.has(normalized)) normalized = types.aliases.get(normalized);
  const simple = normalized.split(/[.:]/).at(-1);
  const namespace = sdkNamespaces.get(simple);
  if (!namespace) return null;
  if (normalized === `${namespace}.${simple}`) return simple;
  if (normalized !== simple) return null;
  return types.imports.has(namespace) && !types.localTypes.has(simple)
    ? simple
    : null;
}

function methodDefinitions(code) {
  const methods = new Map();
  const ranges = [];
  const typePattern =
    /\b(?:class|struct|record(?:\s+(?:class|struct))?)\s+(\w+)[^{;]*\{/g;
  for (const match of code.matchAll(typePattern)) {
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingDelimiter(code, open, "{", "}");
    if (close >= 0) ranges.push({ name: match[1], start: match.index, open, close });
  }
  const ownerAt = (index) =>
    ranges
      .filter((range) => range.open < index && index < range.close)
      .sort((left, right) => right.open - left.open)[0]?.name ?? null;
  const ignored = new Set([
    "catch", "for", "foreach", "if", "lock", "switch", "using", "while",
  ]);
  const pattern =
    /\b((?:(?:public|private|protected|internal|static|virtual|override|sealed|new|async|partial)\s+)*)(?:([\w.:<>\[\]?]+)\s+)?(\w+)\s*\(([^()]*)\)\s*(=>|\{)/g;
  let id = 0;
  for (const match of code.matchAll(pattern)) {
    if (ignored.has(match[3])) continue;
    const owner = ownerAt(match.index);
    const constructor = owner !== null && match[3] === owner && !match[2];
    if (!match[2] && !constructor) continue;
    const parameters = splitArguments(match[4]).map((parameter) => {
      const parsed =
        /(?:(?:this|ref|out|in|params)\s+)*([\w.:<>\[\]?]+)\s+(\w+)(?:\s*=\s*([\s\S]*))?$/.exec(
          parameter.trim(),
        );
      return {
        defaultExpression: parsed?.[3] ?? null,
        name: parsed?.[2] ?? null,
        type: parsed?.[1] ?? null,
      };
    }).filter(({ name }) => name !== null);
    let body;
    let bodyStart;
    let bodyEnd;
    if (match[5] === "{") {
      const open = match.index + match[0].lastIndexOf("{");
      const close = matchingDelimiter(code, open, "{", "}");
      if (close < 0) continue;
      body = code.slice(open + 1, close);
      bodyStart = open + 1;
      bodyEnd = close;
    } else {
      const start = match.index + match[0].length;
      let end = start;
      let depth = 0;
      for (; end < code.length; end += 1) {
        if (code[end] === "(") depth += 1;
        else if (code[end] === ")") depth -= 1;
        else if (code[end] === ";" && depth === 0) break;
      }
      body = `return ${code.slice(start, end)};`;
      bodyStart = start;
      bodyEnd = end;
    }
    const definition = {
      async: /\basync\b/.test(match[1]) ||
        /\b(?:Task|ValueTask)\b/.test(match[2] ?? ""),
      body,
      bodyEnd,
      bodyStart,
      id: ++id,
      name: match[3],
      owner,
      parameters,
      returnType: match[2] ?? owner,
      start: match.index,
    };
    const overloads = methods.get(definition.name) ?? [];
    overloads.push(definition);
    methods.set(definition.name, overloads);
  }
  return { methods, ranges };
}

class Environment {
  constructor(parent = null, receiver = null) {
    this.parent = parent;
    this.receiver = receiver ?? parent?.receiver ?? null;
    this.values = new Map();
  }

  declare(name, value) {
    this.values.set(name, value);
  }

  lookup(expression) {
    const normalized = expression.replace(/\s+/g, "").replace(/^this\./, "");
    if (!/^\w+(?:\.\w+)*$/.test(normalized)) return null;
    const parts = normalized.split(".");
    let value = null;
    for (let scope = this; scope && value === null; scope = scope.parent) {
      value = scope.values.get(parts[0]) ?? null;
    }
    if (value === null && this.receiver?.members) {
      value = this.receiver.members.get(parts[0]) ?? null;
    }
    for (const part of parts.slice(1)) {
      value = value?.members?.get(part) ?? null;
    }
    return value;
  }

  assign(expression, value) {
    const normalized = expression.replace(/\s+/g, "").replace(/^this\./, "");
    const parts = normalized.split(".");
    if (parts.length > 1) {
      const target = this.lookup(parts.slice(0, -1).join("."));
      target?.members?.set(parts.at(-1), value);
      return;
    }
    for (let scope = this; scope; scope = scope.parent) {
      if (scope.values.has(parts[0])) {
        scope.values.set(parts[0], value);
        return;
      }
    }
    if (this.receiver?.members) {
      this.receiver.members.set(parts[0], value);
    } else {
      this.values.set(parts[0], value);
    }
  }

  clone() {
    const result = new Environment(this.parent, this.receiver);
    result.values = new Map(this.values);
    return result;
  }
}

function unknown(type = null) {
  return { kind: "unknown", type };
}

function samePath(left = [], right = []) {
  const choices = new Map(left.map(({ id, choice }) => [id, choice]));
  return right.every(
    ({ id, choice }) => !choices.has(id) || choices.get(id) === choice,
  );
}

function pathCovers(prior = [], later = []) {
  const choices = new Map(later.map(({ id, choice }) => [id, choice]));
  return prior.every(
    ({ id, choice }) => choices.get(id) === choice,
  );
}

function event(state, context, details) {
  const recorded = {
    ...details,
    guaranteed: Boolean(context.guaranteed),
    loopCount: context.loopCount ?? null,
    guaranteeId: context.guaranteeId ?? null,
    origin: context.origin ?? "root",
    order: state.events.length,
    normalFlow: !context.exceptionalFlow,
    path: context.path ?? [],
  };
  state.events.push(recorded);
  return recorded;
}

function literalValue(expression, state) {
  const marker = /^(?:\$@|@\$|\$|@)?"([^"]+)"$/.exec(expression.trim())?.[1];
  return marker && state.literals.has(marker)
    ? { kind: "string", value: state.literals.get(marker) }
    : null;
}

function invocation(expression) {
  let value = stripOuterParentheses(expression.trim().replace(/!+$/, ""));
  let awaited = false;
  if (/^await\b/.test(value)) {
    awaited = true;
    value = stripOuterParentheses(value.replace(/^await\b/, "").trim());
  }
  const configured =
    /^([\s\S]+)\.\s*ConfigureAwait\s*\(\s*(?:true|false)\s*\)$/.exec(value);
  if (configured) value = configured[1];
  const match =
    /^((?:global::)?[A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*)*)\s*\(/.exec(
      value,
    );
  if (!match) return null;
  const open = value.indexOf("(", match.index);
  const close = matchingDelimiter(value, open, "(", ")");
  if (close < 0 || value.slice(close + 1).trim() !== "") return null;
  const path = match[1].replace(/::/g, ".");
  const parts = path.split(".");
  return {
    arguments: splitArguments(value.slice(open + 1, close)),
    awaited,
    method: parts.at(-1),
    receiver: parts.slice(0, -1).join("."),
  };
}

function constructor(expression, expectedType, state) {
  const value = stripOuterParentheses(expression);
  const match = /^new\s*([\w:.]+)?\s*(\(|\{)/.exec(value);
  if (!match) return null;
  const open = value.indexOf(match[2], match.index);
  const close = matchingDelimiter(
    value,
    open,
    match[2],
    match[2] === "(" ? ")" : "}",
  );
  if (close < 0) return null;
  const rawType = match[1] ?? expectedType;
  return {
    arguments:
      match[2] === "(" ? splitArguments(value.slice(open + 1, close)) : [],
    rawType,
    type: canonicalType(rawType, state.types),
  };
}

function stringIdentity(value) {
  return value?.kind === "string" && !value.fallback ? value.value : null;
}

function environmentIdentity(value) {
  const identity = stringIdentity(value);
  return identity?.startsWith("env:") ? identity : null;
}

function evaluateExpression(
  expression,
  expectedType,
  environment,
  state,
  context,
) {
  let value = stripOuterParentheses(namedArgument(expression).expression)
    .replace(/!+$/, "")
    .trim();
  const coalesce = value.indexOf("??");
  if (coalesce >= 0) {
    const left = evaluateExpression(
      value.slice(0, coalesce),
      expectedType,
      environment,
      state,
      context,
    );
    return left?.kind === "string"
      ? {
          ...left,
          fallback: !/^\s*throw\b/.test(value.slice(coalesce + 2)),
        }
      : left;
  }
  const literal = literalValue(value, state);
  if (literal) return literal;
  if (/^-?\d+$/.test(value)) {
    return { kind: "number", value: Number(value) };
  }
  const duration =
    /^TimeSpan\s*\.\s*From(?:Milliseconds|Seconds|Minutes)\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (duration) {
    const amount = evaluateExpression(
      duration[1],
      null,
      environment,
      state,
      context,
    );
    return {
      bounded: amount?.kind === "number" && amount.value > 0,
      kind: "duration",
    };
  }
  if (/^Timeout\s*\.\s*Infinite(?:TimeSpan)?$/.test(value)) {
    return { bounded: false, infinite: true, kind: "duration" };
  }
  if (/^Task\s*\.\s*CompletedTask$/.test(value)) {
    return { kind: "completed-task" };
  }
  if (
    /^Task\s*\.\s*From(?:Result|Exception|Canceled)\s*\(/.test(value)
  ) {
    return { kind: "completed-task" };
  }

  const environmentRead =
    /^(?:System\s*\.\s*)?Environment\s*\.\s*GetEnvironmentVariable\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (environmentRead) {
    const name = stringIdentity(
      evaluateExpression(
        environmentRead[1],
        null,
        environment,
        state,
        context,
      ),
    );
    return {
      fallback: false,
      kind: "string",
      value: name ? `env:${name}` : null,
    };
  }

  const body = /^([\s\S]+)\.\s*Body$/.exec(value);
  if (body) {
    const owner = evaluateExpression(
      body[1],
      null,
      environment,
      state,
      context,
    );
    return owner?.kind === "message"
      ? { kind: "body", messageId: owner.id }
      : unknown();
  }
  const messageProperty = /^([\s\S]+)\.\s*Message$/.exec(value);
  if (messageProperty) {
    const owner = evaluateExpression(
      messageProperty[1],
      null,
      environment,
      state,
      context,
    );
    return owner?.kind === "handler-args" ? owner.message : unknown();
  }
  const exceptionProperty = /^([\s\S]+)\.\s*(?:Exception|error)$/i.exec(value);
  if (exceptionProperty) {
    const owner = evaluateExpression(
      exceptionProperty[1],
      null,
      environment,
      state,
      context,
    );
    return owner?.kind === "error-args"
      ? { kind: "error-detail" }
      : unknown();
  }
  const conversion = /^([\s\S]+)\.\s*(?:ToString|ToArray)\s*\(\s*\)$/.exec(
    value,
  );
  if (conversion) {
    return evaluateExpression(
      conversion[1],
      null,
      environment,
      state,
      context,
    );
  }

  const reference = /^\s*(?:this\.)?\w+(?:\.\w+)*\s*$/.test(value)
    ? environment.lookup(value)
    : null;
  if (reference) return reference;

  const call = invocation(value);
  if (call) {
    return invoke(call, environment, state, context);
  }

  const created = constructor(value, expectedType, state);
  if (created) {
    if (created.type === "DefaultAzureCredential") {
      return { kind: "credential" };
    }
    if (created.type === "ServiceBusClient") {
      const args = orderedArguments(created.arguments, [
        "fullyqualifiednamespace",
        "credential",
        "options",
      ]);
      const namespace = args?.[0]
        ? environmentIdentity(
            evaluateExpression(args[0], null, environment, state, context),
          )
        : null;
      const credential = args?.[1]
        ? evaluateExpression(args[1], null, environment, state, context)
        : null;
      const object = {
        id: ++state.nextId,
        kind: "client",
        namespace,
        path: context.path ?? [],
        valid: namespace !== null && credential?.kind === "credential",
      };
      state.resources.push(object);
      return object;
    }
    if (created.type === "ServiceBusMessage") {
      const args = orderedArguments(created.arguments, ["body"]);
      const bodyValue = args?.[0]
        ? evaluateExpression(args[0], null, environment, state, context)
        : null;
      return {
        body: bodyValue?.kind !== "unknown",
        constructedLoopCount: context.loopCount ?? null,
        id: ++state.nextId,
        kind: "message",
      };
    }
    if (created.type === "ServiceBusProcessorOptions") {
      return {
        autoCompleteFalse: /AutoCompleteMessages\s*=\s*false/.test(value),
        kind: "processor-options",
      };
    }

    const raw = created.rawType?.replace(/^global::/, "").split(".").at(-1);
    if (raw && state.ranges.some((range) => range.name === raw)) {
      const object = {
        id: ++state.nextId,
        kind: "object",
        members: new Map(),
        type: raw,
      };
      const definitions = (state.methods.get(raw) ?? []).filter(
        (definition) =>
          definition.owner === raw &&
          definition.parameters.length === created.arguments.length,
      );
      for (const definition of definitions) {
        invokeHelper(
          {
            arguments: created.arguments,
            awaited: false,
            method: raw,
            receiverValue: object,
          },
          environment,
          state,
          context,
        );
      }
      return object;
    }
  }
  return unknown(canonicalType(expectedType, state.types) ?? expectedType);
}

function invoke(call, environment, state, context) {
  const receiver =
    call.receiverValue ?? environment.lookup(call.receiver);
  const method = call.method.replace(/Async$/, "");
  const asyncMethod = call.method.endsWith("Async");
  if (asyncMethod && !call.awaited) return unknown();

  if (receiver?.kind === "client" && receiver.valid) {
    if (method === "CreateSender") {
      const args = orderedArguments(call.arguments, ["queueortopicname"]);
      const entity = args?.[0]
        ? stringIdentity(
            evaluateExpression(args[0], null, environment, state, context),
          )
        : null;
      const sender = {
        clientId: receiver.id,
        entity,
        id: ++state.nextId,
        kind: "sender",
        path: context.path ?? [],
      };
      state.resources.push(sender);
      return sender;
    }
    if (method === "CreateReceiver") {
      const names =
        call.arguments.length > 1
          ? ["topicname", "subscriptionname", "options"]
          : ["queueName", "options"];
      const args = orderedArguments(
        call.arguments,
        names.map((name) => name.toLowerCase()),
      );
      const first = args?.[0]
        ? stringIdentity(
            evaluateExpression(args[0], null, environment, state, context),
          )
        : null;
      const second =
        call.arguments.length > 1 && args?.[1]
          ? stringIdentity(
              evaluateExpression(args[1], null, environment, state, context),
            )
          : null;
      const receiverObject = {
        clientId: receiver.id,
        entity: first,
        id: ++state.nextId,
        kind: "receiver",
        path: context.path ?? [],
        subscription: second,
      };
      state.resources.push(receiverObject);
      return receiverObject;
    }
    if (method === "CreateProcessor") {
      const names =
        call.arguments.length > 2
          ? ["topicname", "subscriptionname", "options"]
          : ["queueorsubscriptionname", "options"];
      const args = orderedArguments(call.arguments, names);
      const entity = args?.[0]
        ? stringIdentity(
            evaluateExpression(args[0], null, environment, state, context),
          )
        : null;
      const processor = {
        autoCompleteFalse:
          call.arguments.some((argument) =>
            /AutoCompleteMessages\s*=\s*false/.test(argument)
          ) ||
          call.arguments.some(
            (argument) =>
              evaluateExpression(
                argument,
                null,
                environment,
                state,
                context,
              )?.autoCompleteFalse,
          ),
        clientId: receiver.id,
        entity,
        errorHandler: null,
        id: ++state.nextId,
        kind: "processor",
        messageHandler: null,
        path: context.path ?? [],
        subscription:
          call.arguments.length > 2 && args?.[1]
            ? stringIdentity(
                evaluateExpression(args[1], null, environment, state, context),
              )
            : null,
      };
      state.resources.push(processor);
      return processor;
    }
  }

  if (receiver?.kind === "sender") {
    if (method === "CreateMessageBatch") {
      const batch = {
        id: ++state.nextId,
        kind: "batch",
        path: context.path ?? [],
        senderId: receiver.id,
      };
      state.resources.push(batch);
      return batch;
    }
    if (method === "SendMessage") {
      const message = call.arguments[0]
        ? evaluateExpression(
            call.arguments[0],
            "ServiceBusMessage",
            environment,
            state,
            context,
          )
        : null;
      if (message?.kind === "message") {
        event(state, context, {
          awaited: call.awaited,
          kind: "send-message",
          messageId: message.id,
          senderId: receiver.id,
        });
      }
      return unknown();
    }
    if (method === "SendMessages") {
      const value = call.arguments[0]
        ? evaluateExpression(
            call.arguments[0],
            null,
            environment,
            state,
            context,
          )
        : null;
      if (value?.kind === "batch") {
        event(state, context, {
          awaited: call.awaited,
          batchId: value.id,
          kind: "send-batch",
          senderId: receiver.id,
        });
      }
      return unknown();
    }
  }

  if (receiver?.kind === "batch" && method === "TryAddMessage") {
    const message = call.arguments[0]
      ? evaluateExpression(
          call.arguments[0],
          "ServiceBusMessage",
          environment,
          state,
          context,
        )
      : null;
    if (message?.kind === "message") {
      const addEvent = event(state, context, {
        batchId: receiver.id,
        constructedLoopCount: message.constructedLoopCount ?? null,
        handledFailure: Boolean(context.handledTryAdd),
        kind: "batch-add",
        messageBody: message.body,
        messageId: message.id,
      });
      return { event: addEvent, kind: "try-add-result" };
    }
    return { kind: "boolean", value: null };
  }

  if (receiver?.kind === "receiver") {
    if (method === "ReceiveMessage" || method === "ReceiveMessages") {
      const args = orderedArguments(
        call.arguments,
        method === "ReceiveMessage"
          ? ["maxwaittime", "cancellationtoken"]
          : ["maxmessages", "maxwaittime", "cancellationtoken"],
      );
      const count = method === "ReceiveMessage"
        ? { kind: "number", value: 1 }
        : args?.[0]
          ? evaluateExpression(
              args[0],
              null,
              environment,
              state,
              context,
            )
          : unknown();
      const boundedCount =
        count?.kind !== "number" || count.value > 0;
      const waitArgument = method === "ReceiveMessage" ? args?.[0] : args?.[1];
      const wait = waitArgument
        ? evaluateExpression(
            waitArgument,
            null,
            environment,
            state,
            context,
          )
        : null;
      const boundedWait = wait?.kind === "duration" && wait.bounded;
      const message = {
        id: ++state.nextId,
        kind: "message",
        receivedBy: receiver.id,
      };
      const receiveEvent = event(state, context, {
        awaited: call.awaited,
        bounded: boundedCount && boundedWait,
        coversAll: true,
        kind: "receive",
        maxCount: count?.kind === "number" ? count.value : null,
        messageId: message.id,
        receiverId: receiver.id,
      });
      return method === "ReceiveMessages"
        ? {
            items: [message],
            kind: "collection",
            maxCount: receiveEvent.maxCount,
            receiveEvent,
          }
        : message;
    }
    if (["CompleteMessage", "AbandonMessage", "DeadLetterMessage"].includes(method)) {
      const message = call.arguments[0]
        ? evaluateExpression(
            call.arguments[0],
            null,
            environment,
            state,
            context,
          )
        : null;
      if (message?.kind === "message") {
        event(state, context, {
          awaited: call.awaited,
          kind: "complete",
          messageId: message.id,
          receiverId: receiver.id,
          settlement: method,
        });
      }
      return unknown();
    }
  }

  if (
    receiver?.kind === "handler-args" &&
    ["CompleteMessage", "AbandonMessage", "DeadLetterMessage"].includes(method)
  ) {
    const message = call.arguments[0]
      ? evaluateExpression(
          call.arguments[0],
          null,
          environment,
          state,
          context,
        )
      : null;
    if (message?.kind === "message") {
      event(state, context, {
        awaited: call.awaited,
        handlerProcessorId: receiver.processorId,
        kind: "handler-complete",
        messageId: message.id,
        settlement: method,
      });
    }
    return unknown();
  }

  if (receiver?.kind === "processor") {
    if (method === "StartProcessing") {
      event(state, context, {
        awaited: call.awaited,
        kind: "processor-start",
        processorId: receiver.id,
      });
      return unknown();
    }
    if (method === "StopProcessing") {
      event(state, context, {
        awaited: call.awaited,
        kind: "processor-stop",
        processorId: receiver.id,
      });
      return unknown();
    }
  }

  if (
    ["client", "sender", "receiver", "processor"].includes(receiver?.kind) &&
    method === "Dispose"
  ) {
    event(state, context, {
      async: asyncMethod,
      awaited: call.awaited,
      kind: "dispose",
      resourceId: receiver.id,
    });
    return unknown();
  }
  if (receiver?.kind === "batch" && method === "Dispose") {
    event(state, context, {
      async: false,
      awaited: true,
      kind: "dispose",
      resourceId: receiver.id,
    });
    return unknown();
  }

  if (call.receiver === "Task" && method === "Delay") {
    const delay = call.arguments[0]
      ? evaluateExpression(
          call.arguments[0],
          null,
          environment,
          state,
          context,
        )
      : null;
    const cancellable = call.arguments.length > 1;
    const valid =
      delay?.kind === "duration"
        ? delay.bounded || (delay.infinite && cancellable)
        : delay?.kind === "number" && delay.value > 0;
    if (call.awaited) {
      event(state, context, {
        awaited: true,
        kind: "wait",
        valid,
      });
    }
    return { cancellable, kind: "wait-task", valid };
  }
  if (call.receiver === "Task" && method === "WhenAny") {
    const values = call.arguments.map((argument) =>
      evaluateExpression(argument, null, environment, state, context)
    );
    const cancellableWait = values.some(
      (candidate) =>
        candidate?.kind === "wait-task" &&
        candidate.cancellable &&
        candidate.valid,
    );
    const signal = values.some(
      (candidate) =>
        candidate?.kind !== "wait-task" &&
        candidate?.kind !== "completed-task",
    );
    event(state, context, {
      awaited: call.awaited,
      kind: "wait",
      valid: call.arguments.length >= 2 && cancellableWait && signal,
    });
    return unknown();
  }
  if (/(?:WaitForCancellation|WaitOne|ReadLine|ReadKey)/.test(call.method)) {
    event(state, context, {
      awaited: true,
      kind: "wait",
      valid: true,
    });
    return unknown();
  }

  return invokeHelper(call, environment, state, context);
}

function invokeHelper(call, environment, state, context) {
  const receiver =
    call.receiverValue ?? environment.lookup(call.receiver);
  const candidates = state.methods.get(call.method) ?? [];
  const definitions = candidates.flatMap((definition) => {
    const staticOwner = call.receiver?.split(".").at(-1);
    const ownerMatches = receiver?.kind === "object"
      ? definition.owner === receiver.type
      : definition.owner === null ||
        definition.owner === staticOwner ||
        (call.receiverValue && definition.owner === call.receiverValue.type);
    if (!ownerMatches) return [];
    const argumentsByParameter = bindHelperArguments(
      call.arguments,
      definition.parameters,
    );
    return argumentsByParameter === null
      ? []
      : [{ argumentsByParameter, definition }];
  });
  let result = unknown();
  for (const { argumentsByParameter, definition } of definitions) {
    if (definition.async && !call.awaited && definition.name !== definition.owner) {
      continue;
    }
    const activeKey = `${definition.id}:${receiver?.id ?? "static"}`;
    if (state.activeMethods.has(activeKey)) continue;
    const child = new Environment(
      null,
      receiver?.kind === "object" ? receiver : null,
    );
    definition.parameters.forEach((parameter, index) => {
      const argument = argumentsByParameter[index];
      child.declare(
        parameter.name,
        evaluateExpression(
          argument.expression,
          parameter.type,
          argument.usesDefault ? child : environment,
          state,
          context,
        ),
      );
    });
    state.activeMethods.add(activeKey);
    const flow = executeRegion(definition.body, child, state, {
      ...context,
      origin: `method:${definition.id}`,
    });
    state.activeMethods.delete(activeKey);
    if (flow.value) result = flow.value;
  }
  return result;
}

function processOutput(expression, environment, state, context) {
  const value = evaluateExpression(
    expression,
    null,
    environment,
    state,
    context,
  );
  if (value?.kind === "body") {
    event(state, context, {
      kind: "body-output",
      messageId: value.messageId,
    });
    return;
  }
  if (value?.kind === "error-detail") {
    event(state, context, { kind: "error-output" });
    return;
  }
  for (const match of expression.matchAll(
    /\b((?:this\.)?\w+(?:\.\w+)*)\s*\.\s*(?:Exception|error)\b/gi,
  )) {
    const owner = evaluateExpression(
      match[1],
      null,
      environment,
      state,
      context,
    );
    if (owner?.kind === "error-args") {
      event(state, context, { kind: "error-output" });
      return;
    }
  }
  for (const name of expression.match(/\b\w+\b/g) ?? []) {
    if (environment.lookup(name)?.kind === "error-detail") {
      event(state, context, { kind: "error-output" });
      return;
    }
  }
  for (const match of expression.matchAll(
    /\b((?:this\.)?\w+(?:\.\w+)*)\s*\.\s*Body\b/g,
  )) {
    const owner = environment.lookup(match[1]);
    if (owner?.kind === "message") {
      event(state, context, {
        kind: "body-output",
        messageId: owner.id,
      });
    } else {
      const bodyValue = evaluateExpression(
        `${match[1]}.Body`,
        null,
        environment,
        state,
        context,
      );
      if (bodyValue?.kind === "body") {
        event(state, context, {
          kind: "body-output",
          messageId: bodyValue.messageId,
        });
      }
    }
  }
}

function processStatement(statement, environment, state, context) {
  const text = statement.trim();
  if (!text) return { normal: true, value: null };
  if (/^return(?:\s|$)/.test(text)) {
    const returned = /^return\s+([\s\S]+)$/.exec(text)?.[1];
    event(state, context, { kind: "terminate" });
    return {
      normal: false,
      value: returned
        ? evaluateExpression(
            returned,
            null,
            environment,
            state,
            context,
          )
        : null,
    };
  }
  if (/^throw\b/.test(text)) {
    event(state, context, { kind: "terminate" });
    return { normal: false, value: null };
  }
  if (/^break\s*$/.test(text)) {
    return { break: true, normal: false, value: null };
  }

  const singleIf = /^if\s*\(([\s\S]+)\)\s*([\s\S]+)$/.exec(text);
  if (singleIf) {
    processTryAddCondition(
      singleIf[1],
      environment,
      state,
      { ...context, failureAborts: branchAborts(singleIf[2]) },
    );
    markHandledTryAdd(
      singleIf[1],
      environment,
      branchAborts(singleIf[2]),
    );
    return { normal: true, value: null };
  }

  const registration =
    /^((?:this\.)?\w+(?:\.\w+)*)\s*\.\s*(ProcessMessageAsync|ProcessErrorAsync)\s*\+=\s*([\s\S]+)$/.exec(
      text,
    );
  if (registration) {
    const processor = environment.lookup(registration[1]);
    if (processor?.kind === "processor") {
      const handler = registration[3].trim();
      if (handler.includes("=>")) {
        const arrow = handler.indexOf("=>");
        const parameter = handler
          .slice(0, arrow)
          .replace(/[()]/g, "")
          .trim()
          .split(/\s+/)
          .at(-1);
        processor[
          registration[2] === "ProcessMessageAsync"
            ? "messageHandler"
            : "errorHandler"
        ] = {
          body: handler.slice(arrow + 2).trim(),
          inline: true,
          parameter,
        };
      } else {
        processor[
          registration[2] === "ProcessMessageAsync"
            ? "messageHandler"
            : "errorHandler"
        ] = { inline: false, name: handler };
      }
      event(state, context, {
        handlerKind:
          registration[2] === "ProcessMessageAsync" ? "message" : "error",
        kind: "handler-register",
        processorId: processor.id,
      });
    }
    return { normal: true, value: null };
  }

  const output =
    /^(?:(?:System\s*\.\s*)?Console\s*\.\s*(?:Error\s*\.\s*)?(?:Write|WriteLine))\s*\(([\s\S]*)\)$/.exec(
      text,
    );
  if (output) {
    processOutput(output[1], environment, state, context);
    return { normal: true, value: null };
  }

  const declaration =
    /^(?:(?:public|private|protected|internal|static|readonly|required|volatile|new|unsafe|const|await|using)\s+)*(var|(?:global::)?[\w.:<>?[\]]+)\s+(\w+)\s*=\s*([\s\S]+)$/.exec(
      text,
    );
  if (declaration) {
    const explicitType = declaration[1] === "var" ? null : declaration[1];
    const binding = evaluateExpression(
      declaration[3],
      explicitType,
      environment,
      state,
      context,
    );
    environment.declare(declaration[2], binding);
    const structuredAsync =
      /\bawait\s+using\b/.test(text) &&
      ["client", "sender", "receiver", "processor"].includes(binding?.kind);
    const structuredSync =
      /\busing\b/.test(text) && binding?.kind === "batch";
    if (structuredAsync || structuredSync) {
      context.structuredResources?.push({
        async: structuredAsync,
        path: context.path ?? [],
        resourceId: binding.id,
      });
    }
    return { normal: true, value: null };
  }

  const assignment =
    /^((?:this\.)?\w+(?:\.\w+)*)\s*=\s*([\s\S]+)$/.exec(text);
  if (assignment) {
    environment.assign(
      assignment[1],
      evaluateExpression(
        assignment[2],
        environment.lookup(assignment[1])?.type ?? null,
        environment,
        state,
        context,
      ),
    );
    return { normal: true, value: null };
  }

  evaluateExpression(text, null, environment, state, context);
  return { normal: true, value: null };
}

function conditionValue(condition) {
  const normalized = stripOuterParentheses(condition)
    .replace(/\s+/g, "")
    .toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function loopCount(prefix, state) {
  const forHeader = /\bfor\s*\(([^;]*);([^;]*);([^)]*)\)/.exec(prefix);
  if (forHeader) {
    const initialized =
      /(?:int|long|var)\s+(\w+)\s*=\s*([A-Z_]\w*|-?\d+)/.exec(forHeader[1]);
    const compared =
      /(\w+)\s*(<|<=|>|>=)\s*([A-Z_]\w*|-?\d+)/.exec(forHeader[2]);
    if (!initialized || !compared || initialized[1] !== compared[1]) return null;
    const resolve = (expression) =>
      /^-?\d+$/.test(expression)
        ? Number(expression)
        : state.integerConstants.get(expression);
    const start = resolve(initialized[2]);
    const bound = resolve(compared[3]);
    if (start === undefined || bound === undefined) return null;
    const variable = escapeRegExp(initialized[1]);
    const up = new RegExp(
      `(?:${variable}\\+\\+|\\+\\+${variable}|${variable}\\s*\\+=\\s*1)`,
    ).test(forHeader[3]);
    const down = new RegExp(
      `(?:${variable}--|--${variable}|${variable}\\s*-=\\s*1)`,
    ).test(forHeader[3]);
    if (up && ["<", "<="].includes(compared[2])) {
      return bound - start + (compared[2] === "<=" ? 1 : 0);
    }
    if (down && [">", ">="].includes(compared[2])) {
      return start - bound + (compared[2] === ">=" ? 1 : 0);
    }
  }
  const range =
    /\bEnumerable\s*\.\s*Range\s*\(\s*[^,]+,\s*([A-Z_]\w*|\d+)\s*\)/.exec(
      prefix,
    );
  if (!range) return null;
  return /^\d+$/.test(range[1])
    ? Number(range[1])
    : state.integerConstants.get(range[1]) ?? null;
}

function statementEnd(source, start) {
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "(") parentheses += 1;
    else if (source[index] === ")") parentheses -= 1;
    else if (source[index] === "[") brackets += 1;
    else if (source[index] === "]") brackets -= 1;
    else if (
      source[index] === ";" &&
      parentheses === 0 &&
      brackets === 0
    ) {
      return index;
    }
  }
  return source.length;
}

function controlCondition(prefix, keyword) {
  const match = new RegExp(`^${keyword}\\b`).exec(prefix.trim());
  if (!match) return null;
  const open = prefix.indexOf("(", match.index + match[0].length);
  if (open < 0) return null;
  const close = matchingDelimiter(prefix, open, "(", ")");
  return close >= 0 ? prefix.slice(open + 1, close) : null;
}

function processTryAddCondition(
  condition,
  environment,
  state,
  context,
) {
  const handled =
    context.failureAborts &&
    (
      /!\s*[\w.]+\s*\.\s*TryAddMessage\s*\(/.test(condition) ||
      /TryAddMessage\s*\([^)]*\)\s*(?:==|is)\s*false/.test(condition)
    );
  const match = /([\w.]+)\s*\.\s*TryAddMessage\s*\(([\s\S]*)\)/.exec(
    condition,
  );
  if (!match) return;
  invoke(
    {
      arguments: [match[2]],
      awaited: false,
      method: "TryAddMessage",
      receiver: match[1],
    },
    environment,
    state,
    { ...context, handledTryAdd: handled },
  );
}

function branchGuards(source, position) {
  const guards = new Map();
  for (const match of source.matchAll(/\bif\s*\(/g)) {
    const conditionOpen = match.index + match[0].lastIndexOf("(");
    const conditionClose = matchingDelimiter(source, conditionOpen, "(", ")");
    if (conditionClose < 0) continue;
    let opening = conditionClose + 1;
    while (/\s/.test(source[opening] ?? "")) opening += 1;
    if (source[opening] !== "{") continue;
    const closing = matchingDelimiter(source, opening, "{", "}");
    if (opening < position && position < closing) {
      guards.set(match.index, true);
      continue;
    }
    let cursor = closing + 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (!/^else\b/.test(source.slice(cursor))) continue;
    cursor += source.slice(cursor).match(/^else\b/)[0].length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "{") continue;
    const elseClosing = matchingDelimiter(source, cursor, "{", "}");
    if (cursor < position && position < elseClosing) {
      guards.set(match.index, false);
    }
  }
  return guards;
}

function branchAborts(body) {
  const branchIds = [...body.matchAll(/\bif\s*\(/g)].map(
    (match) => match.index,
  );
  const terminations = [...body.matchAll(/\b(?:throw|return)\b/g)].map(
    (match) => branchGuards(body, match.index),
  );
  if (terminations.length === 0 || branchIds.length > 16) return false;
  for (let mask = 0; mask < 2 ** branchIds.length; mask += 1) {
    const path = new Map(
      branchIds.map((id, index) => [id, Boolean(mask & (1 << index))]),
    );
    if (
      !terminations.some((guards) =>
        [...guards].every(([id, side]) => path.get(id) === side)
      )
    ) {
      return false;
    }
  }
  return true;
}

function markHandledTryAdd(condition, environment, aborts) {
  if (!aborts) return;
  const match =
    /^\s*(?:!\s*(\w+)|(\w+)\s*(?:==|is)\s*false)\s*$/.exec(condition);
  const binding = match ? environment.lookup(match[1] ?? match[2]) : null;
  if (binding?.kind === "try-add-result") {
    binding.event.handledFailure = true;
  }
}

function executeRegion(source, environment, state, inherited = {}) {
  const structuredResources = [];
  const regionContext = { ...inherited, structuredResources };
  const finish = (flow) => {
    for (const resource of structuredResources.reverse()) {
      event(state, {
        guaranteed: true,
        path: resource.path,
      }, {
        async: resource.async,
        awaited: true,
        implicit: true,
        kind: "dispose",
        resourceId: resource.resourceId,
      });
    }
    return flow;
  };
  let cursor = 0;
  let lastIf = null;
  while (cursor < source.length) {
    while (cursor < source.length && /[\s;]/.test(source[cursor])) cursor += 1;
    if (cursor >= source.length) break;

    let parentheses = 0;
    let brackets = 0;
    let blockOpen = -1;
    let semicolon = -1;
    for (let index = cursor; index < source.length; index += 1) {
      const character = source[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") parentheses -= 1;
      else if (character === "[") brackets += 1;
      else if (character === "]") brackets -= 1;
      else if (
        character === "{" &&
        parentheses === 0 &&
        brackets === 0
      ) {
        blockOpen = index;
        break;
      } else if (
        character === ";" &&
        parentheses === 0 &&
        brackets === 0
      ) {
        semicolon = index;
        break;
      }
    }

    if (semicolon >= 0 && (blockOpen < 0 || semicolon < blockOpen)) {
      const statement = source.slice(cursor, semicolon);
      const flow = processStatement(
        statement,
        environment,
        state,
        regionContext,
      );
      if (!flow.normal) return finish(flow);
      cursor = semicolon + 1;
      lastIf = null;
      continue;
    }
    if (blockOpen < 0) break;

    const blockClose = matchingDelimiter(source, blockOpen, "{", "}");
    if (blockClose < 0) break;
    const prefix = source.slice(cursor, blockOpen).trim();
    const body = source.slice(blockOpen + 1, blockClose);
    const ifCondition = controlCondition(prefix, "if");
    const forCondition = controlCondition(prefix, "for");
    const foreachCondition = controlCondition(
      prefix.replace(/^await\s+/, ""),
      "foreach",
    );
    const whileCondition = controlCondition(prefix, "while");

    if (ifCondition !== null) {
      processTryAddCondition(
        ifCondition,
        environment,
        state,
        {
          ...regionContext,
          failureAborts: branchAborts(body),
        },
      );
      markHandledTryAdd(ifCondition, environment, branchAborts(body));
      const condition = conditionValue(ifCondition);
      const id = `branch:${state.nextBranch++}`;
      if (condition !== false) {
        const flow = executeRegion(body, environment.clone(), state, {
          ...regionContext,
          path:
            condition === null
              ? [...(regionContext.path ?? []), { choice: true, id }]
              : regionContext.path,
        });
        if (!flow.normal && condition === true) return finish(flow);
      }
      lastIf = { condition, id };
    } else if (
      /^((?:this\.)?\w+(?:\.\w+)*)\s*\.\s*(ProcessMessageAsync|ProcessErrorAsync)\s*\+=\s*[\s\S]+=>\s*$/.test(
        prefix,
      )
    ) {
      processStatement(
        `${prefix}{${body}}`,
        environment,
        state,
        regionContext,
      );
      lastIf = null;
    } else if (/^else\b/.test(prefix) && lastIf) {
      if (lastIf.condition !== true) {
        const flow = executeRegion(body, environment.clone(), state, {
          ...regionContext,
          path:
            lastIf.condition === null
              ? [
                  ...(regionContext.path ?? []),
                  { choice: false, id: lastIf.id },
                ]
              : inherited.path,
        });
        if (!flow.normal && lastIf.condition === false) return finish(flow);
      }
      lastIf = null;
    } else if (/^try\s*$/.test(prefix)) {
      const flow = executeRegion(body, environment, state, regionContext);
      if (!flow.normal) return finish(flow);
      lastIf = null;
    } else if (/^finally\s*$/.test(prefix)) {
      const flow = executeRegion(body, environment, state, {
        ...regionContext,
        exceptionalFlow: true,
        guaranteed: true,
        guaranteeId: `finally:${state.nextGuarantee++}`,
      });
      if (!flow.normal) return finish(flow);
      lastIf = null;
    } else if (/^catch\b/.test(prefix)) {
      lastIf = null;
    } else if (
      forCondition !== null ||
      foreachCondition !== null ||
      whileCondition !== null
    ) {
      const count = loopCount(prefix, state);
      const condition =
        whileCondition === null ? null : conditionValue(whileCondition);
      if (condition !== false) {
        const loopEnvironment = new Environment(environment);
        let collection = null;
        if (foreachCondition !== null) {
          const iteration = /^(?:var|[\w.:<>?[\]]+)\s+(\w+)\s+in\s+([\s\S]+)$/.exec(
            foreachCondition.trim(),
          );
          if (iteration) {
            collection = evaluateExpression(
              iteration[2],
              null,
              environment,
              state,
              regionContext,
            );
            if (collection?.kind === "collection") {
              loopEnvironment.declare(iteration[1], collection.items[0]);
            }
          }
        }
        const flow = executeRegion(body, loopEnvironment, state, {
          ...regionContext,
          loopCount: count,
        });
        if (collection?.kind === "collection") {
          collection.receiveEvent.coversAll =
            collection.maxCount !== null &&
              collection.maxCount <= 1
              ? true
              : !flow.break;
        }
      }
      lastIf = null;
    } else {
      const initializer =
        /=/.test(prefix) &&
        (/\bnew\b/.test(prefix) || /\bwith\s*$/.test(prefix));
      if (initializer) {
        const close = statementEnd(source, blockClose + 1);
        const fullStatement = source.slice(cursor, close);
        const flow = processStatement(
          fullStatement,
          environment,
          state,
          regionContext,
        );
        if (!flow.normal) return finish(flow);
        cursor = close + 1;
        lastIf = null;
        continue;
      }
      const flow = executeRegion(
        body,
        new Environment(environment),
        state,
        regionContext,
      );
      if (!flow.normal) return finish(flow);
      lastIf = null;
    }
    cursor = blockClose + 1;
  }
  return finish({ normal: true, value: null });
}

function maskRanges(source, ranges) {
  const characters = [...source];
  for (const range of ranges) {
    for (let index = range.start; index <= range.end; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

function analyze(source) {
  const { code, literals } = literalAwareCode(source);
  const types = typeContext(code);
  const { methods, ranges } = methodDefinitions(code);
  const state = {
    activeMethods: new Set(),
    code,
    events: [],
    literals,
    methods,
    integerConstants: new Map(
      [...code.matchAll(
        /\bconst\s+(?:int|long)\s+(\w+)\s*=\s*(-?\d+)\s*;/g,
      )].map((match) => [match[1], Number(match[2])]),
    ),
    nextBranch: 1,
    nextGuarantee: 1,
    nextId: 0,
    ranges,
    resources: [],
    types,
  };
  const methodRanges = [...methods.values()].flat()
    .filter((method) => method.owner === null)
    .map((method) => ({ start: method.start, end: method.bodyEnd }));
  const root = maskRanges(code, [
    ...ranges.map((range) => ({ start: range.start, end: range.close })),
    ...methodRanges,
  ]);
  executeRegion(root, new Environment(), state);
  for (const main of methods.get("Main") ?? []) {
    if (main.owner !== null && main.owner !== "Program") continue;
    const environment = new Environment();
    main.parameters.forEach((parameter) =>
      environment.declare(parameter.name, unknown(parameter.type)),
    );
    executeRegion(main.body, environment, state);
  }
  return state;
}

function executeMessageHandler(processor, analysis) {
  if (!processor.messageHandler) return [];
  const before = analysis.events.length;
  const message = { id: ++analysis.nextId, kind: "message" };
  const args = {
    kind: "handler-args",
    message,
    processorId: processor.id,
  };
  const handler = processor.messageHandler;
  if (handler.inline) {
    const environment = new Environment();
    environment.declare(handler.parameter, args);
    const body = handler.body;
    if (body.startsWith("{")) {
      const close = matchingDelimiter(body, 0, "{", "}");
      executeRegion(body.slice(1, close), environment, analysis);
    } else {
      processStatement(body, environment, analysis, {});
    }
  } else {
    const definitions = analysis.methods.get(handler.name) ?? [];
    for (const definition of definitions) {
      const environment = new Environment();
      definition.parameters.forEach((parameter, index) =>
        environment.declare(parameter.name, index === 0 ? args : unknown()),
      );
      executeRegion(definition.body, environment, analysis);
    }
  }
  return analysis.events.slice(before);
}

function executeErrorHandler(processor, analysis) {
  if (!processor.errorHandler) return [];
  const before = analysis.events.length;
  const args = { kind: "error-args", processorId: processor.id };
  const handler = processor.errorHandler;
  if (handler.inline) {
    const environment = new Environment();
    environment.declare(handler.parameter, args);
    const body = handler.body;
    if (body.startsWith("{")) {
      const close = matchingDelimiter(body, 0, "{", "}");
      executeRegion(body.slice(1, close), environment, analysis);
    } else {
      processStatement(body, environment, analysis, {});
    }
  } else {
    const definitions = analysis.methods.get(handler.name) ?? [];
    for (const definition of definitions) {
      const environment = new Environment();
      definition.parameters.forEach((parameter, index) =>
        environment.declare(parameter.name, index === 0 ? args : unknown()),
      );
      executeRegion(definition.body, environment, analysis);
    }
  }
  return analysis.events.slice(before);
}

function hasCompatibleSequence(events) {
  return events.every((event, index) =>
    events.slice(0, index).every((other) => samePath(event.path, other.path)),
  );
}

function eventApplies(candidate, path) {
  return candidate.path.every(
    ({ id, choice }) => path.get(id) === choice,
  );
}

function batchSendIsValid(analysis, send) {
  const adds = analysis.events.filter(
    (candidate) =>
      candidate.kind === "batch-add" &&
      candidate.batchId === send.batchId &&
      candidate.order < send.order,
  );
  const terminations = analysis.events.filter(
    (candidate) =>
      candidate.kind === "terminate" &&
      candidate.order < send.order &&
      candidate.origin === send.origin,
  );
  const branchIds = new Set([
    ...send.path.map(({ id }) => id),
    ...adds.flatMap(({ path }) => path.map(({ id }) => id)),
    ...terminations.flatMap(({ path }) => path.map(({ id }) => id)),
  ]);
  const ids = [...branchIds];
  let reached = false;
  for (let mask = 0; mask < 2 ** ids.length; mask += 1) {
    const path = new Map(
      ids.map((id, index) => [id, Boolean(mask & (1 << index))]),
    );
    if (!eventApplies(send, path)) continue;
    if (terminations.some((termination) => eventApplies(termination, path))) {
      continue;
    }
    reached = true;
    const pathAdds = adds.filter((add) => eventApplies(add, path));
    const exactFive =
      (
        pathAdds.length === 1 &&
        pathAdds[0].loopCount === 5 &&
        pathAdds[0].constructedLoopCount === 5 &&
        pathAdds[0].handledFailure &&
        pathAdds[0].messageBody
      ) ||
      (
        pathAdds.length === 5 &&
        new Set(pathAdds.map((add) => add.messageId)).size === 5 &&
        pathAdds.every(
          (add) =>
            add.loopCount === null &&
            add.handledFailure &&
            add.messageBody,
        )
      );
    if (!exactFive) return false;
  }
  return reached;
}

function hasCompatibleSecondSettlement(
  analysis,
  messageId,
  receiverId,
  handlerProcessorId = null,
) {
  const settlements = analysis.events.filter(
    (candidate) =>
      ["complete", "handler-complete"].includes(candidate.kind) &&
      candidate.messageId === messageId &&
      (
        handlerProcessorId === null
          ? candidate.receiverId === receiverId
          : candidate.handlerProcessorId === handlerProcessorId
      ),
  );
  return settlements.some((left, index) =>
    settlements.slice(index + 1).some((right) =>
      samePath(left.path, right.path)
    )
  );
}

function projectDocuments(project) {
  const withoutComments = project.replace(/<!--[\s\S]*?-->/g, " ");
  return [
    ...withoutComments.matchAll(
      /<(?:\w+:)?Project\b[^>]*>[\s\S]*?<\/(?:\w+:)?Project\s*>/gi,
    ),
  ].map((match) => match[0]);
}

function xmlAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(
    /\b([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g,
  )) {
    attributes.set(match[1].toLowerCase(), match[3].trim());
  }
  return attributes;
}

function xmlChildValue(source, name) {
  return new RegExp(
    String.raw`<(?:\w+:)?${name}\b[^>]*>([^<]*)<\/(?:\w+:)?${name}\s*>`,
    "i",
  ).exec(source)?.[1]?.trim();
}

function staticConditionValue(condition) {
  if (condition === undefined) return null;
  const normalized = condition.trim().replace(/["']/g, "").toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  const comparison = /^(true|false)\s*(==|!=)\s*(true|false)$/.exec(
    normalized,
  );
  if (!comparison) return null;
  const equal = comparison[1] === comparison[3];
  return comparison[2] === "==" ? equal : !equal;
}

function disabledAncestor(document, index) {
  const stack = [];
  const tags =
    /<\/?(?:\w+:)?(Project|PropertyGroup|ItemGroup|When|Otherwise)\b[^>]*>/gi;
  for (const match of document.matchAll(tags)) {
    if (match.index >= index) break;
    if (/^<\//.test(match[0])) stack.pop();
    else if (!/\/\s*>$/.test(match[0])) {
      stack.push(xmlAttributes(match[0]).get("condition"));
    }
  }
  return stack.some((condition) => staticConditionValue(condition) === false);
}

function disabledChooseBranch(document, index) {
  const stack = [];
  const choices = [];
  const tags = /<\/?(?:\w+:)?(Choose|When|Otherwise)\b[^>]*>/gi;
  for (const match of document.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    if (/^<\//.test(match[0])) {
      const position = stack.map(({ tag: name }) => name).lastIndexOf(tag);
      if (position < 0) continue;
      stack[position].end = match.index + match[0].length;
      stack.length = position;
      continue;
    }
    const node = {
      condition: xmlAttributes(match[0]).get("condition"),
      end: document.length,
      start: match.index,
      tag,
    };
    if (tag === "choose") {
      node.branches = [];
      choices.push(node);
    } else {
      [...stack]
        .reverse()
        .find(({ tag: name }) => name === "choose")
        ?.branches.push(node);
    }
    if (!/\/\s*>$/.test(match[0])) stack.push(node);
  }
  return choices.some((choice) => {
    if (!(choice.start <= index && index < choice.end)) return false;
    const branch = choice.branches.find(
      (candidate) => candidate.start <= index && index < candidate.end,
    );
    if (!branch) return false;
    let selected = false;
    for (const candidate of choice.branches) {
      if (candidate === branch) {
        return (
          selected ||
          (candidate.tag === "when" &&
            staticConditionValue(candidate.condition) === false)
        );
      }
      if (
        !selected &&
        candidate.tag === "when" &&
        staticConditionValue(candidate.condition) === true
      ) {
        selected = true;
      }
    }
    return false;
  });
}

function activeProperties(document) {
  const properties = new Map();
  for (const group of document.matchAll(
    /<(?:\w+:)?PropertyGroup\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?PropertyGroup\s*>/gi,
  )) {
    if (
      staticConditionValue(xmlAttributes(group[1]).get("condition")) ===
        false ||
      disabledAncestor(document, group.index) ||
      disabledChooseBranch(document, group.index)
    ) {
      continue;
    }
    for (const property of group[2].matchAll(
      /<(?:\w+:)?([A-Za-z_][\w.-]*)\b([^>]*)>([^<]*)<\/(?:\w+:)?\1\s*>/gi,
    )) {
      if (
        staticConditionValue(
          xmlAttributes(property[2]).get("condition"),
        ) === false ||
        disabledChooseBranch(
          document,
          group.index + group[0].indexOf(group[2]) + property.index,
        )
      ) {
        continue;
      }
      properties.set(property[1].toLowerCase(), property[3].trim());
    }
  }
  return properties;
}

function resolveMsbuildValue(value, properties, resolving = new Set()) {
  let unresolved = false;
  const result = value.replace(
    /\$\(([A-Za-z_][\w.-]*)\)/g,
    (_reference, propertyName) => {
      const key = propertyName.toLowerCase();
      if (resolving.has(key) || !properties.has(key)) {
        unresolved = true;
        return "";
      }
      const nested = resolveMsbuildValue(
        properties.get(key),
        properties,
        new Set([...resolving, key]),
      );
      if (nested === null) {
        unresolved = true;
        return "";
      }
      return nested;
    },
  );
  return unresolved || /\$\([^)]+\)/.test(result) ? null : result.trim();
}

function activePackageReferences(document, properties) {
  const references = [];
  for (const match of document.matchAll(
    /<(?:\w+:)?PackageReference\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?PackageReference\s*>)/gi,
  )) {
    const attributes = xmlAttributes(match[1]);
    const body = match[2] ?? "";
    const condition =
      attributes.get("condition") ?? xmlChildValue(body, "Condition");
    const excluded = (
      attributes.get("excludeassets") ??
      xmlChildValue(body, "ExcludeAssets") ??
      ""
    ).toLowerCase();
    if (
      staticConditionValue(condition) === false ||
      disabledAncestor(document, match.index) ||
      disabledChooseBranch(document, match.index) ||
      /(?:^|;)\s*(?:all|compile)\s*(?:;|$)/.test(excluded)
    ) {
      continue;
    }
    const include =
      attributes.get("include") ?? xmlChildValue(body, "Include");
    const version =
      attributes.get("version") ?? xmlChildValue(body, "Version");
    references.push({
      include: include ? resolveMsbuildValue(include, properties) : null,
      version: version ? resolveMsbuildValue(version, properties) : null,
    });
  }
  return references;
}

function hasRequiredManifest(project) {
  return projectDocuments(project).some((document) => {
    const properties = activeProperties(document);
    const targets = ["targetframework", "targetframeworks"].flatMap((name) => {
      const value = properties.get(name);
      const resolved = value
        ? resolveMsbuildValue(value, properties, new Set([name]))
        : null;
      return resolved?.split(";") ?? [];
    });
    const references = activePackageReferences(document, properties);
    return (
      targets.some((target) =>
        /^net8\.0(?:-[a-z][a-z0-9]*(?:\.[0-9]+)*)?$/i.test(target.trim()),
      ) &&
      references.some(
        ({ include, version }) =>
          include?.toLowerCase() === "azure.messaging.servicebus" &&
          ["7.20.2", "[7.20.2]"].includes(version),
      )
    );
  });
}

function configuredClients(analysis) {
  return analysis.resources.filter(
    (resource) => resource.kind === "client" && resource.valid,
  );
}

function queueSenders(analysis) {
  const clients = new Set(configuredClients(analysis).map(({ id }) => id));
  return analysis.resources.filter(
    (resource) =>
      resource.kind === "sender" &&
      clients.has(resource.clientId) &&
      resource.entity?.startsWith("env:") &&
      analysis.resources.some(
        (candidate) =>
          candidate.kind === "receiver" &&
          candidate.clientId === resource.clientId &&
          candidate.entity === resource.entity &&
          candidate.subscription === null,
      ) &&
      analysis.resources.some(
        (candidate) =>
          candidate.kind === "processor" &&
          candidate.clientId === resource.clientId &&
          candidate.entity === resource.entity &&
          candidate.subscription === null,
      ),
  );
}

function queueReceivers(analysis) {
  const clients = new Set(configuredClients(analysis).map(({ id }) => id));
  const senderEntities = new Set(queueSenders(analysis).map(({ entity }) => entity));
  return analysis.resources.filter(
    (resource) =>
      resource.kind === "receiver" &&
      clients.has(resource.clientId) &&
      senderEntities.has(resource.entity) &&
      resource.subscription === null,
  );
}

function processorHandlersPass(analysis) {
  for (const processor of analysis.resources.filter(
    (resource) =>
      resource.kind === "processor" &&
      queueSenders(analysis).some(
        (sender) =>
          sender.clientId === resource.clientId &&
          sender.entity === resource.entity,
      ),
  )) {
    const registrations = analysis.events.filter(
      (candidate) =>
        candidate.kind === "handler-register" &&
        candidate.processorId === processor.id,
    );
    const start = analysis.events.find(
      (candidate) =>
        candidate.kind === "processor-start" &&
        candidate.processorId === processor.id &&
        candidate.awaited,
    );
    if (
      !processor.messageHandler ||
      !processor.errorHandler ||
      !processor.autoCompleteFalse ||
      registrations.length < 2 ||
      !start ||
      registrations.some(
        (registration) =>
          registration.order > start.order ||
          !samePath(registration.path, start.path),
      )
    ) {
      continue;
    }
    const handlerEvents = executeMessageHandler(processor, analysis);
    const output = handlerEvents.find(
      (candidate) =>
        candidate.kind === "body-output" && candidate.normalFlow,
    );
    const completion = handlerEvents.find(
      (candidate) =>
        candidate.kind === "handler-complete" &&
        candidate.settlement === "CompleteMessage" &&
        candidate.handlerProcessorId === processor.id &&
        candidate.awaited &&
        candidate.normalFlow,
    );
    const errorEvents = executeErrorHandler(processor, analysis);
    if (
      output &&
      completion &&
      !hasCompatibleSecondSettlement(
        analysis,
        completion.messageId,
        null,
        processor.id,
      ) &&
      output.messageId === completion.messageId &&
      output.order < completion.order &&
      pathCovers(output.path, completion.path) &&
      errorEvents.some((candidate) => candidate.kind === "error-output")
    ) {
      return true;
    }
  }
  return false;
}

function lifecyclePasses(analysis) {
  const resources = analysis.resources.filter((resource) =>
    ["client", "sender", "receiver", "processor", "batch"].includes(
      resource.kind,
    ),
  );
  if (resources.length === 0) return false;
  const useOrder = (resource) => analysis.events
    .filter((candidate) => {
      if (candidate.kind === "dispose") return false;
      if (resource.kind === "batch") return candidate.batchId === resource.id;
      if (resource.kind === "sender") return candidate.senderId === resource.id;
      if (resource.kind === "receiver") {
        return candidate.receiverId === resource.id;
      }
      if (resource.kind === "processor") {
        return candidate.processorId === resource.id ||
          candidate.handlerProcessorId === resource.id;
      }
      return false;
    })
    .reduce((last, candidate) => Math.max(last, candidate.order), -1);
  const disposals = new Map();
  const independentlyGuaranteed = (candidate) =>
    candidate.implicit ||
    (
      candidate.guaranteed &&
      (
        candidate.guaranteeId === null ||
        !analysis.events.some(
          (earlier) =>
            earlier.order < candidate.order &&
            earlier.guaranteeId === candidate.guaranteeId &&
            ["dispose", "processor-stop"].includes(earlier.kind),
        )
      )
    );
  for (const resource of resources) {
    const lastUse = useOrder(resource);
    if (analysis.events.some(
      (candidate) =>
        candidate.kind === "dispose" &&
        candidate.resourceId === resource.id &&
        !candidate.implicit &&
        candidate.order <= lastUse,
    )) {
      return false;
    }
    const disposed = analysis.events.find(
      (candidate) =>
        candidate.kind === "dispose" &&
        candidate.resourceId === resource.id &&
        independentlyGuaranteed(candidate) &&
        samePath(candidate.path, resource.path) &&
        (
          resource.kind === "batch" ||
          (candidate.async && candidate.awaited)
        ) &&
        candidate.order > lastUse,
    );
    if (!disposed) return false;
    disposals.set(resource.id, disposed);
  }
  for (const resource of resources) {
    const parentId = resource.clientId ??
      (resource.kind === "batch" ? resource.senderId : null);
    if (
      parentId !== null &&
      parentId !== undefined &&
      disposals.get(resource.id)?.order >= disposals.get(parentId)?.order
    ) {
      return false;
    }
  }
  return analysis.resources
    .filter((resource) => resource.kind === "processor")
    .every((processor) => {
      const start = analysis.events.find(
        (candidate) =>
          candidate.kind === "processor-start" &&
          candidate.processorId === processor.id &&
          candidate.awaited,
      );
      const waits = analysis.events.filter(
        (candidate) => candidate.kind === "wait" && candidate.awaited,
      );
      const stops = analysis.events.filter(
        (candidate) =>
          candidate.kind === "processor-stop" &&
          candidate.processorId === processor.id &&
          candidate.awaited &&
          candidate.guaranteed,
      );
      const explicitDisposal = analysis.events.find(
        (candidate) =>
          candidate.kind === "dispose" &&
          candidate.resourceId === processor.id &&
          !candidate.implicit,
      );
      return Boolean(
        start &&
        stops.some((stop) =>
          stop.order > start.order &&
          samePath(stop.path, start.path) &&
          (!explicitDisposal || explicitDisposal.order > stop.order) &&
          waits.some(
            (wait) =>
              wait.order > start.order &&
              wait.order < stop.order &&
              wait.valid &&
              samePath(wait.path, start.path),
          )
        ),
      );
    });
}

const rules = {
  "prompt/source-manifest": ({ project }) => hasRequiredManifest(project),

  "prompt/client-configuration": ({ analysis }) =>
    configuredClients(analysis).length > 0,

  "prompt/queue-single-message": ({ analysis }) =>
    queueSenders(analysis).some((sender) =>
      analysis.events.some(
        (candidate) =>
          candidate.kind === "send-message" &&
          candidate.senderId === sender.id &&
          candidate.awaited,
      )
    ),

  "prompt/queue-five-message-batch": ({ analysis }) =>
    (() => {
      const senderIds = new Set(queueSenders(analysis).map(({ id }) => id));
      const sends = analysis.events.filter(
        (candidate) =>
          candidate.kind === "send-batch" &&
          candidate.awaited &&
          senderIds.has(candidate.senderId),
      );
      return sends.length > 0 &&
        sends.every((send) => batchSendIsValid(analysis, send));
    })(),

  "prompt/queue-receive-body": ({ analysis }) =>
    queueReceivers(analysis).some((receiver) =>
      analysis.events
        .filter(
          (candidate) =>
            candidate.kind === "receive" &&
            candidate.receiverId === receiver.id &&
            candidate.awaited &&
            candidate.bounded &&
            candidate.coversAll &&
            candidate.normalFlow,
        )
        .some((received) =>
          analysis.events.some(
            (candidate) =>
              candidate.kind === "body-output" &&
              candidate.messageId === received.messageId &&
              candidate.order > received.order &&
              candidate.normalFlow &&
              samePath(candidate.path, received.path),
          )
        )
    ),

  "prompt/complete-same-message": ({ analysis }) =>
    queueReceivers(analysis).some((receiver) =>
      analysis.events
        .filter(
          (candidate) =>
            candidate.kind === "receive" &&
            candidate.receiverId === receiver.id &&
            candidate.awaited &&
            candidate.bounded &&
            candidate.coversAll &&
            candidate.normalFlow,
        )
        .some((received) => {
          const output = analysis.events.find(
            (candidate) =>
              candidate.kind === "body-output" &&
              candidate.messageId === received.messageId &&
              candidate.order > received.order &&
              candidate.normalFlow &&
              samePath(candidate.path, received.path),
          );
          return Boolean(
            output &&
            analysis.events.some(
              (candidate) =>
                candidate.kind === "complete" &&
                candidate.settlement === "CompleteMessage" &&
                candidate.receiverId === receiver.id &&
                candidate.messageId === received.messageId &&
                candidate.awaited &&
                candidate.order > output.order &&
                candidate.normalFlow &&
                samePath(candidate.path, received.path) &&
                pathCovers(output.path, candidate.path) &&
                !hasCompatibleSecondSettlement(
                  analysis,
                  received.messageId,
                  receiver.id,
                ),
            ),
          );
        })
    ),

  "prompt/processor-handlers": ({ analysis }) =>
    processorHandlersPass(analysis),

  "prompt/topic-subscription": ({ analysis }) => {
    const clients = new Set(configuredClients(analysis).map(({ id }) => id));
    const namespaces = new Map(
      configuredClients(analysis).map(({ id, namespace }) => [id, namespace]),
    );
    const queueEntities = new Set(queueSenders(analysis).map(({ entity }) => entity));
    const senders = analysis.resources.filter(
      (resource) =>
        resource.kind === "sender" &&
        clients.has(resource.clientId) &&
        resource.entity?.startsWith("env:") &&
        !queueEntities.has(resource.entity) &&
        resource.entity !== namespaces.get(resource.clientId),
    );
    const receivers = analysis.resources.filter(
      (resource) =>
        resource.kind === "receiver" &&
        clients.has(resource.clientId) &&
        resource.entity?.startsWith("env:") &&
        resource.subscription?.startsWith("env:") &&
        resource.entity !== resource.subscription &&
        resource.entity !== namespaces.get(resource.clientId) &&
        resource.subscription !== namespaces.get(resource.clientId) &&
        !queueEntities.has(resource.entity) &&
        !queueEntities.has(resource.subscription),
    );
    return senders.some((sender) => receivers.some((receiver) =>
      sender.clientId === receiver.clientId &&
      sender.entity === receiver.entity &&
      analysis.events.some((sent) =>
        sent.kind === "send-message" &&
        sent.senderId === sender.id &&
        sent.awaited &&
        analysis.events.some((received) => {
          if (
            received.kind !== "receive" ||
            received.receiverId !== receiver.id ||
            !received.awaited ||
            !received.bounded ||
            !received.coversAll ||
            !received.normalFlow ||
            received.order <= sent.order ||
            !samePath(received.path, sent.path)
          ) return false;
          const output = analysis.events.find((candidate) =>
            candidate.kind === "body-output" &&
            candidate.messageId === received.messageId &&
            candidate.order > received.order &&
            candidate.normalFlow &&
            samePath(candidate.path, received.path)
          );
          return Boolean(output && analysis.events.some((candidate) =>
            candidate.kind === "complete" &&
            candidate.settlement === "CompleteMessage" &&
            candidate.receiverId === receiver.id &&
            candidate.messageId === received.messageId &&
            candidate.awaited &&
            candidate.order > output.order &&
            candidate.normalFlow &&
            samePath(candidate.path, received.path) &&
            pathCovers(output.path, candidate.path) &&
            !hasCompatibleSecondSettlement(
              analysis,
              received.messageId,
              receiver.id,
            )
          ));
        })
      )
    ));
  },

  "prompt/resource-lifecycle": ({ analysis }) =>
    lifecyclePasses(analysis),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  if (name === "prompt/source-manifest") {
    return Boolean(rule({ project: workspace.project ?? "" }));
  }
  const source = workspace.source ?? "";
  if (source.trim() === "") return false;
  const analysis = analyze(source);
  return Boolean(rule({ analysis }));
}

export function ruleNames() {
  return Object.keys(rules);
}
