import { dotnetCodeOnly } from "../../../languages/dotnet/checks.mjs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bindings(source, type) {
  const escapedType = escapeRegExp(type);
  const names = new Set();
  const patterns = [
    new RegExp(
      `\\b(?:${escapedType}|var)\\s+(\\w+)\\s*=\\s*new\\s+${escapedType}\\s*\\(`,
      "g",
    ),
    new RegExp(
      `\\b${escapedType}\\s+(\\w+)\\s*=\\s*new\\s*\\(`,
      "g",
    ),
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

function statementFrom(source, start) {
  let braces = 0;
  let parentheses = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") braces += 1;
    if (source[index] === "}") braces -= 1;
    if (source[index] === "(") parentheses += 1;
    if (source[index] === ")") parentheses -= 1;
    if (source[index] === ";" && braces === 0 && parentheses === 0) {
      return source.slice(start, index);
    }
  }
  return "";
}

function balancedBlock(source, openBrace) {
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace + 1, index);
      }
    }
  }
  return "";
}

function namedHandlerBody(source, name) {
  const escapedName = escapeRegExp(name);
  const method = new RegExp(
    `\\b(?:static\\s+)?(?:async\\s+)?(?:Task|ValueTask)\\s+${escapedName}\\s*\\([^)]*\\)\\s*`,
    "g",
  ).exec(source);
  if (method) {
    const bodyStart = source.indexOf("{", method.index + method[0].length);
    if (bodyStart >= 0) {
      return balancedBlock(source, bodyStart);
    }
    const expressionStart = source.indexOf("=>", method.index + method[0].length);
    if (expressionStart >= 0) {
      return statementFrom(source, expressionStart + 2);
    }
  }

  const assigned = new RegExp(
    `\\b(?:var|Func\\s*<[^;=]+>)\\s+${escapedName}\\s*=\\s*`,
    "g",
  ).exec(source);
  return assigned
    ? statementFrom(source, assigned.index + assigned[0].length)
    : "";
}

function handler(source, processor, eventName) {
  const subscription = new RegExp(
    `\\b${escapeRegExp(processor)}\\s*\\.\\s*${eventName}\\s*\\+=\\s*`,
    "g",
  ).exec(source);
  if (!subscription) {
    return null;
  }

  const expression = statementFrom(
    source,
    subscription.index + subscription[0].length,
  ).trim();
  if (expression.includes("=>")) {
    return { expression, name: null };
  }

  const name = expression.match(/^(\w+)$/)?.[1];
  return name ? { expression: namedHandlerBody(source, name), name } : null;
}

function printsReceivedBody(body) {
  const direct =
    /Console\.(?:Write|WriteLine)\s*\([\s\S]{0,240}?\.Data\s*\.\s*EventBody\b/.test(
      body,
    );
  const assigned =
    /\b(?:var|string)\s+(\w+)\s*=[^;]*\.Data\s*\.\s*EventBody\b[^;]*;[\s\S]{0,240}?Console\.(?:Write|WriteLine)\s*\(\s*\1\b/.test(
      body,
    );
  return direct || assigned;
}

function printsProcessingError(body) {
  const direct =
    /Console\.(?:Error\.)?(?:Write|WriteLine)\s*\([\s\S]{0,240}?\.(?:Exception|Message)\b/.test(
      body,
    );
  const assigned =
    /\b(?:var|string)\s+(\w+)\s*=[^;]*\.(?:Exception|Message)\b[^;]*;[\s\S]{0,240}?Console\.(?:Error\.)?(?:Write|WriteLine)\s*\(\s*\1\b/.test(
      body,
    );
  return direct || assigned;
}

function processorHandlers(source) {
  for (const processor of bindings(source, "EventProcessorClient")) {
    const eventHandler = handler(source, processor, "ProcessEventAsync");
    const errorHandler = handler(source, processor, "ProcessErrorAsync");
    if (eventHandler && errorHandler) {
      return { processor, eventHandler, errorHandler };
    }
  }
  return null;
}

function producerBatches(source) {
  const result = [];
  for (const producer of bindings(source, "EventHubProducerClient")) {
    const pattern = new RegExp(
      `\\b(?:EventDataBatch|var)\\s+(\\w+)\\s*=\\s*await\\s+${escapeRegExp(producer)}\\s*\\.\\s*CreateBatchAsync\\s*\\(`,
      "g",
    );
    for (const match of source.matchAll(pattern)) {
      result.push({ producer, batch: match[1] });
    }
  }
  return result;
}

function integerConstants(source) {
  const constants = new Map();
  for (const match of source.matchAll(
    /\bconst\s+(?:int|long)\s+(\w+)\s*=\s*(-?\d+)\s*;/g,
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

function loopRunsTenTimes(initializer, condition, increment, constants) {
  const initialized = initializer
    .trim()
    .match(/^(?:int|long|var)\s+(\w+)\s*=\s*([A-Z_]\w*|-?\d+)$/);
  if (!initialized) {
    return false;
  }

  const [, variable, startExpression] = initialized;
  const compared = condition
    .trim()
    .match(/^(\w+)\s*(<=|>=|<|>)\s*([A-Z_]\w*|-?\d+)$/);
  if (!compared || compared[1] !== variable) {
    return false;
  }

  const escapedVariable = escapeRegExp(variable);
  const update = increment.trim();
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
  const forPattern = /\bfor\s*\(([^;]*);([^;]*);([^)]*)\)/g;
  for (const match of source.matchAll(forPattern)) {
    if (!loopRunsTenTimes(match[1], match[2], match[3], constants)) {
      continue;
    }
    const bodyStart = source.indexOf("{", match.index + match[0].length);
    if (bodyStart >= 0 && bodyStart - match.index - match[0].length < 80) {
      bodies.push(balancedBlock(source, bodyStart));
    }
  }

  const rangePattern =
    /\bforeach\s*\([^)]*\bEnumerable\s*\.\s*Range\s*\(\s*[^,]+,\s*([A-Z_]\w*|\d+)\s*\)[^)]*\)/g;
  for (const match of source.matchAll(rangePattern)) {
    if (resolveInteger(match[1], constants) !== 10) {
      continue;
    }
    const bodyStart = source.indexOf("{", match.index + match[0].length);
    if (bodyStart >= 0 && bodyStart - match.index - match[0].length < 80) {
      bodies.push(balancedBlock(source, bodyStart));
    }
  }
  return bodies;
}

function hasEventAddedWithProperty(source, batch) {
  const eventBindings = new Set();
  const patterns = [
    /\b(?:EventData|var)\s+(\w+)\s*=\s*new\s+EventData\s*\((?!\s*\))\s*/g,
    /\bEventData\s+(\w+)\s*=\s*new\s*\((?!\s*\))\s*/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      eventBindings.add(match[1]);
    }
  }

  return [...eventBindings].some((event) => {
    const escapedEvent = escapeRegExp(event);
    const property = new RegExp(
      `\\b${escapedEvent}\\s*\\.\\s*Properties\\s*\\[[^\\]]+\\]\\s*=`,
    ).test(source);
    const tryAdd = `${escapeRegExp(batch)}\\s*\\.\\s*TryAdd\\s*\\(\\s*${escapedEvent}\\s*\\)`;
    const directlyHandled = new RegExp(
      `\\bif\\s*\\(\\s*(?:!\\s*${tryAdd}|${tryAdd}\\s*(?:==|is)\\s*false)`,
    ).test(source);
    const assigned = new RegExp(
      `\\b(?:var|bool)\\s+(\\w+)\\s*=\\s*${tryAdd}\\s*;`,
    ).exec(source);
    const assignedHandled =
      assigned !== null &&
      new RegExp(
        `\\bif\\s*\\(\\s*(?:!\\s*${escapeRegExp(assigned[1])}|${escapeRegExp(assigned[1])}\\s*(?:==|is)\\s*false)`,
      ).test(source);
    return property && (directlyHandled || assignedHandled);
  });
}

function producerIsDisposed(source, producer) {
  const escapedProducer = escapeRegExp(producer);
  return (
    new RegExp(
      `\\bawait\\s+using\\s+(?:var|EventHubProducerClient)\\s+${escapedProducer}\\s*=`,
    ).test(source) ||
    new RegExp(
      `\\b${escapedProducer}\\s*\\.\\s*(?:DisposeAsync|CloseAsync)\\s*\\(`,
    ).test(source)
  );
}

function batchIsDisposed(source, batch) {
  const escapedBatch = escapeRegExp(batch);
  return (
    new RegExp(
      `\\busing\\s+(?:var|EventDataBatch)\\s+${escapedBatch}\\s*=`,
    ).test(source) ||
    new RegExp(`\\b${escapedBatch}\\s*\\.\\s*Dispose\\s*\\(`).test(source)
  );
}

function finallyContainsCall(source, receiver, method, afterIndex) {
  const pattern = /\bfinally\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    if (match.index < afterIndex) {
      continue;
    }
    const openBrace = source.indexOf("{", match.index);
    const body = balancedBlock(source, openBrace);
    if (
      new RegExp(
        `\\b${escapeRegExp(receiver)}\\s*\\.\\s*${method}\\s*\\(`,
      ).test(body)
    ) {
      return true;
    }
  }
  return false;
}

const rules = {
  "prompt/event-hubs-packages": ({ project }) =>
    [
      "Azure.Messaging.EventHubs",
      "Azure.Messaging.EventHubs.Processor",
      "Azure.Storage.Blobs",
    ].every((name) =>
      new RegExp(
        `<PackageReference\\s+Include="${escapeRegExp(name)}"`,
      ).test(project),
    ),

  "prompt/producer-client": ({ source }) =>
    bindings(source, "EventHubProducerClient").length > 0,

  "prompt/event-batch": ({ source }) =>
    producerBatches(source).some(({ batch }) =>
      tenEventIterationBodies(source).some((body) =>
        hasEventAddedWithProperty(body, batch),
      ),
    ),

  "prompt/send-batch": ({ source }) =>
    producerBatches(source).some(({ producer, batch }) =>
      new RegExp(
        `\\b${escapeRegExp(producer)}\\s*\\.\\s*SendAsync\\s*\\(\\s*${escapeRegExp(batch)}\\b`,
      ).test(source),
    ),

  "prompt/checkpointed-consumer": ({ source }) => {
    const stores = bindings(source, "BlobContainerClient");
    return bindings(source, "EventProcessorClient").some((processor) => {
      const construction = new RegExp(
        `\\b(?:EventProcessorClient|var)\\s+${escapeRegExp(processor)}\\s*=\\s*new\\s*(?:EventProcessorClient\\s*)?\\(([\\s\\S]{0,600}?)\\)\\s*;`,
      ).exec(source);
      return (
        construction &&
        stores.some((store) =>
          new RegExp(`\\b${escapeRegExp(store)}\\b`).test(construction[1]),
        ) &&
        /(?:DefaultConsumerGroupName|["']\$Default["'])/.test(construction[1])
      );
    });
  },

  "prompt/receive-handlers": ({ source }) => {
    const handlers = processorHandlers(source);
    return (
      handlers !== null &&
      printsReceivedBody(handlers.eventHandler.expression) &&
      printsProcessingError(handlers.errorHandler.expression)
    );
  },

  "prompt/update-checkpoint": ({ source }) => {
    const handlers = processorHandlers(source);
    return (
      handlers !== null &&
      /\bawait\b[\s\S]{0,120}?\.UpdateCheckpointAsync\s*\(/.test(
        handlers.eventHandler.expression,
      )
    );
  },

  "prompt/client-lifecycle": ({ source }) =>
    bindings(source, "EventHubProducerClient").some((producer) => {
      if (!producerIsDisposed(source, producer)) {
        return false;
      }
      const batches = producerBatches(source).filter(
        (candidate) => candidate.producer === producer,
      );
      if (!batches.every(({ batch }) => batchIsDisposed(source, batch))) {
        return false;
      }
      return bindings(source, "EventProcessorClient").some((processor) => {
        const escapedProcessor = escapeRegExp(processor);
        const start = new RegExp(
          `\\b${escapedProcessor}\\s*\\.\\s*StartProcessingAsync\\s*\\(`,
        ).exec(source);
        const stop = new RegExp(
          `\\b${escapedProcessor}\\s*\\.\\s*StopProcessingAsync\\s*\\(`,
        ).exec(source);
        const waits =
          /\b(?:Task\s*\.\s*Delay|Console\s*\.\s*Read(?:Line|Key)|WaitForCancellationAsync)\s*\(/.test(
            source,
          );
        const handlers = processorHandlers(source);
        const namedHandlersRemoved =
          handlers === null ||
          [handlers.eventHandler, handlers.errorHandler].every(
            ({ name }) =>
              name === null ||
              new RegExp(
                `\\b${escapedProcessor}\\s*\\.\\s*Process(?:Event|Error)Async\\s*-=\\s*${escapeRegExp(name)}\\s*;`,
              ).test(source),
          );
        return (
          start !== null &&
          stop !== null &&
          stop.index > start.index &&
          finallyContainsCall(
            source,
            processor,
            "StopProcessingAsync",
            start.index,
          ) &&
          waits &&
          namedHandlersRemoved
        );
      });
    }),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }
  return Boolean(
    rule({
      ...workspace,
      source: dotnetCodeOnly(workspace.source ?? ""),
    }),
  );
}

export function ruleNames() {
  return Object.keys(rules);
}
