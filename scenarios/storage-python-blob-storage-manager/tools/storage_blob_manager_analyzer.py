from __future__ import annotations

import ast
import json
import posixpath
import re
import sys
import tomllib
from dataclasses import dataclass, field
from typing import Any


LEASE_ERROR_CODES = {
    "leasealreadypresent",
    "leaseidmismatchwithbloboperation",
    "leaseidmissing",
    "leaseidmismatchwithleaseoperation",
    "leaseisbreakingandcannotbeacquired",
    "leaseisbreakingandcannotberenewed",
    "leaseislost",
    "leasealreadybroken",
}


@dataclass
class Value:
    kind: str
    data: Any = None
    flags: frozenset[str] = frozenset()


@dataclass
class Function:
    node: ast.FunctionDef | ast.AsyncFunctionDef
    closure: dict[str, Value]


@dataclass
class ClassInfo:
    methods: dict[str, Function]


@dataclass
class Instance:
    class_info: ClassInfo
    members: dict[str, Value] = field(default_factory=dict)


@dataclass
class Lease:
    service: int
    mode: str
    acquired: int | None = None


@dataclass
class ClientConfig:
    mode: str
    account_url_flags: frozenset[str]
    logging_enabled: bool
    custom_retry: bool


@dataclass(frozen=True)
class Operation:
    identifier: int
    kind: str
    service: int
    mode: str
    order: int
    related: int | None = None
    streamed: bool = False
    tags: bool = False
    timeout: bool = False
    overwrite: bool | None = None
    lease: bool = False
    guards: frozenset[tuple[int, str]] = frozenset()
    try_stack: tuple[int, ...] = ()


@dataclass
class TryInfo:
    identifier: int
    catches: set[str]
    meaningful: bool
    lease_conflict: bool


@dataclass
class Flow:
    environment: dict[str, Value]
    normal: bool = True
    returned: list[Value] = field(default_factory=list)


@dataclass(frozen=True)
class Document:
    path: str
    source: str


def unknown(flags: frozenset[str] = frozenset()) -> Value:
    return Value("unknown", flags=flags)


def value_flags(value: Value, seen: set[int] | None = None) -> frozenset[str]:
    flags = value.flags
    if value.kind != "instance":
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
    if value.kind in {
        "bound-function",
        "bound-sdk",
        "class",
        "function",
        "instance",
        "lease",
        "local-module",
        "retry-policy",
    }:
        return value.kind, id(value.data), value.flags
    return value.kind, value.data, value.flags


def merge_values(values: list[Value]) -> Value:
    if not values:
        return unknown()
    first = signature(values[0])
    if all(signature(value) == first for value in values[1:]):
        return values[0]
    return unknown(frozenset().union(*(value_flags(value) for value in values)))


def merge_environments(
    environments: list[dict[str, Value]],
) -> dict[str, Value]:
    keys = set().union(*(environment.keys() for environment in environments))
    return {
        key: merge_values(
            [environment.get(key, unknown()) for environment in environments]
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


class Analyzer:
    def __init__(
        self,
        documents: list[Document],
        dependency_manifests: list[dict[str, str]],
    ) -> None:
        self.documents = documents
        self.dependency_manifests = dependency_manifests
        self.trees: dict[str, ast.Module] = {}
        self.document_paths = {document.path for document in documents}
        self.module_paths: dict[str, str | None] = {}
        self.primary_modules: dict[str, str] = {}
        self.module_environments: dict[str, dict[str, Value]] = {}
        self.module_stack: list[str] = []
        self.executing_modules: set[str] = set()
        self.parse_error = False
        self.has_source = False
        self.client_counter = 0
        self.valid_services: dict[str, set[int]] = {"sync": set(), "async": set()}
        self.client_configs: dict[int, ClientConfig] = {}
        self.logging_configured = False
        self.forbidden_auth = False
        self.operations: list[Operation] = []
        self.operation_counter = 0
        self.try_counter = 0
        self.try_stack: list[int] = []
        self.try_infos: dict[int, TryInfo] = {}
        self.guards: list[tuple[int, str]] = []
        self.call_stack: set[int] = set()

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

        imported = self.imported_local_paths()
        roots = [
            document.path
            for document in self.documents
            if document.path in self.trees and document.path not in imported
        ]
        for path in roots:
            self.execute_module(path, as_import=False)
        for path in self.trees:
            if path not in self.module_environments:
                self.execute_module(path, as_import=False)

        source_valid = self.has_source and not self.parse_error
        packages = (
            source_valid
            and declares_package(self.dependency_manifests, "azure-identity")
            and declares_package(self.dependency_manifests, "azure-storage-blob")
        )
        sync_chain = self.best_chain("sync")
        async_chain = self.best_chain("async")
        sync_complete_chains = self.complete_chains("sync")
        async_complete_chains = self.complete_chains("async")
        secure_clients = (
            source_valid
            and not self.forbidden_auth
            and self.chain_client_is_secure(sync_chain, "sync")
            and self.chain_client_is_secure(async_chain, "async")
        )
        retry_and_logging = (
            secure_clients
            and self.logging_configured
            and self.chain_client_has_retry_and_logging(sync_chain)
            and self.chain_client_has_retry_and_logging(async_chain)
        )
        sync_service = secure_clients and len(sync_chain) == 7
        async_service = secure_clients and len(async_chain) == 7
        upload_tags = (
            sync_service
            and async_service
            and self.chain_has_streaming_upload_and_tags(sync_chain)
            and self.chain_has_streaming_upload_and_tags(async_chain)
        )
        lease_overwrite = (
            sync_service
            and async_service
            and self.chain_has_lease_overwrite(sync_chain)
            and self.chain_has_lease_overwrite(async_chain)
        )
        timeouts = (
            sync_service
            and async_service
            and self.chain_has_timeouts(sync_chain)
            and self.chain_has_timeouts(async_chain)
        )
        error_handling = (
            sync_service
            and async_service
            and self.chain_has_error_handling(sync_chain)
            and self.chain_has_error_handling(async_chain)
        )
        demo = (
            sync_service
            and async_service
            and self.has_ordered_demo_workflow(
                sync_complete_chains,
                async_complete_chains,
            )
        )
        return {
            "prompt/sdk-packages": packages,
            "prompt/secure-client-configuration": secure_clients,
            "prompt/retry-and-http-logging": retry_and_logging,
            "prompt/sync-service-operations": sync_service,
            "prompt/async-service-operations": async_service,
            "prompt/streaming-upload-and-tags": upload_tags,
            "prompt/lease-protected-overwrite": lease_overwrite,
            "prompt/operation-timeouts": timeouts,
            "prompt/sdk-error-handling": error_handling,
            "prompt/demo-workflow": demo,
        }

    def best_chain(self, mode: str) -> list[Operation]:
        expected = self.expected_chain_kinds()
        best: list[Operation] = []
        for service in self.valid_services[mode]:
            candidates = [
                operation
                for operation in self.operations
                if operation.service == service and operation.mode == mode
            ]
            for start in range(len(candidates)):
                chain: list[Operation] = []
                index = 0
                for operation in candidates[start:]:
                    if operation.kind != expected[index]:
                        continue
                    if chain and not guards_compatible(chain, operation):
                        continue
                    if not self.operation_is_valid(index, operation, chain):
                        continue
                    chain.append(operation)
                    index += 1
                    if index == len(expected):
                        return chain
                if len(chain) > len(best):
                    best = chain
        return best

    @staticmethod
    def expected_chain_kinds() -> tuple[str, ...]:
        return (
            "upload-blob",
            "list-blobs",
            "download-blob",
            "save-download",
            "acquire-lease",
            "overwrite-blob",
            "delete-blob",
        )

    def complete_chains(self, mode: str) -> list[list[Operation]]:
        expected = self.expected_chain_kinds()
        complete: list[list[Operation]] = []
        for service in self.valid_services[mode]:
            candidates = [
                operation
                for operation in self.operations
                if operation.service == service and operation.mode == mode
            ]
            self.collect_complete_chains(
                candidates,
                expected,
                0,
                0,
                [],
                complete,
            )
        return complete

    def collect_complete_chains(
        self,
        candidates: list[Operation],
        expected: tuple[str, ...],
        start: int,
        index: int,
        chain: list[Operation],
        complete: list[list[Operation]],
    ) -> None:
        if index == len(expected):
            complete.append(chain.copy())
            return
        for position in range(start, len(candidates)):
            operation = candidates[position]
            if operation.kind != expected[index]:
                continue
            if chain and not guards_compatible(chain, operation):
                continue
            if not self.operation_is_valid(index, operation, chain):
                continue
            chain.append(operation)
            self.collect_complete_chains(
                candidates,
                expected,
                position + 1,
                index + 1,
                chain,
                complete,
            )
            chain.pop()

    def has_ordered_demo_workflow(
        self,
        sync_chains: list[list[Operation]],
        async_chains: list[list[Operation]],
    ) -> bool:
        for sync_chain in sync_chains:
            for async_chain in async_chains:
                if not chains_are_compatible(sync_chain, async_chain):
                    continue
                compatible_operations = [
                    operation
                    for operation in self.operations
                    if operation.mode in {"sync", "async"}
                    and operation_is_compatible_with_chains(
                        operation,
                        sync_chain,
                        async_chain,
                    )
                ]
                saw_sync = False
                saw_async = False
                interleaved = False
                for operation in compatible_operations:
                    if operation.mode == "sync":
                        saw_sync = True
                        if saw_async:
                            interleaved = True
                            break
                    else:
                        saw_async = True
                if saw_sync and saw_async and not interleaved:
                    return True
        return False

    def operation_is_valid(
        self,
        index: int,
        operation: Operation,
        chain: list[Operation],
    ) -> bool:
        if operation.kind == "upload-blob":
            return operation.streamed and operation.overwrite is True and not operation.lease
        if operation.kind == "save-download":
            return bool(chain) and operation.related == chain[index - 1].identifier
        if operation.kind == "acquire-lease":
            return operation.timeout
        if operation.kind == "overwrite-blob":
            lease_operation = chain[index - 1]
            return (
                operation.streamed
                and operation.overwrite is True
                and operation.lease
                and operation.related == lease_operation.identifier
            )
        return True

    def chain_client_is_secure(self, chain: list[Operation], mode: str) -> bool:
        if len(chain) != 7:
            return False
        config = self.client_configs.get(chain[0].service)
        return bool(
            config
            and config.mode == mode
            and account_url_from_environment(config.account_url_flags)
        )

    def chain_client_has_retry_and_logging(self, chain: list[Operation]) -> bool:
        if len(chain) != 7:
            return False
        config = self.client_configs.get(chain[0].service)
        return bool(config and config.logging_enabled and config.custom_retry)

    def chain_has_streaming_upload_and_tags(self, chain: list[Operation]) -> bool:
        if len(chain) != 7:
            return False
        upload = chain[0]
        return upload.streamed and upload.timeout and (
            upload.tags or self.has_tag_operation(upload, chain[1])
        )

    def has_tag_operation(self, upload: Operation, listing: Operation) -> bool:
        return any(
            operation.service == upload.service
            and operation.mode == upload.mode
            and operation.kind == "set-blob-tags"
            and upload.order < operation.order < listing.order
            and guards_compatible([upload], operation)
            for operation in self.operations
        )

    @staticmethod
    def chain_has_lease_overwrite(chain: list[Operation]) -> bool:
        if len(chain) != 7:
            return False
        acquire = chain[4]
        overwrite = chain[5]
        return (
            acquire.timeout
            and overwrite.timeout
            and overwrite.lease
            and overwrite.overwrite is True
        )

    @staticmethod
    def chain_has_timeouts(chain: list[Operation]) -> bool:
        if len(chain) != 7:
            return False
        timeout_indexes = [0, 1, 2, 4, 5, 6]
        return all(chain[index].timeout for index in timeout_indexes)

    def chain_has_error_handling(self, chain: list[Operation]) -> bool:
        if len(chain) != 7:
            return False
        core_indexes = [0, 1, 2, 4, 5, 6]
        if not all(self.operation_has_sdk_handler(chain[index]) for index in core_indexes):
            return False
        return self.operation_has_lease_handler(chain[4]) and self.operation_has_lease_handler(
            chain[5]
        )

    def operation_has_sdk_handler(self, operation: Operation) -> bool:
        accepted = {
            "azure.core.exceptions.HttpResponseError",
            "azure.core.exceptions.ResourceExistsError",
            "azure.core.exceptions.ResourceModifiedError",
            "azure.core.exceptions.ResourceNotFoundError",
        }
        return any(
            identifier in self.try_infos
            and self.try_infos[identifier].meaningful
            and bool(self.try_infos[identifier].catches & accepted)
            for identifier in operation.try_stack
        )

    def operation_has_lease_handler(self, operation: Operation) -> bool:
        accepted = {
            "azure.core.exceptions.ResourceExistsError",
            "azure.core.exceptions.ResourceModifiedError",
        }
        return any(
            identifier in self.try_infos
            and self.try_infos[identifier].meaningful
            and (
                bool(self.try_infos[identifier].catches & accepted)
                or self.try_infos[identifier].lease_conflict
            )
            for identifier in operation.try_stack
        )

    def register_module(self, path: str) -> None:
        parts = path.removesuffix(".py").split("/")
        if parts[-1] == "__init__":
            parts.pop()
        aliases = [".".join(parts)]
        if parts and parts[0] == "src":
            aliases.append(".".join(parts[1:]))
        aliases = [alias for alias in aliases if alias]
        self.primary_modules[path] = aliases[-1] if aliases else path
        for alias in aliases:
            if alias not in self.module_paths:
                self.module_paths[alias] = path
            elif self.module_paths[alias] != path:
                self.module_paths[alias] = None

    def resolve_local_module(
        self,
        module: str,
        *,
        importer: str | None,
        level: int = 0,
    ) -> str | None:
        name = module
        if level:
            if importer is None:
                return None
            current = self.primary_modules.get(importer, "")
            package = current if importer.endswith("/__init__.py") else current.rpartition(".")[0]
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
        ):
            return None
        return path

    def imported_local_paths(self) -> set[str]:
        paths: set[str] = set()
        for importer, tree in self.trees.items():
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        path = self.resolve_local_module(alias.name, importer=importer)
                        if path is not None:
                            paths.add(path)
                elif isinstance(node, ast.ImportFrom):
                    path = self.resolve_local_module(
                        node.module or "",
                        importer=importer,
                        level=node.level,
                    )
                    if path is not None:
                        paths.add(path)
        return paths

    def azure_import_is_shadowed(self, module: str, importer: str) -> bool:
        if not module.startswith("azure"):
            return False
        directory = importer.rpartition("/")[0]
        roots = [directory] if directory else [""]
        if importer.startswith("src/"):
            roots.append("src")
        for root in dict.fromkeys(roots):
            parts = module.split(".")
            for length in range(1, len(parts) + 1):
                prefix = "/".join(parts[:length])
                for suffix in (".py", "/__init__.py"):
                    candidate = "/".join(part for part in (root, prefix + suffix) if part)
                    if candidate in self.document_paths:
                        return True
        return False

    def execute_module(
        self,
        path: str,
        *,
        as_import: bool,
    ) -> dict[str, Value]:
        existing = self.module_environments.get(path)
        if existing is not None:
            return existing
        if path in self.executing_modules:
            return {}
        tree = self.trees[path]
        environment = self.base_environment(
            self.primary_modules.get(path, path) if as_import else "__main__"
        )
        self.module_environments[path] = environment
        self.executing_modules.add(path)
        self.module_stack.append(path)
        for statement in tree.body:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                environment[statement.name] = Value(
                    "function",
                    Function(statement, environment.copy()),
                )
            elif isinstance(statement, ast.ClassDef):
                environment[statement.name] = Value(
                    "class",
                    self.make_class(statement, environment),
                )
        try:
            flow = self.execute_block(tree.body, environment)
            environment.clear()
            environment.update(flow.environment)
        finally:
            self.module_stack.pop()
            self.executing_modules.remove(path)
        return environment

    @staticmethod
    def base_environment(module_name: str) -> dict[str, Value]:
        return {
            "__name__": Value("string", module_name),
            "open": Value("symbol", "builtins.open"),
            "print": Value("symbol", "builtins.print"),
            "Exception": Value("symbol", "builtins.Exception"),
            "BaseException": Value("symbol", "builtins.BaseException"),
            "int": Value("symbol", "builtins.int"),
            "getattr": Value("symbol", "builtins.getattr"),
        }

    @staticmethod
    def make_class(
        node: ast.ClassDef,
        environment: dict[str, Value],
    ) -> ClassInfo:
        return ClassInfo(
            {
                statement.name: Function(statement, environment.copy())
                for statement in node.body
                if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
        )

    def execute_block(
        self,
        statements: list[ast.stmt],
        environment: dict[str, Value],
    ) -> Flow:
        current = environment.copy()
        returned: list[Value] = []
        normal = True
        for statement in statements:
            if not normal:
                break
            flow = self.execute_statement(statement, current)
            current = flow.environment
            returned.extend(flow.returned)
            normal = flow.normal
        return Flow(current, normal, returned)

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
            function = (
                existing.data
                if existing is not None
                and existing.kind == "function"
                and existing.data.node is statement
                else Function(statement, current.copy())
            )
            function.closure = current.copy()
            current[statement.name] = Value("function", function)
            return Flow(current)
        if isinstance(statement, ast.ClassDef):
            existing = current.get(statement.name)
            class_info = (
                existing.data
                if existing is not None and existing.kind == "class"
                else self.make_class(statement, current)
            )
            for function in class_info.methods.values():
                function.closure = current.copy()
            current[statement.name] = Value("class", class_info)
            return Flow(current)
        if isinstance(statement, (ast.Assign, ast.AnnAssign)):
            value = self.expression(statement.value, current) if statement.value is not None else unknown()
            targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
            for target in targets:
                self.assign(target, value, current)
            return Flow(current)
        if isinstance(statement, ast.Expr):
            self.expression(statement.value, current)
            return Flow(current)
        if isinstance(statement, ast.Return):
            value = self.expression(statement.value, current) if statement.value is not None else Value("none")
            return Flow(current, False, [value])
        if isinstance(statement, ast.Raise):
            if statement.exc is not None:
                self.expression(statement.exc, current)
            return Flow(current, False)
        if isinstance(statement, ast.If):
            condition = self.boolean(statement.test, current)
            if condition is True:
                return self.execute_block(statement.body, current)
            if condition is False:
                return self.execute_block(statement.orelse, current)
            branch = id(statement)
            self.guards.append((branch, "body"))
            body = self.execute_block(statement.body, current)
            self.guards.pop()
            self.guards.append((branch, "else"))
            alternate = self.execute_block(statement.orelse, current)
            self.guards.pop()
            return self.merge_flows([body, alternate], current)
        if isinstance(statement, (ast.For, ast.AsyncFor)):
            iterable = self.expression(statement.iter, current)
            body_environment = current.copy()
            if iterable.kind == "blob-list":
                item = Value("blob-item")
            elif iterable.kind == "tuple":
                item = merge_values(list(iterable.data))
            else:
                item = unknown(value_flags(iterable))
            self.assign(statement.target, item, body_environment)
            body = self.execute_block(statement.body, body_environment)
            alternate = self.execute_block(statement.orelse, current)
            return self.merge_flows([Flow(current), body, alternate], current)
        if isinstance(statement, ast.While):
            condition = self.boolean(statement.test, current)
            if condition is False:
                return self.execute_block(statement.orelse, current)
            body = self.execute_block(statement.body, current)
            alternate = self.execute_block(statement.orelse, current)
            flows = [body, alternate]
            if condition is not True:
                flows.append(Flow(current))
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
        return Flow(current)

    def execute_try(
        self,
        statement: ast.Try | ast.TryStar,
        environment: dict[str, Value],
    ) -> Flow:
        self.try_counter += 1
        identifier = self.try_counter
        catches: set[str] = set()
        meaningful = False
        lease_conflict = False
        for handler in statement.handlers:
            catches |= self.exception_names(handler.type, environment)
            meaningful |= handler_is_meaningful(handler)
            lease_conflict |= handler_mentions_lease_conflict(handler, environment)
        self.try_infos[identifier] = TryInfo(
            identifier,
            catches,
            meaningful,
            lease_conflict,
        )

        self.try_stack.append(identifier)
        self.guards.append((identifier, "body"))
        body = self.execute_block(statement.body, environment)
        self.guards.pop()
        self.try_stack.pop()
        if body.normal and statement.orelse:
            body = self.execute_block(statement.orelse, body.environment)

        flows = [body]
        for index, handler in enumerate(statement.handlers):
            handler_environment = environment.copy()
            if handler.name:
                handler_environment[handler.name] = unknown()
            self.guards.append((identifier, f"handler:{index}"))
            flows.append(self.execute_block(handler.body, handler_environment))
            self.guards.pop()
        merged = self.merge_flows(flows, environment)
        if statement.finalbody:
            return self.execute_block(statement.finalbody, merged.environment)
        return merged

    @staticmethod
    def merge_flows(flows: list[Flow], fallback: dict[str, Value]) -> Flow:
        normal = [flow for flow in flows if flow.normal]
        returned = [value for flow in flows for value in flow.returned]
        if not normal:
            return Flow(fallback.copy(), False, returned)
        return Flow(merge_environments([flow.environment for flow in normal]), True, returned)

    def bind_import(
        self,
        statement: ast.Import | ast.ImportFrom,
        environment: dict[str, Value],
    ) -> None:
        importer = self.module_stack[-1]
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                local_path = self.resolve_local_module(alias.name, importer=importer)
                if local_path is not None:
                    module = Value("local-module", self.execute_module(local_path, as_import=True))
                    environment[alias.asname or alias.name.split(".")[0]] = module
                elif self.azure_import_is_shadowed(alias.name, importer):
                    environment[alias.asname or alias.name.split(".")[0]] = unknown()
                else:
                    binding = alias.asname or alias.name.split(".")[0]
                    environment[binding] = Value("symbol", alias.name if alias.asname else binding)
            return

        module = statement.module or ""
        local_path = self.resolve_local_module(
            module,
            importer=importer,
            level=statement.level,
        )
        local_environment = self.execute_module(local_path, as_import=True) if local_path is not None else None
        for alias in statement.names:
            if alias.name == "*":
                if local_environment is not None:
                    environment.update(local_environment)
                continue
            binding = alias.asname or alias.name
            if local_environment is not None:
                environment[binding] = local_environment.get(alias.name, unknown())
            elif self.azure_import_is_shadowed(module, importer):
                environment[binding] = unknown()
            else:
                environment[binding] = Value(
                    "symbol",
                    f"{module}.{alias.name}" if module else alias.name,
                )

    def expression(
        self,
        node: ast.expr | None,
        environment: dict[str, Value],
    ) -> Value:
        if node is None:
            return Value("none")
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                return Value("string", node.value)
            if isinstance(node.value, bool):
                return Value("bool", node.value)
            if node.value is None:
                return Value("none")
            return Value("literal", node.value)
        if isinstance(node, ast.Name):
            return environment.get(node.id, unknown())
        if isinstance(node, ast.Attribute):
            base = self.expression(node.value, environment)
            if base.kind == "symbol":
                return Value("symbol", f"{base.data}.{node.attr}")
            if base.kind == "local-module":
                return base.data.get(node.attr, unknown())
            if base.kind == "instance":
                member = base.data.members.get(node.attr)
                if member is not None:
                    return member
                function = base.data.class_info.methods.get(node.attr)
                if function is not None:
                    return Value("bound-function", (function, base))
            if base.kind in {
                "blob",
                "container",
                "download",
                "file",
                "lease",
                "logger",
                "path",
                "service",
            }:
                return Value("bound-sdk", (base, node.attr))
            return unknown(value_flags(base))
        if isinstance(node, ast.Await):
            return self.expression(node.value, environment)
        if isinstance(node, ast.Call):
            return self.call(node, environment)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left = self.expression(node.left, environment)
            right = self.expression(node.right, environment)
            if left.kind == right.kind == "string":
                return Value(
                    "string",
                    left.data + right.data,
                    value_flags(left) | value_flags(right),
                )
            return unknown(value_flags(left) | value_flags(right))
        if isinstance(node, ast.JoinedStr):
            values = [self.expression(value, environment) for value in node.values]
            return unknown(frozenset().union(*(value_flags(value) for value in values)))
        if isinstance(node, ast.FormattedValue):
            return self.expression(node.value, environment)
        if isinstance(node, ast.Dict):
            return Value("mapping")
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return Value("tuple", tuple(self.expression(item, environment) for item in node.elts))
        if isinstance(node, ast.IfExp):
            return merge_values(
                [self.expression(node.body, environment), self.expression(node.orelse, environment)]
            )
        if isinstance(node, ast.NamedExpr):
            value = self.expression(node.value, environment)
            self.assign(node.target, value, environment)
            return value
        if isinstance(node, ast.Subscript):
            base = self.expression(node.value, environment)
            key = subscript_key(node.slice, environment)
            if base.kind == "symbol" and base.data == "os.environ" and key is not None:
                return env_value(key)
            return unknown(value_flags(base))
        return unknown()

    def call(self, node: ast.Call, environment: dict[str, Value]) -> Value:
        function = self.expression(node.func, environment)
        positional = [self.expression(argument, environment) for argument in node.args]
        named = {
            keyword.arg: self.expression(keyword.value, environment)
            for keyword in node.keywords
            if keyword.arg is not None
        }
        if function.kind == "function":
            return self.invoke(function.data, positional, named, environment)
        if function.kind == "bound-function":
            info, instance = function.data
            return self.invoke(info, [instance, *positional], named, environment)
        if function.kind == "class":
            instance = Value("instance", Instance(function.data))
            initializer = function.data.methods.get("__init__")
            if initializer is not None:
                self.invoke(initializer, [instance, *positional], named, environment)
            return instance
        if function.kind == "bound-sdk":
            receiver, method = function.data
            return self.sdk_method(receiver, method, positional, named)
        if function.kind != "symbol":
            return unknown(frozenset().union(*(value_flags(value) for value in positional)))

        symbol = function.data
        if symbol == "builtins.print":
            return Value("none")
        if symbol == "builtins.open":
            path = path_value(argument(positional, named, 0, "file"))
            mode = string_value(argument(positional, named, 1, "mode")) or "r"
            return Value("file", (path, mode))
        if symbol == "builtins.int":
            source = argument(positional, named, 0, "x")
            return unknown(value_flags(source))
        if symbol == "builtins.getattr":
            source = argument(positional, named, 1, "name")
            return unknown(value_flags(source))
        if symbol in {"pathlib.Path", "pathlib.PurePath"}:
            return Value("path", path_value(argument(positional, named, 0, "pathsegments")))
        if symbol in {"os.getenv", "os.environ.get"}:
            key = string_value(argument(positional, named, 0, "key"))
            return env_value(key) if key is not None else unknown()
        if symbol == "logging.basicConfig":
            if has_argument(named, 0, "level", positional):
                self.logging_configured = True
            return Value("none")
        if symbol == "logging.getLogger":
            return Value("logger")
        if symbol == "asyncio.run":
            return Value("none")
        if symbol in {
            "azure.identity.DefaultAzureCredential",
            "azure.identity.aio.DefaultAzureCredential",
        }:
            return Value("credential", "async" if ".aio." in symbol else "sync")
        if symbol in {
            "azure.storage.blob.ExponentialRetry",
            "azure.storage.blob.aio.ExponentialRetry",
        }:
            return Value(
                "retry-policy",
                {
                    "mode": "exponential",
                    "custom": retry_policy_is_custom(node),
                },
            )
        if symbol in {
            "azure.storage.blob.BlobServiceClient.from_connection_string",
            "azure.storage.blob.aio.BlobServiceClient.from_connection_string",
        }:
            self.forbidden_auth = True
            return unknown()
        if symbol in {
            "azure.core.credentials.AzureNamedKeyCredential",
            "azure.core.credentials.AzureSasCredential",
            "azure.storage.blob._shared.authentication.StorageSharedKeyCredential",
        }:
            self.forbidden_auth = True
            return unknown()
        if symbol in {
            "azure.storage.blob.BlobServiceClient",
            "azure.storage.blob.aio.BlobServiceClient",
        }:
            mode = "async" if ".aio." in symbol else "sync"
            account_url = argument(positional, named, 0, "account_url")
            credential = argument(positional, named, 1, "credential")
            if credential.kind != "credential" or credential.data != mode:
                return unknown()
            if not account_url_from_environment(value_flags(account_url)):
                return unknown()
            self.client_counter += 1
            identifier = self.client_counter
            self.valid_services[mode].add(identifier)
            self.client_configs[identifier] = ClientConfig(
                mode=mode,
                account_url_flags=value_flags(account_url),
                logging_enabled=logging_is_enabled(named),
                custom_retry=client_has_custom_retry(named),
            )
            return Value("service", (identifier, mode))
        if symbol in {
            "azure.storage.blob.BlobLeaseClient",
            "azure.storage.blob.aio.BlobLeaseClient",
        }:
            target = argument(positional, named, 0, "client")
            if target.kind != "blob":
                return unknown()
            service, mode = target.data
            return Value("lease", Lease(service, mode))
        return unknown(frozenset().union(*(value_flags(value) for value in positional)))

    def sdk_method(
        self,
        receiver: Value,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        if receiver.kind == "path":
            if method == "open":
                mode = string_value(argument(positional, named, 0, "mode")) or "r"
                return Value("file", (receiver.data, mode))
            if method == "read_bytes":
                return Value("source-bytes", receiver.data)
        if receiver.kind == "logger" and method == "setLevel":
            if positional or named:
                self.logging_configured = True
            return Value("none")
        if receiver.kind == "service":
            service, mode = receiver.data
            if method == "get_container_client":
                return Value("container", (service, mode))
            if method == "get_blob_client":
                return Value("blob", (service, mode))
            if method == "create_container":
                return Value("container", (service, mode))
        if receiver.kind == "container":
            service, mode = receiver.data
            if method == "create_container":
                return receiver
            if method == "get_blob_client":
                return Value("blob", (service, mode))
            if method == "upload_blob":
                return self.record_upload(service, mode, positional, named)
            if method == "list_blobs":
                operation = self.record(
                    "list-blobs",
                    service,
                    mode,
                    timeout=has_argument(named, 0, "timeout", positional),
                )
                return Value("blob-list", operation)
            if method == "download_blob":
                operation = self.record(
                    "download-blob",
                    service,
                    mode,
                    timeout=has_argument(named, 0, "timeout", positional),
                )
                return Value("download", operation)
            if method == "delete_blob":
                self.record(
                    "delete-blob",
                    service,
                    mode,
                    timeout=has_argument(named, 0, "timeout", positional),
                )
                return Value("none")
        if receiver.kind == "blob":
            service, mode = receiver.data
            if method == "upload_blob":
                return self.record_upload(service, mode, positional, named)
            if method == "set_blob_tags":
                self.record("set-blob-tags", service, mode)
                return Value("none")
            if method == "download_blob":
                operation = self.record(
                    "download-blob",
                    service,
                    mode,
                    timeout=has_argument(named, 0, "timeout", positional),
                )
                return Value("download", operation)
            if method == "delete_blob":
                self.record(
                    "delete-blob",
                    service,
                    mode,
                    timeout=has_argument(named, 0, "timeout", positional),
                )
                return Value("none")
            if method == "acquire_lease":
                operation = self.record(
                    "acquire-lease",
                    service,
                    mode,
                    timeout=has_argument(named, 1, "timeout", positional),
                )
                return Value("lease", Lease(service, mode, operation.identifier))
        if receiver.kind == "lease":
            lease: Lease = receiver.data
            if method == "acquire":
                operation = self.record(
                    "acquire-lease",
                    lease.service,
                    lease.mode,
                    timeout=has_argument(named, 1, "timeout", positional),
                )
                lease.acquired = operation.identifier
                return receiver
            if method in {"release", "break_lease"}:
                return Value("none")
        if receiver.kind == "download":
            operation: Operation = receiver.data
            if method in {"readall", "content_as_bytes"}:
                return Value("downloaded-bytes", operation)
            if method == "readinto":
                destination = argument(positional, named, 0, "stream")
                if writable_path(destination):
                    self.record(
                        "save-download",
                        operation.service,
                        operation.mode,
                        related=operation.identifier,
                    )
                return Value("literal", 0)
        if receiver.kind == "file" and method == "write":
            data = argument(positional, named, 0, "data")
            if data.kind == "downloaded-bytes" and writable_path(receiver):
                operation = data.data
                self.record(
                    "save-download",
                    operation.service,
                    operation.mode,
                    related=operation.identifier,
                )
            return Value("literal", 0)
        if method in {"close", "__enter__", "__aenter__"}:
            return receiver
        if method == "format":
            return unknown(
                receiver.flags
                | frozenset().union(*(value_flags(value) for value in positional))
            )
        return unknown(
            value_flags(receiver)
            | frozenset().union(*(value_flags(value) for value in positional))
        )

    def record_upload(
        self,
        service: int,
        mode: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        data = argument(positional, named, 0, "data")
        overwrite = bool_value(named.get("overwrite", unknown()))
        lease_value = named.get("lease", unknown())
        lease = lease_value.kind == "lease" and lease_value.data.service == service
        related = lease_value.data.acquired if lease else None
        self.record(
            "overwrite-blob" if lease else "upload-blob",
            service,
            mode,
            related=related,
            streamed=upload_is_streamed(data),
            tags=has_meaningful_argument(named.get("tags", unknown())),
            timeout=has_argument(named, 0, "timeout", positional),
            overwrite=overwrite,
            lease=lease,
        )
        return Value("none")

    def invoke(
        self,
        function: Function,
        positional: list[Value],
        named: dict[str, Value],
        caller: dict[str, Value],
    ) -> Value:
        identity = id(function)
        if identity in self.call_stack:
            return unknown()
        self.call_stack.add(identity)
        environment = function.closure.copy()
        environment.update(
            {
                key: value
                for key, value in caller.items()
                if key not in environment or value.kind != "unknown"
            }
        )
        parameters = (
            list(function.node.args.posonlyargs)
            + list(function.node.args.args)
            + list(function.node.args.kwonlyargs)
        )
        for index, parameter in enumerate(parameters):
            if index < len(positional):
                environment[parameter.arg] = positional[index]
            elif parameter.arg in named:
                environment[parameter.arg] = named[parameter.arg]
        try:
            flow = self.execute_block(function.node.body, environment)
        finally:
            self.call_stack.remove(identity)
        return merge_values(flow.returned) if flow.returned else Value("none")

    def assign(
        self,
        target: ast.expr,
        value: Value,
        environment: dict[str, Value],
    ) -> None:
        if isinstance(target, ast.Name):
            environment[target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)) and value.kind == "tuple":
            for item, assigned in zip(target.elts, value.data, strict=False):
                self.assign(item, assigned, environment)
        elif isinstance(target, ast.Attribute):
            owner = self.expression(target.value, environment)
            if owner.kind == "instance":
                owner.data.members[target.attr] = value

    def boolean(
        self,
        node: ast.expr,
        environment: dict[str, Value],
    ) -> bool | None:
        value = self.expression(node, environment)
        if value.kind == "bool":
            return value.data
        if isinstance(node, ast.Compare) and len(node.ops) == len(node.comparators) == 1:
            left = self.expression(node.left, environment)
            right = self.expression(node.comparators[0], environment)
            if left.kind == right.kind == "string":
                if isinstance(node.ops[0], ast.Eq):
                    return left.data == right.data
                if isinstance(node.ops[0], ast.NotEq):
                    return left.data != right.data
        return None

    def exception_names(
        self,
        node: ast.expr | None,
        environment: dict[str, Value],
    ) -> set[str]:
        if node is None:
            return {"builtins.BaseException"}
        if isinstance(node, ast.Tuple):
            return set().union(*(self.exception_names(item, environment) for item in node.elts))
        value = self.expression(node, environment)
        return {value.data} if value.kind == "symbol" else set()

    def record(
        self,
        kind: str,
        service: int,
        mode: str,
        *,
        related: int | None = None,
        streamed: bool = False,
        tags: bool = False,
        timeout: bool = False,
        overwrite: bool | None = None,
        lease: bool = False,
    ) -> Operation:
        self.operation_counter += 1
        operation = Operation(
            self.operation_counter,
            kind,
            service,
            mode,
            self.operation_counter,
            related,
            streamed,
            tags,
            timeout,
            overwrite,
            lease,
            frozenset(self.guards),
            tuple(self.try_stack),
        )
        self.operations.append(operation)
        return operation


def argument(
    positional: list[Value],
    named: dict[str, Value],
    index: int,
    name: str,
) -> Value:
    if name in named:
        return named[name]
    return positional[index] if index < len(positional) else unknown()


def string_value(value: Value) -> str | None:
    return value.data if value.kind == "string" else None


def path_value(value: Value) -> str | None:
    if value.kind == "string":
        return value.data
    if value.kind == "path":
        return value.data
    return None


def bool_value(value: Value) -> bool | None:
    return value.data if value.kind == "bool" else None


def writable_path(value: Value) -> str | None:
    if value.kind != "file":
        return None
    path, mode = value.data
    return path if path is not None and "w" in mode and "b" in mode else None


def upload_is_streamed(value: Value) -> bool:
    if value.kind != "file":
        return False
    _, mode = value.data
    return "r" in mode and "b" in mode


def env_value(name: str | None) -> Value:
    if name is None:
        return unknown()
    return Value("env", name, frozenset({f"env:{name}"}))


def account_url_from_environment(flags: frozenset[str]) -> bool:
    return any(flag.startswith("env:") for flag in flags)


def logging_is_enabled(named: dict[str, Value]) -> bool:
    value = named.get("logging_enable")
    if value is None:
        return False
    if value.kind == "bool":
        return value.data
    return value.kind != "none"


def client_has_custom_retry(named: dict[str, Value]) -> bool:
    policy = named.get("retry_policy")
    if policy is not None and policy.kind == "retry-policy":
        details = policy.data
        return bool(details.get("mode") == "exponential" and details.get("custom"))
    if "retry_total" not in named:
        return False
    if not any(
        key in named for key in {"retry_backoff_factor", "retry_backoff_max", "initial_backoff", "increment_base"}
    ):
        return False
    retry_mode = named.get("retry_mode")
    mode_text = string_value(retry_mode) if retry_mode is not None else None
    return mode_text in {None, "exponential"}


def retry_policy_is_custom(node: ast.Call) -> bool:
    interesting = {"retry_total", "initial_backoff", "increment_base", "random_jitter_range"}
    return bool(node.args) or any(keyword.arg in interesting for keyword in node.keywords)


def has_argument(
    named: dict[str, Value],
    index: int,
    name: str,
    positional: list[Value],
) -> bool:
    return name in named or index < len(positional)


def has_meaningful_argument(value: Value) -> bool:
    return value.kind not in {"none", "unknown"} or bool(value.flags)


def subscript_key(node: ast.expr, environment: dict[str, Value]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        value = environment.get(node.id)
        return string_value(value) if value is not None else None
    return None


def guards_compatible(chain: list[Operation], candidate: Operation) -> bool:
    selected: dict[int, str] = {}
    for operation in [*chain, candidate]:
        for branch, arm in operation.guards:
            existing = selected.get(branch)
            if existing is not None and existing != arm:
                return False
            selected[branch] = arm
    return True


def chains_are_compatible(*chains: list[Operation]) -> bool:
    selected: list[Operation] = []
    for chain in chains:
        for operation in chain:
            if not guards_compatible(selected, operation):
                return False
            selected.append(operation)
    return True


def operation_is_compatible_with_chains(
    operation: Operation,
    *chains: list[Operation],
) -> bool:
    selected = [member for chain in chains for member in chain]
    return guards_compatible(selected, operation)


def handler_is_meaningful(handler: ast.ExceptHandler) -> bool:
    for node in ast.walk(ast.Module(body=handler.body, type_ignores=[])):
        if isinstance(node, ast.Raise):
            return True
        if isinstance(node, ast.Call):
            name = dotted(node.func) or ""
            if (
                name == "print"
                or name.endswith((".error", ".exception", ".warning"))
                or "raise" in name
            ):
                return True
    return False


def handler_mentions_lease_conflict(
    handler: ast.ExceptHandler,
    environment: dict[str, Value],
) -> bool:
    caught = canonical_exception_members(handler.type, environment)
    if caught & {
        "azure.core.exceptions.ResourceExistsError",
        "azure.core.exceptions.ResourceModifiedError",
    }:
        return True
    module = ast.Module(body=handler.body, type_ignores=[])
    for node in ast.walk(module):
        if isinstance(node, ast.Compare):
            texts: set[str] = set()
            numbers: set[int] = set()
            compared: list[ast.expr] = [node.left, *node.comparators]
            for item in compared:
                if isinstance(item, ast.Constant):
                    if isinstance(item.value, str):
                        texts.add(item.value.lower())
                    if isinstance(item.value, int):
                        numbers.add(item.value)
                elif isinstance(item, ast.Attribute):
                    name = dotted(item)
                    if name and name.endswith((".error_code", ".status_code")):
                        texts.add(name.lower())
            if numbers & {409, 412} and any(
                text.endswith((".error_code", ".status_code")) for text in texts
            ):
                return True
            if any(code in texts for code in LEASE_ERROR_CODES) and any(
                text.endswith(".error_code") for text in texts
            ):
                return True
    return False


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
            *(canonical_exception_members(item, environment) for item in node.elts)
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
    return unknown()


def is_docstring(statement: ast.stmt) -> bool:
    return (
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Constant)
        and isinstance(statement.value.value, str)
    )


def normalized_package(package: str) -> str:
    return re.sub(r"[-_.]+", "-", package).lower()


def requirement_package(declaration: str) -> str | None:
    pattern = re.compile(
        r"^(?P<package>[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)"
        r"(?:\[[^\]]+\])?"
        r"(?:\s*(?:===|==|~=|!=|<=|>=|<|>|@)\s*[^\s,]+"
        r"(?:\s*,\s*(?:!=|<=|>=|<|>)\s*[^\s,]+)*)?"
        r"(?:\s*;\s*.+)?$"
    )
    match = pattern.fullmatch(declaration)
    return match.group("package") if match else None


def runtime_requirements(filename: str) -> bool:
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if not re.fullmatch(r"requirements[^\\/]*\.txt", name, re.IGNORECASE):
        return False
    suffix = name[len("requirements") : -len(".txt")]
    parts = {part for part in re.split(r"[-_.]+", suffix.lower()) if part}
    return not parts & {"build", "ci", "dev", "development", "docs", "lint", "test", "tests"}


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
                isinstance(constraint, dict) and constraint.get("optional") is True
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
