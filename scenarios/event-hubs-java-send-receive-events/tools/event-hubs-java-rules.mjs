function sanitizeJava(source) {
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
    } else if (character === '"') {
      const defaultGroup = '"$Default"';
      if (source.startsWith(defaultGroup, index)) {
        result += defaultGroup;
        index += defaultGroup.length - 1;
      } else {
        result += character;
        state = "string";
      }
    } else if (character === "'") {
      result += character;
      state = "character";
    } else {
      result += character;
    }
  }

  return result;
}

function matchingIndex(text, start, open = "(", close = ")") {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === open) {
      depth += 1;
    } else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function statementEnd(text, start) {
  const depths = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character in depths) {
      depths[character] += 1;
    } else if (character in closing) {
      depths[closing[character]] -= 1;
    } else if (
      character === ";" &&
      Object.values(depths).every((depth) => depth === 0)
    ) {
      return index;
    }
  }
  return text.length;
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  const depths = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character in depths) {
      depths[character] += 1;
    } else if (character in closing) {
      depths[closing[character]] -= 1;
    } else if (
      character === "," &&
      Object.values(depths).every((depth) => depth === 0)
    ) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(text.slice(start).trim());
  return parts;
}

function callArguments(text, method) {
  const calls = [];
  const pattern = new RegExp(`\\.${method}\\s*\\(`, "g");
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const open = text.indexOf("(", match.index);
    const close = matchingIndex(text, open);
    if (close !== -1) {
      calls.push(text.slice(open + 1, close));
      pattern.lastIndex = close + 1;
    }
  }
  return calls;
}

function assignmentExpressions(source, typePattern) {
  const assignments = [];
  const pattern = new RegExp(
    `\\b(?:${typePattern}|var)\\s+(\\w+)\\s*=\\s*`,
    "g",
  );
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const end = statementEnd(source, pattern.lastIndex);
    assignments.push({
      name: match[1],
      expression: source.slice(pattern.lastIndex, end),
      start: match.index,
      end,
    });
    pattern.lastIndex = end + 1;
  }
  return assignments;
}

function resolveAssignment(source, name, typePattern) {
  return assignmentExpressions(source, typePattern).find(
    (assignment) => assignment.name === name,
  )?.expression;
}

function hasAuthentication(expression) {
  for (const args of callArguments(expression, "credential")) {
    if (
      splitTopLevel(args).length >= 3 ||
      (new RegExp("\\.fullyQualifiedNamespace\\s*\\(").test(expression) &&
        new RegExp("\\.eventHubName\\s*\\(").test(expression))
    ) {
      return true;
    }
  }
  return callArguments(expression, "connectionString").length > 0;
}

function resolveBuilder(source, expression, builderType) {
  if (new RegExp(`\\bnew\\s+${builderType}\\s*\\(`).test(expression)) {
    return expression;
  }

  const receiver = expression.match(/\b(\w+)\s*\.build\w*Client\s*\(/)?.[1];
  if (!receiver) {
    return expression;
  }
  const configured = resolveAssignment(source, receiver, builderType);
  return configured ? `${configured}\n${expression}` : expression;
}

function producerAssignments(source) {
  return assignmentExpressions(
    source,
    "EventHubProducer(?:Async)?Client",
  )
    .filter((assignment) =>
      /\.build(?:Async)?ProducerClient\s*\(/.test(assignment.expression),
    )
    .map((assignment) => ({
      ...assignment,
      builder: resolveBuilder(
        source,
        assignment.expression,
        "EventHubClientBuilder",
      ),
    }));
}

function batchAssignments(source) {
  const producers = producerAssignments(source);
  return assignmentExpressions(source, "EventDataBatch")
    .map((assignment) => ({
      ...assignment,
      producer: producers.find((producer) =>
        new RegExp(
          `\\b${producer.name}\\s*\\.createBatch\\s*\\(`,
        ).test(assignment.expression),
      ),
    }))
    .filter((assignment) => assignment.producer);
}

function loopBodies(source) {
  const loops = [];
  const pattern = /\bfor\s*\(([^)]*)\)\s*\{/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf("{", match.index);
    const close = matchingIndex(source, open, "{", "}");
    if (close !== -1) {
      loops.push({ header: match[1], body: source.slice(open + 1, close) });
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

function resolveInteger(value, constants) {
  const cleaned = value.trim();
  if (/^-?\d+$/.test(cleaned)) {
    return Number(cleaned);
  }
  return constants.get(cleaned);
}

function iteratesTenTimes(header, constants) {
  const parts = header.split(";");
  if (parts.length !== 3) {
    return false;
  }

  const initialized = parts[0]
    .trim()
    .match(/^(?:int|long|var)\s+(\w+)\s*=\s*([A-Z_]\w*|-?\d+)$/);
  if (!initialized) {
    return false;
  }
  const [, variable, startExpression] = initialized;
  const compared = parts[1]
    .trim()
    .match(/^(\w+)\s*(<=|>=|<|>)\s*([A-Z_]\w*|-?\d+)$/);
  if (!compared || compared[1] !== variable) {
    return false;
  }

  const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function populatesBatch(body, batchName) {
  const eventPattern = /\b(?:EventData|var)\s+(\w+)\s*=\s*new\s+EventData\s*\(/g;
  let eventMatch;
  while ((eventMatch = eventPattern.exec(body)) !== null) {
    const openingIndex = body.indexOf("(", eventMatch.index);
    const closingIndex = matchingIndex(body, openingIndex);
    if (
      closingIndex === -1 ||
      !body.slice(openingIndex + 1, closingIndex).trim()
    ) {
      continue;
    }
    const eventName = eventMatch[1];
    const remainder = body.slice(eventMatch.index);
    const properties = new RegExp(
      `\\b${eventName}\\s*\\.getProperties\\s*\\(\\s*\\)\\s*\\.put\\s*\\(`,
    );
    const add = new RegExp(
      `\\b${batchName}\\s*\\.tryAdd\\s*\\(\\s*${eventName}\\s*\\)`,
    );
    if (properties.test(remainder) && add.test(remainder)) {
      return true;
    }
  }
  return false;
}

function hasTenEventBatch(source, batchName) {
  const constants = integerConstants(source);
  if (
    loopBodies(source).some(
      ({ header, body }) =>
        iteratesTenTimes(header, constants) &&
        populatesBatch(body, batchName),
    )
  ) {
    return true;
  }

  const stream = /\bIntStream\s*\.\s*(?:range\s*\(\s*0\s*,\s*10\s*\)|rangeClosed\s*\(\s*1\s*,\s*10\s*\))[\s\S]*?->\s*\{([\s\S]*?)\}/g;
  let streamMatch;
  while ((streamMatch = stream.exec(source)) !== null) {
    if (populatesBatch(streamMatch[1], batchName)) {
      return true;
    }
  }

  const additions = source.match(
    new RegExp(`\\b${batchName}\\s*\\.tryAdd\\s*\\(`, "g"),
  )?.length;
  const events = source.match(/\bnew\s+EventData\s*\(/g)?.length;
  const properties = source.match(
    /\.getProperties\s*\(\s*\)\s*\.put\s*\(/g,
  )?.length;
  return additions >= 10 && events >= 10 && properties >= 10;
}

function blobCheckpointStoreIsConfigured(source, processorExpression) {
  const checkpointArgument = callArguments(
    processorExpression,
    "checkpointStore",
  )[0]?.trim();
  if (!checkpointArgument) {
    return false;
  }

  let checkpointExpression = checkpointArgument;
  if (/^\w+$/.test(checkpointArgument)) {
    checkpointExpression =
      resolveAssignment(
        source,
        checkpointArgument,
        "(?:Blob)?CheckpointStore",
      ) ?? "";
  }
  if (!/\bnew\s+BlobCheckpointStore\s*\(/.test(checkpointExpression)) {
    return false;
  }

  const storeStart = checkpointExpression.search(
    /\bnew\s+BlobCheckpointStore\s*\(/,
  );
  const open = checkpointExpression.indexOf("(", storeStart);
  const close = matchingIndex(checkpointExpression, open);
  if (close === -1) {
    return false;
  }
  const containerArgument = checkpointExpression
    .slice(open + 1, close)
    .trim();
  let containerExpression = containerArgument;
  if (/^\w+$/.test(containerArgument)) {
    containerExpression =
      resolveAssignment(
        source,
        containerArgument,
        "BlobContainerAsyncClient",
      ) ?? "";
  }

  return (
    /\bnew\s+BlobContainerClientBuilder\s*\(/.test(containerExpression) &&
    /\.containerName\s*\(/.test(containerExpression) &&
    /\.buildAsyncClient\s*\(/.test(containerExpression) &&
    (callArguments(containerExpression, "connectionString").length > 0 ||
      (callArguments(containerExpression, "endpoint").length > 0 &&
        (callArguments(containerExpression, "credential").length > 0 ||
          callArguments(containerExpression, "sasToken").length > 0)))
  );
}

function processorAssignments(source) {
  return assignmentExpressions(source, "EventProcessorClient")
    .filter((assignment) =>
      /\.buildEventProcessorClient\s*\(/.test(assignment.expression),
    )
    .map((assignment) => ({
      ...assignment,
      builder: resolveBuilder(
        source,
        assignment.expression,
        "EventProcessorClientBuilder",
      ),
    }));
}

function resolveHandlerBody(source, argument) {
  const arrow = argument.indexOf("->");
  if (arrow !== -1) {
    return argument.slice(arrow + 2);
  }

  const methodName = argument.match(/::\s*(\w+)/)?.[1];
  if (methodName) {
    const method = new RegExp(
      `\\b${methodName}\\s*\\([^)]*\\)\\s*\\{`,
      "g",
    ).exec(source);
    if (!method) {
      return "";
    }
    const open = source.indexOf("{", method.index);
    const close = matchingIndex(source, open, "{", "}");
    return close === -1 ? "" : source.slice(open + 1, close);
  }

  const handlerName = argument.trim();
  if (!/^\w+$/.test(handlerName)) {
    return "";
  }
  const declaration = new RegExp(
    `\\b(?:Consumer\\s*<[^>]+>|var)\\s+${handlerName}\\s*=\\s*`,
  ).exec(source);
  if (!declaration) {
    return "";
  }
  const expression = source.slice(
    declaration.index + declaration[0].length,
    statementEnd(source, declaration.index + declaration[0].length),
  );
  const handlerArrow = expression.indexOf("->");
  return handlerArrow === -1 ? "" : expression.slice(handlerArrow + 2);
}

function handlerBodies(source, processorExpression, method) {
  return callArguments(processorExpression, method)
    .map((argumentsText) => splitTopLevel(argumentsText)[0])
    .map((argument) => resolveHandlerBody(source, argument))
    .filter(Boolean);
}

function printsEventBody(body) {
  const direct =
    /System\.out\.(?:print|println|printf)\s*\([\s\S]*?(?:getEventData\s*\(\s*\)[\s\S]*?)?getBodyAsString\s*\(/.test(
      body,
    ) ||
    /System\.out\.(?:print|println|printf)\s*\([\s\S]*?getBody\s*\(\s*\)(?:\s*\.toString\s*\(\s*\))?/.test(
      body,
    );
  const assigned =
    /\b(?:String|var)\s+(\w+)\s*=[^;]*(?:getBodyAsString\s*\(|getBody\s*\(\s*\))[^;]*;[\s\S]{0,300}?System\.out\.(?:print|println|printf)\s*\(\s*\1\b/.test(
      body,
    );
  return direct || assigned;
}

function usesDefaultConsumerGroup(processorExpression) {
  return callArguments(processorExpression, "consumerGroup").some(
    (argument) =>
      /^(?:EventHubClientBuilder\.)?DEFAULT_CONSUMER_GROUP_NAME$/.test(
        argument.trim(),
      ) || /^"\$Default"$/.test(argument.trim()),
  );
}

function printsError(body) {
  return (
    /System\.err\.(?:print|println|printf)\s*\([\s\S]*?getThrowable\s*\(/.test(
      body,
    ) ||
    /\.getThrowable\s*\(\s*\)\s*\.printStackTrace\s*\(/.test(body)
  );
}

function eventHandlerBodies(source, processor) {
  return [
    ...handlerBodies(source, processor.builder, "processEvent"),
    ...handlerBodies(source, processor.builder, "processEventBatch"),
  ];
}

function resourceManaged(source, clientName) {
  const pattern = /\btry\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf("(", match.index);
    const close = matchingIndex(source, open);
    if (
      close !== -1 &&
      new RegExp(`\\b${clientName}\\b`).test(source.slice(open + 1, close))
    ) {
      return true;
    }
  }
  return false;
}

function hasWaitBetween(source, start, stop) {
  const middle = source.slice(start, stop);
  return (
    /\bThread\s*\.\s*sleep\s*\(/.test(middle) ||
    /\bTimeUnit\s*\.\s*\w+\s*\.\s*sleep\s*\(/.test(middle) ||
    /\.(?:await|join)\s*\(/.test(middle) ||
    /\bSystem\s*\.\s*in\s*\.\s*read\s*\(/.test(middle) ||
    /\.(?:next|nextLine)\s*\(/.test(middle)
  );
}

function hasAzureDependency(build, artifact) {
  const dependencies = build.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [];
  const maven = dependencies.some(
    (dependency) =>
      /<groupId>\s*com\.azure\s*<\/groupId>/.test(dependency) &&
      new RegExp(
        `<artifactId>\\s*${artifact}\\s*<\\/artifactId>`,
      ).test(dependency),
  );
  const gradle = new RegExp(
    `["']com\\.azure:${artifact}(?::[^"']+)?["']`,
  ).test(build);
  return maven || gradle;
}

const rules = {
  "prompt/event-hubs-packages": ({ build }) =>
    ["azure-messaging-eventhubs", "azure-messaging-eventhubs-checkpointstore-blob"].every(
      (artifact) => hasAzureDependency(build, artifact),
    ),
  "prompt/producer-client": ({ source }) =>
    producerAssignments(source).some(
      ({ builder }) =>
        /\bnew\s+EventHubClientBuilder\s*\(/.test(builder) &&
        hasAuthentication(builder),
    ),
  "prompt/event-batch": ({ source }) =>
    batchAssignments(source).some(({ name }) => hasTenEventBatch(source, name)),
  "prompt/send-batch": ({ source }) =>
    batchAssignments(source).some(({ name, producer }) =>
      new RegExp(
        `\\b${producer.name}\\s*\\.send\\s*\\(\\s*${name}\\b`,
      ).test(source),
    ),
  "prompt/checkpointed-consumer": ({ source }) =>
    processorAssignments(source).some(
      (processor) =>
        /\bnew\s+EventProcessorClientBuilder\s*\(/.test(processor.builder) &&
        usesDefaultConsumerGroup(processor.builder) &&
        hasAuthentication(processor.builder) &&
        /\.processEvent(?:Batch)?\s*\(/.test(processor.builder) &&
        /\.processError\s*\(/.test(processor.builder) &&
        blobCheckpointStoreIsConfigured(source, processor.builder),
    ),
  "prompt/receive-handlers": ({ source }) =>
    processorAssignments(source).some((processor) => {
      const eventBodies = eventHandlerBodies(source, processor);
      const errorBodies = handlerBodies(
        source,
        processor.builder,
        "processError",
      );
      return eventBodies.some(printsEventBody) && errorBodies.some(printsError);
    }),
  "prompt/update-checkpoint": ({ source }) =>
    processorAssignments(source).some((processor) =>
      eventHandlerBodies(source, processor).some((body) =>
        /\.updateCheckpoint\s*\(\s*\)/.test(body),
      ),
    ),
  "prompt/client-lifecycle": ({ source }) =>
    producerAssignments(source).some((producer) =>
      processorAssignments(source).some((processor) => {
        const start = source.search(
          new RegExp(`\\b${processor.name}\\s*\\.start\\s*\\(`),
        );
        const stop = source.search(
          new RegExp(`\\b${processor.name}\\s*\\.stop\\s*\\(`),
        );
        const producerCleanup =
          new RegExp(`\\b${producer.name}\\s*\\.close\\s*\\(`).test(source) ||
          resourceManaged(source, producer.name);
        return (
          start !== -1 &&
          stop > start &&
          hasWaitBetween(source, start, stop) &&
          producerCleanup
        );
      }),
    ),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) {
    throw new Error(`Unknown rule: ${name}`);
  }
  return rule({
    ...workspace,
    source: sanitizeJava(workspace.source ?? ""),
    build: workspace.build ?? "",
  });
}

export function ruleNames() {
  return Object.keys(rules);
}
