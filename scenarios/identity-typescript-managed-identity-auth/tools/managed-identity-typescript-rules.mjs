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
      const scope = {
        bindings: new Map(),
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

  function typeConstructor(expression, names, exportedName) {
    const calls = constructorCalls(expression, names, exportedName);
    return calls.find((call) =>
      maskSource(expression.slice(0, call.index), true).trim() === ""
    ) ?? null;
  }

  function referencedValue(expression, position) {
    return valueAt(resolveReference(expression, position), position);
  }

  function isClientId(expression, position) {
    return isEnvironmentValue(expression, "AZURE_CLIENT_ID", position);
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

  function booleanValue(expression, position) {
    const text = maskSource(expression, true).trim();
    if (/^\(*\s*false\s*\)*$/.test(text)) return "false";
    if (/^\(*\s*true\s*\)*$/.test(text)) return "true";
    const value = referencedValue(expression, position);
    if (value?.kind === "false") return "false";
    if (value?.kind === "true") return "true";
    return "unknown";
  }

  function parseOptionState(expression, position) {
    const text = maskSource(expression, false).trim();
    if (!text.startsWith("{") || !text.endsWith("}")) return null;
    const state = {
      clientId: "absent",
      excludeManagedIdentityCredential: "absent",
      invalid: false,
      managedIdentityClientId: "absent",
      otherIdentitySelector: false,
    };

    for (const rawEntry of splitTopLevel(text.slice(1, -1))) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      if (entry.startsWith("...") || entry.startsWith("[")) {
        state.invalid = true;
        continue;
      }
      const property = entry.match(
        /^(?:([A-Za-z_$]\w*)|["']([^"']+)["'])(?:\s*:\s*([\s\S]+))?$/,
      );
      if (!property) continue;
      const name = property[1] ?? property[2];
      const value = property[3]?.trim() ?? name;
      if (name === "clientId") {
        state.clientId = isClientId(value, position)
          ? "client-id"
          : "unknown";
      } else if (name === "managedIdentityClientId") {
        state.managedIdentityClientId = isClientId(value, position)
          ? "client-id"
          : "unknown";
      } else if (name === "excludeManagedIdentityCredential") {
        state.excludeManagedIdentityCredential = booleanValue(
          value,
          position,
        );
      } else if (
        ["objectId", "resourceId", "managedIdentityResourceId"].includes(
          name,
        )
      ) {
        state.otherIdentitySelector = true;
      }
    }
    return state;
  }

  function optionStateAt(value, position) {
    if (value?.kind !== "option-object") return null;
    let selected = null;
    for (const entry of value.history) {
      if (entry.index > position) break;
      selected = entry.state;
    }
    return selected;
  }

  function optionStateFor(expression, position) {
    return (
      optionStateAt(referencedValue(expression, position), position) ??
      parseOptionState(expression, position)
    );
  }

  function validManagedIdentityOptions(state) {
    if (!state || state.invalid || state.otherIdentitySelector) return null;
    if (state.clientId === "client-id") return "user";
    if (
      state.clientId === "absent" &&
      state.managedIdentityClientId === "absent"
    ) {
      return "system";
    }
    return null;
  }

  function validDefaultOptions(state) {
    return (
      state !== null &&
      !state.invalid &&
      !state.otherIdentitySelector &&
      state.managedIdentityClientId === "client-id" &&
      ["absent", "false"].includes(
        state.excludeManagedIdentityCredential,
      )
    );
  }

  function mutateOption(value, event) {
    const previous = optionStateAt(value, event.index);
    if (!previous) return;
    const state = { ...previous };
    if (
      ["computed-assignment", "spread-mutation"].includes(event.kind)
    ) {
      state.invalid = true;
    } else {
      const start = event.equals + 1;
      const expression = original.slice(
        start,
        expressionEnd(code, start),
      );
      if (event.property === "clientId") {
        state.clientId = isClientId(expression, event.index)
          ? "client-id"
          : "unknown";
      } else if (event.property === "managedIdentityClientId") {
        state.managedIdentityClientId = isClientId(
          expression,
          event.index,
        )
          ? "client-id"
          : "unknown";
      } else if (event.property === "excludeManagedIdentityCredential") {
        state.excludeManagedIdentityCredential = booleanValue(
          expression,
          event.index,
        );
      } else {
        state.otherIdentitySelector = true;
      }
    }
    value.history.push({ index: event.index, state });
  }

  function classifyCredential(expression, position) {
    const credentialValue = (credentialType) => {
      createdCredentialTypes.add(credentialType);
      return {
        credentialType,
        kind: "credential",
        version: nextVersion++,
      };
    };
    const managedIdentityCall = typeConstructor(
      expression,
      credentialTypes.managedIdentity,
      "ManagedIdentityCredential",
    );
    if (managedIdentityCall) {
      const args = splitTopLevel(managedIdentityCall.arguments);
      if (args.length === 0 || (args.length === 1 && args[0] === "")) {
        return credentialValue("managed-system");
      }
      const first = args[0];
      if (isClientId(first, position)) {
        return credentialValue("managed-user");
      }
      const optionKind = validManagedIdentityOptions(
        optionStateFor(first, position),
      );
      if (optionKind === "user") {
        return credentialValue("managed-user");
      }
      if (optionKind === "system") {
        return credentialValue("managed-system");
      }
      return null;
    }

    const defaultCall = typeConstructor(
      expression,
      credentialTypes.defaultAzure,
      "DefaultAzureCredential",
    );
    if (defaultCall) {
      const args = splitTopLevel(defaultCall.arguments);
      const options = args[0] ?? "";
      if (!validDefaultOptions(optionStateFor(options, position))) {
        return null;
      }
      return credentialValue("default-managed");
    }

    const cliCall = typeConstructor(
      expression,
      credentialTypes.azureCli,
      "AzureCliCredential",
    );
    if (cliCall) {
      return credentialValue("azure-cli");
    }

    const chainCall = typeConstructor(
      expression,
      credentialTypes.chained,
      "ChainedTokenCredential",
    );
    if (chainCall) {
      const args = splitTopLevel(chainCall.arguments);
      if (args.length < 2) return null;
      const first = classifyCredential(args[0], position) ??
        referencedValue(args[0], position);
      const second = classifyCredential(args[1], position) ??
        referencedValue(args[1], position);
      if (
        !["managed-system", "managed-user"].includes(
          first?.credentialType,
        ) ||
        second?.credentialType !== "azure-cli"
      ) {
        return null;
      }
      return credentialValue("managed-cli-chain");
    }

    const value = referencedValue(expression, position);
    return value?.kind === "credential" ? value : null;
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
    if (/^\(*\s*false\s*\)*$/.test(maskSource(expression, true).trim())) {
      return { kind: "false" };
    }
    if (/^\(*\s*true\s*\)*$/.test(maskSource(expression, true).trim())) {
      return { kind: "true" };
    }

    const initialOptionState = parseOptionState(expression, position);
    if (initialOptionState) {
      return {
        history: [{ index: position, state: initialOptionState }],
        kind: "option-object",
      };
    }

    const credential = classifyCredential(expression, position);
    if (credential) return credential;

    for (const [className, classScope] of classes) {
      if (typeConstructor(expression, new Set([className]), className)) {
        return { classScope, kind: "instance" };
      }
    }

    const clientCall = typeConstructor(
      expression,
      clientTypeNames,
      "SecretClient",
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
      if (
        inlineCredential &&
        inlineCredential.credentialType !== "azure-cli"
      ) {
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
        credentialValue.credentialType === "azure-cli"
      ) return null;
      return {
        credentialBinding,
        credentialType: credentialValue.credentialType,
        credentialVersion: credentialValue.version,
        kind: "client",
        version: nextVersion++,
      };
    }

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
    if (
      event.kind === "computed-assignment" ||
      event.kind === "spread-mutation" ||
      [
        "clientId",
        "excludeManagedIdentityCredential",
        "managedIdentityClientId",
        "managedIdentityResourceId",
        "objectId",
        "resourceId",
      ].includes(event.property)
    ) {
      const optionBinding = resolveReference(
        event.receiver ?? event.name,
        event.index,
      );
      const optionValue = valueAt(optionBinding, event.index);
      if (optionValue?.kind === "option-object") {
        mutateOption(optionValue, event);
        continue;
      }
    }
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
      if (
        !binding &&
        [
          "clientId",
          "excludeManagedIdentityCredential",
          "managedIdentityClientId",
        ].includes(event.property)
      ) {
        binding = resolve(event.name.split(".")[0], event.index);
      }
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
      const previous = valueAt(binding, event.index);
      value = event.kind === "assignment" &&
          previous?.kind === "option-object"
        ? { kind: "invalid-option-reassignment" }
        : classify(
          original.slice(start, expressionEnd(code, start)),
          event.index,
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
  return names;
}

function isKnownType(candidate, names, exportedName) {
  const normalized = candidate.replace(/\s+/g, "");
  return names.has(normalized);
}

function constructorCalls(source, names, exportedName) {
  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const pattern =
    /\bnew\s+([A-Za-z_$]\w*(?:\s*\.\s*[A-Za-z_$]\w*)?)\s*(?:<[^;(){}]+>)?\s*\(/g;
  const calls = [];

  for (const match of code.matchAll(pattern)) {
    if (!isKnownType(match[1], names, exportedName)) continue;
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

function managedIdentityContext(workspace) {
  const source = workspace.source;
  const credentialTypes = {
    azureCli: typeNames(source, "@azure/identity", "AzureCliCredential"),
    chained: typeNames(source, "@azure/identity", "ChainedTokenCredential"),
    defaultAzure: typeNames(
      source,
      "@azure/identity",
      "DefaultAzureCredential",
    ),
    managedIdentity: typeNames(
      source,
      "@azure/identity",
      "ManagedIdentityCredential",
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
    isValidClientAt: state.isValidClientAt,
    isSecretNameAt: state.isSecretNameAt,
    liveCredentialTypes: state.liveCredentialTypes,
    source,
  };
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
      isSecretNameAt(args, index) && isValidClientAt(clientName, index),
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
          /^\s*\)*\s*\.\s*value\b/.test(
            expression.slice(nestedCall.end),
          )
        );
      })) {
        return true;
      }
    }

    const continuation = code.slice(call.end, call.end + 500);
    const then = continuation.match(
      /^\s*\.\s*then\s*\(\s*(?:async\s*)?\(?\s*(\w+)[^=]*=>\s*/,
    );
    if (
      then &&
      printsBoundValue(
        source,
        then[1],
        call.end + then.index + then[0].length,
      )
    ) {
      return true;
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

function credentialCondition(condition, error, errorNames) {
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
  return errorNames.has(type) ? !negated : null;
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

function hasCredentialDiscrimination(body, error, errorNames) {
  if (!error) return false;
  return ifBlocks(body).some(
    ({ condition }) =>
      credentialCondition(condition, error, errorNames) !== null,
  );
}

function usefulCredentialBranch(body, error, errorNames) {
  if (!error) return false;
  const escaped = escapeRegExp(error);
  const useful = (branch) =>
    new RegExp(
      `\\bconsole\\s*\\.\\s*(?:error|warn|log)\\s*\\([\\s\\S]{0,300}?\\b${escaped}(?:\\s*\\.\\s*(?:message|name|stack))?\\b`,
    ).test(maskSource(branch, true)) ||
    typeScriptHandlerAlwaysCausal(branch, error, errorNames);

  return ifBlocks(body).some((block) => {
    const positive = credentialCondition(
      block.condition,
      error,
      errorNames,
    );
    if (positive === null) return false;
    const matchingBranch = positive
      ? block.consequent
      : block.alternate ?? body.slice(block.end);
    return useful(matchingBranch);
  });
}

function handlesCredentialUnavailableError(
  source,
  clientCandidates,
  credentialCandidates,
  credentialTypeAt,
  isValidClientAt,
) {
  const errorNames = typeNames(
    source,
    "@azure/identity",
    "CredentialUnavailableError",
  );
  if (errorNames.size === 0) return false;

  const catches = tryCatchBlocks(source);
  if (
    catches.some(({ body, error }) => {
      const discriminates = hasCredentialDiscrimination(
        body,
        error,
        errorNames,
      );
      return !typeScriptHandlerAlwaysCausal(
        body,
        error,
        errorNames,
        discriminates ? false : null,
      );
    })
  ) {
    return false;
  }

  return catches.some(({
    body,
    error,
    tryBody,
    tryStart,
  }) => {
    const tryCode = maskSource(tryBody, true);
    const handlesClientOperation = [...clientCandidates].some((name) =>
      methodCalls(tryBody, name, "getSecret").some(
        ({ arguments: args, index }) =>
          args.trim() !== "" &&
          isValidClientAt(name, tryStart + index) &&
          /\bawait\s+(?:\(\s*)*$/.test(tryCode.slice(0, index)),
      ),
    );
    const handlesManagedIdentityOperation = [...credentialCandidates].some(
      (name) =>
        methodCalls(tryBody, name, "getToken").some(
          ({ arguments: args, index }) =>
            args.trim() !== "" &&
            ["managed-system", "managed-user"].includes(
              credentialTypeAt(name, tryStart + index),
            ) &&
            /\bawait\s+(?:\(\s*)*$/.test(tryCode.slice(0, index)),
        ),
    );
    if (!handlesClientOperation && !handlesManagedIdentityOperation) {
      return false;
    }
    return (
      hasCredentialDiscrimination(body, error, errorNames) &&
      usefulCredentialBranch(body, error, errorNames)
    );
  });
}

function loggingLevelConstants(source) {
  const levels = new Map();
  const commentsMasked = maskSource(source, false);
  const code = maskSource(source, true);
  const pattern =
    /\bconst\s+(\w+)(?:\s*:\s*[^=;]+)?\s*=\s*["'](verbose|info|warning|error)["']\s*;/g;
  for (const match of commentsMasked.matchAll(pattern)) {
    if (code[match.index] === "c") levels.set(match[1], match[2]);
  }
  return levels;
}

function configuresIdentityDiagnostics(source) {
  const imports = importBindings(source, "@azure/logger");
  const callNames = new Set();
  const direct = imports.named.get("setLogLevel");
  if (direct) callNames.add(direct);
  for (const namespace of imports.namespaces) {
    callNames.add(`${namespace}.setLogLevel`);
  }
  if (callNames.size === 0) return false;

  const code = maskSource(source, true);
  const original = maskSource(source, false);
  const levels = loggingLevelConstants(source);

  for (const callName of callNames) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(callName)}\\s*\\(`,
      "g",
    );
    for (const match of code.matchAll(pattern)) {
      const openingIndex = match.index + match[0].lastIndexOf("(");
      const argument = balancedText(original, openingIndex).trim();
      if (
        /^["'](?:verbose|info|warning|error)["']$/.test(argument) ||
        levels.has(argument)
      ) {
        return true;
      }
    }
  }
  return false;
}

const rules = {
  "prompt/identity-packages": (workspace) => {
    if (!hasSource(workspace)) return false;
    const dependencies = packageDependencies(workspace.packageJson);
    const importsIdentity =
      importBindings(workspace.source, "@azure/identity").named.size > 0 ||
      importBindings(workspace.source, "@azure/identity").namespaces.size > 0;
    const importsSecretClient =
      typeNames(
        workspace.source,
        "@azure/keyvault-secrets",
        "SecretClient",
      ).size > 0;
    return (
      importsIdentity &&
      importsSecretClient &&
      ["@azure/identity", "@azure/keyvault-secrets"].every(
        (name) => typeof dependencies[name] === "string",
      )
    );
  },
  "prompt/system-assigned-credential": (workspace) =>
    hasSource(workspace) &&
    managedIdentityContext(workspace).createdCredentialTypes.has(
      "managed-system",
    ),
  "prompt/user-assigned-credential": (workspace) =>
    hasSource(workspace) &&
    managedIdentityContext(workspace).createdCredentialTypes.has(
      "managed-user",
    ),
  "prompt/default-azure-credential": (workspace) =>
    hasSource(workspace) &&
    managedIdentityContext(workspace).createdCredentialTypes.has(
      "default-managed",
    ),
  "prompt/local-fallback-chain": (workspace) => {
    if (!hasSource(workspace)) return false;
    const context = managedIdentityContext(workspace);
    return (
      context.liveCredentialTypes.has("managed-cli-chain") ||
      context.associatedClients.some(
        ({ credentialType }) =>
          credentialType === "managed-cli-chain",
      )
    );
  },
  "prompt/credential-client-association": (workspace) =>
    hasSource(workspace) &&
    managedIdentityContext(workspace).associatedClients.length > 0,
  "prompt/authenticated-operation": (workspace) => {
    if (!hasSource(workspace)) return false;
    const {
      clientCandidates,
      isSecretNameAt,
      isValidClientAt,
      source,
    } = managedIdentityContext(workspace);
    return [...clientCandidates].some((name) =>
      methodCalls(source, name, "getSecret").some(
        ({ arguments: args, index }) =>
          isSecretNameAt(args, index) &&
          isValidClientAt(name, index) &&
          printsSecretResult(
            source,
            name,
            isValidClientAt,
            isSecretNameAt,
          ),
      )
    );
  },
  "prompt/credential-unavailable-error": (workspace) => {
    if (!hasSource(workspace)) return false;
    const {
      clientCandidates,
      credentialCandidates,
      credentialTypeAt,
      isValidClientAt,
      source,
    } = managedIdentityContext(workspace);
    return handlesCredentialUnavailableError(
      source,
      clientCandidates,
      credentialCandidates,
      credentialTypeAt,
      isValidClientAt,
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
