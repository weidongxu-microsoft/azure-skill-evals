from __future__ import annotations

import ast
import json
import re
import sys
from dataclasses import dataclass
from typing import Any


PINS = {
    "azure-identity": "1.25.3",
    "azure-servicebus": "7.14.3",
}


def active_statements(statements: list[ast.stmt]) -> list[ast.stmt]:
    active: list[ast.stmt] = []
    for statement in statements:
        if isinstance(statement, ast.If) and isinstance(statement.test, ast.Constant):
            branch = statement.body if statement.test.value else statement.orelse
            active.extend(active_statements(branch))
        elif isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant):
            continue
        else:
            active.append(statement)
    return active


class ActiveCopy(ast.NodeTransformer):
    def visit_If(self, node: ast.If) -> Any:
        if isinstance(node.test, ast.Constant):
            selected = node.body if node.test.value else node.orelse
            return [self.visit(statement) for statement in selected]
        return self.generic_visit(node)

    def visit_Expr(self, node: ast.Expr) -> Any:
        if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            return None
        return self.generic_visit(node)


def active_node(node: ast.AST) -> ast.AST:
    value = ActiveCopy().visit(ast.fix_missing_locations(ast.parse(ast.unparse(node))))
    return ast.fix_missing_locations(value)


def call_name(call: ast.Call) -> str:
    function = call.func
    if isinstance(function, ast.Name):
        return function.id
    if isinstance(function, ast.Attribute):
        return function.attr
    return ""


def calls_in(node: ast.AST) -> set[str]:
    return {
        call_name(candidate)
        for candidate in ast.walk(active_node(node))
        if isinstance(candidate, ast.Call) and call_name(candidate)
    }


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
    return None


@dataclass
class Function:
    name: str
    node: ast.FunctionDef | ast.AsyncFunctionDef
    asynchronous: bool
    owner: str | None = None


class Program:
    def __init__(self, documents: list[dict[str, str]]) -> None:
        self.valid = True
        self.modules: list[ast.Module] = []
        self.constants: dict[str, int] = {}
        self.functions: list[Function] = []
        self.classes: list[ast.ClassDef] = []
        for document in documents:
            try:
                module = ast.parse(document.get("source", ""))
            except SyntaxError:
                self.valid = False
                continue
            self.modules.append(module)
            for statement in module.body:
                if (
                    isinstance(statement, (ast.Assign, ast.AnnAssign))
                    and statement.value is not None
                ):
                    targets = (
                        statement.targets
                        if isinstance(statement, ast.Assign)
                        else [statement.target]
                    )
                    value = integer_value(statement.value, self.constants)
                    if value is not None:
                        for target in targets:
                            if isinstance(target, ast.Name):
                                self.constants[target.id] = value
            for node in module.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self.functions.append(
                        Function(
                            node.name,
                            node,
                            isinstance(node, ast.AsyncFunctionDef),
                        )
                    )
                elif isinstance(node, ast.ClassDef):
                    self.classes.append(node)
                    for method in node.body:
                        if isinstance(
                            method,
                            (ast.FunctionDef, ast.AsyncFunctionDef),
                        ):
                            self.functions.append(
                                Function(
                                    method.name,
                                    method,
                                    isinstance(method, ast.AsyncFunctionDef),
                                    node.name,
                                )
                            )

        self.by_name: dict[str, list[Function]] = {}
        for function in self.functions:
            self.by_name.setdefault(function.name, []).append(function)
        self.roots = self._roots()
        self.reachable = self._reachable()
        self.instantiated_classes = self._instantiated_classes()
        self.reachable_code = "\n".join(
            ast.unparse(active_node(function.node)) for function in self.reachable
        )
        self.all_code = "\n".join(
            ast.unparse(active_node(module)) for module in self.modules
        )

    def _roots(self) -> list[Function]:
        root_names = {"main"}
        for module in self.modules:
            for statement in active_statements(module.body):
                if isinstance(
                    statement,
                    (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
                ):
                    continue
                for node in ast.walk(statement):
                    if isinstance(node, ast.Call):
                        name = call_name(node)
                        if name in self.by_name:
                            root_names.add(name)
                        if name == "run" and node.args and isinstance(node.args[0], ast.Call):
                            root_names.add(call_name(node.args[0]))
        return [
            function
            for name in root_names
            for function in self.by_name.get(name, [])
        ]

    def _reachable(self) -> list[Function]:
        pending = list(self.roots)
        found: list[Function] = []
        seen: set[int] = set()
        while pending:
            function = pending.pop()
            marker = id(function.node)
            if marker in seen:
                continue
            seen.add(marker)
            found.append(function)
            for name in calls_in(function.node):
                pending.extend(self.by_name.get(name, []))
        return found

    def _instantiated_classes(self) -> set[str]:
        class_names = {class_node.name for class_node in self.classes}
        connected: set[str] = set()
        changed = True
        while changed:
            changed = False
            candidate_functions = [
                *self.reachable,
                *[
                    function
                    for function in self.functions
                    if function.owner in connected
                ],
            ]
            for function in candidate_functions:
                for node in ast.walk(active_node(function.node)):
                    if not isinstance(node, ast.Call):
                        continue
                    name = call_name(node)
                    if name in class_names and name not in connected:
                        connected.add(name)
                        changed = True
        return connected

    def implemented_methods(self, asynchronous: bool) -> list[Function]:
        return [
            function
            for function in self.functions
            if function.asynchronous == asynchronous
            and function.owner in self.instantiated_classes
            and not function.name.startswith("_")
        ]

    def closure(self, function: Function) -> list[Function]:
        pending = [function]
        found: list[Function] = []
        seen: set[int] = set()
        while pending:
            current = pending.pop()
            marker = id(current.node)
            if marker in seen:
                continue
            seen.add(marker)
            found.append(current)
            for name in calls_in(current.node):
                pending.extend(self.by_name.get(name, []))
        return found

    def code_for(self, function: Function) -> str:
        return "\n".join(
            ast.unparse(active_node(candidate.node))
            for candidate in self.closure(function)
        )


def exact_dependencies(manifests: list[dict[str, str]]) -> bool:
    found: dict[str, str] = {}
    for manifest in manifests:
        filename = manifest.get("filename", "").lower()
        content = manifest.get("content", "")
        if filename.startswith("requirements"):
            for line in content.splitlines():
                active = line.split("#", 1)[0].strip()
                match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)", active)
                if match:
                    found[match.group(1).lower()] = match.group(2)
        elif filename == "pyproject.toml":
            for package, version in PINS.items():
                if re.search(
                    rf'["\']?{re.escape(package)}["\']?\s*=\s*["\']=={re.escape(version)}["\']',
                    content,
                    re.IGNORECASE,
                ):
                    found[package] = version
        elif filename == "setup.py":
            for package, version in PINS.items():
                if f"{package}=={version}" in content:
                    found[package] = version
    return all(found.get(package) == version for package, version in PINS.items())


def order_model(program: Program) -> bool:
    fields = {
        "order_id",
        "customer_name",
        "product",
        "quantity",
        "total_price",
        "status",
    }
    for class_node in program.classes:
        class_fields = {
            node.target.id
            for node in class_node.body
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
        }
        methods = {
            node.name: ast.unparse(active_node(node))
            for node in class_node.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        class_code = ast.unparse(active_node(class_node))
        if (
            fields <= class_fields
            and any(name in methods for name in ("to_json", "serialize", "model_dump_json"))
            and any(name in methods for name in ("from_json", "deserialize", "model_validate_json"))
            and "json.dumps" in class_code
            and "json.loads" in class_code
        ):
            statuses = {"pending", "processing", "completed", "failed"}
            constructed = bool(
                re.search(rf"\b{re.escape(class_node.name)}\s*\(", program.reachable_code)
            )
            return constructed and all(
                status in program.all_code.lower() for status in statuses
            )
    return False


def assigned_expressions(node: ast.AST) -> dict[str, ast.AST]:
    result: dict[str, ast.AST] = {}
    for candidate in ast.walk(node):
        if isinstance(candidate, ast.Assign) and len(candidate.targets) == 1:
            if isinstance(candidate.targets[0], ast.Name):
                result[candidate.targets[0].id] = candidate.value
        elif (
            isinstance(candidate, ast.AnnAssign)
            and isinstance(candidate.target, ast.Name)
            and candidate.value is not None
        ):
            result[candidate.target.id] = candidate.value
    return result


def resolved_nodes(
    node: ast.AST,
    assignments: dict[str, ast.AST],
    visited: set[str] | None = None,
) -> list[ast.AST]:
    visited = visited or set()
    result = [node]
    for child in ast.walk(node):
        if (
            isinstance(child, ast.Name)
            and child.id in assignments
            and child.id not in visited
        ):
            result.extend(
                resolved_nodes(
                    assignments[child.id],
                    assignments,
                    {*visited, child.id},
                )
            )
    return result


def attribute_root(node: ast.AST, attribute: str) -> str | None:
    if (
        isinstance(node, ast.Attribute)
        and node.attr == attribute
        and isinstance(node.value, ast.Name)
    ):
        return node.value.id
    return None


def message_metadata(program: Program, function: Function) -> bool:
    for candidate in program.closure(function):
        active = active_node(candidate.node)
        assignments = assigned_expressions(active)
        for invocation in (
            node
            for node in ast.walk(active)
            if isinstance(node, ast.Call)
            and call_name(node) == "ServiceBusMessage"
        ):
            keywords = {
                keyword.arg: keyword.value
                for keyword in invocation.keywords
                if keyword.arg
            }
            expanded = [
                keyword.value
                for keyword in invocation.keywords
                if keyword.arg is None
                and isinstance(keyword.value, ast.Name)
                and isinstance(assignments.get(keyword.value.id), ast.Dict)
            ]
            if expanded:
                argument_dict = assignments[expanded[0].id]
                assert isinstance(argument_dict, ast.Dict)
                keywords.update(
                    {
                        key.value: value
                        for key, value in zip(
                            argument_dict.keys,
                            argument_dict.values,
                        )
                        if isinstance(key, ast.Constant)
                        and isinstance(key.value, str)
                    }
                )
            correlation = attribute_root(
                keywords.get("correlation_id", ast.Constant(None)),
                "order_id",
            )
            session = attribute_root(
                keywords.get("session_id", ast.Constant(None)),
                "customer_name",
            )
            if correlation is None or correlation != session:
                continue

            scheduled = keywords.get("scheduled_enqueue_time_utc")
            properties = keywords.get("application_properties")
            if properties is None:
                continue
            scheduled_nodes = (
                resolved_nodes(scheduled, assignments)
                if scheduled is not None
                else [
                    assignment.value
                    for assignment in ast.walk(active)
                    if isinstance(assignment, ast.Assign)
                    and len(assignment.targets) == 1
                    and isinstance(assignment.targets[0], ast.Subscript)
                    and isinstance(assignment.targets[0].value, ast.Name)
                    and expanded
                    and assignment.targets[0].value.id
                    == expanded[0].id
                    and isinstance(
                        assignment.targets[0].slice,
                        ast.Constant,
                    )
                    and assignment.targets[0].slice.value
                    == "scheduled_enqueue_time_utc"
                ]
            )
            property_nodes = resolved_nodes(properties, assignments)
            has_delay = any(
                isinstance(node, ast.Call)
                and call_name(node) == "timedelta"
                and any(
                    keyword.arg == "seconds"
                    and integer_value(keyword.value, program.constants) == 30
                    for keyword in node.keywords
                )
                for resolved in scheduled_nodes
                for node in ast.walk(resolved)
            )
            has_high_priority = any(
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and node.value.lower() == "high"
                for resolved in property_nodes
                for node in ast.walk(resolved)
            ) or any(
                isinstance(assignment, ast.Assign)
                and len(assignment.targets) == 1
                and isinstance(assignment.targets[0], ast.Subscript)
                and isinstance(assignment.targets[0].value, ast.Name)
                and isinstance(properties, ast.Name)
                and assignment.targets[0].value.id == properties.id
                and isinstance(assignment.value, ast.Constant)
                and assignment.value.value == "high"
                for assignment in ast.walk(active)
            )
            depends_on_total = any(
                isinstance(node, ast.Attribute)
                and node.attr == "total_price"
                and isinstance(node.value, ast.Name)
                and node.value.id == correlation
                for resolved in property_nodes
                for node in ast.walk(resolved)
            ) or any(
                isinstance(node, ast.Attribute)
                and node.attr == "total_price"
                and isinstance(node.value, ast.Name)
                and node.value.id == correlation
                for node in ast.walk(active)
            )
            if has_delay and has_high_priority and depends_on_total:
                return True
    return False


def sender_rule(program: Program, asynchronous: bool) -> bool:
    candidates = list(
        {
            id(function.node): function
            for function in [
                *program.reachable,
                *program.implemented_methods(asynchronous),
            ]
            if function.asynchronous == asynchronous
        }.values()
    )
    single = False
    batch = False
    for function in candidates:
        code = program.code_for(function)
        own = ast.unparse(active_node(function.node))
        if (
            "get_queue_sender" in code
            and "send_messages" in code
            and "ServiceBusMessage" in code
            and message_metadata(program, function)
        ):
            awaited = not asynchronous or bool(
                re.search(r"\bawait\s+[^\n]*send_messages\s*\(", code)
            )
            if awaited and "create_message_batch" not in own:
                single = True
            if (
                awaited
                and "create_message_batch" in own
                and "add_message" in own
                and own.count("create_message_batch") >= 2
                and own.count("add_message") >= 2
                and own.count("send_messages") >= 2
                and (
                    "MessageSizeExceededError" in own
                    or re.search(r"\btry\s*:", own)
                    or re.search(r"\bif\s+not\s+[^:\n]*add_message", own)
                )
            ):
                created = re.search(
                    r"\b(\w+)\s*=\s*(?:await\s+)?(\w+)\.create_message_batch\s*\(",
                    own,
                )
                if created:
                    batch_name, sender_name = created.groups()
                    add_positions = [
                        match.start()
                        for match in re.finditer(
                            rf"\b{batch_name}\.add_message\s*\(", own
                        )
                    ]
                    send_positions = [
                        match.start()
                        for match in re.finditer(
                            rf"\b{sender_name}\.send_messages\s*\(\s*{batch_name}\s*\)",
                            own,
                        )
                    ]
                    create_positions = [
                        match.start()
                        for match in re.finditer(
                            rf"\b{batch_name}\s*=\s*(?:await\s+)?{sender_name}\.create_message_batch",
                            own,
                        )
                    ]
                    batch = (
                        len(add_positions) >= 2
                        and len(send_positions) >= 2
                        and len(create_positions) >= 2
                        and min(add_positions) < min(send_positions)
                        and min(send_positions) < max(create_positions)
                        and max(create_positions) < max(add_positions)
                    )
    if asynchronous:
        return (
            single
            and batch
            and "azure.servicebus.aio" in program.all_code
            and "async with" in program.reachable_code
        )
    return single and batch and "with " in program.reachable_code


TRANSIENT_EXCEPTIONS = {
    "ServiceBusCommunicationError",
    "ServiceBusConnectionError",
    "ServiceBusServerBusyError",
}


def function_parameters(function: Function) -> list[str]:
    return [
        argument.arg
        for argument in [
            *function.node.args.posonlyargs,
            *function.node.args.args,
            *function.node.args.kwonlyargs,
        ]
        if argument.arg != "self"
    ]


def transient_expression(
    node: ast.AST,
    exception_name: str,
    program: Program,
    visited: set[int] | None = None,
) -> bool:
    visited = visited or set()
    if (
        isinstance(node, ast.Attribute)
        and node.attr == "is_transient"
        and isinstance(node.value, ast.Name)
        and node.value.id == exception_name
    ):
        return True
    if isinstance(node, (ast.BoolOp, ast.UnaryOp)):
        return any(
            transient_expression(child, exception_name, program, visited)
            for child in ast.iter_child_nodes(node)
        )
    if not isinstance(node, ast.Call):
        return False
    name = call_name(node)
    if (
        name == "getattr"
        and len(node.args) >= 3
        and isinstance(node.args[0], ast.Name)
        and node.args[0].id == exception_name
        and isinstance(node.args[1], ast.Constant)
        and node.args[1].value == "is_transient"
        and isinstance(node.args[2], ast.Constant)
        and node.args[2].value is False
    ):
        return True
    if (
        name == "isinstance"
        and len(node.args) == 2
        and isinstance(node.args[0], ast.Name)
        and node.args[0].id == exception_name
        and any(
            isinstance(child, ast.Name)
            and child.id in TRANSIENT_EXCEPTIONS
            for child in ast.walk(node.args[1])
        )
    ):
        return True
    if name == "bool" and len(node.args) == 1:
        return transient_expression(node.args[0], exception_name, program, visited)
    for helper in program.by_name.get(name, []):
        marker = id(helper.node)
        parameters = function_parameters(helper)
        if marker in visited or not parameters or not node.args:
            continue
        if not (
            isinstance(node.args[0], ast.Name)
            and node.args[0].id == exception_name
        ):
            continue
        if any(
            transient_expression(
                returned.value,
                parameters[0],
                program,
                {*visited, marker},
            )
            for returned in ast.walk(active_node(helper.node))
            if isinstance(returned, ast.Return)
            and returned.value is not None
        ):
            return True
    return False


def has_transient_classification(program: Program, function: Function) -> bool:
    for handler in (
        node
        for node in ast.walk(active_node(function.node))
        if isinstance(node, ast.ExceptHandler)
        and node.name
        and isinstance(node.type, ast.Name)
        and node.type.id == "ServiceBusError"
    ):
        if any(
            transient_expression(test.test, handler.name, program)
            for test in ast.walk(handler)
            if isinstance(test, ast.If)
        ):
            return True
    return False


def expression_uses_message(
    node: ast.AST,
    message_name: str,
    program: Program,
    visited: set[int] | None = None,
) -> bool:
    visited = visited or set()
    if isinstance(node, ast.Name):
        return node.id == message_name
    if (
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == message_name
        and node.attr == "body"
    ):
        return True
    if not isinstance(node, ast.Call):
        return any(
            expression_uses_message(child, message_name, program, visited)
            for child in ast.iter_child_nodes(node)
        )
    name = call_name(node)
    if name in {"str", "bytes"} and node.args:
        return expression_uses_message(node.args[0], message_name, program, visited)
    for helper in program.by_name.get(name, []):
        marker = id(helper.node)
        parameters = function_parameters(helper)
        if marker in visited or not parameters or not node.args:
            continue
        if not expression_uses_message(
            node.args[0],
            message_name,
            program,
            visited,
        ):
            continue
        if any(
            isinstance(child, ast.Attribute)
            and isinstance(child.value, ast.Name)
            and child.value.id == parameters[0]
            and child.attr == "body"
            for child in ast.walk(active_node(helper.node))
        ):
            return True
    return False


def loop_deserialization(
    loop: ast.For | ast.AsyncFor,
    program: Program,
) -> tuple[str, int] | None:
    if not isinstance(loop.target, ast.Name):
        return None
    message_name = loop.target.id
    for node in ast.walk(ast.Module(body=loop.body, type_ignores=[])):
        if not isinstance(node, ast.Call) or call_name(node) not in {
            "from_json",
            "loads",
        }:
            continue
        if node.args and expression_uses_message(node.args[0], message_name, program):
            return message_name, node.lineno
    return None


def matching_settlement_calls(
    loop: ast.For | ast.AsyncFor,
    message_name: str,
    asynchronous: bool,
) -> dict[str, list[ast.Call]]:
    body = ast.Module(body=loop.body, type_ignores=[])
    awaited = {
        id(node.value)
        for node in ast.walk(body)
        if isinstance(node, ast.Await)
        and isinstance(node.value, ast.Call)
    }
    result: dict[str, list[ast.Call]] = {
        "complete_message": [],
        "dead_letter_message": [],
        "abandon_message": [],
    }
    for node in ast.walk(body):
        if (
            not isinstance(node, ast.Call)
            or call_name(node) not in result
            or not node.args
            or not isinstance(node.args[0], ast.Name)
            or node.args[0].id != message_name
            or (asynchronous and id(node) not in awaited)
        ):
            continue
        if call_name(node) == "dead_letter_message" and not any(
            keyword.arg == "reason" for keyword in node.keywords
        ):
            continue
        result[call_name(node)].append(node)
    return result


def receiver_loop(
    function: Function,
    program: Program,
    asynchronous: bool,
) -> bool:
    for loop in (
        node
        for node in ast.walk(active_node(function.node))
        if isinstance(node, (ast.For, ast.AsyncFor))
    ):
        deserialization = loop_deserialization(loop, program)
        if deserialization is None:
            continue
        message_name, deserialize_line = deserialization
        settlements = matching_settlement_calls(
            loop,
            message_name,
            asynchronous,
        )
        if (
            settlements["complete_message"]
            and settlements["dead_letter_message"]
            and settlements["abandon_message"]
            and all(
                call.lineno > deserialize_line
                for call in settlements["complete_message"]
            )
        ):
            return True
    return False


def processing_rule(program: Program, asynchronous: bool) -> bool:
    for function in program.reachable:
        if function.asynchronous != asynchronous:
            continue
        code = program.code_for(function)
        own = ast.unparse(active_node(function.node))
        if (
            "get_queue_receiver" in code
            and "session_id" in code
            and "receive_messages" in code
            and "ServiceBusError" in code
            and has_transient_classification(program, function)
            and receiver_loop(function, program, asynchronous)
        ):
            if asynchronous:
                return "async with" in own and "await" in own
            return "with " in own
    return False


def reprocess_function(program: Program, asynchronous: bool) -> bool:
    for function in program.reachable:
        if function.asynchronous != asynchronous:
            continue
        own = ast.unparse(active_node(function.node))
        if (
            "ServiceBusSubQueue.DEAD_LETTER" not in own
            or "get_queue_receiver" not in own
            or "from_json" not in own
        ):
            continue
        for loop in (
            node
            for node in ast.walk(active_node(function.node))
            if isinstance(node, (ast.For, ast.AsyncFor))
        ):
            deserialization = loop_deserialization(loop, program)
            if deserialization is None:
                continue
            message_name, _deserialize_line = deserialization
            order_names = {
                target.id
                for assignment in ast.walk(ast.Module(body=loop.body, type_ignores=[]))
                if isinstance(assignment, (ast.Assign, ast.AnnAssign))
                and assignment.value is not None
                and isinstance(assignment.value, ast.Call)
                and call_name(assignment.value) in {"from_json", "loads"}
                and assignment.value.args
                and expression_uses_message(
                    assignment.value.args[0],
                    message_name,
                    program,
                )
                for target in (
                    assignment.targets
                    if isinstance(assignment, ast.Assign)
                    else [assignment.target]
                )
                if isinstance(target, ast.Name)
            }
            if not order_names:
                continue
            body = ast.Module(body=loop.body, type_ignores=[])
            awaited = {
                id(node.value)
                for node in ast.walk(body)
                if isinstance(node, ast.Await)
                and isinstance(node.value, ast.Call)
            }
            sends = [
                node
                for node in ast.walk(body)
                if isinstance(node, ast.Call)
                and re.search(r"(?:send|publish)", call_name(node), re.IGNORECASE)
                and node.args
                and isinstance(node.args[0], ast.Name)
                and node.args[0].id in order_names
                and (not asynchronous or id(node) in awaited)
            ]
            completes = matching_settlement_calls(
                loop,
                message_name,
                asynchronous,
            )["complete_message"]
            if any(
                send.lineno < complete.lineno
                for send in sends
                for complete in completes
            ):
                return True
    return False


def error_classification(program: Program) -> bool:
    classifiers = []
    for function in program.reachable:
        parameters = function_parameters(function)
        if not parameters:
            continue
        code = ast.unparse(active_node(function.node))
        if (
            re.search(r"(?:entity|queue)", code, re.IGNORECASE)
            and re.search(r"(?:logging|logger|print)\.", code, re.IGNORECASE)
            and re.search(r"(?:error|exception|exc)", code, re.IGNORECASE)
            and any(
                transient_expression(
                    child,
                    parameter,
                    program,
                )
                for parameter in parameters
                for child in ast.walk(active_node(function.node))
            )
        ):
            return True
        if any(
            transient_expression(node.value, parameters[0], program)
            for node in ast.walk(active_node(function.node))
            if isinstance(node, ast.Return) and node.value is not None
        ):
            classifiers.append(function.name)
    if not classifiers:
        return False
    return any(
        re.search(r"(?:entity|queue)", code, re.IGNORECASE)
        and re.search(r"(?:logging|logger|print)\.", code, re.IGNORECASE)
        and re.search(r"(?:error|exception|exc)", code, re.IGNORECASE)
        and any(name in calls_in(function.node) for name in classifiers)
        for function in program.reachable
        for code in [ast.unparse(active_node(function.node))]
    )


def connected_demo(program: Program, state: dict[str, bool]) -> bool:
    if not all(state.values()):
        return False
    mains = [function for function in program.reachable if function.name == "main"]
    async_runs = [
        function
        for function in program.reachable
        if function.asynchronous and re.search(r"(?:run|main)", function.name, re.IGNORECASE)
    ]
    def feature_name(asynchronous: bool, kind: str) -> str | None:
        candidates = [
            *program.implemented_methods(asynchronous),
            *program.reachable,
        ]
        for function in candidates:
            if function.asynchronous != asynchronous:
                continue
            code = program.code_for(function)
            if (
                kind == "single"
                and "send_messages" in code
                and "create_message_batch" not in code
                and "DEAD_LETTER" not in code
            ):
                return function.name
            if kind == "batch" and "create_message_batch" in code:
                return function.name
            if (
                kind == "process"
                and "get_queue_receiver" in code
                and "DEAD_LETTER" not in code
                and "complete_message" in code
            ):
                return function.name
            if kind == "reprocess" and "DEAD_LETTER" in code:
                return function.name
        return None

    sync_names = [
        feature_name(False, kind)
        for kind in ("single", "process", "reprocess")
    ]
    async_names = [
        feature_name(True, kind)
        for kind in ("single", "process", "reprocess")
    ]
    if any(name is None for name in sync_names + async_names):
        return False
    for main in mains:
        code = ast.unparse(active_node(main.node))
        sync_calls = [code.find(f".{name}(") for name in sync_names]
        direct_ready = not (
            "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE" not in code
            or "SERVICE_BUS_QUEUE_NAME" not in code
            or "DefaultAzureCredential" not in code
            or "ServiceBusClient" not in code
            or "with " not in code
            or any(position < 0 for position in sync_calls)
            or sync_calls != sorted(sync_calls)
            or "asyncio.run" not in code
            or code.find("asyncio.run") < sync_calls[-1]
        )
        if direct_ready:
            for async_run in async_runs:
                async_code = ast.unparse(active_node(async_run.node))
                async_calls = [
                    async_code.find(f".{name}(") for name in async_names
                ]
                if (
                    "AsyncServiceBusClient" in program.all_code
                    and "async with" in async_code
                    and all(position >= 0 for position in async_calls)
                    and async_calls == sorted(async_calls)
                    and async_code.count("await ") >= 4
                ):
                    return True

        active_main = active_node(main.node)
        assignments = assigned_expressions(active_main)
        for async_call in (
            node
            for node in ast.walk(active_main)
            if isinstance(node, ast.Call)
            and call_name(node) == "run"
            and node.args
            and isinstance(node.args[0], ast.Call)
        ):
            wrapped_async = async_call.args[0]
            async_targets = [
                function
                for function in program.by_name.get(
                    call_name(wrapped_async),
                    [],
                )
                if function.asynchronous
            ]
            if not async_targets:
                continue
            for sync_call in (
                node
                for node in ast.walk(active_main)
                if isinstance(node, ast.Call)
                and node.lineno < async_call.lineno
                and call_name(node) != "run"
            ):
                sync_targets = [
                    function
                    for function in program.by_name.get(
                        call_name(sync_call),
                        [],
                    )
                    if not function.asynchronous
                    and function.owner is None
                ]
                if not sync_targets:
                    continue
                shared_arguments = {
                    argument.id
                    for argument in sync_call.args
                    if isinstance(argument, ast.Name)
                } & {
                    argument.id
                    for argument in wrapped_async.args
                    if isinstance(argument, ast.Name)
                }
                configured = any(
                    name in assignments
                    and isinstance(assignments[name], ast.Call)
                    for name in shared_arguments
                )
                if not configured:
                    continue
                for sync_target in sync_targets:
                    sync_code = ast.unparse(active_node(sync_target.node))
                    sync_positions = [
                        sync_code.find(f".{name}(")
                        for name in sync_names
                    ]
                    if (
                        any(position < 0 for position in sync_positions)
                        or sync_positions != sorted(sync_positions)
                    ):
                        continue
                    for async_target in async_targets:
                        async_code = ast.unparse(active_node(async_target.node))
                        async_positions = [
                            async_code.find(f".{name}(")
                            for name in async_names
                        ]
                        if (
                            all(position >= 0 for position in async_positions)
                            and async_positions == sorted(async_positions)
                            and async_code.count("await ") >= 3
                        ):
                            return True
    return False


def analyze(payload: dict[str, Any]) -> dict[str, bool]:
    documents = payload.get("documents", [])
    program = Program(documents)
    has_top_level = any("/" not in document.get("path", "") for document in documents)
    valid = program.valid and bool(program.roots) and has_top_level
    state = {
        "model": valid and order_model(program),
        "sync_sender": valid and sender_rule(program, False),
        "async_sender": valid and sender_rule(program, True),
        "sync_processing": valid and processing_rule(program, False),
        "async_processing": valid and processing_rule(program, True),
        "reprocessing": valid
        and reprocess_function(program, False)
        and reprocess_function(program, True),
        "errors": valid and error_classification(program),
    }
    return {
        "prompt/sdk-dependencies": valid
        and exact_dependencies(payload.get("dependencyManifests", [])),
        "prompt/order-model": state["model"],
        "prompt/sync-sender": state["sync_sender"],
        "prompt/async-sender": state["async_sender"],
        "prompt/sync-processing-settlement": state["sync_processing"],
        "prompt/async-processing-settlement": state["async_processing"],
        "prompt/dead-letter-reprocessing": state["reprocessing"],
        "prompt/error-classification": state["errors"],
        "prompt/connected-demo": valid and connected_demo(program, state),
    }


if __name__ == "__main__":
    print(json.dumps(analyze(json.load(sys.stdin))))
