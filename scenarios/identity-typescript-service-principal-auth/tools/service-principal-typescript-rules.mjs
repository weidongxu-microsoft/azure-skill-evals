function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskSource(source, maskStrings) {
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
        result += maskStrings ? "  " : current + next;
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        result += current;
        state = "code";
      } else {
        result += maskStrings && current !== "\n" ? " " : current;
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
      result += current;
      if (current === "'") state = "single";
      if (current === '"') state = "double";
      if (current === "`") state = "template";
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

    if (state === "line-comment") {
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
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

    if (current === "/" && next === "/") {
      index += 1;
      state = "line-comment";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 1;
      state = "block-comment";
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

function splitTopLevel(argumentsText) {
  const parts = [];
  let current = "";
  let depth = 0;
  let state = "code";

  for (let index = 0; index < argumentsText.length; index += 1) {
    const character = argumentsText[index];
    const next = argumentsText[index + 1];

    if (state === "line-comment") {
      current += character;
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      current += character;
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state !== "code") {
      current += character;
      if (character === "\\") {
        current += next;
        index += 1;
      } else if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      current += character + next;
      index += 1;
      state = "line-comment";
      continue;
    }
    if (character === "/" && next === "*") {
      current += character + next;
      index += 1;
      state = "block-comment";
      continue;
    }
    if (character === "'") state = "single";
    if (character === '"') state = "double";
    if (character === "`") state = "template";
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;

    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }

  if (current.trim() || argumentsText.includes(",")) {
    parts.push(current.trim());
  }
  return parts;
}

function expressionCode(source) {
  let result = "";
  let state = "code";
  const templateDepths = [];

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      result += current === "\n" ? "\n" : " ";
      if (current === "\n") state = "code";
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
    if (state === "single" || state === "double") {
      result += current === "\n" ? "\n" : " ";
      if (current === "\\") {
        result += " ";
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"')
      ) {
        state = "code";
      }
      continue;
    }
    if (state === "template") {
      if (current === "\\") {
        result += "  ";
        index += 1;
      } else if (current === "`") {
        result += " ";
        state = "code";
      } else if (current === "$" && next === "{") {
        result += "  ";
        index += 1;
        templateDepths.push(1);
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
    } else if (current === "'") {
      result += " ";
      state = "single";
    } else if (current === '"') {
      result += " ";
      state = "double";
    } else if (current === "`") {
      result += " ";
      state = "template";
    } else {
      result += current;
      if (templateDepths.length > 0) {
        if (current === "{") {
          templateDepths[templateDepths.length - 1] += 1;
        } else if (current === "}") {
          templateDepths[templateDepths.length - 1] -= 1;
          if (templateDepths[templateDepths.length - 1] === 0) {
            templateDepths.pop();
            state = "template";
          }
        }
      }
    }
  }

  return result;
}

function matchingOpening(source, closingIndex, opening, closing) {
  let depth = 0;
  for (let index = closingIndex; index >= 0; index -= 1) {
    if (source[index] === closing) {
      depth += 1;
    } else if (source[index] === opening) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parameterListBefore(source, code, end) {
  let closingIndex = end - 1;
  while (closingIndex >= 0 && /\s/.test(code[closingIndex])) {
    closingIndex -= 1;
  }

  if (code[closingIndex] !== ")") {
    for (let index = closingIndex; index >= 0; index -= 1) {
      if (";={}".includes(code[index])) return null;
      if (code[index] === ")") {
        const annotation = code.slice(index + 1, end).trim();
        if (!annotation.startsWith(":")) return null;
        closingIndex = index;
        break;
      }
    }
  }
  if (code[closingIndex] !== ")") return null;

  const openingIndex = matchingOpening(code, closingIndex, "(", ")");
  if (openingIndex === -1) return null;
  return {
    openingIndex,
    parameters: source.slice(openingIndex + 1, closingIndex),
  };
}

function callableBodies(source) {
  const code = maskSource(source, true);
  const bodies = [];
  const controlFlowNames = new Set([
    "catch",
    "for",
    "if",
    "switch",
    "while",
    "with",
  ]);

  for (let openingBrace = 0; openingBrace < code.length; openingBrace += 1) {
    if (code[openingBrace] !== "{") continue;

    const prefix = code.slice(0, openingBrace);
    const arrow = /=>\s*$/.exec(prefix);
    if (arrow) {
      const parameterList = parameterListBefore(
        source,
        code,
        arrow.index,
      );
      if (parameterList) {
        bodies.push({
          openingBrace,
          parameters: parameterList.parameters,
        });
        continue;
      }

      const singleParameter = code
        .slice(0, arrow.index)
        .match(/([A-Za-z_$]\w*)\s*$/);
      if (singleParameter) {
        bodies.push({
          openingBrace,
          parameters: singleParameter[1],
        });
      }
      continue;
    }

    const parameterList = parameterListBefore(
      source,
      code,
      openingBrace,
    );
    if (!parameterList) continue;
    const callablePrefix = code.slice(0, parameterList.openingIndex);
    const callableName = callablePrefix
      .match(/([A-Za-z_$]\w*)\s*(?:<[^<>]*>)?\s*$/)?.[1];
    if (
      !callableName ||
      controlFlowNames.has(callableName) ||
      /\bfor\s+await\s*$/.test(callablePrefix)
    ) {
      continue;
    }

    bodies.push({
      openingBrace,
      parameters: parameterList.parameters,
    });
  }

  return bodies;
}

function sourceScopes(source) {
  const code = maskSource(source, true);
  const root = {
    bindings: new Map(),
    conditional: false,
    end: source.length,
    functionScope: null,
    parent: null,
    start: 0,
  };
  root.functionScope = root;
  const scopes = [root];
  const stack = [root];
  const callables = callableBodies(source);
  const functionOpenings = new Set(
    callables.map(({ openingBrace }) => openingBrace),
  );

  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === "{") {
      const parent = stack[stack.length - 1];
      let cursor = index - 1;
      while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1;
      let controlFlow = false;
      if (code[cursor] === ")") {
        const opening = matchingOpening(code, cursor, "(", ")");
        const keyword = code
          .slice(0, Math.max(0, opening))
          .match(/([A-Za-z_$]\w*)\s*$/)?.[1];
        controlFlow = [
          "catch",
          "for",
          "if",
          "switch",
          "while",
          "with",
        ].includes(keyword);
      } else {
        controlFlow = /\b(?:do|else|finally|try)\s*$/.test(
          code.slice(0, index),
        );
      }
      const scope = {
        bindings: new Map(),
        conditional: parent.conditional || controlFlow,
        end: source.length,
        functionScope: null,
        parent,
        start: index + 1,
      };
      scope.functionScope = functionOpenings.has(index)
        ? scope
        : parent.functionScope;
      scopes.push(scope);
      stack.push(scope);
    } else if (code[index] === "}" && stack.length > 1) {
      stack.pop().end = index;
    }
  }

  return {
    at(position) {
      let selected = root;
      for (const scope of scopes) {
        if (
          scope.start <= position &&
          position < scope.end &&
          scope.start >= selected.start
        ) {
          selected = scope;
        }
      }
      return selected;
    },
    callables,
    scopes,
  };
}

function expressionEnd(code, start) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    const current = code[index];
    if ("([{".includes(current)) depth += 1;
    if (")]}".includes(current)) depth -= 1;
    if (current === ";" && depth === 0) return index;
  }
  return code.length;
}

function simpleReference(expression) {
  const code = maskSource(expression, true).trim();
  const match = code.match(
    /^\(*\s*([A-Za-z_$]\w*)\s*!?\s*(?:as\s+[\w.<>]+\s*)?\)*$/,
  );
  return match?.[1] ?? null;
}

function memberReference(expression) {
  const code = maskSource(expression, true).trim();
  const match = code.match(
    /^\(*\s*((?:this|[A-Za-z_$]\w*)\s*\.\s*[A-Za-z_$]\w*)\s*!?\s*(?:as\s+[\w.<>]+\s*)?\)*$/,
  );
  return match?.[1].replace(/\s+/g, "") ?? null;
}

function bindingState(source, credentialTypes, clientTypeNames) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const scopeIndex = sourceScopes(source);
  const classScopes = new Set();
  const classes = new Map();
  const events = [];
  const declarationEquals = new Set();
  const createdCredentialTypes = new Set();
  let nextBindingId = 1;
  let nextVersion = 1;

  const classPattern = /\bclass\s+([A-Za-z_$]\w*)[^{]*\{/g;
  for (const match of code.matchAll(classPattern)) {
    const openingBrace = match.index + match[0].lastIndexOf("{");
    const classScope = scopeIndex.at(openingBrace + 1);
    classScopes.add(classScope);
    classes.set(match[1], classScope);
  }

  function classScopeAt(position) {
    for (
      let scope = scopeIndex.at(position);
      scope;
      scope = scope.parent
    ) {
      if (classScopes.has(scope)) return scope;
    }
    return null;
  }

  const environmentReaders = new Set();
  const credentialFactories = new Map();
  for (const definition of taintHelperDefinitions(source).values()) {
    const factoryCall = constructorCalls(
      definition.body,
      credentialTypes.clientSecret,
      "ClientSecretCredential",
      definition.bodyStart,
    ).find((call) =>
      /\breturn\s+(?:\(\s*)*$/.test(
        maskSource(
          definition.body.slice(0, call.index),
          true,
        ),
      )
    );
    if (!factoryCall) continue;
    const argumentsList = splitTopLevel(factoryCall.arguments);
    if (argumentsList.length < 3) continue;
    const expectedNames = [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
    ];
    const inputs = expectedNames.map((environmentName, index) => {
      const reference = simpleReference(argumentsList[index]);
      const parameter = definition.parameters.indexOf(reference);
      if (parameter !== -1) return { parameter };
      return directEnvironmentName(argumentsList[index]) === environmentName
        ? { direct: true }
        : null;
    });
    if (inputs.every(Boolean)) {
      credentialFactories.set(definition.name, {
        definition,
        inputs,
      });
    }
  }

  const functionPattern =
    /\bfunction\s+([A-Za-z_$]\w*)\s*\(\s*([A-Za-z_$]\w*)[^)]*\)\s*(?::[^{]+)?\{/g;
  for (const match of code.matchAll(functionPattern)) {
    const openingBrace = match.index + match[0].lastIndexOf("{");
    const body = balancedText(original, openingBrace, "{", "}");
    const bodyCode = maskSource(body, true);
    const parameter = escapeRegExp(match[2]);
    const environmentAccess = new RegExp(
      `process\\s*\\.\\s*env\\s*\\[\\s*${parameter}\\s*\\]`,
    );
    if (!environmentAccess.test(bodyCode)) continue;
    const valueAssignment = bodyCode.match(
      new RegExp(
        `\\b(?:const|let|var)\\s+([A-Za-z_$]\\w*)[^=;]*=\\s*` +
          `process\\s*\\.\\s*env\\s*\\[\\s*${parameter}\\s*\\]`,
      ),
    );
    const valueBinding = valueAssignment?.[1];
    if (valueAssignment) {
      const equals = bodyCode.indexOf("=", valueAssignment.index);
      const assignedExpression = bodyCode
        .slice(equals + 1, expressionEnd(bodyCode, equals + 1))
        .trim();
      const directAssignment = new RegExp(
        `^process\\s*\\.\\s*env\\s*\\[\\s*${parameter}\\s*\\]` +
          `\\s*!?\\s*(?:as\\s+[\\w.<>]+\\s*)?$`,
      );
      if (!directAssignment.test(assignedExpression)) continue;
    }
    const returnPattern = new RegExp(
      `\\breturn\\s+(?:${valueBinding
        ? escapeRegExp(valueBinding)
        : `process\\s*\\.\\s*env\\s*\\[\\s*${parameter}\\s*\\]`})\\s*!?\\s*;`,
    );
    const returned = returnPattern.exec(bodyCode);
    if (!returned) continue;
    if (valueBinding) {
      const between = bodyCode.slice(
        valueAssignment.index + valueAssignment[0].length,
        returned.index,
      );
      if (
        new RegExp(
          `(?<![\\w$.])${escapeRegExp(valueBinding)}\\s*=(?!=|>)`,
        ).test(between)
      ) {
        continue;
      }
    }
    environmentReaders.add(match[1]);
  }

  const declarations =
    /\b(const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:\s*[^=;\n]+)?\s*(=)?/g;
  for (const match of code.matchAll(declarations)) {
    const equals = match[3]
      ? match.index + match[0].lastIndexOf("=")
      : -1;
    if (equals !== -1) declarationEquals.add(equals);
    events.push({
      declarationKind: match[1],
      equals,
      index: match.index,
      kind: "declaration",
      name: match[2],
    });
  }

  const classFields =
    /(?:^|\n)\s*(?:(?:public|private|protected|readonly|static|declare|override|abstract)\s+)*([A-Za-z_$]\w*)(?:\s*[!?])?(?:\s*:[^=;\n]+)?\s*=(?!=|>)/g;
  for (const match of code.matchAll(classFields)) {
    const nameIndex = match.index + match[0].indexOf(match[1]);
    const classScope = classScopeAt(nameIndex);
    if (!classScope || scopeIndex.at(nameIndex) !== classScope) continue;
    const equals = match.index + match[0].lastIndexOf("=");
    declarationEquals.add(equals);
    events.push({
      declarationKind: "field",
      equals,
      index: nameIndex,
      kind: "declaration",
      name: `this.${match[1]}`,
      scopeOverride: classScope,
    });
  }

  function addParameters(parameters, openingBrace) {
    for (const parameter of splitTopLevel(parameters)) {
      const name = parameter
        .trim()
        .match(/^(?:\.\.\.)?([A-Za-z_$]\w*)\b/)?.[1];
      if (!name) continue;
      events.push({
        equals: -1,
        index: openingBrace + 1,
        kind: "declaration",
        name,
      });
    }
  }

  for (const callable of scopeIndex.callables) {
    addParameters(callable.parameters, callable.openingBrace);
  }
  const catchParameters = /\bcatch\s*\(([^)]*)\)\s*\{/g;
  for (const match of code.matchAll(catchParameters)) {
    addParameters(
      match[1],
      match.index + match[0].lastIndexOf("{"),
    );
  }

  const assignments = /(?<![\w$.])([A-Za-z_$]\w*)\s*=(?!=|>)/g;
  for (const match of code.matchAll(assignments)) {
    const equals = match.index + match[0].lastIndexOf("=");
    if (declarationEquals.has(equals)) continue;
    events.push({
      equals,
      index: match.index,
      kind: "assignment",
      name: match[1],
    });
  }

  const memberAssignments =
    /\b((?:this|[A-Za-z_$]\w*)(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*\.\s*([A-Za-z_$]\w*)\s*=(?!=|>)/g;
  for (const match of code.matchAll(memberAssignments)) {
    const equals = match.index + match[0].lastIndexOf("=");
    if (declarationEquals.has(equals)) continue;
    const receiver = match[1].replace(/\s+/g, "");
    events.push({
      equals,
      index: match.index,
      kind: "assignment",
      name: `${receiver}.${match[2]}`,
      property: match[2],
      receiver,
    });
  }

  const propertyAssignments =
    /(?<![\w$.])([A-Za-z_$]\w*)\s*\.\s*value\s*=(?!=|>)/g;
  for (const match of code.matchAll(propertyAssignments)) {
    events.push({
      index: match.index,
      kind: "property-assignment",
      name: match[1],
    });
  }

  const computedAssignments =
    /\b((?:this|[A-Za-z_$]\w*)(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*\[[^\]]*\]\s*=(?!=|>)/g;
  for (const match of code.matchAll(computedAssignments)) {
    events.push({
      index: match.index,
      kind: "computed-assignment",
      name: match[1].replace(/\s+/g, ""),
    });
  }

  const objectAssignCalls =
    /\bObject\s*\.\s*assign\s*\(\s*((?:this|[A-Za-z_$]\w*)(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*,/g;
  for (const match of code.matchAll(objectAssignCalls)) {
    events.push({
      index: match.index,
      kind: "spread-mutation",
      name: match[1].replace(/\s+/g, ""),
    });
  }

  events.sort((left, right) =>
    left.index - right.index ||
    (left.kind === "declaration" ? -1 : 1),
  );

  function resolve(name, position) {
    for (
      let scope = scopeIndex.at(position);
      scope;
      scope = scope.parent
    ) {
      const binding = scope.bindings.get(name);
      if (!binding || binding.index > position) continue;
      return binding;
    }
    return null;
  }

  function valueAt(binding, position) {
    if (!binding) return null;
    let selected = null;
    for (const entry of binding.history) {
      if (entry.index > position) break;
      selected = entry.value;
    }
    return selected;
  }

  function resolveMember(reference, position) {
    const [receiver, property] = reference.split(".");
    let targetClass;
    if (receiver === "this") {
      targetClass = classScopeAt(position);
    } else {
      const receiverValue = valueAt(resolve(receiver, position), position);
      targetClass = receiverValue?.kind === "instance"
        ? receiverValue.classScope
        : null;
    }
    return targetClass?.bindings.get(`this.${property}`) ?? null;
  }

  function resolveReference(expression, position) {
    const simple = simpleReference(expression);
    if (simple) return resolve(simple, position);
    const member = memberReference(expression);
    return member ? resolveMember(member, position) : null;
  }

  function typeConstructor(expression, names, exportedName, position) {
    const calls = constructorCalls(
      expression,
      names,
      exportedName,
      position,
    );
    return calls.find((call) =>
      maskSource(expression.slice(0, call.index), true).trim() === ""
    ) ?? null;
  }

  function referencedValue(expression, position) {
    return valueAt(resolveReference(expression, position), position);
  }

  function directEnvironmentName(expression) {
    const text = maskSource(expression, false).trim();
    const direct = text.match(
      /^\(*\s*process\s*\.\s*env\s*(?:\.\s*([A-Za-z_$]\w*)|\[\s*["']([^"']+)["']\s*\])\s*!?\s*(?:as\s+[\w.<>]+\s*)?\)*$/,
    );
    if (direct) return direct[1] ?? direct[2];
    const helper = text.match(
      /^\(*\s*([A-Za-z_$]\w*)\s*\(\s*["']([^"']+)["']\s*\)\s*!?\s*(?:as\s+[\w.<>]+\s*)?\)*$/,
    );
    if (helper && environmentReaders.has(helper[1])) return helper[2];
    return null;
  }

  function isEnvironmentValue(expression, name, position) {
    const parts = splitTopLevel(expression).filter((part) => part !== "");
    const value = parts.length === 1 ? parts[0] : expression;
    if (directEnvironmentName(value) === name) return true;
    return referencedValue(value, position)?.environmentName === name;
  }

  function containsEnvironmentValue(expression, name, position) {
    const codeExpression = expressionCode(expression);
    const direct = new RegExp(
      `\\bprocess\\s*\\.\\s*env\\s*(?:\\.\\s*${escapeRegExp(name)}\\b|` +
        `\\[\\s*["']${escapeRegExp(name)}["']\\s*\\])`,
    );
    if (direct.test(codeExpression)) return true;

    const references =
      /\b(?:this\s*\.\s*[A-Za-z_$]\w*|[A-Za-z_$]\w*\s*\.\s*[A-Za-z_$]\w*|[A-Za-z_$]\w*)\b/g;
    return [...codeExpression.matchAll(references)].some((match) =>
      isEnvironmentValue(match[0], name, position)
    );
  }

  function classifyCredential(expression, position) {
    const clientSecretCall = typeConstructor(
      expression,
      credentialTypes.clientSecret,
      "ClientSecretCredential",
      position,
    );
    if (clientSecretCall) {
      const args = splitTopLevel(clientSecretCall.arguments);
      if (
        args.length < 3 ||
        !isEnvironmentValue(args[0], "AZURE_TENANT_ID", position) ||
        !isEnvironmentValue(args[1], "AZURE_CLIENT_ID", position) ||
        !isEnvironmentValue(args[2], "AZURE_CLIENT_SECRET", position)
      ) {
        return null;
      }
      createdCredentialTypes.add("client-secret");
      return {
        credentialType: "client-secret",
        kind: "credential",
        version: nextVersion++,
      };
    }

    const factoryMatch =
      /^\s*([A-Za-z_$]\w*)\s*\(/.exec(
        maskSource(expression, true),
      );
    if (factoryMatch) {
      const opening = expression.indexOf("(", factoryMatch.index);
      const argumentsText = balancedText(expression, opening);
      const trailing =
        expression.slice(opening + argumentsText.length + 2).trim();
      const factory = credentialFactories.get(factoryMatch[1]);
      if (factory && trailing === "") {
        const args = splitTopLevel(argumentsText);
        const expectedNames = [
          "AZURE_TENANT_ID",
          "AZURE_CLIENT_ID",
          "AZURE_CLIENT_SECRET",
        ];
        if (factory.inputs.every((input, index) =>
          input.direct ||
          (
            input.parameter < args.length &&
            isEnvironmentValue(
              args[input.parameter],
              expectedNames[index],
              position + opening + 1,
            )
          )
        )) {
          createdCredentialTypes.add("client-secret");
          return {
            credentialType: "client-secret",
            kind: "credential",
            version: nextVersion++,
          };
        }
      }
    }

    const value = referencedValue(expression, position);
    return value?.kind === "credential" ? value : null;
  }

  function classifyObject(expression, position) {
    const text = maskSource(expression, false).trim();
    if (!text.startsWith("{") || !text.endsWith("}")) return null;
    const objectScope = {
      bindings: new Map(),
      end: scopeIndex.at(position).end,
      parent: scopeIndex.at(position),
      start: position,
    };

    for (const rawEntry of splitTopLevel(text.slice(1, -1))) {
      const entry = rawEntry.trim();
      if (
        !entry ||
        entry.startsWith("...") ||
        /^(?:async\s+)?[A-Za-z_$]\w*\s*\(/.test(entry)
      ) {
        continue;
      }
      const property = entry.match(
        /^(?:([A-Za-z_$]\w*)|["']([^"']+)["'])\s*:\s*([\s\S]+)$/,
      );
      const shorthand = property
        ? null
        : entry.match(/^([A-Za-z_$]\w*)$/);
      const name = property?.[1] ?? property?.[2] ?? shorthand?.[1];
      if (!name) continue;
      const valueExpression = property?.[3] ?? name;
      const value = classify(valueExpression, position);
      const binding = {
        history: [{ index: position, value }],
        id: nextBindingId++,
        index: position,
        name: `this.${name}`,
        scope: objectScope,
      };
      objectScope.bindings.set(binding.name, binding);
      bindings.push(binding);
    }
    return { classScope: objectScope, kind: "instance" };
  }

  function classify(expression, position) {
    const environmentName = directEnvironmentName(expression);
    if (environmentName) {
      return {
        environmentName,
        kind: environmentName === "AZURE_CLIENT_ID"
          ? "client-id"
          : "environment",
      };
    }
    const credential = classifyCredential(expression, position);
    if (credential) return credential;

    for (const [className, classScope] of classes) {
      if (
        typeConstructor(
          expression,
          new Set([className]),
          className,
          position,
        )
      ) {
        return { classScope, kind: "instance" };
      }
    }

    const clientCall = typeConstructor(
      expression,
      clientTypeNames,
      "SecretClient",
      position,
    );
    if (clientCall) {
      const clientArguments = splitTopLevel(clientCall.arguments);
      if (clientArguments.length < 2) return null;
      if (
        !isEnvironmentValue(
          clientArguments[0],
          "AZURE_KEY_VAULT_URL",
          position,
        )
      ) {
        return null;
      }
      const credentialArgument = clientArguments[1];
      const inlineCredential = classifyCredential(
        credentialArgument,
        position,
      );
      if (inlineCredential?.credentialType === "client-secret") {
        return {
          credentialBinding: null,
          credentialVersion: null,
          credentialType: inlineCredential.credentialType,
          kind: "client",
          version: nextVersion++,
        };
      }

      const credentialBinding = resolveReference(
        credentialArgument,
        position,
      );
      const credentialValue = valueAt(credentialBinding, position);
      if (
        credentialValue?.kind !== "credential" ||
        credentialValue.credentialType !== "client-secret"
      ) return null;
      return {
        credentialBinding,
        credentialType: credentialValue.credentialType,
        credentialVersion: credentialValue.version,
        kind: "client",
        version: nextVersion++,
      };
    }

    const object = classifyObject(expression, position);
    if (object) return object;

    return referencedValue(expression, position);
  }

  const clientCandidates = new Set();
  const credentialCandidates = new Set();
  const bindings = [];
  for (const event of events) {
    const lexicalScope = scopeIndex.at(event.index);
    const scope = event.scopeOverride ??
      (event.declarationKind === "var"
      ? lexicalScope.functionScope
      : lexicalScope);
    let binding;
    if (event.kind === "declaration") {
      binding = ["var", "field"].includes(event.declarationKind)
        ? scope.bindings.get(event.name)
        : null;
      if (!binding) {
        binding = {
          history: [],
          id: nextBindingId++,
          index: event.index,
          name: event.name,
          scope,
        };
        bindings.push(binding);
        scope.bindings.set(event.name, binding);
      }
    } else {
      binding = event.name.includes(".")
        ? resolveMember(event.name, event.index)
        : resolve(event.name, event.index);
      if (!binding && event.name.includes(".")) {
        const [receiver, property] = event.name.split(".");
        const targetClass = receiver === "this"
          ? classScopeAt(event.index)
          : valueAt(resolve(receiver, event.index), event.index)?.classScope;
        if (targetClass) {
          binding = {
            history: [],
            id: nextBindingId++,
            index: event.index,
            name: `this.${property}`,
            scope: targetClass,
          };
          bindings.push(binding);
          targetClass.bindings.set(binding.name, binding);
        }
      }
    }
    if (!binding) continue;

    let value = null;
    if (event.kind !== "property-assignment" && event.equals !== -1) {
      const start = event.equals + 1;
      value =
        event.kind !== "declaration" && lexicalScope.conditional
          ? null
          : classify(
            original.slice(start, expressionEnd(code, start)),
            start,
          );
    }
    binding.history.push({ index: event.index, value });
    if (value?.kind === "client") {
      clientCandidates.add(binding.name);
      if (event.name.includes(".")) clientCandidates.add(event.name);
    }
    if (value?.kind === "credential") {
      credentialCandidates.add(binding.name);
      if (event.name.includes(".")) credentialCandidates.add(event.name);
      createdCredentialTypes.add(value.credentialType);
    }
  }

  function validClientValue(value, position) {
    if (value?.kind !== "client") return false;
    if (!value.credentialBinding) return true;
    const credentialValue = valueAt(value.credentialBinding, position);
    return (
      credentialValue?.kind === "credential" &&
      credentialValue.version === value.credentialVersion
    );
  }

  function isValidClientAt(name, position) {
    const binding = resolveReference(name, position);
    return validClientValue(valueAt(binding, position), position);
  }

  function credentialTypeAt(name, position) {
    const binding = resolveReference(name, position);
    const value = valueAt(binding, position);
    return value?.kind === "credential" ? value.credentialType : null;
  }

  for (const binding of bindings) {
    const value = valueAt(binding, Math.max(binding.index, binding.scope.end - 1));
    if (value?.kind !== "instance") continue;
    for (const [name, memberBinding] of value.classScope.bindings) {
      const member = valueAt(
        memberBinding,
        Math.max(memberBinding.index, value.classScope.end - 1),
      );
      const instanceName = `${binding.name}.${name.slice("this.".length)}`;
      if (member?.kind === "client") clientCandidates.add(instanceName);
      if (member?.kind === "credential") {
        credentialCandidates.add(instanceName);
      }
    }
  }

  const associatedClients = [];
  const liveCredentialTypes = new Set();
  for (const binding of bindings) {
    const position = Math.max(binding.index, binding.scope.end - 1);
    const value = valueAt(binding, position);
    if (validClientValue(value, position)) {
      associatedClients.push({
        credentialType: value.credentialType,
        name: binding.name,
      });
    }
    if (value?.kind === "credential") {
      liveCredentialTypes.add(value.credentialType);
    }
  }

  return {
    associatedClients,
    clientCandidates,
    createdCredentialTypes,
    credentialCandidates,
    credentialTypeAt,
    containsEnvironmentValue,
    isEnvironmentValue,
    isValidClientAt,
    isSecretNameAt: (expression, position) =>
      isEnvironmentValue(
        expression,
        "AZURE_KEY_VAULT_SECRET_NAME",
        position,
      ),
    liveCredentialTypes,
  };
}

function packageDependencies(packageJson) {
  try {
    const manifest = JSON.parse(packageJson);
    return manifest.dependencies ?? {};
  } catch {
    return {};
  }
}

function validRuntimeDependencyDeclaration(value) {
  if (typeof value !== "string") return false;
  const declaration = value.trim();
  if (
    declaration === "" ||
    /^(?:#|\/\/|\/\*)/.test(declaration)
  ) {
    return false;
  }

  const version =
    String.raw`v?\d+(?:\.(?:\d+|[xX*])){0,2}` +
    String.raw`(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
  const comparator = new RegExp(
    `^(?:[~^]|[<>]=?|=)?(?:${version}|[xX*])$`,
  );
  const validRange = declaration.split(/\s*\|\|\s*/).every((range) => {
    const hyphen = new RegExp(`^${version}\\s+-\\s+${version}$`);
    return (
      hyphen.test(range) ||
      range.trim().split(/\s+/).every((part) => comparator.test(part))
    );
  });

  return (
    validRange ||
    /^[a-z][a-z0-9._-]*$/.test(declaration) ||
    /^(?:workspace|file|link|https?|git(?:\+https?|\+ssh)?):\S+$/.test(
      declaration,
    ) ||
    /^git@[\w.-]+:[^\s]+$/.test(declaration) ||
    /^github:\S+$/.test(declaration) ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[^\s]+)?$/.test(
      declaration,
    ) ||
    /^npm:(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+@(?:[~^]|[<>]=?|=)?(?:v?\d+|\*|[xX])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(
      declaration,
    )
  );
}

function hasSource(workspace) {
  return typeof workspace.source === "string" && workspace.source.trim() !== "";
}

function importBindings(source, moduleName) {
  const commentsMasked = maskSource(source, false);
  const codeMasked = maskSource(source, true);
  const modulePattern = escapeRegExp(moduleName);
  const named = new Map();
  const namespaces = new Set();

  const namedPattern = new RegExp(
    `\\bimport\\s*\\{([^}]+)\\}\\s*from\\s*["']${modulePattern}["']`,
    "g",
  );
  for (const match of commentsMasked.matchAll(namedPattern)) {
    if (codeMasked[match.index] !== "i") continue;
    for (const specifier of match[1].split(",")) {
      const parsed = specifier
        .trim()
        .match(/^(\w+)(?:\s+as\s+(\w+))?$/);
      if (parsed) named.set(parsed[1], parsed[2] ?? parsed[1]);
    }
  }

  const namespacePattern = new RegExp(
    `\\bimport\\s*\\*\\s*as\\s*(\\w+)\\s*from\\s*["']${modulePattern}["']`,
    "g",
  );
  for (const match of commentsMasked.matchAll(namespacePattern)) {
    if (codeMasked[match.index] === "i") namespaces.add(match[1]);
  }

  return { named, namespaces };
}

function typeNames(source, moduleName, exportedName) {
  const imports = importBindings(source, moduleName);
  const names = new Set();
  const local = imports.named.get(exportedName);
  if (local) names.add(local);
  for (const namespace of imports.namespaces) {
    names.add(`${namespace}.${exportedName}`);
  }
  Object.defineProperty(names, "provenance", {
    value: {
      exportedName,
      imports,
      moduleName,
      scopeIndex: sourceScopes(source),
      shadowing: new Map(),
      source,
    },
  });
  return names;
}

function typeShadowingScopes(provenance, name) {
  if (provenance.shadowing.has(name)) {
    return provenance.shadowing.get(name);
  }

  const scopes = declarationScopes(
    provenance.source,
    name,
    provenance.scopeIndex,
  );
  const code = maskSource(provenance.source, true);
  const escapedName = escapeRegExp(name);
  const declarations = [
    new RegExp(`\\bclass\\s+${escapedName}\\b`, "g"),
    new RegExp(`\\bfunction\\s+${escapedName}\\s*\\(`, "g"),
  ];
  for (const pattern of declarations) {
    for (const match of code.matchAll(pattern)) {
      scopes.add(provenance.scopeIndex.at(match.index));
    }
  }
  provenance.shadowing.set(name, scopes);
  return scopes;
}

function importedTypeResolvesAt(candidate, names, position) {
  const provenance = names.provenance;
  if (!provenance) return true;
  const normalized = candidate.replace(/\s+/g, "");
  const separator = normalized.indexOf(".");
  const bindingName = separator === -1
    ? normalized
    : normalized.slice(0, separator);
  const expectedNamed =
    provenance.imports.named.get(provenance.exportedName);
  const expectedNamespace =
    separator !== -1 &&
    normalized.slice(separator + 1) === provenance.exportedName &&
    provenance.imports.namespaces.has(bindingName);
  if (
    (separator === -1 && bindingName !== expectedNamed) ||
    (separator !== -1 && !expectedNamespace)
  ) {
    return false;
  }

  const shadowing = typeShadowingScopes(provenance, bindingName);
  for (
    let scope = provenance.scopeIndex.at(position);
    scope;
    scope = scope.parent
  ) {
    if (shadowing.has(scope)) return false;
  }
  return true;
}

function isKnownType(candidate, names, exportedName, position = 0) {
  const normalized = candidate.replace(/\s+/g, "");
  return (
    names.has(normalized) &&
    importedTypeResolvesAt(candidate, names, position)
  );
}

function constructorCalls(source, names, exportedName, sourceOffset = 0) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern =
    /\bnew\s+([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*(?:<[^;(){}]+>)?\s*\(/g;
  const calls = [];

  for (const match of code.matchAll(pattern)) {
    if (
      !isKnownType(
        match[1],
        names,
        exportedName,
        sourceOffset + match.index,
      )
    ) continue;
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(original, openingIndex);
    calls.push({
      arguments: argumentsText,
      argumentsStart: openingIndex + 1,
      end: openingIndex + argumentsText.length + 2,
      index: match.index,
    });
  }
  return calls;
}

function constructorBindings(source, names, exportedName) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern =
    /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;]+)?\s*=\s*new\s+([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*(?:<[^;(){}]+>)?\s*\(/g;
  const bindings = [];

  for (const match of code.matchAll(pattern)) {
    if (!isKnownType(match[2], names, exportedName)) continue;
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(original, openingIndex);
    bindings.push({
      arguments: argumentsText,
      end: openingIndex + argumentsText.length + 2,
      index: match.index,
      name: match[1],
    });
  }
  return bindings;
}

function methodCalls(source, receiver, method) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern = new RegExp(
    `\\b${escapeRegExp(receiver)}\\s*(?:\\?\\.|\\.)\\s*${method}\\s*\\(`,
    "g",
  );
  const calls = [];

  for (const match of code.matchAll(pattern)) {
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(original, openingIndex);
    calls.push({
      arguments: argumentsText,
      argumentsStart: openingIndex + 1,
      end: openingIndex + argumentsText.length + 2,
      index: match.index,
    });
  }
  return calls;
}

function consoleCalls(source) {
  return [
    ...methodCalls(source, "console", "log"),
    ...methodCalls(source, "console", "info"),
  ];
}

function declarationScopes(source, name, scopeIndex) {
  const code = maskSource(source, true);
  const escapedName = escapeRegExp(name);
  const declarations = new Set();
  const patterns = [
    new RegExp(`\\b(const|let|var)\\s+${escapedName}\\b`, "g"),
    new RegExp(
      `\\b(const|let|var)\\s*\\{[^{}]*` +
        `(?:\\bvalue\\s*:\\s*)?\\b${escapedName}\\b[^{}]*\\}`,
      "g",
    ),
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const lexicalScope = scopeIndex.at(match.index);
      declarations.add(
        match[1] === "var"
          ? lexicalScope.functionScope
          : lexicalScope,
      );
    }
  }

  const parameterLists = [
    ...scopeIndex.callables.map((callable) => ({
      openingBrace: callable.openingBrace,
      parameters: callable.parameters,
    })),
  ];
  const catchParameters = /\bcatch\s*\(([^)]*)\)\s*\{/g;
  for (const match of code.matchAll(catchParameters)) {
    parameterLists.push({
      openingBrace: match.index + match[0].lastIndexOf("{"),
      parameters: match[1],
    });
  }
  for (const { openingBrace, parameters } of parameterLists) {
    const declaresName = splitTopLevel(parameters).some((parameter) =>
      parameter
        .trim()
        .match(/^(?:\.\.\.)?([A-Za-z_$]\w*)\b/)?.[1] === name
    );
    if (declaresName) {
      declarations.add(scopeIndex.at(openingBrace + 1));
    }
  }
  return declarations;
}

function resolvesToScope(
  position,
  bindingScope,
  scopeIndex,
  shadowingScopes,
) {
  let scope = scopeIndex.at(position);
  while (scope && scope !== bindingScope) {
    if (shadowingScopes.has(scope)) return false;
    scope = scope.parent;
  }
  return scope === bindingScope;
}

function firstValueOverwrite(
  source,
  name,
  start,
  bindingScope,
  scopeIndex,
  shadowingScopes,
) {
  const code = maskSource(source, true);
  const escapedName = escapeRegExp(name);
  const patterns = [
    new RegExp(
      `\\b${escapedName}\\s*(?:\\.\\s*value\\s*)?=(?!=|>)`,
      "g",
    ),
    new RegExp(
      `\\{[^{}]*\\bvalue\\s*:\\s*${escapedName}\\b[^{}]*\\}\\s*=`,
      "g",
    ),
  ];
  let first = -1;

  for (const pattern of patterns) {
    pattern.lastIndex = start;
    for (const match of code.matchAll(pattern)) {
      if (
        resolvesToScope(
          match.index,
          bindingScope,
          scopeIndex,
          shadowingScopes,
        ) &&
        (first === -1 || match.index < first)
      ) {
        first = match.index;
      }
    }
  }
  return first;
}

function printsBoundValue(
  source,
  name,
  start,
  property = true,
  bindingScope = null,
  scopeIndex = null,
) {
  scopeIndex ??= sourceScopes(source);
  bindingScope ??= scopeIndex.at(Math.max(0, start - 1));
  const shadowingScopes = declarationScopes(source, name, scopeIndex);
  const overwrite = firstValueOverwrite(
    source,
    name,
    start,
    bindingScope,
    scopeIndex,
    shadowingScopes,
  );
  const valuePattern = property
    ? new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*value\\b`)
    : new RegExp(`\\b${escapeRegExp(name)}\\b`);

  if (consoleCalls(source).some((call) => {
    if (call.index < start || (overwrite !== -1 && call.index >= overwrite)) {
      return false;
    }
    if (!resolvesToScope(
      call.index,
      bindingScope,
      scopeIndex,
      shadowingScopes,
    )) return false;
    return valuePattern.test(expressionCode(call.arguments));
  })) {
    return true;
  }

  const code = maskSource(source, true);
  const sourceName = escapeRegExp(name);
  const sourceExpression = property
    ? `${sourceName}\\s*\\.\\s*value`
    : sourceName;
  const aliasPattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$]\\w*)` +
      `(?:\\s*:[^=;]+)?\\s*=\\s*${sourceExpression}\\b`,
    "g",
  );
  for (const match of code.matchAll(aliasPattern)) {
    if (
      match.index < start ||
      (overwrite !== -1 && match.index >= overwrite) ||
      !resolvesToScope(
        match.index,
        bindingScope,
        scopeIndex,
        shadowingScopes,
      )
    ) {
      continue;
    }
    const aliasStart = match.index + match[0].length;
    if (printsBoundValue(
      source,
      match[1],
      aliasStart,
      false,
      scopeIndex.at(match.index),
      scopeIndex,
    )) {
      return true;
    }
  }

  return false;
}

function servicePrincipalContext(workspace) {
  const source = workspace.source;
  const credentialTypes = {
    clientSecret: typeNames(
      source,
      "@azure/identity",
      "ClientSecretCredential",
    ),
  };
  const clientNames = typeNames(
    source,
    "@azure/keyvault-secrets",
    "SecretClient",
  );
  const state = bindingState(source, credentialTypes, clientNames);

  return {
    associatedClients: state.associatedClients,
    clientCandidates: state.clientCandidates,
    clientNames,
    credentialCandidates: state.credentialCandidates,
    credentialTypeAt: state.credentialTypeAt,
    createdCredentialTypes: state.createdCredentialTypes,
    credentialTypes,
    containsEnvironmentValue: state.containsEnvironmentValue,
    isEnvironmentValue: state.isEnvironmentValue,
    isValidClientAt: state.isValidClientAt,
    isSecretNameAt: state.isSecretNameAt,
    liveCredentialTypes: state.liveCredentialTypes,
    source,
  };
}

function isAwaitedCall(source, index) {
  const code = maskSource(source, true);
  const deadBlocks = [
    /\bif\s*\(\s*false\s*\)\s*\{/g,
    /\bwhile\s*\(\s*false\s*\)\s*\{/g,
    /\bfor\s*\([^;]*;\s*false\s*;[^)]*\)\s*\{/g,
  ];
  for (const pattern of deadBlocks) {
    for (const match of code.matchAll(pattern)) {
      const opening = match.index + match[0].lastIndexOf("{");
      const body = balancedText(code, opening, "{", "}");
      if (opening < index && index < opening + body.length + 1) {
        return false;
      }
    }
  }
  return /\bawait\s+(?:\(\s*)*$/.test(
    code.slice(0, index),
  );
}

function printsSecretResult(
  source,
  clientName,
  isValidClientAt = () => true,
  isSecretNameAt = () => true,
) {
  const code = maskSource(source, true);
  const escapedClient = escapeRegExp(clientName);

  const assignment = new RegExp(
    `(?:\\b(?:const|let|var)\\s+|(?<![\\w$.]))(\\w+)` +
      `(?:\\s*:[^=;]+)?\\s*=\\s*\\(*\\s*await\\s+` +
      `${escapedClient}\\s*\\.\\s*getSecret\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(assignment)) {
    const callIndex = match.index + match[0].lastIndexOf(clientName);
    if (!isValidClientAt(clientName, callIndex)) continue;
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(source, openingIndex);
    const operationEnd = openingIndex + argumentsText.length + 2;
    const extractsValue = /^\s*\)*\s*\.\s*value\b/.test(
      code.slice(operationEnd),
    );
    if (
      isSecretNameAt(argumentsText, callIndex) &&
      printsBoundValue(
        source,
        match[1],
        operationEnd,
        !extractsValue,
      )
    ) {
      return true;
    }
  }

  const destructuring = new RegExp(
    `(?:\\b(?:const|let|var)\\s+)?\\{\\s*value(?:\\s*:\\s*(\\w+))?\\s*\\}\\s*=\\s*await\\s+${escapedClient}\\s*\\.\\s*getSecret\\s*\\(`,
    "g",
  );
  for (const match of code.matchAll(destructuring)) {
    const callIndex = match.index + match[0].lastIndexOf(clientName);
    if (!isValidClientAt(clientName, callIndex)) continue;
    const openingIndex = match.index + match[0].lastIndexOf("(");
    const argumentsText = balancedText(source, openingIndex);
    const operationEnd = openingIndex + argumentsText.length + 2;
    const valueName = match[1] ?? "value";
    if (
      isSecretNameAt(argumentsText, callIndex) &&
      printsBoundValue(source, valueName, operationEnd, false)
    ) {
      return true;
    }
  }

  const secretCalls = methodCalls(source, clientName, "getSecret").filter(
    ({ arguments: args, index }) =>
      isSecretNameAt(args, index) &&
      isValidClientAt(clientName, index) &&
      isAwaitedCall(source, index),
  );
  for (const call of secretCalls) {
    if (
      consoleCalls(source).some((consoleCall) => {
        if (
          call.index < consoleCall.index ||
          call.end > consoleCall.end
        ) {
          return false;
        }
        return /^\s*\)*\s*\.\s*value\b/.test(
          code.slice(call.end, consoleCall.end),
        );
      })
    ) {
      return true;
    }

    for (const consoleCall of consoleCalls(source)) {
      const expression = expressionCode(consoleCall.arguments);
      const nestedCalls = methodCalls(
        expression,
        clientName,
        "getSecret",
      );
      if (nestedCalls.some((nestedCall) => {
        const globalIndex = consoleCall.argumentsStart + nestedCall.index;
        return (
          isSecretNameAt(nestedCall.arguments, globalIndex) &&
          isValidClientAt(clientName, globalIndex) &&
          isAwaitedCall(expression, nestedCall.index) &&
          /^\s*\)*\s*\.\s*value\b/.test(
            expression.slice(nestedCall.end),
          )
        );
      })) {
        return true;
      }
    }

  }

  return false;
}

function tryCatchBlocks(source) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern = /\btry\s*\{/g;
  const blocks = [];

  for (const match of code.matchAll(pattern)) {
    const tryOpeningIndex = match.index + match[0].lastIndexOf("{");
    const tryBody = balancedText(original, tryOpeningIndex, "{", "}");
    const tryClosingIndex = tryOpeningIndex + tryBody.length + 1;
    const catchMatch = code.slice(tryClosingIndex + 1).match(
      /^\s*catch(?:\s*\(\s*([A-Za-z_$]\w*)(?:\s*:\s*[^)]+)?\))?\s*\{/,
    );
    if (!catchMatch) continue;

    const catchOpeningIndex =
      tryClosingIndex +
      1 +
      catchMatch.index +
      catchMatch[0].lastIndexOf("{");
    blocks.push({
      body: balancedText(original, catchOpeningIndex, "{", "}"),
      bodyStart: catchOpeningIndex + 1,
      catchStart: tryClosingIndex + 1 + catchMatch.index,
      error: catchMatch[1] ?? null,
      tryBody,
      tryStart: tryOpeningIndex + 1,
    });
  }
  return blocks;
}

function ifBlocks(source) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern = /\bif\s*\(/g;
  const blocks = [];

  for (const match of code.matchAll(pattern)) {
    const conditionOpening = match.index + match[0].lastIndexOf("(");
    const condition = balancedText(original, conditionOpening);
    const conditionClosing = conditionOpening + condition.length + 1;
    const statementAt = (start) => {
      let opening = start;
      while (/\s/.test(code[opening] ?? "")) opening += 1;
      if (code[opening] === "{") {
        const body = balancedText(original, opening, "{", "}");
        return {
          body,
          end: opening + body.length + 2,
        };
      }
      const end = expressionEnd(code, opening);
      return {
        body: original.slice(opening, end + 1),
        end: Math.min(code.length, end + 1),
      };
    };
    const consequentStatement = statementAt(conditionClosing + 1);
    const consequent = consequentStatement.body;
    const consequentClosing = consequentStatement.end;
    const alternateMatch = code.slice(consequentClosing).match(
      /^\s*else\b/,
    );
    let alternate = null;
    let end = consequentClosing;
    if (alternateMatch) {
      const alternateStatement = statementAt(
        consequentClosing + alternateMatch[0].length,
      );
      alternate = alternateStatement.body;
      end = alternateStatement.end;
    }

    blocks.push({
      alternate,
      condition,
      consequent,
      end,
      index: match.index,
    });
  }
  return blocks;
}

function stripExpressionParentheses(expression) {
  let value = expression.trim();
  while (value.startsWith("(")) {
    const inner = balancedText(value, 0);
    if (inner.length + 2 !== value.length) break;
    value = inner.trim();
  }
  return value;
}

function credentialCondition(
  condition,
  error,
  errorNames,
  position = 0,
) {
  if (!error) return null;
  let value = stripExpressionParentheses(maskSource(condition, true));
  let negated = false;
  if (value.startsWith("!")) {
    negated = true;
    value = stripExpressionParentheses(value.slice(1));
  }
  const match = new RegExp(
    `^${escapeRegExp(error)}\\s+instanceof\\s+([A-Za-z_$]\\w*(?:\\s*\\.\\s*[A-Za-z_$]\\w*)?)$`,
  ).exec(value);
  if (!match) return null;
  const type = match[1].replace(/\s+/g, "");
  return isKnownType(
    type,
    errorNames,
    "AuthenticationError",
    position,
  )
    ? !negated
    : null;
}

function typeScriptThrowIsCausal(statement, error) {
  if (!error) return false;
  const rawExpression =
    /^\s*throw\s+([\s\S]+);\s*$/.exec(statement)?.[1];
  const expression = rawExpression
    ? stripExpressionParentheses(rawExpression)
    : null;
  if (!expression) return false;
  const escaped = escapeRegExp(error);
  if (new RegExp(`^\\s*${escaped}\\s*$`).test(expression)) return true;
  return new RegExp(
    String.raw`\{[\s\S]*\bcause\s*:\s*\(?\s*${escaped}\s*\)?\s*(?=,|\})[\s\S]*\}`,
  ).test(expression);
}

function typeScriptHandlerAlwaysCausal(
  body,
  error,
  errorNames,
  credentialMatches = null,
  bodyOffset = 0,
) {
  const code = maskSource(body, true);
  let nextTargetId = 0;
  const outcomes = (start, end, frames = []) => {
    let result = new Set(["fall"]);
    let index = start;
    const sequence = (next) => {
      const combined = new Set(
        [...result].filter((value) => value !== "fall"),
      );
      if (result.has("fall")) {
        for (const value of next) combined.add(value);
      }
      result = combined;
    };
    const skipWhitespace = () => {
      while (index < end && /\s/.test(code[index])) index += 1;
    };
    const closingIndex = (open, opening = "(", closing = ")") => {
      const nested = balancedText(code, open, opening, closing);
      const close = open + nested.length + 1;
      return close < code.length && code[close] === closing ? close : -1;
    };
    const conditionKind = (condition) => {
      const value = stripExpressionParentheses(condition)
        .replace(/\s+/g, "")
        .toLowerCase();
      if (value === "true") return true;
      if (value === "false") return false;
      return null;
    };
    const loopOutcomes = (
      bodyOutcomes,
      condition,
      canSkip,
      executesOnce = false,
      consumedTargets = [],
    ) => {
      const consumed = new Set(consumedTargets);
      const invalid = [...bodyOutcomes].filter(
        (value) => value === "invalid",
      );
      if (condition === false && !executesOnce) {
        return new Set(["fall", ...invalid]);
      }
      const loopResult = new Set(
        [...bodyOutcomes].filter(
          (value) =>
            value === "safe" ||
            value === "unsafe" ||
            value === "invalid" ||
            (/^(?:break|continue):/.test(value) &&
              !consumed.has(value.slice(value.indexOf(":") + 1))),
        ),
      );
      const consumedBreak = [...bodyOutcomes].some(
        (value) =>
          value.startsWith("break:") &&
          consumed.has(value.slice("break:".length)),
      );
      const consumedContinue = [...bodyOutcomes].some(
        (value) =>
          value.startsWith("continue:") &&
          consumed.has(value.slice("continue:".length)),
      );
      if (consumedBreak) loopResult.add("fall");
      if (
        condition !== true &&
        (canSkip ||
          bodyOutcomes.has("fall") ||
          consumedContinue)
      ) {
        loopResult.add("fall");
      }
      return loopResult;
    };
    const parenthesized = () => {
      skipWhitespace();
      if (code[index] !== "(") return null;
      const close = closingIndex(index);
      if (close < 0 || close >= end) return null;
      const value = code.slice(index + 1, close);
      index = close + 1;
      return value;
    };
    const forCondition = (header) => {
      const parts = [];
      let partStart = 0;
      let depth = 0;
      for (let cursor = 0; cursor < header.length; cursor += 1) {
        const character = header[cursor];
        if ("([{".includes(character)) depth += 1;
        else if (")]}".includes(character)) depth -= 1;
        else if (character === ";" && depth === 0) {
          parts.push(header.slice(partStart, cursor));
          partStart = cursor + 1;
        }
      }
      parts.push(header.slice(partStart));
      if (
        parts.length === 1 &&
        /\s(?:of|in)\s/.test(` ${header.trim()} `)
      ) {
        return null;
      }
      if (parts.length !== 3) return "ambiguous";
      return parts[1].trim() === ""
        ? true
        : conditionKind(parts[1]);
    };
    const statement = (activeFrames = frames, loopLabelIds = []) => {
      skipWhitespace();
      if (index >= end) return new Set(["invalid"]);
      if (code[index] === ";") {
        index += 1;
        return new Set(["fall"]);
      }
      const labelNames = [];
      while (true) {
        const label = /^([A-Za-z_$][\w$]*)\s*:/.exec(
          code.slice(index),
        );
        if (!label) break;
        labelNames.push(label[1]);
        index += label[0].length;
        skipWhitespace();
      }
      if (labelNames.length > 0) {
        const seen = new Set(
          activeFrames
            .map((frame) => frame.name)
            .filter((name) => name !== undefined),
        );
        let duplicate = false;
        for (const name of labelNames) {
          if (seen.has(name)) duplicate = true;
          seen.add(name);
        }
        const labelsLoop = /^(?:while|for|do)\b/.test(
          code.slice(index),
        );
        const labelFrames = labelNames.map((name) => ({
          id: String(nextTargetId++),
          kind: labelsLoop ? "loop-label" : "label",
          name,
        }));
        const nested = statement(
          [...activeFrames, ...labelFrames],
          labelsLoop ? labelFrames.map(({ id }) => id) : [],
        );
        const labelIds = new Set(labelFrames.map(({ id }) => id));
        const resolved = new Set(
          [...nested].map((value) =>
            value.startsWith("break:") &&
            labelIds.has(value.slice("break:".length))
              ? "fall"
              : value,
          ),
        );
        if (duplicate) resolved.add("invalid");
        return resolved;
      }
      if (code[index] === "{") {
        const close = closingIndex(index, "{", "}");
        if (close < 0 || close >= end) {
          index = end;
          return new Set(["invalid"]);
        }
        const nested = outcomes(index + 1, close, activeFrames);
        index = close + 1;
        return nested;
      }
      if (/^while\b/.test(code.slice(index))) {
        index += code.slice(index).match(/^while\b/)[0].length;
        const condition = parenthesized();
        if (condition === null) return new Set(["invalid"]);
        const kind = conditionKind(condition);
        const loopId = String(nextTargetId++);
        return loopOutcomes(
          statement([
            ...activeFrames,
            { id: loopId, kind: "loop" },
          ]),
          kind,
          kind === null,
          false,
          [loopId, ...loopLabelIds],
        );
      }
      if (/^for\b/.test(code.slice(index))) {
        index += code.slice(index).match(/^for\b/)[0].length;
        const header = parenthesized();
        if (header === null) return new Set(["invalid"]);
        const kind = forCondition(header);
        const loopId = String(nextTargetId++);
        const nested = statement([
          ...activeFrames,
          { id: loopId, kind: "loop" },
        ]);
        if (kind === "ambiguous") return new Set(["invalid"]);
        return loopOutcomes(
          nested,
          kind,
          kind === null,
          false,
          [loopId, ...loopLabelIds],
        );
      }
      if (/^do\b/.test(code.slice(index))) {
        index += code.slice(index).match(/^do\b/)[0].length;
        const loopId = String(nextTargetId++);
        const nested = statement([
          ...activeFrames,
          { id: loopId, kind: "loop" },
        ]);
        skipWhitespace();
        if (!/^while\b/.test(code.slice(index))) {
          return new Set(["invalid"]);
        }
        index += code.slice(index).match(/^while\b/)[0].length;
        const condition = parenthesized();
        if (condition === null) return new Set(["invalid"]);
        skipWhitespace();
        if (code[index] === ";") index += 1;
        return loopOutcomes(
          nested,
          conditionKind(condition),
          false,
          true,
          [loopId, ...loopLabelIds],
        );
      }
      if (/^if\b/.test(code.slice(index))) {
        index += code.slice(index).match(/^if\b/)[0].length;
        const condition = parenthesized();
        if (condition === null) return new Set(["invalid"]);
        const consequent = statement(activeFrames);
        skipWhitespace();
        let alternate = new Set(["fall"]);
        if (/^else\b/.test(code.slice(index))) {
          index += code.slice(index).match(/^else\b/)[0].length;
          alternate = statement(activeFrames);
        }
        const kind = conditionKind(condition);
        const invalid = new Set(
          [...consequent, ...alternate].filter(
            (value) => value === "invalid",
          ),
        );
        if (kind === true) return new Set([...consequent, ...invalid]);
        if (kind === false) return new Set([...alternate, ...invalid]);
        const exact = credentialCondition(
          condition,
          error,
          errorNames,
          bodyOffset + index,
        );
        if (credentialMatches !== null && exact !== null) {
          return new Set([
            ...(exact === credentialMatches ? consequent : alternate),
            ...invalid,
          ]);
        }
        return new Set([...consequent, ...alternate]);
      }

      const statementStart = index;
      let parentheses = 0;
      let brackets = 0;
      for (; index < end; index += 1) {
        const character = code[index];
        if (character === "(") parentheses += 1;
        else if (character === ")") parentheses -= 1;
        else if (character === "[") brackets += 1;
        else if (character === "]") brackets -= 1;
        else if (
          character === "{" &&
          parentheses === 0 &&
          brackets === 0
        ) {
          const close = closingIndex(index, "{", "}");
          if (close < 0 || close >= end) {
            index = end;
            return new Set(["unsafe"]);
          }
          const nested = outcomes(index + 1, close, activeFrames);
          const prefix = code.slice(statementStart, index).trim();
          index = close + 1;
          if (/^[A-Za-z_$][\w$]*\s*:/.test(prefix)) {
            return new Set(["unsafe"]);
          }
          return new Set(["fall", ...nested]);
        } else if (
          character === ";" &&
          parentheses === 0 &&
          brackets === 0
        ) {
          index += 1;
          break;
        }
      }
      const text = code.slice(statementStart, index).trim();
      if (/^throw\b/.test(text)) {
        return new Set([
          typeScriptThrowIsCausal(text, error) ? "safe" : "unsafe",
        ]);
      }
      if (/^return\b/.test(text)) {
        return new Set(["unsafe"]);
      }
      if (/^(?:break|continue)\b/.test(text)) {
        const control =
          /^(break|continue)(?:\s+([A-Za-z_$][\w$]*))?\s*;\s*$/.exec(
            text,
          );
        if (!control) return new Set(["invalid"]);
        const [, kind, labelName] = control;
        let target;
        if (labelName) {
          target = [...activeFrames]
            .reverse()
            .find((frame) => frame.name === labelName);
          if (
            !target ||
            (kind === "continue" && target.kind !== "loop-label")
          ) {
            return new Set(["invalid"]);
          }
        } else {
          target = [...activeFrames]
            .reverse()
            .find((frame) => frame.kind === "loop");
          if (!target) return new Set(["invalid"]);
        }
        return new Set([`${kind}:${target.id}`]);
      }
      if (/^[A-Za-z_$][\w$]*\s*:/.test(text)) {
        return new Set(["unsafe"]);
      }
      return new Set(["fall"]);
    };

    while (index < end) {
      skipWhitespace();
      while (code[index] === ";") {
        index += 1;
        skipWhitespace();
      }
      if (index >= end) break;
      sequence(statement());
    }
    return result;
  };
  const result = outcomes(0, code.length);
  return result.size === 1 && result.has("safe");
}

function hasCredentialDiscrimination(
  body,
  error,
  errorNames,
  bodyOffset,
) {
  if (!error) return false;
  return ifBlocks(body).some(
    ({ condition, index }) =>
      credentialCondition(
        condition,
        error,
        errorNames,
        bodyOffset + index,
      ) !== null,
  );
}

function usefulCredentialBranch(
  body,
  error,
  errorNames,
  bodyOffset,
) {
  if (!error) return false;
  const escaped = escapeRegExp(error);
  const useful = (branch) =>
    ["error", "warn", "log", "info"]
      .flatMap((method) => methodCalls(branch, "console", method))
      .some((call) => {
      const expression = expressionCode(call.arguments);
      if (
        new RegExp(
          `\\b${escaped}(?:\\s*\\.\\s*(?:message|name|stack))?\\b`,
        ).test(expression)
      ) {
        return true;
      }
      const diagnostic = call.arguments
        .match(/(["'`])([\s\S]*?)\1/g)
        ?.map((literal) => literal.slice(1, -1))
        .join(" ") ?? "";
      return (
        /\b(?:auth(?:entication)?|credential)\w*\b/i.test(diagnostic) &&
        /\b(?:check|configure|ensure|provide|set|update|verify)\w*\b/i.test(
          diagnostic,
        )
      );
      });

  return ifBlocks(body).some((block) => {
    const positive = credentialCondition(
      block.condition,
      error,
      errorNames,
      bodyOffset + block.index,
    );
    if (positive === null) return false;
    const matchingBranch = positive
      ? block.consequent
      : block.alternate ?? body.slice(block.end);
    return useful(matchingBranch);
  });
}

function handlesAuthenticationError(
  source,
  clientCandidates,
  isValidClientAt,
  isSecretNameAt,
) {
  const errorNames = typeNames(
    source,
    "@azure/identity",
    "AuthenticationError",
  );
  if (errorNames.size === 0) return false;

  const catches = tryCatchBlocks(source);
  if (
    catches.some(({ body, bodyStart, error }) => {
      const discriminates = hasCredentialDiscrimination(
        body,
        error,
        errorNames,
        bodyStart,
      );
      return !typeScriptHandlerAlwaysCausal(
        body,
        error,
        errorNames,
        discriminates ? false : null,
        bodyStart,
      );
    })
  ) {
    return false;
  }

  return catches.some(({
    body,
    bodyStart,
    error,
    tryBody,
    tryStart,
  }) => {
    const tryCode = maskSource(tryBody, true);
    const handlesClientOperation = [...clientCandidates].some((name) =>
      methodCalls(tryBody, name, "getSecret").some(
        ({ arguments: args, index }) =>
          isSecretNameAt(args, tryStart + index) &&
          isValidClientAt(name, tryStart + index) &&
          /\bawait\s+(?:\(\s*)*$/.test(tryCode.slice(0, index)),
      ),
    );
    if (!handlesClientOperation) return false;
    return (
      hasCredentialDiscrimination(
        body,
        error,
        errorNames,
        bodyStart,
      ) &&
      usefulCredentialBranch(
        body,
        error,
        errorNames,
        bodyStart,
      )
    );
  });
}

function dotenvState(source) {
  const commentsMasked = maskSource(source, false);
  const code = maskSource(source, true);
  const sideEffectPattern = /\bimport\s*["']dotenv\/config["']\s*;?/g;
  for (const match of commentsMasked.matchAll(sideEffectPattern)) {
    if (code[match.index] === "i") {
      return { imported: true, initializedAt: -1 };
    }
  }

  const bindings = importBindings(source, "dotenv");
  const callNames = new Set();
  const named = bindings.named.get("config");
  if (named) callNames.add(named);
  for (const namespace of bindings.namespaces) {
    callNames.add(`${namespace}.config`);
  }

  const defaultPattern =
    /\bimport\s+([A-Za-z_$]\w*)\s+from\s+["']dotenv["']/g;
  for (const match of commentsMasked.matchAll(defaultPattern)) {
    if (code[match.index] === "i") {
      callNames.add(`${match[1]}.config`);
    }
  }

  let initializedAt = -1;
  for (const callName of callNames) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(callName)}\\s*\\(`,
      "g",
    );
    for (const match of code.matchAll(pattern)) {
      if (initializedAt === -1 || match.index < initializedAt) {
        initializedAt = match.index;
      }
    }
  }
  return {
    imported: callNames.size > 0,
    initializedAt,
  };
}

function dotenvInitializedBeforeEnvironment(source) {
  const state = dotenvState(source);
  if (!state.imported || state.initializedAt === -1) {
    return state.imported && state.initializedAt === -1 &&
      /\bimport\s*["']dotenv\/config["']/.test(maskSource(source, false));
  }

  const commentsMasked = maskSource(source, false);
  const codeMasked = maskSource(source, true);
  const environmentRead =
    /\bprocess\s*\.\s*env\s*(?:\.\s*[A-Za-z_$]\w*|\[\s*["'][^"']+["']\s*\])/g;
  const firstRead = [...commentsMasked.matchAll(environmentRead)]
    .map((match) => match.index)
    .filter((index) => codeMasked[index] === "p")
    .sort((left, right) => left - right)[0];
  return firstRead === undefined || state.initializedAt < firstRead;
}

function constructorSecretInputsAreSafe(context) {
  const calls = constructorCalls(
    context.source,
    context.credentialTypes.clientSecret,
    "ClientSecretCredential",
  );
  return calls.length > 0 && calls.every((call) => {
    const args = splitTopLevel(call.arguments);
    if (args.length < 3) return false;
    if (
      context.isEnvironmentValue(
        args[2],
        "AZURE_CLIENT_SECRET",
        call.argumentsStart,
      )
    ) {
      return true;
    }

    const definitions = [
      ...taintHelperDefinitions(context.source).values(),
    ].filter((candidate) =>
      candidate.bodyStart <= call.index &&
      call.index < candidate.bodyEnd
    );
    const definition = definitions[0];
    const secretParameter = definition?.parameters.indexOf(
      simpleReference(args[2]),
    );
    if (!definition || secretParameter === -1) return false;

    const sourceCode = maskSource(context.source, true);
    const factoryNames = [
      ...new Set(definitions.map(({ name }) => name)),
    ].map(escapeRegExp).join("|");
    const pattern = new RegExp(
      `\\b(?:${factoryNames})\\s*\\(`,
      "g",
    );
    let invocationCount = 0;
    for (const invocation of sourceCode.matchAll(pattern)) {
      if (
        /\bfunction\s*$/.test(
          sourceCode.slice(
            Math.max(0, invocation.index - 20),
            invocation.index,
          ),
        )
      ) {
        continue;
      }
      const opening =
        invocation.index + invocation[0].lastIndexOf("(");
      const invocationArgs = splitTopLevel(
        balancedText(context.source, opening),
      );
      invocationCount += 1;
      if (
        secretParameter >= invocationArgs.length ||
        !context.isEnvironmentValue(
          invocationArgs[secretParameter],
          "AZURE_CLIENT_SECRET",
          opening + 1,
        )
      ) {
        return false;
      }
    }
    return invocationCount > 0;
  });
}

function taintHelperDefinitions(source) {
  const code = maskSource(source, true);
  const definitions = new Map();
  const parameterNames = (parameters) => {
    let simplified = parameters;
    let previous;
    do {
      previous = simplified;
      simplified = simplified.replace(/<[^<>]*>/g, "");
    } while (simplified !== previous);
    return splitTopLevel(simplified).map((parameter) =>
      parameter
        .trim()
        .match(/^(?:\.\.\.)?([A-Za-z_$]\w*)/)?.[1] ?? ""
    ).filter(Boolean);
  };
  const functions =
    /\b(?:async\s+)?function\s+([A-Za-z_$]\w*)\s*\(([^)]*)\)\s*(?::[^{]+)?\s*\{/g;
  for (const match of code.matchAll(functions)) {
    const opening = match.index + match[0].lastIndexOf("{");
    definitions.set(match[1], {
      body: source.slice(
        opening + 1,
        opening + balancedText(source, opening, "{", "}").length + 1,
      ),
      bodyEnd:
        opening + balancedText(source, opening, "{", "}").length + 1,
      bodyStart: opening + 1,
      name: match[1],
      parameters: parameterNames(match[2]),
      start: match.index,
    });
  }

  const arrows =
    /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$]\w*))\s*(?::[^=;\n]+)?=>\s*/g;
  for (const match of code.matchAll(arrows)) {
    let bodyStart = match.index + match[0].length;
    let body;
    let offset = bodyStart;
    if (code[bodyStart] === "{") {
      const bodyLength = balancedText(
        source,
        bodyStart,
        "{",
        "}",
      ).length;
      body = source.slice(
        bodyStart + 1,
        bodyStart + bodyLength + 1,
      );
      offset += 1;
      bodyStart += bodyLength + 1;
    } else {
      const end = expressionEnd(code, bodyStart);
      body = `return ${source.slice(bodyStart, end)};`;
      offset -= "return ".length;
      bodyStart = end;
    }
    definitions.set(match[1], {
      body,
      bodyEnd: bodyStart,
      bodyStart: offset,
      name: match[1],
      parameters: parameterNames(match[2] ?? match[3]),
      start: match.index,
    });
  }

  const aliases =
    /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*([A-Za-z_$]\w*)\s*;/g;
  while (true) {
    let changed = false;
    for (const match of code.matchAll(aliases)) {
      if (definitions.has(match[1])) continue;
      const target = definitions.get(match[2]);
      if (!target) continue;
      definitions.set(match[1], {
        ...target,
        name: match[1],
      });
      changed = true;
    }
    if (!changed) break;
  }
  return definitions;
}

function allocationIdentityTaint(source, helpers) {
  const objects = new Map();
  const cleanSinks = new Set();
  const methodsByName = new Map();
  const definitions = [];
  let nextObjectId = 1;
  let exposed = false;

  const scopeIndex = sourceScopes(source);
  const objectShadowScopes = new Set();
  const objectShadowRanges = [];
  const addObjectShadow = (position, functionScoped = false) => {
    const scope = scopeIndex.at(position);
    objectShadowScopes.add(functionScoped ? scope.functionScope : scope);
  };
  for (const callable of scopeIndex.callables) {
    const scope = scopeIndex.at(callable.openingBrace + 1);
    if (
      splitTopLevel(callable.parameters).some((parameter) =>
        parameter.trim().match(/^(?:\.\.\.)?([A-Za-z_$]\w*)/)?.[1] ===
          "Object"
      )
    ) {
      objectShadowScopes.add(scope);
    }
  }
  for (const match of maskSource(source, true).matchAll(
    /\bcatch\s*\(([^)]*)\)\s*\{/g,
  )) {
    if (
      splitTopLevel(match[1]).some((parameter) =>
        parameter.trim().match(/^([A-Za-z_$]\w*)/)?.[1] === "Object"
      )
    ) {
      addObjectShadow(match.index + match[0].lastIndexOf("{") + 1);
    }
  }
  const scopeCode = maskSource(source, true);
  for (const match of scopeCode.matchAll(
    /\b(const|let|var)\s+Object\b/g,
  )) {
    addObjectShadow(match.index, match[1] === "var");
  }
  for (const match of scopeCode.matchAll(/\bfunction\s+Object\b/g)) {
    addObjectShadow(match.index, true);
  }
  for (const match of scopeCode.matchAll(/\bclass\s+Object\b/g)) {
    addObjectShadow(match.index);
  }
  for (const match of scopeCode.matchAll(
    /\bimport\s+(?!["'])([\s\S]*?)\s+from\s+["'][^"']+["']/g,
  )) {
    const clause = match[1].trim();
    const shadows =
      /^Object\b/.test(clause) ||
      /^\*\s+as\s+Object\b/.test(clause) ||
      (
        clause.startsWith("{") &&
        splitTopLevel(clause.slice(1, clause.lastIndexOf("}"))).some(
          (entry) => {
            const binding = entry.trim().match(
              /^(?:type\s+)?[A-Za-z_$]\w*(?:\s+as\s+([A-Za-z_$]\w*))?$/,
            );
            return (binding?.[1] ?? entry.trim().replace(/^type\s+/, "")) ===
              "Object";
          },
        )
      );
    if (shadows) objectShadowScopes.add(scopeIndex.scopes[0]);
  }
  if (/\bimport\s+Object\s*=\s*/.test(scopeCode)) {
    objectShadowScopes.add(scopeIndex.scopes[0]);
  }
  for (const match of scopeCode.matchAll(
    /(?:\(([^)]*)\)|\b(Object)\b)\s*(?::[^=;\n]+)?=>\s*(?!\{)/g,
  )) {
    const parameters = match[1] ?? match[2];
    if (
      !splitTopLevel(parameters).some((parameter) =>
        parameter.trim().match(/^(?:\.\.\.)?([A-Za-z_$]\w*)/)?.[1] ===
          "Object"
      )
    ) {
      continue;
    }
    const start = match.index + match[0].length;
    objectShadowRanges.push({
      end: expressionEnd(scopeCode, start),
      start,
    });
  }
  const hasGlobalObject = (position) => {
    if (
      objectShadowRanges.some(
        (range) => range.start <= position && position < range.end,
      )
    ) {
      return false;
    }
    for (
      let scope = scopeIndex.at(position);
      scope;
      scope = scope.parent
    ) {
      if (objectShadowScopes.has(scope)) return false;
    }
    return true;
  };

  const addDefinition = (definition) => {
    const overloads = methodsByName.get(definition.name) ?? [];
    if (
      !overloads.some(
        (candidate) =>
          candidate.bodyStart === definition.bodyStart &&
          candidate.bodyEnd === definition.bodyEnd,
      )
    ) {
      overloads.push(definition);
      definitions.push(definition);
      methodsByName.set(definition.name, overloads);
    }
  };
  for (const definition of helpers.values()) addDefinition(definition);

  const masked = maskSource(source, true);
  const classes = /\bclass\s+[A-Za-z_$]\w*[^{]*\{/g;
  for (const classMatch of masked.matchAll(classes)) {
    const classOpen = classMatch.index + classMatch[0].lastIndexOf("{");
    const classBody = balancedText(source, classOpen, "{", "}");
    const bodyStart = classOpen + 1;
    const methodPattern =
      /(?:^|[;}])\s*(?:(?:public|private|protected|static|readonly|async|override|abstract)\s+)*([A-Za-z_$]\w*)\s*\(([^()]*)\)\s*(?::[^{]+)?\s*\{/g;
    for (const match of maskSource(classBody, true).matchAll(methodPattern)) {
      if (new Set(["if", "for", "while", "switch", "catch"]).has(match[1])) {
        continue;
      }
      const open =
        bodyStart + match.index + match[0].lastIndexOf("{");
      const body = balancedText(source, open, "{", "}");
      const parameters = splitTopLevel(match[2]).map((parameter) =>
        parameter
          .trim()
          .match(/^(?:\.\.\.)?([A-Za-z_$]\w*)/)?.[1] ?? ""
      ).filter(Boolean);
      addDefinition({
        body,
        bodyEnd: open + body.length + 1,
        bodyStart: open + 1,
        name: match[1],
        parameters,
        start:
          bodyStart + match.index +
          (/^[;}]/.test(match[0]) ? 1 : 0),
      });
    }
  }

  const value = (
    tainted = false,
    ids = [],
    derived = false,
    uncertain = false,
    objectAssign = false,
  ) => ({
    derived,
    ids: new Set(ids),
    objectAssign,
    tainted,
    uncertain,
  });
  const merge = (...values) => {
    const merged = value();
    let sawValue = false;
    let allObjectAssign = true;
    for (const item of values) {
      if (!item) continue;
      sawValue = true;
      allObjectAssign &&= item.objectAssign;
      merged.tainted ||= item.tainted;
      merged.derived ||= item.derived;
      merged.uncertain ||= item.uncertain;
      for (const id of item.ids) merged.ids.add(id);
    }
    merged.objectAssign = sawValue && allObjectAssign;
    return merged;
  };
  const allocate = () => {
    const id = nextObjectId;
    nextObjectId += 1;
    objects.set(id, new Map());
    return value(false, [id]);
  };
  const descendantTainted = (item, seen = new Set()) => {
    if (item?.tainted) return true;
    for (const id of item?.ids ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      for (const child of objects.get(id)?.values() ?? []) {
        if (descendantTainted(child, seen)) return true;
      }
    }
    return false;
  };
  const normalize = (path) => {
    const normalized = path
      .trim()
      .replace(/^await\s+/, "")
      .replace(/!+$/, "")
      .replace(
        /\[\s*(?:"([^"]+)"|'([^']+)'|(\d+))\s*\]/g,
        (_match, double, single, number) => `.${double ?? single ?? number}`,
      )
      .replace(/\[[^\]]+\]/g, ".*")
      .replace(/\s+/g, "");
    return /^(?:this|[A-Za-z_$]\w*)(?:\.(?:[A-Za-z_$]\w*|\d+|\*))*$/.test(
      normalized,
    )
      ? normalized
      : null;
  };
  const pathSegments = (path, environment) => {
    const normalized = normalize(path);
    if (!normalized) return null;
    const segments = normalized.split(".");
    if (!environment.has(segments[0]) && environment.has("this")) {
      segments.unshift("this");
    }
    return segments;
  };
  const readPath = (path, environment) => {
    const segments = pathSegments(path, environment);
    if (!segments) return value();
    let current = environment.get(segments[0]) ?? value();
    for (const segment of segments.slice(1)) {
      const next = [];
      let missing = current.ids.size === 0;
      for (const id of current.ids) {
        const edges = objects.get(id);
        const exact = edges?.get(segment);
        const wildcard = edges?.get("*");
        if (!exact && !wildcard) missing = true;
        next.push(exact, wildcard);
      }
      current = merge(...next, value(false, [], true, missing));
    }
    return current;
  };
  const writePath = (
    path,
    next,
    environment,
    conditional = false,
  ) => {
    const segments = pathSegments(path, environment);
    if (!segments) return;
    if (segments.length === 1) {
      environment.set(
        segments[0],
        conditional
          ? merge(environment.get(segments[0]), next)
          : next,
      );
      return;
    }
    let current = environment.get(segments[0]);
    if (!current || current.ids.size === 0) {
      current = allocate();
      environment.set(segments[0], current);
    }
    for (const segment of segments.slice(1, -1)) {
      const children = [];
      for (const id of current.ids) {
        const edges = objects.get(id);
        let child = edges.get(segment);
        if (!child || child.ids.size === 0) {
          child = allocate();
          edges.set(segment, child);
        }
        children.push(child);
      }
      current = merge(...children);
    }
    const field = segments.at(-1);
    for (const id of current.ids) {
      const edges = objects.get(id);
      edges?.set(
        field,
        conditional ? merge(edges.get(field), next) : next,
      );
    }
  };
  const copyObjectEdges = (
    target,
    sourceValue,
    conditional = false,
    weakExact = false,
  ) => {
    const sourceEdges = [...sourceValue.ids].map(
      (id) => new Map(objects.get(id)),
    );
    const fields = new Set();
    for (const edges of sourceEdges) {
      for (const field of edges?.keys() ?? []) {
        if (field !== "*") fields.add(field);
      }
    }

    for (const targetId of target.ids) {
      const targetEdges = objects.get(targetId);
      if (!targetEdges) continue;
      for (const field of fields) {
        const exact = sourceEdges.map((edges) => edges?.get(field));
        const wildcards = sourceEdges.map((edges) => edges?.get("*"));
        const copied = merge(...exact, ...wildcards);
        const missing = exact.some((child) => !child);
        targetEdges.set(
          field,
          conditional ||
              weakExact ||
              missing ||
              wildcards.some(Boolean) ||
              sourceValue.uncertain
            ? merge(targetEdges.get(field), copied)
            : copied,
        );
      }

      const wildcard = merge(
        ...sourceEdges.map((edges) => edges?.get("*")),
        sourceValue.tainted || sourceValue.uncertain
          ? value(
            sourceValue.tainted,
            [],
            sourceValue.derived,
            sourceValue.uncertain,
          )
          : null,
      );
      if (
        wildcard.tainted ||
        wildcard.derived ||
        wildcard.uncertain ||
        wildcard.ids.size > 0
      ) {
        targetEdges.set("*", merge(targetEdges.get("*"), wildcard));
      }
    }
    return target;
  };

  const invocations = (expression) => {
    const found = [];
    const pattern =
      /((?:[A-Za-z_$]\w*\s*\.\s*)*[A-Za-z_$]\w*)\s*\(/g;
    let match;
    while ((match = pattern.exec(expression)) !== null) {
      const open = expression.indexOf("(", match.index);
      const argumentsText = balancedText(expression, open);
      const close = open + argumentsText.length + 1;
      found.push({
        args: argumentsText,
        end: close + 1,
        name: match[1].replace(/\s+/g, ""),
        start: match.index,
      });
      pattern.lastIndex = close + 1;
    }
    return found;
  };
  const isSink = (name) =>
    /^(?:(?:console|process\.(?:stdout|stderr)|[A-Za-z_$]\w*(?:\.[A-Za-z_$]\w*)*)\.(?:log|info|warn|error|debug|trace|write|print|printf|dir|table)|(?:debug|logger|log|print|printf|output|write))$/.test(
      name,
    );

  const controlRanges = (region) => {
    const ranges = [];
    const code = maskSource(region, true);
    const controls = /\b(if|while|for)\s*\(/g;
    for (const match of code.matchAll(controls)) {
      const open = match.index + match[0].lastIndexOf("(");
      const condition = balancedText(region, open).trim();
      const close = open + balancedText(region, open).length + 1;
      let bodyStart = close + 1;
      while (/\s/.test(code[bodyStart] ?? "")) bodyStart += 1;
      let bodyEnd;
      if (code[bodyStart] === "{") {
        bodyEnd =
          bodyStart + balancedText(region, bodyStart, "{", "}").length + 1;
        bodyStart += 1;
      } else {
        bodyEnd = expressionEnd(code, bodyStart);
      }
      ranges.push({
        end: bodyEnd,
        skip: match[1] === "while" && condition === "false",
        start: bodyStart,
      });
    }
    return ranges;
  };
  const statements = (region) => {
    const found = [];
    let start = 0;
    let parentheses = 0;
    let brackets = 0;
    let initializerBraces = 0;
    for (let index = 0; index < region.length; index += 1) {
      const character = region[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") parentheses = Math.max(0, parentheses - 1);
      else if (character === "[") brackets += 1;
      else if (character === "]") brackets = Math.max(0, brackets - 1);
      else if (character === "{") {
        const prefix = region.slice(start, index);
        const initializer =
          parentheses > 0 ||
          brackets > 0 ||
          initializerBraces > 0 ||
          (/=/.test(prefix) && !/=>\s*$/.test(prefix));
        if (initializer) initializerBraces += 1;
        else start = index + 1;
      } else if (character === "}") {
        if (initializerBraces > 0) initializerBraces -= 1;
        else start = index + 1;
      } else if (
        character === ";" &&
        parentheses === 0 &&
        brackets === 0 &&
        initializerBraces === 0
      ) {
        const text = region.slice(start, index).trim();
        if (text) {
          const leading = region.slice(start, index).indexOf(text);
          found.push({ start: start + leading, text });
        }
        start = index + 1;
      }
    }
    return found;
  };
  const declaration =
    /^\s*(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*[!?])?(?:\s*:[^=;\n]+)?\s*=\s*([\s\S]+)$/;
  const assignment =
    /^\s*((?:this\s*\.\s*)?[A-Za-z_$]\w*(?:\s*(?:\.\s*[A-Za-z_$]\w*|\[[^\]]+\]))*)\s*=\s*([\s\S]+)$/;

  const executeDefinition = (
    definition,
    argumentsList,
    receiver,
    depth,
    conditional = false,
  ) => {
    if (depth > 128) return value();
    const environment = new Map();
    definition.parameters.forEach((parameter, index) => {
      environment.set(parameter, argumentsList[index] ?? value());
    });
    if (receiver) environment.set("this", receiver);
    return execute(
      definition.body,
      environment,
      depth + 1,
      definition.bodyStart,
      conditional,
    ).returned;
  };
  const expressionValue = (
    expression,
    environment,
    depth,
    position = 0,
    conditional = false,
  ) => {
    let text = expression.trim().replace(/^await\s+/, "").replace(/!+$/, "");
    while (text.startsWith("(")) {
      const inner = balancedText(text, 0);
      if (inner.length + 2 !== text.length) break;
      text = inner.trim();
    }
    if (
      /\bprocess\s*\.\s*env\s*(?:\.\s*AZURE_CLIENT_SECRET\b|\[\s*["']AZURE_CLIENT_SECRET["']\s*\])/.test(
        text,
      )
    ) {
      return value(true);
    }
    if (
      /^Object\s*\.\s*assign$/.test(maskSource(text, true)) &&
      hasGlobalObject(position)
    ) {
      return value(false, [], false, false, true);
    }
    const path = normalize(text);
    if (path) return readPath(path, environment);

    const foundCalls = invocations(text);
    const wholeCall = foundCalls.find(
      (call) => call.start === 0 && call.end === text.length,
    );
    if (wholeCall) {
      const directObjectAssign = wholeCall.name === "Object.assign";
      const intrinsic =
        (directObjectAssign && hasGlobalObject(position)) ||
        readPath(wholeCall.name, environment).objectAssign;
      if (intrinsic) {
        const rawArguments = splitTopLevel(wholeCall.args);
        if (rawArguments.length === 0 || rawArguments[0] === "") {
          return value();
        }
        let argumentCursor = text.indexOf("(") + 1;
        const argumentValues = rawArguments.map((argument) => {
          const argumentIndex = text.indexOf(argument, argumentCursor);
          argumentCursor =
            (argumentIndex === -1 ? argumentCursor : argumentIndex) +
            argument.length + 1;
          return expressionValue(
            argument,
            environment,
            depth,
            position + Math.max(0, argumentIndex),
            conditional,
          );
        });
        const target = argumentValues[0];
        for (const sourceValue of argumentValues.slice(1)) {
          copyObjectEdges(target, sourceValue, conditional);
        }
        return target;
      }
      if (directObjectAssign && !hasGlobalObject(position)) {
        return value(false, [], true);
      }
    }
    const whole = foundCalls.find(
      (call) =>
        call.start === 0 &&
        call.end === text.length &&
        methodsByName.has(call.name.split(".").at(-1)),
    );
    if (whole) {
      const argumentsList = splitTopLevel(whole.args).map((argument) =>
        expressionValue(argument, environment, depth, position, conditional),
      );
      const receiverPath = whole.name.split(".").slice(0, -1).join(".");
      const receiver = receiverPath
        ? readPath(receiverPath, environment)
        : environment.get("this");
      return merge(
        ...(methodsByName.get(whole.name.split(".").at(-1)) ?? [])
          .filter(
            (definition) =>
              definition.parameters.length === argumentsList.length,
          )
          .map((definition) =>
            executeDefinition(
              definition,
              argumentsList,
              receiver,
              depth,
              conditional,
            )
          ),
      );
    }

    const objectLiteral = /^\{([\s\S]*)\}$/.exec(text);
    const arrayLiteral = /^\[([\s\S]*)\]$/.exec(text);
    if (/^new\b/.test(text) || objectLiteral || arrayLiteral) {
      const result = allocate();
      if (/ClientSecretCredential/.test(text)) return result;
      if (objectLiteral) {
        for (const entry of splitTopLevel(objectLiteral[1])) {
          const spread = /^\s*\.\.\.([\s\S]+)$/.exec(entry);
          if (spread) {
            const child = expressionValue(
              spread[1],
              environment,
              depth,
              position,
              conditional,
            );
            copyObjectEdges(result, child, conditional, true);
            continue;
          }
          const property =
            /^\s*(?:([A-Za-z_$]\w*)|["']([^"']+)["'])\s*:\s*([\s\S]+)$/.exec(
              entry,
            );
          const shorthand = property
            ? null
            : /^\s*([A-Za-z_$]\w*)\s*$/.exec(entry);
          const field = property?.[1] ?? property?.[2] ?? shorthand?.[1];
          const child = property?.[3] ?? shorthand?.[1];
          if (!field || !child) continue;
          const childValue = expressionValue(
            child,
            environment,
            depth,
            position,
            conditional,
          );
          result.uncertain ||= childValue.uncertain;
          for (const id of result.ids) {
            objects.get(id).set(
              field,
              childValue,
            );
          }
        }
      } else if (arrayLiteral) {
        const children = splitTopLevel(arrayLiteral[1]).map((entry) =>
          expressionValue(entry.replace(/^\s*\.\.\./, ""), environment, depth)
        );
        result.uncertain ||= children.some((child) => child.uncertain);
        for (const id of result.ids) {
          objects.get(id).set(
            "*",
            merge(...children),
          );
        }
      }
      return result;
    }

    const question = text.indexOf("?");
    const colon = question < 0 ? -1 : text.indexOf(":", question + 1);
    if (colon > question) {
      return merge(
        expressionValue(
          text.slice(question + 1, colon),
          environment,
          depth,
          position,
          conditional,
        ),
        expressionValue(
          text.slice(colon + 1),
          environment,
          depth,
          position,
          conditional,
        ),
      );
    }

    const code = maskSource(text, true);
    const references = [];
    for (const call of foundCalls) {
      const receiver = call.name.split(".").slice(0, -1).join(".");
      if (receiver) references.push(readPath(receiver, environment));
    }
    for (const match of code.matchAll(
      /(?<![\w.])(?:this\s*\.\s*)?[A-Za-z_$]\w*(?:\s*(?:\.\s*[A-Za-z_$]\w*|\[[^\]]+\]))*/g,
    )) {
      references.push(readPath(match[0], environment));
    }
    return merge(...references);
  };

  const execute = (
    region,
    environment,
    depth = 0,
    regionOffset = 0,
    inheritedConditional = false,
  ) => {
    let returned = value();
    let hasReturn = false;
    const ranges = controlRanges(region);
    for (const statement of statements(region)) {
      const controls = ranges.filter(
        (range) => range.start <= statement.start && statement.start < range.end,
      );
      if (controls.some((range) => range.skip)) continue;
      const conditional = inheritedConditional || controls.length > 0;
      const declared = declaration.exec(statement.text);
      if (declared) {
        writePath(
          declared[1],
          expressionValue(
            declared[2],
            environment,
            depth,
            regionOffset + statement.start,
            conditional,
          ),
          environment,
          conditional,
        );
        continue;
      }
      const assigned = assignment.exec(statement.text);
      if (assigned) {
        writePath(
          assigned[1],
          expressionValue(
            assigned[2],
            environment,
            depth,
            regionOffset + statement.start,
            conditional,
          ),
          environment,
          conditional,
        );
        continue;
      }
      const returnedExpression = /^\s*return\s+([\s\S]+)$/.exec(
        statement.text,
      );
      if (returnedExpression) {
        const nextReturn = expressionValue(
          returnedExpression[1],
          environment,
          depth,
          regionOffset + statement.start,
          conditional,
        );
        returned = hasReturn ? merge(returned, nextReturn) : nextReturn;
        hasReturn = true;
        continue;
      }
      for (const call of invocations(statement.text)) {
        const simpleName = call.name.split(".").at(-1);
        const callPosition =
          regionOffset + statement.start + call.start;
        if (
          (
            call.name === "Object.assign" &&
            hasGlobalObject(callPosition)
          ) ||
          readPath(call.name, environment).objectAssign
        ) {
          expressionValue(
            statement.text.slice(call.start, call.end),
            environment,
            depth,
            callPosition,
            conditional,
          );
          continue;
        }
        const argumentsList = splitTopLevel(call.args).map((argument) =>
          expressionValue(
            argument,
            environment,
            depth,
            callPosition,
            conditional,
          ),
        );
        if (isSink(call.name)) {
          if (argumentsList.some((argument) => descendantTainted(argument))) {
            exposed = true;
          } else if (
            argumentsList.some(
              (argument) =>
                !argument.uncertain &&
                (argument.derived || argument.ids.size > 0),
            ) &&
            (
              depth === 0 ||
              [...environment.values()].some(
                (binding) => binding.ids.size > 0,
              )
            )
          ) {
            cleanSinks.add(statement.text);
          }
          continue;
        }
        const receiverPath = call.name.split(".").slice(0, -1).join(".");
        const receiver = receiverPath
          ? readPath(receiverPath, environment)
          : environment.get("this");
        if (
          /^(?:push|unshift|add|set)$/.test(simpleName) &&
          receiverPath
        ) {
          writePath(
            `${receiverPath}[*]`,
            merge(readPath(`${receiverPath}[*]`, environment), ...argumentsList),
            environment,
            conditional,
          );
        }
        for (const definition of methodsByName.get(simpleName) ?? []) {
          if (definition.parameters.length === argumentsList.length) {
            executeDefinition(
              definition,
              argumentsList,
              receiver,
              depth,
              conditional,
            );
          }
        }
      }
    }
    return { returned };
  };

  let root = source;
  for (const definition of [...definitions].sort(
    (left, right) => right.start - left.start,
  )) {
    if (definition.start === undefined) continue;
    root =
      root.slice(0, definition.start) +
      root.slice(definition.start, definition.bodyEnd + 1).replace(/[^\n]/g, " ") +
      root.slice(definition.bodyEnd + 1);
  }
  execute(root, new Map(), 0, 0);

  let sanitized = source;
  for (const statement of cleanSinks) {
    sanitized = sanitized.replaceAll(statement, statement.replace(/[^\n]/g, " "));
  }
  return { exposed, source: sanitized };
}

function logsClientSecret(context) {
  let source = context.source;
  const helpers = taintHelperDefinitions(source);
  const identity = allocationIdentityTaint(source, helpers);
  if (identity.exposed) return true;
  source = identity.source;
  const code = maskSource(source, true);
  const classRanges = [];
  const classInstances = new Map();
  const classes = /\bclass\s+([A-Za-z_$]\w*)[^{]*\{/g;
  for (const match of code.matchAll(classes)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const body = balancedText(source, opening, "{", "}");
    classRanges.push({
      end: opening + body.length + 2,
      name: match[1],
      start: opening + 1,
    });
    classInstances.set(match[1], new Set());
  }
  const instances =
    /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=\s*new\s+([A-Za-z_$]\w*)\s*(?:<[^;(){}]+>)?\s*\(/g;
  for (const match of code.matchAll(instances)) {
    classInstances.get(match[2])?.add(match[1]);
  }

  const summaries = new Map();
  const directSecret =
    /\bprocess\s*\.\s*env\s*(?:\.\s*AZURE_CLIENT_SECRET\b|\[\s*["']AZURE_CLIENT_SECRET["']\s*\])/;
  const safeScalar = (expression) => {
    const text = expression.trim();
    if (
      /^(?:Boolean\s*\(|!!|typeof\b)/.test(text) ||
      /^\(*\s*[A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)*\s*\.\s*length\s*\)*$/.test(
        maskSource(text, true),
      )
    ) {
      return true;
    }
    const question = text.indexOf("?");
    if (question === -1) return false;
    const colon = text.indexOf(":", question + 1);
    return (
      colon !== -1 &&
      expressionCode(text.slice(question + 1, colon)).trim() === "" &&
      expressionCode(text.slice(colon + 1)).trim() === ""
    );
  };

  const emptySummary = () => ({
    leaks: false,
    returned: false,
    writes: new Set(),
  });
  const summaryKey = (definition, parameterIndex) =>
    `${definition.name}:${parameterIndex}`;
  const analyzeFunction = (definition, argumentTaint) => {
    const result = emptySummary();
    const relevant = [-1];
    argumentTaint.forEach((tainted, index) => {
      if (tainted) relevant.push(index);
    });
    for (const parameterIndex of relevant) {
      const summary = summaries.get(
        summaryKey(definition, parameterIndex),
      );
      if (!summary) continue;
      result.leaks ||= summary.leaks;
      result.returned ||= summary.returned;
      for (const write of summary.writes) result.writes.add(write);
    }
    return result;
  };

  const wholeHelperCall = (expression, offset) => {
    const text = expression.trim();
    const match =
      /^(?:await\s+)?([A-Za-z_$]\w*)\s*\(/.exec(
        maskSource(text, true),
      );
    if (!match) return null;
    const opening = text.indexOf("(", match.index);
    const argumentsText = balancedText(text, opening);
    if (
      text.slice(opening + argumentsText.length + 2).trim() !== ""
    ) {
      return null;
    }
    const definition = helpers.get(match[1]);
    if (!definition) return null;
    return {
      arguments: splitTopLevel(argumentsText),
      definition,
      offset: offset + opening + 1,
    };
  };

  const containsTaintedReference = (expression, taints) => {
    const normalized = expressionCode(expression)
      .replace(
        /\[\s*(?:"([^"]+)"|'([^']+)'|(\d+))\s*\]/g,
        (_match, double, single, number) =>
          `.${double ?? single ?? number}`,
      )
      .replace(/\s+/g, "");
    return [...taints].some((name) => {
      const compact = name.replace(/\s+/g, "");
      const pattern = new RegExp(
        `(?<![\\w$])${escapeRegExp(compact)}(?![\\w$])`,
      );
      if (pattern.test(normalized)) return true;

      const segments = compact.split(".");
      for (let length = 1; length < segments.length; length += 1) {
        const aggregate = segments.slice(0, length).join(".");
        if (
          new RegExp(
            `(?<![\\w$])${escapeRegExp(aggregate)}(?![\\w$.])`,
          ).test(normalized)
        ) {
          return true;
        }
      }
      return false;
    });
  };

  const expressionTainted = (expression, offset, taints) => {
    if (safeScalar(expression)) return false;
    const credential = constructorCalls(
      expression,
      context.credentialTypes.clientSecret,
      "ClientSecretCredential",
      offset,
    ).find((call) =>
      maskSource(expression.slice(0, call.index), true).trim() === ""
    );
    if (credential) return false;

    let secretBearingExpression = expression;
    const credentialCalls = constructorCalls(
      expression,
      context.credentialTypes.clientSecret,
      "ClientSecretCredential",
      offset,
    );
    for (const call of credentialCalls.reverse()) {
      secretBearingExpression =
        secretBearingExpression.slice(0, call.index) +
        " ".repeat(call.end - call.index) +
        secretBearingExpression.slice(call.end);
    }

    const helperCall = wholeHelperCall(expression, offset);
    if (helperCall) {
      const argumentTaint = helperCall.arguments.map((argument, index) =>
        expressionTainted(
          argument,
          helperCall.offset +
            helperCall.arguments
              .slice(0, index)
              .reduce((length, item) => length + item.length + 1, 0),
          taints,
        )
      );
      return analyzeFunction(
        helperCall.definition,
        argumentTaint,
      ).returned;
    }

    const safeHelperCalls = [];
    const expressionSource = expressionCode(expression);
    for (const definition of helpers.values()) {
      const pattern = new RegExp(
        `\\b${escapeRegExp(definition.name)}\\s*\\(`,
        "g",
      );
      for (const match of expressionSource.matchAll(pattern)) {
        const opening = match.index + match[0].lastIndexOf("(");
        const argumentsText = balancedText(expression, opening);
        const argumentTaint = splitTopLevel(argumentsText).map(
          (argument) =>
            expressionTainted(
              argument,
              offset + opening + 1,
              taints,
            ),
        );
        if (!analyzeFunction(definition, argumentTaint).returned) {
          safeHelperCalls.push({
            end: opening + argumentsText.length + 2,
            start: match.index,
          });
        }
      }
    }
    safeHelperCalls
      .sort((left, right) => right.start - left.start)
      .forEach(({ end, start }) => {
        secretBearingExpression =
          secretBearingExpression.slice(0, start) +
          " ".repeat(end - start) +
          secretBearingExpression.slice(end);
      });

    return (
      directSecret.test(maskSource(secretBearingExpression, true)) ||
      context.containsEnvironmentValue(
        secretBearingExpression,
        "AZURE_CLIENT_SECRET",
        offset,
      ) ||
      containsTaintedReference(secretBearingExpression, taints) ||
      classRanges.some(({ name }) =>
        taints.has(`${name}.prototype`) &&
        new RegExp(`\\bnew\\s+${escapeRegExp(name)}\\b`).test(
          maskSource(secretBearingExpression, true),
        )
      )
    );
  };

  function analyzeRegion(region, regionOffset, initialTaints) {
    const regionCode = maskSource(region, true);
    const taints = new Set(initialTaints);
    const writes = new Set();
    const declarations =
      /\b(?:const|let|var)\s+([A-Za-z_$]\w*)(?:\s*:[^=;\n]+)?\s*=(?!=|>)/g;
    const members =
      /\b((?:this|[A-Za-z_$]\w*)(?:\s*(?:\.\s*[A-Za-z_$]\w*|\[\s*(?:["'][^"']+["']|\d+)\s*\]))+)\s*=(?!=|>)/g;
    const assignments =
      /(?<!\b(?:const|let|var)\s)\b([A-Za-z_$]\w*)\s*=(?!=|>)/g;
    const destructuring =
      /\b(?:const|let|var)\s+(\{[^{}]*\}|\[[^\[\]]*\])\s*=(?!=|>)/g;
    const mutations =
      /\b((?:this|[A-Za-z_$]\w*)(?:\s*(?:\.\s*[A-Za-z_$]\w*|\[\s*(?:["'][^"']+["']|\d+)\s*\]))*)\s*\.\s*(?:push|unshift)\s*\(/g;
    const fields =
      /(?:^|\n)\s*((?:(?:public|private|protected|readonly|static|declare|override)\s+)*)?([A-Za-z_$]\w*)(?:\s*[!?])?(?:\s*:[^=;\n]+)?\s*=(?!=|>)/g;

    const normalizeTarget = (target) =>
      target
        .replace(
          /\[\s*(?:"([^"]+)"|'([^']+)'|(\d+))\s*\]/g,
          (_match, double, single, number) =>
            `.${double ?? single ?? number}`,
        )
        .replace(/\s+/g, "");
    const addTaint = (target, position) => {
      const compact = normalizeTarget(target);
      taints.add(compact);

      if (!compact.startsWith("this.")) return;
      const containingClass = classRanges.find(
        (range) =>
          range.start <= position && position < range.end,
      );
      if (!containingClass) return;
      const suffix = compact.slice("this.".length);
      addTaint(`${containingClass.name}.prototype.${suffix}`, -1);
      for (const instance of classInstances.get(containingClass.name) ?? []) {
        addTaint(`${instance}.${suffix}`, -1);
      }
    };

    while (true) {
      const before = taints.size;
      const record = (target, equals) => {
        const start = equals + 1;
        const end = expressionEnd(regionCode, start);
        const expression = region.slice(start, end);
        const object = maskSource(expression, false).trim();
        const explicitObject =
          object.startsWith("{") &&
          object.endsWith("}") &&
          !splitTopLevel(object.slice(1, -1)).some((entry) =>
            /^\s*\.\.\./.test(entry)
          );
        if (
          !explicitObject &&
          expressionTainted(expression, regionOffset + start, taints)
        ) {
          addTaint(target, regionOffset + equals);
          if (normalizeTarget(target).includes(".")) {
            writes.add(normalizeTarget(target).split(".")[0]);
          }
        }

        if (object.startsWith("{") && object.endsWith("}")) {
          for (const entry of splitTopLevel(object.slice(1, -1))) {
            const property = entry.match(
              /^(?:([A-Za-z_$]\w*)|["']([^"']+)["'])\s*:\s*([\s\S]+)$/,
            );
            const shorthand = property
              ? null
              : entry.trim().match(/^([A-Za-z_$]\w*)$/);
            const name = property?.[1] ?? property?.[2] ?? shorthand?.[1];
            const value = property?.[3] ?? shorthand?.[1];
            if (
              name &&
              value &&
              expressionTainted(
                value,
                regionOffset + start,
                taints,
              )
            ) {
              addTaint(
                `${normalizeTarget(target)}.${name}`,
                regionOffset + equals,
              );
            }
          }
        }
      };

      for (const match of regionCode.matchAll(declarations)) {
        record(
          match[1],
          match.index + match[0].lastIndexOf("="),
        );
      }
      for (const match of regionCode.matchAll(members)) {
        record(
          match[1],
          match.index + match[0].lastIndexOf("="),
        );
      }
      for (const match of regionCode.matchAll(assignments)) {
        record(
          match[1],
          match.index + match[0].lastIndexOf("="),
        );
      }
      for (const match of regionCode.matchAll(destructuring)) {
        const equals = match.index + match[0].lastIndexOf("=");
        const start = equals + 1;
        const end = expressionEnd(regionCode, start);
        if (
          !expressionTainted(
            region.slice(start, end),
            regionOffset + start,
            taints,
          )
        ) {
          continue;
        }
        for (const binding of match[1].matchAll(/\b[A-Za-z_$]\w*\b/g)) {
          addTaint(binding[0], regionOffset + equals);
        }
      }
      for (const match of regionCode.matchAll(mutations)) {
        const opening = match.index + match[0].lastIndexOf("(");
        const argumentsText = balancedText(region, opening);
        if (
          splitTopLevel(argumentsText).some((argument) =>
            expressionTainted(
              argument,
              regionOffset + opening + 1,
              taints,
            )
          )
        ) {
          addTaint(match[1], regionOffset + match.index);
          writes.add(normalizeTarget(match[1]).split(".")[0]);
        }
      }
      for (const definition of helpers.values()) {
        const pattern = new RegExp(
          `\\b${escapeRegExp(definition.name)}\\s*\\(`,
          "g",
        );
        for (const match of regionCode.matchAll(pattern)) {
          if (
            /\bfunction\s*$/.test(
              regionCode.slice(
                Math.max(0, match.index - 20),
                match.index,
              ),
            )
          ) {
            continue;
          }
          const opening = match.index + match[0].lastIndexOf("(");
          const argumentsList = splitTopLevel(
            balancedText(region, opening),
          );
          const argumentTaint = argumentsList.map((argument) =>
            expressionTainted(
              argument,
              regionOffset + opening + 1,
              taints,
            )
          );
          const summary = analyzeFunction(
            definition,
            argumentTaint,
          );
          for (const write of summary.writes) {
            let mapped = write;
            definition.parameters.forEach((parameter, index) => {
              if (
                mapped !== parameter &&
                !mapped.startsWith(`${parameter}.`)
              ) {
                return;
              }
              const argument = normalizeTarget(
                argumentsList[index] ?? "",
              );
              if (!/^(?:this|[A-Za-z_$]\w*)(?:\.[\w$]+)*$/.test(
                argument,
              )) {
                return;
              }
              mapped = argument + mapped.slice(parameter.length);
            });
            addTaint(mapped, regionOffset + match.index);
            writes.add(mapped);
          }
        }
      }
      for (const match of regionCode.matchAll(fields)) {
        const index = regionOffset + match.index;
        const containingClass = classRanges.find(
          (range) => range.start <= index && index < range.end,
        );
        if (!containingClass) continue;
        const target = /\bstatic\b/.test(match[1] ?? "")
          ? `${containingClass.name}.${match[2]}`
          : `this.${match[2]}`;
        record(target, match.index + match[0].lastIndexOf("="));
      }
      if (taints.size === before) break;
    }

    const scopeIndex = sourceScopes(region);
    const assignmentIsConditional = (position) => {
      if (scopeIndex.at(position).conditional) return true;
      const prefix = regionCode.slice(0, position);
      const boundary = Math.max(
        prefix.lastIndexOf(";"),
        prefix.lastIndexOf("{"),
        prefix.lastIndexOf("}"),
      );
      const statement = prefix.slice(boundary + 1);
      return /^\s*(?:(?:if|for|while|switch)\s*\([\s\S]*\)|(?:else|do)\b)[\s\S]*$/.test(
        statement,
      );
    };
    const assignmentPattern =
      /\b((?:this|[A-Za-z_$]\w*)(?:\s*(?:\.\s*[A-Za-z_$]\w*|\[\s*(?:["'][^"']+["']|\d+)\s*\]))*)\s*=(?!=|>)/g;
    const filteredTaintsAt = (position, resolving = new Set()) => {
      const filtered = new Set(taints);
      for (const name of taints) {
        let latest = null;
        assignmentPattern.lastIndex = 0;
        for (const match of regionCode.matchAll(assignmentPattern)) {
          const equals = match.index + match[0].lastIndexOf("=");
          if (equals >= position || normalizeTarget(match[1]) !== name) {
            continue;
          }
          latest = { equals, start: equals + 1 };
        }
        if (!latest || assignmentIsConditional(latest.equals)) continue;
        const resolution = `${name}:${latest.equals}`;
        if (resolving.has(resolution)) continue;
        const end = expressionEnd(regionCode, latest.start);
        const expression = region.slice(latest.start, end);
        const nestedResolving = new Set(resolving);
        nestedResolving.add(resolution);
        if (
          !expressionTainted(
            expression,
            regionOffset + latest.start,
            filteredTaintsAt(latest.equals, nestedResolving),
          )
        ) {
          filtered.delete(name);
        }
      }
      return filtered;
    };
    const expressionTaintedAt = (expression, offset, position) =>
      expressionTainted(expression, offset, filteredTaintsAt(position));

    const sinkCalls = [];
    const memberSinks =
      /\b((?:[A-Za-z_$]\w*\s*\.\s*)+)(log|info|warn|error|debug|trace|write|print|printf|dir|table)\s*\(/g;
    for (const match of regionCode.matchAll(memberSinks)) {
      const opening = match.index + match[0].lastIndexOf("(");
      sinkCalls.push({
        arguments: balancedText(region, opening),
        offset: regionOffset + opening + 1,
      });
    }
    const directSinks =
      /\b(?:debug|logger|log|print|printf|output|write)\s*\(/g;
    for (const match of regionCode.matchAll(directSinks)) {
      const prefix = regionCode.slice(
        Math.max(0, match.index - 10),
        match.index,
      );
      if (/\.\s*$/.test(prefix)) continue;
      const opening = match.index + match[0].lastIndexOf("(");
      sinkCalls.push({
        arguments: balancedText(region, opening),
        offset: regionOffset + opening + 1,
      });
    }
    const leaks = sinkCalls.some((call) =>
      splitTopLevel(call.arguments).some((argument) =>
        expressionTaintedAt(
          argument,
          call.offset,
          call.offset - regionOffset,
        )
      )
    );

    let helperLeak = false;
    for (const definition of helpers.values()) {
      const pattern = new RegExp(
        `\\b${escapeRegExp(definition.name)}\\s*\\(`,
        "g",
      );
      for (const match of regionCode.matchAll(pattern)) {
        if (
          /\bfunction\s*$/.test(
            regionCode.slice(Math.max(0, match.index - 20), match.index),
          )
        ) {
          continue;
        }
        const opening = match.index + match[0].lastIndexOf("(");
        const argumentsText = balancedText(region, opening);
        const argumentTaint = splitTopLevel(argumentsText).map(
          (argument) =>
            expressionTaintedAt(
              argument,
              regionOffset + opening + 1,
              match.index,
            ),
        );
        if (
          argumentTaint.some(Boolean) &&
          analyzeFunction(definition, argumentTaint).leaks
        ) {
          helperLeak = true;
        }
      }
    }

    let returned = false;
    const returns = /\breturn\b/g;
    for (const match of regionCode.matchAll(returns)) {
      const start = match.index + match[0].length;
      const end = expressionEnd(regionCode, start);
      if (
        expressionTaintedAt(
          region.slice(start, end),
          regionOffset + start,
          match.index,
        )
      ) {
        returned = true;
      }
    }
    return {
      leaks: leaks || helperLeak,
      returned,
      writes,
    };
  }

  for (const definition of helpers.values()) {
    for (
      let parameterIndex = -1;
      parameterIndex < definition.parameters.length;
      parameterIndex += 1
    ) {
      summaries.set(
        summaryKey(definition, parameterIndex),
        emptySummary(),
      );
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of helpers.values()) {
      for (
        let parameterIndex = -1;
        parameterIndex < definition.parameters.length;
        parameterIndex += 1
      ) {
        const initial = new Set();
        if (parameterIndex >= 0) {
          const parameter = definition.parameters[parameterIndex];
          if (parameter) initial.add(parameter);
        }
        const result = analyzeRegion(
          definition.body,
          definition.bodyStart,
          initial,
        );
        const current = summaries.get(
          summaryKey(definition, parameterIndex),
        );
        if (result.leaks && !current.leaks) {
          current.leaks = true;
          changed = true;
        }
        if (result.returned && !current.returned) {
          current.returned = true;
          changed = true;
        }
        for (const write of result.writes) {
          if (current.writes.has(write)) continue;
          current.writes.add(write);
          changed = true;
        }
      }
    }
  }

  return analyzeRegion(source, 0, new Set()).leaks;
}

const rules = {
  "prompt/identity-packages": (workspace) => {
    if (!hasSource(workspace)) return false;
    const dependencies = packageDependencies(workspace.packageJson);
    const importsIdentity = typeNames(
      workspace.source,
      "@azure/identity",
      "ClientSecretCredential",
    ).size > 0;
    const importsSecretClient = typeNames(
      workspace.source,
      "@azure/keyvault-secrets",
      "SecretClient",
    ).size > 0;
    return (
      importsIdentity &&
      importsSecretClient &&
      dotenvState(workspace.source).imported &&
      ["@azure/identity", "@azure/keyvault-secrets", "dotenv"].every(
        (name) => validRuntimeDependencyDeclaration(dependencies[name]),
      )
    );
  },
  "prompt/environment-secret-management": (workspace) => {
    if (!hasSource(workspace)) return false;
    const context = servicePrincipalContext(workspace);
    const hasNamedOperation = [...context.clientCandidates].some((name) =>
      methodCalls(context.source, name, "getSecret").some(
        ({ arguments: args, index }) =>
          context.isSecretNameAt(args, index) &&
          context.isValidClientAt(name, index),
      )
    );
    return (
      dotenvInitializedBeforeEnvironment(context.source) &&
      constructorSecretInputsAreSafe(context) &&
      context.associatedClients.length > 0 &&
      hasNamedOperation &&
      !logsClientSecret(context)
    );
  },
  "prompt/client-secret-credential": (workspace) =>
    hasSource(workspace) &&
    servicePrincipalContext(workspace).createdCredentialTypes.has(
      "client-secret",
    ),
  "prompt/credential-client-association": (workspace) =>
    hasSource(workspace) &&
    servicePrincipalContext(workspace).associatedClients.length > 0,
  "prompt/authenticated-operation": (workspace) => {
    if (!hasSource(workspace)) return false;
    const {
      clientCandidates,
      isSecretNameAt,
      isValidClientAt,
      source,
    } = servicePrincipalContext(workspace);
    return [...clientCandidates].some((name) =>
      methodCalls(source, name, "getSecret").some(
        ({ arguments: args, index }) =>
          isSecretNameAt(args, index) &&
          isValidClientAt(name, index) &&
          isAwaitedCall(source, index) &&
          printsSecretResult(
            source,
            name,
            isValidClientAt,
            isSecretNameAt,
          ),
      )
    );
  },
  "prompt/authentication-errors": (workspace) => {
    if (!hasSource(workspace)) return false;
    const {
      clientCandidates,
      isValidClientAt,
      isSecretNameAt,
      source,
    } = servicePrincipalContext(workspace);
    return handlesAuthenticationError(
      source,
      clientCandidates,
      isValidClientAt,
      isSecretNameAt,
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
