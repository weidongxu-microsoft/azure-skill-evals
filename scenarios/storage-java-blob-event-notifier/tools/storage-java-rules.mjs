import { spawnSync } from "node:child_process";

const PINS = [
  ["com.azure", "azure-identity", "1.18.5"],
  ["com.azure", "azure-storage-blob", "12.35.1"],
  ["com.azure", "azure-messaging-eventgrid", "4.31.8"],
];

const SDK_TYPES = {
  BinaryData: "com.azure.core.util",
  TokenCredential: "com.azure.core.credential",
  BlobAsyncClient: "com.azure.storage.blob",
  BlobClient: "com.azure.storage.blob",
  BlobProperties: "com.azure.storage.blob.models",
  BlobServiceAsyncClient: "com.azure.storage.blob",
  BlobServiceClient: "com.azure.storage.blob",
  BlobServiceClientBuilder: "com.azure.storage.blob",
  BlobStorageException: "com.azure.storage.blob.models",
  CloudEvent: "com.azure.core.models",
  AzureCliCredentialBuilder: "com.azure.identity",
  DefaultAzureCredentialBuilder: "com.azure.identity",
  EnvironmentCredentialBuilder: "com.azure.identity",
  EventGridEvent: "com.azure.messaging.eventgrid",
  EventGridPublisherAsyncClient: "com.azure.messaging.eventgrid",
  EventGridPublisherClient: "com.azure.messaging.eventgrid",
  EventGridPublisherClientBuilder: "com.azure.messaging.eventgrid",
  HttpResponseException: "com.azure.core.exception",
  ManagedIdentityCredentialBuilder: "com.azure.identity",
  WorkloadIdentityCredentialBuilder: "com.azure.identity",
};

const SECURE_CREDENTIAL_BUILDERS = new Set([
  "AzureCliCredentialBuilder",
  "DefaultAzureCredentialBuilder",
  "EnvironmentCredentialBuilder",
  "ManagedIdentityCredentialBuilder",
  "WorkloadIdentityCredentialBuilder",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskJava(source, preserveStrings = false) {
  let result = "";
  let state = "code";
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
    } else if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
    } else if (state === "text-block") {
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
    } else if (state === "string" || state === "character") {
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
    } else if (character === "/" && next === "/") {
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
  if (start < 0 || text[start] !== opening) return -1;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === opening) depth += 1;
    if (text[index] === closing && --depth === 0) return index;
  }
  return -1;
}

function skipWhitespace(text, start) {
  let index = start;
  while (/\s/.test(text[index] ?? "")) index += 1;
  return index;
}

function startsWithWord(text, index, word) {
  return text.slice(index, index + word.length) === word &&
    !/[\w$]/.test(text[index - 1] ?? "") &&
    !/[\w$]/.test(text[index + word.length] ?? "");
}

function javaStatementEnd(text, start) {
  const first = skipWhitespace(text, start);
  if (first >= text.length) return -1;
  const labeled = /^([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(first));
  if (labeled && !["case", "default"].includes(labeled[1])) {
    return javaStatementEnd(text, first + labeled[0].length);
  }
  if (text[first] === "{") {
    const close = matchingIndex(text, first, "{", "}");
    return close < 0 ? -1 : close + 1;
  }
  if (startsWithWord(text, first, "if")) {
    const open = text.indexOf("(", first + 2);
    const close = matchingIndex(text, open);
    if (open < 0 || close < 0) return -1;
    const consequentEnd = javaStatementEnd(text, close + 1);
    if (consequentEnd < 0) return -1;
    const alternateWord = skipWhitespace(text, consequentEnd);
    if (!startsWithWord(text, alternateWord, "else")) return consequentEnd;
    return javaStatementEnd(text, alternateWord + 4);
  }
  if (startsWithWord(text, first, "do")) {
    const bodyEnd = javaStatementEnd(text, first + 2);
    if (bodyEnd < 0) return -1;
    const whileWord = skipWhitespace(text, bodyEnd);
    if (!startsWithWord(text, whileWord, "while")) return -1;
    const open = text.indexOf("(", whileWord + 5);
    const close = matchingIndex(text, open);
    if (open < 0 || close < 0) return -1;
    const semicolon = skipWhitespace(text, close + 1);
    return text[semicolon] === ";" ? semicolon + 1 : -1;
  }
  if (startsWithWord(text, first, "try")) {
    let cursor = skipWhitespace(text, first + 3);
    if (text[cursor] === "(") {
      const resourcesEnd = matchingIndex(text, cursor);
      if (resourcesEnd < 0) return -1;
      cursor = skipWhitespace(text, resourcesEnd + 1);
    }
    cursor = javaStatementEnd(text, cursor);
    if (cursor < 0) return -1;
    while (true) {
      const keyword = skipWhitespace(text, cursor);
      if (startsWithWord(text, keyword, "catch")) {
        const open = text.indexOf("(", keyword + 5);
        const close = matchingIndex(text, open);
        if (open < 0 || close < 0) return -1;
        cursor = javaStatementEnd(text, close + 1);
        if (cursor < 0) return -1;
        continue;
      }
      if (startsWithWord(text, keyword, "finally")) {
        return javaStatementEnd(text, keyword + 7);
      }
      return cursor;
    }
  }
  if (
    startsWithWord(text, first, "while") ||
    startsWithWord(text, first, "for") ||
    startsWithWord(text, first, "switch") ||
    startsWithWord(text, first, "synchronized")
  ) {
    const open = text.indexOf("(", first);
    const close = matchingIndex(text, open);
    return open < 0 || close < 0 ? -1 : javaStatementEnd(text, close + 1);
  }
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = first; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (
      character === ";" &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      return index + 1;
    }
  }
  return -1;
}

function functionalExpressionEnd(code, start) {
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = start; index < code.length; index += 1) {
    const character = code[index];
    if (character in depth) {
      depth[character] += 1;
      continue;
    }
    if (character in closing) {
      const opening = closing[character];
      if (depth[opening] === 0) return index;
      depth[opening] -= 1;
      continue;
    }
    if (
      (character === "," || character === ";") &&
      Object.values(depth).every((value) => value === 0)
    ) {
      return index;
    }
  }
  return code.length;
}

function enclosingFunctionalCall(code, position) {
  let depth = 0;
  for (let index = position - 1; index >= 0; index -= 1) {
    if (code[index] === ")") {
      depth += 1;
      continue;
    }
    if (code[index] !== "(") continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    return /([A-Za-z_$][\w$]*)\s*$/.exec(
      code.slice(0, index),
    )?.[1] ?? null;
  }
  return null;
}

function functionalStatement(code, position) {
  const start = Math.max(
    code.lastIndexOf(";", position - 1),
    code.lastIndexOf("{", position - 1),
    code.lastIndexOf("}", position - 1),
  ) + 1;
  const end = javaStatementEnd(code, start);
  return {
    start,
    end: end < 0 ? code.length : end,
    text: code.slice(start, end < 0 ? code.length : end),
  };
}

function assignedFunctionalName(statement, position) {
  return /\b([A-Za-z_$][\w$]*)\s*=\s*[\s\S]*$/.exec(
    statement.text.slice(0, position - statement.start),
  )?.[1] ?? null;
}

function functionalValueInvocationPositions(code, name, bodyEnd) {
  if (!name) return [];
  return Array.from(
    code.slice(bodyEnd).matchAll(
      new RegExp(
        `\\b${escapeRegExp(name)}\\s*\\.\\s*(?:accept|apply|call|get|run|test)\\s*\\(`,
        "g",
      ),
    ),
    (match) => bodyEnd + match.index,
  );
}

const publisherTransformCallbackMethods = new Set([
  "as",
  "publish",
  "transform",
  "transformDeferred",
  "transformDeferredContextual",
]);

const reactorCallbackMethods = new Set([
  "concatMap",
  "defer",
  "doOnError",
  "doOnNext",
  "filter",
  "flatMap",
  "flatMapMany",
  "fromCallable",
  "fromRunnable",
  "handle",
  "map",
  "onErrorMap",
  "onErrorResume",
  "switchIfEmpty",
  "then",
  ...publisherTransformCallbackMethods,
]);

const publisherArgumentMethods = new Set([
  "and",
  "amb",
  "concat",
  "concatDelayError",
  "concatWith",
  "firstWithValue",
  "firstWithSignal",
  "from",
  "fromDirect",
  "merge",
  "mergeDelayError",
  "mergeSequential",
  "mergeWith",
  "startWith",
  "switchIfEmpty",
  "then",
  "thenEmpty",
  "thenMany",
  "when",
  "whenDelayError",
  "zip",
  "zipDelayError",
  "zipWith",
]);

const publisherReturningCallbackMethods = new Set([
  "concatMap",
  "delayUntil",
  "defer",
  "flatMap",
  "flatMapMany",
  "onErrorResume",
  ...publisherTransformCallbackMethods,
]);

function trustedReactorStaticReceiver(runtime, receiver) {
  const compact = receiver.replace(/\s+/g, "");
  const name = compact.split(".").at(-1);
  return (
    ["Mono", "Flux"].includes(name) &&
    !runtime.localSimpleTypes.has(name) &&
    (
      compact === name ||
      compact === `reactor.core.publisher.${name}`
    )
  );
}

function reactorPublisherExpression(
  runtime,
  method,
  expression,
  seen = new Set(),
) {
  const value = unwrapParentheses(expression);
  if (!value || seen.has(value)) return false;
  const nextSeen = new Set(seen).add(value);
  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) {
    return /^(?:Mono|Flux|Publisher)$/.test(
      methodVariableTypes(runtime, method).get(reference) ?? "",
    );
  }
  const calls = topLevelMethodCalls(value);
  const call = calls
    .filter(({ close }) => !value.slice(close + 1).trim().startsWith("("))
    .at(-1);
  if (!call) return false;
  const receiver = callReceiverExpression(value, call);
  if (trustedReactorStaticReceiver(runtime, receiver)) return true;
  if (
    methodCallTargets(runtime, method, call).some(reactorReturningMethod)
  ) {
    return true;
  }
  return receiver !== value &&
    reactorPublisherExpression(runtime, method, receiver, nextSeen);
}

function subscribedPublisherArgumentIndexes(
  runtime,
  method,
  expression,
  call,
) {
  if (!publisherArgumentMethods.has(call.name)) return [];
  const receiver = callReceiverExpression(expression, call);
  if (
    [
      "amb",
      "concat",
      "concatDelayError",
      "firstWithValue",
      "firstWithSignal",
      "from",
      "fromDirect",
      "merge",
      "mergeDelayError",
      "mergeSequential",
      "when",
      "whenDelayError",
      "zip",
      "zipDelayError",
    ].includes(call.name)
  ) {
    if (!trustedReactorStaticReceiver(runtime, receiver)) return [];
    return ["from", "fromDirect"].includes(call.name)
      ? call.arguments.length > 0 ? [0] : []
      : call.arguments.map((_, index) => index);
  }
  if (
    [
      "and",
      "concatWith",
      "mergeWith",
      "startWith",
      "switchIfEmpty",
      "then",
      "thenEmpty",
      "thenMany",
      "zipWith",
    ].includes(call.name) &&
    reactorPublisherExpression(runtime, method, receiver)
  ) {
    return call.arguments.length > 0 ? [0] : [];
  }
  return [];
}

function mergePublisherDataOrigins(...values) {
  const merged = new Map();
  for (const value of values) {
    for (const origin of value ?? []) {
      const key = `${origin.depth}\u0000${origin.expression}`;
      if (!merged.has(key)) merged.set(key, origin);
    }
  }
  return [...merged.values()];
}

function intersectPublisherDataOrigins(...values) {
  if (values.length === 0) return [];
  const keys = values.map(
    (origins) =>
      new Set(
        (origins ?? []).map(
          ({ depth, expression }) => `${depth}\u0000${expression}`,
        ),
      ),
  );
  return (values[0] ?? []).filter(({ depth, expression }) =>
    keys.slice(1).every((candidates) =>
      candidates.has(`${depth}\u0000${expression}`)
    )
  );
}

function intersectPublisherExpressions(...values) {
  if (values.length === 0) return [];
  const candidates = values.map((value) => new Set(value ?? []));
  return [...candidates[0]].filter((expression) =>
    candidates.slice(1).every((branch) => branch.has(expression))
  );
}

function mergeBranchEnvironments(environment, branches, mergeValue) {
  const names = new Set(branches.flatMap((branch) => [...branch.keys()]));
  environment.clear();
  for (const name of names) {
    environment.set(
      name,
      mergeValue(branches.map((branch) => branch.get(name))),
    );
  }
}

function evaluateJavaConditionSideEffects(
  expression,
  environment,
  evaluate,
  mergeValue,
) {
  const value = unwrapParentheses(expression);
  if (!value) return;

  const assignment = topLevelAssignmentExpression(value);
  if (assignment) {
    evaluate(value, environment);
    return;
  }

  const conditional = splitTopLevelConditional(value);
  if (conditional) {
    evaluateJavaConditionSideEffects(
      conditional.condition,
      environment,
      evaluate,
      mergeValue,
    );
    const truth = staticJavaBoolean(conditional.condition);
    if (truth === true) {
      evaluateJavaConditionSideEffects(
        conditional.consequent,
        environment,
        evaluate,
        mergeValue,
      );
      return;
    }
    if (truth === false) {
      evaluateJavaConditionSideEffects(
        conditional.alternate,
        environment,
        evaluate,
        mergeValue,
      );
      return;
    }
    const consequent = new Map(environment);
    const alternate = new Map(environment);
    evaluateJavaConditionSideEffects(
      conditional.consequent,
      consequent,
      evaluate,
      mergeValue,
    );
    evaluateJavaConditionSideEffects(
      conditional.alternate,
      alternate,
      evaluate,
      mergeValue,
    );
    mergeBranchEnvironments(
      environment,
      [consequent, alternate],
      mergeValue,
    );
    return;
  }

  for (const operator of ["||", "&&"]) {
    const parts = splitTopLevelBoolean(value, operator);
    if (!parts) continue;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      evaluateJavaConditionSideEffects(
        part,
        environment,
        evaluate,
        mergeValue,
      );
      const truth = staticJavaBoolean(part);
      if (
        operator === "||" && truth === true ||
        operator === "&&" && truth === false
      ) {
        return;
      }
      if (truth === null && index + 1 < parts.length) {
        const skipped = new Map(environment);
        const executed = new Map(environment);
        evaluateJavaConditionSideEffects(
          parts.slice(index + 1).join(` ${operator} `),
          executed,
          evaluate,
          mergeValue,
        );
        mergeBranchEnvironments(
          environment,
          [skipped, executed],
          mergeValue,
        );
        return;
      }
    }
    return;
  }

  if (value.startsWith("!") && !value.startsWith("!=")) {
    evaluateJavaConditionSideEffects(
      value.slice(1),
      environment,
      evaluate,
      mergeValue,
    );
    return;
  }

  const comparison = topLevelComparison(value);
  if (comparison) {
    evaluateJavaConditionSideEffects(
      comparison.left,
      environment,
      evaluate,
      mergeValue,
    );
    evaluateJavaConditionSideEffects(
      comparison.right,
      environment,
      evaluate,
      mergeValue,
    );
    return;
  }

  const assignments = simpleAssignmentExpressions(value)
    .filter(
      (candidate, index, candidates) =>
        !candidates.some(
          (owner, ownerIndex) =>
            ownerIndex !== index &&
            owner.position <= candidate.position &&
            candidate.end <= owner.end &&
            (
              owner.position < candidate.position ||
              candidate.end < owner.end
            ),
        ),
    )
    .sort((left, right) => left.position - right.position);
  for (const nested of assignments) {
    evaluate(value.slice(nested.position, nested.end), environment);
  }
}

function shiftPublisherDataOrigins(origins, amount) {
  return mergePublisherDataOrigins(
    origins
      .map((origin) => ({ ...origin, depth: origin.depth + amount }))
      .filter(({ depth }) => depth >= 0),
  );
}

function trustedPublisherContainerReceiver(
  runtime,
  method,
  receiver,
  position,
) {
  const compact = receiver.replace(/\s+/g, "");
  const name = compact.split(".").at(-1);
  return (
    ["Arrays", "Collections", "List", "Set"].includes(name) &&
    trustedJdkStaticReceiver(
      runtime,
      method,
      receiver,
      "java.util",
      name,
      position,
    )
  );
}

function lambdaParameterSegment(code, arrow) {
  let end = arrow;
  while (end > 0 && /\s/.test(code[end - 1])) end -= 1;
  if (code[end - 1] !== ")") {
    const match = /([A-Za-z_$][\w$]*)$/.exec(code.slice(0, end));
    if (!match) return null;
    const start = end - match[0].length;
    return { start, end, text: code.slice(start, end) };
  }
  let depth = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (code[index] === ")") depth += 1;
    if (code[index] === "(" && --depth === 0) {
      return {
        start: index,
        end,
        text: code.slice(index + 1, end - 1),
      };
    }
  }
  return null;
}

function callbackLexicalBindings(names, length) {
  return names.map((name) => ({
    name,
    position: 0,
    start: 0,
    end: length,
  }));
}

function lambdaLexicalBindings(source) {
  const code = maskJava(source, false);
  const bindings = [];
  for (const match of code.matchAll(/->/g)) {
    const prefixStart = Math.max(
      code.lastIndexOf("\n", match.index - 1),
      code.lastIndexOf(";", match.index - 1),
      code.lastIndexOf("{", match.index - 1),
    ) + 1;
    if (
      /^\s*(?:case\b[\s\S]*|default)\s*$/.test(
        code.slice(prefixStart, match.index),
      )
    ) {
      continue;
    }
    const parameters = lambdaParameterSegment(code, match.index);
    if (!parameters) continue;
    const bodyStart = skipWhitespace(code, match.index + match[0].length);
    const block = code[bodyStart] === "{";
    const close = block
      ? matchingIndex(code, bodyStart, "{", "}")
      : functionalExpressionEnd(code, bodyStart);
    if (close < 0) continue;
    const scopeStart = block ? bodyStart + 1 : bodyStart;
    const scopeEnd = block ? close : close;
    for (const name of parameterNames(parameters.text)) {
      const declaration = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
      let position = parameters.start;
      for (const occurrence of code
        .slice(parameters.start, parameters.end)
        .matchAll(declaration)) {
        position = parameters.start + occurrence.index;
      }
      bindings.push({
        name,
        position,
        start: scopeStart,
        end: scopeEnd,
      });
    }
  }
  return bindings;
}

function lambdaDetails(argument, runtime = null, ownerMethod = null) {
  const structural = maskJava(argument, false);
  const arrow = structural.indexOf("->");
  if (arrow < 0) return null;
  let parameters = structural.slice(0, arrow).trim();
  if (parameters.startsWith("(") && parameters.endsWith(")")) {
    parameters = parameters.slice(1, -1);
  }
  const names = parameterNames(parameters);
  const body = argument.slice(arrow + 2).trim();
  if (!body.startsWith("{")) {
    const callbackMethod = ownerMethod
      ? {
        ...ownerMethod,
        id: `${ownerMethod.id}:callback-expression`,
        code: maskJava(body, false),
        literal: body,
        lexicalBindings: callbackLexicalBindings(names, body.length),
      }
      : null;
    return {
      block: false,
      literal: body,
      method: callbackMethod,
      parameters: names,
      returns: [body],
      returnDetails: [],
    };
  }
  const close = matchingIndex(maskJava(body, false), 0, "{", "}");
  if (close < 0) {
    return {
      block: true,
      literal: "",
      method: null,
      parameters: names,
      returns: [],
      returnDetails: [],
    };
  }
  const literal = body.slice(1, close);
  const callbackMethod = ownerMethod
    ? {
      ...ownerMethod,
      id: `${ownerMethod.id}:callback-block`,
      code: maskJava(`${ownerMethod.code}\n${literal}`, false),
      literal,
      lexicalBindings: callbackLexicalBindings(names, literal.length),
    }
    : null;
  const returnDetails = publisherCallbackReturnDetails(literal, {
    runtime,
    method: callbackMethod,
    returnType: null,
  });
  return {
    block: true,
    literal,
    method: callbackMethod,
    parameters: names,
    returns: returnDetails.map(
      ({ variantExpression }) => variantExpression,
    ),
    returnDetails,
  };
}

function publisherTransformCallback(call, runtime = null, method = null) {
  if (!publisherTransformCallbackMethods.has(call?.name)) return null;
  const callback = lambdaDetails(
    call.arguments[0] ?? "",
    runtime,
    method,
  );
  return callback?.parameters.length ? callback : null;
}

function topLevelAssignmentExpression(expression) {
  const structural = maskJava(expression, false);
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < structural.length; index += 1) {
    const character = structural[index];
    if (character in depth) {
      depth[character] += 1;
      continue;
    }
    if (character in closing) {
      depth[closing[character]] -= 1;
      continue;
    }
    if (
      character !== "=" ||
      !Object.values(depth).every((value) => value === 0)
    ) {
      continue;
    }
    let previous = index - 1;
    while (previous >= 0 && /\s/.test(structural[previous])) previous -= 1;
    let next = index + 1;
    while (next < structural.length && /\s/.test(structural[next])) next += 1;
    if (
      /[=!<>+\-*/%&|^]/.test(structural[previous] ?? "") ||
      /[=>]/.test(structural[next] ?? "")
    ) {
      continue;
    }
    const target = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(
      expression.slice(0, index).trim(),
    )?.[1];
    if (!target) return null;
    return {
      name: target,
      expression: expression.slice(index + 1).trim(),
    };
  }
  return null;
}

function javaTryStatementAt(source, position) {
  const code = maskJava(source, false);
  let cursor = skipWhitespace(code, position + 3);
  let resources = null;
  if (code[cursor] === "(") {
    const resourcesEnd = matchingIndex(code, cursor);
    if (resourcesEnd < 0) return null;
    resources = { start: cursor + 1, end: resourcesEnd };
    cursor = skipWhitespace(code, resourcesEnd + 1);
  }
  const bodyStart = cursor;
  const bodyEnd = javaStatementEnd(code, bodyStart);
  if (bodyEnd < 0) return null;
  const catches = [];
  cursor = bodyEnd;
  while (true) {
    const catchWord = skipWhitespace(code, cursor);
    if (!startsWithWord(code, catchWord, "catch")) break;
    const open = code.indexOf("(", catchWord + 5);
    const close = matchingIndex(code, open);
    if (open < 0 || close < 0) return null;
    const catchStart = skipWhitespace(code, close + 1);
    const catchEnd = javaStatementEnd(code, catchStart);
    if (catchEnd < 0) return null;
    catches.push({
      start: catchStart,
      end: catchEnd,
    });
    cursor = catchEnd;
  }
  let finalizer = null;
  const finallyWord = skipWhitespace(code, cursor);
  if (startsWithWord(code, finallyWord, "finally")) {
    const start = skipWhitespace(code, finallyWord + 7);
    const end = javaStatementEnd(code, start);
    if (end < 0) return null;
    finalizer = { start, end };
    cursor = end;
  }
  if (catches.length === 0 && finalizer === null) return null;
  return {
    start: position,
    end: cursor,
    body: { start: bodyStart, end: bodyEnd },
    catches,
    finalizer,
    resources,
  };
}

function javaStatementMayThrow(statement) {
  const code = maskJava(statement, false);
  if (/\bthrow\b/.test(code)) return true;
  if (/\bnew\s+[A-Za-z_$]/.test(code)) return true;
  if (/(?:^|[^\w$])(?:[A-Za-z_$][\w$]*\s*\.)*[A-Za-z_$][\w$]*\s*\(/.test(
    code,
  )) {
    return true;
  }
  return /\[[^\]]*\]|(?<![/*])[/%](?![/*=])/.test(code);
}

const javaPrimitiveTypes = new Set([
  "boolean",
  "byte",
  "short",
  "int",
  "long",
  "float",
  "double",
  "char",
]);

const javaBoxedPrimitiveTypes = new Set([
  "Boolean",
  "Byte",
  "Short",
  "Integer",
  "Long",
  "Float",
  "Double",
  "Character",
]);

const javaPrimitiveWrappers = new Map([
  ["boolean", "Boolean"],
  ["byte", "Byte"],
  ["short", "Short"],
  ["int", "Integer"],
  ["long", "Long"],
  ["float", "Float"],
  ["double", "Double"],
  ["char", "Character"],
]);

function javaLeadingCast(expression) {
  const value = expression.trim();
  if (!value.startsWith("(")) return null;
  const close = matchingIndex(maskJava(value, false), 0);
  if (close <= 0 || close >= value.length - 1) return null;
  const type = value.slice(1, close).trim();
  if (
    !/^(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*(?:\s*<[^()]*>)?(?:\s*\[\s*\])*$/.test(
      type,
    )
  ) {
    return null;
  }
  return {
    type: normalizeJavaTypeReference(type),
    operand: value.slice(close + 1).trim(),
  };
}

function javaStaticMemberExpression(expression) {
  const value = unwrapParentheses(expression);
  const call =
    /^((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  const member =
    /^((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(
      value,
    );
  const receiver = call?.[1] ?? member?.[1] ?? null;
  if (!receiver) return null;
  const compact = receiver.replace(/\s+/g, "");
  const parts = compact.split(".");
  const declaring = parts.at(-1) ?? "";
  if (
    !/^[A-Z_$]/.test(declaring) &&
    !(parts.length > 1 && /^[a-z_$]/.test(parts[0]))
  ) {
    return null;
  }
  return {
    kind: call ? "method" : "field",
    receiver: compact,
    name: call?.[2] ?? member[2],
  };
}

function javaExpressionTypeFacts(source, context = {}) {
  const sourcePosition = context.sourcePosition ?? source.length;
  const method = context.method
    ? {
      ...context.method,
      code: maskJava(source, false),
      literal: source,
      lexicalBindings: (context.method.lexicalBindings ?? [])
        .filter(({ start }) => start === 0)
        .map((binding) => ({ ...binding, end: source.length })),
    }
    : null;
  const types = context.runtime && method
    ? new Map(
      methodVariableTypeReferences(
        context.runtime,
        method,
        sourcePosition,
      ),
    )
    : new Map();
  const values = new Map();
  const structural = maskJava(source, false);
  const events = [
    ...javaVariableDeclarations(source).map((declaration) => ({
      ...declaration,
      kind: "declaration",
    })),
    ...simpleAssignmentExpressions(source).map((assignment) => ({
      ...assignment,
      kind: "assignment",
    })),
    ...Array.from(
      structural.matchAll(
        /\b([A-Za-z_$][\w$]*)\s*(?:>>>=|<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=)|(?:\b([A-Za-z_$][\w$]*)\s*(?:\+\+|--)|(?:\+\+|--)\s*\b([A-Za-z_$][\w$]*))/g,
      ),
      (match) => ({
        kind: "mutation",
        name: match[1] ?? match[2] ?? match[3],
        position: match.index,
      }),
    ),
  ].sort((left, right) =>
    left.position - right.position ||
    (left.kind === "declaration" ? -1 : 1)
  );
  for (const event of events) {
    if (event.kind === "declaration") {
      types.set(event.name, event.typeReference ?? event.type);
      if (event.initialized) {
        values.set(event.name, {
          expression: event.expression,
          sourcePosition: event.expressionPosition ?? event.position,
        });
      }
      else values.delete(event.name);
    } else if (event.kind === "assignment") {
      values.set(event.name, {
        expression: event.expression,
        sourcePosition: event.expressionPosition ?? event.position,
      });
    } else {
      values.delete(event.name);
    }
  }
  return {
    types,
    values,
    runtime: context.runtime ?? null,
    method,
    returnType: context.returnType ?? null,
    sourcePosition,
  };
}

function javaFactTypes(facts) {
  return facts instanceof Map ? facts : facts?.types ?? new Map();
}

function javaFactValues(facts) {
  return facts instanceof Map ? new Map() : facts?.values ?? new Map();
}

function javaExpressionStaticType(expression, facts = new Map()) {
  const value = unwrapParentheses(expression);
  if (value === "null") return "null";
  if (["true", "false", "Boolean.TRUE", "Boolean.FALSE"].includes(value)) {
    return value.startsWith("Boolean.") ? "Boolean" : "boolean";
  }
  if (/^"(?:\\.|[^"\\])*"$|^"""[\s\S]*"""$/.test(value)) {
    return "String";
  }
  if (/^'(?:\\.|[^'\\])'$/.test(value)) return "char";
  if (/^[+-]?\d+[lL]$/.test(value)) return "long";
  if (/^[+-]?\d+$/.test(value)) return "int";
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?[fF]$/.test(value)) {
    return "float";
  }
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?[dD]?$/.test(value)) {
    return "double";
  }
  const cast = javaLeadingCast(value);
  if (cast) return normalizeJavaTypeReference(cast.type);
  const constructor =
    /^new\s+((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*(?:\s*<[^()]*>)?(?:\s*\[\s*\])*)/.exec(
      value,
    );
  if (constructor) return normalizeJavaTypeReference(constructor[1]);
  const staticMember = javaStaticMemberValueType(
    value,
    facts instanceof Map ? null : facts?.runtime ?? null,
    facts instanceof Map ? null : facts?.method ?? null,
    facts,
  );
  if (staticMember) return staticMember;
  const reference = /^([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  return reference ? javaFactTypes(facts).get(reference) ?? null : null;
}

function javaExpressionKnownValue(expression, facts, seen = new Set()) {
  const value = unwrapParentheses(expression);
  const sourcePosition = facts instanceof Map
    ? null
    : facts?.sourcePosition ?? null;
  if (
    value === "null" ||
    value === "true" ||
    value === "false" ||
    /^Boolean\.(?:TRUE|FALSE)$/.test(value) ||
    /^[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[fFdDlL]?$/.test(value) ||
    /^'(?:\\.|[^'\\])'$/.test(value) ||
    /^"(?:\\.|[^"\\])*"$|^"""[\s\S]*"""$/.test(value) ||
    /^\s*new\s+[A-Za-z_$]/.test(value)
  ) {
    return { value, sourcePosition };
  }
  const reference = /^([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (!reference || seen.has(reference)) return { value, sourcePosition };
  const known = javaFactValues(facts).get(reference);
  if (known === undefined) return null;
  seen.add(reference);
  const knownExpression = typeof known === "string"
    ? known
    : known.expression;
  const knownPosition = typeof known === "string"
    ? sourcePosition
    : known.sourcePosition;
  return javaExpressionKnownValue(
    knownExpression,
    facts instanceof Map
      ? facts
      : { ...facts, sourcePosition: knownPosition },
    seen,
  );
}

function javaExpressionNullability(expression, facts) {
  const known = javaExpressionKnownValue(expression, facts);
  if (known === null) return "unknown";
  const unwrapped = unwrapParentheses(known.value);
  if (unwrapped === "null") return "null";
  const cast = javaLeadingCast(unwrapped);
  if (cast) {
    return javaPrimitiveTypes.has(normalizeJavaType(cast.type))
      ? "nonnull"
      : javaExpressionNullability(cast.operand, facts);
  }
  if (
    /^(?:true|false|Boolean\.(?:TRUE|FALSE)|[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[fFdDlL]?|'(?:\\.|[^'\\])'|"(?:\\.|[^"\\])*"|"""[\s\S]*""")$/.test(
      unwrapped,
    ) ||
    /^\s*new\s+[A-Za-z_$]/.test(unwrapped) ||
    /^(?:Boolean|Byte|Short|Integer|Long|Float|Double|Character)\s*\.\s*valueOf\s*\(/.test(
      unwrapped,
    )
  ) {
    return "nonnull";
  }
  return "unknown";
}

function javaExpressionRuntimeType(expression, facts) {
  const known = javaExpressionKnownValue(expression, facts);
  if (known === null) return null;
  const knownFacts = facts instanceof Map
    ? facts
    : { ...facts, sourcePosition: known.sourcePosition };
  const knownType = javaExpressionStaticType(known.value, knownFacts);
  if (knownType === "null") return "null";
  const reference = /^([A-Za-z_$][\w$]*)$/.exec(
    unwrapParentheses(expression),
  )?.[1];
  const declared = reference
    ? javaFactTypes(facts).get(reference) ?? null
    : null;
  const simpleKnownType = normalizeJavaType(knownType);
  const simpleDeclared = normalizeJavaType(declared);
  if (knownType && javaPrimitiveTypes.has(simpleKnownType)) {
    return declared && !javaPrimitiveTypes.has(simpleDeclared)
      ? javaPrimitiveWrappers.get(simpleKnownType) ?? knownType
      : knownType;
  }
  if (knownType) return knownType;
  return null;
}

function javaKnownReferenceAssignable(sourceType, targetType, runtime = null) {
  const sourceReference = normalizeJavaTypeReference(sourceType);
  const targetReference = normalizeJavaTypeReference(targetType);
  const source = normalizeJavaType(sourceReference);
  const target = normalizeJavaType(targetReference);
  if (!source || !target) return false;
  if (!runtime && (source === target || target === "Object")) return true;
  if (source.endsWith("[]")) {
    return ["Object", "Cloneable", "Serializable"].includes(target);
  }
  if (runtime) {
    return (
      referenceTypeDistance(runtime, sourceReference, targetReference) <
      Infinity
    );
  }
  return knownJavaSupertypes.get(source)?.has(target) ?? false;
}

function javaUnboxingBehavior(expression, facts = new Map()) {
  const type = javaExpressionStaticType(expression, facts);
  const simpleType = normalizeJavaType(type);
  if (type && javaPrimitiveTypes.has(simpleType)) return "never";
  const nullability = javaExpressionNullability(expression, facts);
  if (nullability === "null") return "always";
  if (type && javaBoxedPrimitiveTypes.has(simpleType)) {
    return nullability === "nonnull" ? "never" : "maybe";
  }
  return type === null ? "maybe" : "never";
}

function javaCastBehavior(type, operand, facts = new Map()) {
  const target = normalizeJavaTypeReference(type);
  const simpleTarget = normalizeJavaType(target);
  const source = javaExpressionStaticType(operand, facts);
  const simpleSource = normalizeJavaType(source);
  const runtime = facts instanceof Map ? null : facts?.runtime ?? null;
  if (javaPrimitiveTypes.has(simpleTarget)) {
    if (source && javaPrimitiveTypes.has(simpleSource)) return "never";
    return javaUnboxingBehavior(operand, facts);
  }
  if (
    source === "null" ||
    javaExpressionNullability(operand, facts) === "null"
  ) {
    return "never";
  }
  if (source && javaPrimitiveTypes.has(simpleSource)) {
    const wrapper = javaPrimitiveWrappers.get(simpleSource);
    return javaKnownReferenceAssignable(wrapper, target, runtime)
      ? "never"
      : "always";
  }
  if (source && javaKnownReferenceAssignable(source, target, runtime)) {
    return "never";
  }
  const runtimeType = javaExpressionRuntimeType(operand, facts);
  if (runtimeType) {
    return javaKnownReferenceAssignable(runtimeType, target, runtime)
      ? "never"
      : "always";
  }
  return "maybe";
}

function javaCastMayThrow(type, operand, facts = new Map()) {
  return javaCastBehavior(type, operand, facts) !== "never";
}

function javaOperandMayNeedUnboxing(expression, facts = new Map()) {
  return javaUnboxingBehavior(expression, facts) !== "never";
}

function javaConditionMayNeedUnboxing(expression, facts = new Map()) {
  const value = unwrapParentheses(expression);
  if (
    staticJavaBoolean(value) !== null ||
    /\binstanceof\b/.test(maskJava(value, false))
  ) {
    return false;
  }
  const type = normalizeJavaType(javaExpressionStaticType(value, facts));
  if (type === "boolean") return false;
  if (type === "Boolean") return true;
  return /^(?:[A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(
    maskJava(value, false).trim(),
  );
}

function javaComparisonUnboxing(
  comparison,
  facts = new Map(),
) {
  if (["<", "<=", ">", ">="].includes(comparison.operator)) {
    return [
      javaOperandMayNeedUnboxing(comparison.left, facts),
      javaOperandMayNeedUnboxing(comparison.right, facts),
    ];
  }
  const leftType = normalizeJavaType(
    javaExpressionStaticType(comparison.left, facts),
  );
  const rightType = normalizeJavaType(
    javaExpressionStaticType(comparison.right, facts),
  );
  if (leftType === "null" || rightType === "null") return [false, false];
  return [
    Boolean(rightType && javaPrimitiveTypes.has(rightType)) &&
      javaOperandMayNeedUnboxing(comparison.left, facts),
    Boolean(leftType && javaPrimitiveTypes.has(leftType)) &&
      javaOperandMayNeedUnboxing(comparison.right, facts),
  ];
}

function topLevelBinaryOperation(expression) {
  const code = maskJava(expression, false);
  const groups = [
    ["|"],
    ["^"],
    ["&"],
    [">>>", "<<", ">>"],
    ["+", "-"],
    ["*", "/", "%"],
  ];
  for (const operators of groups) {
    const depth = { "(": 0, "[": 0, "{": 0 };
    const closing = { ")": "(", "]": "[", "}": "{" };
    let found = null;
    for (let index = 0; index < code.length; index += 1) {
      const character = code[index];
      if (character in depth) {
        depth[character] += 1;
        continue;
      }
      if (character in closing) {
        depth[closing[character]] -= 1;
        continue;
      }
      if (!Object.values(depth).every((value) => value === 0)) continue;
      const operator = operators.find((candidate) =>
        code.startsWith(candidate, index)
      );
      if (!operator) continue;
      if (
        ["|", "&"].includes(operator) &&
        code[index + 1] === operator
      ) {
        index += 1;
        continue;
      }
      if (
        ["+", "-"].includes(operator) &&
        (
          code[index + 1] === operator ||
          code[index - 1] === operator ||
          /(?:^|[([{?:,=+\-*/%&|^!~<>])\s*$/.test(code.slice(0, index))
        )
      ) {
        continue;
      }
      if (
        ["*", "/", "%", "&", "|", "^"].includes(operator) &&
        code[index + operator.length] === "="
      ) {
        continue;
      }
      found = {
        left: expression.slice(0, index),
        operator,
        right: expression.slice(index + operator.length),
      };
      index += operator.length - 1;
    }
    if (found) return found;
  }
  return null;
}

function javaExpressionMayThrow(expression, facts = new Map()) {
  const code = maskJava(expression, false);
  if (/\bnew\s+[A-Za-z_$]/.test(code)) return true;
  if (/(?:^|[^\w$])(?:[A-Za-z_$][\w$]*\s*\.)*[A-Za-z_$][\w$]*\s*\(/.test(
    code,
  )) {
    return true;
  }
  const cast = javaLeadingCast(expression);
  return (
    Boolean(cast && javaCastMayThrow(cast.type, cast.operand, facts)) ||
    /\[[^\]]*\]|(?<![/*])[/%](?![/*=])/.test(code)
  );
}

function appendJavaEvaluationPrefix(prefix, effect) {
  if (!effect.trim()) return prefix;
  return `${prefix}${prefix.trim() ? "\n" : ""}${effect}`;
}

function javaExpressionEvaluationPaths(
  expression,
  condition = false,
  limit = 64,
  facts = new Map(),
  context = {},
  expectedType = null,
) {
  const analysisMethod = facts instanceof Map
    ? context.method
    : facts.method ?? context.method;
  const positionedCall = (call) => {
    const base = facts instanceof Map ? null : facts?.sourcePosition;
    if (base === null || base === undefined) return call;
    return {
      ...call,
      position: base + call.position,
      argumentPositions: call.argumentPositions?.map(
        (position) => base + position,
      ),
    };
  };
  const uniquePrefixes = (prefixes) =>
    [...new Set(prefixes)].slice(0, limit);
  const uniqueConditions = (paths) => {
    const unique = new Map();
    for (const path of paths) {
      const key = `${path.truth}\u0000${path.prefix}`;
      if (!unique.has(key)) unique.set(key, path);
    }
    return [...unique.values()].slice(0, limit);
  };
  const combinePrefix = (left, right) =>
    appendJavaEvaluationPrefix(left, right);
  const withConversion = (evaluated, behavior) => ({
    completions: behavior === "always" ? [] : evaluated.completions,
    throws: uniquePrefixes([
      ...evaluated.throws,
      ...(
        behavior === "never"
          ? []
          : evaluated.completions
      ),
    ]),
  });
  const withExpectedConversion = (
    evaluated,
    source,
    targetType,
    resultType = javaExpressionStaticType(source, facts),
  ) => {
    const normalizedTarget = normalizeJavaType(targetType);
    if (
      !javaPrimitiveTypes.has(normalizedTarget) ||
      javaPrimitiveTypes.has(normalizeJavaType(resultType))
    ) {
      return evaluated;
    }
    return withConversion(
      evaluated,
      javaUnboxingBehavior(source, facts),
    );
  };
  const sequence = (expressions) => {
    let completions = [""];
    let throws = [];
    for (const item of expressions) {
      const source = typeof item === "string" ? item : item.expression;
      if (!source?.trim()) continue;
      const evaluated = analyzeValue(
        source,
        typeof item === "string" ? null : item.expectedType,
      );
      throws = uniquePrefixes([
        ...throws,
        ...completions.flatMap((prefix) =>
          evaluated.throws.map((thrown) => combinePrefix(prefix, thrown))
        ),
      ]);
      completions = uniquePrefixes(
        completions.flatMap((prefix) =>
          evaluated.completions.map((completed) =>
            combinePrefix(prefix, completed)
          )
        ),
      );
    }
    return { completions, throws };
  };
  const invocation = (expressions) => {
    const evaluated = sequence(expressions);
    return {
      completions: evaluated.completions,
      throws: uniquePrefixes([
        ...evaluated.throws,
        ...evaluated.completions,
      ]),
    };
  };
  const invocationTypes = (call) => {
    if (!context.runtime || !analysisMethod || !call) return [];
    const targets = methodCallTargets(
      context.runtime,
      analysisMethod,
      positionedCall(call),
    );
    if (targets.length === 0) return [];
    const parameterLists = targets.map((target) =>
      effectiveParameterTypes(target, call.arguments.length)
    );
    return call.arguments.map((_, index) => {
      const candidates = new Set(
        parameterLists
          .map((parameters) => normalizeJavaType(parameters[index]))
          .filter(Boolean),
      );
      return candidates.size === 1 ? [...candidates][0] : null;
    });
  };
  const completionTruths = (value) => {
    const truth = staticJavaBoolean(value);
    return truth === null ? [true, false] : [truth];
  };
  const outerAssignments = (value) =>
    simpleAssignmentExpressions(value)
      .filter(
        (candidate, index, candidates) =>
          !candidates.some(
            (owner, ownerIndex) =>
              ownerIndex !== index &&
              owner.position <= candidate.position &&
              candidate.end <= owner.end &&
              (
                owner.position < candidate.position ||
                candidate.end < owner.end
              ),
          ),
      )
      .sort((left, right) => left.position - right.position);

  const analyzeValue = (source, targetType = expectedType) => {
    const value = unwrapParentheses(source);
    if (!value) return { completions: [""], throws: [] };

    const assignment = topLevelAssignmentExpression(value);
    if (assignment) {
      const assignmentType =
        javaFactTypes(facts).get(assignment.name) ?? null;
      const evaluated = analyzeValue(
        assignment.expression,
        assignmentType,
      );
      return {
        completions: uniquePrefixes(
          evaluated.completions.map((prefix) =>
            appendJavaEvaluationPrefix(
              prefix,
              `${assignment.name} = ${assignment.expression};`,
            )
          ),
        ),
        throws: evaluated.throws,
      };
    }

    const conditionalExpression = splitTopLevelConditional(value);
    if (conditionalExpression) {
      const evaluatedCondition = analyzeCondition(
        conditionalExpression.condition,
      );
      const completions = [];
      const throws = [...evaluatedCondition.throws];
      for (const path of evaluatedCondition.completions) {
        const branch = path.truth
          ? conditionalExpression.consequent
          : conditionalExpression.alternate;
        const evaluatedBranch = analyzeValue(branch, targetType);
        throws.push(
          ...evaluatedBranch.throws.map((thrown) =>
            combinePrefix(path.prefix, thrown)
          ),
        );
        completions.push(
          ...evaluatedBranch.completions.map((completed) =>
            combinePrefix(path.prefix, completed)
          ),
        );
      }
      return {
        completions: uniquePrefixes(completions),
        throws: uniquePrefixes(throws),
      };
    }

    for (const operator of ["||", "&&"]) {
      if (splitTopLevelBoolean(value, operator)) {
        const evaluated = analyzeCondition(value);
        return {
          completions: uniquePrefixes(
            evaluated.completions.map(({ prefix }) => prefix),
          ),
          throws: evaluated.throws,
        };
      }
    }

    if (value.startsWith("!") && !value.startsWith("!=")) {
      const operand = value.slice(1);
      return withConversion(
        analyzeValue(operand, null),
        javaUnboxingBehavior(operand, facts),
      );
    }

    const comparison = topLevelComparison(value);
    if (comparison) {
      const conversions = javaComparisonUnboxing(comparison, facts);
      const left = analyzeValue(comparison.left, null);
      const convertedLeft = conversions[0]
        ? withConversion(
          left,
          javaUnboxingBehavior(comparison.left, facts),
        )
        : left;
      const throws = [...convertedLeft.throws];
      const right = analyzeValue(comparison.right, null);
      const convertedRight = conversions[1]
        ? withConversion(
          right,
          javaUnboxingBehavior(comparison.right, facts),
        )
        : right;
      const completions = convertedLeft.completions.flatMap((leftPrefix) =>
        convertedRight.completions.map((rightPrefix) =>
          combinePrefix(leftPrefix, rightPrefix)
        )
      );
      throws.push(
        ...convertedLeft.completions.flatMap((leftPrefix) =>
          convertedRight.throws.map((rightPrefix) =>
            combinePrefix(leftPrefix, rightPrefix)
          )
        ),
      );
      return {
        completions: uniquePrefixes(completions),
        throws: uniquePrefixes(throws),
      };
    }

    const cast = javaLeadingCast(value);
    if (cast) {
      return withExpectedConversion(
        withConversion(
          analyzeValue(cast.operand, null),
          javaCastBehavior(cast.type, cast.operand, facts),
        ),
        value,
        targetType,
        cast.type,
      );
    }

    if (
      /^[+\-~]/.test(value) &&
      !/^[+\-]?\d/.test(value)
    ) {
      const operand = value.slice(1).trim();
      return withExpectedConversion(
        withConversion(
          analyzeValue(operand, null),
          javaUnboxingBehavior(operand, facts),
        ),
        value,
        targetType,
        "int",
      );
    }

    const binary = topLevelBinaryOperation(value);
    if (binary) {
      const left = analyzeValue(binary.left, null);
      const leftType = javaExpressionStaticType(binary.left, facts);
      const rightType = javaExpressionStaticType(binary.right, facts);
      const stringConcatenation =
        binary.operator === "+" &&
        (leftType === "String" || rightType === "String");
      const convertedLeft = stringConcatenation
        ? left
        : withConversion(
          left,
          javaUnboxingBehavior(binary.left, facts),
        );
      const right = analyzeValue(binary.right, null);
      const convertedRight = stringConcatenation
        ? right
        : withConversion(
          right,
          javaUnboxingBehavior(binary.right, facts),
        );
      const completions = convertedLeft.completions.flatMap((leftPrefix) =>
        convertedRight.completions.map((rightPrefix) =>
          combinePrefix(leftPrefix, rightPrefix)
        )
      );
      const throws = [
        ...convertedLeft.throws,
        ...convertedLeft.completions.flatMap((leftPrefix) =>
          convertedRight.throws.map((rightPrefix) =>
            combinePrefix(leftPrefix, rightPrefix)
          )
        ),
      ];
      if (["/", "%"].includes(binary.operator)) {
        throws.push(...completions);
      }
      return withExpectedConversion(
        {
          completions: uniquePrefixes(completions),
          throws: uniquePrefixes(throws),
        },
        value,
        targetType,
        stringConcatenation ? "String" : "int",
      );
    }

    const calls = topLevelMethodCalls(value);
    const call = calls.at(-1);
    if (call && !value.slice(call.close + 1).trim()) {
      const receiver = callReceiverExpression(value, call);
      const parameterTypes = invocationTypes(call);
      const evaluated = invocation([
        receiver && receiver !== value ? receiver : "",
        ...call.arguments.map((argument, index) => ({
          expression: argument,
          expectedType: parameterTypes[index] ?? null,
        })),
      ]);
      const returnTypes = context.runtime && analysisMethod
        ? new Set(
          methodCallTargets(
            context.runtime,
            analysisMethod,
            positionedCall(call),
          )
            .map((target) => normalizeJavaType(target.returnType)),
        )
        : new Set();
      const resultType = returnTypes.size === 1 ? [...returnTypes][0] : null;
      return withExpectedConversion(
        evaluated,
        value,
        targetType,
        resultType,
      );
    }

    const structural = maskJava(value, false);
    const constructor =
      /^\s*new\s+([A-Za-z_$][\w$]*(?:\s*<[^>]*>)?)\s*\(/.exec(
        structural,
      );
    if (constructor) {
      const open = structural.indexOf("(", constructor.index);
      const close = matchingIndex(structural, open);
      if (close >= 0 && !structural.slice(close + 1).trim()) {
        return withExpectedConversion(
          invocation(
            splitTopLevel(value.slice(open + 1, close)),
          ),
          value,
          targetType,
          normalizeJavaType(constructor[1]),
        );
      }
    }

    let completed = "";
    for (const nested of outerAssignments(value)) {
      completed = appendJavaEvaluationPrefix(
        completed,
        `${nested.name} = ${nested.expression};`,
      );
    }
    return withExpectedConversion(
      {
        completions: [completed],
        throws: javaExpressionMayThrow(value, facts) ? [completed] : [],
      },
      value,
      targetType,
    );
  };

  const analyzeCondition = (source) => {
    const value = unwrapParentheses(source);
    if (!value) return { completions: [], throws: [] };

    const conditionalExpression = splitTopLevelConditional(value);
    if (conditionalExpression) {
      const evaluatedCondition = analyzeCondition(
        conditionalExpression.condition,
      );
      const completions = [];
      const throws = [...evaluatedCondition.throws];
      for (const path of evaluatedCondition.completions) {
        const branch = path.truth
          ? conditionalExpression.consequent
          : conditionalExpression.alternate;
        const evaluatedBranch = analyzeCondition(branch);
        throws.push(
          ...evaluatedBranch.throws.map((thrown) =>
            combinePrefix(path.prefix, thrown)
          ),
        );
        completions.push(
          ...evaluatedBranch.completions.map((completed) => ({
            prefix: combinePrefix(path.prefix, completed.prefix),
            truth: completed.truth,
          })),
        );
      }
      return {
        completions: uniqueConditions(completions),
        throws: uniquePrefixes(throws),
      };
    }

    for (const operator of ["||", "&&"]) {
      const parts = splitTopLevelBoolean(value, operator);
      if (!parts) continue;
      let active = [""];
      const completions = [];
      let throws = [];
      for (let index = 0; index < parts.length; index += 1) {
        const evaluatedPart = analyzeCondition(parts[index]);
        const next = [];
        for (const prefix of active) {
          throws.push(
            ...evaluatedPart.throws.map((thrown) =>
              combinePrefix(prefix, thrown)
            ),
          );
          for (const path of evaluatedPart.completions) {
            const combined = combinePrefix(prefix, path.prefix);
            const shortCircuits =
              operator === "||" && path.truth ||
              operator === "&&" && !path.truth;
            if (shortCircuits || index === parts.length - 1) {
              completions.push({ prefix: combined, truth: path.truth });
            } else {
              next.push(combined);
            }
          }
        }
        active = uniquePrefixes(next);
        if (active.length === 0) break;
      }
      return {
        completions: uniqueConditions(completions),
        throws: uniquePrefixes(throws),
      };
    }

    if (value.startsWith("!") && !value.startsWith("!=")) {
      const evaluated = analyzeCondition(value.slice(1));
      return {
        completions: uniqueConditions(
          evaluated.completions.map((path) => ({
            prefix: path.prefix,
            truth: !path.truth,
          })),
        ),
        throws: evaluated.throws,
      };
    }

    const evaluated = analyzeValue(value, null);
    const converted = javaConditionMayNeedUnboxing(value, facts)
      ? withConversion(
        evaluated,
        javaUnboxingBehavior(value, facts),
      )
      : evaluated;
    return {
      completions: uniqueConditions(
        converted.completions.flatMap((prefix) =>
          completionTruths(value).map((truth) => ({ prefix, truth }))
        ),
      ),
      throws: converted.throws,
    };
  };

  return condition ? analyzeCondition(expression) : analyzeValue(expression);
}

function javaExpressionSequenceEvaluationPaths(
  expressions,
  limit = 64,
  facts = new Map(),
  context = {},
) {
  let completions = [""];
  let throws = [];
  for (const expression of expressions) {
    const source = typeof expression === "string"
      ? expression
      : expression.expression;
    if (!source?.trim()) continue;
    const evaluated = javaExpressionEvaluationPaths(
      source,
      false,
      limit,
      facts,
      context,
      typeof expression === "string" ? null : expression.expectedType,
    );
    throws = [
      ...new Set([
        ...throws,
        ...completions.flatMap((prefix) =>
          evaluated.throws.map((thrown) =>
            appendJavaEvaluationPrefix(prefix, thrown)
          )
        ),
      ]),
    ].slice(0, limit);
    completions = [
      ...new Set(
        completions.flatMap((prefix) =>
          evaluated.completions.map((completed) =>
            appendJavaEvaluationPrefix(prefix, completed)
          )
        ),
      ),
    ].slice(0, limit);
  }
  return { completions, throws };
}

function javaConditionEvaluationPaths(
  expression,
  limit = 64,
  facts = new Map(),
  context = {},
) {
  return javaExpressionEvaluationPaths(
    expression,
    true,
    limit,
    facts,
    context,
  );
}

function javaCatchPrefixes(body, prior = "", context = {}) {
  const limit = 64;
  const prefixes = [];
  const append = (prefix, statement) =>
    `${prefix}${prefix.trim() ? "\n" : ""}${statement}`;
  const addPrefix = (prefix, collector = prefixes) => {
    if (!collector.includes(prefix) && collector.length < limit) {
      collector.push(prefix);
    }
  };
  const prefixStateKey = (prefix) => {
    const assignments = [
      ...javaVariableDeclarations(prefix)
        .filter(({ initialized }) => initialized)
        .map(({ position, name, expression }) => ({
          position,
          name,
          expression,
        })),
      ...simpleAssignmentExpressions(prefix),
    ].sort((left, right) => left.position - right.position);
    const states = new Map();
    for (const assignment of assignments) {
      states.set(
        assignment.name,
        assignment.expression.replace(/\s+/g, " ").trim(),
      );
    }
    const structural = maskJava(prefix, false);
    for (const match of structural.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*(?:>>>=|<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=)|(?:\b([A-Za-z_$][\w$]*)\s*(?:\+\+|--)|(?:\+\+|--)\s*\b([A-Za-z_$][\w$]*))/g,
    )) {
      states.set(match[1] ?? match[2] ?? match[3], "<mutated>");
    }
    return JSON.stringify(
      [...states].sort(([left], [right]) => left.localeCompare(right)),
    );
  };
  const uniquePaths = (paths) => {
    const unique = new Map();
    for (const path of paths) {
      const key = `${
        path.control ?? "normal"
      }\u0000${path.label ?? ""}\u0000${prefixStateKey(path.prefix)}`;
      if (!unique.has(key)) unique.set(key, path);
      if (unique.size >= limit) break;
    }
    return [...unique.values()];
  };
  const expressionFacts = (prefix) =>
    javaExpressionTypeFacts(append(prior, prefix), context);
  const addEvaluationThrows = (
    basePrefix,
    evaluated,
    collector,
  ) => {
    for (const thrown of evaluated.throws) {
      addPrefix(append(basePrefix, thrown), collector);
    }
  };
  const evaluateSequence = (
    expressions,
    initialPrefixes,
    collector,
  ) => {
    let completions = [...initialPrefixes];
    for (const expression of expressions) {
      const source = typeof expression === "string"
        ? expression
        : expression.expression;
      if (!source?.trim()) continue;
      const next = [];
      for (const prefix of completions) {
        const evaluated = javaExpressionEvaluationPaths(
          source,
          false,
          limit,
          expressionFacts(prefix),
          context,
          typeof expression === "string" ? null : expression.expectedType,
        );
        addEvaluationThrows(prefix, evaluated, collector);
        for (const completed of evaluated.completions) {
          next.push(append(prefix, completed));
        }
      }
      completions = [
        ...new Map(
          next.map((prefix) => [prefixStateKey(prefix), prefix]),
        ).values(),
      ].slice(0, limit);
      if (completions.length === 0) break;
    }
    return completions;
  };
  const simpleStatementExpressions = (statement) => {
    const declarations = javaVariableDeclarations(statement)
      .filter(({ initialized }) => initialized)
      .map(({ expression, type }) => ({
        expression,
        expectedType: type,
      }));
    if (declarations.length > 0) return declarations;
    const value = statement.trim().replace(/;\s*$/, "").trim();
    if (startsWithWord(value, 0, "assert")) {
      return topLevelConditionParts(value.slice(6), ":").map(
        (expression, index) => ({
          expression,
          expectedType: index === 0 ? "boolean" : null,
        }),
      );
    }
    return value ? [value] : [];
  };
  const loopFlow = (
    flow,
    loopLabel,
    nextPrefixes,
    exits,
    escaped,
  ) => {
    if (
      !flow.control ||
      flow.control === "continue" &&
        (flow.label === null || flow.label === loopLabel)
    ) {
      nextPrefixes.push(flow.prefix);
      return;
    }
    if (
      flow.control === "break" &&
      (flow.label === null || flow.label === loopLabel)
    ) {
      exits.push({ prefix: flow.prefix, control: null, label: null });
      return;
    }
    escaped.push(flow);
  };

  const analyzeSequence = (
    source,
    initialPaths,
    context,
    collector,
  ) => {
    const code = maskJava(source, false);
    let cursor = 0;
    let paths = uniquePaths(initialPaths);
    while (cursor < code.length && paths.length > 0) {
      const start = skipWhitespace(code, cursor);
      if (start >= code.length) break;
      const end = javaStatementEnd(code, start);
      if (end < 0) break;
      const statement = source.slice(start, end);
      const next = [];
      for (const path of paths) {
        if (path.control) {
          next.push(path);
        } else {
          next.push(
            ...analyzeStatement(
              statement,
              path,
              context,
              collector,
              null,
            ),
          );
        }
      }
      paths = uniquePaths(next);
      cursor = end;
    }
    return paths;
  };

  const analyzeTry = (statement, nested, path, context, collector) => {
    const resourceExceptions = [];
    let entries = [path.prefix];
    if (nested.resources) {
      entries = evaluateSequence(
        topLevelConditionParts(
          statement.slice(nested.resources.start, nested.resources.end),
          ";",
        ),
        entries,
        resourceExceptions,
      );
    }

    const bodyExceptions = [];
    const bodyText = statementBody(
      statement,
      nested.body.start,
      nested.body.end,
    );
    const bodyFlows = entries.flatMap((prefix) =>
      analyzeSequence(
        bodyText,
        [{ prefix, control: null, label: null }],
        context,
        bodyExceptions,
      )
    );
    const protectedExceptions = [
      ...resourceExceptions,
      ...bodyExceptions,
    ];
    const escapingExceptions = [...protectedExceptions];
    const candidateFlows = [...bodyFlows];
    for (const exceptionPrefix of protectedExceptions) {
      for (const { start, end } of nested.catches) {
        const catchExceptions = [];
        candidateFlows.push(
          ...analyzeSequence(
            statementBody(statement, start, end),
            [{
              prefix: exceptionPrefix,
              control: null,
              label: null,
            }],
            context,
            catchExceptions,
          ),
        );
        escapingExceptions.push(...catchExceptions);
      }
    }

    const finalizer = nested.finalizer
      ? statementBody(
        statement,
        nested.finalizer.start,
        nested.finalizer.end,
      )
      : "";
    if (!finalizer) {
      for (const exceptionPrefix of escapingExceptions) {
        addPrefix(exceptionPrefix, collector);
      }
      return uniquePaths(candidateFlows);
    }

    const completedFlows = [];
    for (const flow of candidateFlows) {
      const finalizerExceptions = [];
      const finalizerFlows = analyzeSequence(
        finalizer,
        [{ prefix: flow.prefix, control: null, label: null }],
        context,
        finalizerExceptions,
      );
      for (const exceptionPrefix of finalizerExceptions) {
        addPrefix(exceptionPrefix, collector);
      }
      for (const finalizerFlow of finalizerFlows) {
        completedFlows.push(
          finalizerFlow.control
            ? finalizerFlow
            : {
              prefix: finalizerFlow.prefix,
              control: flow.control,
              label: flow.label,
            },
        );
      }
    }
    for (const exceptionPrefix of escapingExceptions) {
      const finalizerExceptions = [];
      const finalizerFlows = analyzeSequence(
        finalizer,
        [{
          prefix: exceptionPrefix,
          control: null,
          label: null,
        }],
        context,
        finalizerExceptions,
      );
      for (const finalizerException of finalizerExceptions) {
        addPrefix(finalizerException, collector);
      }
      for (const finalizerFlow of finalizerFlows) {
        if (finalizerFlow.control) {
          completedFlows.push(finalizerFlow);
        } else {
          addPrefix(finalizerFlow.prefix, collector);
        }
      }
    }
    return uniquePaths(completedFlows);
  };

  const analyzeLoop = (
    statement,
    path,
    context,
    collector,
    kind,
    loopLabel,
  ) => {
    const code = maskJava(statement, false);
    const first = skipWhitespace(code, 0);
    let bodyStart;
    let bodyEnd;
    let condition = "";
    let initialization = "";
    let update = "";
    let iterable = "";
    if (kind === "do") {
      bodyStart = skipWhitespace(code, first + 2);
      bodyEnd = javaStatementEnd(code, bodyStart);
      const whileWord = skipWhitespace(code, bodyEnd);
      const open = startsWithWord(code, whileWord, "while")
        ? code.indexOf("(", whileWord + 5)
        : -1;
      const close = matchingIndex(code, open);
      if (bodyEnd < 0 || open < 0 || close < 0) return [];
      condition = statement.slice(open + 1, close);
    } else {
      const open = code.indexOf("(", first + kind.length);
      const close = matchingIndex(code, open);
      if (open < 0 || close < 0) return [];
      bodyStart = skipWhitespace(code, close + 1);
      bodyEnd = javaStatementEnd(code, bodyStart);
      if (bodyEnd < 0) return [];
      if (kind === "while") {
        condition = statement.slice(open + 1, close);
      } else {
        const classic = classicForHeaderParts(statement, open, close);
        if (classic) {
          initialization = classic.initialization;
          condition = classic.condition;
          update = classic.update;
        } else {
          const header = statement.slice(open + 1, close);
          const parts = topLevelConditionParts(header, ":");
          iterable = parts.length === 2 ? parts[1] : header;
        }
      }
    }
    const bodyText = statement.slice(bodyStart, bodyEnd);
    const exits = [];
    const escaped = [];
    const seen = new Set();
    let work = [];

    const evaluateCondition = (entryPrefix, onTrue) => {
      if (!condition.trim()) {
        onTrue(entryPrefix);
        return;
      }
      const evaluated = javaConditionEvaluationPaths(
        condition,
        limit,
        expressionFacts(entryPrefix),
        context,
      );
      addEvaluationThrows(entryPrefix, evaluated, collector);
      for (const completed of evaluated.completions) {
        const completedPrefix = append(entryPrefix, completed.prefix);
        if (completed.truth) {
          onTrue(completedPrefix);
        } else {
          exits.push({
            prefix: completedPrefix,
            control: null,
            label: null,
          });
        }
      }
    };

    if (kind === "for" && initialization) {
      work = evaluateSequence(
        splitTopLevel(initialization),
        [path.prefix],
        collector,
      );
    } else if (kind === "for" && iterable) {
      const evaluated = javaExpressionEvaluationPaths(
        iterable,
        false,
        limit,
        expressionFacts(path.prefix),
        context,
      );
      addEvaluationThrows(path.prefix, evaluated, collector);
      work = evaluated.completions.map((completed) =>
        append(path.prefix, completed)
      );
      const cardinality = javaIterableCardinality(iterable);
      if (cardinality !== null && cardinality === 0) {
        exits.push(
          ...work.map((prefix) => ({
            prefix,
            control: null,
            label: null,
          })),
        );
        work = [];
      } else if (cardinality === null) {
        exits.push(
          ...work.map((prefix) => ({
            prefix,
            control: null,
            label: null,
          })),
        );
      }
    } else {
      work = [path.prefix];
    }

    let iterations = 0;
    while (work.length > 0 && iterations < limit * 2) {
      const entryPrefix = work.shift();
      const key = prefixStateKey(entryPrefix);
      if (seen.has(key)) continue;
      seen.add(key);
      iterations += 1;

      const bodyEntries = [];
      if (kind === "do" || kind === "for" && iterable) {
        bodyEntries.push(entryPrefix);
      } else {
        evaluateCondition(entryPrefix, (completedPrefix) => {
          bodyEntries.push(completedPrefix);
        });
      }

      for (const bodyEntry of bodyEntries) {
        const flows = analyzeStatement(
          bodyText,
          { prefix: bodyEntry, control: null, label: null },
          context,
          collector,
          null,
        );
        const next = [];
        for (const flow of flows) {
          loopFlow(flow, loopLabel, next, exits, escaped);
        }
        for (const nextPrefix of next) {
          if (kind === "for" && update.trim()) {
            const updated = evaluateSequence(
              splitTopLevel(update),
              [nextPrefix],
              collector,
            );
            work.push(...updated);
          } else if (kind === "do") {
            evaluateCondition(nextPrefix, (completedPrefix) => {
              work.push(completedPrefix);
            });
          } else {
            work.push(nextPrefix);
          }
          if (kind === "for" && iterable) {
            exits.push({
              prefix: nextPrefix,
              control: null,
              label: null,
            });
          }
        }
      }
    }
    for (const prefix of work) addPrefix(prefix, collector);
    return uniquePaths([...exits, ...escaped]);
  };

  const analyzeStatement = (
    statement,
    path,
    context,
    collector,
    statementLabel,
  ) => {
    const code = maskJava(statement, false);
    let first = skipWhitespace(code, 0);
    const labeled = /^([A-Za-z_$][\w$]*)\s*:/.exec(code.slice(first));
    if (labeled && !["case", "default"].includes(labeled[1])) {
      const nestedStart = skipWhitespace(code, first + labeled[0].length);
      const nestedEnd = javaStatementEnd(code, nestedStart);
      if (nestedEnd < 0) return [];
      return uniquePaths(
        analyzeStatement(
          statement.slice(nestedStart, nestedEnd),
          path,
          context,
          collector,
          labeled[1],
        ).map((flow) =>
          flow.control === "break" && flow.label === labeled[1]
            ? { prefix: flow.prefix, control: null, label: null }
            : flow
        ),
      );
    }
    if (code[first] === "{") {
      const end = matchingIndex(code, first, "{", "}");
      return end < 0
        ? []
        : analyzeSequence(
          statement.slice(first + 1, end),
          [path],
          context,
          collector,
        );
    }
    if (startsWithWord(code, first, "try")) {
      const nested = javaTryStatementAt(statement, first);
      if (!nested) {
        if (javaStatementMayThrow(statement)) {
          addPrefix(path.prefix, collector);
        }
        return [{
          prefix: append(path.prefix, statement),
          control: null,
          label: null,
        }];
      }
      return analyzeTry(statement, nested, path, context, collector);
    }
    if (startsWithWord(code, first, "if")) {
      const conditional = conditionalAt(code, first);
      if (!conditional) {
        if (javaStatementMayThrow(statement)) {
          addPrefix(path.prefix, collector);
        }
        return [{
          prefix: append(path.prefix, statement),
          control: null,
          label: null,
        }];
      }
      const condition = javaConditionEvaluationPaths(
        conditional.condition,
        limit,
        expressionFacts(path.prefix),
        context,
      );
      addEvaluationThrows(path.prefix, condition, collector);
      const flows = [];
      for (const completed of condition.completions) {
        const branchPrefix = append(path.prefix, completed.prefix);
        if (completed.truth) {
          flows.push(
            ...analyzeStatement(
              statement.slice(
                conditional.consequentStart,
                conditional.consequentEnd,
              ),
              { prefix: branchPrefix, control: null, label: null },
              context,
              collector,
              null,
            ),
          );
        } else if (conditional.alternateStart >= 0) {
          flows.push(
            ...analyzeStatement(
              statement.slice(
                conditional.alternateStart,
                conditional.alternateEnd,
              ),
              { prefix: branchPrefix, control: null, label: null },
              context,
              collector,
              null,
            ),
          );
        } else {
          flows.push({
            prefix: branchPrefix,
            control: null,
            label: null,
          });
        }
      }
      return uniquePaths(flows);
    }
    for (const kind of ["do", "while", "for"]) {
      if (startsWithWord(code, first, kind)) {
        return analyzeLoop(
          statement,
          path,
          context,
          collector,
          kind,
          statementLabel,
        );
      }
    }
    if (startsWithWord(code, first, "synchronized")) {
      const open = code.indexOf("(", first + 12);
      const close = matchingIndex(code, open);
      const bodyStart = skipWhitespace(code, close + 1);
      const bodyEnd = javaStatementEnd(code, bodyStart);
      if (open < 0 || close < 0 || bodyEnd < 0) return [];
      const evaluated = javaExpressionEvaluationPaths(
        statement.slice(open + 1, close),
        false,
        limit,
        expressionFacts(path.prefix),
        context,
      );
      addEvaluationThrows(path.prefix, evaluated, collector);
      return uniquePaths(
        evaluated.completions.flatMap((completed) =>
          analyzeStatement(
            statement.slice(bodyStart, bodyEnd),
            {
              prefix: append(path.prefix, completed),
              control: null,
              label: null,
            },
            context,
            collector,
            null,
          )
        ),
      );
    }
    const abrupt = /^(break|continue)(?:\s+([A-Za-z_$][\w$]*))?\s*;$/.exec(
      code.slice(first).trim(),
    );
    if (abrupt) {
      return [{
        prefix: path.prefix,
        control: abrupt[1],
        label: abrupt[2] ?? null,
      }];
    }
    for (const control of ["return", "throw"]) {
      if (!startsWithWord(code, first, control)) continue;
      const end = javaStatementEnd(code, first);
      const expression = statement
        .slice(first + control.length, Math.max(first + control.length, end - 1))
        .trim();
      const evaluated = expression
        ? javaExpressionEvaluationPaths(
          expression,
          false,
          limit,
          expressionFacts(path.prefix),
          context,
          control === "return" ? context.returnType ?? null : null,
        )
        : { completions: [""], throws: [] };
      addEvaluationThrows(path.prefix, evaluated, collector);
      if (control === "throw") {
        for (const completed of evaluated.completions) {
          addPrefix(append(path.prefix, completed), collector);
        }
        return [];
      }
      return evaluated.completions.map((completed) => ({
        prefix: append(path.prefix, completed),
        control,
        label: null,
      }));
    }

    const evaluated = javaExpressionSequenceEvaluationPaths(
      simpleStatementExpressions(statement),
      limit,
      expressionFacts(path.prefix),
      context,
    );
    addEvaluationThrows(path.prefix, evaluated, collector);
    if (javaStatementMayThrow(statement) && evaluated.throws.length === 0) {
      addPrefix(path.prefix, collector);
    }
    return evaluated.completions.map(() => ({
      prefix: append(path.prefix, statement),
      control: null,
      label: null,
    }));
  };

  analyzeSequence(
    body,
    [{ prefix: "", control: null, label: null }],
    context,
    prefixes,
  );
  return [...new Set(prefixes)].slice(0, limit);
}

function applyCallbackFinally(path, finalizer) {
  if (!finalizer.trim()) return path;
  const wrapped = `try {
${path}
} finally {
${finalizer}
}`;
  const expanded = expandAbruptFinalizers(wrapped);
  const statement = javaTryStatementAt(expanded, 0);
  if (!statement) return `${path}\n${finalizer}`;
  return `${
    statementBody(expanded, statement.body.start, statement.body.end)
  }\n${statementBody(
    expanded,
    statement.finalizer.start,
    statement.finalizer.end,
  )}`;
}

function completedTryVariants(source, limit = 64, context = {}) {
  const variants = [];
  const visit = (value) => {
    if (variants.length >= limit) return;
    const code = maskJava(value, false);
    const functions = functionalExecutionAnalysis(value).functions;
    const nestedMethods = parseMethods(code, value);
    let statement = null;
    for (const match of code.matchAll(/\btry\b/g)) {
      if (
        parsedMethodOwnerAt(nestedMethods, match.index) ||
        functions.some(
          ({ start, end }) => start <= match.index && match.index < end,
        )
      ) {
        continue;
      }
      statement = javaTryStatementAt(value, match.index);
      if (statement) break;
    }
    if (!statement) {
      variants.push(value);
      return;
    }
    const before = value.slice(0, statement.start);
    const after = value.slice(statement.end);
    const finalizer = statement.finalizer
      ? statementBody(
        value,
        statement.finalizer.start,
        statement.finalizer.end,
      )
      : "";
    const body = statementBody(
      value,
      statement.body.start,
      statement.body.end,
    );
    const catchPrefixes = javaCatchPrefixes(body, before, context);
    const paths = [
      body,
      ...catchPrefixes.flatMap((prefix) =>
        statement.catches.map(({ start, end }) =>
          `${prefix}\n${statementBody(value, start, end)}`
        )
      ),
    ];
    for (const path of paths) {
      visit(`${before}${applyCallbackFinally(path, finalizer)}${after}`);
      if (variants.length >= limit) break;
    }
  };
  visit(source);
  return [...new Set(variants)].slice(0, limit);
}

function publisherCallbackReturnDetails(source, context = {}) {
  const variants = completedConditionalVariants(
    source,
    source.length,
    128,
    true,
  )
    .flatMap((literal) => completedSwitchVariants(literal, 128))
    .flatMap((literal) => completedTryVariants(literal, 128, context))
    .flatMap((literal) =>
      completedConditionalVariants(literal, literal.length, 128)
    )
    .flatMap((literal) => completedSwitchVariants(literal, 128))
    .slice(0, 128);
  const reachable = [];
  for (const literal of variants) {
    const code = maskJava(literal, false);
    const functions = functionalExecutionAnalysis(literal).functions;
    const nestedMethods = parseMethods(code, literal);
    for (const match of code.matchAll(/\b(return|throw)\b/g)) {
      if (
        parsedMethodOwnerAt(nestedMethods, match.index) ||
        functions.some(
          ({ start, end }) => start <= match.index && match.index < end,
        )
      ) {
        continue;
      }
      const end = javaStatementEnd(code, match.index);
      if (end < 0) continue;
      const reachability = assignmentControl({ literal }, match.index);
      if (!reachability.reachable) continue;
      if (match[1] === "return") {
        reachable.push({
          literal,
          position: match.index,
          variantPosition: match.index,
          variantExpression: literal
            .slice(match.index + match[1].length, end - 1)
            .trim(),
        });
      }
      if (!reachability.conditional) break;
    }
  }
  return reachable;
}

function publisherCallbackReturnFlows(
  runtime,
  ownerMethod,
  callback,
  initialEnvironment,
  assignmentValue,
  mergeConditional,
) {
  if (!callback.block) {
    return callback.returns.map((expression) => ({
      expression,
      environment: new Map(initialEnvironment),
      method: callback.method ?? ownerMethod,
      position: 0,
    }));
  }
  return callback.returnDetails.map((returned) => {
    const method = {
      ...ownerMethod,
      id: `${ownerMethod.id}:callback-return@${returned.position}`,
      code: maskJava(returned.literal, false),
      literal: returned.literal,
      lexicalBindings: callbackLexicalBindings(
        callback.parameters,
        returned.literal.length,
      ),
    };
    const environment = new Map(initialEnvironment);
    for (const assignment of flowAssignmentEvents(
      method,
      returned.variantPosition,
    )) {
      const assigned = assignmentValue(
        method,
        assignment,
        environment,
      );
      environment.set(
        assignment.name,
        assignment.conditional
          ? mergeConditional(
            environment.get(assignment.name),
            assigned,
          )
          : assigned,
      );
    }
    return {
      expression: returned.variantExpression,
      environment,
      method,
      position: returned.variantPosition,
    };
  });
}

function publisherCallbackExpressions(
  runtime,
  method,
  expression,
  environment,
) {
  let value = unwrapParentheses(expression);
  while (/^\(\s*[A-Za-z_$][\w$.<>,? ]*\s*\)\s*/.test(value)) {
    value = value.replace(
      /^\(\s*[A-Za-z_$][\w$.<>,? ]*\s*\)\s*/,
      "",
    ).trim();
  }
  const assignment = topLevelAssignmentExpression(value);
  if (assignment) {
    const assigned = publisherCallbackExpressions(
      runtime,
      method,
      assignment.expression,
      environment,
    );
    environment.set(assignment.name, assigned ?? []);
    return assigned;
  }
  const conditional = splitTopLevelConditional(value);
  if (conditional) {
    evaluateJavaConditionSideEffects(
      conditional.condition,
      environment,
      (condition, conditionEnvironment) =>
        publisherCallbackExpressions(
          runtime,
          method,
          condition,
          conditionEnvironment,
        ),
      (values) => intersectPublisherExpressions(...values),
    );
    const truth = staticJavaBoolean(conditional.condition);
    const branches = [];
    if (truth !== false) branches.push(conditional.consequent);
    if (truth !== true) branches.push(conditional.alternate);
    const evaluated = branches.map((branch) => {
      const branchEnvironment = new Map(environment);
      return {
        environment: branchEnvironment,
        result: publisherCallbackExpressions(
          runtime,
          method,
          branch,
          branchEnvironment,
        ),
      };
    });
    mergeBranchEnvironments(
      environment,
      evaluated.map(({ environment: branch }) => branch),
      (values) => intersectPublisherExpressions(...values),
    );
    const resolved = evaluated.map(({ result }) => result);
    if (resolved.some((branch) => branch === null)) return null;
    return intersectPublisherExpressions(...resolved);
  }
  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference && environment.has(reference)) {
    return environment.get(reference);
  }
  const calls = topLevelMethodCalls(value);
  const outputCall = calls.at(-1);
  if (outputCall) {
    let targets = methodCallTargets(runtime, method, outputCall);
    if (targets.length === 0) {
      const sameClass = runtime.methods.filter(
        (candidate) =>
          candidate.className === method.className &&
          candidate.name === outputCall.name &&
          candidate.parameterNames.length === outputCall.arguments.length,
      );
      if (sameClass.length === 1) targets = sameClass;
    }
    for (const target of targets) {
      let indexes = [...returnedPublisherParameterIndexes(runtime, target)];
      if (indexes.length === 0) {
        const returns = reachableMethodReturns(target);
        indexes = target.parameterNames.flatMap((parameter, index) =>
          returns.length > 0 &&
            returns.every(
              ({ variantExpression }) =>
                unwrapParentheses(variantExpression) === parameter,
            )
            ? [index]
            : []
        );
      }
      if (indexes.length !== 1) continue;
      const resolved = publisherCallbackExpressions(
        runtime,
        method,
        outputCall.arguments[indexes[0]] ?? "",
        environment,
      );
      if (resolved !== null) return resolved;
    }
    if (
      [
        "doOnError",
        "doOnNext",
        "filter",
        "hide",
        "onErrorMap",
        "take",
      ].includes(outputCall.name)
    ) {
      const receiver = callReceiverExpression(value, outputCall);
      if (receiver && receiver !== value) {
        const resolved = publisherCallbackExpressions(
          runtime,
          method,
          receiver,
          environment,
        );
        if (resolved !== null) return resolved;
      }
    }
  }
  return reactorPublisherExpression(runtime, method, value) ? [value] : null;
}

function publisherTransformReturnsInput(runtime, method, call) {
  const callback = publisherTransformCallback(call, runtime, method);
  if (!callback || callback.returns.length === 0) return false;
  const environment = new Map(
    callback.parameters.map((parameter, index) => [parameter, index === 0]),
  );
  const returns = publisherCallbackReturnFlows(
    runtime,
    method,
    callback,
    environment,
    (callbackMethod, assignment, reaching) =>
      publisherParameterExpression(
        runtime,
        callbackMethod,
        assignment.expression,
        reaching,
      ),
    (previous, assigned) => Boolean(previous && assigned),
  );
  return returns.length > 0 && returns.every((returned) =>
    publisherParameterExpression(
      runtime,
      returned.method,
      returned.expression,
      returned.environment,
    )
  );
}

function reachingPublisherAssignment(method, name, position) {
  const assignments = flowAssignmentEvents(method, position)
    .filter(
      (assignment) =>
        assignment.name === name &&
        assignment.position < position &&
        !assignment.conditional,
    );
  return assignments.at(-1) ?? null;
}

function publisherDataValueOrigins(
  runtime,
  method,
  expression,
  position,
  environment = new Map(),
  seen = new Set(),
) {
  const value = unwrapParentheses(expression);
  if (!value) return [];
  const key = `value:${position}:${value}`;
  if (seen.has(key)) return [];
  const nextSeen = new Set(seen).add(key);
  const assignment = topLevelAssignmentExpression(value);
  if (assignment) {
    const assigned = publisherDataValueOrigins(
      runtime,
      method,
      assignment.expression,
      position,
      environment,
      nextSeen,
    );
    environment.set(assignment.name, assigned);
    return assigned;
  }
  const conditional = splitTopLevelConditional(value);
  if (conditional) {
    evaluateJavaConditionSideEffects(
      conditional.condition,
      environment,
      (condition, conditionEnvironment) =>
        publisherDataValueOrigins(
          runtime,
          method,
          condition,
          position,
          conditionEnvironment,
          nextSeen,
        ),
      (values) => intersectPublisherDataOrigins(...values),
    );
    const truth = staticJavaBoolean(conditional.condition);
    const branches = [];
    if (truth !== false) branches.push(conditional.consequent);
    if (truth !== true) branches.push(conditional.alternate);
    const evaluated = branches.map((branch) => {
      const branchEnvironment = new Map(environment);
      return {
        environment: branchEnvironment,
        result: publisherDataValueOrigins(
          runtime,
          method,
          branch,
          position,
          branchEnvironment,
          nextSeen,
        ),
      };
    });
    mergeBranchEnvironments(
      environment,
      evaluated.map(({ environment: branch }) => branch),
      (values) => intersectPublisherDataOrigins(...values),
    );
    return intersectPublisherDataOrigins(
      ...evaluated.map(({ result }) => result),
    );
  }

  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) {
    if (environment.has(reference)) {
      return mergePublisherDataOrigins(environment.get(reference));
    }
    const assignment = reachingPublisherAssignment(method, reference, position);
    if (assignment) {
      return publisherDataValueOrigins(
        runtime,
        method,
        assignment.expression,
        assignment.position,
        environment,
        nextSeen,
      );
    }
  }

  const array = /^new\s+[A-Za-z_$][\w$.]*(?:\s*<[^>]+>)?\s*\[\s*\]\s*\{([\s\S]*)\}$/
    .exec(value);
  if (array) {
    return shiftPublisherDataOrigins(
      mergePublisherDataOrigins(
        ...splitTopLevel(array[1]).map((item) =>
          publisherDataValueOrigins(
            runtime,
            method,
            item,
            position,
            environment,
            nextSeen,
          )
        ),
      ),
      1,
    );
  }

  const calls = topLevelMethodCalls(value);
  const call = calls.at(-1);
  if (call && call.close === maskJava(value, false).trimEnd().length - 1) {
    const receiver = callReceiverExpression(value, call);
    if (
      trustedPublisherContainerReceiver(
        runtime,
        method,
        receiver,
        position,
      ) &&
      (
        ["asList", "of"].includes(call.name) ||
        call.name === "singletonList"
      )
    ) {
      return shiftPublisherDataOrigins(
        mergePublisherDataOrigins(
          ...call.arguments.map((argument) =>
            publisherDataValueOrigins(
              runtime,
              method,
              argument,
              position,
              environment,
              nextSeen,
            )
          ),
        ),
        1,
      );
    }
  }

  return reactorPublisherExpression(runtime, method, value)
    ? [{ expression: value, depth: 0 }]
    : [];
}

function publisherOutputDataOrigins(
  runtime,
  method,
  expression,
  position,
  environment = new Map(),
  seen = new Set(),
) {
  const value = unwrapParentheses(expression);
  if (!value) return [];
  const key = `output:${position}:${value}`;
  if (seen.has(key)) return [];
  const nextSeen = new Set(seen).add(key);
  const assignment = topLevelAssignmentExpression(value);
  if (assignment) {
    const assigned = publisherOutputDataOrigins(
      runtime,
      method,
      assignment.expression,
      position,
      environment,
      nextSeen,
    );
    environment.set(assignment.name, assigned);
    return assigned;
  }
  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) {
    if (environment.has(reference)) {
      return mergePublisherDataOrigins(
        ...environment.get(reference)
          .filter(({ depth }) => depth === 0)
          .map((origin) =>
            publisherOutputDataOrigins(
              runtime,
              method,
              origin.expression,
              position,
              new Map(),
              nextSeen,
            )
          ),
      );
    }
    const assignment = reachingPublisherAssignment(method, reference, position);
    if (assignment) {
      return publisherOutputDataOrigins(
        runtime,
        method,
        assignment.expression,
        assignment.expressionPosition ?? assignment.position,
        environment,
        nextSeen,
      );
    }
    return [];
  }

  const calls = topLevelMethodCalls(value);
  const call = calls.at(-1);
  if (!call) return [];
  const receiver = callReceiverExpression(value, call);
  if (trustedReactorStaticReceiver(runtime, receiver)) {
    if (["just", "justOrEmpty"].includes(call.name)) {
      return mergePublisherDataOrigins(
        ...call.arguments.map((argument) =>
          publisherDataValueOrigins(
            runtime,
            method,
            argument,
            position,
            environment,
            nextSeen,
          )
        ),
      );
    }
    if (["fromArray", "fromIterable"].includes(call.name)) {
      return shiftPublisherDataOrigins(
        publisherDataValueOrigins(
          runtime,
          method,
          call.arguments[0] ?? "",
          position,
          environment,
          nextSeen,
        ),
        -1,
      );
    }
  }

  const upstream = receiver && receiver !== value
    ? publisherOutputDataOrigins(
      runtime,
      method,
      receiver,
      position,
      environment,
      nextSeen,
    )
    : [];
  const callback = lambdaDetails(
    call.arguments[0] ?? "",
    runtime,
    method,
  );
  if (
    publisherTransformCallbackMethods.has(call.name) &&
    callback?.parameters.length
  ) {
    const callbackEnvironment = new Map(environment);
    for (const parameter of callback.parameters) {
      callbackEnvironment.set(parameter, []);
    }
    callbackEnvironment.set(callback.parameters[0], upstream);
    const returns = publisherCallbackReturnFlows(
      runtime,
      method,
      callback,
      callbackEnvironment,
      (callbackMethod, assignment, reaching) =>
        publisherOutputDataOrigins(
          runtime,
          callbackMethod,
          assignment.expression,
          assignment.expressionPosition ?? assignment.position,
          reaching,
          nextSeen,
        ),
      (previous, assigned) =>
        mergePublisherDataOrigins(previous ?? [], assigned),
    );
    return intersectPublisherDataOrigins(
      ...returns.map((returned) =>
        publisherOutputDataOrigins(
          runtime,
          returned.method,
          returned.expression,
          returned.position ?? position,
          returned.environment,
          nextSeen,
        )
      ),
    );
  }
  if (
    callback?.parameters.length === 1 &&
    ["map"].includes(call.name)
  ) {
    const callbackEnvironment = new Map(environment);
    callbackEnvironment.set(callback.parameters[0], upstream);
    return mergePublisherDataOrigins(
      ...callback.returns.map((returned) =>
        publisherDataValueOrigins(
          runtime,
          callback.method ?? method,
          returned,
          0,
          callbackEnvironment,
          nextSeen,
        )
      ),
    );
  }
  if (
    callback?.parameters.length === 1 &&
    ["concatMap", "flatMap", "flatMapMany"].includes(call.name)
  ) {
    const callbackEnvironment = new Map(environment);
    callbackEnvironment.set(callback.parameters[0], upstream);
    return mergePublisherDataOrigins(
      ...callback.returns.map((returned) =>
        publisherOutputDataOrigins(
          runtime,
          callback.method ?? method,
          returned,
          0,
          callbackEnvironment,
          nextSeen,
        )
      ),
    );
  }
  if (
    [
      "doOnError",
      "doOnNext",
      "filter",
      "hide",
      "onErrorMap",
      "take",
    ].includes(call.name)
  ) {
    return upstream;
  }
  return [];
}

function callbackIsExecuted(code, arrow, bodyEnd) {
  const statement = functionalStatement(code, arrow);
  const call = enclosingFunctionalCall(code, arrow);
  const suffix = code.slice(bodyEnd, statement.end);
  if (/\.\s*(?:accept|apply|call|get|run|test)\s*\(/.test(suffix)) {
    return true;
  }
  if (["forEach", "ifPresent", "removeIf", "replaceAll"].includes(call)) {
    return true;
  }
  if (
    ["filter", "flatMap", "map", "peek"].includes(call) &&
    /\.(?:allMatch|anyMatch|collect|count|findAny|findFirst|forEach|noneMatch|reduce|toArray|toList)\s*\(/.test(
      statement.text,
    )
  ) {
    return true;
  }
  return false;
}

function functionalKey(functional, source) {
  return [
    functional.call ?? "",
    functional.binding ?? "",
    String(functional.ordinal ?? 0),
    maskJava(source.slice(functional.start, functional.end), true)
      .replace(/\s+/g, " ")
      .trim(),
  ].join("\u0000");
}

function reactorCallbackWasConsumed(callbacks, functional, source) {
  const key = functionalKey(functional, source);
  if (callbacks.has(key)) return true;
  const [call, binding, ordinal, body] = key.split("\u0000");
  return [...callbacks].some((candidate) => {
    const [
      candidateCall,
      candidateBinding,
      candidateOrdinal,
      candidateBody,
    ] =
      candidate.split("\u0000");
    return (
      call === candidateCall &&
      binding === candidateBinding &&
      (
        ordinal === candidateOrdinal ||
        (
          body &&
          candidateBody &&
          (
            candidateBody.includes(body) ||
            body.includes(candidateBody)
          )
        )
      )
    );
  });
}

function lexicalScopePath(code, position) {
  const path = [];
  for (let index = 0; index < position; index += 1) {
    if (code[index] === "{") path.push(index);
    else if (code[index] === "}") path.pop();
  }
  return path;
}

function scopeContains(owner, use) {
  return owner.length <= use.length &&
    owner.every((value, index) => value === use[index]);
}

function functionalExecutionAnalysis(source, executedReactorCallbacks = new Set()) {
  const code = maskJava(source, false);
  const functions = [];
  for (const match of code.matchAll(/->/g)) {
    const prefixStart = Math.max(
      code.lastIndexOf("\n", match.index - 1),
      code.lastIndexOf(";", match.index - 1),
      code.lastIndexOf("{", match.index - 1),
    ) + 1;
    if (
      /^\s*(?:case\b[\s\S]*|default)\s*$/.test(
        code.slice(prefixStart, match.index),
      )
    ) {
      continue;
    }
    const start = skipWhitespace(code, match.index + match[0].length);
    const close = code[start] === "{"
      ? matchingIndex(code, start, "{", "}")
      : functionalExpressionEnd(code, start);
    if (close < 0) continue;
    const end = code[start] === "{" ? close + 1 : close;
    const statement = functionalStatement(code, match.index);
    const assignmentPosition = statement.start +
      statement.text.slice(0, match.index - statement.start).lastIndexOf("=");
    const call = enclosingFunctionalCall(code, match.index);
    const block = code[start] === "{";
    functions.push({
      position: match.index,
      start: block ? start + 1 : start,
      end: block ? close : end,
      block,
      binding: assignedFunctionalName(statement, match.index),
      assignmentPosition,
      call,
      reactor: reactorCallbackMethods.has(call),
      scope: lexicalScopePath(code, Math.max(statement.start, assignmentPosition)),
      executed: callbackIsExecuted(code, match.index, end),
    });
  }

  for (const match of code.matchAll(
    /\bnew\s+[A-Za-z_$][\w$.]*(?:\s*<[^;{}()]*>)?\s*\(/g,
  )) {
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    const bodyOpen = skipWhitespace(code, close + 1);
    if (close < 0 || code[bodyOpen] !== "{") continue;
    const bodyClose = matchingIndex(code, bodyOpen, "{", "}");
    if (bodyClose < 0) continue;
    const statement = functionalStatement(code, match.index);
    const suffix = code.slice(bodyClose + 1, statement.end);
    const immediatelyInvoked =
      /\.\s*(?:accept|apply|call|get|run|test)\s*\(/.test(suffix);
    const assignmentPosition = statement.start +
      statement.text.slice(0, match.index - statement.start).lastIndexOf("=");
    functions.push({
      position: match.index,
      start: bodyOpen + 1,
      end: bodyClose,
      binding: assignedFunctionalName(statement, match.index),
      assignmentPosition,
      call: null,
      reactor: false,
      scope: lexicalScopePath(code, Math.max(statement.start, assignmentPosition)),
      executed: immediatelyInvoked,
    });
  }
  for (const match of code.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*=\s*((?:this|super|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*::\s*([A-Za-z_$][\w$]*))/g,
  )) {
    functions.push({
      position: match.index,
      start: match.index,
      end: match.index,
      binding: match[1],
      assignmentPosition: code.indexOf("=", match.index),
      call: null,
      reactor: false,
      scope: lexicalScopePath(code, match.index),
      executed: false,
      reference: {
        receiver: match[2].slice(0, match[2].lastIndexOf("::")).trim(),
        method: match[3],
      },
    });
  }
  const ordinals = new Map();
  for (const functional of functions) {
    const group = `${functional.call ?? ""}\u0000${functional.binding ?? ""}`;
    functional.ordinal = ordinals.get(group) ?? 0;
    ordinals.set(group, functional.ordinal + 1);
  }
  for (const functional of functions) {
    if (
      functional.reactor &&
      reactorCallbackWasConsumed(
        executedReactorCallbacks,
        functional,
        source,
      )
    ) {
      functional.executed = true;
    }
  }

  const assignmentEvents = flowAssignmentEvents({ literal: source })
    .filter(({ reachable }) => reachable)
    .map((assignment) => ({
      ...assignment,
      scope: lexicalScopePath(code, assignment.position),
    }));
  const assignments = new Map();
  for (const assignment of assignmentEvents) {
    if (!assignments.has(assignment.name)) {
      assignments.set(assignment.name, []);
    }
    assignments.get(assignment.name).push(assignment);
  }
  const assignedFunctionals = new Map();
  for (const functional of functions) {
    if (!functional.binding) continue;
    const assignment = (assignments.get(functional.binding) ?? [])
      .filter(
        (candidate) =>
          candidate.position <= functional.position &&
          functional.position < candidate.end,
      )
      .sort((left, right) => right.position - left.position)[0];
    if (assignment) assignedFunctionals.set(assignment, functional);
  }
  const invocations = Array.from(
    code.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:accept|apply|call|get|run|test)\s*\(/g,
    ),
    (match) => ({
      name: match[1],
      position: match.index,
      end: match.index + match[0].length -
        match[0].slice(match[0].lastIndexOf("(")).length,
      scope: lexicalScopePath(code, match.index),
    }),
  );
  const reachingAssignment = (name, position, useScope) =>
    (assignments.get(name) ?? [])
      .filter(
        (assignment) =>
          assignment.position < position &&
          scopeContains(assignment.scope, useScope),
      )
      .sort((left, right) => right.position - left.position)[0] ?? null;
  const resolveFunctionals = (
    name,
    position,
    useScope,
    seen = new Set(),
  ) => {
    const key = `${name}:${position}`;
    if (seen.has(key)) return new Set();
    const assignment = reachingAssignment(name, position, useScope);
    if (!assignment) return new Set();
    const nextSeen = new Set(seen).add(key);
    const resolved = new Set();
    const direct = assignedFunctionals.get(assignment);
    if (direct) {
      resolved.add(direct);
    } else {
      const alias = /^([A-Za-z_$][\w$]*)$/.exec(
        unwrapParentheses(assignment.expression),
      )?.[1];
      if (alias) {
        for (const functional of resolveFunctionals(
          alias,
          assignment.position,
          assignment.scope,
          nextSeen,
        )) {
          resolved.add(functional);
        }
      }
    }
    if (assignment.conditional) {
      for (const functional of resolveFunctionals(
        name,
        assignment.position,
        useScope,
        nextSeen,
      )) {
        resolved.add(functional);
      }
    }
    return resolved;
  };
  const rewrites = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const invocation of invocations) {
      const owners = functions.filter(
        (candidate) =>
          candidate.start <= invocation.position &&
          invocation.position < candidate.end,
      );
      if (
        owners.length > 0 &&
        !owners.some((candidate) => candidate.executed)
      ) {
        continue;
      }
      const resolved = resolveFunctionals(
        invocation.name,
        invocation.position,
        invocation.scope,
      );
      if (resolved.size !== 1) continue;
      const [functional] = resolved;
      if (!functional.executed) {
        functional.executed = true;
        changed = true;
      }
    }
  }
  for (const invocation of invocations) {
    const resolved = resolveFunctionals(
      invocation.name,
      invocation.position,
      invocation.scope,
    );
    if (resolved.size !== 1) continue;
    const [functional] = resolved;
    if (!functional.executed || !functional.reference) continue;
    const replacement = functional.reference.receiver === "this"
      ? functional.reference.method
      : `${functional.reference.receiver}.${functional.reference.method}`;
    if (replacement.length <= invocation.end - invocation.position) {
      rewrites.push({
        start: invocation.position,
        end: invocation.end,
        replacement,
      });
    }
  }
  return {
    functions,
    rewrites,
    deferred: functions
    .filter(({ executed }) => !executed)
    .filter(({ start, end }) => end > start)
    .map(({ start, end }) => ({ start, end })),
  };
}

function deferredFunctionalRanges(source, executedReactorCallbacks = new Set()) {
  return functionalExecutionAnalysis(source, executedReactorCallbacks).deferred;
}

function executableFunctionalText(source, executedReactorCallbacks = new Set()) {
  const characters = [...source];
  const analysis = functionalExecutionAnalysis(
    source,
    executedReactorCallbacks,
  );
  for (const { start, end } of analysis.deferred) {
    for (let index = start; index < end; index += 1) {
      if (characters[index] !== "\n" && characters[index] !== "\r") {
        characters[index] = " ";
      }
    }
  }
  for (const { start, end, replacement } of analysis.rewrites) {
    const padded = replacement.padEnd(end - start, " ");
    for (let index = start; index < end; index += 1) {
      characters[index] = padded[index - start];
    }
  }
  return characters.join("");
}

function conditionalAt(text, index) {
  if (!startsWithWord(text, index, "if")) return null;
  const conditionOpen = text.indexOf("(", index + 2);
  const conditionClose = matchingIndex(text, conditionOpen);
  if (conditionOpen < 0 || conditionClose < 0) return null;
  const consequentStart = skipWhitespace(text, conditionClose + 1);
  const consequentEnd = javaStatementEnd(text, consequentStart);
  if (consequentEnd < 0) return null;
  const alternateWord = skipWhitespace(text, consequentEnd);
  const hasAlternate = startsWithWord(text, alternateWord, "else");
  const alternateStart = hasAlternate
    ? skipWhitespace(text, alternateWord + 4)
    : -1;
  const alternateEnd = hasAlternate
    ? javaStatementEnd(text, alternateStart)
    : -1;
  if (hasAlternate && alternateEnd < 0) return null;
  return {
    condition: text.slice(conditionOpen + 1, conditionClose).trim(),
    consequentStart,
    consequentEnd,
    alternateStart,
    alternateEnd,
    end: hasAlternate ? alternateEnd : consequentEnd,
  };
}

function javaConditionLiteral(expression) {
  const value = unwrapParentheses(expression);
  if (value === "true" || value === "Boolean.TRUE") return true;
  if (value === "false" || value === "Boolean.FALSE") return false;
  if (value === "null") return null;
  if (/^[+-]?\d+[lL]$/.test(value)) {
    return Number.parseInt(value.slice(0, -1), 10);
  }
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (
    /^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?[fFdD]?$/.test(value)
  ) {
    return Number.parseFloat(value.replace(/[fFdD]$/, ""));
  }
  const string = javaStringValue(value);
  return string === null ? undefined : string;
}

function topLevelConditionParts(expression, operator) {
  const parts = [];
  let start = 0;
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character in depth) depth[character] += 1;
    else if (character in closing) depth[closing[character]] -= 1;
    else if (
      expression.startsWith(operator, index) &&
      Object.values(depth).every((value) => value === 0)
    ) {
      parts.push(expression.slice(start, index));
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  parts.push(expression.slice(start));
  return parts;
}

function staticJavaBoolean(expression) {
  const value = unwrapParentheses(expression);
  const literal = javaConditionLiteral(value);
  if (typeof literal === "boolean") return literal;
  if (value.startsWith("!") && !value.startsWith("!=")) {
    const operand = staticJavaBoolean(value.slice(1));
    return operand === null ? null : !operand;
  }
  const disjunction = topLevelConditionParts(value, "||");
  if (disjunction.length > 1) {
    let unknown = false;
    for (const part of disjunction) {
      const result = staticJavaBoolean(part);
      if (result === true) return true;
      unknown ||= result === null;
    }
    return unknown ? null : false;
  }
  const conjunction = topLevelConditionParts(value, "&&");
  if (conjunction.length > 1) {
    let unknown = false;
    for (const part of conjunction) {
      const result = staticJavaBoolean(part);
      if (result === false) return false;
      unknown ||= result === null;
    }
    return unknown ? null : true;
  }
  const comparison =
    /^([\s\S]+?)\s*(==|!=|<=|>=|<|>)\s*([\s\S]+)$/.exec(value);
  if (!comparison) return null;
  const left = javaConditionLiteral(comparison[1]);
  const right = javaConditionLiteral(comparison[3]);
  if (left === undefined || right === undefined) return null;
  if (comparison[2] === "==") return left === right;
  if (comparison[2] === "!=") return left !== right;
  if (comparison[2] === "<") return left < right;
  if (comparison[2] === "<=") return left <= right;
  if (comparison[2] === ">") return left > right;
  return left >= right;
}

function javaIterableCardinality(expression) {
  const value = unwrapParentheses(expression).trim();
  const factory =
    /^(?:(?:java\s*\.\s*util\s*\.\s*)?(?:List|Set)|Arrays)\s*\.\s*(?:of|asList)\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (factory) {
    const arguments_ = splitTopLevel(factory[1]);
    return arguments_.length === 1 && arguments_[0] === ""
      ? 0
      : arguments_.length;
  }
  if (
    /^(?:java\s*\.\s*util\s*\.\s*)?Collections\s*\.\s*empty(?:List|Set)\s*\(\s*\)$/.test(
      value,
    ) ||
    /^(?:java\s*\.\s*util\s*\.\s*)?stream\s*\.\s*Stream\s*\.\s*empty\s*\(\s*\)$/.test(
      value,
    )
  ) {
    return 0;
  }
  if (
    /^(?:java\s*\.\s*util\s*\.\s*)?Collections\s*\.\s*singleton(?:List)?\s*\(/.test(
      value,
    )
  ) {
    return 1;
  }
  const arrayInitializer =
    /^new\s+[A-Za-z_$][\w$.<>?]*\s*\[\s*\]\s*\{([\s\S]*)\}$/.exec(value);
  if (arrayInitializer) {
    const items = splitTopLevel(arrayInitializer[1]);
    return items.length === 1 && items[0] === "" ? 0 : items.length;
  }
  const arrayLength =
    /^new\s+[A-Za-z_$][\w$.<>?]*\s*\[\s*(\d+)\s*\]$/.exec(value);
  return arrayLength ? Number(arrayLength[1]) : null;
}

function classicForExecution(header) {
  const parts = header.split(";").map((part) => part.trim());
  if (parts.length !== 3) return null;
  const initializer =
    /(?:^|\s)([A-Za-z_$][\w$]*)\s*=\s*(-?\d+)\s*$/.exec(parts[0]);
  if (!initializer) return null;
  const comparison = new RegExp(
    `^\\s*${escapeRegExp(initializer[1])}\\s*(==|!=|<=|>=|<|>)\\s*(-?\\d+)\\s*$`,
  ).exec(parts[1]);
  if (!comparison) return null;
  return staticJavaBoolean(
    `${initializer[2]} ${comparison[1]} ${comparison[2]}`,
  )
    ? "nonempty"
    : "zero";
}

function loopExecution(kind, header) {
  if (kind === "while") {
    const condition = staticJavaBoolean(header);
    return condition === true
      ? "nonempty"
      : condition === false
        ? "zero"
        : "unknown";
  }
  const enhanced = /^([\s\S]*?)\s*:\s*([\s\S]+)$/.exec(header);
  if (enhanced) {
    const cardinality = javaIterableCardinality(enhanced[2]);
    return cardinality === 0
      ? "zero"
      : cardinality === null
        ? "unknown"
        : "nonempty";
  }
  return classicForExecution(header) ?? "unknown";
}

function loopControls(source) {
  const structural = maskJava(source, false);
  const controls = [];
  for (const match of structural.matchAll(/\b(for|while)\s*\(/g)) {
    const open = structural.indexOf("(", match.index);
    const close = matchingIndex(structural, open);
    if (close < 0) continue;
    const start = skipWhitespace(structural, close + 1);
    let end;
    if (structural[start] === "{") {
      const bodyClose = matchingIndex(structural, start, "{", "}");
      end = bodyClose < 0 ? -1 : bodyClose + 1;
    } else {
      end = javaStatementEnd(structural, start);
    }
    if (end < 0) continue;
    controls.push({
      start,
      end,
      execution: loopExecution(
        match[1],
        source.slice(open + 1, close),
      ),
    });
  }
  for (const match of structural.matchAll(/\bdo\b/g)) {
    const start = skipWhitespace(structural, match.index + match[0].length);
    let end;
    if (structural[start] === "{") {
      const bodyClose = matchingIndex(structural, start, "{", "}");
      end = bodyClose < 0 ? -1 : bodyClose + 1;
    } else {
      end = javaStatementEnd(structural, start);
    }
    if (end >= 0) controls.push({ start, end, execution: "nonempty" });
  }
  return controls;
}

function assignmentControl(method, position) {
  const structural = maskJava(method.literal, false);
  let conditional = false;
  for (const match of structural.matchAll(/\bif\s*\(/g)) {
    const branch = conditionalAt(structural, match.index);
    if (!branch) continue;
    const inConsequent =
      branch.consequentStart <= position && position < branch.consequentEnd;
    const inAlternate =
      branch.alternateStart >= 0 &&
      branch.alternateStart <= position &&
      position < branch.alternateEnd;
    if (!inConsequent && !inAlternate) continue;
    const condition = staticJavaBoolean(branch.condition);
    if (
      condition === true && inAlternate ||
      condition === false && inConsequent
    ) {
      return { reachable: false, conditional: false };
    }
    if (condition === null) conditional = true;
  }
  for (const loop of loopControls(method.literal)) {
    if (!(loop.start <= position && position < loop.end)) continue;
    if (loop.execution === "zero") {
      return { reachable: false, conditional: false };
    }
    if (loop.execution === "unknown") conditional = true;
  }
  return { reachable: true, conditional };
}

function statementBody(source, start, end) {
  if (start < 0 || end < 0) return "";
  const first = skipWhitespace(source, start);
  if (source[first] === "{") {
    return source.slice(first + 1, end - 1);
  }
  return source.slice(first, end);
}

function splitTopLevel(text) {
  const values = [];
  let start = 0;
  let state = "code";
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state !== "code") {
      if (character === "\\") index += 1;
      else if (
        state === "string" && character === '"' ||
        state === "character" && character === "'"
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') state = "string";
    else if (character === "'") state = "character";
    else if (character in depth) depth[character] += 1;
    else if (character in closing) depth[closing[character]] -= 1;
    else if (
      character === "," &&
      Object.values(depth).every((value) => value === 0)
    ) {
      values.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = text.slice(start).trim();
  if (final || values.length > 0) values.push(final);
  return values;
}

function splitTopLevelRanges(text) {
  const ranges = [];
  let start = 0;
  let state = "code";
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (state !== "code") {
      if (character === "\\") index += 1;
      else if (
        state === "string" && character === '"' ||
        state === "character" && character === "'"
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') state = "string";
    else if (character === "'") state = "character";
    else if (character in depth) depth[character] += 1;
    else if (character in closing) depth[closing[character]] -= 1;
    else if (
      character === "," &&
      Object.values(depth).every((value) => value === 0)
    ) {
      ranges.push({ start, end: index, value: text.slice(start, index) });
      start = index + 1;
    }
  }
  ranges.push({ start, end: text.length, value: text.slice(start) });
  return ranges;
}

function javaVariableDeclarations(text) {
  const code = maskJava(text, false);
  const declarations = [];
  const pattern =
    /\b(?:(?:public|protected|private|static|final|transient|volatile)\s+)*(?!return\b|throw\b|yield\b|break\b|continue\b)([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;{}()]*>)?(?:\s*\[\s*\])*)\s+([^;{}]+);/g;
  for (const match of code.matchAll(pattern)) {
    const declarators = match[2];
    const declaratorsStart = match.index + match[0].indexOf(declarators);
    for (const range of splitTopLevelRanges(declarators)) {
      const declarator =
        /^\s*([A-Za-z_$][\w$]*)\s*(?:\[\s*\])*\s*(?:=([\s\S]*))?$/.exec(
          range.value,
        );
      if (!declarator) continue;
      const relativeName = range.value.indexOf(declarator[1]);
      const equals = range.value.indexOf("=");
      const literalValue = text.slice(
        declaratorsStart + range.start,
        declaratorsStart + range.end,
      );
      const rawExpression = equals >= 0
        ? literalValue.slice(equals + 1)
        : "";
      const expressionLeading = Math.max(0, rawExpression.search(/\S/));
      declarations.push({
        type: normalizeJavaType(match[1]),
        typeReference: normalizeJavaTypeReference(match[1]),
        static: /\bstatic\b/.test(
          match[0].slice(0, match[0].indexOf(match[1])),
        ),
        name: declarator[1],
        expression: rawExpression.trim(),
        expressionPosition: equals >= 0
          ? declaratorsStart + range.start + equals + 1 + expressionLeading
          : -1,
        initialized: equals >= 0,
        position: declaratorsStart + range.start + relativeName,
        end: match.index + match[0].length,
      });
    }
  }
  return declarations;
}

function splitTopLevelConditional(expression) {
  let state = "code";
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  let question = -1;
  let nested = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (state !== "code") {
      if (character === "\\") index += 1;
      else if (
        state === "string" && character === '"' ||
        state === "character" && character === "'"
      ) {
        state = "code";
      }
      continue;
    }
    if (character === '"') state = "string";
    else if (character === "'") state = "character";
    else if (character in depth) depth[character] += 1;
    else if (character in closing) depth[closing[character]] -= 1;
    else if (Object.values(depth).every((value) => value === 0)) {
      if (character === "?") {
        if (question < 0) question = index;
        else nested += 1;
      } else if (character === ":" && question >= 0) {
        if (nested > 0) nested -= 1;
        else {
          return {
            condition: expression.slice(0, question).trim(),
            consequent: expression.slice(question + 1, index).trim(),
            alternate: expression.slice(index + 1).trim(),
          };
        }
      }
    }
  }
  return null;
}

function unwrapParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith("(")) {
    const close = matchingIndex(value, 0);
    if (close !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

function callAt(expression, methodName) {
  const pattern = new RegExp(`\\.\\s*${escapeRegExp(methodName)}\\s*\\(`, "g");
  const matches = Array.from(expression.matchAll(pattern));
  const match = matches.at(-1);
  if (!match) return null;
  const open = expression.indexOf("(", match.index);
  const close = matchingIndex(expression, open);
  if (close < 0) return null;
  return {
    receiver: expression.slice(0, match.index).trim(),
    arguments: splitTopLevel(expression.slice(open + 1, close)),
    suffix: expression.slice(close + 1).trim(),
  };
}

function parameterNames(parameters) {
  return splitTopLevel(parameters)
    .map((parameter) =>
      /([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?\s*$/.exec(
        parameter
          .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, "")
          .replace(/\bfinal\b/g, "")
          .trim(),
      )?.[1]
    )
    .filter(Boolean);
}

function normalizeJavaType(type) {
  const value = normalizeJavaTypeReference(type);
  const dimensions = (value.match(/\[\]/g) ?? []).length;
  const base = value.replace(/\[\]/g, "");
  const simple = base.split(".").at(-1) ?? base;
  return `${simple}${"[]".repeat(dimensions)}`;
}

function normalizeJavaTypeReference(type) {
  let value = String(type ?? "")
    .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, "")
    .replace(/\bfinal\b/g, "")
    .trim()
    .replace(/\.\.\./g, "[]")
    .replace(/\s+/g, "");
  for (let pass = 0; pass < 8 && value.includes("<"); pass += 1) {
    value = value.replace(/<[^<>]*>/g, "");
  }
  return value;
}

function parameterTypes(parameters) {
  return splitTopLevel(parameters).map((parameter) => {
    const cleaned = parameter
      .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, "")
      .replace(/\bfinal\b/g, "")
      .trim();
    const match = /^(.+?)\s+([A-Za-z_$][\w$]*)(\s*\[\s*\])?$/.exec(cleaned);
    return match
      ? normalizeJavaType(`${match[1]}${match[3] ?? ""}`)
      : "";
  });
}

function parameterTypeReferences(parameters) {
  return splitTopLevel(parameters).map((parameter) => {
    const cleaned = parameter
      .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, "")
      .replace(/\bfinal\b/g, "")
      .trim();
    const match = /^(.+?)\s+([A-Za-z_$][\w$]*)(\s*\[\s*\])?$/.exec(cleaned);
    return match
      ? normalizeJavaTypeReference(`${match[1]}${match[3] ?? ""}`)
      : "";
  });
}

const knownJavaSupertypes = new Map([
  ["String", new Set(["Object", "CharSequence", "Serializable", "Comparable"])],
  [
    "StringBuilder",
    new Set([
      "Object",
      "CharSequence",
      "Serializable",
      "Comparable",
      "Appendable",
    ]),
  ],
  [
    "StringBuffer",
    new Set([
      "Object",
      "CharSequence",
      "Serializable",
      "Comparable",
      "Appendable",
    ]),
  ],
  ["Boolean", new Set(["Object", "Serializable", "Comparable"])],
  ["Byte", new Set(["Number", "Object", "Serializable", "Comparable"])],
  ["Short", new Set(["Number", "Object", "Serializable", "Comparable"])],
  ["Integer", new Set(["Number", "Object", "Serializable", "Comparable"])],
  ["Long", new Set(["Number", "Object", "Serializable", "Comparable"])],
  ["Float", new Set(["Number", "Object", "Serializable", "Comparable"])],
  ["Double", new Set(["Number", "Object", "Serializable", "Comparable"])],
  ["Character", new Set(["Object", "Serializable", "Comparable"])],
  ["Number", new Set(["Object", "Serializable"])],
]);

const javaLangTypes = new Set([
  "Appendable",
  "Boolean",
  "Byte",
  "Character",
  "CharSequence",
  "Class",
  "Cloneable",
  "Comparable",
  "Double",
  "Enum",
  "Float",
  "Integer",
  "Iterable",
  "Long",
  "Number",
  "Object",
  "Record",
  "Runnable",
  "Short",
  "String",
  "StringBuffer",
  "StringBuilder",
  "Throwable",
]);
const jdkHierarchyCache = new Map();
const jdkStaticMemberCache = new Map();

function javaSourceTypeContext(source) {
  const code = maskJava(source, false);
  const packageName =
    /\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/.exec(
      code,
    )?.[1] ?? "";
  const imports = new Map();
  const wildcardImports = new Set();
  for (const match of code.matchAll(
    /\bimport\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\.\*)?\s*;/g,
  )) {
    if (match[2]) {
      wildcardImports.add(match[1]);
      continue;
    }
    const simple = match[1].split(".").at(-1);
    if (!imports.has(simple)) imports.set(simple, new Set());
    imports.get(simple).add(match[1]);
  }
  return { packageName, imports, wildcardImports };
}

function resolveJavaTypeIdentity(runtime, type, context = null) {
  const reference = normalizeJavaTypeReference(type);
  if (!reference) return null;
  const dimensions = (reference.match(/\[\]/g) ?? []).length;
  const base = reference.replace(/\[\]/g, "");
  const suffix = "[]".repeat(dimensions);
  if (javaPrimitiveTypes.has(base) || base === "void" || base === "null") {
    return `${base}${suffix}`;
  }
  const activeContext = context ?? runtime.sourceTypeContext ?? {
    packageName: "",
    imports: new Map(),
    wildcardImports: new Set(),
  };
  const declared = (candidate) =>
    runtime.typeDeclarations?.has(candidate);
  const enclosing = activeContext.enclosingType ?? "";
  if (enclosing) {
    const packageDepth = activeContext.packageName
      ? activeContext.packageName.split(".").length
      : 0;
    const enclosingParts = enclosing.split(".");
    if (
      !base.includes(".") &&
      enclosingParts.at(-1) === base &&
      declared(enclosing)
    ) {
      return `${enclosing}${suffix}`;
    }
    for (
      let length = enclosingParts.length;
      length >= packageDepth;
      length -= 1
    ) {
      const prefix = enclosingParts.slice(0, length).join(".");
      const candidate = prefix ? `${prefix}.${base}` : base;
      if (declared(candidate)) return `${candidate}${suffix}`;
    }
  }

  if (base.includes(".")) {
    if (declared(base)) return `${base}${suffix}`;
    const samePackage = activeContext.packageName
      ? `${activeContext.packageName}.${base}`
      : base;
    if (declared(samePackage)) return `${samePackage}${suffix}`;

    const [root, ...rest] = base.split(".");
    const importedCandidates = new Set(
      [...(activeContext.imports?.get(root) ?? [])]
        .map((imported) => [imported, ...rest].join("."))
        .filter(declared),
    );
    if (importedCandidates.size === 1) {
      return `${[...importedCandidates][0]}${suffix}`;
    }
    if (importedCandidates.size > 1) return null;

    const wildcardCandidates = new Set(
      [...(activeContext.wildcardImports ?? [])]
        .map((packageName) => `${packageName}.${base}`)
        .filter((candidate) =>
          declared(candidate) || candidate.startsWith("java.")
        ),
    );
    if (wildcardCandidates.size === 1) {
      return `${[...wildcardCandidates][0]}${suffix}`;
    }
    if (wildcardCandidates.size > 1) return null;
    return `${base}${suffix}`;
  }

  const candidates = new Set();
  const samePackage = activeContext.packageName
    ? `${activeContext.packageName}.${base}`
    : base;
  if (declared(samePackage)) {
    candidates.add(samePackage);
  }
  for (const imported of activeContext.imports?.get(base) ?? []) {
    candidates.add(imported);
  }
  for (const packageName of activeContext.wildcardImports ?? []) {
    const qualified = `${packageName}.${base}`;
    if (
      declared(qualified) ||
      packageName.startsWith("java.")
    ) {
      candidates.add(qualified);
    }
  }
  if (javaLangTypes.has(base)) candidates.add(`java.lang.${base}`);
  if (candidates.size === 0) {
    for (const qualified of runtime.typeCandidates?.get(base) ?? []) {
      candidates.add(qualified);
    }
  }
  if (candidates.size === 1) return `${[...candidates][0]}${suffix}`;
  if (candidates.size > 1) return null;
  return `${base}${suffix}`;
}

function addStaticMemberType(target, key, type, context = null) {
  if (!type) return;
  if (!target.has(key)) target.set(key, []);
  target.get(key).push({
    type: normalizeJavaTypeReference(type),
    context,
  });
}

function loadJdkStaticMemberTypes(qualified) {
  if (!jdkStaticMemberCache.has(qualified)) {
    const result = spawnSync("javap", ["-public", qualified], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (result.status !== 0) {
      jdkStaticMemberCache.set(qualified, null);
    } else {
      const methods = new Map();
      const fields = new Map();
      for (const rawLine of result.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!/^public\s+static\b/.test(line) || !line.endsWith(";")) {
          continue;
        }
        const open = line.indexOf("(");
        const head = line.slice(0, open >= 0 ? open : -1).trim();
        const nameMatch = /([A-Za-z_$][\w$]*)$/.exec(head);
        if (!nameMatch) continue;
        let type = head.slice(0, nameMatch.index).trim()
          .replace(
            /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|transient|volatile)\s+)*/,
            "",
          )
          .replace(/^<[^>]+>\s*/, "");
        type = normalizeJavaTypeReference(type);
        if (!type || /^[A-Z_$][\w$]*$/.test(type) && type.length <= 2) {
          continue;
        }
        const target = open >= 0 ? methods : fields;
        if (!target.has(nameMatch[1])) target.set(nameMatch[1], new Set());
        target.get(nameMatch[1]).add(type);
      }
      jdkStaticMemberCache.set(qualified, { methods, fields });
    }
  }
  return jdkStaticMemberCache.get(qualified);
}

function javaStaticMemberValueType(
  expression,
  runtime = null,
  method = null,
  facts = null,
  sourcePosition = null,
) {
  const member = javaStaticMemberExpression(expression);
  if (!member) return null;
  const root = member.receiver.split(".")[0];
  const position = sourcePosition ??
    (facts instanceof Map ? null : facts?.sourcePosition) ??
    method?.literal.length ??
    0;
  if (
    runtime && method
      ? identifierShadowsType(runtime, method, root, position)
      : javaFactTypes(facts).has(root)
  ) {
    return null;
  }
  let receiver = runtime
    ? resolveJavaTypeIdentity(
      runtime,
      member.receiver,
      method?.typeContext ?? runtime.sourceTypeContext,
    )
    : member.receiver.includes(".")
      ? member.receiver
      : null;
  if (
    runtime &&
    receiver === member.receiver &&
    !member.receiver.includes(".")
  ) {
    const candidates = new Set();
    for (const match of runtime.code.matchAll(
      /\bimport\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/g,
    )) {
      if (match[1].endsWith(`.${member.receiver}`)) {
        candidates.add(match[1]);
      }
    }
    for (const match of runtime.code.matchAll(
      /\bimport\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.\*\s*;/g,
    )) {
      candidates.add(`${match[1]}.${member.receiver}`);
    }
    if (candidates.size === 1) receiver = [...candidates][0];
  }
  if (!receiver) return null;

  const workspaceMembers = member.kind === "method"
    ? runtime?.staticMethods
    : runtime?.staticFields;
  const workspaceTypes = workspaceMembers?.get(
    `${receiver}.${member.name}`,
  ) ?? [];
  const resolvedWorkspaceTypes = new Set(
    workspaceTypes
      .map(({ type, context }) =>
        resolveJavaTypeIdentity(runtime, type, context)
      )
      .filter(Boolean),
  );
  if (resolvedWorkspaceTypes.size === 1) {
    return [...resolvedWorkspaceTypes][0];
  }
  if (runtime?.localQualifiedTypes.has(receiver)) return null;
  if (!receiver.startsWith("java.")) return null;

  const jdkMembers = loadJdkStaticMemberTypes(receiver);
  const jdkTypes = member.kind === "method"
    ? jdkMembers?.methods.get(member.name)
    : jdkMembers?.fields.get(member.name);
  return jdkTypes?.size === 1 ? [...jdkTypes][0] : null;
}

function loadJdkTypeHierarchy(runtime, type) {
  const normalized = resolveJavaTypeIdentity(runtime, type);
  if (
    !normalized ||
    normalized.endsWith("[]") ||
    !normalized.startsWith("java.")
  ) {
    return;
  }
  const qualified = normalized;
  if (!jdkHierarchyCache.has(qualified)) {
    const result = spawnSync("javap", ["-public", qualified], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (result.status !== 0) {
      jdkHierarchyCache.set(qualified, null);
    } else {
      const declaration =
        /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:<[^{}]*>)?\s*([\s\S]*?)\{/.exec(
          result.stdout,
        );
      if (!declaration) {
        jdkHierarchyCache.set(qualified, null);
      } else {
        const parents = [];
        for (const section of declaration[2].matchAll(
          /\b(?:extends|implements)\s+([\s\S]*?)(?=\bextends\b|\bimplements\b|$)/g,
        )) {
          for (const parent of splitTopLevel(section[1])) {
            const raw = parent
              .replace(/<[\s\S]*>/g, "")
              .replace(/^\?extends/, "")
              .trim();
            if (!raw) continue;
            const parentQualified = raw.replace(/\s+/g, "");
            parents.push(parentQualified);
          }
        }
        jdkHierarchyCache.set(qualified, parents);
      }
    }
  }
  const parents = jdkHierarchyCache.get(qualified);
  if (!parents) return;
  const hierarchy = runtime.typeHierarchy;
  if (!hierarchy.has(normalized)) hierarchy.set(normalized, new Set());
  for (const parent of parents) {
    const identity = resolveJavaTypeIdentity(runtime, parent);
    if (identity) hierarchy.get(normalized).add(identity);
  }
}

function javaTypeHierarchy(runtime) {
  if (runtime.typeHierarchy) return runtime.typeHierarchy;
  const hierarchy = new Map(
    [...knownJavaSupertypes].map(([name, parents]) => [
      `java.lang.${name}`,
      new Set(
        [...parents].map((parent) =>
          ["Serializable"].includes(parent)
            ? `java.io.${parent}`
            : `java.lang.${parent}`
        ),
      ),
    ]),
  );
  runtime.typeHierarchy = hierarchy;
  for (const declaration of runtime.typeDeclarations?.values() ?? []) {
    const { kind, qualified, header, context } = declaration;
    if (!hierarchy.has(qualified)) hierarchy.set(qualified, new Set());
    const parents = hierarchy.get(qualified);
    const extendsMatch = /\bextends\s+([\s\S]*?)(?=\bimplements\b|$)/.exec(
      header,
    );
    if (extendsMatch) {
      for (const parent of splitTopLevel(extendsMatch[1])) {
        const normalized = resolveJavaTypeIdentity(runtime, parent, context);
        if (normalized) parents.add(normalized);
      }
    }
    const implementsMatch = /\bimplements\s+([\s\S]*)$/.exec(header);
    if (implementsMatch) {
      for (const parent of splitTopLevel(implementsMatch[1])) {
        const normalized = resolveJavaTypeIdentity(runtime, parent, context);
        if (normalized) parents.add(normalized);
      }
    }
    if (kind !== "interface" && qualified !== "java.lang.Object") {
      parents.add("java.lang.Object");
    }
  }
  return hierarchy;
}

function referenceTypeDistance(runtime, argumentType, parameterType) {
  const argument = resolveJavaTypeIdentity(runtime, argumentType);
  const parameter = resolveJavaTypeIdentity(runtime, parameterType);
  if (!argument || !parameter) return Number.POSITIVE_INFINITY;
  if (argument === parameter) return 0;
  if (argument.endsWith("[]")) {
    return [
      "java.lang.Object",
      "java.lang.Cloneable",
      "java.io.Serializable",
    ].includes(parameter)
      ? 1
      : Number.POSITIVE_INFINITY;
  }
  if (parameter === "java.lang.Object") return 1;
  const hierarchy = javaTypeHierarchy(runtime);
  const queue = [{ type: argument, distance: 0 }];
  const seen = new Set([argument]);
  while (queue.length > 0) {
    const current = queue.shift();
    loadJdkTypeHierarchy(runtime, current.type);
    for (const parent of hierarchy.get(current.type) ?? []) {
      if (parent === parameter) return current.distance + 1;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push({ type: parent, distance: current.distance + 1 });
      }
    }
  }
  return Number.POSITIVE_INFINITY;
}

function maskStaticBranches(source) {
  let result = source;
  for (let pass = 0; pass < 64; pass += 1) {
    const structural = maskJava(result, false);
    let selected = null;
    for (const match of structural.matchAll(/\bif\s*\(/g)) {
      const conditional = conditionalAt(structural, match.index);
      const condition = conditional
        ? staticJavaBoolean(conditional.condition)
        : null;
      if (conditional && condition !== null) {
        selected = { index: match.index, staticCondition: condition, ...conditional };
        break;
      }
    }
    if (!selected) return result;
    const branch = selected.staticCondition
      ? statementBody(result, selected.consequentStart, selected.consequentEnd)
      : statementBody(result, selected.alternateStart, selected.alternateEnd);
    result = `${result.slice(0, selected.index)}${branch}${result.slice(selected.end)}`;
  }
  return result;
}

function xmlLocalName(name) {
  return name.split(":").at(-1);
}

function parseXmlDocument(source) {
  const root = { name: "#document", children: [], text: "" };
  const stack = [root];
  const tokens = source.match(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?[^>]+>|[^<]+/g,
  );
  if (!tokens || tokens.join("") !== source) return null;
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) {
      stack.at(-1).text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("<!")) return null;
    if (!token.startsWith("<")) {
      stack.at(-1).text += token;
      continue;
    }
    if (token.startsWith("</")) {
      const name = xmlLocalName(
        /^<\/\s*([A-Za-z_][\w.:-]*)\s*>$/.exec(token)?.[1] ?? "",
      );
      if (!name || stack.length === 1 || stack.at(-1).name !== name) {
        return null;
      }
      stack.pop();
      continue;
    }
    const opening = /^<\s*([A-Za-z_][\w.:-]*)(?:\s+[^<>]*?)?\s*(\/?)>$/.exec(
      token,
    );
    if (!opening) return null;
    const node = {
      name: xmlLocalName(opening[1]),
      children: [],
      text: "",
    };
    stack.at(-1).children.push(node);
    if (!opening[2]) stack.push(node);
  }
  if (stack.length !== 1) return null;
  const nonWhitespace = root.text.trim();
  return nonWhitespace || root.children.length !== 1 ? null : root.children[0];
}

function childNodes(node, name) {
  return node.children.filter((child) => child.name === name);
}

function singleChildText(node, name, { required = false } = {}) {
  const children = childNodes(node, name);
  if (children.length > 1 || required && children.length !== 1) return null;
  if (children.length === 0) return "";
  if (children[0].children.length > 0) return null;
  return children[0].text.trim();
}

function compareJavaVersions(left, right) {
  const parts = (value) => value
    .split(/[._-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isNaN(part) ? 0 : part);
  const leftParts = parts(left);
  const rightParts = parts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function jdkActivationMatchesJava17(declaration) {
  const value = declaration.trim();
  const current = "17.0.0";
  const range = /^([\[(])\s*([^,]*)\s*,\s*([^)\]]*)\s*([)\]])$/.exec(
    value,
  );
  if (range) {
    const lower = range[2];
    const upper = range[3];
    const aboveLower =
      !lower ||
      compareJavaVersions(current, lower) > 0 ||
      range[1] === "[" && compareJavaVersions(current, lower) === 0;
    const belowUpper =
      !upper ||
      compareJavaVersions(current, upper) < 0 ||
      range[4] === "]" && compareJavaVersions(current, upper) === 0;
    return aboveLower && belowUpper;
  }
  const exact = /^\[\s*([^\]]+)\s*\]$/.exec(value);
  if (exact) return compareJavaVersions(current, exact[1]) === 0;
  if (value.startsWith("!")) {
    return !current.startsWith(value.slice(1).trim());
  }
  return Boolean(value) && current.startsWith(value);
}

function mavenProfileIsActive(profile) {
  const activationBlocks = childNodes(profile, "activation");
  if (activationBlocks.length > 1) return null;
  if (activationBlocks.length === 0) {
    return { active: false, activeByDefault: false };
  }
  const activation = activationBlocks[0];
  const predicates = [];
  const activeByDefault = singleChildText(activation, "activeByDefault");
  const jdk = singleChildText(activation, "jdk");
  if (activeByDefault === null || jdk === null) return null;
  let defaultActivation = false;
  if (activeByDefault) {
    const normalized = activeByDefault.toLowerCase();
    if (!["true", "false"].includes(normalized)) return null;
    defaultActivation = normalized === "true";
  }
  const conditionalActivation = Boolean(jdk) ||
    ["property", "os", "file"].some((name) =>
      childNodes(activation, name).length > 0
    );
  if (jdk) predicates.push(jdkActivationMatchesJava17(jdk));
  if (["property", "os", "file"].some((name) =>
    childNodes(activation, name).length > 0
  )) {
    predicates.push(false);
  }
  return {
    active: conditionalActivation
      ? predicates.length > 0 && predicates.every(Boolean)
      : defaultActivation,
    activeByDefault: defaultActivation && !conditionalActivation,
  };
}

function mavenModel(build) {
  const project = parseXmlDocument(build);
  if (!project || project.name !== "project") return null;
  const packaging = singleChildText(project, "packaging");
  if (packaging === null || !["", "jar", "war", "ear"].includes(packaging)) {
    return null;
  }

  const profileBlocks = childNodes(project, "profiles");
  if (profileBlocks.length > 1) return null;
  const defaultProfiles = [];
  const conditionallyActiveProfiles = [];
  for (const profile of profileBlocks[0]?.children ?? []) {
    if (profile.name !== "profile") continue;
    const activation = mavenProfileIsActive(profile);
    if (activation === null) return null;
    if (!activation.active) continue;
    if (activation.activeByDefault) defaultProfiles.push(profile);
    else conditionallyActiveProfiles.push(profile);
  }
  const activeProfiles = conditionallyActiveProfiles.length > 0
    ? conditionallyActiveProfiles
    : defaultProfiles;
  const effectiveParents = [project, ...activeProfiles];
  const properties = new Map();
  for (const parent of effectiveParents) {
    const propertyBlocks = childNodes(parent, "properties");
    if (propertyBlocks.length > 1) return null;
    for (const property of propertyBlocks[0]?.children ?? []) {
      if (property.children.length > 0) return null;
      if (!properties.has(property.name)) properties.set(property.name, new Set());
      properties.get(property.name).add(property.text.trim());
    }
  }
  const resolve = (value, seen = new Set()) => {
    const name = /^\$\{([^}]+)\}$/.exec(value)?.[1];
    if (!name) return value;
    if (
      seen.has(name) ||
      !properties.has(name) ||
      properties.get(name).size !== 1
    ) {
      return null;
    }
    return resolve(
      [...properties.get(name)][0],
      new Set(seen).add(name),
    );
  };
  const dependency = (node) => {
    const group = singleChildText(node, "groupId", { required: true });
    const artifact = singleChildText(node, "artifactId", { required: true });
    const version = singleChildText(node, "version");
    const scope = singleChildText(node, "scope");
    const resolvedVersion = resolve(version);
    const resolvedScope = resolve(scope);
    if (
      [group, artifact, version, scope, resolvedVersion, resolvedScope].includes(
        null,
      )
    ) {
      return null;
    }
    return {
      group,
      artifact,
      version: resolvedVersion,
      scope: resolvedScope || "compile",
    };
  };
  const dependencyList = (parent) => {
    const blocks = childNodes(parent, "dependencies");
    if (blocks.length > 1) return null;
    const values = [];
    for (const node of blocks[0]?.children ?? []) {
      if (node.name !== "dependency") continue;
      const value = dependency(node);
      if (!value) return null;
      values.push(value);
    }
    return values;
  };

  const dependencies = [];
  const managed = [];
  for (const parent of effectiveParents) {
    const parentDependencies = dependencyList(parent);
    if (!parentDependencies) return null;
    dependencies.push(...parentDependencies);
    const managementBlocks = childNodes(parent, "dependencyManagement");
    if (managementBlocks.length > 1) return null;
    if (managementBlocks.length === 1) {
      const parentManaged = dependencyList(managementBlocks[0]);
      if (!parentManaged) return null;
      managed.push(...parentManaged);
    }
  }
  const propertyValue = (name) => {
    const values = properties.get(name);
    if (!values) return "";
    if (values.size !== 1) return null;
    return [...values][0];
  };
  const release = resolve(propertyValue("maven.compiler.release"));
  const source = resolve(propertyValue("maven.compiler.source"));
  const target = resolve(propertyValue("maven.compiler.target"));
  if ([release, source, target].includes(null)) return null;
  return { dependencies, managed, release, source, target };
}

function hasPinnedMavenManifest(build) {
  const model = mavenModel(build);
  if (!model) return false;
  const java17 =
    model.release === "17" ||
    model.source === "17" && model.target === "17";
  if (!java17) return false;

  const managedByCoordinate = new Map();
  for (const dependency of model.managed) {
    const key = `${dependency.group}:${dependency.artifact}`;
    if (managedByCoordinate.has(key)) return false;
    managedByCoordinate.set(key, dependency);
  }
  const active = model.dependencies.filter(({ scope }) =>
    ["compile", "runtime"].includes(scope)
  );
  for (const [group, artifact, version] of PINS) {
    const matches = active.filter((dependency) =>
      dependency.group === group && dependency.artifact === artifact
    );
    if (matches.length !== 1) return false;
    const managed = managedByCoordinate.get(`${group}:${artifact}`);
    if (
      matches[0].version &&
      matches[0].version !== version
    ) {
      return false;
    }
    if (managed && managed.version !== version) return false;
    const effectiveVersion = matches[0].version || managed?.version || "";
    if (effectiveVersion !== version) return false;
  }
  return true;
}

function classRanges(code) {
  const classes = [];
  for (const match of code.matchAll(
    /\b(class|interface|record|enum)\s+([A-Za-z_$][\w$]*)[^{]*\{/g,
  )) {
    const open = code.indexOf("{", match.index);
    const close = matchingIndex(code, open, "{", "}");
    if (close >= 0) {
      classes.push({
        kind: match[1],
        name: match[2],
        start: match.index,
        end: close + 1,
      });
    }
  }
  const qualify = (owner) => {
    if (owner.qualifiedName) return owner.qualifiedName;
    const parent = classes
      .filter(
        (candidate) =>
          candidate !== owner &&
          candidate.start < owner.start &&
          owner.end < candidate.end,
      )
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      )[0];
    owner.qualifiedName = parent
      ? `${qualify(parent)}.${owner.name}`
      : owner.name;
    return owner.qualifiedName;
  };
  for (const owner of classes) qualify(owner);
  return classes;
}

function parseMethods(code, literalSource) {
  const methods = [];
  const classes = classRanges(code);
  const ownerAt = (position) =>
    classes
      .filter(({ start, end }) => start <= position && position < end)
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      )[0] ?? null;
  const pattern =
    /(?:^|[;{}])\s*((?:(?:public|protected|private|static|final|synchronized|native|abstract|strictfp)\s+)*)(?:<[^;{}()]+>\s*)?((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*(?:\s*<[^;{}()]+>)?(?:\s*\[\s*\])?)\s+([A-Za-z_$][\w$]*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^{}]+)?\{/gm;
  for (const match of code.matchAll(pattern)) {
    if (["if", "for", "while", "switch", "catch", "try", "new"].includes(match[3])) {
      continue;
    }
    const open = code.indexOf("{", match.index + match[0].lastIndexOf("{"));
    const close = matchingIndex(code, open, "{", "}");
    if (close < 0) continue;
    const owner = ownerAt(match.index);
    methods.push({
      id: methods.length,
      className: owner?.name ?? "",
      classQualifiedName: owner?.qualifiedName ?? "",
      modifiers: new Set(match[1].trim().split(/\s+/).filter(Boolean)),
      returnType: match[2].replace(/\s+/g, ""),
      name: match[3],
      parameters: match[4],
      parameterNames: parameterNames(match[4]),
      parameterTypes: parameterTypes(match[4]),
      parameterTypeReferences: parameterTypeReferences(match[4]),
      start: match.index,
      bodyStart: open + 1,
      bodyEnd: close,
      end: close + 1,
      code: code.slice(open + 1, close),
      literal: literalSource.slice(open + 1, close),
    });
  }
  for (const owner of classes) {
    const constructor = new RegExp(
      `\\b(?:(?:public|protected|private)\\s+)?${escapeRegExp(owner.name)}\\s*\\(([^;{}]*)\\)\\s*\\{`,
      "g",
    );
    for (const match of code.matchAll(constructor)) {
      const open = code.indexOf("{", match.index);
      const close = matchingIndex(code, open, "{", "}");
      if (
        close < 0 ||
        methods.some((method) =>
          (method.classQualifiedName || method.className) ===
            owner.qualifiedName &&
          method.name === owner.name &&
          method.parameters.replace(/\s+/g, "") === match[1].replace(/\s+/g, "")
        )
      ) {
        continue;
      }
      methods.push({
        id: methods.length,
        className: owner.name,
        classQualifiedName: owner.qualifiedName,
        modifiers: new Set(),
        returnType: owner.name,
        name: owner.name,
        parameters: match[1],
        parameterNames: parameterNames(match[1]),
        parameterTypes: parameterTypes(match[1]),
        parameterTypeReferences: parameterTypeReferences(match[1]),
        start: match.index,
        bodyStart: open + 1,
        bodyEnd: close,
        end: close + 1,
        code: code.slice(open + 1, close),
        literal: literalSource.slice(open + 1, close),
      });
    }
  }
  methods.sort((left, right) => left.start - right.start);
  methods.forEach((method, index) => {
    method.id = index;
  });
  return methods;
}

function parsedMethodOwnerAt(methods, position) {
  return methods
    .filter(({ bodyStart, bodyEnd }) =>
      bodyStart <= position && position < bodyEnd
    )
    .sort(
      (left, right) =>
        left.bodyEnd - left.bodyStart - (right.bodyEnd - right.bodyStart),
    )[0] ?? null;
}

function isExecutableMain(method) {
  if (
    method.name !== "main" ||
    method.returnType !== "void" ||
    !method.modifiers.has("public") ||
    !method.modifiers.has("static")
  ) {
    return false;
  }
  const parameters = splitTopLevel(method.parameters);
  if (parameters.length !== 1) return false;
  const parameter = parameters[0]
    .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, "")
    .replace(/\bfinal\b/g, "")
    .replace(/\s+/g, "");
  return /^(?:java\.lang\.)?String(?:\[\][A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*\[\]|\.\.\.[A-Za-z_$][\w$]*)$/.test(
    parameter,
  );
}

function calledMethodNames(text, methodNames, classNames) {
  const code = maskJava(text, false);
  const calls = new Set();
  for (const name of methodNames) {
    const pattern = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\(`);
    const member = new RegExp(`\\.\\s*${escapeRegExp(name)}\\s*\\(`);
    if (pattern.test(code) || member.test(code)) calls.add(name);
  }
  for (const name of classNames) {
    if (new RegExp(`\\bnew\\s+${escapeRegExp(name)}\\s*\\(`).test(code)) {
      calls.add(name);
    }
  }
  return calls;
}

function workspaceResources(workspace) {
  const resources = new Map();
  const entries = Array.isArray(workspace.resources)
    ? workspace.resources.map((resource) => [
        resource.path ?? resource.name ?? "",
        resource.content ?? resource.source ?? "",
      ])
    : Object.entries(workspace.resources ?? {});
  for (const [rawPath, content] of entries) {
    if (typeof content !== "string") continue;
    const path = String(rawPath).replaceAll("\\", "/").replace(/^\.?\//, "");
    const aliases = new Set([
      path,
      `/${path}`,
      path.replace(/^src\/main\/resources\//, ""),
      `/${path.replace(/^src\/main\/resources\//, "")}`,
      path.split("/").at(-1),
    ]);
    for (const alias of aliases) {
      if (alias) resources.set(alias, content);
    }
  }
  return resources;
}

function workspaceSourceDocuments(workspace) {
  const documents = Array.isArray(workspace.sourceDocuments)
    ? workspace.sourceDocuments
      .map((document) => ({
        path: document.path ?? document.name ?? "",
        source: document.source ?? document.content ?? "",
      }))
      .filter(({ source }) => typeof source === "string")
    : [{ path: "", source: workspace.source ?? "" }];
  const split = [];
  for (const document of documents) {
    const code = maskJava(document.source, false);
    const packages = Array.from(
      code.matchAll(
        /\bpackage\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*;/g,
      ),
    );
    if (packages.length <= 1) {
      split.push(document);
      continue;
    }
    for (let index = 0; index < packages.length; index += 1) {
      const start = packages[index].index;
      const end = packages[index + 1]?.index ?? document.source.length;
      split.push({
        path: `${document.path}#${index + 1}`,
        source: document.source.slice(start, end),
      });
    }
  }
  return split;
}

function declaredWorkspaceTypes(workspace) {
  const qualified = new Set();
  const simple = new Set();
  const declarations = new Map();
  const candidates = new Map();
  const staticFields = new Map();
  const staticMethods = new Map();
  for (const document of workspaceSourceDocuments(workspace)) {
    const code = maskJava(document.source, false);
    const literal = maskJava(document.source, true);
    const context = javaSourceTypeContext(document.source);
    const packageName = context.packageName;
    const classes = classRanges(code);
    for (const match of code.matchAll(
      /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)(?:\s*<[^{};]+>)?\s*([^{};]*)\{/g,
    )) {
      const name = match[2];
      const owner = classes.find(
        (candidate) =>
          candidate.start === match.index && candidate.name === name,
      );
      const ownerName = owner?.qualifiedName ?? name;
      const identity = packageName ? `${packageName}.${ownerName}` : ownerName;
      const declarationContext = {
        ...context,
        enclosingType: identity,
      };
      simple.add(name);
      qualified.add(identity);
      declarations.set(identity, {
        kind: match[1],
        name,
        qualified: identity,
        header: match[3],
        context: declarationContext,
      });
      if (!candidates.has(name)) candidates.set(name, new Set());
      candidates.get(name).add(identity);
    }
    for (const method of parseMethods(code, literal)) {
      if (!method.className || !method.modifiers.has("static")) continue;
      const ownerName = method.classQualifiedName || method.className;
      const owner = packageName
        ? `${packageName}.${ownerName}`
        : ownerName;
      addStaticMemberType(
        staticMethods,
        `${owner}.${method.name}`,
        method.returnType,
        { ...context, enclosingType: owner },
      );
    }
    const fieldSource = [...document.source];
    for (const method of parseMethods(code, literal)) {
      for (let index = method.start; index < method.end; index += 1) {
        if (
          fieldSource[index] !== "\n" &&
          fieldSource[index] !== ";"
        ) {
          fieldSource[index] = " ";
        }
      }
    }
    const fieldLiteral = fieldSource.join("");
    const ownerAt = (position) =>
      classes
        .filter(({ start, end }) => start <= position && position < end)
        .sort(
          (left, right) =>
            left.end - left.start - (right.end - right.start),
        )[0]?.qualifiedName ?? "";
    for (const field of javaVariableDeclarations(fieldLiteral)) {
      const ownerName = ownerAt(field.position);
      if (!field.static || !ownerName) continue;
      const owner = packageName ? `${packageName}.${ownerName}` : ownerName;
      addStaticMemberType(
        staticFields,
        `${owner}.${field.name}`,
        field.typeReference,
        { ...context, enclosingType: owner },
      );
    }
  }
  return {
    qualified,
    simple,
    declarations,
    candidates,
    staticFields,
    staticMethods,
  };
}

function runtimeFor(workspace) {
  const source = workspace.source ?? "";
  const workspaceCode = workspaceSourceDocuments(workspace)
    .map((document) => document.source)
    .join("\n");
  const withoutInactive = maskStaticBranches(source);
  const literal = maskJava(withoutInactive, true);
  const code = maskJava(withoutInactive, false);
  const methods = parseMethods(code, literal);
  const sourceTypeContext = javaSourceTypeContext(source);
  for (const method of methods) {
    const enclosingType = method.classQualifiedName
      ? sourceTypeContext.packageName
        ? `${sourceTypeContext.packageName}.${method.classQualifiedName}`
        : method.classQualifiedName
      : "";
    method.typeContext = {
      ...sourceTypeContext,
      enclosingType,
    };
  }
  const methodNames = new Set(methods.map(({ name }) => name));
  const classNames = new Set(methods.map(({ className }) => className).filter(Boolean));
  const byName = new Map();
  for (const method of methods) {
    if (!byName.has(method.name)) byName.set(method.name, []);
    byName.get(method.name).push(method);
  }
  const reachable = new Set(
    methods.filter(isExecutableMain).map(({ id }) => id),
  );
  const declaredTypes = declaredWorkspaceTypes(workspace);
  const runtime = {
    source,
    workspaceCode,
    code,
    literal,
    methods,
    reachable,
    methodNames,
    classNames,
    byName,
    resources: workspaceResources(workspace),
    localQualifiedTypes: declaredTypes.qualified,
    localSimpleTypes: declaredTypes.simple,
    typeDeclarations: declaredTypes.declarations,
    typeCandidates: declaredTypes.candidates,
    staticFields: declaredTypes.staticFields,
    staticMethods: declaredTypes.staticMethods,
    sourceTypeContext,
  };
  const queue = methods.filter(({ id }) => reachable.has(id));
  while (queue.length > 0) {
    const method = queue.shift();
    const nestedMethods = parseMethods(method.code, method.literal);
    for (const call of methodCalls(method.literal)) {
      if (parsedMethodOwnerAt(nestedMethods, call.position)) continue;
      for (const target of methodCallTargets(runtime, method, call)) {
        if (!reachable.has(target.id)) {
          reachable.add(target.id);
          queue.push(target);
        }
      }
    }
    for (const functional of functionalExecutionAnalysis(method.literal).functions) {
      if (parsedMethodOwnerAt(nestedMethods, functional.position)) continue;
      if (!functional.executed || !functional.reference) continue;
      const receiver = functional.reference.receiver;
      const targets = (runtime.byName.get(functional.reference.method) ?? [])
        .filter((target) =>
          receiver === "this"
            ? target.className === method.className
            : !runtime.classNames.has(receiver) ||
              target.className === receiver
        );
      for (const target of targets) {
        if (!reachable.has(target.id)) {
          reachable.add(target.id);
          queue.push(target);
        }
      }
    }
  }
  runtime.consumedReactorCallbacks = analyzeReactorConsumption(runtime);
  return runtime;
}

function hasOfficialType(runtime, name) {
  const packageName = SDK_TYPES[name];
  const code = runtime.code;
  if (
    runtime.localQualifiedTypes.has(`${packageName}.${name}`) ||
    runtime.localSimpleTypes.has(name)
  ) {
    return false;
  }
  const conflicting = new RegExp(
    `\\bimport\\s+(?!${escapeRegExp(packageName)}\\.${escapeRegExp(name)}\\s*;)[\\w.]+\\.${escapeRegExp(name)}\\s*;`,
  ).test(code);
  if (conflicting) return false;
  const qualified = new RegExp(
    `\\b${escapeRegExp(packageName)}\\.${escapeRegExp(name)}\\b`,
  ).test(code);
  return qualified || new RegExp(
    `\\bimport\\s+${escapeRegExp(packageName)}\\.${escapeRegExp(name)}\\s*;`,
  ).test(code) || new RegExp(
    `\\bimport\\s+${escapeRegExp(packageName)}\\.\\*\\s*;`,
  ).test(code);
}

function hasLocalOfficialSdkDefinition(runtime) {
  return Object.entries(SDK_TYPES).some(([name, packageName]) =>
    runtime.localQualifiedTypes.has(`${packageName}.${name}`)
  );
}

function methodIsAsync(method) {
  return (
    /Async/.test(method.className) ||
    /(?:Mono|Flux|CompletableFuture)/.test(method.returnType)
  );
}

function reachableMethods(runtime, async = null) {
  return runtime.methods.filter((method) => {
    if (!runtime.reachable.has(method.id)) return false;
    if (async === null) return true;
    return methodIsAsync(method) === async;
  });
}

function reachableText(runtime, async = null, literal = true) {
  return reachableMethods(runtime, async)
    .map((method) => literal ? method.literal : method.code)
    .join("\n");
}

function pathVariants(source, limit = 32) {
  const variants = [];
  const visit = (value) => {
    if (variants.length >= limit) return;
    const structural = maskJava(value, false);
    let match;
    for (const candidate of structural.matchAll(/\bif\s*\(/g)) {
      const conditional = conditionalAt(structural, candidate.index);
      if (!conditional) continue;
      match = { candidate, ...conditional };
      break;
    }
    if (!match) {
      variants.push(value);
      return;
    }
    const before = value.slice(0, match.candidate.index);
    const after = value.slice(match.end);
    const consequent = statementBody(
      value,
      match.consequentStart,
      match.consequentEnd,
    );
    const alternate = statementBody(
      value,
      match.alternateStart,
      match.alternateEnd,
    );
    const condition = staticJavaBoolean(match.condition);
    if (condition !== false) visit(`${before}${consequent}${after}`);
    if (condition !== true) visit(`${before}${alternate}${after}`);
  };
  visit(source);
  return variants;
}

function closureVariants(runtime, root, seen = new Set(), limit = 48) {
  if (seen.has(root.id) || seen.size > 12) return [""];
  const nextSeen = new Set(seen).add(root.id);
  const variants = [];
  for (const own of pathVariants(executableMethodText(runtime, root), limit)) {
    let combined = [own];
    for (const call of methodCalls(own)) {
      const targets = methodCallTargets(runtime, root, call)
        .filter(({ id }) => runtime.reachable.has(id) && !nextSeen.has(id));
      for (const target of targets) {
        const additions = closureVariants(runtime, target, nextSeen, limit);
        const expanded = [];
        for (const current of combined) {
          for (const addition of additions) {
            expanded.push(`${current}\n${addition}`);
            if (expanded.length >= limit) break;
          }
          if (expanded.length >= limit) break;
        }
        combined = expanded.length > 0 ? expanded : combined;
      }
    }
    variants.push(...combined);
    if (variants.length >= limit) break;
  }
  return variants.slice(0, limit);
}

function anyConnectedVariant(runtime, async, predicate) {
  return reachableMethods(runtime, async)
    .filter(({ name }) => name !== "main")
    .some((method) =>
      closureVariants(runtime, method).some((text) => predicate(text, method))
    );
}

function hasForbiddenAuthentication(runtime) {
  return (
    /\.\s*connectionString\s*\(/.test(runtime.code) ||
    /\b(?:StorageSharedKeyCredential|AzureNamedKeyCredential|AzureKeyCredential|AzureSasCredential)\b/.test(
      runtime.code,
    ) ||
    /\.\s*(?:sasToken|credential)\s*\(\s*["']/.test(runtime.literal) ||
    /\.\s*credential\s*\(\s*(?:\([^)]*TokenCredential[^)]*\)\s*)?null\s*\)/.test(
      runtime.code,
    ) ||
    /\b(?:accountKey|accessKey|sasToken)\b/i.test(runtime.code)
  );
}

function emptyFlow() {
  return {
    strings: new Set(),
    environments: new Set(),
    credentialBuilders: new Set(),
    credential: false,
    kinds: new Set(),
  };
}

function copyFlow(value) {
  return {
    strings: new Set(value?.strings ?? []),
    environments: new Set(value?.environments ?? []),
    credentialBuilders: new Set(value?.credentialBuilders ?? []),
    credential: Boolean(value?.credential),
    kinds: new Set(value?.kinds ?? []),
  };
}

function mergeFlow(left, right) {
  return {
    strings: new Set([
      ...(left?.strings ?? []),
      ...(right?.strings ?? []),
    ]),
    environments: new Set([
      ...(left?.environments ?? []),
      ...(right?.environments ?? []),
    ]),
    credentialBuilders: new Set([
      ...(left?.credentialBuilders ?? []),
      ...(right?.credentialBuilders ?? []),
    ]),
    credential: Boolean(left?.credential || right?.credential),
    kinds: new Set([
      ...(left?.kinds ?? []),
      ...(right?.kinds ?? []),
    ]),
  };
}

function unknownFlow() {
  const value = emptyFlow();
  value.kinds.add("unknown");
  return value;
}

function secureCredentialFlow(value) {
  return Boolean(
    value?.credential &&
    value.kinds?.size === 1 &&
    value.kinds.has("credential"),
  );
}

function secureEndpointFlow(value, environment) {
  return Boolean(
    value?.kinds?.size === 1 &&
    value.kinds.has("environment") &&
    value.environments?.size === 1 &&
    value.environments.has(environment),
  );
}

function flowAssignments(method, endPosition = Number.POSITIVE_INFINITY) {
  return javaVariableDeclarations(method.literal)
    .filter(({ initialized, position }) =>
      initialized && position < endPosition
    )
    .map(({ position, expressionPosition, end, name, expression }) => ({
      position,
      expressionPosition,
      end,
      name,
      expression,
    }));
}

function simpleAssignmentExpressions(text, includeThis = false) {
  const structural = maskJava(text, false);
  const assignments = [];
  const target = includeThis
    ? /(?:this\s*\.\s*)?[A-Za-z_$][\w$]*/
    : /[A-Za-z_$][\w$]*/;
  const pattern = new RegExp(`\\b(${target.source})\\s*=(?!=)`, "g");
  for (const match of structural.matchAll(pattern)) {
    const equals = structural.indexOf("=", match.index + match[1].length);
    let previous = equals - 1;
    while (previous >= 0 && /\s/.test(structural[previous])) previous -= 1;
    if (/[=!<>]/.test(structural[previous] ?? "")) continue;
    let end = equals + 1;
    const depth = { "(": 0, "[": 0, "{": 0 };
    const closing = { ")": "(", "]": "[", "}": "{" };
    for (; end < structural.length; end += 1) {
      const character = structural[end];
      if (character in depth) {
        depth[character] += 1;
      } else if (character in closing) {
        const opening = closing[character];
        if (
          depth[opening] === 0 &&
          Object.values(depth).every((value) => value === 0)
        ) {
          break;
        }
        depth[opening] -= 1;
      } else if (
        (character === ";" || character === ",") &&
        Object.values(depth).every((value) => value === 0)
      ) {
        break;
      }
    }
    const expressionStart = equals + 1;
    const rawExpression = text.slice(expressionStart, end);
    const expressionLeading = Math.max(0, rawExpression.search(/\S/));
    assignments.push({
      position: match.index,
      expressionPosition: expressionStart + expressionLeading,
      end,
      target: match[1].replace(/\s+/g, ""),
      name: match[1].replace(/^this\s*\.\s*/, "").replace(/\s+/g, ""),
      expression: rawExpression.trim(),
    });
  }
  return assignments;
}

function flowAssignmentEvents(method, endPosition = Number.POSITIVE_INFINITY) {
  const declarations = flowAssignments(method, endPosition).map(
    (assignment) => ({
      ...assignment,
      declaration: true,
      ...assignmentControl(method, assignment.position),
    }),
  );
  const structural = maskJava(method.literal, false);
  const reassignments = simpleAssignmentExpressions(method.literal)
    .map((assignment) => ({
      ...assignment,
      declaration: false,
      ...assignmentControl(method, assignment.position),
    }))
    .filter(({ position }) =>
    position < endPosition &&
    !declarations.some(
      ({ position: start, end }) => start <= position && position < end,
    )
  );
  const compoundAssignments = Array.from(
    structural.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*(?:>>>=|<<=|>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=)[^;]*;/g,
    ),
    (match) => ({
      position: match.index + match[0].indexOf(match[1]),
      end: match.index + match[0].length,
      name: match[1],
      expression: "",
      declaration: false,
      ...assignmentControl(method, match.index),
    }),
  );
  const increments = Array.from(
    structural.matchAll(
      /(?:\b([A-Za-z_$][\w$]*)\s*(?:\+\+|--)|(?:\+\+|--)\s*\b([A-Za-z_$][\w$]*))/g,
    ),
    (match) => ({
      position: match.index,
      end: match.index + match[0].length,
      name: match[1] ?? match[2],
      expression: "",
      declaration: false,
      ...assignmentControl(method, match.index),
    }),
  );
  return [
    ...declarations,
    ...reassignments,
    ...compoundAssignments,
    ...increments,
  ]
    .filter(({ reachable }) => reachable)
    .sort((left, right) => left.position - right.position);
}

function flowExpression(
  runtime,
  method,
  expression,
  environment,
  seen = new Set(),
) {
  let value = unwrapParentheses(expression);
  while (/^\(\s*[A-Za-z_$][\w$.<>,? ]*\s*\)\s*/.test(value)) {
    value = value.replace(
      /^\(\s*[A-Za-z_$][\w$.<>,? ]*\s*\)\s*/,
      "",
    ).trim();
  }
  const directString = javaStringValue(value);
  if (directString !== null) {
    return {
      strings: new Set([directString]),
      environments: new Set(),
      credentialBuilders: new Set(),
      credential: false,
      kinds: new Set(["string"]),
    };
  }
  if (/^null$/.test(value)) return unknownFlow();
  const reference = /^([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) {
    return environment.has(reference)
      ? copyFlow(environment.get(reference))
      : unknownFlow();
  }

  const conditional = splitTopLevelConditional(value);
  if (conditional) {
    const condition = staticJavaBoolean(conditional.condition);
    if (condition === true) {
      return flowExpression(
        runtime,
        method,
        conditional.consequent,
        environment,
        seen,
      );
    }
    if (condition === false) {
      return flowExpression(
        runtime,
        method,
        conditional.alternate,
        environment,
        seen,
      );
    }
    return mergeFlow(
      flowExpression(
        runtime,
        method,
        conditional.consequent,
        environment,
        seen,
      ),
      flowExpression(
        runtime,
        method,
        conditional.alternate,
        environment,
        seen,
      ),
    );
  }

  const getenv =
    /^(?:java\s*\.\s*lang\s*\.\s*)?System\s*\.\s*getenv\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (getenv) {
    const argument = flowExpression(
      runtime,
      method,
      getenv[1],
      environment,
      seen,
    );
    return {
      strings: new Set(),
      environments: new Set(argument.strings),
      credentialBuilders: new Set(),
      credential: false,
      kinds: new Set(["environment"]),
    };
  }

  const requireNonNull =
    /^(?:java\s*\.\s*util\s*\.\s*)?Objects\s*\.\s*requireNonNull\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (requireNonNull) {
    const arguments_ = splitTopLevel(requireNonNull[1]);
    return arguments_.length > 0
      ? flowExpression(runtime, method, arguments_[0], environment, seen)
      : unknownFlow();
  }

  let result = emptyFlow();
  for (const builder of SECURE_CREDENTIAL_BUILDERS) {
    if (
      hasOfficialType(runtime, builder) &&
      new RegExp(`\\bnew\\s+${escapeRegExp(builder)}\\s*\\(`).test(value) &&
      !/\bnull\b/.test(value)
    ) {
      result.credentialBuilders.add(builder);
      result.kinds.add("credential-builder");
      if (
        new RegExp(
          `\\bnew\\s+${escapeRegExp(builder)}\\s*\\([^;]*?\\)\\s*\\.\\s*build\\s*\\(`,
        ).test(value)
      ) {
        result.credential = true;
        result.kinds = new Set(["credential"]);
      }
    }
  }
  const buildCall = callAt(value, "build");
  const builderReference = buildCall
    ? /^([A-Za-z_$][\w$]*)$/.exec(
        unwrapParentheses(buildCall.receiver),
      )?.[1]
    : null;
  if (
    builderReference &&
    (environment.get(builderReference)?.credentialBuilders?.size ?? 0) > 0
  ) {
    result.credential = true;
    result.kinds = new Set(["credential"]);
  }

  const directCall =
    /^(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (directCall) {
    const call = {
      name: directCall[2],
      receiver: directCall[1] ?? null,
      arguments: splitTopLevel(directCall[3]),
    };
    const targets = methodCallTargets(runtime, method, call);
    if (targets.length === 0 && result.kinds.size === 0) {
      return unknownFlow();
    }
    for (const target of targets) {
      if (!runtime.reachable.has(target.id) || seen.has(target.id)) continue;
      const incoming = new Map();
      for (
        let index = 0;
        index < target.parameterNames.length &&
        index < call.arguments.length;
        index += 1
      ) {
        incoming.set(
          target.parameterNames[index],
          flowExpression(
            runtime,
            method,
            call.arguments[index],
            environment,
            seen,
          ),
        );
      }
      result = mergeFlow(
        result,
        methodReturnFlow(
          runtime,
          target,
          incoming,
          new Set(seen).add(method.id),
        ),
      );
    }
  }
  return result.kinds.size > 0 ? result : unknownFlow();
}

function flowEnvironmentAt(runtime, method, incoming, endPosition) {
  const environment = new Map();
  for (const parameter of method.parameterNames) {
    environment.set(parameter, copyFlow(incoming.get(parameter)));
  }
  for (const assignment of flowAssignmentEvents(method, endPosition)) {
    const value = flowExpression(
      runtime,
      method,
      assignment.expression,
      environment,
      new Set([method.id]),
    );
    environment.set(
      assignment.name,
      assignment.conditional
        ? mergeFlow(
            environment.has(assignment.name)
              ? environment.get(assignment.name)
              : unknownFlow(),
            value,
          )
        : value,
    );
  }
  return environment;
}

function methodReturnFlow(runtime, method, incoming, seen = new Set()) {
  if (seen.has(method.id) || seen.size > 16) return emptyFlow();
  const returns = Array.from(
    method.literal.matchAll(/\breturn\s+([^;]+);/g),
  );
  if (returns.length === 0) return emptyFlow();
  const values = returns.map((match) =>
    flowExpression(
      runtime,
      method,
      match[1],
      flowEnvironmentAt(runtime, method, incoming, match.index),
      new Set(seen).add(method.id),
    )
  );
  const strings = new Set(values.flatMap((flow) => [...flow.strings]));
  let environments = new Set(values[0].environments);
  for (const flow of values.slice(1)) {
    environments = new Set(
      [...environments].filter((name) => flow.environments.has(name)),
    );
  }
  return {
    strings,
    environments,
    credentialBuilders: new Set(values.flatMap(
      (flow) => [...flow.credentialBuilders],
    )),
    credential: values.every(({ credential }) => credential),
    kinds: new Set(values.flatMap((flow) => [...flow.kinds])),
  };
}

function propagatedSecureArguments(runtime) {
  const incoming = new Map(
    runtime.methods.map((method) => [method.id, new Map()]),
  );
  for (
    let pass = 0;
    pass < runtime.methods.length + 2;
    pass += 1
  ) {
    let changed = false;
    for (const method of reachableMethods(runtime)) {
      const methodIncoming = incoming.get(method.id);
      for (const call of methodCalls(method.literal)) {
        const environment = flowEnvironmentAt(
          runtime,
          method,
          methodIncoming,
          call.position,
        );
        for (const target of methodCallTargets(runtime, method, call)) {
          if (!runtime.reachable.has(target.id)) continue;
          const targetIncoming = incoming.get(target.id);
          for (
            let index = 0;
            index < target.parameterNames.length &&
            index < call.arguments.length;
            index += 1
          ) {
            const name = target.parameterNames[index];
            const value = flowExpression(
              runtime,
              method,
              call.arguments[index],
              environment,
              new Set([method.id]),
            );
            const merged = mergeFlow(targetIncoming.get(name), value);
            const previous = targetIncoming.get(name) ?? emptyFlow();
            if (
              merged.credential !== previous.credential ||
              merged.strings.size !== previous.strings.size ||
              merged.environments.size !== previous.environments.size ||
              merged.credentialBuilders.size !==
                previous.credentialBuilders.size ||
              merged.kinds.size !== previous.kinds.size
            ) {
              targetIncoming.set(name, merged);
              changed = true;
            }
          }
        }
      }
    }
    if (!changed) break;
  }
  return incoming;
}

function builderStateFromExpression(
  runtime,
  method,
  expression,
  environment,
  builders,
) {
  const code = maskJava(expression, false);
  const type =
    /\bnew\s+(BlobServiceClientBuilder|EventGridPublisherClientBuilder)\s*\(/.exec(
      code,
    )?.[1];
  const reference = /^([A-Za-z_$][\w$]*)/.exec(unwrapParentheses(code))?.[1];
  const base = type
    ? {
        type,
        endpoint: emptyFlow(),
        credential: emptyFlow(),
        valid: true,
      }
    : reference && builders.has(reference)
      ? {
          type: builders.get(reference).type,
          endpoint: copyFlow(builders.get(reference).endpoint),
          credential: copyFlow(builders.get(reference).credential),
          valid: builders.get(reference).valid,
        }
      : null;
  if (!base) return null;
  const endpoint = callAt(expression, "endpoint");
  if (endpoint) {
    base.endpoint = flowExpression(
      runtime,
      method,
      endpoint.arguments[0] ?? "",
      environment,
      new Set([method.id]),
    );
  }
  const credential = callAt(expression, "credential");
  if (credential) {
    base.credential = flowExpression(
      runtime,
      method,
      credential.arguments[0] ?? "",
      environment,
      new Set([method.id]),
    );
  }
  return base;
}

function mergeBuilderState(left, right) {
  if (!left && !right) return null;
  return {
    type: left?.type === right?.type ? left.type : left?.type ?? right?.type ?? "",
    endpoint: mergeFlow(left?.endpoint, right?.endpoint),
    credential: mergeFlow(left?.credential, right?.credential),
    valid: Boolean(left && right && left.valid && right.valid && left.type === right.type),
  };
}

function mergeConditionalBuilderFlow(previous, value) {
  return mergeFlow(
    previous?.kinds?.size > 0 ? previous : unknownFlow(),
    value,
  );
}

function secureBuilderConfiguration(runtime) {
  const incoming = propagatedSecureArguments(runtime);
  const products = new Set();
  const expected = new Map([
    ["buildClient", ["BlobServiceClientBuilder", "AZURE_STORAGE_ACCOUNT_URL"]],
    ["buildAsyncClient", ["BlobServiceClientBuilder", "AZURE_STORAGE_ACCOUNT_URL"]],
    [
      "buildEventGridEventPublisherClient",
      ["EventGridPublisherClientBuilder", "AZURE_EVENT_GRID_TOPIC_ENDPOINT"],
    ],
    [
      "buildEventGridEventPublisherAsyncClient",
      ["EventGridPublisherClientBuilder", "AZURE_EVENT_GRID_TOPIC_ENDPOINT"],
    ],
  ]);
  for (const method of reachableMethods(runtime)) {
    const builders = new Map();
    const events = [
      ...flowAssignmentEvents(method).map((assignment) => ({
        type: "assignment",
        ...assignment,
      })),
      ...methodCalls(method.literal).map((call) => ({
        type: "call",
        ...call,
        ...assignmentControl(method, call.position),
      })),
    ].filter(({ reachable }) => reachable)
      .sort((left, right) =>
        left.position - right.position ||
        (left.type === "assignment" ? -1 : 1)
      );
    const methodIncoming = incoming.get(method.id);
    for (const event of events) {
      const environment = flowEnvironmentAt(
        runtime,
        method,
        methodIncoming,
        event.position + 1,
      );
      if (event.type === "assignment") {
        const state = builderStateFromExpression(
          runtime,
          method,
          event.expression,
          environment,
          builders,
        );
        if (event.conditional) {
          builders.set(
            event.name,
            mergeBuilderState(builders.get(event.name), state),
          );
        } else if (state) {
          builders.set(event.name, state);
        } else {
          builders.delete(event.name);
        }
        continue;
      }
      if (["endpoint", "credential"].includes(event.name) && event.receiver) {
        const state = builders.get(event.receiver);
        if (!state) continue;
        if (event.name === "endpoint") {
          const value = flowExpression(
            runtime,
            method,
            event.arguments[0] ?? "",
            environment,
            new Set([method.id]),
          );
          state.endpoint = event.conditional
            ? mergeConditionalBuilderFlow(state.endpoint, value)
            : value;
        } else {
          const value = flowExpression(
            runtime,
            method,
            event.arguments[0] ?? "",
            environment,
            new Set([method.id]),
          );
          state.credential = event.conditional
            ? mergeConditionalBuilderFlow(state.credential, value)
            : value;
        }
        continue;
      }
      if (!expected.has(event.name)) continue;
      const [builderType, environmentName] = expected.get(event.name);
      let state = event.receiver ? builders.get(event.receiver) : null;
      if (!state) {
        const start = Math.max(
          method.literal.lastIndexOf(";", event.position),
          method.literal.lastIndexOf("{", event.position),
          method.literal.lastIndexOf("}", event.position),
        ) + 1;
        state = builderStateFromExpression(
          runtime,
          method,
          method.literal.slice(start, event.position + event.name.length + 2),
          environment,
          builders,
        );
      }
      if (
        !state ||
        !state.valid ||
        state.type !== builderType ||
        !secureEndpointFlow(state.endpoint, environmentName) ||
        !secureCredentialFlow(state.credential)
      ) {
        return false;
      }
      products.add(event.name);
    }
  }
  return [...expected.keys()].every((name) => products.has(name));
}

function emptyClientValue() {
  return new Set();
}

function mergeClientValue(...values) {
  return new Set(values.flatMap((value) => [...(value ?? [])]));
}

function addClientValue(target, key, value) {
  if (!value || value.size === 0) return false;
  if (!target.has(key)) target.set(key, emptyClientValue());
  const existing = target.get(key);
  const previous = existing.size;
  for (const item of value) existing.add(item);
  return existing.size !== previous;
}

function recordComponents(runtime) {
  if (runtime.recordComponents) return runtime.recordComponents;
  const records = new Map();
  for (const match of runtime.code.matchAll(
    /\brecord\s+([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    const open = runtime.code.indexOf("(", match.index);
    const close = matchingIndex(runtime.code, open);
    if (close < 0) continue;
    const parameters = runtime.code.slice(open + 1, close);
    const names = parameterNames(parameters);
    const types = parameterTypes(parameters);
    records.set(
      match[1],
      names.map((name, index) => ({
        name,
        type: types[index] ?? "",
      })),
    );
  }
  runtime.recordComponents = records;
  return records;
}

function classFieldTypes(runtime) {
  if (runtime.classFieldTypes) return runtime.classFieldTypes;
  const fields = new Map();
  for (const owner of classRanges(runtime.code)) {
    const source = runtime.code.slice(owner.start, owner.end);
    const ownerFields = new Map();
    for (const match of source.matchAll(
      /\b([A-Za-z_$][\w$.]*(?:\s*<[^;={}()]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;/g,
    )) {
      ownerFields.set(match[2], normalizeJavaType(match[1]));
    }
    for (const component of recordComponents(runtime).get(owner.name) ?? []) {
      ownerFields.set(component.name, component.type);
    }
    fields.set(owner.name, ownerFields);
  }
  runtime.classFieldTypes = fields;
  return fields;
}

function clientAssignmentEvents(method) {
  const declarationAssignments = flowAssignments(method);
  const declarations = declarationAssignments.map((assignment) => ({
    ...assignment,
    type: "assignment",
    declaration: true,
    target: assignment.name,
    ...assignmentControl(method, assignment.position),
  }));
  const reassignments = simpleAssignmentExpressions(method.literal, true)
    .map((assignment) => ({
      ...assignment,
      type: "assignment",
      declaration: false,
      ...assignmentControl(method, assignment.position),
    }))
    .filter(({ position }) =>
      !declarationAssignments.some(
        ({ position: start, end }) => start <= position && position < end,
      )
    );
  return [...declarations, ...reassignments].filter(({ reachable }) => reachable);
}

const clientProducts = new Map([
  [
    "buildClient",
    {
      builder: "BlobServiceClientBuilder",
      environment: "AZURE_STORAGE_ACCOUNT_URL",
      value: "blob-sync",
    },
  ],
  [
    "buildAsyncClient",
    {
      builder: "BlobServiceClientBuilder",
      environment: "AZURE_STORAGE_ACCOUNT_URL",
      value: "blob-async",
    },
  ],
  [
    "buildEventGridEventPublisherClient",
    {
      builder: "EventGridPublisherClientBuilder",
      environment: "AZURE_EVENT_GRID_TOPIC_ENDPOINT",
      value: "publisher-sync",
    },
  ],
  [
    "buildEventGridEventPublisherAsyncClient",
    {
      builder: "EventGridPublisherClientBuilder",
      environment: "AZURE_EVENT_GRID_TOPIC_ENDPOINT",
      value: "publisher-async",
    },
  ],
]);

function builtClientValue(
  runtime,
  method,
  expression,
  flowEnvironment,
  builders,
) {
  for (const [buildMethod, expected] of clientProducts) {
    const build = callAt(expression, buildMethod);
    if (!build) continue;
    const state = builderStateFromExpression(
      runtime,
      method,
      build.receiver,
      flowEnvironment,
      builders,
    );
    const secure = Boolean(
      state &&
      state.valid &&
      state.type === expected.builder &&
      secureEndpointFlow(state.endpoint, expected.environment) &&
      secureCredentialFlow(state.credential),
    );
    return new Set([`${expected.value}-${secure ? "secure" : "insecure"}`]);
  }
  return null;
}

function fieldClientValue(runtime, method, name, fields) {
  const fieldNames = classFieldTypes(runtime).get(method.className);
  if (!fieldNames?.has(name)) return emptyClientValue();
  return new Set(fields.get(`${method.className}.${name}`) ?? []);
}

function clientExpression(
  runtime,
  method,
  expression,
  environment,
  fields,
  returns,
  flowEnvironment,
  builders,
  seen = new Set(),
) {
  let value = unwrapParentheses(expression);
  while (/^\(\s*[A-Za-z_$][\w$.<>,? \[\]]*\s*\)\s*/.test(value)) {
    value = value.replace(
      /^\(\s*[A-Za-z_$][\w$.<>,? \[\]]*\s*\)\s*/,
      "",
    ).trim();
  }
  if (/^null$/.test(value)) return new Set(["invalid"]);
  const conditional = splitTopLevelConditional(value);
  if (conditional) {
    const condition = staticJavaBoolean(conditional.condition);
    if (condition === true) {
      return clientExpression(
        runtime,
        method,
        conditional.consequent,
        environment,
        fields,
        returns,
        flowEnvironment,
        builders,
        seen,
      );
    }
    if (condition === false) {
      return clientExpression(
        runtime,
        method,
        conditional.alternate,
        environment,
        fields,
        returns,
        flowEnvironment,
        builders,
        seen,
      );
    }
    return mergeClientValue(
      clientExpression(
        runtime,
        method,
        conditional.consequent,
        environment,
        fields,
        returns,
        flowEnvironment,
        builders,
        seen,
      ),
      clientExpression(
        runtime,
        method,
        conditional.alternate,
        environment,
        fields,
        returns,
        flowEnvironment,
        builders,
        seen,
      ),
    );
  }
  const built = builtClientValue(
    runtime,
    method,
    value,
    flowEnvironment,
    builders,
  );
  if (built) return built;

  const reference =
    /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) {
    if (environment.has(reference)) {
      return new Set(environment.get(reference));
    }
    const field = fieldClientValue(runtime, method, reference, fields);
    return field.size > 0 ||
        classFieldTypes(runtime).get(method.className)?.has(reference)
      ? field
      : new Set(["invalid"]);
  }

  const requireNonNull =
    /^(?:java\s*\.\s*util\s*\.\s*)?Objects\s*\.\s*requireNonNull\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (requireNonNull) {
    const arguments_ = splitTopLevel(requireNonNull[1]);
    return arguments_.length > 0
      ? clientExpression(
          runtime,
          method,
          arguments_[0],
          environment,
          fields,
          returns,
          flowEnvironment,
          builders,
          seen,
        )
      : new Set(["invalid"]);
  }

  for (const [name, mode] of [
    ["getBlobContainerClient", "sync"],
    ["getBlobClient", "sync"],
    ["getBlobContainerAsyncClient", "async"],
    ["getBlobAsyncClient", "async"],
  ]) {
    const call = callAt(value, name);
    if (!call) continue;
    const receiver = clientExpression(
      runtime,
      method,
      call.receiver,
      environment,
      fields,
      returns,
      flowEnvironment,
      builders,
      seen,
    );
    return new Set(
      [...receiver]
        .filter(
          (item) => item === "invalid" || item.startsWith(`blob-${mode}-`),
        )
        .map((item) => item),
    );
  }

  const recordConstruction =
    /^\s*new\s+([A-Za-z_$][\w$]*)\s*\(/.exec(value)?.[1];
  if (recordConstruction && recordComponents(runtime).has(recordConstruction)) {
    return emptyClientValue();
  }

  const directCall =
    /^(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (!directCall) return new Set(["invalid"]);
  if (seen.has(value)) return emptyClientValue();
  const call = {
    name: directCall[2],
    receiver: directCall[1] ?? null,
    arguments: splitTopLevel(directCall[3]),
  };
  if (call.receiver) {
    const receiverValue = environment.has(call.receiver)
      ? environment.get(call.receiver)
      : fieldClientValue(runtime, method, call.receiver, fields);
    if (receiverValue?.has("invalid")) return new Set(["invalid"]);
    const receiverType = methodVariableTypes(runtime, method).get(call.receiver);
    const component = recordComponents(runtime)
      .get(receiverType)
      ?.find(({ name }) => name === call.name);
    if (component) {
      return new Set(fields.get(`${receiverType}.${component.name}`) ?? []);
    }
  }
  const targets = methodCallTargets(runtime, method, call)
    .filter(({ id }) => runtime.reachable.has(id));
  if (targets.length === 0) return new Set(["invalid"]);
  return mergeClientValue(
    ...targets.map((target) => returns.get(target.id)),
  );
}

function callReceiverExpression(text, call) {
  let dot = call.position - 1;
  while (/\s/.test(text[dot] ?? "")) dot -= 1;
  if (text[dot] !== ".") return call.receiver ?? "";
  let index = dot - 1;
  const depth = { ")": 0, "]": 0 };
  while (index >= 0) {
    const character = text[index];
    if (character === ")") depth[")"] += 1;
    else if (character === "]") depth["]"] += 1;
    else if (character === "(") {
      if (depth[")"] === 0) break;
      depth[")"] -= 1;
    } else if (character === "[") {
      if (depth["]"] === 0) break;
      depth["]"] -= 1;
    } else if (
      depth[")"] === 0 &&
      depth["]"] === 0 &&
      /[;{}=,]/.test(character)
    ) {
      break;
    }
    index -= 1;
  }
  return text.slice(index + 1, dot)
    .replace(/^\s*(?:return|throw)\s+/, "")
    .trim();
}

function newRecordCall(runtime, method, call) {
  if (!recordComponents(runtime).has(call.name)) return false;
  const prefix = method.code.slice(Math.max(0, call.position - 24), call.position);
  return /\bnew\s*$/.test(prefix);
}

function clientEvents(method) {
  return [
    ...clientAssignmentEvents(method),
    ...methodCalls(method.literal).map((call) => ({
      type: "call",
      ...call,
      ...assignmentControl(method, call.position),
    })),
    ...Array.from(
      method.literal.matchAll(/\breturn\s+([^;]+);/g),
      (match) => ({
        type: "return",
        position: match.index,
        expression: match[1],
      }),
    ),
  ].filter(({ reachable = true }) => reachable)
    .sort((left, right) =>
      left.position - right.position ||
      (left.type === "assignment" ? -1 : 1)
    );
}

function secureClientUsage(runtime) {
  const secureIncoming = propagatedSecureArguments(runtime);
  const incoming = new Map(
    runtime.methods.map((method) => [method.id, new Map()]),
  );
  const fields = new Map();
  const returns = new Map(
    runtime.methods.map((method) => [method.id, emptyClientValue()]),
  );

  for (let pass = 0; pass < runtime.methods.length + 8; pass += 1) {
    let changed = false;
    for (const method of reachableMethods(runtime)) {
      const environment = new Map();
      for (const parameter of method.parameterNames) {
        environment.set(
          parameter,
          new Set(incoming.get(method.id).get(parameter) ?? []),
        );
      }
      const builders = new Map();
      const methodReturns = emptyClientValue();
      for (const event of clientEvents(method)) {
        const flowEnvironment = flowEnvironmentAt(
          runtime,
          method,
          secureIncoming.get(method.id),
          event.position + 1,
        );
        if (event.type === "assignment") {
          const builder = builderStateFromExpression(
            runtime,
            method,
            event.expression,
            flowEnvironment,
            builders,
          );
          if (!event.target.startsWith("this.")) {
            if (event.conditional) {
              builders.set(
                event.name,
                mergeBuilderState(builders.get(event.name), builder),
              );
            } else if (builder) {
              builders.set(event.name, builder);
            } else {
              builders.delete(event.name);
            }
          }
          const value = clientExpression(
            runtime,
            method,
            event.expression,
            environment,
            fields,
            returns,
            flowEnvironment,
            builders,
          );
          const ownerFields = classFieldTypes(runtime).get(method.className);
          if (
            event.target.startsWith("this.") ||
            !event.declaration &&
              !environment.has(event.name) &&
              ownerFields?.has(event.name)
          ) {
            changed = addClientValue(
              fields,
              `${method.className}.${event.name}`,
              value,
            ) || changed;
          } else {
            environment.set(
              event.name,
              event.conditional
                ? mergeClientValue(environment.get(event.name), value)
                : value,
            );
          }
          continue;
        }
        if (event.type === "return") {
          const value = clientExpression(
            runtime,
            method,
            event.expression,
            environment,
            fields,
            returns,
            flowEnvironment,
            builders,
          );
          for (const item of value) methodReturns.add(item);
          continue;
        }
        if (["endpoint", "credential"].includes(event.name) && event.receiver) {
          const state = builders.get(event.receiver);
          if (state) {
            if (event.name === "endpoint") {
              const value = flowExpression(
                runtime,
                method,
                event.arguments[0] ?? "",
                flowEnvironment,
                new Set([method.id]),
              );
              state.endpoint = event.conditional
                ? mergeConditionalBuilderFlow(state.endpoint, value)
                : value;
            } else {
              const value = flowExpression(
                runtime,
                method,
                event.arguments[0] ?? "",
                flowEnvironment,
                new Set([method.id]),
              );
              state.credential = event.conditional
                ? mergeConditionalBuilderFlow(state.credential, value)
                : value;
            }
          }
        }
        if (newRecordCall(runtime, method, event)) {
          const components = recordComponents(runtime).get(event.name);
          for (
            let index = 0;
            index < components.length && index < event.arguments.length;
            index += 1
          ) {
            const value = clientExpression(
              runtime,
              method,
              event.arguments[index],
              environment,
              fields,
              returns,
              flowEnvironment,
              builders,
            );
            changed = addClientValue(
              fields,
              `${event.name}.${components[index].name}`,
              value,
            ) || changed;
          }
        }
        for (const target of methodCallTargets(runtime, method, event)) {
          if (!runtime.reachable.has(target.id)) continue;
          for (
            let index = 0;
            index < target.parameterNames.length &&
            index < event.arguments.length;
            index += 1
          ) {
            const value = clientExpression(
              runtime,
              method,
              event.arguments[index],
              environment,
              fields,
              returns,
              flowEnvironment,
              builders,
            );
            changed = addClientValue(
              incoming.get(target.id),
              target.parameterNames[index],
              value,
            ) || changed;
          }
        }
      }
      changed = addClientValue(returns, method.id, methodReturns) || changed;
    }
    if (!changed) break;
  }

  const required = new Set([
    "blob-sync",
    "blob-async",
    "publisher-sync",
    "publisher-async",
  ]);
  for (const method of reachableMethods(runtime)) {
    const environment = new Map();
    for (const parameter of method.parameterNames) {
      environment.set(
        parameter,
        new Set(incoming.get(method.id).get(parameter) ?? []),
      );
    }
    const builders = new Map();
    for (const event of clientEvents(method)) {
      const flowEnvironment = flowEnvironmentAt(
        runtime,
        method,
        secureIncoming.get(method.id),
        event.position + 1,
      );
      if (event.type === "assignment") {
        const builder = builderStateFromExpression(
          runtime,
          method,
          event.expression,
          flowEnvironment,
          builders,
        );
        if (!event.target.startsWith("this.")) {
          if (event.conditional) {
            builders.set(
              event.name,
              mergeBuilderState(builders.get(event.name), builder),
            );
          } else if (builder) {
            builders.set(event.name, builder);
          } else {
            builders.delete(event.name);
          }
        }
        const value = clientExpression(
          runtime,
          method,
          event.expression,
          environment,
          fields,
          returns,
          flowEnvironment,
          builders,
        );
        const ownerFields = classFieldTypes(runtime).get(method.className);
        if (
          !event.target.startsWith("this.") &&
          (
            event.declaration ||
            environment.has(event.name) ||
            !ownerFields?.has(event.name)
          )
        ) {
          environment.set(
            event.name,
            event.conditional
              ? mergeClientValue(environment.get(event.name), value)
              : value,
          );
        }
        continue;
      }
      if (event.type !== "call") continue;
      if (["endpoint", "credential"].includes(event.name) && event.receiver) {
        const state = builders.get(event.receiver);
        if (state) {
          if (event.name === "endpoint") {
            const value = flowExpression(
              runtime,
              method,
              event.arguments[0] ?? "",
              flowEnvironment,
              new Set([method.id]),
            );
            state.endpoint = event.conditional
              ? mergeConditionalBuilderFlow(state.endpoint, value)
              : value;
          } else {
            const value = flowExpression(
              runtime,
              method,
              event.arguments[0] ?? "",
              flowEnvironment,
              new Set([method.id]),
            );
            state.credential = event.conditional
              ? mergeConditionalBuilderFlow(state.credential, value)
              : value;
          }
        }
      }
      const expected = ["getProperties", "downloadContent", "downloadStream"]
        .includes(event.name)
        ? `blob-${methodIsAsync(method) ? "async" : "sync"}`
        : ["sendEvent", "sendEvents"].includes(event.name)
          ? `publisher-${methodIsAsync(method) ? "async" : "sync"}`
          : null;
      if (!expected) continue;
      const receiver = callReceiverExpression(method.literal, event);
      const value = clientExpression(
        runtime,
        method,
        receiver,
        environment,
        fields,
        returns,
        flowEnvironment,
        builders,
      );
      if (
        value.size === 0 ||
        [...value].some((item) => item !== `${expected}-secure`)
      ) {
        return false;
      }
      required.delete(expected);
    }
  }
  return required.size === 0;
}

function eventTypeReference(code, constants, value) {
  if (constants.includes(`"${value}"`) && code.includes(`"${value}"`)) {
    return true;
  }
  for (const match of constants.matchAll(
    new RegExp(
      `\\b([A-Za-z_$][\\w$]*)\\s*=\\s*"${escapeRegExp(value)}"`,
      "g",
    ),
  )) {
    if (new RegExp(`\\b${escapeRegExp(match[1])}\\b`).test(code)) return true;
  }
  return false;
}

function splitTopLevelBoolean(expression, operator) {
  const code = maskJava(expression, false);
  const parts = [];
  let start = 0;
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (character in depth) {
      depth[character] += 1;
    } else if (character in closing) {
      depth[closing[character]] -= 1;
    } else if (
      Object.values(depth).every((value) => value === 0) &&
      code.startsWith(operator, index)
    ) {
      parts.push(expression.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (parts.length === 0) return null;
  parts.push(expression.slice(start).trim());
  return parts;
}

function eventTypeSelectorOperand(expression, eventTypeNames) {
  const value = unwrapParentheses(expression);
  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  return Boolean(reference && eventTypeNames.has(reference));
}

function fieldOnlyLiteral(runtime) {
  if (runtime.fieldOnlyLiteral) return runtime.fieldOnlyLiteral;
  const result = [...runtime.literal];
  for (const method of runtime.methods) {
    const open = runtime.code.indexOf("{", method.start);
    const close = matchingIndex(runtime.code, open, "{", "}");
    if (open < 0 || close < 0) continue;
    for (let index = method.start; index <= close; index += 1) {
      if (result[index] !== "\n" && result[index] !== ";") {
        result[index] = " ";
      }
    }
  }
  runtime.fieldOnlyLiteral = result.join("");
  return runtime.fieldOnlyLiteral;
}

function exactJavaStringValue(expression, environment) {
  const value = unwrapParentheses(expression);
  const direct = javaStringValue(value);
  if (direct !== null) return direct;
  const compact = value.replace(/\s+/g, "");
  if (/^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*$/.test(compact)) {
    return environment.get(compact) ??
      (
        compact.startsWith("this.")
          ? environment.get(compact.slice("this.".length))
          : null
      ) ??
      null;
  }
  const addition = splitTopLevelAddition(value);
  if (!addition) return null;
  const left = exactJavaStringValue(addition[0], environment);
  const right = exactJavaStringValue(addition[1], environment);
  return left !== null && right !== null ? `${left}${right}` : null;
}

function eventTypeFieldEnvironment(runtime, method) {
  if (!runtime.eventTypeFieldEnvironments) {
    const structural = maskJava(fieldOnlyLiteral(runtime), false);
    const literal = maskJava(fieldOnlyLiteral(runtime), true);
    const owners = classRanges(runtime.code);
    const ownerAt = (position) =>
      owners
        .filter(({ start, end }) => start <= position && position < end)
        .sort(
          (left, right) =>
            left.end - left.start - (right.end - right.start),
        )[0]?.name ?? "";
    const declarations = Array.from(
      structural.matchAll(
        /\b(?:(?:public|protected|private|static|final|transient|volatile)\s+)*(?:java\.lang\.)?String\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
      ),
      (match) => ({
        className: ownerAt(match.index),
        expression: literal.slice(
          structural.indexOf("=", match.index) + 1,
          match.index + match[0].lastIndexOf(";"),
        ),
        final: /\bfinal\b/.test(match[0]),
        name: match[1],
      }),
    ).filter(({ className, final }) => className && final);
    const resolved = new Map();
    for (let pass = 0; pass <= declarations.length; pass += 1) {
      let changed = false;
      for (const declaration of declarations) {
        const key = `${declaration.className}.${declaration.name}`;
        if (resolved.has(key)) continue;
        const environment = new Map(resolved);
        for (const [candidate, candidateValue] of resolved) {
          const [owner, name] = candidate.split(".");
          if (owner === declaration.className) {
            environment.set(name, candidateValue);
            environment.set(`this.${name}`, candidateValue);
          }
        }
        const value = exactJavaStringValue(
          declaration.expression,
          environment,
        );
        if (value !== null) {
          resolved.set(key, value);
          changed = true;
        }
      }
      if (!changed) break;
    }
    runtime.eventTypeFieldEnvironments = resolved;
  }
  const fields = runtime.eventTypeFieldEnvironments;
  const environment = new Map(fields);
  const simple = new Map();
  for (const [key, value] of fields) {
    const separator = key.indexOf(".");
    const owner = key.slice(0, separator);
    const name = key.slice(separator + 1);
    if (!simple.has(name)) simple.set(name, new Set());
    simple.get(name).add(value);
    if (owner === method.className) {
      environment.set(name, value);
      environment.set(`this.${name}`, value);
    }
  }
  for (const [name, values] of simple) {
    if (values.size === 1 && !environment.has(name)) {
      environment.set(name, [...values][0]);
    }
  }
  return environment;
}

function eventTypeStringAssignmentEvents(text) {
  const method = { literal: text };
  const assignments = flowAssignmentEvents(method);
  const initialized = assignments
    .filter(({ declaration }) => declaration)
    .map(({ position, end }) => ({ position, end }));
  const structural = maskJava(text, false);
  const uninitialized = Array.from(
    structural.matchAll(
      /\b(?:final\s+)?(?:java\.lang\.)?String\s+([A-Za-z_$][\w$]*)\s*;/g,
    ),
    (match) => ({
      position: match.index,
      end: match.index + match[0].length,
      name: match[1],
      expression: "",
      declaration: true,
      ...assignmentControl(method, match.index),
    }),
  ).filter(({ position }) =>
    !initialized.some(
      ({ position: start, end }) => start <= position && position < end,
    )
  );
  return [...assignments, ...uninitialized]
    .filter(({ reachable }) => reachable)
    .sort((left, right) => left.position - right.position);
}

function eventTypeStringEnvironmentOnPath(runtime, method, text) {
  const environment = eventTypeFieldEnvironment(runtime, method);
  for (const assignment of eventTypeStringAssignmentEvents(text)) {
    const value = exactJavaStringValue(assignment.expression, environment);
    if (assignment.conditional) {
      if (value === null || environment.get(assignment.name) !== value) {
        environment.delete(assignment.name);
      }
    } else if (value === null) {
      environment.delete(assignment.name);
    } else {
      environment.set(assignment.name, value);
    }
  }
  return environment;
}

function eventTypeStringEnvironmentAt(runtime, method, endPosition) {
  const variants = completedConditionalVariants(
    method.literal,
    endPosition,
  );
  const environments = (
    variants.length > 0 ? variants : [method.literal.slice(0, endPosition)]
  ).map((variant) =>
    eventTypeStringEnvironmentOnPath(runtime, method, variant)
  );
  const stable = new Map(environments[0] ?? []);
  for (const [name, value] of stable) {
    if (environments.slice(1).some((candidate) =>
      candidate.get(name) !== value
    )) {
      stable.delete(name);
    }
  }
  return stable;
}

function expectedEventTypeOperand(expression, environment, value) {
  return exactJavaStringValue(expression, environment) === value;
}

const unknownPredicateValue = Symbol("unknown-predicate-value");

function identifierShadowsType(runtime, method, name, position) {
  if (method.parameterNames.includes(name)) return true;
  if (
    [
      ...(method.lexicalBindings ?? []),
      ...lambdaLexicalBindings(method.literal),
    ].some(
      (binding) =>
        binding.name === name &&
        binding.start <= position &&
        position < binding.end,
    )
  ) {
    return true;
  }
  const methodCode = maskJava(method.literal, false);
  const useScope = lexicalScopePath(methodCode, position);
  for (const declaration of javaVariableDeclarations(method.literal)) {
    if (
      declaration.name === name &&
      declaration.position < position &&
      scopeContains(
        lexicalScopePath(methodCode, declaration.position),
        useScope,
      )
    ) {
      return true;
    }
  }

  const fields = maskJava(fieldOnlyLiteral(runtime), false);
  const owners = classRanges(runtime.code);
  const ownerAt = (fieldPosition) =>
    owners
      .filter(
        ({ start, end }) =>
          start <= fieldPosition && fieldPosition < end,
      )
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      )[0]?.qualifiedName ?? "";
  const methodOwner = method.classQualifiedName || method.className;
  return javaVariableDeclarations(fields).some(
    (declaration) =>
      declaration.name === name &&
      ownerAt(declaration.position) === methodOwner,
  );
}

function trustedJdkStaticReceiver(
  runtime,
  method,
  receiver,
  packageName,
  name,
  position = method.literal.length,
) {
  const compact = receiver.replace(/\s+/g, "");
  if (compact === `${packageName}.${name}`) {
    const packageRoot = packageName.split(".")[0];
    return (
      !runtime.localQualifiedTypes.has(`${packageName}.${name}`) &&
      !identifierShadowsType(runtime, method, packageRoot, position)
    );
  }
  if (
    compact !== name ||
    runtime.localSimpleTypes.has(name) ||
    identifierShadowsType(runtime, method, name, position)
  ) {
    return false;
  }
  if (packageName === "java.lang") return true;
  return hasTrustedSimpleImport(runtime, packageName, name);
}

function trustedStringReceiver(runtime, method, expression) {
  const value = unwrapParentheses(expression);
  if (/^"(?:\\.|[^"\\])*"$/.test(value) || /^"""[\s\S]*"""$/.test(value)) {
    return true;
  }
  if (runtime.localSimpleTypes.has("String")) return false;
  const types = expressionStaticTypes(runtime, method, value);
  return types.size === 1 && types.has("String");
}

function topLevelComparison(expression) {
  const code = maskJava(expression, false);
  const operators = ["==", "!=", "<=", ">=", "<", ">"];
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (character in depth) {
      depth[character] += 1;
      continue;
    }
    if (character in closing) {
      depth[closing[character]] -= 1;
      continue;
    }
    if (!Object.values(depth).every((item) => item === 0)) continue;
    const operator = operators.find((candidate) =>
      code.startsWith(candidate, index)
    );
    if (operator) {
      return {
        left: expression.slice(0, index),
        operator,
        right: expression.slice(index + operator.length),
      };
    }
  }
  return null;
}

function eventPredicateScalar(
  runtime,
  method,
  expression,
  environment,
  expected,
  eventTypeNames,
  sourcePosition,
) {
  const value = unwrapParentheses(expression);
  if (eventTypeSelectorOperand(value, eventTypeNames)) return expected;
  const string = exactJavaStringValue(value, environment);
  if (string !== null) return string;
  const literalValue = javaConditionLiteral(value);
  if (literalValue !== undefined) return literalValue;

  const call =
    /^([\s\S]+?)\.\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(value);
  if (!call) return unknownPredicateValue;
  const receiver = call[1].trim();
  const name = call[2];
  const arguments_ = splitTopLevel(call[3]);
  if (
    trustedJdkStaticReceiver(
      runtime,
      method,
      receiver,
      "java.util",
      "Objects",
      sourcePosition,
    )
  ) {
    const values = arguments_.map((argument) =>
      eventPredicateScalar(
        runtime,
        method,
        argument,
        environment,
        expected,
        eventTypeNames,
        sourcePosition,
      )
    );
    if (values.some((item) => item === unknownPredicateValue)) {
      return unknownPredicateValue;
    }
    if (name === "isNull" && values.length === 1) return values[0] === null;
    if (name === "nonNull" && values.length === 1) return values[0] !== null;
    if (name === "equals" && values.length === 2) return values[0] === values[1];
    return unknownPredicateValue;
  }
  if (
    trustedJdkStaticReceiver(
      runtime,
      method,
      receiver,
      "java.lang",
      "System",
      sourcePosition,
    ) &&
    name === "nanoTime" &&
    arguments_.length === 0
  ) {
    return unknownPredicateValue;
  }
  if (!trustedStringReceiver(runtime, method, receiver)) {
    return unknownPredicateValue;
  }
  const receiverValue = eventPredicateScalar(
    runtime,
    method,
    receiver,
    environment,
    expected,
    eventTypeNames,
    sourcePosition,
  );
  const argumentValues = arguments_.map((argument) =>
    eventPredicateScalar(
      runtime,
      method,
      argument,
      environment,
      expected,
      eventTypeNames,
      sourcePosition,
    )
  );
  if (
    receiverValue === unknownPredicateValue ||
    argumentValues.some((item) => item === unknownPredicateValue)
  ) {
    return unknownPredicateValue;
  }
  if (typeof receiverValue !== "string") return unknownPredicateValue;
  if (name === "length" && argumentValues.length === 0) {
    return receiverValue.length;
  }
  if (name === "isEmpty" && argumentValues.length === 0) {
    return receiverValue.length === 0;
  }
  if (name === "isBlank" && argumentValues.length === 0) {
    return receiverValue.trim().length === 0;
  }
  if (name === "equals" && argumentValues.length === 1) {
    return receiverValue === argumentValues[0];
  }
  if (name === "equalsIgnoreCase" && argumentValues.length === 1) {
    return typeof argumentValues[0] === "string" &&
      receiverValue.toLowerCase() === argumentValues[0].toLowerCase();
  }
  if (
    ["contains", "startsWith", "endsWith"].includes(name) &&
    argumentValues.length === 1 &&
    typeof argumentValues[0] === "string"
  ) {
    if (name === "contains") return receiverValue.includes(argumentValues[0]);
    if (name === "startsWith") return receiverValue.startsWith(argumentValues[0]);
    return receiverValue.endsWith(argumentValues[0]);
  }
  return unknownPredicateValue;
}

function harmlessEventPredicateAtom(
  runtime,
  method,
  condition,
  environment,
  expected,
  eventTypeNames,
  sourcePosition,
) {
  const expression = unwrapParentheses(condition);
  if (expression.startsWith("!") && !expression.startsWith("!=")) {
    const operand = harmlessEventPredicateAtom(
      runtime,
      method,
      expression.slice(1),
      environment,
      expected,
      eventTypeNames,
      sourcePosition,
    );
    return operand === null ? null : !operand;
  }
  const comparison = topLevelComparison(expression);
  if (comparison) {
    const left = eventPredicateScalar(
      runtime,
      method,
      comparison.left,
      environment,
      expected,
      eventTypeNames,
      sourcePosition,
    );
    const right = eventPredicateScalar(
      runtime,
      method,
      comparison.right,
      environment,
      expected,
      eventTypeNames,
      sourcePosition,
    );
    if (left === unknownPredicateValue || right === unknownPredicateValue) {
      return null;
    }
    if (comparison.operator === "==") return left === right;
    if (comparison.operator === "!=") return left !== right;
    if (comparison.operator === "<") return left < right;
    if (comparison.operator === "<=") return left <= right;
    if (comparison.operator === ">") return left > right;
    return left >= right;
  }
  const scalar = eventPredicateScalar(
    runtime,
    method,
    expression,
    environment,
    expected,
    eventTypeNames,
    sourcePosition,
  );
  return typeof scalar === "boolean" ? scalar : null;
}

function positiveEventTypeAtom(
  runtime,
  method,
  condition,
  environment,
  value,
  eventTypeNames,
) {
  const expression = unwrapParentheses(condition);
  if (!expression || expression.startsWith("!")) return false;

  const equals = callAt(expression, "equals");
  if (
    equals &&
    !equals.suffix &&
    equals.arguments.length === 1
  ) {
    const leftSelector = eventTypeSelectorOperand(
      equals.receiver,
      eventTypeNames,
    );
    const rightSelector = eventTypeSelectorOperand(
      equals.arguments[0],
      eventTypeNames,
    );
    return (
      trustedStringReceiver(runtime, method, equals.receiver) &&
      leftSelector !== rightSelector && (
        leftSelector
          ? expectedEventTypeOperand(equals.arguments[0], environment, value)
          : expectedEventTypeOperand(equals.receiver, environment, value)
      )
    );
  }

  const code = maskJava(expression, false);
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < code.length - 1; index += 1) {
    const character = code[index];
    if (character in depth) {
      depth[character] += 1;
      continue;
    }
    if (character in closing) {
      depth[closing[character]] -= 1;
      continue;
    }
    if (
      !Object.values(depth).every((item) => item === 0) ||
      code.slice(index, index + 2) !== "=="
    ) {
      continue;
    }
    const left = expression.slice(0, index);
    const right = expression.slice(index + 2);
    const leftSelector = eventTypeSelectorOperand(left, eventTypeNames);
    const rightSelector = eventTypeSelectorOperand(right, eventTypeNames);
    return leftSelector !== rightSelector && (
      leftSelector
        ? expectedEventTypeOperand(right, environment, value)
        : expectedEventTypeOperand(left, environment, value)
    );
  }
  return false;
}

function positiveEventTypeCondition(
  runtime,
  method,
  condition,
  environment,
  value,
  eventTypeNames,
  sourcePosition,
) {
  const expression = unwrapParentheses(condition);
  const code = maskJava(expression, false);
  if (/(?:^|[^=!<>])=(?!=)|\+\+|--/.test(code)) return false;
  const disjunction = splitTopLevelBoolean(expression, "||");
  if (disjunction) {
    const possible = disjunction.filter((part) =>
      staticJavaBoolean(part) !== false
    );
    return possible.length > 0 && possible.every((part) =>
      positiveEventTypeCondition(
        runtime,
        method,
        part,
        environment,
        value,
        eventTypeNames,
        sourcePosition,
      )
    );
  }
  const conjunction = splitTopLevelBoolean(expression, "&&");
  if (conjunction) {
    const results = conjunction.map((part) => ({
      matches: positiveEventTypeCondition(
        runtime,
        method,
        part,
        environment,
        value,
        eventTypeNames,
        sourcePosition,
      ),
      truth: harmlessEventPredicateAtom(
        runtime,
        method,
        part,
        environment,
        value,
        eventTypeNames,
        sourcePosition,
      ),
    }));
    return results.every(({ matches, truth }) => matches || truth === true) &&
      results.some(({ matches }) => matches);
  }
  const positive = positiveEventTypeAtom(
    runtime,
    method,
    expression,
    environment,
    value,
    eventTypeNames,
  );
  const harmless = harmlessEventPredicateAtom(
    runtime,
    method,
    expression,
    environment,
    value,
    eventTypeNames,
    sourcePosition,
  );
  return positive && harmless === true;
}

function completedConditionalVariants(
  text,
  endPosition,
  limit = 32,
  preserveConditionEffects = false,
) {
  const variants = [];
  const visit = (value) => {
    if (variants.length >= limit) return;
    const structural = maskJava(value, false);
    let match;
    for (const candidate of structural.matchAll(/\bif\s*\(/g)) {
      const conditional = conditionalAt(structural, candidate.index);
      if (!conditional || conditional.end > value.length) continue;
      match = { candidate, ...conditional };
      break;
    }
    if (!match) {
      variants.push(value);
      return;
    }
    const before = value.slice(0, match.candidate.index);
    const after = value.slice(match.end);
    const consequent = statementBody(
      value,
      match.consequentStart,
      match.consequentEnd,
    );
    const alternate = statementBody(
      value,
      match.alternateStart,
      match.alternateEnd,
    );
    const condition = javaConditionEvaluationPaths(match.condition);
    if (
      preserveConditionEffects &&
      condition.completions.some(({ prefix }) => prefix.trim())
    ) {
      variants.push(value);
      return;
    }
    for (const completed of condition.completions) {
      const branch = completed.truth ? consequent : alternate;
      visit(
        `${before}${completed.prefix}${
          completed.prefix.trim() ? "\n" : ""
        }${branch}${after}`,
      );
    }
  };
  visit(text.slice(0, endPosition));
  return variants;
}

function subjectAliasesOnPath(text, subjectNames) {
  const environment = new Map([...subjectNames].map((name) => [name, true]));
  for (const assignment of flowAssignmentEvents(
    { literal: text },
    text.length,
  )) {
    const reference =
      /^([A-Za-z_$][\w$]*)$/.exec(unwrapParentheses(assignment.expression))?.[1];
    const derived = Boolean(reference && environment.get(reference));
    environment.set(
      assignment.name,
      assignment.conditional
        ? Boolean(environment.get(assignment.name) && derived)
        : derived,
    );
  }
  return new Set(
    [...environment]
      .filter(([, derived]) => derived)
      .map(([name]) => name),
  );
}

function subjectAliases(text, subjectNames, endPosition) {
  const variants = completedConditionalVariants(text, endPosition);
  if (variants.length === 0) return new Set(subjectNames);
  const aliases = variants.map((variant) =>
    subjectAliasesOnPath(variant, subjectNames)
  );
  return new Set(
    [...aliases[0]].filter((name) =>
      aliases.slice(1).every((candidate) => candidate.has(name))
    ),
  );
}

function expressionUsesAnyName(expression, names) {
  const code = maskJava(expression, false);
  return [...names].some((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`).test(code)
  );
}

function parameterDetails(parameters) {
  return splitTopLevel(parameters).flatMap((parameter) => {
    const normalized = parameter
      .replace(/@\w+(?:\s*\([^)]*\))?\s*/g, "")
      .replace(/\bfinal\b/g, "")
      .trim();
    const match =
      /^(.*?)\b([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?$/.exec(normalized);
    return match
      ? [{ type: match[1].replace(/\s+/g, ""), name: match[2] }]
      : [];
  });
}

function publisherInputParameters(parameters) {
  const details = parameterDetails(parameters);
  let subject = details
    .filter(({ name }) =>
      /subject/i.test(name) ||
      /^(?:filter|event)_?path$/i.test(name)
    )
    .map(({ name }) => name);
  if (subject.length === 0) {
    const strings = details.filter(({ type }) =>
      /(?:^|\.)String$|(?:^|\.)CharSequence$/.test(type)
    );
    if (strings.length === 1) subject = [strings[0].name];
  }
  const data = details
    .filter(({ type, name }) =>
      /(?:List|Collection|Iterable|Set|Stream|Publisher)</.test(type) ||
      /(?:data|payload|notification|event|item|message|content|detail|body)/i.test(
        name,
      ) && !/subject/i.test(name)
    )
    .map(({ name }) => name);
  return { subject, data };
}

function inputDerivedNames(text, parameters) {
  const code = maskJava(text, false);
  const derived = new Set(parameters);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of code.matchAll(
      /\b(?:final\s+)?(?:[A-Za-z_$][\w$.<>?]*|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
    )) {
      if (
        expressionUsesAnyName(match[2], derived) &&
        !derived.has(match[1])
      ) {
        derived.add(match[1]);
        changed = true;
      }
    }
    for (const match of code.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*\.\s*stream\s*\(\s*\)[\s\S]{0,400}?\.\s*map\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*->/g,
    )) {
      if (!derived.has(match[1])) continue;
      const parameterText = /\.map\s*\(\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*->/.exec(
        match[0],
      )?.[1] ?? "";
      const lambdaName = /([A-Za-z_$][\w$]*)\s*$/.exec(parameterText)?.[1];
      if (lambdaName && !derived.has(lambdaName)) {
        derived.add(lambdaName);
        changed = true;
      }
    }
    for (const match of code.matchAll(
      /\bfor\s*\(\s*[^:;]+?\b([A-Za-z_$][\w$]*)\s*:\s*([^)]+)\)/g,
    )) {
      if (
        expressionUsesAnyName(match[2], derived) &&
        !derived.has(match[1])
      ) {
        derived.add(match[1]);
        changed = true;
      }
    }
  }
  return derived;
}

function inputDerivedBinaryData(text, derivedNames) {
  const binary = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of maskJava(text, true).matchAll(
      /\b(?:final\s+)?(?:BinaryData|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
    )) {
      const call = callAt(match[2], "fromObject");
      const argument = call?.arguments[0] ?? "";
      if (
        call &&
        /(?:^|\.)BinaryData$/.test(call.receiver.replace(/\s+/g, "")) &&
        expressionUsesAnyName(argument, derivedNames) &&
        !binary.has(match[1])
      ) {
        binary.add(match[1]);
        changed = true;
      }
    }
  }
  return binary;
}

function subjectCalls(text, subjectNames) {
  const code = maskJava(text, false);
  const calls = [];
  const ignored = new Set([
    "equals",
    "info",
    "print",
    "printf",
    "println",
    "warn",
    "warning",
  ]);
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (ignored.has(name)) continue;
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    if (close < 0) continue;
    const receiver =
      /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(code.slice(0, match.index))?.[1] ??
      null;
    const aliases = subjectAliases(text, subjectNames, open);
    const args = splitTopLevel(code.slice(open + 1, close));
    const connectedIndexes = [];
    const normalized = args.map((argument, index) => {
      const compact = unwrapParentheses(argument).replace(/\s+/g, "");
      const connected =
        aliases.has(compact) || /\.getSubject\(\)$/.test(compact);
      if (connected) connectedIndexes.push(index);
      return connected ? "$subject" : compact;
    });
    if (connectedIndexes.length === 0) continue;
    calls.push({
      name,
      open,
      close,
      receiver,
      arguments: args,
      connectedIndexes,
      signature: `${name}(${normalized.join(",")})`,
    });
  }
  return calls;
}

function directlyForwardsSubject(text, call) {
  const code = maskJava(text, false);
  const statementStart = Math.max(
    code.lastIndexOf(";", call.open),
    code.lastIndexOf("{", call.open),
    code.lastIndexOf("}", call.open),
  ) + 1;
  const statementEnd = code.indexOf(";", call.close);
  if (statementEnd < 0) return false;
  const prefix = code.slice(statementStart, call.open);
  const suffix = code.slice(call.close + 1, statementEnd).trim();
  return (
    suffix === "" &&
    /^(?:\s*return\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*\s*$/.test(
      prefix,
    )
  );
}

function resolvedRoutingTargets(
  runtime,
  caller,
  text,
  subjectNames,
  seen = new Set(),
  subjectsByTarget = new Map(),
) {
  const targets = new Set();
  const recordTarget = (identity, parameters) => {
    targets.add(identity);
    if (!subjectsByTarget.has(identity)) {
      subjectsByTarget.set(identity, new Set());
    }
    for (const parameter of parameters) {
      subjectsByTarget.get(identity).add(parameter);
    }
  };
  for (const call of subjectCalls(text, subjectNames)) {
    const methods = methodCallTargets(runtime, caller, call).filter(
      ({ id }) => runtime.reachable.has(id),
    );
    if (methods.length === 0) {
      recordTarget(call.signature, []);
      continue;
    }
    for (const method of methods) {
      const identity = method.id;
      const connectedParameters = new Set(
        call.connectedIndexes
          .map((index) => method.parameterNames[index])
          .filter(Boolean),
      );
      if (seen.has(method.id)) {
        recordTarget(identity, connectedParameters);
        continue;
      }
      const forwardingCalls = subjectCalls(
        method.literal,
        connectedParameters,
      ).filter((candidate) => directlyForwardsSubject(method.literal, candidate));
      if (forwardingCalls.length === 0) {
        recordTarget(identity, connectedParameters);
        continue;
      }
      const forwarded = resolvedRoutingTargets(
        runtime,
        method,
        method.literal,
        connectedParameters,
        new Set(seen).add(method.id),
        subjectsByTarget,
      );
      if (forwarded.size === 0) recordTarget(identity, connectedParameters);
      else for (const target of forwarded) targets.add(target);
    }
  }
  return targets;
}

function hasTrustedSimpleImport(runtime, packageName, name) {
  const code = runtime.code;
  if (
    runtime.localQualifiedTypes.has(`${packageName}.${name}`) ||
    runtime.localSimpleTypes.has(name)
  ) {
    return false;
  }
  const conflicting = new RegExp(
    `\\bimport\\s+(?!${escapeRegExp(packageName)}\\.${escapeRegExp(name)}\\s*;)[\\w.]+\\.${escapeRegExp(name)}\\s*;`,
  ).test(code);
  if (conflicting) return false;
  return new RegExp(
    `\\bimport\\s+${escapeRegExp(packageName)}\\.${escapeRegExp(name)}\\s*;`,
  ).test(code) || new RegExp(
    `\\bimport\\s+${escapeRegExp(packageName)}\\.\\*\\s*;`,
  ).test(code);
}

function hasLocalLoggerLookalike(runtime) {
  return (
    runtime.localSimpleTypes.has("Logger") ||
    runtime.localSimpleTypes.has("LoggerFactory")
  );
}

function recognizedLoggerVariables(runtime, method) {
  if (hasLocalLoggerLookalike(runtime)) return new Set();
  const code = runtime.code;
  const types = [];
  if (!runtime.localQualifiedTypes.has("java.util.logging.Logger")) {
    types.push("java\\.util\\.logging\\.Logger");
  }
  if (!runtime.localQualifiedTypes.has("org.slf4j.Logger")) {
    types.push("org\\.slf4j\\.Logger");
  }
  if (
    !runtime.localSimpleTypes.has("System") &&
    !runtime.localQualifiedTypes.has("java.lang.System")
  ) {
    types.push("System\\.Logger");
  }
  const simplePackages = [
    "java.util.logging",
    "org.slf4j",
  ].filter((packageName) =>
    hasTrustedSimpleImport(runtime, packageName, "Logger")
  );
  if (simplePackages.length === 1) types.push("Logger");
  if (types.length === 0) return new Set();
  const variables = new Set();
  const scope = method.className
    ? classRanges(code)
      .filter(({ name }) => name === method.className)
      .map(({ start, end }) => code.slice(start, end))
      .join("\n")
    : method.code;
  const declaration = new RegExp(
    `\\b(?:${types.join("|")})\\s+([A-Za-z_$][\\w$]*)\\b`,
    "g",
  );
  for (const match of scope.matchAll(declaration)) {
    variables.add(match[1]);
  }
  return variables;
}

function hasRecognizedWarning(runtime, method, text) {
  const code = maskJava(executableMethodText(runtime, method, text), false);
  const localSystem =
    runtime.localSimpleTypes.has("System") ||
    runtime.localQualifiedTypes.has("java.lang.System");
  const localLoggerLookalike = hasLocalLoggerLookalike(runtime);
  const simpleJavaUtil = hasTrustedSimpleImport(
    runtime,
    "java.util.logging",
    "Logger",
  );
  const simpleSlf4jFactory = hasTrustedSimpleImport(
    runtime,
    "org.slf4j",
    "LoggerFactory",
  );
  if (
    (
      !localSystem &&
      /\bSystem\s*\.\s*err\s*\.\s*(?:append|format|print|printf|println|write)\s*\(/.test(
        code,
      )
    ) ||
    /\bjava\.lang\.System\s*\.\s*err\s*\.\s*(?:append|format|print|printf|println|write)\s*\(/.test(
      code,
    ) ||
    (
      !runtime.localQualifiedTypes.has("java.util.logging.Logger") &&
      /\bjava\.util\.logging\.Logger\s*\.\s*get(?:Global|Logger)\s*\([^;]*?\)\s*\.\s*(?:log|severe|warning)\s*\(/.test(
        code,
      )
    ) ||
    (
      !localLoggerLookalike &&
      simpleJavaUtil &&
      /\bLogger\s*\.\s*get(?:Global|Logger)\s*\([^;]*?\)\s*\.\s*(?:log|severe|warning)\s*\(/.test(
        code,
      )
    ) ||
    (
      !runtime.localQualifiedTypes.has("org.slf4j.LoggerFactory") &&
      /\borg\.slf4j\.LoggerFactory\s*\.\s*getLogger\s*\([^;]*?\)\s*\.\s*(?:error|info|log|warn)\s*\(/.test(
        code,
      )
    ) ||
    (
      !localLoggerLookalike &&
      simpleSlf4jFactory &&
      /\bLoggerFactory\s*\.\s*getLogger\s*\([^;]*?\)\s*\.\s*(?:error|info|log|warn)\s*\(/.test(
        code,
      )
    ) ||
    (
      !localSystem &&
      /\bSystem\s*\.\s*getLogger\s*\([^;]*?\)\s*\.\s*log\s*\(/.test(code)
    ) ||
    /\bjava\.lang\.System\s*\.\s*getLogger\s*\([^;]*?\)\s*\.\s*log\s*\(/.test(
      code,
    )
  ) {
    return true;
  }
  return [...recognizedLoggerVariables(runtime, method)].some((name) =>
    new RegExp(
      `\\b${escapeRegExp(name)}\\s*\\.\\s*(?:log|severe|warn|warning)\\s*\\(`,
    ).test(code)
  );
}

function logsUnsupportedEvent(runtime, method, text, seen = new Set()) {
  const executable = executableMethodText(runtime, method, text);
  if (hasRecognizedWarning(runtime, method, executable)) return true;
  for (const call of methodCalls(executable)) {
    for (const target of methodCallTargets(runtime, method, call)) {
      if (
        runtime.reachable.has(target.id) &&
        !seen.has(target.id) &&
        logsUnsupportedEvent(
          runtime,
          target,
          target.literal,
          new Set(seen).add(target.id),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function switchArms(code, literal, bodyOpen, bodyClose) {
  const bodyCode = code.slice(bodyOpen + 1, bodyClose);
  const bodyLiteral = literal.slice(bodyOpen + 1, bodyClose);
  const candidates = Array.from(
    bodyCode.matchAll(/\b(case\s+([^:>-]+)|default)\s*(->|:)/g),
  );
  const labels = [];
  let cursor = 0;
  let braces = 0;
  for (const candidate of candidates) {
    for (; cursor < candidate.index; cursor += 1) {
      if (bodyCode[cursor] === "{") braces += 1;
      else if (bodyCode[cursor] === "}") braces -= 1;
    }
    if (braces === 0) labels.push(candidate);
  }
  return labels.map((label, index) => {
    const start = label.index + label[0].length;
    const end = labels[index + 1]?.index ?? bodyCode.length;
    return {
      default: label[1] === "default",
      expression: label[2] ?? "",
      arrow: label[3] === "->",
      code: bodyCode.slice(start, end),
      literal: bodyLiteral.slice(start, end),
    };
  });
}

function nestedControlRanges(text) {
  const code = maskJava(text, false);
  const ranges = [];
  for (const match of code.matchAll(/\b(?:for|while|switch)\s*\(/g)) {
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    if (close < 0) continue;
    const start = skipWhitespace(code, close + 1);
    let end;
    if (code[start] === "{") {
      const bodyClose = matchingIndex(code, start, "{", "}");
      end = bodyClose < 0 ? -1 : bodyClose + 1;
    } else {
      end = javaStatementEnd(code, start);
    }
    if (end >= 0) ranges.push({ start, end });
  }
  for (const match of code.matchAll(/\bdo\b/g)) {
    const end = javaStatementEnd(code, match.index);
    if (end >= 0) ranges.push({ start: match.index, end });
  }
  return ranges;
}

function loopControlRanges(text) {
  const code = maskJava(text, false);
  const ranges = [];
  for (const match of code.matchAll(
    /(?:(\b[A-Za-z_$][\w$]*)\s*:\s*)?\b(for|while)\s*\(/g,
  )) {
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    if (close < 0) continue;
    const start = skipWhitespace(code, close + 1);
    let end;
    if (code[start] === "{") {
      const bodyClose = matchingIndex(code, start, "{", "}");
      end = bodyClose < 0 ? -1 : bodyClose + 1;
    } else {
      end = javaStatementEnd(code, start);
    }
    if (end >= 0) {
      ranges.push({
        start: match.index,
        end,
        label: match[1] ?? null,
      });
    }
  }
  for (const match of code.matchAll(
    /(?:(\b[A-Za-z_$][\w$]*)\s*:\s*)?\bdo\b/g,
  )) {
    const statementStart = code.indexOf("do", match.index);
    const bodyStart = skipWhitespace(code, statementStart + 2);
    const bodyEnd = javaStatementEnd(code, bodyStart);
    const whileStart = skipWhitespace(code, bodyEnd);
    const conditionOpen = startsWithWord(code, whileStart, "while")
      ? code.indexOf("(", whileStart)
      : -1;
    const conditionClose = matchingIndex(code, conditionOpen);
    const semicolon = skipWhitespace(code, conditionClose + 1);
    const end = code[semicolon] === ";" ? semicolon + 1 : -1;
    if (bodyEnd >= 0 && conditionOpen >= 0 && conditionClose >= 0 && end >= 0) {
      ranges.push({
        start: match.index,
        end,
        label: match[1] ?? null,
        continuePosition: conditionOpen + 1,
      });
    }
  }
  return ranges;
}

function classicForHeaderParts(text, open, close) {
  const header = text.slice(open + 1, close);
  const code = maskJava(header, false);
  const separators = [];
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < code.length; index += 1) {
    const character = code[index];
    if (character in depth) {
      depth[character] += 1;
    } else if (character in closing) {
      depth[closing[character]] -= 1;
    } else if (
      character === ";" &&
      Object.values(depth).every((value) => value === 0)
    ) {
      separators.push(index);
    }
  }
  if (separators.length !== 2) return null;
  return {
    initialization: text.slice(
      open + 1,
      open + 1 + separators[0],
    ),
    condition: text.slice(
      open + 1 + separators[0] + 1,
      open + 1 + separators[1],
    ),
    update: text.slice(open + 1 + separators[1] + 1, close),
    updateStart: open + 1 + separators[1] + 1,
    updateEnd: close,
  };
}

const normalizedForUpdateMarker = "/*__hyoka_for_cycle__*/";

function forLoopUpdateRanges(text) {
  const code = maskJava(text, false);
  const ranges = [];
  for (const match of code.matchAll(
    /(?:(\b[A-Za-z_$][\w$]*)\s*:\s*)?\bfor\s*\(/g,
  )) {
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    if (close < 0) continue;
    const header = classicForHeaderParts(text, open, close);
    if (
      !header ||
      header.update.includes(normalizedForUpdateMarker)
    ) {
      continue;
    }
    const bodyStart = skipWhitespace(code, close + 1);
    const bodyEnd = javaStatementEnd(code, bodyStart);
    if (bodyEnd < 0) continue;
    ranges.push({
      start: match.index,
      end: bodyEnd,
      label: match[1] ?? null,
      bodyStart,
      bodyEnd,
      braced: code[bodyStart] === "{",
      ...header,
    });
  }
  return ranges;
}

function normalizeForLoopUpdates(text) {
  let normalized = text;
  for (let pass = 0; pass < 64; pass += 1) {
    const loop = forLoopUpdateRanges(normalized)
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      )[0];
    if (!loop) break;

    const updates = splitTopLevel(loop.update)
      .filter((expression) => expression.trim())
      .map((expression) => `${expression.trim()};`)
      .join("\n");
    const condition = loop.condition.trim();
    const cycle = `${updates}${
      condition ? `\nBoolean.valueOf(${condition});` : ""
    }`;
    const contentStart = loop.braced ? loop.bodyStart + 1 : loop.bodyStart;
    const contentEnd = loop.braced ? loop.bodyEnd - 1 : loop.bodyEnd;
    let body = normalized.slice(contentStart, contentEnd);
    const insertions = [];
    const bodyCode = maskJava(body, false);
    for (const match of bodyCode.matchAll(
      /\bcontinue(?:\s+([A-Za-z_$][\w$]*))?\s*;/g,
    )) {
      const position = contentStart + match.index;
      const target = continueTarget(
        normalized,
        position,
        match[1] ?? null,
      );
      if (target?.start === loop.start && target.end === loop.end) {
        insertions.push(match.index);
      }
    }
    const exitsThroughBreak = Array.from(
      bodyCode.matchAll(/\bbreak(?:\s+([A-Za-z_$][\w$]*))?\s*;/g),
    ).some((match) => {
      const position = contentStart + match.index;
      return breakTargetEnd(
        normalized,
        position,
        match[1] ?? null,
      ) === loop.end;
    });
    for (const position of insertions.toReversed()) {
      body = `${body.slice(0, position)}${cycle}\n${body.slice(position)}`;
    }
    const rewrittenBody = loop.braced
      ? `{${body}\n${cycle}\n}`
      : `{\n${body}\n${cycle}\n}`;
    const finalCondition = condition && !exitsThroughBreak
      ? `\nBoolean.valueOf(${condition});`
      : "";
    const blankUpdate = normalizedForUpdateMarker + normalized
      .slice(loop.updateStart, loop.updateEnd)
      .replace(/[^\r\n]/g, " ");
    normalized = `${normalized.slice(0, loop.updateStart)}${blankUpdate}${
      normalized.slice(loop.updateEnd, loop.bodyStart)
    }${rewrittenBody}${finalCondition}${normalized.slice(loop.bodyEnd)}`;
  }
  return normalized;
}

function continueTarget(text, position, label = null) {
  const containing = loopControlRanges(text)
    .filter(({ start, end }) => start <= position && position < end)
    .sort((left, right) => left.end - left.start - (right.end - right.start));
  if (label) {
    return containing.find((candidate) => candidate.label === label) ?? null;
  }
  return containing[0] ?? null;
}

function continueTargetEnd(text, position, label = null) {
  return continueTarget(text, position, label)?.end ?? null;
}

function continueTargetPosition(text, position, label = null) {
  const target = continueTarget(text, position, label);
  return target?.continuePosition ?? target?.end ?? null;
}

function labeledStatementRanges(text) {
  const code = maskJava(text, false);
  const ranges = [];
  for (const match of code.matchAll(
    /(?:^|[;{}:])\s*([A-Za-z_$][\w$]*)\s*:\s*/g,
  )) {
    const label = match[1];
    if (label === "case" || label === "default") continue;
    const colon = code.indexOf(":", match.index);
    const statementStart = skipWhitespace(code, colon + 1);
    const end = javaStatementEnd(code, statementStart);
    if (end >= 0) {
      ranges.push({
        start: match.index,
        end,
        label,
      });
    }
  }
  return ranges;
}

function breakTargetEnd(text, position, label = null) {
  if (label) {
    return labeledStatementRanges(text)
      .filter(
        (candidate) =>
          candidate.label === label &&
          candidate.start <= position &&
          position < candidate.end,
      )
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      )[0]?.end ?? null;
  }
  return nestedControlRanges(text)
    .filter(({ start, end }) => start <= position && position < end)
    .sort(
      (left, right) =>
        left.end - left.start - (right.end - right.start),
    )[0]?.end ?? null;
}

function tryFinallyRanges(text) {
  const code = maskJava(text, false);
  const ranges = [];
  for (const match of code.matchAll(/\btry\b/g)) {
    let cursor = skipWhitespace(code, match.index + match[0].length);
    if (code[cursor] === "(") {
      const resourcesEnd = matchingIndex(code, cursor);
      if (resourcesEnd < 0) continue;
      cursor = skipWhitespace(code, resourcesEnd + 1);
    }
    const tryBodyStart = cursor;
    const tryBodyEnd = javaStatementEnd(code, tryBodyStart);
    if (tryBodyEnd < 0) continue;
    const protectedRanges = [
      { start: tryBodyStart, end: tryBodyEnd },
    ];
    cursor = tryBodyEnd;
    while (true) {
      const catchWord = skipWhitespace(code, cursor);
      if (!startsWithWord(code, catchWord, "catch")) break;
      const open = code.indexOf("(", catchWord + 5);
      const close = matchingIndex(code, open);
      if (open < 0 || close < 0) {
        cursor = -1;
        break;
      }
      const catchBodyStart = skipWhitespace(code, close + 1);
      const catchBodyEnd = javaStatementEnd(code, catchBodyStart);
      if (catchBodyEnd < 0) {
        cursor = -1;
        break;
      }
      protectedRanges.push({
        start: catchBodyStart,
        end: catchBodyEnd,
      });
      cursor = catchBodyEnd;
    }
    if (cursor < 0) continue;
    const finallyWord = skipWhitespace(code, cursor);
    if (!startsWithWord(code, finallyWord, "finally")) continue;
    const finallyStatementStart = skipWhitespace(code, finallyWord + 7);
    const finallyStatementEnd = javaStatementEnd(
      code,
      finallyStatementStart,
    );
    if (finallyStatementEnd < 0) continue;
    const braced = code[finallyStatementStart] === "{";
    ranges.push({
      start: match.index,
      end: finallyStatementEnd,
      protectedRanges,
      bodyStart: braced
        ? finallyStatementStart + 1
        : finallyStatementStart,
      bodyEnd: braced
        ? finallyStatementEnd - 1
        : finallyStatementEnd,
    });
  }
  return ranges;
}

function abruptControls(text) {
  const code = maskJava(text, false);
  const deferred = functionalExecutionAnalysis(text).functions;
  const nestedMethods = parseMethods(code, text);
  const controls = [];
  for (const match of code.matchAll(/\b(return|throw|continue|break)\b/g)) {
    if (
      parsedMethodOwnerAt(nestedMethods, match.index) ||
      deferred.some(
        ({ start, end }) => start <= match.index && match.index < end,
      )
    ) {
      continue;
    }
    const end = javaStatementEnd(code, match.index);
    if (end < 0) continue;
    const statement = text.slice(match.index, end);
    const control = match[1];
    const normalized = statement.trim();
    if (
      !normalized.endsWith(";") ||
      (
        ["continue", "break"].includes(control) &&
        !new RegExp(
          `^${control}(?:\\s+[A-Za-z_$][\\w$]*)?\\s*;$`,
          "s",
        ).test(normalized)
      )
    ) {
      continue;
    }
    const label = /^(?:continue|break)\s+([A-Za-z_$][\w$]*)\s*;$/s.exec(
      normalized,
    )?.[1] ?? null;
    const expression = ["return", "throw"].includes(control)
      ? statement
        .trim()
        .slice(control.length, -1)
        .trim()
      : "";
    controls.push({
      id: controls.length,
      control,
      expression,
      label,
      position: match.index,
      end,
      statement,
      targetPosition: control === "continue"
        ? continueTargetPosition(text, match.index, label)
        : control === "break"
          ? breakTargetEnd(text, match.index, label)
          : null,
    });
  }
  return controls;
}

function expandAbruptFinalizers(text) {
  const finalizers = tryFinallyRanges(text);
  if (finalizers.length === 0) return text;
  const controls = abruptControls(text);
  if (controls.length === 0) return text;
  const rangeCache = new Map();
  const replacementCache = new Map();

  const controlFinalizers = (control) =>
    finalizers
      .filter(({ protectedRanges }) =>
        protectedRanges.some(({ start, end }) =>
          start <= control.position && control.position < end
        )
      )
      .filter(({ start, end }) =>
        control.targetPosition === null ||
        control.targetPosition < start ||
        control.targetPosition >= end
      )
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      );

  const expandRange = (start, end) => {
    const key = `${start}:${end}`;
    if (rangeCache.has(key)) return rangeCache.get(key);
    let cursor = start;
    let expanded = "";
    for (const control of controls) {
      if (control.position < start || control.end > end) continue;
      expanded += text.slice(cursor, control.position);
      expanded += controlReplacement(control);
      cursor = control.end;
    }
    expanded += text.slice(cursor, end);
    rangeCache.set(key, expanded);
    return expanded;
  };

  const controlReplacement = (control) => {
    if (replacementCache.has(control.id)) {
      return replacementCache.get(control.id);
    }
    const cleanup = controlFinalizers(control)
      .map(({ bodyStart, bodyEnd }) => expandRange(bodyStart, bodyEnd))
      .join("\n");
    if (!cleanup.trim()) {
      replacementCache.set(control.id, control.statement);
      return control.statement;
    }
    let abrupt = control.statement;
    if (control.expression && ["return", "throw"].includes(control.control)) {
      const captured = `__hyoka_abrupt_${control.id}`;
      abrupt = `var ${captured} = ${control.expression};
${cleanup}
${control.control} ${captured};`;
    } else {
      abrupt = `${cleanup}
${control.statement}`;
    }
    const replacement = `{
${abrupt}
}`;
    replacementCache.set(control.id, replacement);
    return replacement;
  };

  return expandRange(0, text.length);
}

function switchTerminator(text) {
  const code = maskJava(text, false);
  const nested = nestedControlRanges(text);
  for (const match of code.matchAll(
    /\b(break|continue)(?:\s+([A-Za-z_$][\w$]*))?\s*;|\b(return|throw)\b/g,
  )) {
    const kind = match[1] ?? match[3];
    const label = match[2] ?? null;
    const inNested = nested.some(
      ({ start, end }) => start <= match.index && match.index < end,
    );
    if (
      inNested &&
      !(
        label &&
        continueTargetEnd(text, match.index, label) === null
      )
    ) {
      continue;
    }
    const control = assignmentControl({ literal: text }, match.index);
    if (!control.reachable || control.conditional) continue;
    const semicolon = code.indexOf(";", match.index);
    return {
      start: match.index,
      end: semicolon < 0 ? text.length : semicolon + 1,
      kind,
      label,
    };
  }
  return null;
}

function unconditionalSwitchTerminator(text) {
  return switchTerminator(text)?.end ?? -1;
}

function switchArmExecution(arms, start) {
  let code = "";
  let literal = "";
  for (let index = start; index < arms.length; index += 1) {
    const arm = arms[index];
    const terminator = unconditionalSwitchTerminator(arm.literal);
    const end = terminator < 0 ? arm.literal.length : terminator;
    code += arm.code.slice(0, end);
    literal += arm.literal.slice(0, end);
    if (arm.arrow || terminator >= 0) break;
  }
  return { code, literal };
}

function routingFallbackWarns(
  runtime,
  method,
  code,
  literal,
  constants,
  eventTypeParameters,
) {
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const known = new Set();
    let cursor = match.index;
    let fallback = "";
    for (let depth = 0; depth < 16; depth += 1) {
      const conditional = conditionalAt(code, cursor);
      if (!conditional) break;
      const eventTypeNames = subjectAliases(
        method.literal,
        eventTypeParameters,
        cursor,
      );
      const eventTypeStrings = eventTypeStringEnvironmentAt(
        runtime,
        method,
        cursor,
      );
      const conditionOpen = code.indexOf("(", cursor);
      const conditionClose = matchingIndex(code, conditionOpen);
      const condition = literal.slice(
        conditionOpen + 1,
        conditionClose,
      );
      if (
        positiveEventTypeCondition(
          runtime,
          method,
          condition,
          eventTypeStrings,
          "Microsoft.Storage.BlobCreated",
          eventTypeNames,
          cursor,
        )
      ) {
        known.add("created");
      }
      if (
        positiveEventTypeCondition(
          runtime,
          method,
          condition,
          eventTypeStrings,
          "Microsoft.Storage.BlobDeleted",
          eventTypeNames,
          cursor,
        )
      ) {
        known.add("deleted");
      }
      if (
        conditional.alternateStart >= 0 &&
        startsWithWord(code, conditional.alternateStart, "if")
      ) {
        cursor = conditional.alternateStart;
        continue;
      }
      fallback = statementBody(
        literal,
        conditional.alternateStart,
        conditional.alternateEnd,
      );
      break;
    }
    if (
      known.has("created") &&
      known.has("deleted") &&
      logsUnsupportedEvent(runtime, method, fallback)
    ) {
      return true;
    }
  }

  const terminating = [];
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const conditional = conditionalAt(code, match.index);
    if (!conditional || conditional.alternateStart >= 0) continue;
    const body = statementBody(
      literal,
      conditional.consequentStart,
      conditional.consequentEnd,
    );
    if (!/\b(?:return|throw)\b/.test(maskJava(body, false))) continue;
    const eventTypeNames = subjectAliases(
      method.literal,
      eventTypeParameters,
      match.index,
    );
    const eventTypeStrings = eventTypeStringEnvironmentAt(
      runtime,
      method,
      match.index,
    );
    const conditionOpen = code.indexOf("(", match.index);
    const conditionClose = matchingIndex(code, conditionOpen);
    const condition = literal.slice(
      conditionOpen + 1,
      conditionClose,
    );
    if (
      positiveEventTypeCondition(
        runtime,
        method,
        condition,
        eventTypeStrings,
        "Microsoft.Storage.BlobCreated",
        eventTypeNames,
        match.index,
      )
    ) {
      terminating.push({ type: "created", end: conditional.end });
    }
    if (
      positiveEventTypeCondition(
        runtime,
        method,
        condition,
        eventTypeStrings,
        "Microsoft.Storage.BlobDeleted",
        eventTypeNames,
        match.index,
      )
    ) {
      terminating.push({ type: "deleted", end: conditional.end });
    }
  }
  const created = terminating.filter(({ type }) => type === "created");
  const deleted = terminating.filter(({ type }) => type === "deleted");
  for (const left of created) {
    for (const right of deleted) {
      if (
        logsUnsupportedEvent(
          runtime,
          method,
          literal.slice(Math.max(left.end, right.end)),
        )
      ) {
        return true;
      }
    }
  }

  for (const match of code.matchAll(/\bswitch\s*\(/g)) {
    const conditionOpen = code.indexOf("(", match.index);
    const conditionClose = matchingIndex(code, conditionOpen);
    const bodyOpen = code.indexOf("{", conditionClose);
    const bodyClose = matchingIndex(code, bodyOpen, "{", "}");
    if (conditionClose < 0 || bodyOpen < 0 || bodyClose < 0) continue;
    const arms = switchArms(code, literal, bodyOpen, bodyClose);
    let hasCreated = false;
    let hasDeleted = false;
    let fallback = "";
    for (let index = 0; index < arms.length; index += 1) {
      const arm = arms[index];
      if (arm.default) {
        fallback = switchArmExecution(arms, index).literal;
      } else {
        hasCreated = hasCreated || eventTypeReference(
          arm.expression,
          constants,
          "Microsoft.Storage.BlobCreated",
        );
        hasDeleted = hasDeleted || eventTypeReference(
          arm.expression,
          constants,
          "Microsoft.Storage.BlobDeleted",
        );
      }
    }
    if (
      hasCreated &&
      hasDeleted &&
      logsUnsupportedEvent(runtime, method, fallback)
    ) {
      return true;
    }
  }
  return false;
}

function routesEvents(runtime, method, constants) {
  const text = method.literal;
  const code = maskJava(text, false);
  const literal = maskJava(text, true);
  const { eventTypeParameters, subjectParameters } = routingParameterRoles(
    runtime,
    method,
  );
  const createdTargets = new Set();
  const deletedTargets = new Set();
  const subjectsByTarget = new Map();
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const conditional = conditionalAt(code, match.index);
    if (!conditional) continue;
    const condition = literal.slice(
      code.indexOf("(", match.index) + 1,
      matchingIndex(code, code.indexOf("(", match.index)),
    );
    const eventTypeNames = subjectAliases(
      method.literal,
      eventTypeParameters,
      match.index,
    );
    const eventTypeStrings = eventTypeStringEnvironmentAt(
      runtime,
      method,
      match.index,
    );
    const subjectNames = subjectAliases(
      method.literal,
      subjectParameters,
      conditional.consequentStart,
    );
    const targets = resolvedRoutingTargets(
      runtime,
      method,
      statementBody(
        literal,
        conditional.consequentStart,
        conditional.consequentEnd,
      ),
      subjectNames,
      new Set(),
      subjectsByTarget,
    );
    if (
      positiveEventTypeCondition(
        runtime,
        method,
        condition,
        eventTypeStrings,
        "Microsoft.Storage.BlobCreated",
        eventTypeNames,
        match.index,
      )
    ) {
      for (const target of targets) createdTargets.add(target);
    }
    if (
      positiveEventTypeCondition(
        runtime,
        method,
        condition,
        eventTypeStrings,
        "Microsoft.Storage.BlobDeleted",
        eventTypeNames,
        match.index,
      )
    ) {
      for (const target of targets) deletedTargets.add(target);
    }
  }
  for (const match of code.matchAll(/\bswitch\s*\(/g)) {
    const conditionOpen = code.indexOf("(", match.index);
    const conditionClose = matchingIndex(code, conditionOpen);
    const bodyOpen = code.indexOf("{", conditionClose);
    const bodyClose = matchingIndex(code, bodyOpen, "{", "}");
    if (conditionClose < 0 || bodyOpen < 0 || bodyClose < 0) continue;
    const eventTypeNames = subjectAliases(
      method.literal,
      eventTypeParameters,
      match.index,
    );
    if (
      !expressionUsesAnyName(
        literal.slice(conditionOpen + 1, conditionClose),
        eventTypeNames,
      )
    ) {
      continue;
    }
    const subjectNames = subjectAliases(
      method.literal,
      subjectParameters,
      bodyOpen,
    );
    const arms = switchArms(code, literal, bodyOpen, bodyClose);
    for (let index = 0; index < arms.length; index += 1) {
      if (arms[index].default) continue;
      const targets = resolvedRoutingTargets(
        runtime,
        method,
        switchArmExecution(arms, index).literal,
        subjectNames,
        new Set(),
        subjectsByTarget,
      );
      if (
        eventTypeReference(
          arms[index].expression,
          constants,
          "Microsoft.Storage.BlobCreated",
        )
      ) {
        for (const target of targets) createdTargets.add(target);
      }
      if (
        eventTypeReference(
          arms[index].expression,
          constants,
          "Microsoft.Storage.BlobDeleted",
        )
      ) {
        for (const target of targets) deletedTargets.add(target);
      }
    }
  }
  const distinctTargets = [...createdTargets].some(
    (created) => !deletedTargets.has(created),
  ) || [...deletedTargets].some((deleted) => !createdTargets.has(deleted));
  return (
    /\b(?:if|switch)\b/.test(code) &&
    eventTypeParameters.size > 0 &&
    createdTargets.size > 0 &&
    deletedTargets.size > 0 &&
    distinctTargets &&
    [...createdTargets].some((target) =>
      routingTargetHasCreatedBehavior(runtime, target)
    ) &&
    [...deletedTargets].some((target) =>
      routingTargetHasDeletedBehavior(
        runtime,
        target,
        subjectsByTarget.get(target),
      )
    ) &&
    routingFallbackWarns(
      runtime,
      method,
      code,
      literal,
      constants,
      eventTypeParameters,
    )
  );
}

function routingParameterRoles(runtime, method) {
  const code = maskJava(method.literal, false);
  const literal = maskJava(method.literal, true);
  const eventTypeParameters = new Set();
  for (const parameter of method.parameterNames) {
    for (const match of code.matchAll(/\bif\s*\(/g)) {
      const open = code.indexOf("(", match.index);
      const close = matchingIndex(code, open);
      if (close < 0) continue;
      const aliases = subjectAliases(
        method.literal,
        new Set([parameter]),
        match.index,
      );
      const condition = literal.slice(open + 1, close);
      const eventTypeStrings = eventTypeStringEnvironmentAt(
        runtime,
        method,
        match.index,
      );
      if (
        positiveEventTypeCondition(
          runtime,
          method,
          condition,
          eventTypeStrings,
          "Microsoft.Storage.BlobCreated",
          aliases,
          match.index,
        ) ||
        positiveEventTypeCondition(
          runtime,
          method,
          condition,
          eventTypeStrings,
          "Microsoft.Storage.BlobDeleted",
          aliases,
          match.index,
        )
      ) {
        eventTypeParameters.add(parameter);
      }
    }
  }
  for (const match of code.matchAll(
    /\bswitch\s*\(/g,
  )) {
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    const bodyOpen = code.indexOf("{", close);
    const bodyClose = matchingIndex(code, bodyOpen, "{", "}");
    if (close < 0 || bodyOpen < 0 || bodyClose < 0) continue;
    const switchExpression = literal.slice(open + 1, close);
    const switchBody = literal.slice(bodyOpen + 1, bodyClose);
    if (
      !eventTypeReference(
        switchBody,
        runtime.literal,
        "Microsoft.Storage.BlobCreated",
      ) &&
      !eventTypeReference(
        switchBody,
        runtime.literal,
        "Microsoft.Storage.BlobDeleted",
      )
    ) {
      continue;
    }
    for (const parameter of method.parameterNames) {
      const aliases = subjectAliases(
        method.literal,
        new Set([parameter]),
        match.index,
      );
      if (expressionUsesAnyName(switchExpression, aliases)) {
        eventTypeParameters.add(parameter);
      }
    }
  }
  const subjectParameters = new Set(
    method.parameterNames.filter((name) => !eventTypeParameters.has(name)),
  );
  const subjectNames = subjectAliases(
    method.literal,
    subjectParameters,
    method.literal.length,
  );
  return {
    eventTypeNames: subjectAliases(
      method.literal,
      eventTypeParameters,
      method.literal.length,
    ),
    eventTypeParameters,
    subjectNames,
    subjectParameters: new Set(
      method.parameterNames.filter((name) => subjectParameters.has(name)),
    ),
  };
}

function hasRoutingMethod(runtime, async) {
  return reachableMethods(runtime, async).some((method) =>
    routesEvents(runtime, method, runtime.literal)
  );
}

function routingTargetMethods(runtime, target) {
  return runtime.methods.filter((method) => method.id === target);
}

function routingTargetHasCreatedBehavior(runtime, target) {
  return routingTargetMethods(runtime, target).some((method) =>
    closureVariants(runtime, method).some((text) => {
      const code = maskJava(text, false);
      return (
        /\.getBlob(?:Async)?Client\s*\(/.test(code) &&
        /\.getProperties\s*\(/.test(code) &&
        /\.(?:downloadContent|downloadStream)\s*\(/.test(code)
      );
    })
  );
}

function deletionMeaning(expression, aliases) {
  const literal = maskJava(expression, true);
  const hasLiteral = Array.from(
    literal.matchAll(/"(?:\\.|[^"\\])*"/g),
    (match) => javaStringValue(match[0]),
  ).some((value) => typeof value === "string" && /delet|remov/i.test(value));
  return hasLiteral || expressionUsesAnyName(expression, aliases);
}

function derivedAliases(text, initial, endPosition, predicate) {
  const aliases = new Set(initial);
  const method = { literal: text };
  for (const assignment of flowAssignmentEvents(method, endPosition)) {
    const derived = predicate(assignment.expression, aliases);
    if (assignment.conditional) {
      if (!aliases.has(assignment.name) || !derived) {
        aliases.delete(assignment.name);
      }
    } else if (derived) {
      aliases.add(assignment.name);
    } else {
      aliases.delete(assignment.name);
    }
  }
  return aliases;
}

function authenticLoggerExpression(runtime, expression, environment) {
  const value = unwrapParentheses(expression);
  const compact = maskJava(value, false).replace(/\s+/g, "");
  if (/^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*$/.test(compact)) {
    if (
      environment.has(compact) ||
      (
        compact.startsWith("this.") &&
        environment.has(compact.slice("this.".length))
      )
    ) {
      return true;
    }
  }

  const localSystem =
    runtime.localSimpleTypes.has("System") ||
    runtime.localQualifiedTypes.has("java.lang.System");
  if (
    (!localSystem && /^System\.(?:out|err)$/.test(compact)) ||
    /^java\.lang\.System\.(?:out|err)$/.test(compact)
  ) {
    return true;
  }
  if (
    (!localSystem && /^System\.getLogger\([\s\S]*\)$/.test(compact)) ||
    /^java\.lang\.System\.getLogger\([\s\S]*\)$/.test(compact)
  ) {
    return true;
  }

  const localLoggerLookalike = hasLocalLoggerLookalike(runtime);
  const simpleJavaUtil = hasTrustedSimpleImport(
    runtime,
    "java.util.logging",
    "Logger",
  );
  if (
    (
      !runtime.localQualifiedTypes.has("java.util.logging.Logger") &&
      /^java\.util\.logging\.Logger\.get(?:Global|Logger)\([\s\S]*\)$/.test(
        compact,
      )
    ) ||
    (
      !localLoggerLookalike &&
      simpleJavaUtil &&
      /^Logger\.get(?:Global|Logger)\([\s\S]*\)$/.test(compact)
    )
  ) {
    return true;
  }

  const simpleSlf4jFactory = hasTrustedSimpleImport(
    runtime,
    "org.slf4j",
    "LoggerFactory",
  );
  return (
    !runtime.localQualifiedTypes.has("org.slf4j.LoggerFactory") &&
    /^org\.slf4j\.LoggerFactory\.getLogger\([\s\S]*\)$/.test(compact)
  ) || (
    !localLoggerLookalike &&
    simpleSlf4jFactory &&
    /^LoggerFactory\.getLogger\([\s\S]*\)$/.test(compact)
  );
}

function loggerFieldEnvironment(runtime, method) {
  runtime.loggerFieldEnvironments ??= new Map();
  if (runtime.loggerFieldEnvironments.has(method.className)) {
    return new Set(runtime.loggerFieldEnvironments.get(method.className));
  }
  const owners = classRanges(runtime.code);
  const ownerAt = (position) =>
    owners
      .filter(({ start, end }) => start <= position && position < end)
      .sort(
        (left, right) =>
          left.end - left.start - (right.end - right.start),
      )[0]?.name ?? "";
  const fields = fieldOnlyLiteral(runtime);
  const fieldNames = new Set(
    Array.from(
      maskJava(fields, false).matchAll(
        /\b(?:java\.util\.logging\.Logger|org\.slf4j\.Logger|System\.Logger|java\.io\.PrintStream|Logger|PrintStream)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]+)?;/g,
      ),
      (match) => ownerAt(match.index) === method.className ? match[1] : null,
    ).filter(Boolean),
  );
  const environment = new Set();
  for (const assignment of flowAssignmentEvents({ literal: fields })) {
    const owner = ownerAt(assignment.position);
    if (
      owner !== method.className ||
      !fieldNames.has(assignment.name)
    ) {
      continue;
    }
    if (authenticLoggerExpression(runtime, assignment.expression, environment)) {
      environment.add(assignment.name);
    } else {
      environment.delete(assignment.name);
    }
  }
  const constructors = runtime.methods.filter((candidate) =>
    candidate.className === method.className &&
    candidate.name === method.className
  );
  const constructorEnvironments = constructors.map((constructor) => {
    const assigned = new Set(environment);
    for (const assignment of loggerAssignmentEvents(constructor.literal)) {
      if (!fieldNames.has(assignment.name)) continue;
      const authentic = authenticLoggerExpression(
        runtime,
        assignment.expression,
        assigned,
      );
      if (assignment.conditional) {
        if (!assigned.has(assignment.name) || !authentic) {
          assigned.delete(assignment.name);
        }
      } else if (authentic) {
        assigned.add(assignment.name);
      } else {
        assigned.delete(assignment.name);
      }
    }
    return assigned;
  });
  if (constructorEnvironments.length > 0) {
    for (const name of fieldNames) {
      if (constructorEnvironments.every((candidate) => candidate.has(name))) {
        environment.add(name);
      } else {
        environment.delete(name);
      }
    }
  }
  const expanded = new Set(environment);
  for (const name of environment) {
    expanded.add(`${method.className}.${name}`);
    expanded.add(`this.${name}`);
  }
  runtime.loggerFieldEnvironments.set(method.className, expanded);
  return new Set(expanded);
}

function loggerAssignmentEvents(text) {
  const method = { literal: text };
  const assignments = flowAssignmentEvents(method);
  const initialized = assignments
    .filter(({ declaration }) => declaration)
    .map(({ position, end }) => ({ position, end }));
  const structural = maskJava(text, false);
  const uninitialized = Array.from(
    structural.matchAll(
      /\b(?:java\.util\.logging\.Logger|org\.slf4j\.Logger|System\.Logger|java\.io\.PrintStream|Logger|PrintStream)\s+([A-Za-z_$][\w$]*)\s*;/g,
    ),
    (match) => ({
      position: match.index,
      end: match.index + match[0].length,
      name: match[1],
      expression: "",
      declaration: true,
      ...assignmentControl(method, match.index),
    }),
  ).filter(({ position }) =>
    !initialized.some(
      ({ position: start, end }) => start <= position && position < end,
    )
  );
  return [...assignments, ...uninitialized]
    .filter(({ reachable }) => reachable)
    .sort((left, right) => left.position - right.position);
}

function loggerReceiversOnPath(runtime, method, text) {
  const environment = loggerFieldEnvironment(runtime, method);
  for (const assignment of loggerAssignmentEvents(text)) {
    const authentic = authenticLoggerExpression(
      runtime,
      assignment.expression,
      environment,
    );
    if (assignment.conditional) {
      if (!environment.has(assignment.name) || !authentic) {
        environment.delete(assignment.name);
      }
    } else if (authentic) {
      environment.add(assignment.name);
    } else {
      environment.delete(assignment.name);
    }
  }
  return environment;
}

function recognizedLoggerReceiversAt(runtime, method, text, endPosition) {
  const variants = completedConditionalVariants(text, endPosition);
  const receivers = (
    variants.length > 0 ? variants : [text.slice(0, endPosition)]
  ).map((variant) => loggerReceiversOnPath(runtime, method, variant));
  if (receivers.length === 0) return new Set();
  return new Set(
    [...receivers[0]].filter((name) =>
      receivers.slice(1).every((candidate) => candidate.has(name))
    ),
  );
}

function recognizedDeletionLoggerCall(runtime, method, text, call) {
  if (![
    "append",
    "error",
    "format",
    "info",
    "log",
    "print",
    "printf",
    "println",
    "severe",
    "warn",
    "warning",
    "write",
  ].includes(call.name)) {
    return false;
  }
  if (
    call.receiver &&
    recognizedLoggerReceiversAt(
      runtime,
      method,
      text,
      call.position,
    ).has(call.receiver)
  ) {
    return true;
  }
  const code = maskJava(text, false);
  const statementStart = Math.max(
    code.lastIndexOf(";", call.position - 1),
    code.lastIndexOf("{", call.position - 1),
    code.lastIndexOf("}", call.position - 1),
  ) + 1;
  const open = code.indexOf("(", call.position);
  const close = matchingIndex(code, open);
  const statement = code.slice(
    statementStart,
    close < 0 ? call.position + call.name.length : close + 1,
  );
  const localSystem =
    runtime.localSimpleTypes.has("System") ||
    runtime.localQualifiedTypes.has("java.lang.System");
  if (
    !localSystem &&
    /\bSystem\s*\.\s*(?:out|err)\s*\.\s*(?:append|format|print|printf|println|write)\s*\(/.test(
      statement,
    )
  ) {
    return true;
  }
  if (
    /\bjava\.lang\.System\s*\.\s*(?:out|err)\s*\.\s*(?:append|format|print|printf|println|write)\s*\(/.test(
      statement,
    )
  ) {
    return true;
  }
  const localLoggerLookalike = hasLocalLoggerLookalike(runtime);
  const simpleJavaUtil = hasTrustedSimpleImport(
    runtime,
    "java.util.logging",
    "Logger",
  );
  const simpleSlf4jFactory = hasTrustedSimpleImport(
    runtime,
    "org.slf4j",
    "LoggerFactory",
  );
  if (
    !runtime.localQualifiedTypes.has("java.util.logging.Logger") &&
    /\bjava\.util\.logging\.Logger\s*\.\s*get(?:Global|Logger)\s*\([^;]*?\)\s*\.\s*(?:info|log|warning)\s*\(/.test(
      statement,
    )
  ) {
    return true;
  }
  if (
    !localLoggerLookalike &&
    simpleJavaUtil &&
    /\bLogger\s*\.\s*get(?:Global|Logger)\s*\([^;]*?\)\s*\.\s*(?:info|log|warning)\s*\(/.test(
      statement,
    )
  ) {
    return true;
  }
  if (
    !runtime.localQualifiedTypes.has("org.slf4j.LoggerFactory") &&
    /\borg\.slf4j\.LoggerFactory\s*\.\s*getLogger\s*\([^;]*?\)\s*\.\s*(?:error|info|log|warn)\s*\(/.test(
      statement,
    )
  ) {
    return true;
  }
  if (
    !localLoggerLookalike &&
    simpleSlf4jFactory &&
    /\bLoggerFactory\s*\.\s*getLogger\s*\([^;]*?\)\s*\.\s*(?:error|info|log|warn)\s*\(/.test(
      statement,
    )
  ) {
    return true;
  }
  return (
    !localSystem &&
    /\bSystem\s*\.\s*getLogger\s*\([^;]*?\)\s*\.\s*log\s*\(/.test(
      statement,
    )
  ) || /\bjava\.lang\.System\s*\.\s*getLogger\s*\([^;]*?\)\s*\.\s*log\s*\(/.test(
    statement,
  );
}

function hasRecognizedDeletionLog(
  runtime,
  method,
  text,
  subjectNames,
  semanticNames = new Set(),
  seen = new Set(),
) {
  if (seen.has(method.id) || seen.size > 12) return false;
  const executable = executableMethodText(runtime, method, text);
  const nextSeen = new Set(seen).add(method.id);
  for (const call of methodCalls(executable)) {
    const identities = derivedAliases(
      executable,
      subjectNames,
      call.position,
      (expression, aliases) => expressionUsesAnyName(expression, aliases),
    );
    const semantics = derivedAliases(
      executable,
      semanticNames,
      call.position,
      deletionMeaning,
    );
    const carriesIdentity = call.arguments.some((argument) =>
      expressionUsesAnyName(argument, identities)
    );
    const carriesMeaning = call.arguments.some((argument) =>
      deletionMeaning(argument, semantics)
    );
    if (
      carriesIdentity &&
      carriesMeaning &&
      recognizedDeletionLoggerCall(runtime, method, executable, call)
    ) {
      return true;
    }
    for (const target of methodCallTargets(runtime, method, call)) {
      if (!runtime.reachable.has(target.id) || nextSeen.has(target.id)) {
        continue;
      }
      const targetSubjects = new Set();
      const targetSemantics = new Set();
      for (
        let index = 0;
        index < target.parameterNames.length &&
        index < call.arguments.length;
        index += 1
      ) {
        if (expressionUsesAnyName(call.arguments[index], identities)) {
          targetSubjects.add(target.parameterNames[index]);
        }
        if (deletionMeaning(call.arguments[index], semantics)) {
          targetSemantics.add(target.parameterNames[index]);
        }
      }
      if (
        targetSubjects.size > 0 &&
        pathVariants(target.literal).every((variant) =>
          hasRecognizedDeletionLog(
            runtime,
            target,
            variant,
            targetSubjects,
            targetSemantics,
            nextSeen,
          )
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function routingTargetHasDeletedBehavior(
  runtime,
  target,
  subjectNames = new Set(),
) {
  return routingTargetMethods(runtime, target).some((method) =>
    closureVariants(runtime, method).some((text) => {
      if (
        /\.(?:getProperties|downloadContent|downloadStream)\s*\(/.test(
          maskJava(executableMethodText(runtime, method, text), false),
        )
      ) {
        return false;
      }
      const variants = pathVariants(method.literal);
      return variants.length > 0 && variants.every((variant) =>
        hasRecognizedDeletionLog(
          runtime,
          method,
          variant,
          subjectNames,
        )
      );
    })
  );
}

function expressionUsesName(expression, names) {
  const code = maskJava(expression, false);
  return [...names].some((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`).test(code)
  );
}

function routedEventUse(runtime, method, text, eventName, schema, routingIds) {
  const typeAccessor = schema === "EventGridEvent"
    ? "getEventType"
    : "getType";
  const typePattern = new RegExp(
    `\\b${escapeRegExp(eventName)}\\s*\\.\\s*${typeAccessor}\\s*\\(`,
  );
  const subjectPattern = new RegExp(
    `\\b${escapeRegExp(eventName)}\\s*\\.\\s*getSubject\\s*\\(`,
  );
  for (const call of methodCalls(text)) {
    for (const target of methodCallTargets(runtime, method, call)) {
      if (!routingIds.has(target.id)) continue;
      const roles = routingParameterRoles(runtime, target);
      const typeConnected = call.arguments.some(
        (argument, index) =>
          typePattern.test(argument) &&
          roles.eventTypeParameters.has(target.parameterNames[index]),
      );
      const subjectConnected = call.arguments.some(
        (argument, index) =>
          subjectPattern.test(argument) &&
          roles.subjectParameters.has(target.parameterNames[index]),
      );
      if (typeConnected && subjectConnected) return true;
    }
  }
  return false;
}

function schemaDeserializationRoutes(runtime, async, schema) {
  const routingMethods = reachableMethods(runtime, async)
    .filter((method) => routesEvents(runtime, method, runtime.literal));
  const routingIds = new Set(routingMethods.map(({ id }) => id));
  if (routingIds.size === 0) return false;
  const tainted = new Map(
    reachableMethods(runtime, async).map((method) => [method.id, new Set()]),
  );
  const fromString = new RegExp(
    `\\b${schema}\\s*\\.\\s*fromString\\s*\\(`,
  );
  for (const method of reachableMethods(runtime, async)) {
    for (const assignment of flowAssignments(method)) {
      if (fromString.test(assignment.expression)) {
        tainted.get(method.id).add(assignment.name);
      }
    }
  }
  for (let pass = 0; pass < runtime.methods.length + 2; pass += 1) {
    let changed = false;
    for (const method of reachableMethods(runtime, async)) {
      const methodTainted = tainted.get(method.id);
      for (const call of methodCalls(method.literal)) {
        for (const target of methodCallTargets(runtime, method, call)) {
          if (!runtime.reachable.has(target.id) || methodIsAsync(target) !== async) {
            continue;
          }
          for (
            let index = 0;
            index < call.arguments.length &&
            index < target.parameterNames.length;
            index += 1
          ) {
            if (
              fromString.test(call.arguments[index]) ||
              expressionUsesName(call.arguments[index], methodTainted)
            ) {
              const targetTainted = tainted.get(target.id);
              const before = targetTainted.size;
              targetTainted.add(target.parameterNames[index]);
              changed = changed || targetTainted.size !== before;
            }
          }
        }
      }
    }
    if (!changed) break;
  }

  for (const method of reachableMethods(runtime, async)) {
    const code = method.code;
    const literal = method.literal;
    const methodTainted = tainted.get(method.id);
    for (const match of code.matchAll(/\bfor\s*\(\s*([^:;]+):/g)) {
      const eventName = /([A-Za-z_$][\w$]*)\s*$/.exec(match[1])?.[1];
      const open = code.indexOf("(", match.index);
      const close = matchingIndex(code, open);
      const colon = code.indexOf(":", open);
      const iterable = close >= 0 && colon >= 0
        ? code.slice(colon + 1, close)
        : "";
      if (
        !eventName ||
        close < 0 ||
        !fromString.test(iterable) &&
          !expressionUsesName(iterable, methodTainted)
      ) {
        continue;
      }
      const bodyStart = skipWhitespace(code, close + 1);
      const bodyEnd = javaStatementEnd(code, bodyStart);
      if (
        bodyEnd >= 0 &&
        routedEventUse(
          runtime,
          method,
          statementBody(literal, bodyStart, bodyEnd),
          eventName,
          schema,
          routingIds,
        )
      ) {
        return true;
      }
    }
    for (const match of code.matchAll(
      /\.(?:concatMap|flatMap|forEach|map)\s*\(\s*(?:\(\s*)?([A-Za-z_$][\w$]*)\s*(?:\)\s*)?->/g,
    )) {
      const statementStart = Math.max(
        code.lastIndexOf(";", match.index),
        code.lastIndexOf("{", match.index),
        code.lastIndexOf("}", match.index),
      ) + 1;
      const statementEnd = javaStatementEnd(code, statementStart);
      if (statementEnd < 0) continue;
      const prefix = code.slice(statementStart, match.index);
      if (
        !fromString.test(prefix) &&
        !expressionUsesName(prefix, methodTainted)
      ) {
        continue;
      }
      if (
        routedEventUse(
          runtime,
          method,
          literal.slice(match.index + match[0].length, statementEnd),
          match[1],
          schema,
          routingIds,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function stringConstants(source) {
  return new Map(
    Array.from(
      source.matchAll(
        /\b(?:static\s+)?final\s+String\s+([A-Za-z_$][\w$]*)\s*=\s*("""[\s\S]*?"""|"(?:\\.|[^"\\])*")\s*;/g,
      ),
      (match) => [match[1], javaStringValue(match[2])],
    ).filter(([, value]) => value !== null),
  );
}

function decodeJavaEscapes(value) {
  let decoded = "";
  const escapes = new Map([
    ["b", "\b"],
    ["t", "\t"],
    ["n", "\n"],
    ["f", "\f"],
    ["r", "\r"],
    ['"', '"'],
    ["'", "'"],
    ["\\", "\\"],
    ["s", " "],
  ]);
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      decoded += value[index];
      continue;
    }
    const next = value[index + 1];
    if (next === "\n") {
      index += 1;
      continue;
    }
    if (next === "\r" && value[index + 2] === "\n") {
      index += 2;
      continue;
    }
    if (next === "u") {
      let cursor = index + 1;
      while (value[cursor] === "u") cursor += 1;
      const digits = value.slice(cursor, cursor + 4);
      if (!/^[0-9A-Fa-f]{4}$/.test(digits)) return null;
      decoded += String.fromCharCode(Number.parseInt(digits, 16));
      index = cursor + 3;
      continue;
    }
    if (/[0-7]/.test(next ?? "")) {
      const octal = /^[0-7]{1,3}/.exec(value.slice(index + 1))?.[0] ?? "";
      decoded += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    if (!escapes.has(next)) return null;
    decoded += escapes.get(next);
    index += 1;
  }
  return decoded;
}

function javaStringValue(expression) {
  const value = unwrapParentheses(expression);
  if (value.startsWith('"""') && value.endsWith('"""')) {
    let content = value.slice(3, -3);
    if (content.startsWith("\r\n")) content = content.slice(2);
    else if (content.startsWith("\n")) content = content.slice(1);
    return decodeJavaEscapes(content);
  }
  const match = /^"((?:\\.|[^"\\])*)"$/.exec(value);
  return match ? decodeJavaEscapes(match[1]) : null;
}

function resolveString(expression, constants) {
  const value = unwrapParentheses(expression);
  return javaStringValue(value) ?? constants.get(value) ?? null;
}

function methodCalls(text) {
  const code = maskJava(text, false);
  const literal = maskJava(text, true);
  const calls = [];
  const ignored = new Set([
    "catch",
    "for",
    "if",
    "new",
    "return",
    "switch",
    "synchronized",
    "throw",
    "try",
    "while",
  ]);
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (ignored.has(match[1])) continue;
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    if (close < 0) continue;
    const receiver =
      /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(code.slice(0, match.index))?.[1] ??
      null;
    const argumentRanges = splitTopLevelRanges(
      literal.slice(open + 1, close),
    ).filter(({ value }) => value.trim());
    calls.push({
      name: match[1],
      position: match.index,
      open,
      close,
      receiver,
      arguments: argumentRanges.map(({ value }) => value.trim()),
      argumentPositions: argumentRanges.map(({ start, value }) =>
        open + 1 + start + Math.max(0, value.search(/\S/))
      ),
    });
  }
  return calls;
}

function methodVariableTypes(runtime, method) {
  const types = new Map();
  const classSource = method.className
    ? classRanges(runtime.code)
      .filter(({ name }) => name === method.className)
      .map(({ start, end }) => runtime.code.slice(start, end))
      .join("\n")
    : "";
  for (const match of classSource.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*(?:<[^;={}]+>)?\s+([A-Za-z_$][\w$]*)\s*(?:=\s*[^;]+)?;/g,
  )) {
    types.set(match[2], normalizeJavaType(match[1]));
  }
  for (const match of method.code.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*(?:<[^;={}]+>)?\s+([A-Za-z_$][\w$]*)\s*=/g,
  )) {
    types.set(match[2], normalizeJavaType(match[1]));
  }
  for (let index = 0; index < method.parameterNames.length; index += 1) {
    const type = method.parameterTypes[index];
    if (type) types.set(method.parameterNames[index], type);
  }
  return types;
}

function methodVariableTypeReferences(
  runtime,
  method,
  endPosition = Number.POSITIVE_INFINITY,
) {
  const types = new Map();
  const classSource = method.className
    ? classRanges(runtime.code)
      .filter(({ name }) => name === method.className)
      .map(({ start, end }) => runtime.code.slice(start, end))
      .join("\n")
    : "";
  for (const match of classSource.matchAll(
    /\b([A-Za-z_$][\w$.]*)\s*(?:<[^;={}]+>)?\s+([A-Za-z_$][\w$]*)\s*(?:=\s*[^;]+)?;/g,
  )) {
    types.set(match[2], normalizeJavaTypeReference(match[1]));
  }
  for (const declaration of javaVariableDeclarations(method.literal)) {
    if (declaration.position < endPosition) {
      types.set(declaration.name, declaration.typeReference);
    }
  }
  const parameters = parameterTypeReferences(method.parameters);
  for (let index = 0; index < method.parameterNames.length; index += 1) {
    const type = parameters[index];
    if (type) types.set(method.parameterNames[index], type);
  }
  return types;
}

function expressionStaticTypes(
  runtime,
  method,
  expression,
  position = method.literal.length,
  seen = new Set(),
) {
  let value = unwrapParentheses(expression);
  const cast = /^\(\s*([A-Za-z_$][\w$.]*(?:\s*<[^()]+>)?(?:\s*\[\s*\])*)\s*\)\s*([\s\S]+)$/.exec(
    value,
  );
  if (cast) return new Set([normalizeJavaTypeReference(cast[1])]);
  if (/^"(?:\\.|[^"\\])*"$/.test(value) || /^"""[\s\S]*"""$/.test(value)) {
    return new Set(["String"]);
  }
  if (/^'(?:\\.|[^'\\])'$/.test(value)) return new Set(["char"]);
  if (/^(?:true|false)$/.test(value)) return new Set(["boolean"]);
  if (/^null$/.test(value)) return new Set(["null"]);
  if (/^[+-]?\d+[lL]$/.test(value)) return new Set(["long"]);
  if (/^[+-]?\d+$/.test(value)) return new Set(["int"]);
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?[fF]$/.test(value)) {
    return new Set(["float"]);
  }
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?[dD]?$/.test(value)) {
    return new Set(["double"]);
  }
  const created = /^\s*new\s+([A-Za-z_$][\w$.]*(?:\s*<[^()]+>)?(?:\s*\[\s*\])*)\b/.exec(
    value,
  );
  if (created) return new Set([normalizeJavaTypeReference(created[1])]);
  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) {
    const type = methodVariableTypeReferences(
      runtime,
      method,
      position,
    ).get(reference);
    return type ? new Set([type]) : new Set();
  }
  const staticMember = javaStaticMemberValueType(
    value,
    runtime,
    method,
    null,
    position,
  );
  if (staticMember) return new Set([staticMember]);
  if (
    /\.(?:getEventType|getType|getSubject|getName|toString)\s*\(\s*\)\s*$/.test(
      value,
    )
  ) {
    return new Set(["String"]);
  }
  const directCall =
    /^(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(
      value,
    );
  if (!directCall || seen.has(value)) return new Set();
  const open = value.indexOf("(");
  const argumentRanges = splitTopLevelRanges(
    value.slice(open + 1, value.length - 1),
  ).filter(({ value: argument }) => argument.trim());
  const call = {
    name: directCall[2],
    receiver: directCall[1] ?? null,
    arguments: argumentRanges.map(({ value: argument }) => argument.trim()),
    argumentPositions: argumentRanges.map(({ start, value: argument }) =>
      position + open + 1 + start + Math.max(0, argument.search(/\S/))
    ),
    position: position + value.indexOf(directCall[2]),
  };
  let candidates = (runtime.byName.get(call.name) ?? []).filter((candidate) => {
    const parameters = splitTopLevel(candidate.parameters);
    const variadic = parameters.at(-1)?.includes("...");
    return variadic
      ? call.arguments.length >= parameters.length - 1
      : call.arguments.length === parameters.length;
  });
  if (call.receiver === "this") {
    candidates = candidates.filter(
      ({ className }) => className === method.className,
    );
  } else if (runtime.classNames.has(call.receiver)) {
    candidates = candidates.filter(
      ({ className }) => className === call.receiver,
    );
  } else if (call.receiver) {
    const receiverType = methodVariableTypes(runtime, method).get(call.receiver);
    if (receiverType) {
      candidates = candidates.filter(
        ({ className }) => className === receiverType,
      );
    }
  } else {
    const sameClass = candidates.filter(
      ({ className }) => className === method.className,
    );
    if (sameClass.length > 0) candidates = sameClass;
  }
  const returns = new Set(
    candidates.map(({ returnType }) => normalizeJavaTypeReference(returnType)),
  );
  return returns.size === 1 ? returns : new Set();
}

const primitiveWidening = new Map([
  ["byte", new Set(["short", "int", "long", "float", "double"])],
  ["short", new Set(["int", "long", "float", "double"])],
  ["char", new Set(["int", "long", "float", "double"])],
  ["int", new Set(["long", "float", "double"])],
  ["long", new Set(["float", "double"])],
  ["float", new Set(["double"])],
]);

const boxedTypes = new Map([
  ["boolean", "Boolean"],
  ["byte", "Byte"],
  ["short", "Short"],
  ["char", "Character"],
  ["int", "Integer"],
  ["long", "Long"],
  ["float", "Float"],
  ["double", "Double"],
]);

const primitiveTypes = new Set([
  "boolean",
  "byte",
  "short",
  "char",
  "int",
  "long",
  "float",
  "double",
]);

function typeCompatibility(runtime, argumentType, parameterType) {
  const argumentReference = normalizeJavaTypeReference(argumentType);
  const parameterReference = normalizeJavaTypeReference(parameterType);
  const argument = normalizeJavaType(argumentReference);
  const parameter = normalizeJavaType(parameterReference);
  if (!argument || !parameter) return 0;
  const argumentIdentity = resolveJavaTypeIdentity(runtime, argumentReference);
  const parameterIdentity = resolveJavaTypeIdentity(runtime, parameterReference);
  if (
    argumentIdentity &&
    parameterIdentity &&
    argumentIdentity === parameterIdentity
  ) {
    return 10;
  }
  if (argument === "null") {
    return primitiveTypes.has(parameter) ? -1 : 1;
  }
  if (primitiveWidening.get(argument)?.has(parameter)) return 8;
  if (
    boxedTypes.get(argument) === parameter ||
    boxedTypes.get(parameter) === argument
  ) {
    return 7;
  }
  if (primitiveTypes.has(argument)) {
    const boxed = boxedTypes.get(argument);
    if (
      boxed &&
      referenceTypeDistance(runtime, boxed, parameterReference) < Infinity
    ) {
      return 2;
    }
  }
  if (primitiveTypes.has(parameter)) return -1;
  const distance = referenceTypeDistance(
    runtime,
    argumentReference,
    parameterReference,
  );
  return distance < Infinity ? Math.max(1, 6 - distance) : -1;
}

function parameterMoreSpecific(runtime, left, right) {
  const leftReference = normalizeJavaTypeReference(left);
  const rightReference = normalizeJavaTypeReference(right);
  const normalizedLeft = normalizeJavaType(leftReference);
  const normalizedRight = normalizeJavaType(rightReference);
  const leftIdentity = resolveJavaTypeIdentity(runtime, leftReference);
  const rightIdentity = resolveJavaTypeIdentity(runtime, rightReference);
  if (leftIdentity && rightIdentity && leftIdentity === rightIdentity) {
    return true;
  }
  if (primitiveTypes.has(normalizedLeft) || primitiveTypes.has(normalizedRight)) {
    return (
      primitiveWidening.get(normalizedLeft)?.has(normalizedRight) ||
      boxedTypes.get(normalizedLeft) === normalizedRight
    );
  }
  return referenceTypeDistance(runtime, leftReference, rightReference) < Infinity;
}

function effectiveParameterTypes(candidate, argumentCount) {
  const parameters = [
    ...(candidate.parameterTypeReferences ?? candidate.parameterTypes),
  ];
  const variadic = splitTopLevel(candidate.parameters).at(-1)?.includes("...");
  if (!variadic) return parameters;
  const fixed = parameters.slice(0, -1);
  const element = parameters.at(-1)?.replace(/\[\]$/, "") ?? "";
  while (fixed.length < argumentCount) fixed.push(element);
  return fixed;
}

function methodCallTargets(runtime, method, call) {
  let candidates = (runtime.byName.get(call.name) ?? []).filter((candidate) => {
    const parameters = splitTopLevel(candidate.parameters);
    const variadic = parameters.at(-1)?.includes("...");
    return variadic
      ? call.arguments.length >= parameters.length - 1
      : call.arguments.length === parameters.length;
  });
  if (candidates.length === 0) return [];
  let receiverType = null;
  if (call.receiver === "this") receiverType = method.className;
  else if (runtime.classNames.has(call.receiver)) receiverType = call.receiver;
  else if (call.receiver) {
    receiverType = methodVariableTypes(runtime, method).get(call.receiver) ?? null;
  } else {
    const sameClass = candidates.filter(
      ({ className }) => className === method.className,
    );
    if (sameClass.length > 0) candidates = sameClass;
    else {
      const constructors = candidates.filter(
        ({ className, name }) => className === name,
      );
      if (constructors.length > 0) candidates = constructors;
    }
  }
  if (receiverType) {
    candidates = candidates.filter(
      ({ className }) => className === receiverType,
    );
  } else if (call.receiver && candidates.length > 1) {
    return [];
  }
  if (candidates.length <= 1) return candidates;

  const argumentTypes = call.arguments.map((argument, index) =>
    expressionStaticTypes(
      runtime,
      method,
      argument,
      call.argumentPositions?.[index] ??
        call.position,
    )
  );
  const applicable = [];
  for (const candidate of candidates) {
    const parameterList = effectiveParameterTypes(
      candidate,
      call.arguments.length,
    );
    let compatible = true;
    for (let index = 0; index < call.arguments.length; index += 1) {
      const parameter = parameterList[index] ?? "";
      const knownTypes = argumentTypes[index];
      if (knownTypes.size === 0) continue;
      const matches = [...knownTypes].map((type) =>
        typeCompatibility(runtime, type, parameter)
      );
      if (Math.min(...matches) < 0) {
        compatible = false;
        break;
      }
    }
    if (compatible) applicable.push({ candidate, parameterList });
  }
  if (applicable.length <= 1) {
    return applicable.map(({ candidate }) => candidate);
  }
  if (argumentTypes.some((types) => types.size === 0)) return [];
  const mostSpecific = applicable.filter((left) =>
    applicable.every((right) => {
      if (left === right) return true;
      let strictlyMoreSpecific = false;
      for (let index = 0; index < left.parameterList.length; index += 1) {
        const leftType = left.parameterList[index] ?? "";
        const rightType = right.parameterList[index] ?? "";
        if (!parameterMoreSpecific(runtime, leftType, rightType)) return false;
        strictlyMoreSpecific ||= normalizeJavaType(leftType) !==
          normalizeJavaType(rightType);
      }
      return strictlyMoreSpecific;
    })
  );
  return mostSpecific.length === 1 ? [mostSpecific[0].candidate] : [];
}

function reactorReturningMethod(method) {
  return /^(?:Mono|Flux|Publisher)(?:$|[<\[])/.test(
    method.returnType,
  );
}

function reachableMethodReturns(method) {
  const source = method.literal;
  const code = maskJava(source, false);
  const functions = functionalExecutionAnalysis(source).functions;
  const nestedMethods = parseMethods(code, source);
  const controls = [];
  for (const match of code.matchAll(/\b(return|throw)\b/g)) {
    if (
      parsedMethodOwnerAt(nestedMethods, match.index) ||
      functions.some(
        ({ start, end }) => start <= match.index && match.index < end,
      )
    ) {
      continue;
    }
    const end = javaStatementEnd(code, match.index);
    if (end < 0) continue;
    controls.push({
      id: controls.length,
      control: match[1],
      expression: source
        .slice(match.index + match[1].length, end - 1)
        .trim(),
      position: match.index,
      end,
      statement: source.slice(match.index, end),
    });
  }
  let annotated = source;
  for (const control of controls.toReversed()) {
    annotated = `${annotated.slice(0, control.position)}{
__hyoka_control_${control.id}__();
${control.statement}
}${annotated.slice(control.end)}`;
  }
  const variants = completedConditionalVariants(
    annotated,
    annotated.length,
    64,
  ).flatMap((literal) => completedSwitchVariants(literal, 64));
  const reachable = [];
  for (const literal of variants) {
    const variantCode = maskJava(literal, false);
    const deferred = functionalExecutionAnalysis(literal).functions;
    for (const match of variantCode.matchAll(/\b(return|throw)\b/g)) {
      if (
        deferred.some(
          ({ start, end }) => start <= match.index && match.index < end,
        )
      ) {
        continue;
      }
      const marker = /__hyoka_control_(\d+)__\s*\(\s*\)\s*;\s*\{\s*$/.exec(
        variantCode.slice(Math.max(0, match.index - 96), match.index),
      ) ?? /__hyoka_control_(\d+)__\s*\(\s*\)\s*;\s*$/.exec(
        variantCode.slice(Math.max(0, match.index - 96), match.index),
      );
      const control = marker
        ? controls[Number.parseInt(marker[1], 10)]
        : null;
      if (!control) continue;
      const reachability = assignmentControl({ literal }, match.index);
      if (!reachability.reachable) continue;
      if (control.control === "return") {
        reachable.push({
          ...control,
          literal,
          variantPosition: match.index,
          variantExpression: control.expression,
        });
      }
      if (!reachability.conditional) break;
    }
  }
  return reachable;
}

function executableMethodText(runtime, method, source = method.literal) {
  return executableFunctionalText(
    source,
    runtime.consumedReactorCallbacks?.get(method.id) ?? new Set(),
  );
}

function topLevelMethodCalls(expression) {
  const calls = methodCalls(expression);
  return calls.filter((call) =>
    !calls.some(
      (owner) =>
        owner !== call &&
        owner.open < call.position &&
        call.position < owner.close,
    )
  );
}

function publisherParameterExpression(
  runtime,
  method,
  expression,
  environment,
) {
  let value = unwrapParentheses(expression);
  while (/^\(\s*[A-Za-z_$][\w$.<>,? ]*\s*\)\s*/.test(value)) {
    value = value.replace(
      /^\(\s*[A-Za-z_$][\w$.<>,? ]*\s*\)\s*/,
      "",
    ).trim();
  }
  const assignment = topLevelAssignmentExpression(value);
  if (assignment) {
    const assigned = publisherParameterExpression(
      runtime,
      method,
      assignment.expression,
      environment,
    );
    environment.set(assignment.name, assigned);
    return assigned;
  }
  const conditional = splitTopLevelConditional(value);
  if (conditional) {
    evaluateJavaConditionSideEffects(
      conditional.condition,
      environment,
      (condition, conditionEnvironment) =>
        publisherParameterExpression(
          runtime,
          method,
          condition,
          conditionEnvironment,
        ),
      (values) => values.every(Boolean),
    );
    const truth = staticJavaBoolean(conditional.condition);
    const branches = [];
    if (truth !== false) branches.push(conditional.consequent);
    if (truth !== true) branches.push(conditional.alternate);
    const evaluated = branches.map((branch) => {
      const branchEnvironment = new Map(environment);
      return {
        environment: branchEnvironment,
        result: publisherParameterExpression(
          runtime,
          method,
          branch,
          branchEnvironment,
        ),
      };
    });
    mergeBranchEnvironments(
      environment,
      evaluated.map(({ environment: branch }) => branch),
      (values) => values.every(Boolean),
    );
    return evaluated.length > 0 &&
      evaluated.every(({ result }) => result);
  }
  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) return Boolean(environment.get(reference));

  const calls = topLevelMethodCalls(value);
  const outputCall = calls.at(-1);
  if (publisherTransformCallbackMethods.has(outputCall?.name)) {
    const callback = publisherTransformCallback(
      outputCall,
      runtime,
      method,
    );
    if (!callback || callback.returns.length === 0) return false;
    const receiver = callReceiverExpression(value, outputCall);
    const callbackEnvironment = new Map(environment);
    for (const parameter of callback.parameters) {
      callbackEnvironment.set(parameter, false);
    }
    callbackEnvironment.set(
      callback.parameters[0],
      publisherParameterExpression(runtime, method, receiver, environment),
    );
    const returns = publisherCallbackReturnFlows(
      runtime,
      method,
      callback,
      callbackEnvironment,
      (callbackMethod, assignment, reaching) =>
        publisherParameterExpression(
          runtime,
          callbackMethod,
          assignment.expression,
          reaching,
        ),
      (previous, assigned) => Boolean(previous && assigned),
    );
    return returns.length > 0 && returns.every((returned) =>
      publisherParameterExpression(
        runtime,
        returned.method,
        returned.expression,
        returned.environment,
      )
    );
  }

  for (const call of calls) {
    const receiver = callReceiverExpression(value, call);
    if (
      receiver &&
      publisherParameterExpression(runtime, method, receiver, environment)
    ) {
      return true;
    }
    for (
      const index of subscribedPublisherArgumentIndexes(
        runtime,
        method,
        value,
        call,
      )
    ) {
      if (
        publisherParameterExpression(
          runtime,
          method,
          call.arguments[index] ?? "",
          environment,
        )
      ) {
        return true;
      }
    }
    for (const target of methodCallTargets(runtime, method, call)) {
      if (!reactorReturningMethod(target)) continue;
      for (const index of returnedPublisherParameterIndexes(runtime, target)) {
        if (
          publisherParameterExpression(
            runtime,
            method,
            call.arguments[index] ?? "",
            environment,
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function publisherParameterEnvironment(
  runtime,
  method,
  returned,
  parameter,
) {
  const environment = new Map([[parameter, true]]);
  const variantMethod = {
    ...method,
    code: maskJava(returned.literal, false),
    literal: returned.literal,
  };
  for (const assignment of flowAssignmentEvents(
    variantMethod,
    returned.variantPosition,
  )) {
    const assigned = publisherParameterExpression(
      runtime,
      variantMethod,
      assignment.expression,
      environment,
    );
    environment.set(
      assignment.name,
      assignment.conditional
        ? Boolean(environment.get(assignment.name) && assigned)
        : assigned,
    );
  }
  return environment;
}

function returnedPublisherParameterIndexes(runtime, method) {
  runtime.returnedPublisherParameters ??= new Map();
  if (runtime.returnedPublisherParameters.has(method.id)) {
    return runtime.returnedPublisherParameters.get(method.id);
  }
  const indexes = new Set();
  runtime.returnedPublisherParameters.set(method.id, indexes);
  const returns = reachableMethodReturns(method);
  for (let index = 0; index < method.parameterNames.length; index += 1) {
    const parameter = method.parameterNames[index];
    if (
      returns.length > 0 &&
      returns.every((returned) =>
        publisherParameterExpression(
          runtime,
          method,
          returned.variantExpression,
          publisherParameterEnvironment(
            runtime,
            method,
            returned,
            parameter,
          ),
        )
      )
    ) {
      indexes.add(index);
    }
  }
  return indexes;
}

function analyzeReactorConsumption(runtime) {
  const consumedCallbacks = new Map(
    runtime.methods.map(({ id }) => [id, new Set()]),
  );
  const consumedMethods = new Set();
  const processedExpressions = new Set();
  const pendingExpressions = [];
  const analyses = new Map(
    runtime.methods.map((method) => [
      method.id,
      functionalExecutionAnalysis(method.literal),
    ]),
  );
  const nestedMethodScopes = new Map(
    runtime.methods.map((method) => [
      method.id,
      parseMethods(maskJava(method.literal, false), method.literal),
    ]),
  );
  const assignments = new Map(
    runtime.methods.map((method) => [
      method.id,
      flowAssignmentEvents(method)
        .filter(({ reachable }) => reachable)
        .sort((left, right) => left.position - right.position),
    ]),
  );

  const queueExpression = (method, expression, position, start, end) => {
    if (!expression?.trim()) return;
    const key = `${method.id}:${position}:${start}:${end}:${expression}`;
    if (processedExpressions.has(key)) return;
    processedExpressions.add(key);
    pendingExpressions.push({ method, expression, position, start, end });
  };

  const ownerIsExecuted = (method, position) => {
    if (parsedMethodOwnerAt(nestedMethodScopes.get(method.id) ?? [], position)) {
      return false;
    }
    const functions = analyses.get(method.id)?.functions ?? [];
    const owners = functions.filter(
      ({ start, end }) => start <= position && position < end,
    );
    return owners.length === 0 || owners.some((owner) =>
      owner.executed ||
      consumedCallbacks.get(method.id)?.has(
        functionalKey(owner, method.literal),
      )
    );
  };

  const queueTerminalExpressions = () => {
    for (const method of runtime.methods) {
      if (!runtime.reachable.has(method.id)) continue;
      const code = maskJava(method.literal, false);
      for (const match of code.matchAll(
        /\.(?:block|blockLast|subscribe)\s*\(/g,
      )) {
        if (!ownerIsExecuted(method, match.index)) continue;
        const statement = functionalStatement(code, match.index);
        queueExpression(
          method,
          method.literal.slice(statement.start, statement.end),
          match.index,
          statement.start,
          statement.end,
        );
      }
    }
  };

  const queueMethodReturns = (method) => {
    for (const returned of reachableMethodReturns(method)) {
      const expression = returned.expression;
      const start = method.literal.indexOf(
        expression,
        returned.position,
      );
      queueExpression(
        method,
        expression,
        returned.position,
        start,
        start + expression.length,
      );
    }
  };

  const queueFunctionalPublisherResult = (
    method,
    functional,
    position,
    callback,
  ) => {
    if (!functional.block) {
      const expression = method.literal.slice(functional.start, functional.end);
      queueExpression(
        method,
        expression,
        position,
        functional.start,
        functional.end,
      );
      return;
    }
    const initialEnvironment = new Map(
      (callback?.parameters ?? []).map((parameter) => [parameter, []]),
    );
    const returns = callback
      ? publisherCallbackReturnFlows(
        runtime,
        method,
        callback,
        initialEnvironment,
        (callbackMethod, assignment, environment) =>
          publisherCallbackExpressions(
            runtime,
            callbackMethod,
            assignment.expression,
            environment,
          ) ?? [],
        (previous, assigned) => [
          ...new Set([...(previous ?? []), ...assigned]),
        ],
      )
      : [];
    const expressionsByReturn = returns.map((returned) =>
      publisherCallbackExpressions(
        runtime,
        returned.method,
        returned.expression,
        returned.environment,
      ) ?? [returned.expression]
    );
    const commonExpressions = expressionsByReturn.length === 0
      ? []
      : expressionsByReturn[0].filter((expression) =>
        expressionsByReturn.slice(1).every((expressions) =>
          expressions.includes(expression)
        )
      );
    for (const expression of commonExpressions) {
      const expressionStart = method.literal.indexOf(
        expression,
        functional.start,
      );
      queueExpression(
        method,
        expression,
        position,
        expressionStart,
        expressionStart + expression.length,
      );
    }
  };

  let changed = true;
  while (changed) {
    changed = false;
    queueTerminalExpressions();
    for (const method of runtime.methods) {
      if (consumedMethods.has(method.id)) queueMethodReturns(method);
    }

    while (pendingExpressions.length > 0) {
      const { method, expression, position, start, end } =
        pendingExpressions.shift();
      const callbacks = consumedCallbacks.get(method.id);
      const calls = methodCalls(expression);
      const topLevelCalls = topLevelMethodCalls(expression);
      const discardedReceiverRanges = topLevelCalls
        .filter((call) =>
          publisherTransformCallbackMethods.has(call.name) &&
          !publisherTransformReturnsInput(runtime, method, call)
        )
        .flatMap((call) => {
          const receiver = callReceiverExpression(expression, call);
          const receiverStart = expression.lastIndexOf(receiver, call.position);
          return receiver && receiverStart >= 0
            ? [{ start: receiverStart, end: call.position }]
            : [];
        });
      const consumedCalls = topLevelCalls.filter((call) =>
        !discardedReceiverRanges.some(
          (range) =>
            range.start <= call.position && call.position < range.end,
        )
      );
      for (const call of consumedCalls) {
        for (const functional of analyses.get(method.id)?.functions ?? []) {
          const localPosition = functional.position - start;
          if (
            !functional.reactor ||
            localPosition < 0 ||
            localPosition >= expression.length
          ) {
            continue;
          }
          const owner = calls
            .filter(
              (candidate) =>
                candidate.open < localPosition &&
                localPosition < candidate.close,
            )
            .sort(
              (left, right) =>
                left.close - left.open - (right.close - right.open),
            )[0];
          if (owner?.position !== call.position) continue;
          const key = functionalKey(functional, method.literal);
          if (!callbacks.has(key)) {
            callbacks.add(key);
            changed = true;
          }
          if (publisherReturningCallbackMethods.has(call.name)) {
            const callback = lambdaDetails(
              call.arguments.find((argument) =>
                maskJava(argument, false).includes("->")
              ) ?? "",
              runtime,
              method,
            );
            queueFunctionalPublisherResult(
              method,
              functional,
              position,
              callback,
            );
            const parameters = callback?.parameters ?? [];
            const returnsPublisherInput =
              publisherTransformCallbackMethods.has(call.name)
                ? publisherTransformReturnsInput(runtime, method, call)
                : parameters.length === 1;
            if (parameters.length > 0 && returnsPublisherInput) {
              const receiver = callReceiverExpression(expression, call);
              const upstream = publisherOutputDataOrigins(
                runtime,
                method,
                receiver,
                position,
              );
              const body = method.literal.slice(functional.start, functional.end);
              const callbackMethod = {
                ...method,
                id: `${method.id}:callback-input@${functional.position}`,
                code: maskJava(body, false),
                literal: body,
                lexicalBindings: callbackLexicalBindings(
                  parameters,
                  body.length,
                ),
              };
              const returned = functional.block
                ? reachableMethodReturns(callbackMethod).map(
                  ({ variantExpression }) => variantExpression,
                )
                : [body];
              if (
                returned.length > 0 &&
                (
                  publisherTransformCallbackMethods.has(call.name) ||
                  returned.every((result) =>
                    publisherParameterExpression(
                      runtime,
                      method,
                      result,
                      new Map([[parameters[0], true]]),
                    )
                  )
                )
              ) {
                for (const origin of upstream) {
                  if (origin.depth !== 0) continue;
                  let originStart = method.literal.lastIndexOf(
                    origin.expression,
                    position,
                  );
                  if (originStart < 0) {
                    originStart = method.literal.indexOf(origin.expression);
                  }
                  queueExpression(
                    method,
                    origin.expression,
                    position,
                    Math.max(0, originStart),
                    Math.max(0, originStart) + origin.expression.length,
                  );
                }
              }
            }
          }
        }

        let argumentSearch = Math.max(0, call.open + 1);
        const argumentStarts = call.arguments.map((argument) => {
          const argumentStart = expression.indexOf(argument, argumentSearch);
          argumentSearch = Math.max(argumentSearch, argumentStart) +
            argument.length;
          return argumentStart;
        });
        for (
          const index of subscribedPublisherArgumentIndexes(
            runtime,
            method,
            expression,
            call,
          )
        ) {
          const argument = call.arguments[index] ?? "";
          const argumentStart = argumentStarts[index] ?? -1;
          if (argumentStart < 0) continue;
          if (
            [
              "concat",
              "concatDelayError",
              "when",
              "whenDelayError",
            ].includes(call.name)
          ) {
            const origins = publisherDataValueOrigins(
              runtime,
              method,
              argument,
              position,
            );
            let flattened = origins.filter(({ depth }) => depth === 1);
            if (
              ["concat", "concatDelayError"].includes(call.name) &&
              flattened.length === 0 &&
              reactorPublisherExpression(runtime, method, argument)
            ) {
              flattened = publisherOutputDataOrigins(
                runtime,
                method,
                argument,
                position,
              ).filter(({ depth }) => depth === 0);
            }
            for (const origin of flattened) {
              const nestedStart = argument.indexOf(origin.expression);
              queueExpression(
                method,
                origin.expression,
                position,
                nestedStart < 0 ? start + argumentStart : start + argumentStart + nestedStart,
                (
                  nestedStart < 0
                    ? start + argumentStart
                    : start + argumentStart + nestedStart
                ) + origin.expression.length,
              );
            }
            if (flattened.length > 0) continue;
          }
          queueExpression(
            method,
            argument,
            position,
            start + argumentStart,
            start + argumentStart + argument.length,
          );
        }
        for (const target of methodCallTargets(runtime, method, call)) {
          if (
            runtime.reachable.has(target.id) &&
            reactorReturningMethod(target) &&
            !consumedMethods.has(target.id)
          ) {
            consumedMethods.add(target.id);
            changed = true;
          }
          if (!reactorReturningMethod(target)) continue;
          for (
            const index of returnedPublisherParameterIndexes(runtime, target)
          ) {
            const argument = call.arguments[index] ?? "";
            const argumentStart = argumentStarts[index] ?? -1;
            if (argumentStart < 0) continue;
            queueExpression(
              method,
              argument,
              position,
              start + argumentStart,
              start + argumentStart + argument.length,
            );
          }
        }
      }

      const code = maskJava(expression, false);
      for (const assignment of assignments.get(method.id) ?? []) {
        if (
          assignment.position >= position ||
          !new RegExp(`\\b${escapeRegExp(assignment.name)}\\b`).test(code) ||
          !publisherParameterExpression(
            runtime,
            method,
            expression,
            new Map([[assignment.name, true]]),
          )
        ) {
          continue;
        }
        const later = (assignments.get(method.id) ?? []).some(
          (candidate) =>
            candidate.name === assignment.name &&
            assignment.position < candidate.position &&
            candidate.position < position,
        );
        if (later) continue;
        const expressionStart = method.literal.indexOf(
          assignment.expression,
          assignment.position,
        );
        queueExpression(
          method,
          assignment.expression,
          assignment.position,
          expressionStart,
          expressionStart + assignment.expression.length,
        );
      }
    }
  }
  return consumedCallbacks;
}

function resourceStrings(paths, resources) {
  const values = new Set();
  for (const path of paths) {
    const normalized = String(path).replaceAll("\\", "/");
    for (const candidate of [
      normalized,
      normalized.replace(/^\.?\//, ""),
      normalized.startsWith("/") ? normalized : `/${normalized}`,
      normalized.split("/").at(-1),
    ]) {
      if (resources.has(candidate)) values.add(resources.get(candidate));
    }
  }
  return values;
}

function resolveStringValues(
  expression,
  environment,
  constants,
  resources = new Map(),
) {
  const value = unwrapParentheses(expression);
  const direct = javaStringValue(value);
  if (direct !== null) return new Set([direct]);
  const reference = /^([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) {
    if (environment.has(reference)) return new Set(environment.get(reference));
    if (constants.has(reference)) return new Set([constants.get(reference)]);
  }
  const readString = callAt(value, "readString");
  if (
    readString &&
    /(?:^|\.)Files$/.test(readString.receiver.replace(/\s+/g, ""))
  ) {
    return resourceStrings(
      resolveStringValues(
        readString.arguments[0] ?? "",
        environment,
        constants,
        resources,
      ),
      resources,
    );
  }
  for (const method of ["of", "get"]) {
    const pathCall = callAt(value, method);
    if (
      pathCall &&
      new RegExp(`(?:^|\\.)(?:Path|Paths)$`).test(
        pathCall.receiver.replace(/\s+/g, ""),
      )
    ) {
      return resolveStringValues(
        pathCall.arguments[0] ?? "",
        environment,
        constants,
        resources,
      );
    }
  }
  const resourceCall =
    /\.getResource(?:AsStream)?\s*\(\s*("(?:\\.|[^"\\])*")\s*\)/.exec(
      value,
    );
  if (resourceCall) {
    const path = javaStringValue(resourceCall[1]);
    return path === null
      ? new Set()
      : resourceStrings(new Set([path]), resources);
  }
  const addition = splitTopLevelAddition(value);
  if (!addition) return new Set();
  const left = resolveStringValues(
    addition[0],
    environment,
    constants,
    resources,
  );
  const right = resolveStringValues(
    addition[1],
    environment,
    constants,
    resources,
  );
  const combined = new Set();
  for (const leftValue of left) {
    for (const rightValue of right) {
      combined.add(`${leftValue}${rightValue}`);
      if (combined.size >= 16) return combined;
    }
  }
  return combined;
}

function stringAssignmentEvents(method) {
  return Array.from(
    method.literal.matchAll(
      /\b(?:final\s+)?(?:String|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
    ),
    (match) => ({
      type: "assignment",
      position: match.index,
      name: match[1],
      expression: match[2],
    }),
  );
}

function stringEnvironment(
  method,
  incoming,
  constants,
  resources,
  endPosition = Number.POSITIVE_INFINITY,
) {
  const environment = new Map(
    [...constants].map(([name, value]) => [name, new Set([value])]),
  );
  for (const parameter of method.parameterNames) {
    environment.set(parameter, new Set(incoming.get(parameter) ?? []));
  }
  for (const assignment of stringAssignmentEvents(method)) {
    if (assignment.position >= endPosition) continue;
    environment.set(
      assignment.name,
      resolveStringValues(
        assignment.expression,
        environment,
        constants,
        resources,
      ),
    );
  }
  return environment;
}

function mergeValues(target, name, values) {
  if (values.size === 0) return false;
  if (!target.has(name)) target.set(name, new Set());
  const existing = target.get(name);
  const previousSize = existing.size;
  for (const value of values) existing.add(value);
  return existing.size !== previousSize;
}

function propagatedStringArguments(runtime) {
  const constants = stringConstants(runtime.literal);
  const resources = runtime.resources ?? new Map();
  const incomingByMethod = new Map(
    runtime.methods.map((method) => [method.id, new Map()]),
  );
  let changed = true;
  for (let pass = 0; changed && pass < runtime.methods.length + 2; pass += 1) {
    changed = false;
    for (const method of reachableMethods(runtime)) {
      const incoming = incomingByMethod.get(method.id);
      const environment = new Map(
        [...constants].map(([name, value]) => [name, new Set([value])]),
      );
      for (const parameter of method.parameterNames) {
        environment.set(parameter, new Set(incoming.get(parameter) ?? []));
      }
      const events = [
        ...stringAssignmentEvents(method),
        ...methodCalls(method.literal).map((call) => ({
          type: "call",
          ...call,
        })),
      ].sort((left, right) => left.position - right.position);
      for (const event of events) {
        if (event.type === "assignment") {
          environment.set(
            event.name,
            resolveStringValues(
              event.expression,
              environment,
              constants,
              resources,
            ),
          );
          continue;
        }
        for (const target of methodCallTargets(runtime, method, event)) {
          if (!runtime.reachable.has(target.id)) continue;
          const targetIncoming = incomingByMethod.get(target.id);
          for (
            let index = 0;
            index < target.parameterNames.length &&
            index < event.arguments.length;
            index += 1
          ) {
            changed = mergeValues(
              targetIncoming,
              target.parameterNames[index],
              resolveStringValues(
                event.arguments[index],
                environment,
                constants,
                resources,
              ),
            ) || changed;
          }
        }
      }
    }
  }
  return {
    constants,
    resources,
    environment(method, endPosition = Number.POSITIVE_INFINITY) {
      return stringEnvironment(
        method,
        incomingByMethod.get(method.id) ?? new Map(),
        constants,
        resources,
        endPosition,
      );
    },
  };
}

function stringParameters(parameters) {
  return splitTopLevel(parameters)
    .map((parameter) =>
      /\bString\s+([A-Za-z_$][\w$]*)\s*(?:\[\s*\])?\s*$/.exec(
        parameter.replace(/@\w+(?:\s*\([^)]*\))?\s*/g, "").trim(),
      )?.[1]
    )
    .filter(Boolean);
}

function splitTopLevelAddition(expression) {
  const code = maskJava(expression, false);
  const depth = { "(": 0, "[": 0, "{": 0 };
  const closing = { ")": "(", "]": "[", "}": "{" };
  for (let index = code.length - 1; index >= 0; index -= 1) {
    const character = code[index];
    if (character in closing) depth[closing[character]] += 1;
    else if (character in depth) depth[character] -= 1;
    else if (
      character === "+" &&
      Object.values(depth).every((value) => value === 0)
    ) {
      return [
        expression.slice(0, index).trim(),
        expression.slice(index + 1).trim(),
      ];
    }
  }
  return null;
}

function combinedSubjectOffset(left, right) {
  const pairs = [[left, right], [right, left]];
  for (const [index, offset] of pairs) {
    if (index?.kind !== "subject-index" || index.data.offset !== 0) continue;
    const marker = index.data.marker;
    const exactLength =
      offset?.kind === "marker-length" && offset.data.marker === marker ||
      offset?.kind === "number" && offset.data === marker.length;
    if (exactLength) {
      return {
        kind: "subject-index",
        data: { marker, offset: marker.length },
      };
    }
  }
  return null;
}

function exactSubjectOffset(value, marker, afterMarker) {
  return (
    value?.kind === "subject-index" &&
    value.data.marker === marker &&
    value.data.offset === (afterMarker ? marker.length : 0)
  );
}

function subjectExpression(
  expression,
  environment,
  constants,
  parserByName,
) {
  const value = unwrapParentheses(expression);
  const reference = /^(?:this\s*\.\s*)?([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference && environment.has(reference)) return environment.get(reference);

  const decoded = callAt(value, "decode");
  if (decoded && /(?:^|\.)URLDecoder$/.test(decoded.receiver.replace(/\s+/g, ""))) {
    const inner = subjectExpression(
      decoded.arguments[0] ?? "",
      environment,
      constants,
      parserByName,
    );
    return inner?.kind === "container" || inner?.kind === "blob"
      ? { ...inner, decoded: true }
      : null;
  }

  const indexed =
    /^([A-Za-z_$][\w$]*)\s*\[\s*([01])\s*\]$/.exec(value);
  if (indexed) {
    const array = environment.get(indexed[1]);
    return array?.kind === "parts" ? array.items[Number(indexed[2])] : null;
  }

  const accessor =
    /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(\s*\)$/.exec(
      value,
    );
  if (accessor) {
    const parts = environment.get(accessor[1]);
    if (parts?.kind === "subject-parts") {
      if (accessor[2] === parts.containerAccessor) {
        return { kind: "container", decoded: true };
      }
      if (accessor[2] === parts.blobAccessor) {
        return { kind: "blob", decoded: true };
      }
    }
  }

  const numeric = /^\d+$/.exec(value);
  if (numeric) return { kind: "number", data: Number(numeric[0]) };

  const length = callAt(value, "length");
  if (length && length.arguments.length === 0) {
    const marker = resolveString(length.receiver, constants);
    if (marker === "/containers/" || marker === "/blobs/") {
      return { kind: "marker-length", data: { marker } };
    }
  }

  const addition = splitTopLevelAddition(value);
  if (addition) {
    const left = subjectExpression(
      addition[0],
      environment,
      constants,
      parserByName,
    );
    const right = subjectExpression(
      addition[1],
      environment,
      constants,
      parserByName,
    );
    const combined = combinedSubjectOffset(left, right);
    if (combined) return combined;
  }

  const split = callAt(value, "split");
  if (split) {
    const receiver = subjectExpression(
      split.receiver,
      environment,
      constants,
      parserByName,
    );
    const separator = resolveString(split.arguments[0] ?? "", constants);
    const limit = Number(unwrapParentheses(split.arguments[1] ?? ""));
    if (
      split.arguments.length === 2 &&
      limit === 2 &&
      receiver?.kind === "subject" &&
      separator === "/containers/"
    ) {
      return {
        kind: "parts",
        items: [
          { kind: "prefix" },
          { kind: "after-container" },
        ],
      };
    }
    if (
      split.arguments.length === 2 &&
      limit === 2 &&
      receiver?.kind === "after-container" &&
      separator === "/blobs/"
    ) {
      return {
        kind: "parts",
        items: [
          { kind: "container" },
          { kind: "blob" },
        ],
      };
    }
  }

  const indexOf = callAt(value, "indexOf");
  if (indexOf) {
    const receiver = subjectExpression(
      indexOf.receiver,
      environment,
      constants,
      parserByName,
    );
    const marker = resolveString(indexOf.arguments[0] ?? "", constants);
    if (receiver?.kind === "subject" && marker === "/containers/") {
      return {
        kind: "subject-index",
        data: { marker, offset: 0 },
      };
    }
    if (receiver?.kind === "subject" && marker === "/blobs/") {
      return {
        kind: "subject-index",
        data: { marker, offset: 0 },
      };
    }
  }

  const substring = callAt(value, "substring");
  if (substring) {
    const receiver = subjectExpression(
      substring.receiver,
      environment,
      constants,
      parserByName,
    );
    if (receiver?.kind === "subject") {
      if (
        substring.arguments.length === 2 &&
        exactSubjectOffset(
          subjectExpression(
            substring.arguments[0],
            environment,
            constants,
            parserByName,
          ),
          "/containers/",
          true,
        ) &&
        exactSubjectOffset(
          subjectExpression(
            substring.arguments[1],
            environment,
            constants,
            parserByName,
          ),
          "/blobs/",
          false,
        )
      ) {
        return { kind: "container" };
      }
      if (
        substring.arguments.length === 1 &&
        exactSubjectOffset(
          subjectExpression(
            substring.arguments[0],
            environment,
            constants,
            parserByName,
          ),
          "/blobs/",
          true,
        )
      ) {
        return { kind: "blob" };
      }
    }
  }

  if (
    /\.matcher\s*\(/.test(value) &&
    [...environment.entries()].some(
      ([name, item]) =>
        item?.kind === "subject" &&
        new RegExp(`\\b${escapeRegExp(name)}\\b`).test(value),
    )
  ) {
    const matcher = callAt(value, "matcher");
    const compile = matcher && callAt(matcher.receiver, "compile");
    const pattern = compile
      ? resolveString(compile.arguments[0] ?? "", constants)
      : null;
    const groups = typeof pattern === "string"
      ? /\/containers\/\((?:\?<[\w$]+>)?([^)]+)\)\/blobs\/\((?:\?<[\w$]+>)?([^)]+)\)/.exec(
          pattern,
        )
      : null;
    const containerGroup = groups?.[1] ?? "";
    const boundedContainer = /\[\^\/\]/.test(containerGroup);
    const nonGreedyContainer = /(?:\.\*|\.\+)\?$/.test(containerGroup);
    if (groups && (boundedContainer || nonGreedyContainer)) {
      return { kind: "subject-matcher" };
    }
  }
  const group = callAt(value, "group");
  if (group) {
    const receiver = subjectExpression(
      group.receiver,
      environment,
      constants,
      parserByName,
    );
    const number = Number(group.arguments[0]);
    if (receiver?.kind === "subject-matcher" && number === 1) {
      return { kind: "container" };
    }
    if (receiver?.kind === "subject-matcher" && number === 2) {
      return { kind: "blob" };
    }
  }

  const directCall =
    /(?:^|\.)\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(value);
  const parser = directCall ? parserByName.get(directCall[1]) : null;
  if (parser) {
    const argument = subjectExpression(
      splitTopLevel(directCall[2])[0] ?? "",
      environment,
      constants,
      parserByName,
    );
    if (argument?.kind === "subject") {
      return {
        kind: "subject-parts",
        containerAccessor: parser.containerAccessor,
        blobAccessor: parser.blobAccessor,
      };
    }
  }
  return null;
}

function subjectValueKey(value) {
  if (!value) return "unknown";
  return JSON.stringify(value);
}

function assignSubjectValue(environment, assignment, value) {
  if (!assignment.conditional) {
    environment.set(assignment.name, value ?? { kind: "unknown" });
    return;
  }
  const previous = environment.get(assignment.name) ?? { kind: "unknown" };
  environment.set(
    assignment.name,
    subjectValueKey(previous) === subjectValueKey(value)
      ? previous
      : { kind: "unknown" },
  );
}

function subjectAssignments(
  method,
  constants,
  parserByName,
  endPosition = Number.POSITIVE_INFINITY,
) {
  const environment = new Map();
  const subjectNames = stringParameters(method.parameters);
  if (subjectNames.length === 0 && method.parameterNames.length > 0) {
    subjectNames.push(method.parameterNames[0]);
  }
  for (const name of subjectNames) {
    environment.set(name, { kind: "subject" });
  }
  for (const assignment of flowAssignmentEvents(method, endPosition)) {
    const parsed = subjectExpression(
      assignment.expression,
      environment,
      constants,
      parserByName,
    );
    assignSubjectValue(environment, assignment, parsed);
  }
  return environment;
}

function recordAccessors(source, className) {
  const declaration = new RegExp(
    `\\brecord\\s+${escapeRegExp(className)}\\s*\\(([^)]*)\\)`,
  ).exec(maskJava(source, false));
  const names = declaration ? parameterNames(declaration[1]) : [];
  return {
    containerAccessor: names[0] ?? null,
    blobAccessor: names[1] ?? null,
  };
}

function parserInfo(method, runtime, constants, parserByName) {
  const environment = subjectAssignments(method, constants, parserByName);
  const returnMatch =
    /\breturn\s+new\s+([A-Za-z_$][\w$]*)\s*\(/g.exec(method.literal);
  if (!returnMatch) {
    const delegated = /\breturn\s+([^;]+);/.exec(method.literal)?.[1];
    const value = delegated
      ? subjectExpression(
          delegated,
          environment,
          constants,
          parserByName,
        )
      : null;
    return value?.kind === "subject-parts"
      ? {
          name: method.name,
          className: "",
          containerAccessor: value.containerAccessor,
          blobAccessor: value.blobAccessor,
        }
      : null;
  }
  const open = method.literal.indexOf("(", returnMatch.index);
  const close = matchingIndex(method.literal, open);
  if (close < 0) return null;
  const args = splitTopLevel(method.literal.slice(open + 1, close));
  if (args.length !== 2) return null;
  const container = subjectExpression(
    args[0],
    environment,
    constants,
    parserByName,
  );
  const blob = subjectExpression(
    args[1],
    environment,
    constants,
    parserByName,
  );
  if (
    container?.kind !== "container" ||
    blob?.kind !== "blob" ||
    !container.decoded ||
    !blob.decoded
  ) {
    return null;
  }
  return {
    name: method.name,
    className: returnMatch[1],
    ...recordAccessors(runtime.source, returnMatch[1]),
  };
}

function validSubjectParsers(runtime) {
  const constants = stringConstants(runtime.literal);
  const parserByName = new Map();
  for (let pass = 0; pass < 3; pass += 1) {
    for (const method of reachableMethods(runtime)) {
      const info = parserInfo(method, runtime, constants, parserByName);
      if (info) parserByName.set(info.name, info);
    }
  }
  return { constants, parserByName };
}

function hasSubjectClientFlow(runtime, async, constants, parserByName) {
  const containerMethod = async
    ? "getBlobContainerAsyncClient"
    : "getBlobContainerClient";
  const blobMethod = async ? "getBlobAsyncClient" : "getBlobClient";
  let validFlow = false;
  for (const method of reachableMethods(runtime, async)) {
    for (const text of pathVariants(method.literal, 64)) {
      const variantMethod = {
        ...method,
        code: maskJava(text, false),
        literal: text,
      };
      const subjectEnvironment = new Map();
      const subjectNames = stringParameters(variantMethod.parameters);
      if (subjectNames.length === 0 && variantMethod.parameterNames.length > 0) {
        subjectNames.push(variantMethod.parameterNames[0]);
      }
      for (const name of subjectNames) {
        subjectEnvironment.set(name, { kind: "subject" });
      }
      const canonicalEnvironment = new Map(
        variantMethod.parameterNames.map((name) => [
          name,
          `parameter:${variantMethod.id}:${name}`,
        ]),
      );
      const parsedClients = new Set();
      let constructsBlobClient = false;
      for (const assignment of flowAssignmentEvents(variantMethod)) {
        const blobCall = callAt(assignment.expression, blobMethod);
        const containerCall = blobCall
          ? callAt(blobCall.receiver, containerMethod)
          : null;
        if (blobCall && containerCall) {
          constructsBlobClient = true;
          const container = subjectExpression(
            containerCall.arguments[0] ?? "",
            subjectEnvironment,
            constants,
            parserByName,
          );
          const blob = subjectExpression(
            blobCall.arguments[0] ?? "",
            subjectEnvironment,
            constants,
            parserByName,
          );
          if (container?.kind === "container" && blob?.kind === "blob") {
            parsedClients.add(
              canonicalExpression(
                assignment.expression,
                canonicalEnvironment,
              ),
            );
          }
        }
        assignSubjectValue(
          subjectEnvironment,
          assignment,
          subjectExpression(
            assignment.expression,
            subjectEnvironment,
            constants,
            parserByName,
          ),
        );
        canonicalEnvironment.set(
          assignment.name,
          canonicalExpression(assignment.expression, canonicalEnvironment),
        );
      }
      const completed = blobOperationVariants(runtime, variantMethod)
        .flatMap((variant) =>
          [...variant.properties].filter((identity) =>
            variant.downloads.has(identity)
          )
        );
      if (completed.length === 0) continue;
      if (!constructsBlobClient) continue;
      if (completed.some((identity) => !parsedClients.has(identity))) {
        return false;
      }
      validFlow = true;
    }
  }
  return validFlow;
}

function robustSubjectParsing(runtime) {
  const { constants, parserByName } = validSubjectParsers(runtime);
  return (
    hasSubjectClientFlow(runtime, false, constants, parserByName) &&
    hasSubjectClientFlow(runtime, true, constants, parserByName)
  );
}

function canonicalExpression(expression, environment) {
  const value = unwrapParentheses(expression);
  const reference = /^([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) {
    return environment.get(reference) ?? `symbol:${reference}`;
  }
  const blobMethod = /\.getBlobAsyncClient\s*\(/.test(value)
    ? "getBlobAsyncClient"
    : /\.getBlobClient\s*\(/.test(value)
      ? "getBlobClient"
      : null;
  if (blobMethod) {
    const call = callAt(value, blobMethod);
    if (call) {
      return `blob:${canonicalExpression(call.receiver, environment)}(${call.arguments
        .map((argument) => canonicalExpression(argument, environment))
        .join(",")})`;
    }
  }
  const containerMethod = /\.getBlobContainerAsyncClient\s*\(/.test(value)
    ? "getBlobContainerAsyncClient"
    : /\.getBlobContainerClient\s*\(/.test(value)
      ? "getBlobContainerClient"
      : null;
  if (containerMethod) {
    const call = callAt(value, containerMethod);
    if (call) {
      return `container:${canonicalExpression(call.receiver, environment)}(${call.arguments
        .map((argument) => canonicalExpression(argument, environment))
        .join(",")})`;
    }
  }
  return `expression:${value.replace(/\s+/g, "")}`;
}

function blobOperationVariants(
  runtime,
  method,
  incoming = new Map(),
  seen = new Set(),
  limit = 64,
) {
  if (seen.has(method.id) || seen.size > 16) {
    return [{ text: "", properties: new Set(), downloads: new Set() }];
  }
  const nextSeen = new Set(seen).add(method.id);
  const variants = [];
  for (const text of pathVariants(method.literal, limit)) {
    const variantMethod = {
      ...method,
      code: maskJava(text, false),
      literal: text,
    };
    const environment = new Map();
    for (const parameter of method.parameterNames) {
      environment.set(
        parameter,
        incoming.get(parameter) ?? `parameter:${method.id}:${parameter}`,
      );
    }
    const assignments = Array.from(
      variantMethod.literal.matchAll(
        /\b(?:final\s+)?(?:[A-Za-z_$][\w$.<>?]*|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
      ),
      (match) => ({
        type: "assignment",
        position: match.index,
        name: match[1],
        expression: match[2],
      }),
    );
    const events = [
      ...assignments,
      ...methodCalls(text).map((call) => ({ type: "call", ...call })),
    ].sort((left, right) =>
      left.position - right.position ||
      (left.type === "assignment" ? -1 : 1)
    );
    let states = [{
      text,
      properties: new Set(),
      downloads: new Set(),
    }];
    for (const event of events) {
      if (event.type === "assignment") {
        environment.set(
          event.name,
          canonicalExpression(event.expression, environment),
        );
        continue;
      }
      if (
        ["getProperties", "downloadContent", "downloadStream"].includes(
          event.name,
        )
      ) {
        const identity = canonicalExpression(event.receiver ?? "", environment);
        for (const state of states) {
          (
            event.name === "getProperties"
              ? state.properties
              : state.downloads
          ).add(identity);
        }
      }
      const targets = methodCallTargets(runtime, variantMethod, event)
        .filter(({ id }) => runtime.reachable.has(id));
      if (targets.length === 0) continue;
      const additions = [];
      for (const target of targets) {
        const targetIncoming = new Map();
        for (
          let index = 0;
          index < target.parameterNames.length &&
          index < event.arguments.length;
          index += 1
        ) {
          targetIncoming.set(
            target.parameterNames[index],
            canonicalExpression(event.arguments[index], environment),
          );
        }
        additions.push(
          ...blobOperationVariants(
            runtime,
            target,
            targetIncoming,
            nextSeen,
            limit,
          ),
        );
      }
      const expanded = [];
      for (const state of states) {
        for (const addition of additions) {
          expanded.push({
            text: `${state.text}\n${addition.text}`,
            properties: new Set([
              ...state.properties,
              ...addition.properties,
            ]),
            downloads: new Set([
              ...state.downloads,
              ...addition.downloads,
            ]),
          });
          if (expanded.length >= limit) break;
        }
        if (expanded.length >= limit) break;
      }
      if (expanded.length > 0) states = expanded;
    }
    variants.push(...states);
    if (variants.length >= limit) break;
  }
  return variants.slice(0, limit);
}

function createdSummaryVariant(variant, async) {
  const text = variant.text;
  const code = maskJava(text, false);
  const client = async ? "getBlobAsyncClient" : "getBlobClient";
  const complete = async
    ? /\.(?:then|zipWith|flatMap|block)\s*\(/.test(code)
    : true;
  const sameBlob = [...variant.properties].some((identity) =>
    variant.downloads.has(identity)
  );
  return (
    new RegExp(`\\.${client}\\s*\\(`).test(code) &&
    sameBlob &&
    /\.getProperties\s*\(/.test(code) &&
    /\.(?:downloadContent|downloadStream)\s*\(/.test(code) &&
    /\.getBlobSize\s*\(/.test(code) &&
    /\.getContentType\s*\(/.test(code) &&
    /\.getAccessTier\s*\(/.test(code) &&
    /System\.out\.(?:print|println|printf)\s*\(/.test(code) &&
    complete
  );
}

function hasCreatedSummary(runtime, async) {
  return reachableMethods(runtime, async)
    .filter(({ name }) => name !== "main")
    .some((method) =>
      blobOperationVariants(runtime, method)
        .some((variant) => createdSummaryVariant(variant, async))
    );
}

function methodBody(method) {
  return method.literal;
}

function syncRaceRegions(method) {
  const code = maskJava(method.literal, false);
  const regions = [];
  for (const match of code.matchAll(/\btry\s*\{/g)) {
    const tryOpen = code.indexOf("{", match.index);
    const tryClose = matchingIndex(code, tryOpen, "{", "}");
    if (tryClose < 0) continue;
    let cursor = skipWhitespace(code, tryClose + 1);
    while (startsWithWord(code, cursor, "catch")) {
      const header =
        /^catch\s*\(\s*(?:final\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)*BlobStorageException\s+([A-Za-z_$][\w$]*)\s*\)\s*\{/.exec(
          code.slice(cursor),
        );
      if (!header) break;
      const bodyOpen = code.indexOf("{", cursor);
      const bodyClose = matchingIndex(code, bodyOpen, "{", "}");
      if (bodyClose < 0) break;
      const control = assignmentControl(method, cursor);
      if (control.reachable) {
        regions.push({
          name: header[1],
          tryBody: method.literal.slice(tryOpen + 1, tryClose),
          body: method.literal.slice(bodyOpen + 1, bodyClose),
        });
      }
      cursor = skipWhitespace(code, bodyClose + 1);
    }
  }
  return regions;
}

function textCallsBlobRead(runtime, method, text, seen = new Set()) {
  if (
    /\.(?:getProperties|downloadContent|downloadStream)\s*\(/.test(
      maskJava(text, false),
    )
  ) {
    return true;
  }
  for (const call of methodCalls(text)) {
    for (const target of methodCallTargets(runtime, method, call)) {
      if (
        runtime.reachable.has(target.id) &&
        !seen.has(target.id) &&
        textCallsBlobRead(
          runtime,
          target,
          target.literal,
          new Set(seen).add(target.id),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function expandExceptionHelpers(
  runtime,
  method,
  source,
  exceptionName,
  seen = new Set(),
) {
  if (seen.has(method.id) || seen.size > 12) return source;
  const code = maskJava(source, false);
  for (const call of methodCalls(source)) {
    const argumentIndex = call.arguments.findIndex(
      (argument) => unwrapParentheses(argument) === exceptionName,
    );
    if (argumentIndex < 0) continue;
    let targets = methodCallTargets(runtime, method, call)
      .filter(
        (target) =>
          runtime.reachable.has(target.id) &&
          !seen.has(target.id) &&
          target.parameterNames[argumentIndex],
      );
    if (targets.length === 0) {
      const unique = (runtime.byName.get(call.name) ?? [])
        .filter(
          (target) =>
            runtime.reachable.has(target.id) &&
            !seen.has(target.id) &&
            target.parameterNames.length === call.arguments.length &&
            target.parameterNames[argumentIndex],
        );
      if (unique.length === 1) targets = unique;
    }
    if (targets.length !== 1) continue;
    const open = code.indexOf("(", call.position);
    const close = matchingIndex(code, open);
    const statementStart = Math.max(
      code.lastIndexOf(";", call.position),
      code.lastIndexOf("{", call.position),
      code.lastIndexOf("}", call.position),
    ) + 1;
    const statementEnd = code.indexOf(";", close);
    if (open < 0 || close < 0 || statementEnd < 0) continue;
    const prefix = code.slice(statementStart, call.position);
    const suffix = code.slice(close + 1, statementEnd);
    if (
      !/^\s*(?:return\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)?$/.test(prefix) ||
      suffix.trim()
    ) {
      continue;
    }
    const target = targets[0];
    const parameter = target.parameterNames[argumentIndex];
    let replacement = methodBody(target).replace(
      new RegExp(`\\b${escapeRegExp(parameter)}\\b`, "g"),
      exceptionName,
    );
    replacement = expandExceptionHelpers(
      runtime,
      target,
      replacement,
      exceptionName,
      new Set(seen).add(method.id),
    );
    return expandExceptionHelpers(
      runtime,
      method,
      `${source.slice(0, statementStart)}${replacement}${source.slice(statementEnd + 1)}`,
      exceptionName,
      seen,
    );
  }
  return source;
}

function javaBooleanForStatus(
  runtime,
  method,
  expression,
  exceptionName,
  status404,
  seen = new Set(),
) {
  const value = unwrapParentheses(expression);
  const staticValue = staticJavaBoolean(value);
  if (staticValue !== null) return staticValue;
  if (value.startsWith("!") && !value.startsWith("!=")) {
    const operand = javaBooleanForStatus(
      runtime,
      method,
      value.slice(1),
      exceptionName,
      status404,
      seen,
    );
    return operand === null ? null : !operand;
  }
  for (const [operator, anyValue, identity] of [
    ["||", true, false],
    ["&&", false, true],
  ]) {
    const parts = topLevelConditionParts(value, operator);
    if (parts.length <= 1) continue;
    let unknown = false;
    for (const part of parts) {
      const result = javaBooleanForStatus(
        runtime,
        method,
        part,
        exceptionName,
        status404,
        seen,
      );
      if (result === anyValue) return anyValue;
      unknown ||= result === null;
    }
    return unknown ? null : identity;
  }
  const status =
    `${escapeRegExp(exceptionName)}\\s*\\.\\s*getStatusCode\\s*\\(\\s*\\)`;
  for (const pattern of [
    new RegExp(`^\\s*${status}\\s*(==|!=)\\s*404\\s*$`),
    new RegExp(`^\\s*404\\s*(==|!=)\\s*${status}\\s*$`),
  ]) {
    const comparison = pattern.exec(value);
    if (comparison) {
      return comparison[1] === "==" ? status404 : !status404;
    }
  }
  const calls = methodCalls(value);
  if (calls.length !== 1 || seen.size > 12) return null;
  const call = calls[0];
  const argumentIndex = call.arguments.findIndex(
    (argument) => unwrapParentheses(argument) === exceptionName,
  );
  if (argumentIndex < 0) return null;
  let targets = methodCallTargets(runtime, method, call)
    .filter(
      (target) =>
        runtime.reachable.has(target.id) &&
        !seen.has(target.id) &&
        target.parameterNames[argumentIndex],
    );
  if (targets.length === 0) {
    const unique = (runtime.byName.get(call.name) ?? [])
      .filter(
        (target) =>
          runtime.reachable.has(target.id) &&
          !seen.has(target.id) &&
          target.parameterNames.length === call.arguments.length &&
          target.parameterNames[argumentIndex],
      );
    if (unique.length === 1) targets = unique;
  }
  if (targets.length !== 1) return null;
  const target = targets[0];
  const returned = /\breturn\s+([^;]+);/.exec(target.literal)?.[1];
  if (!returned) return null;
  return javaBooleanForStatus(
    runtime,
    target,
    returned.replace(
      new RegExp(
        `\\b${escapeRegExp(target.parameterNames[argumentIndex])}\\b`,
        "g",
      ),
      exceptionName,
    ),
    exceptionName,
    status404,
    new Set(seen).add(target.id),
  );
}

function statusPathVariants(
  runtime,
  method,
  source,
  exceptionName,
  status404,
  limit = 32,
) {
  const variants = [];
  const visit = (value) => {
    if (variants.length >= limit) return;
    const structural = maskJava(value, false);
    let match;
    for (const candidate of structural.matchAll(/\bif\s*\(/g)) {
      const conditional = conditionalAt(structural, candidate.index);
      if (!conditional) continue;
      match = { candidate, ...conditional };
      break;
    }
    if (!match) {
      const terminator = unconditionalSwitchTerminator(value);
      variants.push(terminator < 0 ? value : value.slice(0, terminator));
      return;
    }
    const before = value.slice(0, match.candidate.index);
    const after = value.slice(match.end);
    const consequent = statementBody(
      value,
      match.consequentStart,
      match.consequentEnd,
    );
    const alternate = statementBody(
      value,
      match.alternateStart,
      match.alternateEnd,
    );
    const condition = javaBooleanForStatus(
      runtime,
      method,
      match.condition,
      exceptionName,
      status404,
    );
    if (condition !== false) visit(`${before}${consequent}${after}`);
    if (condition !== true) visit(`${before}${alternate}${after}`);
  };
  visit(source);
  return variants;
}

function syncRaceHandlerIsValid(runtime, method, region) {
  const body = executableFunctionalText(
    expandExceptionHelpers(
      runtime,
      method,
      region.body,
      region.name,
    ),
  );
  const name = escapeRegExp(region.name);
  const rethrows = (path) =>
    new RegExp(`\\bthrow\\s+${name}\\s*;`).test(maskJava(path, false));
  const throws = (path) => /\bthrow\b/.test(maskJava(path, false));
  const notFoundPaths = statusPathVariants(
    runtime,
    method,
    body,
    region.name,
    true,
  );
  const otherPaths = statusPathVariants(
    runtime,
    method,
    body,
    region.name,
    false,
  );
  return (
    notFoundPaths.length > 0 &&
    otherPaths.length > 0 &&
    notFoundPaths.every(
      (path) =>
        logsUnsupportedEvent(runtime, method, path) &&
        !throws(path),
    ) &&
    otherPaths.every(rethrows)
  );
}

function handlesSyncRace(runtime) {
  return reachableMethods(runtime, false).some((method) =>
    syncRaceRegions(method).some(
      (region) =>
        textCallsBlobRead(runtime, method, region.tryBody) &&
        syncRaceHandlerIsValid(runtime, method, region),
    )
  );
}

function asyncRaceLambda(runtime, method, expression) {
  const lambda =
    /^\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*->\s*([\s\S]+)$/.exec(
      expression,
    );
  if (lambda) {
    const name = lambda[1] ?? lambda[2];
    const value = lambda[3].trim();
    return {
      method,
      name,
      body: value.startsWith("{") && value.endsWith("}")
        ? value.slice(1, -1)
        : `return ${value};`,
    };
  }
  const reference =
    /^(?:(?:this|[A-Za-z_$][\w$]*)\s*::\s*)([A-Za-z_$][\w$]*)$/.exec(
      expression.trim(),
    );
  if (!reference) return null;
  const targets = (runtime.byName.get(reference[1]) ?? [])
    .filter(
      (target) =>
        runtime.reachable.has(target.id) &&
        target.parameterNames.length === 1,
    );
  if (targets.length !== 1) return null;
  return {
    method: targets[0],
    name: targets[0].parameterNames[0],
    body: methodBody(targets[0]),
  };
}

function asyncRaceHandlerIsValid(runtime, handler) {
  const body = executableFunctionalText(
    expandExceptionHelpers(
      runtime,
      handler.method,
      handler.body,
      handler.name,
    ),
  );
  const name = escapeRegExp(handler.name);
  const suppresses = (path) =>
    /\bMono\s*\.\s*empty\s*\(/.test(maskJava(path, false)) &&
    !/\bMono\s*\.\s*error\s*\(/.test(maskJava(path, false));
  const reemits = (path) =>
    new RegExp(
      `\\bMono\\s*\\.\\s*error\\s*\\(\\s*${name}\\s*\\)`,
    ).test(maskJava(path, false));
  const notFoundPaths = statusPathVariants(
    runtime,
    handler.method,
    body,
    handler.name,
    true,
  );
  const otherPaths = statusPathVariants(
    runtime,
    handler.method,
    body,
    handler.name,
    false,
  );
  return (
    notFoundPaths.length > 0 &&
    otherPaths.length > 0 &&
    notFoundPaths.every(
      (path) =>
        logsUnsupportedEvent(runtime, handler.method, path) &&
        suppresses(path),
    ) &&
    otherPaths.every(reemits)
  );
}

function handlesAsyncRace(runtime) {
  return reachableMethods(runtime, true).some((method) => {
    const executable = executableMethodText(runtime, method);
    for (const call of methodCalls(executable)) {
      if (
        call.name !== "onErrorResume" ||
        !/(?:^|\.)BlobStorageException\s*\.\s*class$/.test(
          unwrapParentheses(call.arguments[0] ?? "").replace(/\s+/g, ""),
        ) ||
        !textCallsBlobRead(
          runtime,
          method,
          executable.slice(0, call.position),
        )
      ) {
        continue;
      }
      const handler = asyncRaceLambda(
        runtime,
        method,
        call.arguments[1] ?? "",
      );
      if (handler && asyncRaceHandlerIsValid(runtime, handler)) return true;
    }
    return false;
  });
}

function isSubjectHierarchy(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.split("/").filter(Boolean).length >= 3
  );
}

function hasConnectedEventConstructor(
  expression,
  environment,
  constants,
  subjectNames,
  dataNames,
  binaryNames,
) {
  const code = maskJava(expression, false);
  const literal = maskJava(expression, true);
  for (const match of code.matchAll(/\bnew\s+EventGridEvent\s*\(/g)) {
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    if (close < 0) continue;
    const args = splitTopLevel(literal.slice(open + 1, close));
    const subjects = resolveStringValues(
      args[0] ?? "",
      environment,
      constants,
    );
    const data = args[2] ?? "";
    const binary = callAt(data, "fromObject");
    const directData = Boolean(
      binary &&
      /(?:^|\.)BinaryData$/.test(binary.receiver.replace(/\s+/g, "")) &&
      expressionUsesAnyName(binary.arguments[0] ?? "", dataNames),
    );
    const dataReference = /^([A-Za-z_$][\w$]*)$/.exec(
      unwrapParentheses(data),
    )?.[1];
    if (
      [...subjects].some(isSubjectHierarchy) &&
      expressionUsesAnyName(args[0] ?? "", subjectNames) &&
      (directData || Boolean(dataReference && binaryNames.has(dataReference)))
    ) {
      return true;
    }
  }
  return false;
}

function sendsConstructedEvents(
  text,
  environment,
  constants,
  parameters,
) {
  const code = maskJava(text, false);
  const literal = maskJava(text, true);
  const inputs = publisherInputParameters(parameters);
  const subjectNames = inputDerivedNames(text, inputs.subject);
  const dataNames = inputDerivedNames(text, inputs.data);
  const binaryNames = inputDerivedBinaryData(text, dataNames);
  const events = [];
  for (const match of literal.matchAll(
    /\b(?:List\s*<[^;=]+>|Collection\s*<[^;=]+>|Iterable\s*<[^;=]+>|EventGridEvent|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g,
  )) {
    events.push({
      type: "assignment",
      position: match.index,
      name: match[1],
      expression: match[2],
    });
  }
  for (const match of code.matchAll(/\.\s*(?:sendEvents|sendEvent)\s*\(/g)) {
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    if (close < 0) continue;
    events.push({
      type: "send",
      position: match.index,
      expression: literal.slice(open + 1, close).trim(),
    });
  }
  events.sort((left, right) => left.position - right.position);
  const variables = new Set();
  const carriesEvents = (expression) => {
    if (
      hasConnectedEventConstructor(
        expression,
        environment,
        constants,
        subjectNames,
        dataNames,
        binaryNames,
      )
    ) {
      return true;
    }
    const reference = /^([A-Za-z_$][\w$]*)$/.exec(expression.trim())?.[1];
    if (reference) return variables.has(reference);
    const list = /^(?:java\.util\.)?List\s*\.\s*of\s*\(([\s\S]*)\)$/.exec(
      expression.trim(),
    );
    return Boolean(
      list &&
      list[1].trim() &&
      [...variables].some((name) =>
        new RegExp(`\\b${escapeRegExp(name)}\\b`).test(list[1])
      ),
    );
  };
  for (const event of events) {
    if (event.type === "assignment") {
      if (carriesEvents(event.expression)) variables.add(event.name);
      else variables.delete(event.name);
      continue;
    }
    const argument = event.expression;
    if (!argument) continue;
    if (
      carriesEvents(argument)
    ) {
      return true;
    }
  }
  return false;
}

function publishesCustomEvents(
  text,
  async,
  environment,
  constants,
  parameters,
) {
  const executable = executableFunctionalText(text);
  const code = maskJava(executable, false);
  const send = async
    ? /\.(?:sendEvents|sendEvent)\s*\([\s\S]*\)[\s\S]*\b(?:Mono|onErrorResume|then)\b/
    : /\.(?:sendEvents|sendEvent)\s*\(/;
  return (
    /\bnew\s+EventGridEvent\s*\(/.test(code) &&
    /\bBinaryData\s*\.\s*fromObject\s*\(/.test(code) &&
    send.test(code) &&
    sendsConstructedEvents(
      executable,
      environment,
      constants,
      parameters,
    )
  );
}

function emptyPublisherValue() {
  return {
    subject: false,
    data: false,
    binary: false,
    events: false,
    strings: new Set(),
  };
}

function copyPublisherValue(value) {
  return {
    subject: Boolean(value?.subject),
    data: Boolean(value?.data),
    binary: Boolean(value?.binary),
    events: Boolean(value?.events),
    strings: new Set(value?.strings ?? []),
  };
}

function mergePublisherValues(...values) {
  return {
    subject: values.some(({ subject }) => subject),
    data: values.some(({ data }) => data),
    binary: values.some(({ binary }) => binary),
    events: values.some(({ events }) => events),
    strings: new Set(values.flatMap(({ strings }) => [...strings])),
  };
}

function intersectPublisherValues(values) {
  if (values.length === 0) return emptyPublisherValue();
  return {
    subject: values.every(({ subject }) => subject),
    data: values.every(({ data }) => data),
    binary: values.every(({ binary }) => binary),
    events: values.every(({ events }) => events),
    strings: new Set(values.flatMap(({ strings }) => [...strings])),
  };
}

function mergeConditionalPublisherValue(previous, assigned) {
  return intersectPublisherValues([
    copyPublisherValue(previous),
    copyPublisherValue(assigned),
  ]);
}

function publisherStringEnvironment(environment) {
  return new Map(
    [...environment].map(([name, value]) => [name, new Set(value.strings)]),
  );
}

function publisherCall(expression) {
  const direct =
    /^(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(
      unwrapParentheses(expression),
    );
  if (!direct) return null;
  return {
    name: direct[2],
    receiver: direct[1] ?? null,
    arguments: splitTopLevel(direct[3]),
  };
}

function publisherExpression(
  runtime,
  method,
  expression,
  environment,
  trusted,
  strings,
  state,
  seen,
  sourcePosition = method.literal.length,
) {
  const value = unwrapParentheses(expression);
  const directString = javaStringValue(value);
  if (directString !== null) {
    return {
      ...emptyPublisherValue(),
      strings: new Set([directString]),
    };
  }
  const reference = /^([A-Za-z_$][\w$]*)$/.exec(value)?.[1];
  if (reference) {
    if (environment.has(reference)) {
      return copyPublisherValue(environment.get(reference));
    }
    return {
      subject: trusted.subject.has(reference),
      data: trusted.data.has(reference),
      binary: trusted.binary.has(reference),
      events: false,
      strings: resolveStringValues(
        reference,
        publisherStringEnvironment(environment),
        strings.constants,
        strings.resources,
      ),
    };
  }

  for (const collectionMethod of ["of", "asList", "singletonList"]) {
    const collection = callAt(value, collectionMethod);
    const receiver = collection?.receiver.replace(/\s+/g, "") ?? "";
    const receiverType = receiver.endsWith("Arrays")
      ? ["java.util", "Arrays"]
      : receiver.endsWith("Collections")
        ? ["java.util", "Collections"]
        : receiver.endsWith("List")
          ? ["java.util", "List"]
          : null;
    if (!collection || collection.suffix || !receiverType) continue;
    if (
      !trustedJdkStaticReceiver(
        runtime,
        method,
        collection.receiver,
        receiverType[0],
        receiverType[1],
        sourcePosition,
      )
    ) {
      return emptyPublisherValue();
    }
    const items = collection.arguments.map((argument) =>
      publisherExpression(
        runtime,
        method,
        argument,
        environment,
        trusted,
        strings,
        state,
        seen,
        sourcePosition,
      )
    );
    return mergePublisherValues(...items, emptyPublisherValue());
  }

  for (const match of maskJava(value, false).matchAll(
    /\bnew\s+EventGridEvent\s*\(/g,
  )) {
    const open = maskJava(value, false).indexOf("(", match.index);
    const close = matchingIndex(maskJava(value, false), open);
    if (close < 0) continue;
    const argumentsList = splitTopLevel(
      maskJava(value, true).slice(open + 1, close),
    );
    const subject = publisherExpression(
      runtime,
      method,
      argumentsList[0] ?? "",
      environment,
      trusted,
      strings,
      state,
      seen,
      sourcePosition,
    );
    const data = publisherExpression(
      runtime,
      method,
      argumentsList[2] ?? "",
      environment,
      trusted,
      strings,
      state,
      seen,
      sourcePosition,
    );
    if (
      subject.subject &&
      [...subject.strings].some(isSubjectHierarchy) &&
      (data.binary || data.data)
    ) {
      return {
        ...emptyPublisherValue(),
        events: true,
      };
    }
  }

  const binary = callAt(value, "fromObject");
  if (
    binary &&
    /(?:^|\.)BinaryData$/.test(binary.receiver.replace(/\s+/g, ""))
  ) {
    const data = publisherExpression(
      runtime,
      method,
      binary.arguments[0] ?? "",
      environment,
      trusted,
      strings,
      state,
      seen,
      sourcePosition,
    );
    return {
      ...emptyPublisherValue(),
      binary: data.data,
    };
  }

  const call = publisherCall(value);
  if (call) {
    let result = emptyPublisherValue();
    for (const target of methodCallTargets(runtime, method, call)) {
      if (!runtime.reachable.has(target.id) || seen.has(target.id)) continue;
      const incoming = new Map();
      for (
        let index = 0;
        index < target.parameterNames.length &&
        index < call.arguments.length;
        index += 1
      ) {
        incoming.set(
          target.parameterNames[index],
          publisherExpression(
            runtime,
            method,
            call.arguments[index],
            environment,
            trusted,
            strings,
            state,
            seen,
            sourcePosition,
          ),
        );
      }
      const analyzed = analyzePublisherMethod(
        runtime,
        target,
        incoming,
        strings,
        new Set(seen).add(method.id),
      );
      state.sent = state.sent || analyzed.sent;
      result = mergePublisherValues(result, analyzed.value);
    }
    if (
      ["map", "flatMap"].includes(call.name) &&
      expressionUsesAnyName(value, trusted.data)
    ) {
      result.data = true;
    }
    if (result.subject || result.data || result.binary || result.events) {
      return result;
    }
  }

  const additions = splitTopLevelAddition(value);
  if (additions) {
    const left = publisherExpression(
      runtime,
      method,
      additions[0],
      environment,
      trusted,
      strings,
      state,
      seen,
      sourcePosition,
    );
    const right = publisherExpression(
      runtime,
      method,
      additions[1],
      environment,
      trusted,
      strings,
      state,
      seen,
      sourcePosition,
    );
    const combined = mergePublisherValues(left, right);
    combined.strings = new Set();
    for (const leftValue of left.strings) {
      for (const rightValue of right.strings) {
        combined.strings.add(`${leftValue}${rightValue}`);
      }
    }
    return combined;
  }

  const referenced = [
    ...environment,
    ...[...trusted.subject]
      .filter((name) => !environment.has(name))
      .map((name) => [
      name,
      {
        ...emptyPublisherValue(),
        subject: true,
        strings: resolveStringValues(
          name,
          publisherStringEnvironment(environment),
          strings.constants,
          strings.resources,
        ),
      },
      ]),
    ...[...trusted.data]
      .filter((name) => !environment.has(name))
      .map((name) => [
      name,
      { ...emptyPublisherValue(), data: true },
      ]),
    ...[...trusted.binary]
      .filter((name) => !environment.has(name))
      .map((name) => [
      name,
      { ...emptyPublisherValue(), binary: true },
      ]),
  ]
    .filter(([name]) =>
      new RegExp(`\\b${escapeRegExp(name)}\\b`).test(maskJava(value, false))
    )
    .map(([, flow]) => flow);
  const result = mergePublisherValues(
    ...referenced,
    emptyPublisherValue(),
  );
  result.strings = resolveStringValues(
    value,
    publisherStringEnvironment(environment),
    strings.constants,
    strings.resources,
  );
  return result;
}

function completedSwitchVariants(source, limit = 64) {
  const variants = [];
  const visit = (value) => {
    if (variants.length >= limit) return;
    const code = maskJava(value, false);
    const match = /\bswitch\s*\(/g.exec(code);
    if (!match) {
      variants.push(value);
      return;
    }
    const open = code.indexOf("(", match.index);
    const close = matchingIndex(code, open);
    const bodyOpen = code.indexOf("{", close);
    const bodyClose = matchingIndex(code, bodyOpen, "{", "}");
    if (close < 0 || bodyOpen < 0 || bodyClose < 0) {
      variants.push(value);
      return;
    }
    const arms = switchArms(code, value, bodyOpen, bodyClose);
    if (arms.length === 0) {
      variants.push(value);
      return;
    }
    const before = value.slice(0, match.index);
    const after = value.slice(bodyClose + 1);
    for (let start = 0; start < arms.length; start += 1) {
      let selected = "";
      for (let index = start; index < arms.length; index += 1) {
        const arm = arms[index];
        const terminator = switchTerminator(arm.literal);
        if (terminator?.kind === "break" && !terminator.label) {
          selected += arm.literal.slice(0, terminator.start);
        } else {
          selected += arm.literal.slice(
            0,
            terminator?.end ?? arm.literal.length,
          );
        }
        if (arm.arrow || terminator) break;
      }
      visit(`${before}${selected}${after}`);
      if (variants.length >= limit) break;
    }
    if (!arms.some((arm) => arm.default) && variants.length < limit) {
      visit(`${before}${after}`);
    }
  };
  visit(source);
  return [...new Set(variants)].slice(0, limit);
}

function analyzePublisherMethod(
  runtime,
  method,
  incoming,
  strings,
  seen = new Set(),
  expandBranches = true,
) {
  if (seen.has(method.id) || seen.size > 16) {
    return {
      value: emptyPublisherValue(),
      sent: false,
      invalid: false,
      terminated: false,
      returned: false,
    };
  }
  const executable = executableMethodText(runtime, method);
  if (executable !== method.literal) {
    method = {
      ...method,
      code: maskJava(executable, false),
      literal: executable,
    };
  }
  if (expandBranches) {
    const finalized = normalizeForLoopUpdates(
      expandAbruptFinalizers(method.literal),
    );
    if (finalized !== method.literal) {
      method = {
        ...method,
        code: maskJava(finalized, false),
        literal: finalized,
      };
    }
    const variants = completedConditionalVariants(
      method.literal,
      method.literal.length,
      64,
    ).flatMap((literal) => completedSwitchVariants(literal, 64));
    if (
      variants.length !== 1 ||
      variants[0] !== method.literal
    ) {
      const analyzed = variants.map((literal) =>
        analyzePublisherMethod(
          runtime,
          {
            ...method,
            code: maskJava(literal, false),
            literal,
          },
          incoming,
          strings,
          seen,
          false,
        )
      );
      const valuePaths = analyzed.filter(
        ({ returned, terminated }) => returned || !terminated,
      );
      return {
        value: intersectPublisherValues(valuePaths.map(({ value }) => value)),
        sent:
          analyzed.some(({ sent }) => sent) &&
          analyzed.every(({ sent, terminated, invalid }) =>
            !invalid && (sent || terminated)
          ),
        invalid: analyzed.some(({ invalid }) => invalid),
        terminated: analyzed.length > 0 &&
          analyzed.every(({ terminated }) => terminated),
        returned: analyzed.length > 0 &&
          analyzed.every(({ returned }) => returned),
      };
    }
  }
  const environment = new Map();
  for (const parameter of method.parameterNames) {
    environment.set(
      parameter,
      copyPublisherValue(incoming.get(parameter)),
    );
  }
  const trusted = {
    subject: inputDerivedNames(
      method.literal,
      method.parameterNames.filter(
        (name) => environment.get(name)?.subject,
      ),
    ),
    data: inputDerivedNames(
      method.literal,
      method.parameterNames.filter(
        (name) => environment.get(name)?.data,
      ),
    ),
  };
  trusted.binary = inputDerivedBinaryData(method.literal, trusted.data);
  const state = { sent: false, invalid: false };
  const events = [
    ...flowAssignmentEvents(method).map((assignment) => ({
      type: "assignment",
      ...assignment,
    })),
    ...methodCalls(method.literal).map((call) => ({
      type: "call",
      ...call,
    })),
    ...Array.from(
      method.literal.matchAll(
        /\b(return)(?:\s+([^;]+))?;|\b(throw)\s+([^;]+);|\b(continue)(?:\s+([A-Za-z_$][\w$]*))?\s*;|\b(break)(?:\s+([A-Za-z_$][\w$]*))?\s*;/g,
      ),
      (match) => ({
        type: "control",
        control: match[1] ?? match[3] ?? match[5] ?? match[7],
        position: match.index,
        end: match.index + match[0].length,
        expression: match[2] ?? match[4] ?? "",
        targetPosition: match[5]
          ? continueTargetPosition(
            method.literal,
            match.index,
            match[6] ?? null,
          )
          : match[7]
            ? breakTargetEnd(method.literal, match.index, match[8] ?? null)
          : null,
        ...assignmentControl(method, match.index),
      }),
    ),
  ]
    .filter(({ reachable = true }) => reachable)
    .sort((left, right) => left.position - right.position);
  let returned = emptyPublisherValue();
  let terminalControlEnd = null;
  let skipUntil = null;
  let terminated = false;
  let returnedControl = false;
  const nextSeen = new Set(seen).add(method.id);
  for (const event of events) {
    if (skipUntil !== null) {
      if (event.position < skipUntil) continue;
      skipUntil = null;
    }
    if (
      terminalControlEnd !== null &&
      event.position >= terminalControlEnd
    ) {
      break;
    }
    if (event.type === "assignment") {
      const assigned = publisherExpression(
        runtime,
        method,
        event.expression,
        environment,
        trusted,
        strings,
        state,
        nextSeen,
        event.expressionPosition ?? event.position,
      );
      environment.set(
        event.name,
        event.conditional
          ? mergeConditionalPublisherValue(
            environment.get(event.name),
            assigned,
          )
          : assigned,
      );
      continue;
    }
    if (event.type === "control") {
      if (event.control === "continue" || event.control === "break") {
        if (!event.conditional) {
          skipUntil = event.targetPosition ?? method.literal.length;
        }
        continue;
      }
      if (event.control === "return" && event.expression) {
        const value = publisherExpression(
          runtime,
          method,
          event.expression,
          environment,
          trusted,
          strings,
          state,
          nextSeen,
          event.position,
        );
        returned = event.conditional
          ? mergePublisherValues(returned, value)
          : value;
      }
      if (!event.conditional) {
        terminalControlEnd = event.end;
        terminated = true;
        returnedControl = event.control === "return";
      }
      continue;
    }
    if (["sendEvent", "sendEvents"].includes(event.name)) {
      const payload = publisherExpression(
        runtime,
        method,
        event.arguments[0] ?? "",
        environment,
        trusted,
        strings,
        state,
        nextSeen,
        event.position,
      );
      if (payload.events) state.sent = true;
      else state.invalid = true;
      continue;
    }
    for (const target of methodCallTargets(runtime, method, event)) {
      if (!runtime.reachable.has(target.id) || nextSeen.has(target.id)) {
        continue;
      }
      const targetIncoming = new Map();
      for (
        let index = 0;
        index < target.parameterNames.length &&
        index < event.arguments.length;
        index += 1
      ) {
        targetIncoming.set(
          target.parameterNames[index],
          publisherExpression(
            runtime,
            method,
            event.arguments[index],
            environment,
            trusted,
            strings,
            state,
            nextSeen,
            event.position,
          ),
        );
      }
      const analyzed = analyzePublisherMethod(
        runtime,
        target,
        targetIncoming,
        strings,
        nextSeen,
      );
      state.sent = state.sent || analyzed.sent;
      state.invalid = state.invalid || analyzed.invalid;
    }
  }
  return {
    value: returned,
    sent: state.sent && !state.invalid,
    invalid: state.invalid,
    terminated,
    returned: returnedControl,
  };
}

function methodReachesSend(runtime, method, seen = new Set()) {
  if (seen.has(method.id) || seen.size > 16) return false;
  const executable = executableMethodText(runtime, method);
  if (/\.\s*(?:sendEvent|sendEvents)\s*\(/.test(maskJava(executable, false))) {
    return true;
  }
  const nextSeen = new Set(seen).add(method.id);
  return methodCalls(executable).some((call) =>
    methodCallTargets(runtime, method, call).some((target) =>
      runtime.reachable.has(target.id) &&
      methodReachesSend(runtime, target, nextSeen)
    )
  );
}

function hasConnectedCustomPublishers(runtime) {
  const strings = propagatedStringArguments(runtime);
  return [false, true].every((async) =>
    reachableMethods(runtime, async)
      .filter((method) => {
        const inputs = publisherInputParameters(method.parameters);
        return (
          method.name !== "main" &&
          method.modifiers.has("public") &&
          inputs.subject.length > 0 &&
          inputs.data.length > 0 &&
          methodReachesSend(runtime, method)
        );
      })
      .map((method) => {
        const inputs = publisherInputParameters(method.parameters);
        const incoming = new Map();
        const stringEnvironment = strings.environment(method);
        for (const parameter of method.parameterNames) {
          incoming.set(parameter, {
            subject: inputs.subject.includes(parameter),
            data: inputs.data.includes(parameter),
            binary: false,
            events: false,
            strings: new Set(stringEnvironment.get(parameter) ?? []),
          });
        }
        return analyzePublisherMethod(
          runtime,
          method,
          incoming,
          strings,
        ).sent;
      })
      .every(Boolean) &&
    reachableMethods(runtime, async)
      .some((method) => {
        const inputs = publisherInputParameters(method.parameters);
        return (
          method.name !== "main" &&
          method.modifiers.has("public") &&
          inputs.subject.length > 0 &&
          inputs.data.length > 0 &&
          methodReachesSend(runtime, method)
        );
      })
  );
}

function handlesPublishError(runtime, method, text, async) {
  const executable = executableMethodText(runtime, method, text);
  const code = maskJava(executable, false);
  if (async) {
    for (const call of methodCalls(executable)) {
      if (
        call.name !== "onErrorResume" ||
        !/(?:^|\.)HttpResponseException\s*\.\s*class$/.test(
          unwrapParentheses(call.arguments[0] ?? "").replace(/\s+/g, ""),
        )
      ) {
        continue;
      }
      const handler = asyncRaceLambda(
        runtime,
        method,
        call.arguments[1] ?? "",
      );
      if (!handler) continue;
      const body = executableFunctionalText(handler.body);
      if (
        hasRecognizedWarning(runtime, handler.method, body) &&
        new RegExp(
          `\\bMono\\s*\\.\\s*error\\s*\\(\\s*${escapeRegExp(handler.name)}\\s*\\)`,
        ).test(maskJava(body, false))
      ) {
        return true;
      }
    }
    return false;
  }
  const caught = /catch\s*\(\s*HttpResponseException\s+(\w+)\s*\)\s*\{([\s\S]*?)\}/.exec(
    code,
  );
  return Boolean(
    caught &&
    hasRecognizedWarning(runtime, method, caught[2]) &&
    new RegExp(`\\bthrow\\s+${escapeRegExp(caught[1])}\\s*;`).test(caught[2]),
  );
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function jsonObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value),
  );
}

function validTimestamp(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function validEventGridSample(event) {
  return (
    jsonObject(event) &&
    nonEmptyString(event.id) &&
    nonEmptyString(event.eventType) &&
    nonEmptyString(event.subject) &&
    validTimestamp(event.eventTime) &&
    jsonObject(event.data) &&
    typeof event.dataVersion === "string" &&
    typeof event.metadataVersion === "string" &&
    nonEmptyString(event.topic)
  );
}

function validCloudEventSample(event) {
  return (
    jsonObject(event) &&
    event.specversion === "1.0" &&
    nonEmptyString(event.id) &&
    nonEmptyString(event.source) &&
    nonEmptyString(event.type) &&
    nonEmptyString(event.subject) &&
    jsonObject(event.data) &&
    (!Object.hasOwn(event, "time") || validTimestamp(event.time)) &&
    (
      !Object.hasOwn(event, "datacontenttype") ||
      nonEmptyString(event.datacontenttype)
    )
  );
}

function sampleSchemas(value) {
  const schemas = new Set();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return schemas;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return schemas;
  const eventGridTypes = new Set(
    parsed.filter(validEventGridSample).map(({ eventType }) => eventType),
  );
  if (
    parsed.every(validEventGridSample) &&
    eventGridTypes.has("Microsoft.Storage.BlobCreated") &&
    eventGridTypes.has("Microsoft.Storage.BlobDeleted")
  ) {
    schemas.add("eventgrid");
  }
  const cloudTypes = new Set(
    parsed.filter(validCloudEventSample).map(({ type }) => type),
  );
  if (
    parsed.every(validCloudEventSample) &&
    cloudTypes.has("Microsoft.Storage.BlobCreated") &&
    cloudTypes.has("Microsoft.Storage.BlobDeleted")
  ) {
    schemas.add("cloud");
  }
  return schemas;
}

function deduplicateSequences(sequences, limit) {
  const unique = new Map();
  for (const sequence of sequences) {
    const key = sequence.join("\u0000");
    if (!unique.has(key)) unique.set(key, sequence);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

function appendSequenceVariants(current, additions, limit) {
  const combined = [];
  for (const prefix of current) {
    for (const addition of additions) {
      combined.push([...prefix, ...addition]);
      if (combined.length >= limit) {
        return deduplicateSequences(combined, limit);
      }
    }
  }
  return deduplicateSequences(combined, limit);
}

function methodReachesRouting(runtime, method, seen = new Set()) {
  if (seen.has(method.id) || seen.size > 16) return false;
  if (routesEvents(runtime, method, runtime.literal)) return true;
  const nextSeen = new Set(seen).add(method.id);
  for (const call of methodCalls(method.literal)) {
    for (const target of methodCallTargets(runtime, method, call)) {
      if (
        runtime.reachable.has(target.id) &&
        methodIsAsync(target) === methodIsAsync(method) &&
        methodReachesRouting(runtime, target, nextSeen)
      ) {
        return true;
      }
    }
  }
  return false;
}

function directDemoActions(
  runtime,
  method,
  text,
  call,
  environment,
  constants,
  resources,
) {
  const actions = [];
  const schema = call.receiver === "EventGridEvent"
    ? "eventgrid"
    : call.receiver === "CloudEvent"
      ? "cloud"
      : null;
  const derivedInputs = inputDerivedNames(
    method.literal,
    method.parameterNames,
  );
  if (
    call.name === "fromString" &&
    schema &&
    method.name !== "main" &&
    expressionUsesAnyName(call.arguments[0] ?? "", derivedInputs) &&
    methodReachesRouting(runtime, method)
  ) {
    const values = resolveStringValues(
      call.arguments[0] ?? "",
      environment,
      constants,
      resources,
    );
    if ([...values].some((value) => sampleSchemas(value).has(schema))) {
      actions.push(`${methodIsAsync(method) ? "async" : "sync"}:${schema}`);
    }
  }
  if (
    ["sendEvent", "sendEvents"].includes(call.name) &&
    publishesCustomEvents(
      text,
      methodIsAsync(method),
      environment,
      constants,
      method.parameters,
    )
  ) {
    actions.push(`${methodIsAsync(method) ? "async" : "sync"}:publish`);
  }
  if (call.name === "block") actions.push("async:block");
  return actions;
}

function demoExecutionVariants(
  runtime,
  method,
  incoming,
  constants,
  resources,
  seen = new Set(),
  limit = 96,
) {
  if (seen.has(method.id) || seen.size > 16) return [[]];
  const nextSeen = new Set(seen).add(method.id);
  const variants = [];
  for (const text of pathVariants(method.literal, limit)) {
    const variantMethod = {
      ...method,
      code: maskJava(text, false),
      literal: text,
    };
    const environment = new Map(
      [...constants].map(([name, value]) => [name, new Set([value])]),
    );
    for (const parameter of method.parameterNames) {
      environment.set(parameter, new Set(incoming.get(parameter) ?? []));
    }
    const events = [
      ...stringAssignmentEvents(variantMethod),
      ...methodCalls(text).map((call) => ({
        type: "call",
        ...call,
      })),
    ].sort((left, right) => left.position - right.position);
    let sequences = [[]];
    for (const event of events) {
      if (event.type === "assignment") {
        environment.set(
          event.name,
          resolveStringValues(
            event.expression,
            environment,
            constants,
            resources,
          ),
        );
        continue;
      }
      const targets = methodCallTargets(runtime, variantMethod, event);
      let additions = [];
      for (const target of targets) {
        const targetIncoming = new Map();
        for (
          let index = 0;
          index < target.parameterNames.length &&
          index < event.arguments.length;
          index += 1
        ) {
          targetIncoming.set(
            target.parameterNames[index],
            resolveStringValues(
              event.arguments[index],
              environment,
              constants,
              resources,
            ),
          );
        }
        additions.push(
          ...demoExecutionVariants(
            runtime,
            target,
            targetIncoming,
            constants,
            resources,
            nextSeen,
            limit,
          ),
        );
      }
      if (additions.length === 0) {
        additions = [[
          ...directDemoActions(
            runtime,
            variantMethod,
            text,
            event,
            environment,
            constants,
            resources,
          ),
        ]];
      }
      sequences = appendSequenceVariants(sequences, additions, limit);
    }
    variants.push(...sequences);
    if (variants.length >= limit) break;
  }
  return deduplicateSequences(variants, limit);
}

function connectedDemoSequence(actions) {
  const positions = (name) =>
    actions.flatMap((action, index) => action === name ? [index] : []);
  const syncEventGrid = positions("sync:eventgrid");
  const syncCloud = positions("sync:cloud");
  const syncPublish = positions("sync:publish");
  const asyncEventGrid = positions("async:eventgrid");
  const asyncCloud = positions("async:cloud");
  const asyncPublish = positions("async:publish");
  const asyncBlock = positions("async:block");
  if ([
    syncEventGrid,
    syncCloud,
    syncPublish,
    asyncEventGrid,
    asyncCloud,
    asyncPublish,
    asyncBlock,
  ].some((matches) => matches.length === 0)) {
    return false;
  }
  const syncReceives = [...syncEventGrid, ...syncCloud];
  const asyncReceives = [...asyncEventGrid, ...asyncCloud];
  const syncActions = [...syncReceives, ...syncPublish];
  const asyncActions = [...asyncReceives, ...asyncPublish];
  return (
    Math.max(...syncReceives) < Math.min(...syncPublish) &&
    Math.max(...syncActions) < Math.min(...asyncActions) &&
    Math.max(...asyncReceives) < Math.min(...asyncPublish) &&
    asyncBlock.some((position) => position > Math.max(...asyncActions))
  );
}

function connectedDemo(runtime) {
  const constants = stringConstants(runtime.literal);
  const resources = runtime.resources ?? new Map();
  return runtime.methods
    .filter(({ name, id }) => name === "main" && runtime.reachable.has(id))
    .some((main) =>
      demoExecutionVariants(
        runtime,
        main,
        new Map(),
        constants,
        resources,
      )
        .some(connectedDemoSequence)
    );
}

const rules = {
  "prompt/source-manifest": ({ build }) => hasPinnedMavenManifest(build),
  "prompt/secure-client-configuration": ({ runtime }) => {
    if (
      hasForbiddenAuthentication(runtime) ||
      ![
        "BlobServiceClientBuilder",
        "EventGridPublisherClientBuilder",
      ].every((name) => hasOfficialType(runtime, name))
    ) {
      return false;
    }
    return secureBuilderConfiguration(runtime) && secureClientUsage(runtime);
  },
  "prompt/dual-schema-receivers": ({ runtime }) => {
    if (!["EventGridEvent", "CloudEvent"].every((name) => hasOfficialType(runtime, name))) {
      return false;
    }
    return [false, true].every((async) =>
      schemaDeserializationRoutes(runtime, async, "EventGridEvent") &&
      schemaDeserializationRoutes(runtime, async, "CloudEvent")
    );
  },
  "prompt/event-routing": ({ runtime }) =>
    hasRoutingMethod(runtime, false) &&
    hasRoutingMethod(runtime, true) &&
    [false, true].every((async) =>
      schemaDeserializationRoutes(runtime, async, "EventGridEvent") &&
      schemaDeserializationRoutes(runtime, async, "CloudEvent")
    ),
  "prompt/blob-subject-parsing": ({ runtime }) =>
    ["BlobClient", "BlobAsyncClient"].every((name) => hasOfficialType(runtime, name)) &&
    robustSubjectParsing(runtime),
  "prompt/blob-created-summary": ({ runtime }) =>
    hasOfficialType(runtime, "BlobProperties") &&
    hasCreatedSummary(runtime, false) &&
    hasCreatedSummary(runtime, true),
  "prompt/blob-race-handling": ({ runtime }) =>
    hasOfficialType(runtime, "BlobStorageException") &&
    handlesSyncRace(runtime) &&
    handlesAsyncRace(runtime),
  "prompt/custom-event-publishing": ({ runtime }) =>
    [
      "EventGridEvent",
      "BinaryData",
      "EventGridPublisherClient",
      "EventGridPublisherAsyncClient",
    ].every((name) => hasOfficialType(runtime, name)) &&
    hasConnectedCustomPublishers(runtime),
  "prompt/publish-error-handling": ({ runtime }) =>
    hasOfficialType(runtime, "HttpResponseException") &&
    anyConnectedVariant(
      runtime,
      false,
      (text, method) => handlesPublishError(runtime, method, text, false),
    ) &&
    anyConnectedVariant(
      runtime,
      true,
      (text, method) => handlesPublishError(runtime, method, text, true),
    ),
  "prompt/connected-demo": ({ runtime }) => connectedDemo(runtime),
};

export function evaluateRule(name, workspace) {
  const rule = rules[name];
  if (!rule) throw new Error(`Unknown rule: ${name}`);
  const hasSource = Array.isArray(workspace.sourceFiles)
    ? workspace.sourceFiles.length > 0
    : Boolean(workspace.source?.trim());
  if (!hasSource) return false;
  const runtime = name === "prompt/source-manifest"
    ? null
    : runtimeFor(workspace);
  if (runtime && hasLocalOfficialSdkDefinition(runtime)) return false;
  return rule({ ...workspace, build: workspace.build ?? "", runtime });
}

export function ruleNames() {
  return Object.keys(rules);
}
