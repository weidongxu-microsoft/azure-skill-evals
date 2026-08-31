import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const analyzerPath = fileURLToPath(
  new URL("./event_hubs_analyzer.py", import.meta.url),
);
const semanticCache = new WeakMap();

function semanticAnalysis(workspace) {
  if (semanticCache.has(workspace)) return semanticCache.get(workspace);
  const result = spawnSync("python", [analyzerPath], {
    encoding: "utf8",
    input: JSON.stringify({ source: workspace.python ?? "" }),
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `Event Hubs analysis failed: ${result.stderr || result.stdout}`,
    );
  }
  const analysis = JSON.parse(result.stdout);
  semanticCache.set(workspace, analysis);
  return analysis;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codeOnly(source) {
  let result = "";
  let quote = null;
  let triple = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (quote !== null) {
      if (character === "\n") {
        result += "\n";
        if (!triple) {
          quote = null;
        }
        continue;
      }

      if (
        triple &&
        character === quote &&
        source.slice(index, index + 3) === quote.repeat(3)
      ) {
        result += "   ";
        index += 2;
        quote = null;
        triple = false;
      } else if (
        !triple &&
        character === quote &&
        source[index - 1] !== "\\"
      ) {
        result += " ";
        quote = null;
      } else {
        result += " ";
      }
      continue;
    }

    if (character === "#") {
      while (index < source.length && source[index] !== "\n") {
        result += " ";
        index += 1;
      }
      if (index < source.length) {
        result += "\n";
      }
      continue;
    }

    if (character === "'" || character === '"') {
      triple = source.slice(index, index + 3) === character.repeat(3);
      quote = character;
      result += triple ? "   " : " ";
      if (triple) {
        index += 2;
      }
      continue;
    }

    result += character;
  }

  return result;
}

function symbolNames(source, className) {
  const names = new Set([className]);
  const aliasPattern = new RegExp(
    `\\b${escapeRegularExpression(className)}\\s+as\\s+(\\w+)`,
    "g",
  );

  for (const match of source.matchAll(aliasPattern)) {
    names.add(match[1]);
  }
  return [...names];
}

function findClosingParenthesis(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === "(") {
      depth += 1;
    } else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitArguments(argumentSource) {
  const argumentsList = [];
  let depth = 0;
  let start = 0;
  let lambdaParameters = false;

  for (let index = 0; index < argumentSource.length; index += 1) {
    const character = argumentSource[index];
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (
      depth === 0 &&
      argumentSource.slice(index).match(/^lambda\b/)
    ) {
      lambdaParameters = true;
    } else if (depth === 0 && lambdaParameters && character === ":") {
      lambdaParameters = false;
    } else if (depth === 0 && !lambdaParameters && character === ",") {
      argumentsList.push(argumentSource.slice(start, index).trim());
      start = index + 1;
    }
  }

  const finalArgument = argumentSource.slice(start).trim();
  if (finalArgument) {
    argumentsList.push(finalArgument);
  }
  return argumentsList;
}

function splitNamedArgument(argument) {
  let depth = 0;
  for (let index = 0; index < argument.length; index += 1) {
    const character = argument[index];
    if ("([{".includes(character)) {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    } else if (depth === 0 && character === "=") {
      return [argument.slice(0, index).trim(), argument.slice(index + 1).trim()];
    }
  }
  return null;
}

function parseArguments(argumentSource) {
  const positional = [];
  const named = new Map();
  for (const argument of splitArguments(argumentSource)) {
    const pair = splitNamedArgument(argument);
    if (pair && /^\w+$/.test(pair[0])) {
      named.set(pair[0], pair[1]);
    } else {
      positional.push(argument);
    }
  }
  return { named, positional };
}

function collectClientConstructions(source, className) {
  const constructions = [];
  for (const symbol of symbolNames(source, className)) {
    const pattern = new RegExp(
      `\\b(\\w+)\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?(?:\\w+\\.)*${escapeRegularExpression(symbol)}(?:\\s*\\.\\s*from_connection_string)?\\s*\\(`,
      "g",
    );
    for (const match of source.matchAll(pattern)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const closingIndex = findClosingParenthesis(source, openingIndex);
      if (closingIndex !== -1) {
        constructions.push({
          args: source.slice(openingIndex + 1, closingIndex),
          variable: match[1],
        });
      }
    }

    const inlinePattern = new RegExp(
      `(?:async\\s+)?with\\s+(?:\\w+\\.)*${escapeRegularExpression(symbol)}(?:\\s*\\.\\s*from_connection_string)?\\s*\\(`,
      "g",
    );
    for (const match of source.matchAll(inlinePattern)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const closingIndex = findClosingParenthesis(source, openingIndex);
      if (closingIndex === -1) {
        continue;
      }
      const suffix = source.slice(closingIndex + 1, closingIndex + 100);
      const alias = suffix.match(/^\s+as\s+(\w+)/);
      if (alias) {
        constructions.push({
          args: source.slice(openingIndex + 1, closingIndex),
          inlineManaged: true,
          variable: alias[1],
        });
      }
    }
  }
  return constructions;
}

function collectMethodCalls(source, methodNames, receivers) {
  const calls = [];
  const methods = methodNames.map(escapeRegularExpression).join("|");
  const pattern = new RegExp(`\\b(\\w+)\\s*\\.\\s*(${methods})\\s*\\(`, "g");

  for (const match of source.matchAll(pattern)) {
    if (receivers && !receivers.has(match[1])) {
      continue;
    }
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const closingIndex = findClosingParenthesis(source, openingIndex);
    if (closingIndex !== -1) {
      calls.push({
        args: source.slice(openingIndex + 1, closingIndex),
        method: match[2],
        receiver: match[1],
      });
    }
  }
  return calls;
}

function collectBatchConstructions(source, producerVariables) {
  const batches = [];
  const pattern =
    /\b(\w+)\s*(?::[^=\n]+)?=\s*(?:await\s+)?(\w+)\s*\.\s*create_batch\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    if (producerVariables.has(match[2])) {
      batches.push({ producer: match[2], variable: match[1] });
    }
  }
  return batches;
}

function indentedBlocks(source, headerPattern) {
  const lines = source.split(/\r?\n/);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(headerPattern);
    if (!match) {
      continue;
    }

    const indentation = match[1].length;
    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() && line.match(/^\s*/)[0].length <= indentation) {
        break;
      }
      end += 1;
    }
    blocks.push({ body: lines.slice(index + 1, end).join("\n"), match });
  }
  return blocks;
}

function functionDetails(source, reference) {
  const name = reference.trim().match(/(?:^|\.)((?:\w)+)$/)?.[1];
  if (!name) {
    return null;
  }

  const pattern = new RegExp(
    `^(\\s*)(?:async\\s+)?def\\s+${escapeRegularExpression(name)}\\s*\\(([^)]*)\\)[^:]*:\\s*$`,
  );
  for (const block of indentedBlocks(source, pattern)) {
    const parameters = splitArguments(block.match[2])
      .map((parameter) => parameter.split(/[=:]/, 1)[0].replace(/^\*+/, "").trim())
      .filter(Boolean);
    return { body: block.body, parameters };
  }
  return null;
}

function receiveHandlerArguments(call) {
  const parsed = parseArguments(call.args);
  return {
    error: parsed.named.get("on_error"),
    event:
      parsed.named.get(call.method === "receive_batch" ? "on_event_batch" : "on_event") ??
      parsed.positional[0],
  };
}

function callbackDetails(source, expression) {
  if (!expression) {
    return null;
  }

  const lambda = expression.match(/\blambda\s+([^:]+):([\s\S]*)/);
  if (lambda) {
    return {
      body: lambda[2],
      parameters: splitArguments(lambda[1]).map((parameter) =>
        parameter.trim().replace(/^\*+/, ""),
      ),
    };
  }
  return functionDetails(source, expression);
}

function eventReferences(details, isBatch) {
  if (!details || details.parameters.length < 2) {
    return [];
  }

  const eventParameter = details.parameters[1];
  const escapedParameter = escapeRegularExpression(eventParameter);
  const references = isBatch
    ? [`${escapedParameter}\\s*\\[[^\\]]+\\]`]
    : [escapedParameter];

  if (isBatch) {
    const loopPattern = new RegExp(
      `\\bfor\\s+(\\w+)\\s+in\\s+${escapedParameter}\\b`,
      "g",
    );
    for (const match of details.body.matchAll(loopPattern)) {
      references.push(escapeRegularExpression(match[1]));
    }
  }
  return references;
}

function handlerUpdatesCheckpoint(source, expression, isBatch) {
  const details = callbackDetails(source, expression);
  if (!details || details.parameters.length < 2) {
    return false;
  }
  const partitionContext = details.parameters[0];
  const references = eventReferences(details, isBatch);
  if (references.length === 0) {
    return false;
  }
  return new RegExp(
    `\\b${escapeRegularExpression(partitionContext)}\\s*\\.\\s*update_checkpoint\\s*\\(\\s*(?:event\\s*=\\s*)?(?:${references.join("|")})(?!\\w)`,
  ).test(details.body);
}

function clientIsManaged(source, construction) {
  if (construction.inlineManaged) {
    return true;
  }
  const variable = escapeRegularExpression(construction.variable);
  return (
    new RegExp(`(?:async\\s+)?with[^\\n:]*\\b${variable}\\b`).test(source) ||
    new RegExp(`\\b${variable}\\s*\\.\\s*close\\s*\\(`).test(source) ||
    new RegExp(
      `\\.\\s*enter_(?:async_)?context\\s*\\(\\s*${variable}\\b`,
    ).test(source)
  );
}

function createContext(workspace) {
  const source = codeOnly(workspace.python);
  const producers = collectClientConstructions(source, "EventHubProducerClient");
  const consumers = collectClientConstructions(source, "EventHubConsumerClient");
  const producerVariables = new Set(producers.map(({ variable }) => variable));
  const consumerVariables = new Set(consumers.map(({ variable }) => variable));
  const batches = collectBatchConstructions(source, producerVariables);
  const receiveCalls = collectMethodCalls(
    source,
    ["receive", "receive_batch"],
    consumerVariables,
  );

  return {
    batches,
    consumers,
    consumerVariables,
    producers,
    producerVariables,
    receiveCalls,
    source,
  };
}

const rules = {
  "prompt/event-hubs-packages": ({ dependencies }) =>
    /\bazure-eventhub(?:\s*(?:==|>=|~=|<|>|@)|\b)/i.test(dependencies) &&
    /\bazure-eventhub-checkpointstoreblob-aio(?:\s*(?:==|>=|~=|<|>|@)|\b)/i.test(
      dependencies,
    ),
  "prompt/producer-client": (workspace) =>
    createContext(workspace).producers.length > 0,
  "prompt/event-batch": (workspace) =>
    semanticAnalysis(workspace).event_batch,
  "prompt/send-batch": (workspace) => {
    const context = createContext(workspace);
    return context.batches.some((batch) =>
      collectMethodCalls(
        context.source,
        ["send_batch"],
        new Set([batch.producer]),
      ).some(
        (call) =>
          splitArguments(call.args)[0]?.trim() === batch.variable,
      ),
    );
  },
  "prompt/checkpointed-consumer": (workspace) => {
    const context = createContext(workspace);
    const stores = collectClientConstructions(
      context.source,
      "BlobCheckpointStore",
    );
    const storeVariables = new Set(stores.map(({ variable }) => variable));
    const storeSymbols = symbolNames(context.source, "BlobCheckpointStore");

    return context.consumers.some((consumer) => {
      const checkpoint = parseArguments(consumer.args).named.get(
        "checkpoint_store",
      );
      return (
        checkpoint !== undefined &&
        (storeVariables.has(checkpoint.trim()) ||
          storeSymbols.some((symbol) =>
            new RegExp(`\\b${escapeRegularExpression(symbol)}\\b`).test(
              checkpoint,
            ),
          ))
      );
    });
  },
  "prompt/receive-handlers": (workspace) =>
    semanticAnalysis(workspace).receive_handlers,
  "prompt/update-checkpoint": (workspace) => {
    const context = createContext(workspace);
    return context.receiveCalls.some((call) =>
      handlerUpdatesCheckpoint(
        context.source,
        receiveHandlerArguments(call).event,
        call.method === "receive_batch",
      ),
    );
  },
  "prompt/client-lifecycle": (workspace) => {
    const context = createContext(workspace);
    return (
      context.producers.length > 0 &&
      context.consumers.length > 0 &&
      context.producers.every((client) =>
        clientIsManaged(context.source, client),
      ) &&
      context.consumers.every((client) =>
        clientIsManaged(context.source, client),
      )
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
