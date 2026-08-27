function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripComments(source) {
  let result = "";
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (current === "\n") {
        state = "code";
        result += current;
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "single" || state === "double" || state === "template") {
      if (current === "\\") {
        result += "  ";
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        result += current;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (current === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else {
      const defaultGroup = source.slice(index).match(/^(['"])\$Default\1/);
      if (defaultGroup) {
        result += defaultGroup[0];
        index += defaultGroup[0].length - 1;
      } else {
        result += current;
        if (current === "'") state = "single";
        if (current === '"') state = "double";
        if (current === "`") state = "template";
      }
    }
  }

  return result;
}

function balancedText(source, openingIndex, opening = "(", closing = ")") {
  let depth = 0;
  let state = "code";

  for (let index = openingIndex; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state !== "code") {
      if (current === "\\") {
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (current === "'") {
      state = "single";
      continue;
    }
    if (current === '"') {
      state = "double";
      continue;
    }
    if (current === "`") {
      state = "template";
      continue;
    }
    if (current === opening) depth += 1;
    if (current === closing) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openingIndex + 1, index);
      }
    }
  }

  return "";
}

function constructorBindings(source, constructorName) {
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+(\\w+)(?:\\s*:[^=;]+)?\\s*=\\s*new\\s+${constructorName}\\s*\\(`,
    "g",
  );
  const bindings = [];

  for (const match of source.matchAll(pattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    bindings.push({
      name: match[1],
      arguments: balancedText(source, openingIndex),
    });
  }

  return bindings;
}

function methodCalls(source, receiver, method) {
  const pattern = new RegExp(
    `\\b${escapeRegExp(receiver)}\\s*(?:\\?\\.|\\.)\\s*${method}\\s*\\(`,
    "g",
  );
  const calls = [];

  for (const match of source.matchAll(pattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    calls.push({
      arguments: balancedText(source, openingIndex),
      index: match.index,
    });
  }

  return calls;
}

function assignedMethodBindings(source, receivers, method) {
  const receiverAlternation = receivers.map(escapeRegExp).join("|");
  if (!receiverAlternation) return [];

  const pattern = new RegExp(
    `\\b(?:(?:const|let|var)\\s+)?(\\w+)(?:\\s*:[^=;]+)?\\s*=\\s*(?:await\\s+)?(${receiverAlternation})\\s*\\.\\s*${method}\\s*\\(`,
    "g",
  );
  const bindings = [];

  for (const match of source.matchAll(pattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(source, openingIndex);
    bindings.push({
      name: match[1],
      owner: match[2],
      arguments: argumentsText,
      index: match.index,
      end: openingIndex + argumentsText.length + 2,
    });
  }

  return bindings;
}

function objectInitializer(source, name) {
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+${escapeRegExp(name)}(?:\\s*:[^=;]+)?\\s*=\\s*\\{`,
  );
  const match = pattern.exec(source);
  if (!match) return "";
  const openingIndex = match.index + match[0].lastIndexOf("{");
  return balancedText(source, openingIndex, "{", "}");
}

function resolveFunction(source, name) {
  const escapedName = escapeRegExp(name);
  const patterns = [
    new RegExp(`\\b(?:async\\s+)?function\\s+${escapedName}\\s*\\(([^)]*)\\)\\s*\\{`),
    new RegExp(
      `\\b(?:const|let|var)\\s+${escapedName}(?:\\s*:[^=;]+)?\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*\\{`,
    ),
    new RegExp(
      `\\b(?:const|let|var)\\s+${escapedName}(?:\\s*:[^=;]+)?\\s*=\\s*(?:async\\s*)?(\\w+)\\s*=>\\s*\\{`,
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const openingIndex = match.index + match[0].lastIndexOf("{");
    return {
      parameters: match[1].split(",").map((value) => value.trim().split(/[?:\s]/)[0]),
      body: balancedText(source, openingIndex, "{", "}"),
    };
  }

  return null;
}

function propertyFunction(source, objectText, property) {
  const escapedProperty = escapeRegExp(property);
  const directPatterns = [
    new RegExp(
      `\\b${escapedProperty}\\s*:\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*\\{`,
    ),
    new RegExp(
      `\\b(?:async\\s+)?${escapedProperty}\\s*\\(([^)]*)\\)\\s*\\{`,
    ),
  ];

  for (const pattern of directPatterns) {
    const match = pattern.exec(objectText);
    if (!match) continue;
    const openingIndex = match.index + match[0].lastIndexOf("{");
    return {
      parameters: match[1].split(",").map((value) => value.trim().split(/[?:\s]/)[0]),
      body: balancedText(objectText, openingIndex, "{", "}"),
    };
  }

  const expressionArrow = new RegExp(
    `\\b${escapedProperty}\\s*:\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*([^,}]+)`,
  ).exec(objectText);
  if (expressionArrow) {
    return {
      parameters: expressionArrow[1]
        .split(",")
        .map((value) => value.trim().split(/[?:\s]/)[0]),
      body: expressionArrow[2],
    };
  }

  const aliased = new RegExp(`\\b${escapedProperty}\\s*:\\s*(\\w+)`).exec(
    objectText,
  );
  if (aliased) return resolveFunction(source, aliased[1]);

  if (new RegExp(`(?:^|,)\\s*${escapedProperty}\\s*(?=,|$)`).test(objectText)) {
    return resolveFunction(source, property);
  }

  return null;
}

function handlerObjects(source, consumerNames) {
  const handlers = [];

  for (const consumerName of consumerNames) {
    for (const call of methodCalls(source, consumerName, "subscribe")) {
      for (let index = 0; index < call.arguments.length; index += 1) {
        if (call.arguments[index] !== "{") continue;
        const candidate = balancedText(call.arguments, index, "{", "}");
        if (/\bprocessEvents\b/.test(candidate) && /\bprocessError\b/.test(candidate)) {
          handlers.push(candidate);
        }
      }

      for (const identifier of call.arguments.matchAll(/\b[A-Za-z_$]\w*\b/g)) {
        const candidate = objectInitializer(source, identifier[0]);
        if (/\bprocessEvents\b/.test(candidate) && /\bprocessError\b/.test(candidate)) {
          handlers.push(candidate);
        }
      }
    }
  }

  return handlers;
}

function integerConstants(source) {
  const constants = new Map();
  for (const match of source.matchAll(
    /\bconst\s+(\w+)(?:\s*:\s*number)?\s*=\s*(-?\d+)\s*;/g,
  )) {
    constants.set(match[1], Number(match[2]));
  }
  return constants;
}

function resolveInteger(value, constants) {
  const cleaned = value.trim();
  if (/^-?\d+$/.test(cleaned)) {
    return Number(cleaned);
  }
  return constants.get(cleaned);
}

function loopRunsTenTimes(header, constants) {
  const parts = header.split(";");
  if (parts.length !== 3) {
    return false;
  }
  const initialized = parts[0]
    .trim()
    .match(/^(?:let|var)\s+(\w+)(?:\s*:\s*number)?\s*=\s*(\w+|-?\d+)$/);
  if (!initialized) {
    return false;
  }

  const [, variable, startExpression] = initialized;
  const compared = parts[1]
    .trim()
    .match(/^(\w+)\s*(<=|>=|<|>)\s*(\w+|-?\d+)$/);
  if (!compared || compared[1] !== variable) {
    return false;
  }

  const escapedVariable = escapeRegExp(variable);
  const update = parts[2].trim();
  const increases = new RegExp(
    `^(?:${escapedVariable}\\+\\+|\\+\\+${escapedVariable}|${escapedVariable}\\s*\\+=\\s*1)$`,
  ).test(update);
  const decreases = new RegExp(
    `^(?:${escapedVariable}--|--${escapedVariable}|${escapedVariable}\\s*-=\\s*1)$`,
  ).test(update);
  const start = resolveInteger(startExpression, constants);
  const bound = resolveInteger(compared[3], constants);
  if (start === undefined || bound === undefined) {
    return false;
  }

  const operator = compared[2];
  if (increases && (operator === "<" || operator === "<=")) {
    return bound - start + (operator === "<=" ? 1 : 0) === 10;
  }
  if (decreases && (operator === ">" || operator === ">=")) {
    return start - bound + (operator === ">=" ? 1 : 0) === 10;
  }
  return false;
}

function tenEventIterationBodies(source) {
  const bodies = [];
  const constants = integerConstants(source);
  const pattern = /\bfor\s*\(/g;

  for (const match of source.matchAll(pattern)) {
    const openingIndex = source.indexOf("(", match.index);
    const header = balancedText(source, openingIndex);
    const closingIndex = openingIndex + header.length + 1;
    const classicLoop = loopRunsTenTimes(header, constants);
    const arrayLength = header.match(
      /\bof\s+Array\.from\s*\(\s*\{\s*length\s*:\s*(\w+|\d+)\b/,
    )?.[1];
    const arrayLoop =
      arrayLength !== undefined &&
      resolveInteger(arrayLength, constants) === 10;
    if (!classicLoop && !arrayLoop) {
      continue;
    }

    const bodyStart = source.indexOf("{", closingIndex + 1);
    if (bodyStart >= 0 && bodyStart - closingIndex < 80) {
      bodies.push(balancedText(source, bodyStart, "{", "}"));
    }
  }
  return bodies;
}

function eventExpressionHasBodyAndProperties(source, expression) {
  if (/\bbody\s*:/.test(expression) && /\bproperties\s*:/.test(expression)) {
    return true;
  }

  const identifier = /^\s*(\w+)\s*$/.exec(expression)?.[1];
  if (!identifier) return false;
  const eventObject = objectInitializer(source, identifier);
  return /\bbody\s*:/.test(eventObject) && /\bproperties\s*:/.test(eventObject);
}

function handlesTryAddFailure(source, batchName) {
  const escapedBatch = escapeRegExp(batchName);
  const direct = new RegExp(
    `\\bif\\s*\\(\\s*(?:!\\s*${escapedBatch}\\s*\\.\\s*tryAdd\\s*\\(|${escapedBatch}\\s*\\.\\s*tryAdd\\s*\\([^;]+?\\)\\s*={2,3}\\s*false)`,
  );
  if (direct.test(source)) return true;

  const assigned = new RegExp(
    `\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*${escapedBatch}\\s*\\.\\s*tryAdd\\s*\\(`,
  ).exec(source);
  return (
    assigned !== null &&
    new RegExp(
      `\\bif\\s*\\(\\s*(?:!\\s*${escapeRegExp(assigned[1])}\\b|${escapeRegExp(assigned[1])}\\s*={2,3}\\s*false)`,
    ).test(source)
  );
}

function eventReferences(handler) {
  if (!handler || handler.parameters.length === 0) {
    return [];
  }

  const events = handler.parameters[0];
  const escapedEvents = escapeRegExp(events);
  const references = [`${escapedEvents}\\s*\\[[^\\]]+\\]`];
  const forOfPattern = new RegExp(
    `\\bfor\\s*\\(\\s*(?:const|let|var)\\s+(\\w+)\\s+of\\s+${escapedEvents}\\b`,
    "g",
  );
  for (const match of handler.body.matchAll(forOfPattern)) {
    references.push(escapeRegExp(match[1]));
  }
  const callbackPattern = new RegExp(
    `\\b${escapedEvents}\\s*\\.\\s*(?:forEach|map)\\s*\\(\\s*(?:async\\s*)?\\(?\\s*(\\w+)`,
    "g",
  );
  for (const match of handler.body.matchAll(callbackPattern)) {
    references.push(escapeRegExp(match[1]));
  }
  return references;
}

function printsReceivedBody(handler) {
  const references = eventReferences(handler);
  if (!handler || references.length === 0) {
    return false;
  }
  const eventReference = `(?:${references.join("|")})`;
  const direct = new RegExp(
    `\\bconsole\\.(?:log|info)\\s*\\([\\s\\S]{0,240}?\\b${eventReference}\\s*\\.\\s*body\\b`,
  ).test(handler.body);
  const assigned = new RegExp(
    `\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*${eventReference}\\s*\\.\\s*body\\b[^;]*;[\\s\\S]{0,240}?\\bconsole\\.(?:log|info)\\s*\\(\\s*\\1\\b`,
  ).test(handler.body);
  return direct || assigned;
}

function reportsProcessingError(handler) {
  if (!handler || handler.parameters.length === 0) {
    return false;
  }
  const error = escapeRegExp(handler.parameters[0]);
  const direct = new RegExp(
    `\\bconsole\\.(?:error|warn|log)\\s*\\([\\s\\S]{0,240}?\\b${error}\\b`,
  ).test(handler.body);
  const assigned = new RegExp(
    `\\b(?:const|let|var)\\s+(\\w+)\\s*=\\s*${error}(?:\\s*\\.\\s*\\w+)?\\b[^;]*;[\\s\\S]{0,240}?\\bconsole\\.(?:error|warn|log)\\s*\\(\\s*\\1\\b`,
  ).test(handler.body);
  return direct || assigned;
}

function waitsForShutdown(source, subscription) {
  const close = methodCalls(source, subscription.name, "close").find(
    (call) => call.index > subscription.end,
  );
  if (!close) {
    return false;
  }
  const active = source.slice(subscription.end, close.index);
  return (
    /\bawait\s+new\s+Promise\b/.test(active) ||
    /\bawait\s+(?:\w+\.)*(?:wait|once)\s*\(/i.test(active) ||
    /\bawait\s+\w*(?:shutdown|signal|cancel|abort|termination|forever)\w*\s*\(/i.test(
      active,
    )
  );
}

function packageDependencies(packageJson) {
  try {
    const manifest = JSON.parse(packageJson);
    return {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
  } catch {
    return {};
  }
}

function contextFor(workspace) {
  const source = stripComments(workspace.source);
  const producers = constructorBindings(source, "EventHubProducerClient");
  const consumers = constructorBindings(source, "EventHubConsumerClient");
  const batches = assignedMethodBindings(
    source,
    producers.map(({ name }) => name),
    "createBatch",
  );

  return { source, producers, consumers, batches };
}

const rules = {
  "prompt/event-hubs-packages": ({ packageJson }) => {
    const dependencies = packageDependencies(packageJson);
    return [
      "@azure/event-hubs",
      "@azure/eventhubs-checkpointstore-blob",
      "@azure/storage-blob",
    ].every((name) => typeof dependencies[name] === "string");
  },
  "prompt/producer-client": (workspace) =>
    contextFor(workspace).producers.some(({ arguments: args }) => args.trim()),
  "prompt/event-batch": (workspace) => {
    const { source, batches } = contextFor(workspace);
    const iterationBodies = tenEventIterationBodies(source);
    return batches.some(({ name }) =>
      iterationBodies.some(
        (body) =>
          handlesTryAddFailure(body, name) &&
          methodCalls(body, name, "tryAdd").some(({ arguments: event }) =>
            eventExpressionHasBodyAndProperties(body, event),
          ),
      ),
    );
  },
  "prompt/send-batch": (workspace) => {
    const { source, batches } = contextFor(workspace);
    return batches.some(({ name, owner }) =>
      methodCalls(source, owner, "sendBatch").some(({ arguments: args }) =>
        new RegExp(`\\b${escapeRegExp(name)}\\b`).test(args),
      ),
    );
  },
  "prompt/checkpointed-consumer": (workspace) => {
    const { source, consumers } = contextFor(workspace);
    const stores = constructorBindings(source, "BlobCheckpointStore");
    return stores.some(({ name, arguments: storeArguments }) =>
      storeArguments.trim() &&
      consumers.some(({ arguments: consumerArguments }) =>
        new RegExp(`\\b${escapeRegExp(name)}\\b`).test(consumerArguments) &&
        /(?:["']\$Default["']|\bdefaultConsumerGroupName\b)/.test(
          consumerArguments,
        ),
      ),
    );
  },
  "prompt/receive-handlers": (workspace) => {
    const { source, consumers } = contextFor(workspace);
    return handlerObjects(
      source,
      consumers.map(({ name }) => name),
    ).some((handlers) => {
      const processEvents = propertyFunction(source, handlers, "processEvents");
      const processError = propertyFunction(source, handlers, "processError");
      return (
        processEvents !== null &&
        processError !== null &&
        printsReceivedBody(processEvents) &&
        reportsProcessingError(processError)
      );
    });
  },
  "prompt/update-checkpoint": (workspace) => {
    const { source, consumers } = contextFor(workspace);
    return handlerObjects(
      source,
      consumers.map(({ name }) => name),
    ).some((handlers) => {
      const processEvents = propertyFunction(source, handlers, "processEvents");
      if (!processEvents) return false;

      const update = /\b(\w+)\.updateCheckpoint\s*\(\s*([^)]+)\)/.exec(
        processEvents.body,
      );
      if (!update) return false;

      const [eventsParameter, contextParameter] = processEvents.parameters;
      if (contextParameter && update[1] !== contextParameter) return false;
      if (
        eventsParameter &&
        new RegExp(`\\b${escapeRegExp(eventsParameter)}\\b`).test(update[2])
      ) {
        return true;
      }

      const eventName = new RegExp(
        `\\bfor\\s*\\(\\s*(?:const|let|var)\\s+(\\w+)\\s+of\\s+${escapeRegExp(eventsParameter ?? "")}\\b`,
      ).exec(processEvents.body)?.[1];
      return eventName === update[2].trim();
    });
  },
  "prompt/client-lifecycle": (workspace) => {
    const { source, producers, consumers } = contextFor(workspace);
    return producers.some(({ name: producer }) =>
      methodCalls(source, producer, "close").length > 0 &&
      consumers.some(({ name: consumer }) => {
        if (methodCalls(source, consumer, "close").length === 0) return false;
        const subscriptions = assignedMethodBindings(
          source,
          [consumer],
          "subscribe",
        );
        return subscriptions.some(
          (subscription) =>
            methodCalls(source, subscription.name, "close").length > 0 &&
            waitsForShutdown(source, subscription),
        );
      }),
    );
  },
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }
  return rule(workspace);
}

export function ruleNames() {
  return Object.keys(rules);
}
