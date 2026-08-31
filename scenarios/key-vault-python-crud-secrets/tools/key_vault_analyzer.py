from __future__ import annotations

import ast
import json
import re
import sys
import tomllib
from dataclasses import dataclass, field
from typing import Any


RESULT_FLAG_PREFIX = "result:"
UNKNOWN = None


@dataclass
class Value:
    kind: str
    data: Any = None
    flags: frozenset[str] = frozenset()


@dataclass
class FunctionInfo:
    node: ast.FunctionDef | ast.AsyncFunctionDef
    closure: dict[str, Value]
    scope: str
    owner: str | None = None


@dataclass
class ClassInfo:
    name: str
    methods: dict[str, FunctionInfo]


@dataclass(frozen=True)
class ClientInfo:
    identifier: int
    is_async: bool


@dataclass
class PendingCall:
    kind: str
    positional: tuple[Value, ...]
    named: dict[str, Value]
    receiver: Value | None = None
    method_name: str | None = None
    function: FunctionInfo | None = None
    consumed: bool = False


@dataclass
class Aggregate:
    members: dict[Any, Value] = field(default_factory=dict)


@dataclass
class Flow:
    environment: dict[str, Value]
    normal: bool = True
    returned: list[Value] = field(default_factory=list)
    guards: frozenset[tuple[int, str]] | None = None


@dataclass
class HandlerInfo:
    node: ast.ExceptHandler
    environment: dict[str, Value]


@dataclass
class TryInfo:
    identifier: int
    scope: str
    handlers: list[HandlerInfo]
    may_throw: bool


@dataclass(frozen=True)
class Operation:
    kind: str
    order: int
    client: int
    name: str
    value: str | None = None
    related: int | None = None
    guards: frozenset[tuple[int, str]] = frozenset()
    try_stack: tuple[int, ...] = ()
    scope: str = ""


def unknown(flags: frozenset[str] = frozenset()) -> Value:
    return Value("unknown", flags=flags)


def value_signature(value: Value) -> tuple[Any, ...]:
    if value.kind in {
        "aggregate",
        "awaitable",
        "bound-function",
        "class",
        "function",
    }:
        return (value.kind, id(value.data), value.flags)
    if value.kind == "tuple":
        return (
            value.kind,
            tuple(value_signature(item) for item in value.data),
            value.flags,
        )
    return (value.kind, value.data, value.flags)


def merge_values(values: list[Value]) -> Value:
    if not values:
        return unknown()
    signature = value_signature(values[0])
    if all(value_signature(value) == signature for value in values[1:]):
        return values[0]
    flags = frozenset().union(*(value_flags(value) for value in values))
    return unknown(flags)


def value_flags(
    value: Value,
    seen: set[int] | None = None,
) -> frozenset[str]:
    flags = value.flags
    if value.kind != "aggregate":
        return flags
    seen = seen or set()
    identity = id(value.data)
    if identity in seen:
        return flags
    seen.add(identity)
    for member in value.data.members.values():
        if isinstance(member, Value):
            flags |= value_flags(member, seen)
    return flags


def merge_environments(environments: list[dict[str, Value]]) -> dict[str, Value]:
    if not environments:
        return {}
    keys = set().union(*(environment.keys() for environment in environments))
    merged: dict[str, Value] = {}
    for key in keys:
        values = [environment.get(key, unknown()) for environment in environments]
        merged[key] = merge_values(values)
    return merged


def dotted_target(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_target(node.value)
        if parent is not None:
            return f"{parent}.{node.attr}"
    return None


def has_decorator(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
    name: str,
) -> bool:
    return any(
        dotted_target(decorator) == name
        for decorator in function.decorator_list
    )


def canonical_exception(
    node: ast.expr | None,
    environment: dict[str, Value],
) -> str | None:
    if node is None or isinstance(node, ast.Tuple):
        return None
    value = evaluate_static_symbol(node, environment)
    return value.data if value.kind == "symbol" else None


def evaluate_static_symbol(
    node: ast.expr,
    environment: dict[str, Value],
) -> Value:
    if isinstance(node, ast.Name):
        return environment.get(node.id, unknown())
    if isinstance(node, ast.Attribute):
        base = evaluate_static_symbol(node.value, environment)
        if base.kind == "symbol":
            return Value("symbol", f"{base.data}.{node.attr}")
    return unknown()


class Analyzer:
    def __init__(
        self,
        sources: list[str],
        dependency_manifests: list[dict[str, str]],
    ) -> None:
        self.sources = sources
        self.dependency_manifests = dependency_manifests
        self.parse_error = False
        self.has_source = False
        self.credential_nodes: set[int] = set()
        self.client_nodes: set[int] = set()
        self.secret_client_nodes: set[int] = set()
        self.operation_counter = 0
        self.output_operation_ids: set[int] = set()
        self.operation_try_stacks: dict[int, tuple[int, ...]] = {}
        self.operations: list[Operation] = []
        self.operation_by_id: dict[int, Operation] = {}
        self.unexpected_secret_operation = False
        self.try_infos: list[TryInfo] = []
        self.try_counter = 0
        self.scope_stack: list[str] = []
        self.try_stack: list[int] = []
        self.path_guards: list[tuple[int, str]] = []
        self.call_stack: set[int] = set()

    def analyze(self) -> dict[str, bool]:
        for index, source in enumerate(self.sources):
            if not source.strip():
                continue
            try:
                tree = ast.parse(source)
            except SyntaxError:
                self.parse_error = True
                continue
            if any(not is_docstring_statement(statement) for statement in tree.body):
                self.has_source = True
            self.analyze_module(tree, index)

        source_is_valid = self.has_source and not self.parse_error
        package_rule = (
            source_is_valid
            and declares_package(
                self.dependency_manifests,
                "azure-identity",
            )
            and declares_package(
                self.dependency_manifests,
                "azure-keyvault-secrets",
            )
        )
        chains = self.lifecycle_chains()
        clients_are_valid = (
            source_is_valid
            and len(self.secret_client_nodes) == 1
            and len(self.client_nodes) == 1
        )
        lifecycle_is_valid = clients_are_valid and not self.unexpected_secret_operation
        return {
            "prompt/key-vault-packages": package_rule,
            "prompt/authenticated-secret-client": clients_are_valid,
            "prompt/create-secret": lifecycle_is_valid
            and self.has_lifecycle_prefix(1),
            "prompt/read-secret-value": lifecycle_is_valid
            and self.has_lifecycle_prefix(3),
            "prompt/update-secret": lifecycle_is_valid
            and self.has_lifecycle_prefix(4),
            "prompt/begin-delete-secret": lifecycle_is_valid
            and self.has_lifecycle_prefix(5),
            "prompt/purge-after-delete-completion": lifecycle_is_valid
            and bool(chains),
            "prompt/sdk-error-handling": source_is_valid
            and bool(chains)
            and self.sdk_errors_are_valid(chains),
        }

    def base_environment(self) -> dict[str, Value]:
        return {
            "dict": Value("symbol", "builtins.dict"),
            "list": Value("symbol", "builtins.list"),
            "object": Value("symbol", "builtins.object"),
            "print": Value("symbol", "builtins.print"),
            "str": Value("symbol", "builtins.str"),
            "SystemExit": Value("symbol", "builtins.SystemExit"),
            "RuntimeError": Value("symbol", "builtins.RuntimeError"),
            "Exception": Value("symbol", "builtins.Exception"),
            "BaseException": Value("symbol", "builtins.BaseException"),
        }

    def analyze_module(self, tree: ast.Module, index: int) -> None:
        scope = f"module:{index}"
        self.scope_stack.append(scope)
        initial = self.base_environment()
        for statement in tree.body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                initial[statement.name] = Value(
                    "function",
                    FunctionInfo(
                        statement,
                        initial,
                        f"{scope}:{statement.name}:{statement.lineno}",
                    ),
                )
            elif isinstance(statement, ast.ClassDef):
                methods = {
                    method.name: FunctionInfo(
                        method,
                        initial,
                        (
                            f"{scope}:class:{statement.name}:"
                            f"{method.name}:{method.lineno}"
                        ),
                        statement.name,
                    )
                    for method in statement.body
                    if isinstance(
                        method,
                        (ast.FunctionDef, ast.AsyncFunctionDef),
                    )
                }
                initial[statement.name] = Value(
                    "class",
                    ClassInfo(statement.name, methods),
                )
        self.execute_block(tree.body, initial)
        self.scope_stack.pop()

    def analyze_class(
        self,
        node: ast.ClassDef,
        module_environment: dict[str, Value],
        module_index: int,
    ) -> None:
        methods: dict[str, FunctionInfo] = {}
        for statement in node.body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                methods[statement.name] = FunctionInfo(
                    statement,
                    module_environment,
                    f"module:{module_index}:class:{node.name}:{statement.name}",
                    node.name,
                )

        member_environment = module_environment.copy()
        member_environment["self"] = unknown()
        for name, method in methods.items():
            member_environment[f"self.{name}"] = Value("function", method)

        initializer = methods.get("__init__")
        if initializer is not None:
            _, initialized = self.invoke_function(
                initializer,
                [unknown()],
                {},
                base_environment=member_environment,
            )
            member_environment.update(
                {
                    key: value
                    for key, value in initialized.items()
                    if key.startswith("self.")
                },
            )

        for name, method in methods.items():
            if name == "__init__":
                continue
            arguments = [unknown() for _ in method.node.args.args]
            self.invoke_function(
                method,
                arguments,
                {},
                base_environment=member_environment,
            )

    def bind_import(
        self,
        statement: ast.Import | ast.ImportFrom,
        environment: dict[str, Value],
    ) -> None:
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                if alias.asname:
                    environment[alias.asname] = Value("symbol", alias.name)
                else:
                    root = alias.name.split(".", maxsplit=1)[0]
                    environment[root] = Value("symbol", root)
            return

        module = "." * statement.level + (statement.module or "")
        for alias in statement.names:
            if alias.name == "*":
                continue
            binding = alias.asname or alias.name
            environment[binding] = Value(
                "symbol",
                f"{module}.{alias.name}" if module else alias.name,
            )

    def execute_block(
        self,
        statements: list[ast.stmt],
        environment: dict[str, Value],
    ) -> Flow:
        current = environment.copy()
        returned: list[Value] = []
        normal = True
        entry_guards = list(self.path_guards)
        active_guards = frozenset(entry_guards)
        try:
            for statement in statements:
                if not normal:
                    break
                self.path_guards[:] = active_guards
                flow = self.execute_statement(statement, current)
                current = flow.environment
                returned.extend(flow.returned)
                normal = flow.normal
                active_guards = (
                    flow.guards
                    if flow.guards is not None
                    else frozenset(self.path_guards)
                )
        finally:
            self.path_guards[:] = entry_guards
        return Flow(current, normal, returned, active_guards)

    def execute_statement(
        self,
        statement: ast.stmt,
        environment: dict[str, Value],
    ) -> Flow:
        current = environment.copy()
        if isinstance(statement, (ast.Import, ast.ImportFrom)):
            self.bind_import(statement, current)
            return Flow(current)

        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            existing = current.get(statement.name)
            info = (
                existing.data
                if existing is not None
                and existing.kind == "function"
                and existing.data.node is statement
                else FunctionInfo(
                    statement,
                    current.copy(),
                    (
                        f"{self.current_scope()}:"
                        f"{statement.name}:{statement.lineno}"
                    ),
                )
            )
            info.closure = current.copy()
            current[statement.name] = Value("function", info)
            return Flow(current)

        if isinstance(statement, ast.ClassDef):
            existing = current.get(statement.name)
            if (
                existing is None
                or existing.kind != "class"
                or not isinstance(existing.data, ClassInfo)
            ):
                methods = {
                    method.name: FunctionInfo(
                        method,
                        current.copy(),
                        (
                            f"{self.current_scope()}:class:"
                            f"{statement.name}:{method.name}:{method.lineno}"
                        ),
                        statement.name,
                    )
                    for method in statement.body
                    if isinstance(
                        method,
                        (ast.FunctionDef, ast.AsyncFunctionDef),
                    )
                }
                existing = Value(
                    "class",
                    ClassInfo(statement.name, methods),
                )
            for method in existing.data.methods.values():
                method.closure = current.copy()
            current[statement.name] = existing
            return Flow(current)

        if isinstance(statement, ast.Assign):
            value = self.evaluate_expression(statement.value, current)
            for target in statement.targets:
                self.assign_target(target, value, current)
            return Flow(current)

        if isinstance(statement, ast.AnnAssign):
            value = (
                self.evaluate_expression(statement.value, current)
                if statement.value is not None
                else unknown()
            )
            self.assign_target(statement.target, value, current)
            return Flow(current)

        if isinstance(statement, (ast.AugAssign, ast.NamedExpr)):
            target = statement.target
            self.assign_target(target, unknown(), current)
            return Flow(current)

        if isinstance(statement, ast.Expr):
            self.evaluate_expression(statement.value, current)
            return Flow(current)

        if isinstance(statement, ast.Return):
            value = (
                self.evaluate_expression(statement.value, current)
                if statement.value is not None
                else Value("none")
            )
            return Flow(current, False, [value])

        if isinstance(statement, ast.Raise):
            if statement.exc is not None:
                self.evaluate_expression(statement.exc, current)
            return Flow(current, False)

        if isinstance(statement, ast.If):
            literal = self.evaluate_boolean(statement.test, current)
            if literal is True:
                return self.execute_block(statement.body, current)
            if literal is False:
                return self.execute_block(statement.orelse, current)
            branch_id = id(statement)
            self.path_guards.append((branch_id, "body"))
            body = self.execute_block(statement.body, current)
            self.path_guards.pop()
            self.path_guards.append((branch_id, "else"))
            alternate = self.execute_block(statement.orelse, current)
            self.path_guards.pop()
            branches = [body, alternate]
            return self.merge_flows(branches, current)

        if isinstance(statement, (ast.For, ast.AsyncFor)):
            if self.iterable_is_empty(statement.iter, current):
                return self.execute_block(statement.orelse, current)
            loop_environment = current.copy()
            iterable = self.evaluate_expression(statement.iter, current)
            item = (
                merge_values(list(iterable.data))
                if iterable.kind == "tuple"
                else merge_values(list(iterable.data.members.values()))
                if iterable.kind == "aggregate"
                else unknown(value_flags(iterable))
            )
            self.assign_target(statement.target, item, loop_environment)
            body = self.execute_block(statement.body, loop_environment)
            alternate = self.execute_block(statement.orelse, current)
            return self.merge_flows(
                [Flow(current), body, alternate],
                current,
            )

        if isinstance(statement, ast.While):
            literal = self.evaluate_boolean(statement.test, current)
            if literal is False:
                return self.execute_block(statement.orelse, current)
            body = self.execute_block(statement.body, current)
            alternate = self.execute_block(statement.orelse, current)
            flows = [body, alternate]
            if literal is not True:
                flows.append(Flow(current))
            return self.merge_flows(flows, current)

        if isinstance(statement, (ast.With, ast.AsyncWith)):
            body_environment = current.copy()
            for item in statement.items:
                value = self.evaluate_expression(
                    item.context_expr,
                    body_environment,
                )
                if item.optional_vars is not None:
                    self.assign_target(
                        item.optional_vars,
                        value,
                        body_environment,
                    )
            return self.execute_block(statement.body, body_environment)

        if isinstance(statement, (ast.Try, ast.TryStar)):
            return self.execute_try(statement, current)

        if isinstance(statement, ast.Match):
            flows = []
            branch_id = id(statement)
            for index, case in enumerate(statement.cases):
                self.path_guards.append((branch_id, f"case:{index}"))
                flows.append(self.execute_block(case.body, current))
                self.path_guards.pop()
            flows.append(Flow(current))
            return self.merge_flows(flows, current)

        return Flow(current)

    def execute_try(
        self,
        statement: ast.Try | ast.TryStar,
        environment: dict[str, Value],
    ) -> Flow:
        self.try_counter += 1
        identifier = self.try_counter
        info = TryInfo(
            identifier,
            self.current_scope(),
            [
                HandlerInfo(handler, environment.copy())
                for handler in statement.handlers
            ],
            self.block_may_throw(statement.body, environment),
        )
        self.try_infos.append(info)

        self.try_stack.append(identifier)
        self.path_guards.append((id(statement), "body"))
        body = self.execute_block(statement.body, environment)
        self.path_guards.pop()
        self.try_stack.pop()
        if body.normal and statement.orelse:
            body = self.execute_block(statement.orelse, body.environment)

        branches = [body]
        if self.block_may_throw(statement.body, environment):
            for index, handler in enumerate(statement.handlers):
                handler_environment = environment.copy()
                if handler.name:
                    handler_environment[handler.name] = unknown()
                self.path_guards.append((id(statement), f"handler:{index}"))
                branches.append(
                    self.execute_block(handler.body, handler_environment),
                )
                self.path_guards.pop()
        merged = self.merge_flows(branches, environment)
        if statement.finalbody:
            saved = list(self.path_guards)
            self.path_guards[:] = merged.guards or ()
            try:
                return self.execute_block(
                    statement.finalbody,
                    merged.environment,
                )
            finally:
                self.path_guards[:] = saved
        return merged

    def iterable_is_empty(
        self,
        node: ast.expr,
        environment: dict[str, Value],
    ) -> bool:
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            return len(node.elts) == 0
        if isinstance(node, ast.Dict):
            return len(node.keys) == 0
        if isinstance(node, (ast.Name, ast.Attribute)):
            value = self.evaluate_expression(node, environment)
        else:
            return False
        if value.kind == "tuple":
            return len(value.data) == 0
        if value.kind == "aggregate":
            return len(value.data.members) == 0
        return False

    def block_may_throw(
        self,
        statements: list[ast.stmt],
        environment: dict[str, Value],
        seen: set[int] | None = None,
    ) -> bool:
        seen = seen or set()
        current = environment.copy()
        for statement in statements:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if isinstance(statement, ast.Raise):
                return True
            if isinstance(statement, ast.Return):
                return (
                    statement.value is not None
                    and self.expression_may_throw(statement.value, current, seen)
                )
            if isinstance(statement, ast.Assign):
                if self.expression_may_throw(statement.value, current, seen):
                    return True
                value = self.evaluate_expression(statement.value, current)
                for target in statement.targets:
                    self.assign_target(target, value, current)
                continue
            if isinstance(statement, ast.AnnAssign):
                if statement.value is not None:
                    if self.expression_may_throw(statement.value, current, seen):
                        return True
                    value = self.evaluate_expression(statement.value, current)
                else:
                    value = unknown()
                self.assign_target(statement.target, value, current)
                continue
            if isinstance(statement, (ast.AugAssign, ast.NamedExpr)):
                value = statement.value
                if self.expression_may_throw(value, current, seen):
                    return True
                self.assign_target(statement.target, unknown(), current)
                continue
            if isinstance(statement, ast.If):
                if self.expression_may_throw(statement.test, current, seen):
                    return True
                condition = self.evaluate_boolean(statement.test, current)
                branches = (
                    [statement.body]
                    if condition is True
                    else [statement.orelse]
                    if condition is False
                    else [statement.body, statement.orelse]
                )
                if any(
                    self.block_may_throw(branch, current, seen)
                    for branch in branches
                ):
                    return True
                continue
            if isinstance(statement, (ast.With, ast.AsyncWith)):
                if any(
                    self.expression_may_throw(
                        item.context_expr,
                        current,
                        seen,
                    )
                    for item in statement.items
                ) or self.block_may_throw(statement.body, current, seen):
                    return True
                continue
            if isinstance(statement, (ast.Try, ast.TryStar)):
                if self.block_may_throw(statement.body, current, seen):
                    return True
                continue
            if isinstance(statement, (ast.For, ast.AsyncFor)):
                branches = [statement.orelse]
                if self.expression_may_throw(statement.iter, current, seen):
                    return True
                if not self.iterable_is_empty(statement.iter, current):
                    branches.append(statement.body)
                if any(
                    self.block_may_throw(branch, current, seen)
                    for branch in branches
                ):
                    return True
                continue
            if isinstance(statement, ast.While):
                if self.expression_may_throw(statement.test, current, seen):
                    return True
                condition = self.evaluate_boolean(statement.test, current)
                branches = [statement.orelse]
                if condition is not False:
                    branches.append(statement.body)
                if any(
                    self.block_may_throw(branch, current, seen)
                    for branch in branches
                ):
                    return True
                continue
            expressions = [
                node
                for node in ast.iter_child_nodes(statement)
                if isinstance(node, ast.expr)
            ]
            if any(
                self.expression_may_throw(node, current, seen)
                for node in expressions
            ):
                return True
        return False

    def expression_may_throw(
        self,
        node: ast.expr,
        environment: dict[str, Value],
        seen: set[int],
    ) -> bool:
        if isinstance(node, ast.Call):
            function = self.evaluate_expression(node.func, environment)
            if function.kind == "function":
                identity = id(function.data.node)
                if identity in seen:
                    return True
                return self.block_may_throw(
                    function.data.node.body,
                    function.data.closure,
                    seen | {identity},
                )
            return True
        if isinstance(node, ast.IfExp):
            condition = self.evaluate_boolean(node.test, environment)
            arms = (
                [node.body]
                if condition is True
                else [node.orelse]
                if condition is False
                else [node.body, node.orelse]
            )
            return any(
                self.expression_may_throw(arm, environment, seen)
                for arm in arms
            )
        if isinstance(node, ast.BoolOp):
            for child in node.values:
                if self.expression_may_throw(child, environment, seen):
                    return True
                condition = self.evaluate_boolean(child, environment)
                if (
                    isinstance(node.op, ast.And) and condition is False
                ) or (
                    isinstance(node.op, ast.Or) and condition is True
                ):
                    break
            return False
        return any(
            self.expression_may_throw(child, environment, seen)
            for child in ast.iter_child_nodes(node)
            if isinstance(child, ast.expr)
        )

    def merge_flows(
        self,
        flows: list[Flow],
        fallback: dict[str, Value],
    ) -> Flow:
        normal_environments = [
            flow.environment for flow in flows if flow.normal
        ]
        returned = [value for flow in flows for value in flow.returned]
        if not normal_environments:
            return Flow(fallback.copy(), False, returned, frozenset())
        normal_guards = [
            flow.guards or frozenset()
            for flow in flows
            if flow.normal
        ]
        common_guards = set(normal_guards[0])
        for guards in normal_guards[1:]:
            common_guards.intersection_update(guards)
        return Flow(
            merge_environments(normal_environments),
            True,
            returned,
            frozenset(common_guards),
        )

    def evaluate_boolean(
        self,
        node: ast.expr,
        environment: dict[str, Value],
    ) -> bool | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, bool):
            return node.value
        if isinstance(node, (ast.Name, ast.Attribute)):
            value = self.evaluate_expression(node, environment)
            return (
                value.data
                if value.kind == "literal"
                and isinstance(value.data, bool)
                else None
            )
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            value = self.evaluate_boolean(node.operand, environment)
            return None if value is None else not value
        if isinstance(node, ast.BoolOp):
            values = [
                self.evaluate_boolean(value, environment)
                for value in node.values
            ]
            if isinstance(node.op, ast.And):
                if False in values:
                    return False
                return True if all(value is True for value in values) else None
            if True in values:
                return True
            return False if all(value is False for value in values) else None
        if (
            isinstance(node, ast.Compare)
            and len(node.ops) == 1
            and len(node.comparators) == 1
            and isinstance(node.ops[0], (ast.Eq, ast.NotEq))
        ):
            left = self.evaluate_boolean(node.left, environment)
            right = self.evaluate_boolean(node.comparators[0], environment)
            if left is None or right is None:
                return None
            equal = left == right
            return equal if isinstance(node.ops[0], ast.Eq) else not equal
        return None

    def assign_target(
        self,
        target: ast.expr,
        value: Value,
        environment: dict[str, Value],
    ) -> None:
        if isinstance(target, ast.Name):
            environment[target.id] = value
            return
        if isinstance(target, ast.Attribute):
            base = self.evaluate_expression(target.value, environment)
            if base.kind == "aggregate":
                base.data.members[target.attr] = value
                base.flags |= value_flags(value)
            name = dotted_target(target)
            if name is not None:
                environment[name] = value
            return
        if isinstance(target, ast.Subscript):
            base = self.evaluate_expression(target.value, environment)
            key = self.evaluate_expression(target.slice, environment)
            if base.kind == "aggregate":
                base.data.members[self.aggregate_key(key)] = value
                base.flags |= value_flags(value) | value_flags(key)
            return
        if isinstance(target, (ast.Tuple, ast.List)):
            if value.kind == "tuple" and len(value.data) == len(target.elts):
                for child, item in zip(target.elts, value.data, strict=True):
                    self.assign_target(child, item, environment)
            else:
                for child in target.elts:
                    self.assign_target(
                        child,
                        unknown(value_flags(value)),
                        environment,
                    )

    def evaluate_expression(
        self,
        node: ast.expr | None,
        environment: dict[str, Value],
    ) -> Value:
        if node is None:
            return Value("none")
        if isinstance(node, ast.Name):
            return environment.get(node.id, unknown())
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                return Value("string", node.value)
            if node.value is None:
                return Value("none")
            return Value("literal", node.value)
        if isinstance(node, ast.Attribute):
            name = dotted_target(node)
            if name is not None and name in environment:
                return environment[name]
            base = self.evaluate_expression(node.value, environment)
            if base.kind == "symbol":
                return Value("symbol", f"{base.data}.{node.attr}")
            if base.kind == "aggregate":
                member = base.data.members.get(node.attr)
                if member is not None:
                    return member
                class_info = base.data.members.get("__class__")
                if (
                    isinstance(class_info, ClassInfo)
                    and node.attr in class_info.methods
                ):
                    method = class_info.methods[node.attr]
                    if has_decorator(method.node, "staticmethod"):
                        return Value("function", method)
                    return Value(
                        "bound-function",
                        (method, base),
                    )
                return unknown(value_flags(base))
            if base.kind == "class" and node.attr in base.data.methods:
                method = base.data.methods[node.attr]
                if has_decorator(method.node, "classmethod"):
                    return Value(
                        "bound-function",
                        (method, Value("class", base.data)),
                    )
                return Value("function", method)
            if base.kind == "client" and node.attr in {
                "set_secret",
                "get_secret",
                "begin_delete_secret",
                "purge_deleted_secret",
            }:
                return Value("sdk-bound", (base, node.attr))
            if base.kind == "delete-poller" and node.attr in {"wait", "result"}:
                return Value("sdk-bound", (base, node.attr))
            if base.kind == "secret-result" and node.attr == "value":
                return Value(
                    "secret-value",
                    base.data,
                    frozenset({f"{RESULT_FLAG_PREFIX}{base.data}"}),
                )
            return unknown(value_flags(base))
        if isinstance(node, ast.Subscript):
            base = self.evaluate_expression(node.value, environment)
            key = self.evaluate_expression(node.slice, environment)
            if base.kind == "symbol" and base.data == "os.environ":
                return self.environment_value(key, safe=True)
            if base.kind == "aggregate":
                member = base.data.members.get(self.aggregate_key(key))
                if member is not None:
                    return member
                return unknown(value_flags(base) | value_flags(key))
            if base.kind == "tuple" and isinstance(key.data, int):
                try:
                    return base.data[key.data]
                except IndexError:
                    return unknown()
            return unknown(value_flags(base) | value_flags(key))
        if isinstance(node, ast.Tuple):
            values = [
                self.evaluate_expression(element, environment)
                for element in node.elts
            ]
            flags = frozenset().union(*(value_flags(value) for value in values))
            return Value("tuple", tuple(values), flags)
        if isinstance(node, ast.List):
            values = [
                self.evaluate_expression(element, environment)
                for element in node.elts
            ]
            flags = frozenset().union(*(value_flags(value) for value in values))
            return Value(
                "aggregate",
                Aggregate(dict(enumerate(values))),
                flags,
            )
        if isinstance(node, ast.Call):
            return self.evaluate_call(node, environment)
        if isinstance(node, ast.Await):
            value = self.evaluate_expression(node.value, environment)
            return self.consume_awaitable(value)
        if isinstance(node, ast.JoinedStr):
            values = [
                self.evaluate_expression(value.value, environment)
                if isinstance(value, ast.FormattedValue)
                else self.evaluate_expression(value, environment)
                for value in node.values
            ]
            flags = frozenset().union(*(value_flags(value) for value in values))
            if all(value.kind in {"literal", "string"} for value in values):
                return Value(
                    "string",
                    "".join(str(value.data) for value in values),
                    flags,
                )
            return Value("formatted", flags=flags)
        if isinstance(node, ast.FormattedValue):
            return self.evaluate_expression(node.value, environment)
        if isinstance(node, ast.BoolOp):
            return self.evaluate_short_circuit(node, environment)
        if isinstance(node, ast.IfExp):
            condition = self.evaluate_boolean(node.test, environment)
            if condition is True:
                return self.evaluate_expression(node.body, environment)
            if condition is False:
                return self.evaluate_expression(node.orelse, environment)
            branch_id = id(node)
            self.path_guards.append((branch_id, "body"))
            body = self.evaluate_expression(node.body, environment)
            self.path_guards.pop()
            self.path_guards.append((branch_id, "else"))
            alternate = self.evaluate_expression(node.orelse, environment)
            self.path_guards.pop()
            return merge_values([body, alternate])
        if isinstance(node, (ast.Compare, ast.UnaryOp)):
            boolean = self.evaluate_boolean(node, environment)
            if boolean is not None:
                return Value("literal", boolean)
        if isinstance(node, ast.BinOp):
            left = self.evaluate_expression(node.left, environment)
            right = self.evaluate_expression(node.right, environment)
            flags = value_flags(left) | value_flags(right)
            if (
                isinstance(node.op, ast.Add)
                and left.kind == "string"
                and right.kind == "string"
            ):
                return Value("string", left.data + right.data, flags)
            if isinstance(node.op, ast.Mult):
                if (
                    left.kind == "string"
                    and right.kind == "literal"
                    and isinstance(right.data, int)
                ):
                    return Value("string", left.data * right.data, flags)
                if (
                    right.kind == "string"
                    and left.kind == "literal"
                    and isinstance(left.data, int)
                ):
                    return Value("string", right.data * left.data, flags)
            return unknown(flags)
        if isinstance(node, ast.Compare):
            children = [
                self.evaluate_expression(child, environment)
                for child in ast.iter_child_nodes(node)
                if isinstance(child, ast.expr)
            ]
            flags = frozenset().union(*(value_flags(value) for value in children))
            return unknown(flags)
        if isinstance(node, ast.UnaryOp):
            return self.evaluate_expression(node.operand, environment)
        if isinstance(node, ast.Starred):
            return self.evaluate_expression(node.value, environment)
        if isinstance(node, ast.Dict):
            aggregate = Aggregate()
            flags = frozenset()
            for key_node, value_node in zip(
                node.keys,
                node.values,
                strict=True,
            ):
                key = self.evaluate_expression(key_node, environment)
                value = self.evaluate_expression(value_node, environment)
                aggregate.members[self.aggregate_key(key)] = value
                flags |= value_flags(key) | value_flags(value)
            return Value("aggregate", aggregate, flags)
        return unknown()

    def evaluate_short_circuit(
        self,
        node: ast.BoolOp,
        environment: dict[str, Value],
    ) -> Value:
        values: list[Value] = []
        pushed = 0
        try:
            for index, child in enumerate(node.values):
                value = self.evaluate_expression(child, environment)
                values.append(value)
                boolean = (
                    value.data
                    if value.kind == "literal" and isinstance(value.data, bool)
                    else self.evaluate_boolean(child, environment)
                )
                stops = (
                    isinstance(node.op, ast.And) and boolean is False
                ) or (
                    isinstance(node.op, ast.Or) and boolean is True
                )
                if stops or index == len(node.values) - 1:
                    return value
                if boolean is None:
                    arm = "truthy" if isinstance(node.op, ast.And) else "falsy"
                    self.path_guards.append((id(node), f"{arm}:{index}"))
                    pushed += 1
        finally:
            for _ in range(pushed):
                self.path_guards.pop()
        return values[-1] if values else unknown()

    @staticmethod
    def aggregate_key(value: Value) -> Any:
        if value.kind in {"literal", "string"}:
            return value.data
        return ("unknown", id(value))

    def evaluate_call(
        self,
        node: ast.Call,
        environment: dict[str, Value],
    ) -> Value:
        receiver = None
        method_name = None
        if isinstance(node.func, ast.Attribute):
            receiver = self.evaluate_expression(node.func.value, environment)
            method_name = node.func.attr
        function = self.evaluate_expression(node.func, environment)
        positional = [
            self.evaluate_expression(argument, environment)
            for argument in node.args
        ]
        named = {
            keyword.arg: self.evaluate_expression(keyword.value, environment)
            for keyword in node.keywords
            if keyword.arg is not None
        }
        all_values = positional + list(named.values())
        flags = frozenset().union(*(value_flags(value) for value in all_values))
        if receiver is not None:
            flags |= value_flags(receiver)

        if function.kind == "sdk-bound":
            receiver, method_name = function.data

        if function.kind == "function":
            if isinstance(function.data.node, ast.AsyncFunctionDef):
                return self.function_awaitable(
                    function.data,
                    positional,
                    named,
                )
            value, _ = self.invoke_function(function.data, positional, named)
            return value

        if function.kind == "bound-function":
            info, instance = function.data
            if isinstance(info.node, ast.AsyncFunctionDef):
                return self.function_awaitable(
                    info,
                    [instance, *positional],
                    named,
                )
            value, _ = self.invoke_function(
                info,
                [instance, *positional],
                named,
            )
            return value

        if function.kind == "class":
            instance_flags = frozenset().union(
                *(value_flags(value) for value in all_values),
            )
            instance = Value(
                "aggregate",
                Aggregate({"__class__": function.data}),
                instance_flags,
            )
            initializer = function.data.methods.get("__init__")
            if initializer is not None:
                self.invoke_function(
                    initializer,
                    [instance, *positional],
                    named,
                )
            return instance

        canonical = function.data if function.kind == "symbol" else None
        if canonical in {
            "azure.identity.DefaultAzureCredential",
            "azure.identity.aio.DefaultAzureCredential",
        }:
            self.credential_nodes.add(id(node))
            return Value("credential", id(node))

        if canonical in {
            "azure.keyvault.secrets.SecretClient",
            "azure.keyvault.secrets.aio.SecretClient",
        }:
            return self.secret_client(
                node,
                positional,
                named,
                is_async=canonical.endswith(".aio.SecretClient"),
            )

        if receiver is not None and receiver.kind == "client":
            if method_name in {
                "set_secret",
                "get_secret",
                "begin_delete_secret",
                "purge_deleted_secret",
            }:
                if receiver.data.is_async:
                    return self.sdk_awaitable(
                        receiver,
                        method_name,
                        positional,
                        named,
                    )
                return self.execute_sdk_call(
                    receiver,
                    method_name,
                    positional,
                    named,
                )

        if (
            receiver is not None
            and receiver.kind == "delete-poller"
            and method_name in {"wait", "result"}
        ):
            if receiver.data[3]:
                return self.sdk_awaitable(
                    receiver,
                    method_name,
                    positional,
                    named,
                )
            return self.execute_sdk_call(
                receiver,
                method_name,
                positional,
                named,
            )

        if canonical == "builtins.print":
            self.record_output(all_values)
            return Value("none")

        if canonical in {
            "builtins.dict",
            "builtins.list",
            "builtins.object",
        }:
            return Value("aggregate", Aggregate(), flags)

        if receiver is not None and method_name in {
            "append",
            "extend",
            "update",
        }:
            if receiver.kind == "aggregate":
                receiver.flags |= flags
                start = len(receiver.data.members)
                if method_name == "append" and positional:
                    receiver.data.members[start] = positional[0]
                elif positional:
                    source = positional[0]
                    if source.kind == "aggregate":
                        receiver.data.members.update(source.data.members)
                    elif source.kind == "tuple":
                        for offset, item in enumerate(source.data):
                            receiver.data.members[start + offset] = item
            return Value("none")

        if method_name in {
            "debug",
            "info",
            "warning",
            "error",
            "exception",
            "critical",
            "log",
            "write",
        }:
            return Value("none")

        if canonical == "builtins.str" and positional:
            return Value("formatted", flags=positional[0].flags)
        if method_name == "format":
            return Value("formatted", flags=flags)
        return unknown(flags)

    @staticmethod
    def function_awaitable(
        function: FunctionInfo,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        return Value(
            "awaitable",
            PendingCall(
                "function",
                tuple(positional),
                named.copy(),
                function=function,
            ),
        )

    @staticmethod
    def sdk_awaitable(
        receiver: Value,
        method_name: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        return Value(
            "awaitable",
            PendingCall(
                "sdk",
                tuple(positional),
                named.copy(),
                receiver=receiver,
                method_name=method_name,
            ),
        )

    def consume_awaitable(self, value: Value) -> Value:
        if value.kind != "awaitable":
            return unknown(value_flags(value))
        pending = value.data
        if pending.consumed:
            return unknown(value_flags(value))
        pending.consumed = True
        positional = list(pending.positional)
        if pending.kind == "function" and pending.function is not None:
            result, _ = self.invoke_function(
                pending.function,
                positional,
                pending.named,
            )
            return result
        if (
            pending.kind == "sdk"
            and pending.receiver is not None
            and pending.method_name is not None
        ):
            return self.execute_sdk_call(
                pending.receiver,
                pending.method_name,
                positional,
                pending.named,
            )
        return unknown(value_flags(value))

    def execute_sdk_call(
        self,
        receiver: Value,
        method_name: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        if receiver.kind == "client":
            if method_name == "set_secret":
                return self.set_secret(receiver, positional, named)
            if method_name == "get_secret":
                return self.get_secret(receiver, positional, named)
            if method_name == "begin_delete_secret":
                return self.begin_delete_secret(receiver, positional, named)
            if method_name == "purge_deleted_secret":
                self.purge_deleted_secret(receiver, positional, named)
                return Value("none")
        if receiver.kind == "delete-poller" and method_name in {
            "wait",
            "result",
        }:
            poller_id, client, name, _ = receiver.data
            self.record_operation(
                "wait",
                client,
                name,
                related=poller_id,
            )
            return Value("deleted-secret", (client, name))
        return unknown(value_flags(receiver))

    def environment_value(self, key: Value, *, safe: bool) -> Value:
        if not safe or key.kind != "string":
            return unknown()
        return Value("environment", key.data)

    def secret_client(
        self,
        node: ast.Call,
        positional: list[Value],
        named: dict[str, Value],
        *,
        is_async: bool,
    ) -> Value:
        self.secret_client_nodes.add(id(node))
        vault_url = named.get("vault_url")
        credential = named.get("credential")
        if vault_url is None and positional:
            vault_url = positional[0]
        if credential is None and len(positional) > 1:
            credential = positional[1]
        if (
            vault_url is not None
            and credential is not None
            and credential.kind == "credential"
        ):
            self.client_nodes.add(id(node))
            return Value("client", ClientInfo(id(node), is_async))
        return unknown()

    def get_secret(
        self,
        receiver: Value,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        secret_name = self.call_argument(positional, named, 0, "name")
        name = self.exact_string(secret_name)
        if receiver.kind != "client" or name != "my-secret":
            self.unexpected_secret_operation = True
            return unknown()
        operation = self.record_operation(
            "get",
            receiver.data.identifier,
            name,
        )
        return Value("secret-result", operation)

    def set_secret(
        self,
        receiver: Value,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        name = self.exact_string(
            self.call_argument(positional, named, 0, "name", "secret_name"),
        )
        value = self.exact_string(
            self.call_argument(positional, named, 1, "value"),
        )
        if name != "my-secret" or value not in {
            "my-secret-value",
            "updated-value",
        }:
            self.unexpected_secret_operation = True
            return unknown()
        kind = "create" if value == "my-secret-value" else "update"
        operation = self.record_operation(
            kind,
            receiver.data.identifier,
            name,
            value,
        )
        return Value("secret-result", operation)

    def begin_delete_secret(
        self,
        receiver: Value,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        name = self.exact_string(
            self.call_argument(positional, named, 0, "name", "secret_name"),
        )
        if name != "my-secret":
            self.unexpected_secret_operation = True
            return unknown()
        operation = self.record_operation(
            "delete",
            receiver.data.identifier,
            name,
        )
        return Value(
            "delete-poller",
            (
                operation,
                receiver.data.identifier,
                name,
                receiver.data.is_async,
            ),
        )

    def purge_deleted_secret(
        self,
        receiver: Value,
        positional: list[Value],
        named: dict[str, Value],
    ) -> None:
        name = self.exact_string(
            self.call_argument(
                positional,
                named,
                0,
                "name",
                "deleted_secret_name",
            ),
        )
        if name == "my-secret":
            self.record_operation(
                "purge",
                receiver.data.identifier,
                name,
            )
        else:
            self.unexpected_secret_operation = True

    @staticmethod
    def call_argument(
        positional: list[Value],
        named: dict[str, Value],
        index: int,
        *names: str,
    ) -> Value | None:
        for name in names:
            if name in named:
                return named[name]
        return positional[index] if len(positional) > index else None

    @staticmethod
    def exact_string(value: Value | None) -> str | None:
        return value.data if value is not None and value.kind == "string" else None

    def record_operation(
        self,
        kind: str,
        client: int,
        name: str,
        value: str | None = None,
        *,
        related: int | None = None,
    ) -> int:
        self.operation_counter += 1
        identifier = self.operation_counter
        operation = Operation(
            kind=kind,
            order=identifier,
            client=client,
            name=name,
            value=value,
            related=related,
            guards=frozenset(self.path_guards),
            try_stack=tuple(self.try_stack),
            scope=self.current_scope(),
        )
        self.operations.append(operation)
        self.operation_by_id[identifier] = operation
        self.operation_try_stacks[identifier] = tuple(self.try_stack)
        return identifier

    def record_output(self, values: list[Value]) -> None:
        flags = frozenset().union(*(value_flags(value) for value in values))
        for flag in flags:
            if flag.startswith(RESULT_FLAG_PREFIX):
                related = int(flag.removeprefix(RESULT_FLAG_PREFIX))
                source = self.operation_by_id.get(related)
                if source is None or source.kind != "get":
                    continue
                self.output_operation_ids.add(related)
                self.record_operation(
                    "output",
                    source.client,
                    source.name,
                    related=related,
                )

    def invoke_function(
        self,
        info: FunctionInfo,
        positional: list[Value],
        named: dict[str, Value],
        *,
        base_environment: dict[str, Value] | None = None,
    ) -> tuple[Value, dict[str, Value]]:
        identity = id(info.node)
        if identity in self.call_stack:
            return unknown(), {}
        self.call_stack.add(identity)
        environment = (
            base_environment.copy()
            if base_environment is not None
            else info.closure.copy()
        )
        parameters = [
            *info.node.args.posonlyargs,
            *info.node.args.args,
        ]
        positional_defaults = [None] * (
            len(parameters) - len(info.node.args.defaults)
        ) + list(info.node.args.defaults)
        for index, parameter in enumerate(parameters):
            if index < len(positional):
                environment[parameter.arg] = positional[index]
            elif parameter.arg in named:
                environment[parameter.arg] = named[parameter.arg]
            elif positional_defaults[index] is not None:
                environment[parameter.arg] = self.evaluate_expression(
                    positional_defaults[index],
                    environment,
                )
            else:
                environment[parameter.arg] = unknown()
        if info.node.args.vararg:
            environment[info.node.args.vararg.arg] = Value(
                "tuple",
                tuple(positional[len(parameters) :]),
            )
        for parameter, default in zip(
            info.node.args.kwonlyargs,
            info.node.args.kw_defaults,
            strict=True,
        ):
            environment[parameter.arg] = (
                named[parameter.arg]
                if parameter.arg in named
                else self.evaluate_expression(default, environment)
                if default is not None
                else unknown()
            )

        self.scope_stack.append(info.scope)
        flow = self.execute_block(info.node.body, environment)
        self.scope_stack.pop()
        self.call_stack.remove(identity)
        return merge_values(flow.returned), flow.environment

    def current_scope(self) -> str:
        return self.scope_stack[-1] if self.scope_stack else "unknown"

    @staticmethod
    def operations_are_compatible(operations: tuple[Operation, ...]) -> bool:
        selected: dict[int, str] = {}
        for operation in operations:
            for branch, arm in operation.guards:
                previous = selected.get(branch)
                if previous is not None and previous != arm:
                    return False
                selected[branch] = arm
        return True

    def lifecycle_chains(self) -> list[tuple[Operation, ...]]:
        for kind in ("create", "get", "output", "update", "delete", "wait", "purge"):
            if sum(operation.kind == kind for operation in self.operations) != 1:
                return []
        chains: list[tuple[Operation, ...]] = []
        for create in self.operations:
            if create.kind != "create":
                continue
            for get in self.operations:
                if (
                    get.kind != "get"
                    or get.client != create.client
                    or get.name != create.name
                    or get.order <= create.order
                ):
                    continue
                for output in self.operations:
                    if (
                        output.kind != "output"
                        or output.related != get.order
                        or output.order <= get.order
                    ):
                        continue
                    for update in self.operations:
                        if (
                            update.kind != "update"
                            or update.client != create.client
                            or update.name != create.name
                            or update.order <= output.order
                        ):
                            continue
                        for delete in self.operations:
                            if (
                                delete.kind != "delete"
                                or delete.client != create.client
                                or delete.name != create.name
                                or delete.order <= update.order
                            ):
                                continue
                            for wait in self.operations:
                                if (
                                    wait.kind != "wait"
                                    or wait.related != delete.order
                                    or wait.order <= delete.order
                                ):
                                    continue
                                for purge in self.operations:
                                    chain = (
                                        create,
                                        get,
                                        output,
                                        update,
                                        delete,
                                        wait,
                                        purge,
                                    )
                                    if (
                                        purge.kind == "purge"
                                        and purge.client == create.client
                                        and purge.name == create.name
                                        and purge.order > wait.order
                                        and self.operations_are_compatible(chain)
                                    ):
                                        chains.append(chain)
        return chains

    def has_lifecycle_prefix(self, length: int) -> bool:
        expected = ["create", "get", "output", "update", "delete"]
        for kind in expected[:length]:
            if sum(operation.kind == kind for operation in self.operations) != 1:
                return False
        candidates = [
            operation
            for operation in self.operations
            if operation.kind in expected[:length]
        ]

        def search(
            chosen: tuple[Operation, ...],
            position: int,
        ) -> bool:
            if position == length:
                return self.operations_are_compatible(chosen)
            for operation in candidates:
                if operation.kind != expected[position]:
                    continue
                if chosen and operation.order <= chosen[-1].order:
                    continue
                if chosen and (
                    operation.client != chosen[0].client
                    or operation.name != chosen[0].name
                ):
                    continue
                if (
                    operation.kind == "output"
                    and operation.related != chosen[-1].order
                ):
                    continue
                if search((*chosen, operation), position + 1):
                    return True
            return False

        return search((), 0)

    def sdk_errors_are_valid(
        self,
        chains: list[tuple[Operation, ...]],
    ) -> bool:
        connected_try_ids = {
            try_id
            for chain in chains
            for operation in chain
            for try_id in operation.try_stack
        }
        has_useful_not_found_handler = False
        for info in self.try_infos:
            if not info.may_throw:
                continue
            for handler in info.handlers:
                exception = canonical_exception(
                    handler.node.type,
                    handler.environment,
                )
                is_connected_not_found_handler = (
                    info.identifier in connected_try_ids
                    and exception
                    == "azure.core.exceptions.ResourceNotFoundError"
                )
                if is_connected_not_found_handler and useful_handler(
                    handler.node,
                ):
                    has_useful_not_found_handler = True
                    continue
                if not handler_always_causal(handler.node):
                    return False
        return has_useful_not_found_handler


def exact_environment(value: Value | None, key: str) -> bool:
    return (
        value is not None
        and value.kind == "environment"
        and value.data == key
    )


def is_docstring_statement(statement: ast.stmt) -> bool:
    return (
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Constant)
        and isinstance(statement.value.value, str)
    )


def literal_boolean(node: ast.expr) -> bool | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, bool):
        return node.value
    return None


def exception_name_used(node: ast.AST, name: str) -> bool:
    return any(
        isinstance(child, ast.Name) and child.id == name
        for child in ast.walk(node)
    )


def is_diagnostic_call(node: ast.Call) -> bool:
    if isinstance(node.func, ast.Name):
        return node.func.id in {"print", "exit"}
    if isinstance(node.func, ast.Attribute):
        return node.func.attr in {
            "debug",
            "info",
            "warning",
            "error",
            "exception",
            "critical",
            "log",
            "write",
            "exit",
        }
    return False


def useful_handler(handler: ast.ExceptHandler) -> bool:
    if handler_always_causal(handler):
        return True
    if handler.name is None:
        return False
    outcomes = useful_sequence(handler.body, handler.name, False)
    return bool(outcomes) and all(
        terminal == "safe" or diagnosed
        for terminal, diagnosed in outcomes
    )


def statement_diagnoses_error(statement: ast.stmt, binding: str) -> bool:
    return any(
        isinstance(node, ast.Call)
        and is_diagnostic_call(node)
        and any(
            exception_name_used(argument, binding)
            for argument in [*node.args, *(item.value for item in node.keywords)]
        )
        for node in ast.walk(statement)
    )


def useful_sequence(
    statements: list[ast.stmt],
    binding: str,
    diagnosed: bool,
) -> set[tuple[str, bool]]:
    outcomes: set[tuple[str, bool]] = {("fall", diagnosed)}
    for statement in statements:
        combined = {
            outcome for outcome in outcomes if outcome[0] != "fall"
        }
        for terminal, was_diagnosed in outcomes:
            if terminal == "fall":
                combined.update(
                    useful_statement(statement, binding, was_diagnosed),
                )
        outcomes = combined
    return outcomes


def useful_statement(
    statement: ast.stmt,
    binding: str,
    diagnosed: bool,
) -> set[tuple[str, bool]]:
    now_diagnosed = diagnosed or statement_diagnoses_error(statement, binding)
    if isinstance(statement, ast.Raise):
        if causal_raise(statement, binding):
            return {("safe", now_diagnosed)}
        return {("terminal", now_diagnosed)}
    if isinstance(statement, ast.Return):
        return {("terminal", now_diagnosed)}
    if isinstance(statement, ast.Break):
        return {("break", now_diagnosed)}
    if isinstance(statement, ast.Continue):
        return {("continue", now_diagnosed)}
    if isinstance(statement, ast.If):
        body = useful_sequence(statement.body, binding, diagnosed)
        alternate = (
            useful_sequence(statement.orelse, binding, diagnosed)
            if statement.orelse
            else {("fall", diagnosed)}
        )
        return body | alternate
    if isinstance(statement, (ast.With, ast.AsyncWith)):
        return useful_sequence(statement.body, binding, diagnosed)
    if isinstance(statement, (ast.For, ast.AsyncFor)):
        body = useful_sequence(statement.body, binding, diagnosed)
        alternate = (
            useful_sequence(statement.orelse, binding, diagnosed)
            if statement.orelse
            else {("fall", diagnosed)}
        )
        loop_paths = {
            ("fall", seen)
            if terminal in {"fall", "break", "continue"}
            else (terminal, seen)
            for terminal, seen in body
        }
        return loop_paths | alternate | {("fall", diagnosed)}
    if isinstance(statement, ast.While):
        literal = literal_boolean(statement.test)
        alternate = (
            useful_sequence(statement.orelse, binding, diagnosed)
            if statement.orelse
            else {("fall", diagnosed)}
        )
        if literal is False:
            return alternate
        body = useful_sequence(statement.body, binding, diagnosed)
        paths: set[tuple[str, bool]] = set()
        for terminal, seen in body:
            if terminal == "break":
                paths.add(("fall", seen))
            elif terminal in {"fall", "continue"}:
                paths.add(
                    ("terminal" if literal is True else "fall", seen),
                )
            else:
                paths.add((terminal, seen))
        if literal is not True:
            paths |= alternate | {("fall", diagnosed)}
        return paths
    if isinstance(statement, (ast.Try, ast.TryStar)):
        paths = useful_sequence(statement.body, binding, diagnosed)
        for handler in statement.handlers:
            paths |= useful_sequence(handler.body, binding, diagnosed)
        if statement.orelse:
            paths |= useful_sequence(statement.orelse, binding, diagnosed)
        if statement.finalbody:
            final_paths: set[tuple[str, bool]] = set()
            for terminal, seen in paths:
                if terminal == "fall":
                    final_paths |= useful_sequence(
                        statement.finalbody,
                        binding,
                        seen,
                    )
                else:
                    final_paths.add((terminal, seen))
            paths = final_paths
        return paths
    if isinstance(statement, ast.Match):
        paths = {("fall", diagnosed)}
        for case in statement.cases:
            paths |= useful_sequence(case.body, binding, diagnosed)
        return paths
    return {("fall", now_diagnosed)}


def causal_raise(statement: ast.Raise, binding: str | None) -> bool:
    if statement.exc is None:
        return True
    if binding is None:
        return False
    if isinstance(statement.exc, ast.Name) and statement.exc.id == binding:
        return True
    return (
        statement.cause is not None
        and isinstance(statement.cause, ast.Name)
        and statement.cause.id == binding
    )


def handler_always_causal(handler: ast.ExceptHandler) -> bool:
    outcomes = causal_sequence(handler.body, handler.name)
    return outcomes == {"safe"}


def causal_sequence(
    statements: list[ast.stmt],
    binding: str | None,
) -> set[str]:
    outcomes = {"fall"}
    for statement in statements:
        next_outcomes = causal_statement(statement, binding)
        combined = {outcome for outcome in outcomes if outcome != "fall"}
        if "fall" in outcomes:
            combined.update(next_outcomes)
        outcomes = combined
    return outcomes


def causal_statement(statement: ast.stmt, binding: str | None) -> set[str]:
    if isinstance(statement, ast.Raise):
        return {"safe" if causal_raise(statement, binding) else "unsafe"}
    if isinstance(statement, ast.Return):
        return {"unsafe"}
    if isinstance(statement, ast.Break):
        return {"break"}
    if isinstance(statement, ast.Continue):
        return {"continue"}
    if isinstance(statement, ast.If):
        body = causal_sequence(statement.body, binding)
        alternate = (
            causal_sequence(statement.orelse, binding)
            if statement.orelse
            else {"fall"}
        )
        return body | alternate
    if isinstance(statement, (ast.With, ast.AsyncWith)):
        return causal_sequence(statement.body, binding)
    if isinstance(statement, (ast.For, ast.AsyncFor)):
        body = causal_sequence(statement.body, binding)
        alternate = (
            causal_sequence(statement.orelse, binding)
            if statement.orelse
            else {"fall"}
        )
        terminal = body & {"safe", "unsafe"}
        return terminal | alternate | {"fall"}
    if isinstance(statement, ast.While):
        literal = literal_boolean(statement.test)
        alternate = (
            causal_sequence(statement.orelse, binding)
            if statement.orelse
            else {"fall"}
        )
        if literal is False:
            return alternate
        body = causal_sequence(statement.body, binding)
        outcomes = body & {"safe", "unsafe"}
        if literal is True:
            if "break" in body:
                outcomes.add("fall")
            if body & {"fall", "continue"}:
                outcomes.add("unsafe")
            return outcomes
        return outcomes | alternate | {"fall"}
    if isinstance(statement, (ast.Try, ast.TryStar)):
        outcomes = causal_sequence(statement.body, binding)
        for handler in statement.handlers:
            outcomes |= causal_sequence(handler.body, binding)
        if statement.orelse:
            outcomes |= causal_sequence(statement.orelse, binding)
        if statement.finalbody:
            final = causal_sequence(statement.finalbody, binding)
            if final != {"fall"}:
                outcomes = final
        return outcomes
    if isinstance(statement, ast.Match):
        outcomes = {"fall"}
        for case in statement.cases:
            outcomes |= causal_sequence(case.body, binding)
        return outcomes
    return {"fall"}


def normalized_package(package: str) -> str:
    return re.sub(r"[-_.]+", "-", package).lower()


def requirement_package(declaration: str) -> str | None:
    requirement = re.compile(
        r"^(?P<package>[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)"
        r"(?:\[[^\]]+\])?"
        r"(?:\s*(?:===|==|~=|!=|<=|>=|<|>|@)\s*[^\s,]+"
        r"(?:\s*,\s*(?:!=|<=|>=|<|>)\s*[^\s,]+)*)?"
        r"(?:\s*;\s*.+)?$",
    )
    match = requirement.fullmatch(declaration)
    return match.group("package") if match else None


def requirement_file_is_runtime(filename: str) -> bool:
    name = filename.rsplit("/", maxsplit=1)[-1].rsplit("\\", maxsplit=1)[-1]
    if not re.fullmatch(r"requirements[^\\/]*\.txt", name, re.IGNORECASE):
        return False
    suffix = name[len("requirements") : -len(".txt")]
    excluded = {
        part
        for part in re.split(r"[-_.]+", suffix.lower())
        if part
    }
    return not excluded & {
        "build",
        "ci",
        "dev",
        "development",
        "docs",
        "lint",
        "test",
        "tests",
    }


def requirements_packages(content: str) -> set[str]:
    packages: set[str] = set()
    for line in content.splitlines():
        declaration = re.sub(r"\s+#.*$", "", line).strip()
        parsed = requirement_package(declaration)
        if parsed is not None:
            packages.add(normalized_package(parsed))
    return packages


def pyproject_packages(content: str) -> set[str]:
    try:
        document = tomllib.loads(content)
    except tomllib.TOMLDecodeError:
        return set()

    packages: set[str] = set()
    project = document.get("project")
    if isinstance(project, dict):
        dependencies = project.get("dependencies")
        if isinstance(dependencies, list):
            for declaration in dependencies:
                if isinstance(declaration, str):
                    parsed = requirement_package(declaration.strip())
                    if parsed is not None:
                        packages.add(normalized_package(parsed))

    tool = document.get("tool")
    poetry = tool.get("poetry") if isinstance(tool, dict) else None
    dependencies = (
        poetry.get("dependencies")
        if isinstance(poetry, dict)
        else None
    )
    if isinstance(dependencies, dict):
        for name, constraint in dependencies.items():
            if normalized_package(name) == "python":
                continue
            if (
                isinstance(constraint, dict)
                and constraint.get("optional") is True
            ):
                continue
            packages.add(normalized_package(name))
    return packages


def setup_packages(content: str) -> set[str]:
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return set()

    environment: dict[str, Any] = {}
    setup_symbols: set[str] = set()

    def static_requirements(node: ast.expr) -> list[str] | None:
        if isinstance(node, (ast.List, ast.Tuple)):
            declarations: list[str] = []
            for element in node.elts:
                if (
                    not isinstance(element, ast.Constant)
                    or not isinstance(element.value, str)
                ):
                    return None
                declarations.append(element.value)
            return declarations
        if isinstance(node, ast.Name):
            value = environment.get(node.id)
            return value if isinstance(value, list) else None
        return None

    def setup_call_packages(call: ast.Call) -> set[str]:
        target = dotted_target(call.func)
        if target not in setup_symbols:
            return set()
        keyword = next(
            (
                item
                for item in call.keywords
                if item.arg == "install_requires"
            ),
            None,
        )
        if keyword is None:
            return set()
        declarations = static_requirements(keyword.value)
        if declarations is None:
            return set()
        packages: set[str] = set()
        for declaration in declarations:
            parsed = requirement_package(declaration.strip())
            if parsed is not None:
                packages.add(normalized_package(parsed))
        return packages

    def execute(statements: list[ast.stmt]) -> set[str]:
        packages: set[str] = set()
        for statement in statements:
            if isinstance(statement, ast.Import):
                for alias in statement.names:
                    if alias.name == "setuptools":
                        binding = alias.asname or "setuptools"
                        setup_symbols.add(f"{binding}.setup")
            elif isinstance(statement, ast.ImportFrom):
                if statement.level == 0 and statement.module == "setuptools":
                    for alias in statement.names:
                        if alias.name == "setup":
                            setup_symbols.add(alias.asname or "setup")
            elif isinstance(statement, ast.Assign):
                value = static_requirements(statement.value)
                for target in statement.targets:
                    if isinstance(target, ast.Name):
                        environment[target.id] = value
                        setup_symbols.discard(target.id)
            elif isinstance(statement, ast.AnnAssign):
                if isinstance(statement.target, ast.Name):
                    environment[statement.target.id] = (
                        static_requirements(statement.value)
                        if statement.value is not None
                        else None
                    )
                    setup_symbols.discard(statement.target.id)
            elif isinstance(statement, ast.Expr) and isinstance(
                statement.value,
                ast.Call,
            ):
                packages |= setup_call_packages(statement.value)
            elif isinstance(statement, ast.If):
                literal = literal_boolean(statement.test)
                if literal is not False:
                    packages |= execute(statement.body)
                if literal is not True:
                    packages |= execute(statement.orelse)
            elif isinstance(statement, (ast.Try, ast.TryStar)):
                packages |= execute(statement.body)
                packages |= execute(statement.orelse)
                packages |= execute(statement.finalbody)
                for handler in statement.handlers:
                    packages |= execute(handler.body)
            elif isinstance(statement, (ast.With, ast.AsyncWith)):
                packages |= execute(statement.body)
        return packages

    return execute(tree.body)


def declares_package(
    dependency_manifests: list[dict[str, str]],
    package: str,
) -> bool:
    expected = normalized_package(package)
    for manifest in dependency_manifests:
        filename = manifest["filename"]
        content = manifest["content"]
        if requirement_file_is_runtime(filename):
            packages = requirements_packages(content)
        elif filename.lower() == "pyproject.toml":
            packages = pyproject_packages(content)
        elif filename.lower() == "setup.py":
            packages = setup_packages(content)
        else:
            packages = set()
        if expected in packages:
            return True
    return False


def dependency_manifests_from_payload(
    payload: dict[str, Any],
) -> list[dict[str, str]]:
    manifests = payload.get("dependencyManifests")
    if not isinstance(manifests, list):
        raise ValueError("dependencyManifests must be a list")
    if not all(
        isinstance(manifest, dict)
        and isinstance(manifest.get("filename"), str)
        and isinstance(manifest.get("content"), str)
        for manifest in manifests
    ):
        raise ValueError(
            "dependencyManifests entries require filename and content strings",
        )
    return manifests


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        sources = payload.get("sources", [])
        if not isinstance(sources, list) or not all(
            isinstance(source, str) for source in sources
        ):
            raise ValueError("sources must be a list of strings")
        dependency_manifests = dependency_manifests_from_payload(payload)
        print(
            json.dumps(
                Analyzer(sources, dependency_manifests).analyze(),
            ),
        )
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        print(f"Invalid analyzer input: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
