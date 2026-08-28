from __future__ import annotations

import ast
import json
import posixpath
import re
import sys
import tomllib
from dataclasses import dataclass, field
from string import Formatter
from typing import Any


OP_FLAG = "operation:"
ACCOUNT_FLAG = "storage-account-name"
FIELD_FLAG = "field:"
MODEL_FLAG = "model:"


@dataclass
class Value:
    kind: str
    data: Any = None
    flags: frozenset[str] = frozenset()


@dataclass
class Function:
    node: ast.FunctionDef | ast.AsyncFunctionDef
    closure: dict[str, Value]
    scope: str


@dataclass
class Class:
    methods: dict[str, Function]


@dataclass
class Object:
    class_info: Class
    members: dict[str, Value] = field(default_factory=dict)


@dataclass(frozen=True)
class Client:
    identifier: int
    is_async: bool = False


@dataclass
class Pending:
    receiver: Value | None = None
    method: str | None = None
    function: Function | None = None
    positional: tuple[Value, ...] = ()
    named: dict[str, Value] = field(default_factory=dict)
    consumed: bool = False


@dataclass(frozen=True)
class Operation:
    identifier: int
    kind: str
    client: int
    order: int
    related: int | None
    guards: frozenset[tuple[int, str]]
    try_stack: tuple[int, ...]


@dataclass
class Flow:
    environment: dict[str, Value]
    normal: bool = True
    returned: list[Value] = field(default_factory=list)
    guards: frozenset[tuple[int, str]] = frozenset()


@dataclass
class Handler:
    node: ast.ExceptHandler
    environment: dict[str, Value]


@dataclass
class Try:
    identifier: int
    handlers: list[Handler]
    may_throw: bool


@dataclass(frozen=True)
class Document:
    path: str
    source: str


def unknown(flags: frozenset[str] = frozenset()) -> Value:
    return Value("unknown", flags=flags)


def value_flags(value: Value, seen: set[int] | None = None) -> frozenset[str]:
    flags = value.flags
    if value.kind != "object":
        return flags
    seen = seen or set()
    identity = id(value.data)
    if identity in seen:
        return flags
    seen.add(identity)
    for member in value.data.members.values():
        flags |= value_flags(member, seen)
    return flags


def signature(value: Value) -> tuple[Any, ...]:
    if value.kind in {"function", "class", "module", "object", "pending"}:
        return value.kind, id(value.data), value.flags
    if value.kind == "tuple":
        return (
            value.kind,
            tuple(signature(item) for item in value.data),
            value.flags,
        )
    return value.kind, value.data, value.flags


def merge_values(values: list[Value]) -> Value:
    if not values:
        return unknown()
    first = signature(values[0])
    if all(signature(value) == first for value in values[1:]):
        return values[0]
    flags = frozenset().union(*(value_flags(value) for value in values))
    return unknown(flags)


def merge_environments(environments: list[dict[str, Value]]) -> dict[str, Value]:
    keys = set().union(*(environment for environment in environments))
    return {
        key: merge_values(
            [environment.get(key, unknown()) for environment in environments],
        )
        for key in keys
    }


def dotted(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        if parent is not None:
            return f"{parent}.{node.attr}"
    return None


def canonical_exception(
    node: ast.expr | None,
    environment: dict[str, Value],
) -> str | None:
    if node is None or isinstance(node, ast.Tuple):
        return None
    value = static_symbol(node, environment)
    return value.data if value.kind == "symbol" else None


def canonical_exception_members(
    node: ast.expr | None,
    environment: dict[str, Value],
) -> set[str]:
    if node is None:
        return {"builtins.BaseException"}
    if isinstance(node, ast.Tuple):
        return set().union(
            *(
                canonical_exception_members(item, environment)
                for item in node.elts
            ),
        )
    exception = canonical_exception(node, environment)
    return {exception} if exception is not None else set()


def static_symbol(node: ast.expr, environment: dict[str, Value]) -> Value:
    if isinstance(node, ast.Name):
        return environment.get(node.id, unknown())
    if isinstance(node, ast.Attribute):
        base = static_symbol(node.value, environment)
        if base.kind == "symbol":
            return Value("symbol", f"{base.data}.{node.attr}")
        if base.kind == "module":
            return base.data.get(node.attr, unknown())
    return unknown()


class Analyzer:
    def __init__(
        self,
        documents: list[Document],
        dependency_manifests: list[dict[str, str]],
    ) -> None:
        self.documents = documents
        self.dependency_manifests = dependency_manifests
        self.parse_error = False
        self.has_source = False
        self.seen_environment: set[tuple[str, str | None]] = set()
        self.credential_count = 0
        self.management_client_count = 0
        self.valid_client_count = 0
        self.forbidden_operation = False
        self.operations: list[Operation] = []
        self.operations_by_id: dict[int, Operation] = {}
        self.invalid_kinds: set[str] = set()
        self.counter = 0
        self.try_counter = 0
        self.try_infos: list[Try] = []
        self.try_stack: list[int] = []
        self.guards: list[tuple[int, str]] = []
        self.scopes: list[str] = []
        self.call_stack: set[int] = set()
        self.trees: dict[str, ast.Module] = {}
        self.module_paths: dict[str, str | None] = {}
        self.primary_module_names: dict[str, str] = {}
        self.module_environments: dict[str, dict[str, Value]] = {}
        self.executing_modules: set[str] = set()
        self.module_stack: list[str] = []
        self.document_paths = {document.path for document in documents}

    def analyze(self) -> dict[str, bool]:
        for document in self.documents:
            try:
                tree = ast.parse(document.source, filename=document.path)
            except SyntaxError:
                self.parse_error = True
                continue
            if any(not is_docstring(statement) for statement in tree.body):
                self.has_source = True
            self.trees[document.path] = tree
            self.register_module(document.path)

        imported_paths = self.imported_module_paths()
        roots = [
            document.path
            for document in self.documents
            if document.path in self.trees and document.path not in imported_paths
        ]
        for path in roots:
            self.execute_module(path, as_import=False)
        for document in self.documents:
            if (
                document.path in self.trees
                and document.path not in self.module_environments
            ):
                self.execute_module(document.path, as_import=False)

        valid_source = self.has_source and not self.parse_error
        packages = (
            valid_source
            and declares_package(self.dependency_manifests, "azure-identity")
            and declares_package(
                self.dependency_manifests,
                "azure-mgmt-storage",
            )
        )
        configuration = valid_source and {
            ("AZURE_SUBSCRIPTION_ID", None),
            ("AZURE_RESOURCE_GROUP_NAME", None),
            ("AZURE_STORAGE_ACCOUNT_NAME", None),
            ("AZURE_LOCATION", "eastus"),
        }.issubset(self.seen_environment)
        client = (
            valid_source
            and not self.forbidden_operation
            and self.management_client_count == 1
            and self.valid_client_count == 1
            and self.credential_count == 1
        )
        create = configuration and client and self.has_prefix(
            ("create", "create-complete"),
        )
        listed = create and self.has_prefix(
            (
                "create",
                "create-complete",
                "list",
                "list-iterate",
                "list-output",
            ),
        )
        got = listed and self.has_prefix(
            (
                "create",
                "create-complete",
                "list",
                "list-iterate",
                "list-output",
                "get",
                "get-output",
            ),
        )
        updated = got and self.has_prefix(
            (
                "create",
                "create-complete",
                "list",
                "list-iterate",
                "list-output",
                "get",
                "get-output",
                "versioning",
                "versioning-output",
            ),
        )
        chains = self.lifecycle_chains() if updated else []
        deleted = bool(chains)
        return {
            "prompt/sdk-packages": packages,
            "prompt/configuration": configuration,
            "prompt/authenticated-management-client": client,
            "prompt/create-storage-account": create,
            "prompt/list-storage-accounts": listed,
            "prompt/get-storage-account-properties": got,
            "prompt/enable-blob-versioning": updated,
            "prompt/delete-storage-account": deleted,
            "prompt/sdk-error-handling": deleted
            and self.sdk_errors_are_valid(chains),
        }

    @staticmethod
    def base_environment(module_name: str) -> dict[str, Value]:
        return {
            "__name__": Value("string", module_name),
            "dict": Value("symbol", "builtins.dict"),
            "list": Value("symbol", "builtins.list"),
            "object": Value("symbol", "builtins.object"),
            "print": Value("symbol", "builtins.print"),
            "str": Value("symbol", "builtins.str"),
            "Exception": Value("symbol", "builtins.Exception"),
            "BaseException": Value("symbol", "builtins.BaseException"),
            "RuntimeError": Value("symbol", "builtins.RuntimeError"),
            "ValueError": Value("symbol", "builtins.ValueError"),
        }

    def register_module(self, path: str) -> None:
        parts = path.removesuffix(".py").split("/")
        if parts[-1] == "__init__":
            parts.pop()
        aliases = [".".join(parts)]
        if parts and parts[0] == "src":
            aliases.append(".".join(parts[1:]))
        aliases = [alias for alias in aliases if alias]
        self.primary_module_names[path] = aliases[-1] if aliases else path
        for alias in aliases:
            if alias not in self.module_paths:
                self.module_paths[alias] = path
            elif self.module_paths[alias] != path:
                self.module_paths[alias] = None

    def resolve_module(
        self,
        module: str,
        *,
        level: int = 0,
        importer: str | None = None,
    ) -> str | None:
        name = module
        if level:
            if importer is None:
                return None
            current = self.primary_module_names.get(importer, "")
            package = (
                current
                if importer.endswith("/__init__.py")
                else current.rpartition(".")[0]
            )
            parts = [part for part in package.split(".") if part]
            remove = level - 1
            if remove > len(parts):
                return None
            base = parts[: len(parts) - remove] if remove else parts
            if module:
                base.extend(module.split("."))
            name = ".".join(base)
        path = self.module_paths.get(name)
        if (
            path is not None
            and importer is not None
            and not level
            and path.startswith("src/") != importer.startswith("src/")
            and not name.startswith("src.")
        ):
            return None
        return path

    def imported_module_paths(self) -> set[str]:
        imported: set[str] = set()
        for importer, tree in self.trees.items():
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        path = self.resolve_module(alias.name, importer=importer)
                        if path is not None:
                            imported.add(path)
                elif isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    path = self.resolve_module(
                        module,
                        level=node.level,
                        importer=importer,
                    )
                    if path is not None:
                        imported.add(path)
                    for alias in node.names:
                        child = ".".join(
                            part for part in (module, alias.name) if part
                        )
                        child_path = self.resolve_module(
                            child,
                            level=node.level,
                            importer=importer,
                        )
                        if child_path is not None:
                            imported.add(child_path)
        return imported

    def execute_module(
        self,
        path: str,
        *,
        as_import: bool,
    ) -> dict[str, Value]:
        existing = self.module_environments.get(path)
        if existing is not None:
            return existing
        tree = self.trees[path]
        module_name = (
            self.primary_module_names.get(path, path)
            if as_import
            else "__main__"
        )
        environment = self.base_environment(module_name)
        self.module_environments[path] = environment
        self.executing_modules.add(path)
        self.module_stack.append(path)
        scope = f"module:{path}"
        self.scopes.append(scope)
        for statement in tree.body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                environment[statement.name] = Value(
                    "function",
                    Function(statement, environment, f"{scope}:{statement.name}"),
                )
            elif isinstance(statement, ast.ClassDef):
                environment[statement.name] = Value(
                    "class",
                    self.make_class(statement, environment, scope),
                )
        try:
            flow = self.execute_block(tree.body, environment)
            environment.clear()
            environment.update(flow.environment)
        finally:
            self.scopes.pop()
            self.module_stack.pop()
            self.executing_modules.discard(path)
        return environment

    @staticmethod
    def make_class(
        node: ast.ClassDef,
        environment: dict[str, Value],
        scope: str,
    ) -> Class:
        return Class(
            {
                statement.name: Function(
                    statement,
                    environment,
                    f"{scope}:{node.name}:{statement.name}",
                )
                for statement in node.body
                if isinstance(
                    statement,
                    (ast.FunctionDef, ast.AsyncFunctionDef),
                )
            },
        )

    def execute_block(
        self,
        statements: list[ast.stmt],
        environment: dict[str, Value],
    ) -> Flow:
        current = environment.copy()
        returned: list[Value] = []
        active_guards = frozenset(self.guards)
        normal = True
        saved = list(self.guards)
        try:
            for statement in statements:
                if not normal:
                    break
                self.guards[:] = active_guards
                flow = self.execute_statement(statement, current)
                current = flow.environment
                returned.extend(flow.returned)
                normal = flow.normal
                active_guards = flow.guards
        finally:
            self.guards[:] = saved
        return Flow(current, normal, returned, active_guards)

    def execute_statement(
        self,
        statement: ast.stmt,
        environment: dict[str, Value],
    ) -> Flow:
        current = environment.copy()
        if isinstance(statement, (ast.Import, ast.ImportFrom)):
            self.bind_import(statement, current)
            return Flow(current, guards=frozenset(self.guards))
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            existing = current.get(statement.name)
            function = (
                existing.data
                if existing is not None
                and existing.kind == "function"
                and existing.data.node is statement
                else Function(
                    statement,
                    current,
                    f"{self.scope()}:{statement.name}:{statement.lineno}",
                )
            )
            function.closure = current.copy()
            current[statement.name] = Value("function", function)
            return Flow(current, guards=frozenset(self.guards))
        if isinstance(statement, ast.ClassDef):
            existing = current.get(statement.name)
            class_info = (
                existing.data
                if existing is not None and existing.kind == "class"
                else self.make_class(statement, current, self.scope())
            )
            for function in class_info.methods.values():
                function.closure = current.copy()
            current[statement.name] = Value("class", class_info)
            return Flow(current, guards=frozenset(self.guards))
        if isinstance(statement, (ast.Assign, ast.AnnAssign)):
            expression = statement.value
            value = self.expression(expression, current)
            targets = (
                statement.targets
                if isinstance(statement, ast.Assign)
                else [statement.target]
            )
            for target in targets:
                self.assign(target, value, current)
            return Flow(current, guards=frozenset(self.guards))
        if isinstance(statement, ast.AugAssign):
            self.assign(statement.target, unknown(), current)
            return Flow(current, guards=frozenset(self.guards))
        if isinstance(statement, ast.Expr):
            self.expression(statement.value, current)
            return Flow(current, guards=frozenset(self.guards))
        if isinstance(statement, ast.Return):
            value = self.expression(statement.value, current)
            return Flow(
                current,
                False,
                [value],
                frozenset(self.guards),
            )
        if isinstance(statement, ast.Raise):
            self.expression(statement.exc, current)
            return Flow(current, False, guards=frozenset(self.guards))
        if isinstance(statement, ast.If):
            condition = self.boolean(statement.test, current)
            if condition is True:
                return self.execute_block(statement.body, current)
            if condition is False:
                return self.execute_block(statement.orelse, current)
            branch = id(statement)
            body = self.guarded_block(branch, "body", statement.body, current)
            alternate = self.guarded_block(
                branch,
                "else",
                statement.orelse,
                current,
            )
            return self.merge_flows([body, alternate], current)
        if isinstance(statement, (ast.For, ast.AsyncFor)):
            iterable = self.expression(statement.iter, current)
            if iterable.kind == "empty":
                return self.execute_block(statement.orelse, current)
            body_environment = current.copy()
            if iterable.kind == "storage-accounts":
                source = self.operations_by_id[iterable.data]
                self.record("list-iterate", source.client, related=source.identifier)
                item = Value(
                    "storage-account-result",
                    source.identifier,
                    frozenset({f"{OP_FLAG}{source.identifier}"}),
                )
            elif iterable.kind == "tuple":
                item = merge_values(list(iterable.data))
            else:
                item = unknown(value_flags(iterable))
            self.assign(statement.target, item, body_environment)
            body = self.execute_block(statement.body, body_environment)
            alternate = self.execute_block(statement.orelse, current)
            return self.merge_flows(
                [Flow(current, guards=frozenset(self.guards)), body, alternate],
                current,
            )
        if isinstance(statement, ast.While):
            condition = self.boolean(statement.test, current)
            if condition is False:
                return self.execute_block(statement.orelse, current)
            body = self.execute_block(statement.body, current)
            alternate = self.execute_block(statement.orelse, current)
            flows = [body, alternate]
            if condition is not True:
                flows.append(Flow(current, guards=frozenset(self.guards)))
            return self.merge_flows(flows, current)
        if isinstance(statement, (ast.With, ast.AsyncWith)):
            body_environment = current.copy()
            for item in statement.items:
                value = self.expression(item.context_expr, body_environment)
                if item.optional_vars is not None:
                    self.assign(item.optional_vars, value, body_environment)
            return self.execute_block(statement.body, body_environment)
        if isinstance(statement, (ast.Try, ast.TryStar)):
            return self.execute_try(statement, current)
        if isinstance(statement, ast.Match):
            branch = id(statement)
            flows = [
                self.guarded_block(
                    branch,
                    f"case:{index}",
                    case.body,
                    current,
                )
                for index, case in enumerate(statement.cases)
            ]
            flows.append(Flow(current, guards=frozenset(self.guards)))
            return self.merge_flows(flows, current)
        return Flow(current, guards=frozenset(self.guards))

    def guarded_block(
        self,
        branch: int,
        arm: str,
        statements: list[ast.stmt],
        environment: dict[str, Value],
    ) -> Flow:
        self.guards.append((branch, arm))
        try:
            return self.execute_block(statements, environment)
        finally:
            self.guards.pop()

    def execute_try(
        self,
        statement: ast.Try | ast.TryStar,
        environment: dict[str, Value],
    ) -> Flow:
        self.try_counter += 1
        identifier = self.try_counter
        self.try_infos.append(
            Try(
                identifier,
                [
                    Handler(handler, environment.copy())
                    for handler in statement.handlers
                ],
                block_may_throw(statement.body),
            ),
        )
        self.try_stack.append(identifier)
        body = self.guarded_block(
            id(statement),
            "body",
            statement.body,
            environment,
        )
        self.try_stack.pop()
        if body.normal and statement.orelse:
            body = self.execute_block(statement.orelse, body.environment)
        branches = [body]
        for index, handler in enumerate(statement.handlers):
            handler_environment = environment.copy()
            if handler.name:
                handler_environment[handler.name] = unknown()
            branches.append(
                self.guarded_block(
                    id(statement),
                    f"handler:{index}",
                    handler.body,
                    handler_environment,
                ),
            )
        merged = self.merge_flows(branches, environment)
        if statement.finalbody:
            return self.execute_block(statement.finalbody, merged.environment)
        return merged

    @staticmethod
    def merge_flows(flows: list[Flow], fallback: dict[str, Value]) -> Flow:
        normal = [flow for flow in flows if flow.normal]
        returned = [value for flow in flows for value in flow.returned]
        if not normal:
            return Flow(fallback.copy(), False, returned)
        common = set(normal[0].guards)
        for flow in normal[1:]:
            common.intersection_update(flow.guards)
        return Flow(
            merge_environments([flow.environment for flow in normal]),
            True,
            returned,
            frozenset(common),
        )

    def bind_import(
        self,
        statement: ast.Import | ast.ImportFrom,
        environment: dict[str, Value],
    ) -> None:
        importer = self.module_stack[-1] if self.module_stack else None
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                local_path = self.resolve_module(
                    alias.name,
                    importer=importer,
                )
                if local_path is not None:
                    module = Value(
                        "module",
                        self.execute_module(local_path, as_import=True),
                    )
                    if alias.asname:
                        environment[alias.asname] = module
                    else:
                        self.bind_local_import_root(
                            environment,
                            alias.name,
                            module,
                        )
                    continue
                if self.azure_import_is_shadowed(alias.name, importer):
                    environment[alias.asname or alias.name.split(".")[0]] = (
                        unknown()
                    )
                    continue
                if alias.asname:
                    environment[alias.asname] = Value("symbol", alias.name)
                else:
                    root = alias.name.split(".", maxsplit=1)[0]
                    environment[root] = Value("symbol", root)
            return
        module = statement.module or ""
        local_path = self.resolve_module(
            module,
            level=statement.level,
            importer=importer,
        )
        local_environment = (
            self.execute_module(local_path, as_import=True)
            if local_path is not None
            else None
        )
        for alias in statement.names:
            if alias.name == "*":
                if local_environment is not None:
                    environment.update(
                        {
                            name: value
                            for name, value in local_environment.items()
                            if not name.startswith("_")
                        },
                    )
                continue
            if local_environment is not None:
                value = local_environment.get(alias.name)
                if value is None:
                    child_name = ".".join(
                        part for part in (module, alias.name) if part
                    )
                    child_path = self.resolve_module(
                        child_name,
                        level=statement.level,
                        importer=importer,
                    )
                    value = (
                        Value(
                            "module",
                            self.execute_module(child_path, as_import=True),
                        )
                        if child_path is not None
                        else unknown()
                    )
                environment[alias.asname or alias.name] = value
                continue
            imported = ".".join(
                part for part in (module, alias.name) if part
            )
            child_path = self.resolve_module(
                imported,
                level=statement.level,
                importer=importer,
            )
            if child_path is not None:
                environment[alias.asname or alias.name] = Value(
                    "module",
                    self.execute_module(child_path, as_import=True),
                )
                continue
            if statement.level or self.azure_import_is_shadowed(
                imported,
                importer,
            ):
                environment[alias.asname or alias.name] = unknown()
            else:
                environment[alias.asname or alias.name] = Value(
                    "symbol",
                    imported,
                )

    @staticmethod
    def bind_local_import_root(
        environment: dict[str, Value],
        name: str,
        module: Value,
    ) -> None:
        parts = name.split(".")
        value = module
        for part in reversed(parts[1:]):
            value = Value("module", {part: value})
        environment[parts[0]] = value

    def azure_import_is_shadowed(
        self,
        imported: str,
        importer: str | None,
    ) -> bool:
        relevant = (
            imported == "azure"
            or imported.startswith("azure.identity")
            or imported == "azure.mgmt"
            or imported.startswith("azure.mgmt.storage")
        )
        if not relevant or importer is None:
            return False
        roots = ["src"] if importer.startswith("src/") else [""]
        directory = posixpath.dirname(importer)
        if directory and directory not in roots:
            roots.append(directory)
        prefixes = imported.split(".")
        candidates: set[str] = set()
        for index in range(1, len(prefixes) + 1):
            relative = "/".join(prefixes[:index])
            candidates.add(f"{relative}.py")
            candidates.add(f"{relative}/__init__.py")
        for root in roots:
            for candidate in candidates:
                path = posixpath.join(root, candidate) if root else candidate
                if path in self.document_paths:
                    return True
        return False

    def assign(
        self,
        target: ast.expr,
        value: Value,
        environment: dict[str, Value],
    ) -> None:
        if isinstance(target, ast.Name):
            environment[target.id] = value
        elif isinstance(target, ast.Attribute):
            base = self.expression(target.value, environment)
            if base.kind == "object":
                base.data.members[target.attr] = value
            name = dotted(target)
            if name is not None:
                environment[name] = value
        elif isinstance(target, ast.Subscript):
            base = self.expression(target.value, environment)
            key = self.expression(target.slice, environment)
            if base.kind in {"mapping", "model"} and key.kind == "string":
                base.data[key.data] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            values = value.data if value.kind == "tuple" else ()
            for index, child in enumerate(target.elts):
                item = values[index] if index < len(values) else unknown()
                self.assign(child, item, environment)

    def expression(
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
            name = dotted(node)
            if name is not None and name in environment:
                return environment[name]
            base = self.expression(node.value, environment)
            if base.kind == "symbol":
                return Value("symbol", f"{base.data}.{node.attr}")
            if base.kind == "module":
                return base.data.get(node.attr, unknown(value_flags(base)))
            if base.kind == "client" and node.attr == "storage_accounts":
                return Value("storage-account-operations", base.data)
            if base.kind == "client" and node.attr == "blob_services":
                return Value("blob-service-operations", base.data)
            if base.kind == "client" and node.attr == "resource_groups":
                self.forbidden_operation = True
                return unknown()
            if base.kind in {
                "storage-account-operations",
                "blob-service-operations",
                "poller",
            }:
                return Value("bound-sdk", (base, node.attr))
            if base.kind == "object":
                member = base.data.members.get(node.attr)
                if member is not None:
                    return member
                function = base.data.class_info.methods.get(node.attr)
                if function is not None:
                    return Value("bound-function", (function, base))
            if base.kind == "class":
                function = base.data.methods.get(node.attr)
                if function is not None:
                    return Value("function", function)
            if base.kind == "storage-account-result":
                field_flag = f"{FIELD_FLAG}{base.data}:{node.attr}"
                return Value(
                    "result-field",
                    (base.data, node.attr),
                    base.flags | frozenset({field_flag}),
                )
            if base.kind in {"mapping", "model"}:
                return base.data.get(node.attr, unknown(value_flags(base)))
            return unknown(value_flags(base))
        if isinstance(node, ast.Subscript):
            base = self.expression(node.value, environment)
            key = self.expression(node.slice, environment)
            if (
                base.kind == "symbol"
                and base.data == "os.environ"
                and key.kind == "string"
            ):
                return self.environment(key.data)
            if (
                base.kind in {"mapping", "model"}
                and key.kind in {"string", "literal"}
            ):
                return base.data.get(key.data, unknown(value_flags(base)))
            return unknown(value_flags(base) | value_flags(key))
        if isinstance(node, ast.Dict):
            members: dict[Any, Value] = {}
            flags = frozenset()
            for key_node, value_node in zip(node.keys, node.values, strict=True):
                key = self.expression(key_node, environment)
                value = self.expression(value_node, environment)
                if key.kind in {"string", "literal"}:
                    members[key.data] = value
                flags |= value_flags(key) | value_flags(value)
            return Value("mapping", members, flags)
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            values = tuple(self.expression(item, environment) for item in node.elts)
            if not values:
                return Value("empty")
            flags = frozenset().union(*(value_flags(value) for value in values))
            return Value("tuple", values, flags)
        if isinstance(node, ast.Call):
            return self.call(node, environment)
        if isinstance(node, ast.Await):
            value = self.expression(node.value, environment)
            if value.kind == "pending":
                return self.consume(value)
            if value.kind == "storage-accounts":
                self.invalid_kinds.add("list")
            for flag in value_flags(value):
                if flag.startswith(OP_FLAG):
                    source = self.operations_by_id.get(
                        int(flag.removeprefix(OP_FLAG)),
                    )
                    if source is not None:
                        self.invalid_kinds.add(source.kind)
            return unknown(value_flags(value))
        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
            return self.comprehension(node, environment)
        if isinstance(node, ast.JoinedStr):
            values = [
                self.expression(
                    value.value if isinstance(value, ast.FormattedValue) else value,
                    environment,
                )
                for value in node.values
            ]
            flags = frozenset().union(*(value_flags(value) for value in values))
            if all(value.kind in {"string", "literal"} for value in values):
                return Value(
                    "string",
                    "".join(str(value.data) for value in values),
                    flags,
                )
            return Value("formatted", flags=flags)
        if isinstance(node, ast.FormattedValue):
            return self.expression(node.value, environment)
        if isinstance(node, ast.BinOp):
            left = self.expression(node.left, environment)
            right = self.expression(node.right, environment)
            flags = value_flags(left) | value_flags(right)
            if (
                isinstance(node.op, ast.Add)
                and left.kind == right.kind == "string"
            ):
                return Value("string", left.data + right.data, flags)
            return unknown(flags)
        if isinstance(node, ast.IfExp):
            condition = self.boolean(node.test, environment)
            if condition is True:
                return self.expression(node.body, environment)
            if condition is False:
                return self.expression(node.orelse, environment)
            branch = id(node)
            self.guards.append((branch, "body"))
            body = self.expression(node.body, environment)
            self.guards.pop()
            self.guards.append((branch, "else"))
            alternate = self.expression(node.orelse, environment)
            self.guards.pop()
            return merge_values([body, alternate])
        if isinstance(node, ast.BoolOp):
            values = [self.expression(value, environment) for value in node.values]
            return merge_values(values)
        if isinstance(node, (ast.Compare, ast.UnaryOp)):
            result = self.boolean(node, environment)
            return Value("literal", result) if result is not None else unknown()
        return unknown()

    def comprehension(
        self,
        node: ast.ListComp | ast.SetComp | ast.GeneratorExp,
        environment: dict[str, Value],
    ) -> Value:
        current = environment.copy()
        for generator in node.generators:
            iterable = self.expression(generator.iter, current)
            if iterable.kind == "empty":
                return Value("empty")
            if iterable.kind == "storage-accounts":
                source = self.operations_by_id[iterable.data]
                self.record(
                    "list-iterate",
                    source.client,
                    related=source.identifier,
                )
                item = Value(
                    "storage-account-result",
                    source.identifier,
                    frozenset({f"{OP_FLAG}{source.identifier}"}),
                )
            elif iterable.kind == "tuple":
                item = merge_values(list(iterable.data))
            else:
                item = unknown(value_flags(iterable))
            self.assign(generator.target, item, current)
            if any(self.boolean(condition, current) is False for condition in generator.ifs):
                return Value("empty")
        result = self.expression(node.elt, current)
        return Value("tuple", (result,), value_flags(result))

    def boolean(
        self,
        node: ast.expr,
        environment: dict[str, Value],
    ) -> bool | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, bool):
            return node.value
        if isinstance(node, (ast.Name, ast.Attribute)):
            value = self.expression(node, environment)
            if value.kind == "literal" and isinstance(value.data, bool):
                return value.data
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            result = self.boolean(node.operand, environment)
            return None if result is None else not result
        if isinstance(node, ast.BoolOp):
            values = [self.boolean(value, environment) for value in node.values]
            if isinstance(node.op, ast.And):
                return False if False in values else True if None not in values else None
            return True if True in values else False if None not in values else None
        if (
            isinstance(node, ast.Compare)
            and len(node.ops) == 1
            and len(node.comparators) == 1
        ):
            left = self.expression(node.left, environment)
            right = self.expression(node.comparators[0], environment)
            if left.kind in {"string", "literal"} and right.kind == left.kind:
                if isinstance(node.ops[0], ast.Eq):
                    return left.data == right.data
                if isinstance(node.ops[0], ast.NotEq):
                    return left.data != right.data
        return None

    def call(
        self,
        node: ast.Call,
        environment: dict[str, Value],
    ) -> Value:
        receiver = (
            self.expression(node.func.value, environment)
            if isinstance(node.func, ast.Attribute)
            else None
        )
        method = node.func.attr if isinstance(node.func, ast.Attribute) else None
        function = self.expression(node.func, environment)
        positional = [self.expression(value, environment) for value in node.args]
        named = {
            item.arg: self.expression(item.value, environment)
            for item in node.keywords
            if item.arg is not None
        }
        flags = frozenset().union(
            *(value_flags(value) for value in [*positional, *named.values()]),
        )
        if receiver is not None:
            flags |= value_flags(receiver)
        if function.kind == "bound-sdk":
            receiver, method = function.data
        if function.kind == "function":
            if isinstance(function.data.node, ast.AsyncFunctionDef):
                return Value(
                    "pending",
                    Pending(
                        function=function.data,
                        positional=tuple(positional),
                        named=named,
                    ),
                )
            return self.invoke(function.data, positional, named)
        if function.kind == "bound-function":
            info, instance = function.data
            values = [instance, *positional]
            if isinstance(info.node, ast.AsyncFunctionDef):
                return Value(
                    "pending",
                    Pending(
                        function=info,
                        positional=tuple(values),
                        named=named,
                    ),
                )
            return self.invoke(info, values, named)
        if function.kind == "class":
            instance = Value("object", Object(function.data), flags)
            initializer = function.data.methods.get("__init__")
            if initializer is not None:
                self.invoke(initializer, [instance, *positional], named)
            return instance

        canonical = function.data if function.kind == "symbol" else None
        if canonical in {
            "azure.identity.DefaultAzureCredential",
            "azure.identity.aio.DefaultAzureCredential",
        }:
            self.credential_count += 1
            return Value("credential", id(node))
        if canonical == "asyncio.run" and positional:
            return self.consume(positional[0])
        if canonical in {
            "azure.mgmt.storage.StorageManagementClient",
            "azure.mgmt.storage.aio.StorageManagementClient",
        }:
            return self.management_client(
                node,
                positional,
                named,
                canonical.endswith(".aio.StorageManagementClient"),
            )
        if canonical in {
            "azure.mgmt.storage.models.StorageAccountCreateParameters",
            "azure.mgmt.storage.models.Sku",
            "azure.mgmt.storage.models.BlobServiceProperties",
        }:
            return Value(
                "model",
                dict(named),
                flags | frozenset({f"{MODEL_FLAG}{canonical}"}),
            )
        if canonical == "azure.mgmt.resource.ResourceManagementClient":
            self.forbidden_operation = True
            return unknown()
        if canonical == "builtins.print":
            self.record_output([*positional, *named.values()])
            return Value("none")
        if canonical == "builtins.str" and positional:
            return Value("formatted", flags=value_flags(positional[0]))
        if canonical == "builtins.dict":
            return Value("mapping", dict(named), flags)
        if canonical in {"builtins.list", "builtins.object"}:
            return Value("mapping", {}, flags)
        if (
            receiver is not None
            and receiver.kind == "symbol"
            and receiver.data == "os"
            and method == "getenv"
        ):
            return self.getenv(positional, named)
        if (
            receiver is not None
            and receiver.kind == "symbol"
            and receiver.data == "os.environ"
            and method == "get"
        ):
            return self.getenv(positional, named)
        if receiver is not None and receiver.kind == "storage-account-operations":
            if method in {
                "begin_create",
                "list_by_resource_group",
                "get_properties",
                "begin_delete",
            }:
                if method == "list_by_resource_group":
                    return self.sdk_call(receiver, method, positional, named)
                if receiver.data.is_async:
                    return Value(
                        "pending",
                        Pending(
                            receiver=receiver,
                            method=method,
                            positional=tuple(positional),
                            named=named,
                        ),
                    )
                return self.sdk_call(receiver, method, positional, named)
            if method == "list_keys":
                self.forbidden_operation = True
                return unknown()
        if (
            receiver is not None
            and receiver.kind == "blob-service-operations"
            and method == "set_service_properties"
        ):
            if receiver.data.is_async:
                return Value(
                    "pending",
                    Pending(
                        receiver=receiver,
                        method=method,
                        positional=tuple(positional),
                        named=named,
                    ),
                )
            return self.sdk_call(receiver, method, positional, named)
        if receiver is not None and receiver.kind == "poller" and method in {
            "result",
            "wait",
        }:
            if receiver.data[3]:
                return Value(
                    "pending",
                    Pending(receiver=receiver, method=method),
                )
            return self.poller_call(receiver, method)
        if method == "format":
            return Value("formatted", flags=flags)
        if method in {
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
        return unknown(flags)

    def getenv(
        self,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        key = argument(positional, named, 0, "key")
        default = argument(positional, named, 1, "default")
        if key is None or key.kind != "string":
            return unknown()
        default_value = default.data if default is not None and default.kind == "string" else None
        return self.environment(key.data, default_value)

    def environment(self, key: str, default: str | None = None) -> Value:
        self.seen_environment.add((key, default))
        flags = (
            frozenset({ACCOUNT_FLAG})
            if key == "AZURE_STORAGE_ACCOUNT_NAME"
            else frozenset()
        )
        return Value("environment", (key, default), flags)

    def management_client(
        self,
        node: ast.Call,
        positional: list[Value],
        named: dict[str, Value],
        is_async: bool,
    ) -> Value:
        self.management_client_count += 1
        credential = argument(positional, named, 0, "credential")
        subscription = argument(positional, named, 1, "subscription_id")
        if (
            credential is not None
            and credential.kind == "credential"
            and exact_environment(subscription, "AZURE_SUBSCRIPTION_ID")
        ):
            self.valid_client_count += 1
            return Value("client", Client(id(node), is_async))
        return unknown()

    def sdk_call(
        self,
        receiver: Value,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        client = receiver.data.identifier
        resource_group = argument(positional, named, 0, "resource_group_name")
        operation_kind = {
            "begin_create": "create",
            "list_by_resource_group": "list",
            "get_properties": "get",
            "set_service_properties": "versioning",
            "begin_delete": "delete",
        }.get(method, method)
        if not exact_environment(resource_group, "AZURE_RESOURCE_GROUP_NAME"):
            self.invalid_kinds.add(operation_kind)
            return unknown()
        if method == "list_by_resource_group":
            if len(positional) > 1 or any(
                key != "resource_group_name" for key in named
            ):
                self.invalid_kinds.add("list")
                return unknown()
            operation = self.record("list", client)
            return Value("storage-accounts", operation.identifier)
        account = argument(positional, named, 1, "account_name")
        if not exact_environment(account, "AZURE_STORAGE_ACCOUNT_NAME"):
            self.invalid_kinds.add(operation_kind)
            return unknown()
        if method == "begin_create":
            parameters = argument(positional, named, 2, "parameters")
            if not valid_create_model(parameters):
                self.invalid_kinds.add("create")
                return unknown()
            operation = self.record("create", client)
            return Value(
                "poller",
                (operation.identifier, client, "create", receiver.data.is_async),
            )
        if method == "get_properties":
            operation = self.record("get", client)
            return self.result(operation)
        if method == "set_service_properties":
            service = argument(
                positional,
                named,
                2,
                "blob_services_name",
                "blob_service_name",
            )
            parameters = argument(positional, named, 3, "parameters")
            if not exact_string(service, "default") or not valid_versioning(
                parameters,
            ):
                self.invalid_kinds.add("versioning")
                return unknown()
            operation = self.record("versioning", client)
            return self.result(operation)
        if method == "begin_delete":
            operation = self.record("delete", client)
            return Value(
                "poller",
                (operation.identifier, client, "delete", receiver.data.is_async),
            )
        return unknown()

    @staticmethod
    def result(operation: Operation) -> Value:
        return Value(
            "storage-account-result",
            operation.identifier,
            frozenset({f"{OP_FLAG}{operation.identifier}"}),
        )

    def poller_call(self, receiver: Value, method: str) -> Value:
        source_id, client, purpose, _ = receiver.data
        if method != "result":
            self.invalid_kinds.add(f"{purpose}-complete")
            return unknown()
        operation = self.record(
            f"{purpose}-complete",
            client,
            related=source_id,
        )
        return self.result(operation)

    def record_output(self, values: list[Value]) -> None:
        flags = frozenset().union(*(value_flags(value) for value in values))
        recorded: set[tuple[int, str]] = set()
        for flag in flags:
            if not flag.startswith(FIELD_FLAG):
                continue
            field = flag.removeprefix(FIELD_FLAG)
            identifier_text, _, attribute = field.partition(":")
            identifier = int(identifier_text)
            source = self.operations_by_id.get(identifier)
            if source is None:
                continue
            kinds = {
                "list": "list-output",
                "get": "get-output",
                "versioning": "versioning-output",
            }
            kind = kinds.get(source.kind)
            allowed_fields = {
                "list": {"name"},
                "get": {"name", "location", "kind", "provisioning_state"},
                "versioning": {"is_versioning_enabled"},
            }
            if kind is not None and attribute in allowed_fields[source.kind]:
                key = (source.identifier, kind)
                if key in recorded:
                    continue
                recorded.add(key)
                self.record(kind, source.client, related=source.identifier)
        if ACCOUNT_FLAG in flags:
            clients = {
                operation.client
                for operation in self.operations
                if operation.kind == "delete-complete"
            }
            for client in clients:
                self.record("confirmation", client)

    def consume(self, value: Value) -> Value:
        if value.kind != "pending" or value.data.consumed:
            return unknown(value_flags(value))
        value.data.consumed = True
        if value.data.function is not None:
            return self.invoke(
                value.data.function,
                list(value.data.positional),
                value.data.named,
            )
        if value.data.receiver is not None and value.data.method is not None:
            if value.data.receiver.kind in {
                "storage-account-operations",
                "blob-service-operations",
            }:
                return self.sdk_call(
                    value.data.receiver,
                    value.data.method,
                    list(value.data.positional),
                    value.data.named,
                )
            if value.data.receiver.kind == "poller":
                return self.poller_call(
                    value.data.receiver,
                    value.data.method,
                )
        return unknown()

    def invoke(
        self,
        function: Function,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        identity = id(function.node)
        if identity in self.call_stack:
            return unknown()
        self.call_stack.add(identity)
        environment = function.closure.copy()
        parameters = [*function.node.args.posonlyargs, *function.node.args.args]
        defaults = [None] * (
            len(parameters) - len(function.node.args.defaults)
        ) + list(function.node.args.defaults)
        for index, parameter in enumerate(parameters):
            if index < len(positional):
                environment[parameter.arg] = positional[index]
            elif parameter.arg in named:
                environment[parameter.arg] = named[parameter.arg]
            elif defaults[index] is not None:
                environment[parameter.arg] = self.expression(
                    defaults[index],
                    environment,
                )
            else:
                environment[parameter.arg] = unknown()
        if function.node.args.vararg:
            environment[function.node.args.vararg.arg] = Value(
                "tuple",
                tuple(positional[len(parameters) :]),
            )
        self.scopes.append(function.scope)
        flow = self.execute_block(function.node.body, environment)
        self.scopes.pop()
        self.call_stack.remove(identity)
        return merge_values(flow.returned)

    def record(
        self,
        kind: str,
        client: int,
        *,
        related: int | None = None,
    ) -> Operation:
        self.counter += 1
        operation = Operation(
            self.counter,
            kind,
            client,
            self.counter,
            related,
            frozenset(self.guards),
            tuple(self.try_stack),
        )
        self.operations.append(operation)
        self.operations_by_id[operation.identifier] = operation
        return operation

    def scope(self) -> str:
        return self.scopes[-1] if self.scopes else "unknown"

    @staticmethod
    def compatible(operations: tuple[Operation, ...]) -> bool:
        selected: dict[int, str] = {}
        for operation in operations:
            for branch, arm in operation.guards:
                previous = selected.get(branch)
                if previous is not None and previous != arm:
                    return False
                selected[branch] = arm
        return True

    def has_prefix(self, kinds: tuple[str, ...]) -> bool:
        if any(kind in self.invalid_kinds for kind in kinds):
            return False
        for kind in kinds:
            if sum(operation.kind == kind for operation in self.operations) != 1:
                return False
        selected = tuple(
            next(operation for operation in self.operations if operation.kind == kind)
            for kind in kinds
        )
        if any(
            selected[index].order >= selected[index + 1].order
            for index in range(len(selected) - 1)
        ):
            return False
        if any(operation.client != selected[0].client for operation in selected):
            return False
        for operation in selected:
            if operation.kind in {
                "list-iterate",
                "list-output",
                "get-output",
                "versioning-output",
                "create-complete",
                "delete-complete",
            }:
                previous_kind = {
                    "list-iterate": "list",
                    "list-output": "list",
                    "get-output": "get",
                    "versioning-output": "versioning",
                    "create-complete": "create",
                    "delete-complete": "delete",
                }[operation.kind]
                source = next(
                    item for item in selected if item.kind == previous_kind
                )
                if operation.related != source.identifier:
                    return False
        return self.compatible(selected)

    def lifecycle_chains(self) -> list[tuple[Operation, ...]]:
        kinds = (
            "create",
            "create-complete",
            "list",
            "list-iterate",
            "list-output",
            "get",
            "get-output",
            "versioning",
            "versioning-output",
            "delete",
            "delete-complete",
            "confirmation",
        )
        if any(
            sum(operation.kind == kind for operation in self.operations) != 1
            for kind in kinds
        ):
            return []
        if self.invalid_kinds & {
            "create",
            "list",
            "get",
            "versioning",
            "delete",
            "create-complete",
            "delete-complete",
        }:
            return []
        chain = tuple(
            next(operation for operation in self.operations if operation.kind == kind)
            for kind in kinds
        )
        if any(
            chain[index].order >= chain[index + 1].order
            for index in range(len(chain) - 1)
        ):
            return []
        if any(operation.client != chain[0].client for operation in chain):
            return []
        create = chain[0]
        create_complete = chain[1]
        if create_complete.related != create.identifier:
            return []
        delete = chain[-3]
        complete = chain[-2]
        if complete.related != delete.identifier:
            return []
        if not self.compatible(chain):
            return []
        return [chain]

    def sdk_errors_are_valid(
        self,
        chains: list[tuple[Operation, ...]],
    ) -> bool:
        connected = {
            identifier
            for chain in chains
            for operation in chain
            for identifier in operation.try_stack
        }
        useful_handlers: set[str] = set()
        for info in self.try_infos:
            if not info.may_throw:
                continue
            caught: set[str] = set()
            catches_all = False
            for handler in info.handlers:
                if catches_all:
                    continue
                exception = canonical_exception(
                    handler.node.type,
                    handler.environment,
                )
                if exception is not None and exception in caught:
                    continue
                if info.identifier in connected and exception in {
                    "azure.core.exceptions.HttpResponseError",
                    "azure.core.exceptions.ClientAuthenticationError",
                }:
                    if not useful_handler(handler.node, handler.environment):
                        return False
                    useful_handlers.add(exception)
                elif not handler_always_causal(handler.node):
                    return False
                members = canonical_exception_members(
                    handler.node.type,
                    handler.environment,
                )
                caught.update(members)
                catches_all = handler.node.type is None or bool(
                    members
                    & {"builtins.BaseException", "builtins.Exception"},
                )
        return useful_handlers == {
            "azure.core.exceptions.HttpResponseError",
            "azure.core.exceptions.ClientAuthenticationError",
        }


def argument(
    positional: list[Value],
    named: dict[str, Value],
    index: int,
    *names: str,
) -> Value | None:
    for name in names:
        if name in named:
            return named[name]
    return positional[index] if len(positional) > index else None


def exact_environment(value: Value | None, key: str) -> bool:
    return (
        value is not None
        and value.kind == "environment"
        and value.data[0] == key
    )


def exact_string(value: Value | None, expected: str) -> bool:
    return value is not None and value.kind == "string" and value.data == expected


def valid_create_model(value: Value | None) -> bool:
    if value is None or value.kind not in {"mapping", "model"}:
        return False
    if value.kind == "model" and (
        f"{MODEL_FLAG}azure.mgmt.storage.models.StorageAccountCreateParameters"
        not in value.flags
    ):
        return False
    location = value.data.get("location")
    sku = value.data.get("sku")
    kind = value.data.get("kind")
    return (
        location is not None
        and location.kind == "environment"
        and location.data == ("AZURE_LOCATION", "eastus")
        and valid_sku(sku)
        and enum_or_string(kind, {"StorageV2", "STORAGE_V2"})
        and not {"access_tier", "accessTier"} & value.data.keys()
    )


def valid_sku(value: Value | None) -> bool:
    if value is None or value.kind not in {"mapping", "model"}:
        return False
    if value.kind == "model" and (
        f"{MODEL_FLAG}azure.mgmt.storage.models.Sku" not in value.flags
    ):
        return False
    return enum_or_string(
        value.data.get("name"),
        {"Standard_LRS", "STANDARD_LRS"},
    )


def enum_or_string(value: Value | None, accepted: set[str]) -> bool:
    if value is None:
        return False
    if value.kind == "string":
        return value.data in accepted
    if value.kind == "symbol":
        return value.data.rsplit(".", maxsplit=1)[-1] in accepted
    return False


def valid_versioning(value: Value | None) -> bool:
    if value is None or value.kind not in {"mapping", "model"}:
        return False
    if value.kind == "model" and (
        f"{MODEL_FLAG}azure.mgmt.storage.models.BlobServiceProperties"
        not in value.flags
    ):
        return False
    enabled = value.data.get("is_versioning_enabled")
    return (
        enabled is not None
        and enabled.kind == "literal"
        and enabled.data is True
    )


def is_docstring(statement: ast.stmt) -> bool:
    return (
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Constant)
        and isinstance(statement.value.value, str)
    )


def block_may_throw(statements: list[ast.stmt]) -> bool:
    class ThrowingVisitor(ast.NodeVisitor):
        found = False

        def visit_Call(self, node: ast.Call) -> None:
            self.found = True

        def visit_Raise(self, node: ast.Raise) -> None:
            self.found = True

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            return

        def visit_AsyncFunctionDef(
            self,
            node: ast.AsyncFunctionDef,
        ) -> None:
            return

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            return

        def visit_Lambda(self, node: ast.Lambda) -> None:
            return

    visitor = ThrowingVisitor()
    for statement in statements:
        visitor.visit(statement)
        if visitor.found:
            return True
    return False


@dataclass(frozen=True)
class ErrorPath:
    terminal: str
    diagnosed: bool
    payload_names: frozenset[str]
    returned_payload: bool = False


@dataclass(frozen=True)
class ErrorExpression:
    payload: bool = False
    diagnosed: bool = False
    exits: bool = False


@dataclass(frozen=True)
class HelperSummary:
    diagnosed: bool
    returns_payload: bool


DIAGNOSTIC_METHODS = {
    "critical",
    "debug",
    "error",
    "exception",
    "info",
    "log",
    "warning",
    "write",
}

ERROR_DETAIL_ATTRIBUTES = {
    "args",
    "code",
    "details",
    "error",
    "message",
    "reason",
    "response",
    "status",
    "status_code",
}


def static_value(
    node: ast.expr,
    environment: dict[str, Value],
) -> Value:
    if isinstance(node, ast.Name):
        return environment.get(node.id, unknown())
    if isinstance(node, ast.Attribute):
        name = dotted(node)
        if name is not None and name in environment:
            return environment[name]
        base = static_value(node.value, environment)
        if base.kind == "symbol":
            return Value("symbol", f"{base.data}.{node.attr}")
        if base.kind == "module":
            return base.data.get(node.attr, unknown(value_flags(base)))
        if base.kind == "object":
            member = base.data.members.get(node.attr)
            if member is not None:
                return member
            function = base.data.class_info.methods.get(node.attr)
            if function is not None:
                return Value("bound-function", (function, base))
        if base.kind == "class":
            function = base.data.methods.get(node.attr)
            if function is not None:
                return Value("function", function)
    return unknown()


def is_diagnostic_sink(
    node: ast.Call,
    environment: dict[str, Value],
) -> bool:
    function = static_value(node.func, environment)
    if function.kind == "symbol" and function.data == "builtins.print":
        return True
    return (
        isinstance(node.func, ast.Attribute)
        and node.func.attr in DIAGNOSTIC_METHODS
    )


def is_exit_call(
    node: ast.Call,
    environment: dict[str, Value],
) -> bool:
    function = static_value(node.func, environment)
    return (
        function.kind == "symbol"
        and function.data in {"builtins.exit", "sys.exit"}
    ) or (
        isinstance(node.func, ast.Name)
        and node.func.id == "exit"
        and function.kind == "unknown"
    )


def callable_helper(
    node: ast.expr,
    environment: dict[str, Value],
) -> tuple[Function, bool] | None:
    value = static_value(node, environment)
    if value.kind == "function" and isinstance(value.data.node, ast.FunctionDef):
        return value.data, False
    if (
        value.kind == "bound-function"
        and isinstance(value.data[0].node, ast.FunctionDef)
    ):
        return value.data[0], True
    return None


def bind_helper_payloads(
    function: Function,
    bound: bool,
    positional: list[bool],
    named: dict[str, bool],
) -> frozenset[str]:
    values = [False, *positional] if bound else positional
    parameters = [*function.node.args.posonlyargs, *function.node.args.args]
    payloads: set[str] = set()
    for index, parameter in enumerate(parameters):
        if index < len(values):
            payload = values[index]
        else:
            payload = named.get(parameter.arg, False)
        if payload:
            payloads.add(parameter.arg)
    if function.node.args.vararg and any(values[len(parameters) :]):
        payloads.add(function.node.args.vararg.arg)
    for parameter in function.node.args.kwonlyargs:
        if named.get(parameter.arg, False):
            payloads.add(parameter.arg)
    return frozenset(payloads)


def helper_summary(
    function: Function,
    bound: bool,
    positional: list[bool],
    named: dict[str, bool],
    stack: frozenset[int],
) -> HelperSummary:
    identity = id(function.node)
    if identity in stack:
        return HelperSummary(False, False)
    payloads = bind_helper_payloads(function, bound, positional, named)
    paths = error_sequence(
        function.node.body,
        function.closure,
        {ErrorPath("fall", False, payloads)},
        stack | {identity},
    )
    diagnosed = bool(paths) and all(path.diagnosed for path in paths)
    returns_payload = bool(paths) and all(
        path.terminal == "return" and path.returned_payload
        for path in paths
    )
    return HelperSummary(diagnosed, returns_payload)


def str_format_references(
    template: str,
    positional_count: int,
    named_keys: set[str],
) -> tuple[set[int], set[str]] | None:
    positional: set[int] = set()
    named: set[str] = set()
    automatic = 0
    automatic_fields = False
    manual_fields = False

    def collect(value: str) -> bool:
        nonlocal automatic, automatic_fields, manual_fields
        try:
            fields = list(Formatter().parse(value))
        except ValueError:
            return False
        for _, field_name, format_spec, _ in fields:
            if field_name is None:
                continue
            root = re.split(r"[.\[]", field_name, maxsplit=1)[0]
            if root == "":
                if manual_fields:
                    return False
                automatic_fields = True
                positional.add(automatic)
                automatic += 1
            elif root.isdecimal():
                if automatic_fields:
                    return False
                manual_fields = True
                positional.add(int(root))
            else:
                named.add(root)
            if not collect(format_spec):
                return False
        return True

    if not collect(template):
        return None
    if (
        any(index >= positional_count for index in positional)
        or not named.issubset(named_keys)
        or positional != set(range(positional_count))
        or named != named_keys
    ):
        return None
    return positional, named


def percent_references(
    template: str,
) -> tuple[str, list[str | None]] | None:
    references: list[str | None] = []
    index = 0
    conversion = re.compile(
        r"%"
        r"(?:\((?P<key>[^)]+)\))?"
        r"[#0\- +]*"
        r"(?P<width>\*|\d+)?"
        r"(?:\.(?P<precision>\*|\d+))?"
        r"[hlL]?"
        r"[diouxXeEfFgGcrsa]",
    )
    while index < len(template):
        if template[index] != "%":
            index += 1
            continue
        if index + 1 < len(template) and template[index + 1] == "%":
            index += 2
            continue
        match = conversion.match(template, index)
        if match is None:
            return None
        if match.group("key") is not None:
            if match.group("width") == "*" or match.group("precision") == "*":
                return None
            references.append(match.group("key"))
        else:
            if match.group("width") == "*":
                references.append(None)
            if match.group("precision") == "*":
                references.append(None)
            references.append(None)
        index = match.end()
    mapping = any(reference is not None for reference in references)
    if mapping and any(reference is None for reference in references):
        return None
    return ("mapping" if mapping else "positional"), references


def formatted_payload(
    node: ast.expr,
    environment: dict[str, Value],
    payload_names: frozenset[str],
    stack: frozenset[int],
) -> ErrorExpression | None:
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "format"
        and isinstance(node.func.value, ast.Constant)
        and isinstance(node.func.value.value, str)
    ):
        if any(keyword.arg is None for keyword in node.keywords):
            return ErrorExpression()
        positional = [
            error_expression(argument, environment, payload_names, stack)
            for argument in node.args
        ]
        named = {
            keyword.arg: error_expression(
                keyword.value,
                environment,
                payload_names,
                stack,
            )
            for keyword in node.keywords
            if keyword.arg is not None
        }
        references = str_format_references(
            node.func.value.value,
            len(positional),
            set(named),
        )
        nested = any(
            expression.diagnosed
            for expression in [*positional, *named.values()]
        )
        if references is None:
            return ErrorExpression(diagnosed=nested)
        consumed = [
            *(positional[index] for index in references[0]),
            *(named[name] for name in references[1]),
        ]
        return ErrorExpression(
            payload=any(expression.payload for expression in consumed),
            diagnosed=nested,
        )
    if (
        isinstance(node, ast.BinOp)
        and isinstance(node.op, ast.Mod)
        and isinstance(node.left, ast.Constant)
        and isinstance(node.left.value, str)
    ):
        references = percent_references(node.left.value)
        if references is None:
            return ErrorExpression()
        kind, fields = references
        if kind == "mapping":
            if not isinstance(node.right, ast.Dict):
                return ErrorExpression()
            supplied: dict[str, ErrorExpression] = {}
            for key, value in zip(
                node.right.keys,
                node.right.values,
                strict=True,
            ):
                if not (
                    isinstance(key, ast.Constant)
                    and isinstance(key.value, str)
                ):
                    return ErrorExpression()
                supplied[key.value] = error_expression(
                    value,
                    environment,
                    payload_names,
                    stack,
                )
            required = {field for field in fields if field is not None}
            if required != set(supplied):
                return ErrorExpression()
            return ErrorExpression(
                payload=any(supplied[field].payload for field in required),
                diagnosed=any(
                    expression.diagnosed for expression in supplied.values()
                ),
            )
        values = (
            list(node.right.elts)
            if isinstance(node.right, ast.Tuple)
            else [node.right]
        )
        expressions = [
            error_expression(value, environment, payload_names, stack)
            for value in values
        ]
        if len(fields) != len(expressions):
            return ErrorExpression(
                diagnosed=any(
                    expression.diagnosed for expression in expressions
                ),
            )
        return ErrorExpression(
            payload=any(expression.payload for expression in expressions),
            diagnosed=any(
                expression.diagnosed for expression in expressions
            ),
        )
    return None


def error_expression(
    node: ast.expr | None,
    environment: dict[str, Value],
    payload_names: frozenset[str],
    stack: frozenset[int],
) -> ErrorExpression:
    if node is None:
        return ErrorExpression()
    formatted = formatted_payload(
        node,
        environment,
        payload_names,
        stack,
    )
    if formatted is not None:
        return formatted
    if isinstance(node, ast.Name):
        return ErrorExpression(payload=node.id in payload_names)
    if isinstance(node, ast.Attribute):
        base = error_expression(node.value, environment, payload_names, stack)
        payload = base.payload
        if isinstance(node.value, ast.Name) and node.value.id in payload_names:
            payload = node.attr in ERROR_DETAIL_ATTRIBUTES
        return ErrorExpression(payload=payload, diagnosed=base.diagnosed)
    if isinstance(node, ast.Subscript):
        base = error_expression(node.value, environment, payload_names, stack)
        index = error_expression(node.slice, environment, payload_names, stack)
        return ErrorExpression(
            payload=base.payload,
            diagnosed=base.diagnosed or index.diagnosed,
        )
    if isinstance(node, ast.FormattedValue):
        return error_expression(node.value, environment, payload_names, stack)
    if isinstance(node, ast.JoinedStr):
        parts = [
            error_expression(part, environment, payload_names, stack)
            for part in node.values
            if isinstance(part, ast.FormattedValue)
        ]
        return combine_error_expressions(parts)
    if isinstance(node, ast.Call):
        positional = [
            error_expression(argument, environment, payload_names, stack)
            for argument in node.args
        ]
        named = {
            keyword.arg: error_expression(
                keyword.value,
                environment,
                payload_names,
                stack,
            )
            for keyword in node.keywords
            if keyword.arg is not None
        }
        arguments = [*positional, *named.values()]
        nested_diagnostic = any(argument.diagnosed for argument in arguments)
        has_payload = any(argument.payload for argument in arguments)
        if is_diagnostic_sink(node, environment):
            function = static_value(node.func, environment)
            if function.kind == "symbol" and function.data == "builtins.print":
                return ErrorExpression(
                    diagnosed=nested_diagnostic or has_payload,
                )
            if isinstance(node.func, ast.Attribute) and node.func.attr == "write":
                return ErrorExpression(
                    diagnosed=nested_diagnostic or has_payload,
                )
            message_index = 1 if (
                isinstance(node.func, ast.Attribute)
                and node.func.attr == "log"
            ) else 0
            message = (
                node.args[message_index]
                if len(node.args) > message_index
                else next(
                    (
                        keyword.value
                        for keyword in node.keywords
                        if keyword.arg in {"msg", "message"}
                    ),
                    None,
                )
            )
            message_expression = error_expression(
                message,
                environment,
                payload_names,
                stack,
            )
            lazy_nodes = list(node.args[message_index + 1 :])
            lazy = [
                error_expression(
                    argument,
                    environment,
                    payload_names,
                    stack,
                )
                for argument in lazy_nodes
            ]
            lazy_payload = False
            if (
                isinstance(message, ast.Constant)
                and isinstance(message.value, str)
            ):
                references = percent_references(message.value)
                if (
                    references is not None
                    and references[0] == "positional"
                ):
                    lazy_payload = (
                        len(references[1]) == len(lazy)
                        and any(argument.payload for argument in lazy)
                    )
                elif (
                    references is not None
                    and len(lazy_nodes) == 1
                    and isinstance(lazy_nodes[0], ast.Dict)
                ):
                    supplied: dict[str, ErrorExpression] = {}
                    for key, value in zip(
                        lazy_nodes[0].keys,
                        lazy_nodes[0].values,
                        strict=True,
                    ):
                        if not (
                            isinstance(key, ast.Constant)
                            and isinstance(key.value, str)
                        ):
                            supplied = {}
                            break
                        supplied[key.value] = error_expression(
                            value,
                            environment,
                            payload_names,
                            stack,
                        )
                    required = {
                        field
                        for field in references[1]
                        if field is not None
                    }
                    lazy_payload = (
                        required == set(supplied)
                        and any(
                            supplied[field].payload for field in required
                        )
                    )
            exception_payload = any(
                named.get(name, ErrorExpression()).payload
                for name in {"exc_info", "exception"}
            )
            return ErrorExpression(
                diagnosed=(
                    nested_diagnostic
                    or message_expression.payload
                    or lazy_payload
                    or exception_payload
                ),
            )
        if is_exit_call(node, environment):
            return ErrorExpression(
                diagnosed=nested_diagnostic or has_payload,
                exits=has_payload,
            )
        helper = callable_helper(node.func, environment)
        if helper is not None:
            summary = helper_summary(
                *helper,
                [argument.payload for argument in positional],
                {
                    name: argument.payload
                    for name, argument in named.items()
                },
                stack,
            )
            return ErrorExpression(
                payload=summary.returns_payload,
                diagnosed=nested_diagnostic or summary.diagnosed,
            )
        function = static_value(node.func, environment)
        canonical = function.data if function.kind == "symbol" else None
        if canonical in {"builtins.str", "builtins.repr"}:
            return ErrorExpression(
                payload=has_payload,
                diagnosed=nested_diagnostic,
            )
        return ErrorExpression(diagnosed=nested_diagnostic)
    if isinstance(node, ast.IfExp):
        condition = error_expression(
            node.test,
            environment,
            payload_names,
            stack,
        )
        body = error_expression(node.body, environment, payload_names, stack)
        alternate = error_expression(
            node.orelse,
            environment,
            payload_names,
            stack,
        )
        return ErrorExpression(
            payload=body.payload and alternate.payload,
            diagnosed=condition.diagnosed
            or (body.diagnosed and alternate.diagnosed),
        )
    if isinstance(
        node,
        (
            ast.BinOp,
            ast.BoolOp,
            ast.Dict,
            ast.List,
            ast.Set,
            ast.Tuple,
        ),
    ):
        return combine_error_expressions(
            [
                error_expression(child, environment, payload_names, stack)
                for child in ast.iter_child_nodes(node)
                if isinstance(child, ast.expr)
            ],
        )
    return ErrorExpression()


def combine_error_expressions(
    expressions: list[ErrorExpression],
) -> ErrorExpression:
    return ErrorExpression(
        payload=any(expression.payload for expression in expressions),
        diagnosed=any(expression.diagnosed for expression in expressions),
        exits=any(expression.exits for expression in expressions),
    )


def assign_payload(
    target: ast.expr,
    payload: bool,
    names: frozenset[str],
) -> frozenset[str]:
    updated = set(names)
    if isinstance(target, ast.Name):
        if payload:
            updated.add(target.id)
        else:
            updated.discard(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for child in target.elts:
            updated = set(assign_payload(child, payload, frozenset(updated)))
    return frozenset(updated)


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


def useful_handler(
    handler: ast.ExceptHandler,
    environment: dict[str, Value],
) -> bool:
    if handler.name is None:
        return False
    outcomes = error_sequence(
        handler.body,
        environment,
        {
            ErrorPath(
                "fall",
                False,
                frozenset({handler.name}),
            ),
        },
        frozenset(),
    )
    return bool(outcomes) and all(
        (
            outcome.terminal == "raise"
            and outcome.diagnosed
        )
        or (
            outcome.terminal == "return"
            and (outcome.diagnosed or outcome.returned_payload)
        )
        or (
            outcome.terminal == "exit"
            and outcome.diagnosed
        )
        for outcome in outcomes
    )


def error_sequence(
    statements: list[ast.stmt],
    environment: dict[str, Value],
    outcomes: set[ErrorPath],
    stack: frozenset[int],
) -> set[ErrorPath]:
    for statement in statements:
        combined = {
            outcome for outcome in outcomes if outcome.terminal != "fall"
        }
        for outcome in outcomes:
            if outcome.terminal == "fall":
                combined |= error_statement(
                    statement,
                    environment,
                    outcome,
                    stack,
                )
        outcomes = combined
    return outcomes


def error_statement(
    statement: ast.stmt,
    environment: dict[str, Value],
    path: ErrorPath,
    stack: frozenset[int],
) -> set[ErrorPath]:
    diagnosed = path.diagnosed
    names = path.payload_names
    if isinstance(statement, (ast.Assign, ast.AnnAssign)):
        expression = error_expression(
            statement.value,
            environment,
            names,
            stack,
        )
        targets = (
            statement.targets
            if isinstance(statement, ast.Assign)
            else [statement.target]
        )
        for target in targets:
            names = assign_payload(target, expression.payload, names)
        return {
            ErrorPath(
                "fall",
                diagnosed or expression.diagnosed,
                names,
            ),
        }
    if isinstance(statement, ast.AugAssign):
        expression = error_expression(
            statement.value,
            environment,
            names,
            stack,
        )
        return {
            ErrorPath(
                "fall",
                diagnosed or expression.diagnosed,
                names,
            ),
        }
    if isinstance(statement, ast.Expr):
        expression = error_expression(
            statement.value,
            environment,
            names,
            stack,
        )
        return {
            ErrorPath(
                "exit" if expression.exits else "fall",
                diagnosed or expression.diagnosed,
                names,
            ),
        }
    if isinstance(statement, ast.Raise):
        expression = error_expression(
            statement.exc,
            environment,
            names,
            stack,
        )
        cause = error_expression(
            statement.cause,
            environment,
            names,
            stack,
        )
        preserved = statement.exc is None or (
            isinstance(statement.exc, ast.Name)
            and statement.exc.id in names
        ) or (
            isinstance(statement.cause, ast.Name)
            and statement.cause.id in names
        )
        return {
            ErrorPath(
                "raise" if preserved else "unsafe",
                diagnosed or expression.diagnosed or cause.diagnosed,
                names,
            ),
        }
    if isinstance(statement, ast.Return):
        expression = error_expression(
            statement.value,
            environment,
            names,
            stack,
        )
        return {
            ErrorPath(
                "return",
                diagnosed or expression.diagnosed,
                names,
                expression.payload,
            ),
        }
    if isinstance(statement, ast.Break):
        return {ErrorPath("break", diagnosed, names)}
    if isinstance(statement, ast.Continue):
        return {ErrorPath("continue", diagnosed, names)}
    if isinstance(statement, ast.If):
        condition = error_expression(
            statement.test,
            environment,
            names,
            stack,
        )
        branch = ErrorPath(
            "fall",
            diagnosed or condition.diagnosed,
            names,
        )
        alternate = error_sequence(
            statement.orelse,
            environment,
            {branch},
            stack,
        ) if statement.orelse else {branch}
        return error_sequence(
            statement.body,
            environment,
            {branch},
            stack,
        ) | alternate
    if isinstance(statement, (ast.With, ast.AsyncWith)):
        current = ErrorPath("fall", diagnosed, names)
        for item in statement.items:
            expression = error_expression(
                item.context_expr,
                environment,
                current.payload_names,
                stack,
            )
            item_names = current.payload_names
            if item.optional_vars is not None:
                item_names = assign_payload(
                    item.optional_vars,
                    expression.payload,
                    item_names,
                )
            current = ErrorPath(
                "fall",
                current.diagnosed or expression.diagnosed,
                item_names,
            )
        return error_sequence(
            statement.body,
            environment,
            {current},
            stack,
        )
    if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
        expression_node = (
            statement.iter
            if isinstance(statement, (ast.For, ast.AsyncFor))
            else statement.test
        )
        expression = error_expression(
            expression_node,
            environment,
            names,
            stack,
        )
        loop_names = names
        if isinstance(statement, (ast.For, ast.AsyncFor)):
            loop_names = assign_payload(
                statement.target,
                expression.payload,
                names,
            )
        start = ErrorPath(
            "fall",
            diagnosed or expression.diagnosed,
            loop_names,
        )
        body = error_sequence(
            statement.body,
            environment,
            {start},
            stack,
        )
        body = {
            ErrorPath(
                (
                    "fall"
                    if outcome.terminal in {"break", "continue"}
                    else outcome.terminal
                ),
                outcome.diagnosed,
                outcome.payload_names,
                outcome.returned_payload,
            )
            for outcome in body
        }
        alternate = error_sequence(
            statement.orelse,
            environment,
            {start},
            stack,
        )
        return body | alternate | {start}
    if isinstance(statement, (ast.Try, ast.TryStar)):
        body = error_sequence(
            statement.body,
            environment,
            {path},
            stack,
        )
        paths = error_sequence(
            statement.orelse,
            environment,
            {outcome for outcome in body if outcome.terminal == "fall"},
            stack,
        )
        paths |= {
            outcome for outcome in body if outcome.terminal != "fall"
        }
        for handler in statement.handlers:
            handler_names = names
            if handler.name:
                handler_names = assign_payload(
                    ast.Name(id=handler.name),
                    False,
                    handler_names,
                )
            paths |= error_sequence(
                handler.body,
                environment,
                {
                    ErrorPath(
                        "fall",
                        diagnosed,
                        handler_names,
                    ),
                },
                stack,
            )
        if statement.finalbody:
            finalized: set[ErrorPath] = set()
            for outcome in paths:
                final = error_sequence(
                    statement.finalbody,
                    environment,
                    {
                        ErrorPath(
                            "fall",
                            outcome.diagnosed,
                            outcome.payload_names,
                        ),
                    },
                    stack,
                )
                for final_outcome in final:
                    if final_outcome.terminal == "fall":
                        finalized.add(
                            ErrorPath(
                                outcome.terminal,
                                final_outcome.diagnosed,
                                final_outcome.payload_names,
                                outcome.returned_payload,
                            ),
                        )
                    else:
                        finalized.add(final_outcome)
            paths = finalized
        return paths
    return {path}


def handler_always_causal(handler: ast.ExceptHandler) -> bool:
    return causal_sequence(handler.body, handler.name) == {"safe"}


def causal_sequence(
    statements: list[ast.stmt],
    binding: str | None,
) -> set[str]:
    outcomes = {"fall"}
    for statement in statements:
        next_outcomes = causal_statement(statement, binding)
        combined = {outcome for outcome in outcomes if outcome != "fall"}
        if "fall" in outcomes:
            combined |= next_outcomes
        outcomes = combined
    return outcomes


def causal_statement(statement: ast.stmt, binding: str | None) -> set[str]:
    if isinstance(statement, ast.Raise):
        return {"safe" if causal_raise(statement, binding) else "unsafe"}
    if isinstance(statement, (ast.Return, ast.Break, ast.Continue)):
        return {"unsafe"}
    if isinstance(statement, ast.If):
        alternate = (
            causal_sequence(statement.orelse, binding)
            if statement.orelse
            else {"fall"}
        )
        return causal_sequence(statement.body, binding) | alternate
    if isinstance(statement, (ast.With, ast.AsyncWith)):
        return causal_sequence(statement.body, binding)
    if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
        return (
            causal_sequence(statement.body, binding)
            | causal_sequence(statement.orelse, binding)
            | {"fall"}
        )
    if isinstance(statement, (ast.Try, ast.TryStar)):
        outcomes = causal_sequence(statement.body, binding)
        outcomes |= causal_sequence(statement.orelse, binding)
        for handler in statement.handlers:
            outcomes |= causal_sequence(handler.body, binding)
        if statement.finalbody:
            final = causal_sequence(statement.finalbody, binding)
            if final != {"fall"}:
                outcomes = final
        return outcomes
    return {"fall"}


def normalized_package(package: str) -> str:
    return re.sub(r"[-_.]+", "-", package).lower()


def requirement_package(declaration: str) -> str | None:
    pattern = re.compile(
        r"^(?P<package>[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)"
        r"(?:\[[^\]]+\])?"
        r"(?:\s*(?:===|==|~=|!=|<=|>=|<|>|@)\s*[^\s,]+"
        r"(?:\s*,\s*(?:!=|<=|>=|<|>)\s*[^\s,]+)*)?"
        r"(?:\s*;\s*.+)?$",
    )
    match = pattern.fullmatch(declaration)
    return match.group("package") if match else None


def runtime_requirements(filename: str) -> bool:
    name = filename.rsplit("/", maxsplit=1)[-1].rsplit("\\", maxsplit=1)[-1]
    if not re.fullmatch(r"requirements[^\\/]*\.txt", name, re.IGNORECASE):
        return False
    suffix = name[len("requirements") : -len(".txt")]
    parts = {part for part in re.split(r"[-_.]+", suffix.lower()) if part}
    return not parts & {
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
        package = requirement_package(declaration)
        if package is not None:
            packages.add(normalized_package(package))
    return packages


def pyproject_packages(content: str) -> set[str]:
    try:
        document = tomllib.loads(content)
    except tomllib.TOMLDecodeError:
        return set()
    packages: set[str] = set()
    project = document.get("project")
    dependencies = project.get("dependencies") if isinstance(project, dict) else None
    if isinstance(dependencies, list):
        for declaration in dependencies:
            if isinstance(declaration, str):
                package = requirement_package(declaration.strip())
                if package is not None:
                    packages.add(normalized_package(package))
    tool = document.get("tool")
    poetry = tool.get("poetry") if isinstance(tool, dict) else None
    dependencies = poetry.get("dependencies") if isinstance(poetry, dict) else None
    if isinstance(dependencies, dict):
        for name, constraint in dependencies.items():
            if normalized_package(name) != "python" and not (
                isinstance(constraint, dict)
                and constraint.get("optional") is True
            ):
                packages.add(normalized_package(name))
    return packages


def setup_packages(content: str) -> set[str]:
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return set()
    setup_names: set[str] = set()
    values: dict[str, list[str]] = {}
    packages: set[str] = set()
    for statement in tree.body:
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                if alias.name == "setuptools":
                    setup_names.add(f"{alias.asname or 'setuptools'}.setup")
        elif isinstance(statement, ast.ImportFrom) and statement.module == "setuptools":
            for alias in statement.names:
                if alias.name == "setup":
                    setup_names.add(alias.asname or "setup")
        elif isinstance(statement, ast.Assign):
            if isinstance(statement.value, (ast.List, ast.Tuple)) and all(
                isinstance(item, ast.Constant) and isinstance(item.value, str)
                for item in statement.value.elts
            ):
                declarations = [item.value for item in statement.value.elts]
                for target in statement.targets:
                    if isinstance(target, ast.Name):
                        values[target.id] = declarations
        elif (
            isinstance(statement, ast.Expr)
            and isinstance(statement.value, ast.Call)
            and dotted(statement.value.func) in setup_names
        ):
            keyword = next(
                (
                    item
                    for item in statement.value.keywords
                    if item.arg == "install_requires"
                ),
                None,
            )
            declarations: list[str] = []
            if keyword is not None and isinstance(keyword.value, (ast.List, ast.Tuple)):
                declarations = [
                    item.value
                    for item in keyword.value.elts
                    if isinstance(item, ast.Constant) and isinstance(item.value, str)
                ]
            elif keyword is not None and isinstance(keyword.value, ast.Name):
                declarations = values.get(keyword.value.id, [])
            for declaration in declarations:
                package = requirement_package(declaration.strip())
                if package is not None:
                    packages.add(normalized_package(package))
    return packages


def declares_package(
    manifests: list[dict[str, str]],
    expected_package: str,
) -> bool:
    expected = normalized_package(expected_package)
    for manifest in manifests:
        filename = manifest["filename"]
        content = manifest["content"]
        if runtime_requirements(filename):
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


def normalized_document_path(path: str) -> str:
    normalized = posixpath.normpath(path.replace("\\", "/"))
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if (
        not normalized
        or normalized == "."
        or normalized.startswith("../")
        or normalized.startswith("/")
        or re.match(r"^[A-Za-z]:", normalized)
    ):
        raise ValueError("document paths must be relative workspace paths")
    return normalized


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        raw_documents = payload.get("documents")
        manifests = payload.get("dependencyManifests")
        if not isinstance(raw_documents, list) or not all(
            isinstance(document, dict)
            and isinstance(document.get("path"), str)
            and isinstance(document.get("source"), str)
            for document in raw_documents
        ):
            raise ValueError("documents entries are invalid")
        if not isinstance(manifests, list) or not all(
            isinstance(manifest, dict)
            and isinstance(manifest.get("filename"), str)
            and isinstance(manifest.get("content"), str)
            for manifest in manifests
        ):
            raise ValueError("dependencyManifests entries are invalid")
        documents = [
            Document(
                normalized_document_path(document["path"]),
                document["source"],
            )
            for document in raw_documents
        ]
        if len({document.path for document in documents}) != len(documents):
            raise ValueError("document paths must be unique")
        print(json.dumps(Analyzer(documents, manifests).analyze()))
    except (json.JSONDecodeError, TypeError, ValueError) as error:
        print(f"Invalid analyzer input: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
