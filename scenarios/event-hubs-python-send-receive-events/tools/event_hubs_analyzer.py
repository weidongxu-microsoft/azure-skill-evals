from __future__ import annotations

import ast
import json
import sys
from typing import Any, Iterable


def dotted(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        if parent:
            return f"{parent}.{node.attr}"
    return None


def unwrap(node: ast.AST) -> ast.AST:
    while isinstance(node, ast.Await):
        node = node.value
    return node


def call(node: ast.AST) -> ast.Call | None:
    node = unwrap(node)
    return node if isinstance(node, ast.Call) else None


def assigned_name(target: ast.AST | None) -> str | None:
    return target.id if isinstance(target, ast.Name) else None


def assignment(statement: ast.stmt) -> tuple[str | None, ast.AST | None]:
    if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
        return assigned_name(statement.targets[0]), statement.value
    if isinstance(statement, ast.AnnAssign):
        return assigned_name(statement.target), statement.value
    return None, None


def constant_bool(node: ast.AST) -> bool | None:
    if isinstance(node, ast.Constant):
        return bool(node.value)
    if (
        isinstance(node, ast.Compare)
        and len(node.ops) == 1
        and len(node.comparators) == 1
    ):
        left, right = node.left, node.comparators[0]
        if (
            isinstance(left, ast.Name)
            and left.id == "__name__"
            and isinstance(right, ast.Constant)
            and right.value == "__main__"
        ) or (
            isinstance(right, ast.Name)
            and right.id == "__name__"
            and isinstance(left, ast.Constant)
            and left.value == "__main__"
        ):
            return isinstance(node.ops[0], ast.Eq)
    return None


def live_statements(statements: list[ast.stmt]) -> Iterable[ast.stmt]:
    for statement in statements:
        yield statement
        if isinstance(statement, ast.If):
            decision = constant_bool(statement.test)
            branches = (
                [statement.body]
                if decision is True
                else [statement.orelse]
                if decision is False
                else [statement.body, statement.orelse]
            )
            for branch in branches:
                yield from live_statements(branch)
        elif isinstance(statement, (ast.For, ast.AsyncFor)):
            yield from live_statements(statement.body)
            yield from live_statements(statement.orelse)
        elif isinstance(statement, ast.While):
            if constant_bool(statement.test) is not False:
                yield from live_statements(statement.body)
                yield from live_statements(statement.orelse)
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            yield from live_statements(statement.body)
        elif isinstance(statement, ast.Try):
            yield from live_statements(statement.body)
            for handler in statement.handlers:
                yield from live_statements(handler.body)
            yield from live_statements(statement.orelse)
            yield from live_statements(statement.finalbody)
        if isinstance(statement, (ast.Return, ast.Raise, ast.Break, ast.Continue)):
            break


class CallCollector(ast.NodeVisitor):
    def __init__(self) -> None:
        self.calls: list[ast.Call] = []

    def visit_Call(self, node: ast.Call) -> None:
        self.calls.append(node)
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        return

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        return

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        return

    def visit_If(self, node: ast.If) -> None:
        self.visit(node.test)

    def visit_For(self, node: ast.For) -> None:
        self.visit(node.iter)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self.visit(node.iter)

    def visit_While(self, node: ast.While) -> None:
        self.visit(node.test)

    def visit_With(self, node: ast.With) -> None:
        for item in node.items:
            self.visit(item.context_expr)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        for item in node.items:
            self.visit(item.context_expr)

    def visit_Try(self, node: ast.Try) -> None:
        return


def calls_in(statement: ast.stmt) -> list[ast.Call]:
    collector = CallCollector()
    collector.visit(statement)
    return collector.calls


def integer_value(node: ast.AST, constants: dict[str, int]) -> int | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, int):
        return node.value
    if isinstance(node, ast.Name):
        return constants.get(node.id)
    if isinstance(node, ast.UnaryOp):
        value = integer_value(node.operand, constants)
        if value is None:
            return None
        if isinstance(node.op, ast.UAdd):
            return value
        if isinstance(node.op, ast.USub):
            return -value
        return None
    if isinstance(node, ast.BinOp):
        left = integer_value(node.left, constants)
        right = integer_value(node.right, constants)
        if left is None or right is None:
            return None
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.FloorDiv) and right != 0:
            return left // right
    return None


def range_length(node: ast.AST, constants: dict[str, int]) -> int | None:
    invocation = call(node)
    if invocation is None or dotted(invocation.func) != "range":
        return None
    values = [integer_value(argument, constants) for argument in invocation.args]
    if not values or len(values) > 3 or any(value is None for value in values):
        return None
    resolved = [int(value) for value in values if value is not None]
    if len(resolved) == 1:
        start, stop, step = 0, resolved[0], 1
    elif len(resolved) == 2:
        start, stop, step = resolved[0], resolved[1], 1
    else:
        start, stop, step = resolved
    if step == 0:
        return None
    return len(range(start, stop, step))


def terminal_name(node: ast.AST | None) -> str | None:
    name = dotted(node)
    return name.rsplit(".", 1)[-1] if name else None


def constructor_call(node: ast.AST | None, class_name: str) -> ast.Call | None:
    invocation = call(node) if node is not None else None
    if invocation is None:
        return None
    target = dotted(invocation.func)
    if target and target.endswith(".from_connection_string"):
        target = target.removesuffix(".from_connection_string")
    return invocation if target and target.rsplit(".", 1)[-1] == class_name else None


def expression_contains_name(node: ast.AST, names: set[str]) -> bool:
    return any(isinstance(child, ast.Name) and child.id in names for child in ast.walk(node))


def event_constructor_is_valid(invocation: ast.Call) -> bool:
    if any(keyword.arg != "body" for keyword in invocation.keywords):
        return False
    return bool(invocation.args) or any(
        keyword.arg == "body" for keyword in invocation.keywords
    )


def property_operation(
    statement: ast.stmt,
    event_name: str,
) -> bool:
    if isinstance(statement, (ast.Assign, ast.AnnAssign)):
        targets = (
            statement.targets
            if isinstance(statement, ast.Assign)
            else [statement.target]
        )
        value = statement.value
        for target in targets:
            if (
                isinstance(target, ast.Attribute)
                and isinstance(target.value, ast.Name)
                and target.value.id == event_name
                and target.attr == "properties"
                and isinstance(value, ast.Dict)
                and bool(value.keys)
            ):
                return True
            if (
                isinstance(target, ast.Subscript)
                and isinstance(target.value, ast.Attribute)
                and isinstance(target.value.value, ast.Name)
                and target.value.value.id == event_name
                and target.value.attr == "properties"
            ):
                return True
    invocation = call(statement.value) if isinstance(statement, ast.Expr) else None
    return bool(
        invocation
        and isinstance(invocation.func, ast.Attribute)
        and invocation.func.attr == "update"
        and isinstance(invocation.func.value, ast.Attribute)
        and isinstance(invocation.func.value.value, ast.Name)
        and invocation.func.value.value.id == event_name
        and invocation.func.value.attr == "properties"
        and invocation.args
        and not (
            isinstance(invocation.args[0], ast.Dict)
            and not invocation.args[0].keys
        )
    )


def direct_loop_statements(statements: list[ast.stmt]) -> list[ast.stmt]:
    result = []
    for statement in statements:
        result.append(statement)
        if isinstance(statement, (ast.With, ast.AsyncWith)):
            result.extend(direct_loop_statements(statement.body))
        elif isinstance(statement, ast.Try):
            result.extend(direct_loop_statements(statement.body))
    return result


def has_ten_event_batch(
    scopes: list[tuple[str, list[ast.stmt]]],
    module_constants: dict[str, int],
) -> bool:
    for _scope, statements in scopes:
        constants = dict(module_constants)
        producers: set[str] = set()
        batches: set[str] = set()
        for statement in live_statements(statements):
            name, value = assignment(statement)
            if name and value is not None:
                resolved = integer_value(value, constants)
                if resolved is not None:
                    constants[name] = resolved
                if constructor_call(value, "EventHubProducerClient"):
                    producers.add(name)
                invocation = call(value)
                if (
                    invocation
                    and isinstance(invocation.func, ast.Attribute)
                    and invocation.func.attr == "create_batch"
                    and dotted(invocation.func.value) in producers
                ):
                    batches.add(name)
            if isinstance(statement, (ast.With, ast.AsyncWith)):
                for item in statement.items:
                    producer_name = assigned_name(item.optional_vars)
                    if producer_name and constructor_call(
                        item.context_expr,
                        "EventHubProducerClient",
                    ):
                        producers.add(producer_name)
            if not isinstance(statement, (ast.For, ast.AsyncFor)):
                continue
            if range_length(statement.iter, constants) != 10:
                continue
            body = direct_loop_statements(statement.body)
            for event_statement in body:
                event_name, event_value = assignment(event_statement)
                event_call = constructor_call(event_value, "EventData")
                if (
                    not event_name
                    or event_call is None
                    or not event_constructor_is_valid(event_call)
                ):
                    continue
                event_order = (event_statement.lineno, event_statement.col_offset)
                for property_statement in body:
                    property_order = (
                        property_statement.lineno,
                        property_statement.col_offset,
                    )
                    if (
                        property_order <= event_order
                        or not property_operation(property_statement, event_name)
                    ):
                        continue
                    for add_statement in body:
                        add_order = (add_statement.lineno, add_statement.col_offset)
                        invocation = (
                            call(add_statement.value)
                            if isinstance(add_statement, ast.Expr)
                            else None
                        )
                        if (
                            add_order > property_order
                            and invocation
                            and isinstance(invocation.func, ast.Attribute)
                            and invocation.func.attr == "add"
                            and dotted(invocation.func.value) in batches
                            and invocation.args
                            and isinstance(invocation.args[0], ast.Name)
                            and invocation.args[0].id == event_name
                        ):
                            return True
    return False


def callback_parameters(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda) -> list[str]:
    return [
        argument.arg
        for argument in [
            *node.args.posonlyargs,
            *node.args.args,
            *node.args.kwonlyargs,
        ]
    ]


def callback_body(node: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda) -> list[ast.stmt]:
    if isinstance(node, ast.Lambda):
        return [ast.Expr(value=node.body)]
    return node.body


def callback_node(
    expression: ast.AST | None,
    functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef],
) -> ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda | None:
    expression = unwrap(expression) if expression is not None else None
    if isinstance(expression, ast.Name):
        return functions.get(expression.id)
    return expression if isinstance(expression, ast.Lambda) else None


def handler_prints_body(
    handler: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda | None,
    is_batch: bool,
) -> bool:
    if handler is None:
        return False
    parameters = callback_parameters(handler)
    if len(parameters) < 2:
        return False
    event_names = {parameters[1]}
    derived_names: set[str] = set()
    statements = list(live_statements(callback_body(handler)))
    if is_batch:
        for statement in statements:
            if (
                isinstance(statement, (ast.For, ast.AsyncFor))
                and isinstance(statement.target, ast.Name)
                and isinstance(statement.iter, ast.Name)
                and statement.iter.id == parameters[1]
            ):
                event_names.add(statement.target.id)
    for statement in statements:
        name, value = assignment(statement)
        if name and value is not None and any(
            isinstance(child, ast.Attribute)
            and child.attr in {"body", "body_as_str"}
            and isinstance(child.value, ast.Name)
            and child.value.id in event_names
            for child in ast.walk(value)
        ):
            derived_names.add(name)
        for invocation in calls_in(statement):
            if terminal_name(invocation.func) != "print":
                continue
            for argument in [*invocation.args, *(kw.value for kw in invocation.keywords)]:
                if expression_contains_name(argument, derived_names) or any(
                    isinstance(child, ast.Attribute)
                    and child.attr in {"body", "body_as_str"}
                    and isinstance(child.value, ast.Name)
                    and child.value.id in event_names
                    for child in ast.walk(argument)
                ):
                    return True
    return False


def handler_prints_error(
    handler: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda | None,
) -> bool:
    if handler is None:
        return False
    parameters = callback_parameters(handler)
    if len(parameters) < 2:
        return False
    error_name = parameters[-1]
    for statement in live_statements(callback_body(handler)):
        for invocation in calls_in(statement):
            if terminal_name(invocation.func) != "print":
                continue
            if any(
                expression_contains_name(
                    argument,
                    {error_name},
                )
                for argument in [
                    *invocation.args,
                    *(keyword.value for keyword in invocation.keywords),
                ]
            ):
                return True
    return False


def keyword_or_position(
    invocation: ast.Call,
    name: str,
    position: int,
) -> ast.AST | None:
    for keyword in invocation.keywords:
        if keyword.arg == name:
            return keyword.value
    return invocation.args[position] if len(invocation.args) > position else None


def has_receive_handlers(
    scopes: list[tuple[str, list[ast.stmt]]],
    functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef],
) -> bool:
    for _scope, statements in scopes:
        lexical_functions = dict(functions)
        lexical_functions.update(
            {
                statement.name: statement
                for statement in live_statements(statements)
                if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
        )
        consumers: set[str] = set()
        for statement in live_statements(statements):
            name, value = assignment(statement)
            if name and constructor_call(value, "EventHubConsumerClient"):
                consumers.add(name)
            if isinstance(statement, (ast.With, ast.AsyncWith)):
                for item in statement.items:
                    consumer_name = assigned_name(item.optional_vars)
                    if consumer_name and constructor_call(
                        item.context_expr,
                        "EventHubConsumerClient",
                    ):
                        consumers.add(consumer_name)
            for invocation in calls_in(statement):
                if not isinstance(invocation.func, ast.Attribute):
                    continue
                method = invocation.func.attr
                if method not in {"receive", "receive_batch"}:
                    continue
                if dotted(invocation.func.value) not in consumers:
                    continue
                event_expression = keyword_or_position(
                    invocation,
                    "on_event_batch" if method == "receive_batch" else "on_event",
                    0,
                )
                error_expression = keyword_or_position(invocation, "on_error", 1)
                if handler_prints_body(
                    callback_node(event_expression, lexical_functions),
                    method == "receive_batch",
                ) and handler_prints_error(
                    callback_node(error_expression, lexical_functions)
                ):
                    return True
    return False


def reachable_scopes(
    tree: ast.Module,
    functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef],
) -> list[tuple[str, list[ast.stmt]]]:
    scopes = [("<module>", tree.body)]
    queued = {"<module>"}
    index = 0
    while index < len(scopes):
        _name, statements = scopes[index]
        index += 1
        for statement in live_statements(statements):
            for invocation in calls_in(statement):
                target = terminal_name(invocation.func)
                if target in functions and target not in queued:
                    queued.add(target)
                    scopes.append((target, functions[target].body))
    return scopes


def analyze(source: str) -> dict[str, bool]:
    result = {"event_batch": False, "receive_handlers": False}
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return result
    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    module_constants: dict[str, int] = {}
    for statement in tree.body:
        name, value = assignment(statement)
        if name and value is not None:
            resolved = integer_value(value, module_constants)
            if resolved is not None:
                module_constants[name] = resolved
    scopes = reachable_scopes(tree, functions)
    result["event_batch"] = has_ten_event_batch(scopes, module_constants)
    result["receive_handlers"] = has_receive_handlers(scopes, functions)
    return result


request: dict[str, Any] = json.load(sys.stdin)
print(json.dumps(analyze(str(request.get("source", "")))))
