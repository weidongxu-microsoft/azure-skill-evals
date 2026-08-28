from __future__ import annotations

import ast
import json
import re
import sys
import tomllib
from dataclasses import dataclass, field
from typing import Any


RULES = (
    "prompt/sdk-packages",
    "prompt/key-vault-envelope-operations",
    "prompt/local-aes-gcm-encryption",
    "prompt/encrypted-blob-metadata-round-trip",
    "prompt/credential-and-client-configuration",
    "prompt/sync-and-async-implementations",
    "prompt/sdk-error-handling",
    "prompt/ordered-demo-workflow",
)

KEY_NOT_FOUND = "azure.core.exceptions.ResourceNotFoundError"
HTTP_RESPONSE = "azure.core.exceptions.HttpResponseError"
REQUIRED_SDK_ERRORS = {KEY_NOT_FOUND, HTTP_RESPONSE}
REQUIRED_PACKAGES = {
    "azure-identity",
    "azure-storage-blob",
    "azure-keyvault-keys",
    "cryptography",
}
MUTATING_METHODS = {
    "__delitem__",
    "__setitem__",
    "append",
    "clear",
    "extend",
    "insert",
    "pop",
    "remove",
    "reverse",
    "setdefault",
    "sort",
    "update",
}

Tag = tuple[str, int | str]


@dataclass(frozen=True)
class Document:
    path: str
    source: str
    tree: ast.Module


def package_name(declaration: str) -> str | None:
    match = re.match(
        r"^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[.*?\])?",
        declaration.strip(),
    )
    if match is None:
        return None
    return match.group(1).lower().replace("_", "-").replace(".", "-")


def runtime_manifest(filename: str) -> bool:
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].lower()
    if name in {"pyproject.toml", "setup.py"}:
        return True
    if not re.fullmatch(r"requirements[^\\/]*\.txt", name):
        return False
    suffix = name[len("requirements") : -4]
    return not any(
        part in {"dev", "development", "test", "tests", "docs", "build", "ci", "lint"}
        for part in re.split(r"[-_.]+", suffix)
        if part
    )


def declared_packages(manifests: list[dict[str, str]]) -> set[str]:
    packages: set[str] = set()
    for manifest in manifests:
        filename = manifest["filename"].lower()
        content = manifest["content"]
        if not runtime_manifest(filename):
            continue
        if filename.endswith(".txt"):
            for line in content.splitlines():
                package = package_name(line.split("#", 1)[0])
                if package:
                    packages.add(package)
            continue
        if filename == "pyproject.toml":
            try:
                data = tomllib.loads(content)
            except tomllib.TOMLDecodeError:
                continue
            project = data.get("project", {})
            dependencies = project.get("dependencies", []) if isinstance(project, dict) else []
            for item in dependencies:
                if isinstance(item, str) and (package := package_name(item)):
                    packages.add(package)
            poetry = data.get("tool", {}).get("poetry", {})
            poetry_dependencies = (
                poetry.get("dependencies", {}) if isinstance(poetry, dict) else {}
            )
            if isinstance(poetry_dependencies, dict):
                packages.update(
                    name.lower().replace("_", "-").replace(".", "-")
                    for name, constraint in poetry_dependencies.items()
                    if name.lower() != "python"
                    and not (
                        isinstance(constraint, dict) and constraint.get("optional")
                    )
                )
            continue
        for match in re.finditer(
            r"""["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=~!@]|["'])""",
            content,
        ):
            packages.add(match.group(1).lower().replace("_", "-").replace(".", "-"))
    return packages


@dataclass
class Aggregate:
    members: dict[Any, Value] = field(default_factory=dict)


@dataclass
class Value:
    """A small symbolic value with provenance and transformation integrity."""

    kind: str
    data: Any = None
    tags: set[Tag] = field(default_factory=set)
    records: dict[int, Any] = field(default_factory=dict)
    exact: bool = True

    def copied(
        self,
        *,
        kind: str | None = None,
        data: Any = None,
        exact: bool | None = None,
    ) -> Value:
        return Value(
            self.kind if kind is None else kind,
            self.data if data is None else data,
            self.tags.copy(),
            self.records.copy(),
            self.exact if exact is None else exact,
        )


def unknown(*values: Value) -> Value:
    tags: set[Tag] = set()
    records: dict[int, Any] = {}
    for value in values:
        tags.update(value_tags(value))
        records.update(value.records)
    return Value("unknown", tags=tags, records=records, exact=False)


def value_tags(value: Value, seen: set[int] | None = None) -> set[Tag]:
    tags = value.tags.copy()
    seen = seen or set()
    identity = id(value)
    if identity in seen:
        return tags
    seen.add(identity)
    if value.kind == "aggregate" and isinstance(value.data, Aggregate):
        for member in value.data.members.values():
            tags.update(value_tags(member, seen))
    elif value.kind == "instance" and isinstance(value.data, Instance):
        for member in value.data.members.values():
            tags.update(value_tags(member, seen))
    return tags


def tag_value(value: Value, tags: set[Tag], seen: set[int] | None = None) -> None:
    value.tags.update(tags)
    seen = seen or set()
    identity = id(value)
    if identity in seen:
        return
    seen.add(identity)
    if value.kind == "aggregate" and isinstance(value.data, Aggregate):
        for member in value.data.members.values():
            tag_value(member, tags, seen)
    elif value.kind == "instance" and isinstance(value.data, Instance):
        for member in value.data.members.values():
            tag_value(member, tags, seen)


def merge_values(values: list[Value]) -> Value:
    if not values:
        return Value("none")
    if len(values) == 1:
        return values[0]
    tags: set[Tag] = set()
    records: dict[int, Any] = {}
    for value in values:
        tags.update(value_tags(value))
        records.update(value.records)
    first = values[0]
    exact = all(value.exact for value in values)
    if all(
        value.kind == first.kind and value.data is first.data for value in values[1:]
    ):
        return Value(first.kind, first.data, tags, records, exact)
    return Value("unknown", tags=tags, records=records, exact=False)


def literal_data(value: Value) -> object | None:
    if value.kind in {"literal", "string", "bytes"}:
        return value.data
    return None


def has_tag(value: Value, name: str, marker: int | str | None = None) -> bool:
    return any(
        tag_name == name and (marker is None or tag_marker == marker)
        for tag_name, tag_marker in value_tags(value)
    )


def tags_named(value: Value, name: str) -> set[int | str]:
    return {marker for tag_name, marker in value_tags(value) if tag_name == name}


def record_ids(value: Value) -> set[int]:
    return {
        marker
        for tag_name, marker in value_tags(value)
        if tag_name == "record" and isinstance(marker, int)
    } | set(value.records)


def is_exact_fresh(value: Value, kind: str, tag: str) -> bool:
    return value.exact and value.kind == kind and len(tags_named(value, tag)) == 1


def is_storage_endpoint_environment(name: str) -> bool:
    normalized = name.upper()
    return (
        ("STORAGE" in normalized or "BLOB" in normalized)
        and any(token in normalized for token in ("URL", "ENDPOINT", "ACCOUNT"))
    )


def is_key_identifier_environment(name: str) -> bool:
    normalized = name.upper()
    return "KEY" in normalized and any(
        token in normalized for token in ("ID", "URI", "IDENTIFIER")
    )


def is_key_vault_endpoint_environment(name: str) -> bool:
    normalized = name.upper()
    return "VAULT" in normalized and any(
        token in normalized for token in ("URL", "URI", "ENDPOINT")
    )


@dataclass
class FunctionInfo:
    node: ast.FunctionDef | ast.AsyncFunctionDef
    closure: dict[str, Value]
    scope: str
    owner: ClassInfo | None = None
    is_static: bool = False
    is_class: bool = False
    is_property: bool = False


@dataclass
class ClassInfo:
    name: str
    methods: dict[str, FunctionInfo]
    fields: list[str]


@dataclass
class Instance:
    class_info: ClassInfo
    members: dict[str, Value] = field(default_factory=dict)


@dataclass
class ModuleInfo:
    path: str
    name: str
    environment: dict[str, Value]


@dataclass(frozen=True)
class BoundFunction:
    function: FunctionInfo
    receiver: Value


@dataclass
class PendingCall:
    kind: str
    function: FunctionInfo | None = None
    receiver: Value | None = None
    method: str | None = None
    positional: tuple[Value, ...] = ()
    named: dict[str, Value] = field(default_factory=dict)
    consumed: bool = False


@dataclass(frozen=True)
class CredentialInfo:
    identifier: int
    mode: str


@dataclass(frozen=True)
class BlobServiceInfo:
    identifier: int
    mode: str
    credential: CredentialInfo
    account_url: Value


@dataclass(frozen=True)
class BlobClientInfo:
    identifier: int
    mode: str
    service: BlobServiceInfo
    target: tuple[Any, ...]


@dataclass(frozen=True)
class CryptoClientInfo:
    identifier: int
    mode: str
    credential: CredentialInfo
    key_sources: frozenset[int | str]
    key_clients: frozenset[int] = frozenset()


@dataclass(frozen=True)
class KeyClientInfo:
    identifier: int
    mode: str
    credential: CredentialInfo


@dataclass(frozen=True)
class VaultKeyInfo:
    identifier: int
    source: int | str
    client: KeyClientInfo


@dataclass(frozen=True)
class WrapInfo:
    operation: int
    crypto: CryptoClientInfo
    dek: int | str


@dataclass(frozen=True)
class CipherInfo:
    operation: int
    dek: int | str
    nonce: int | str
    plaintext: Value


@dataclass(frozen=True)
class PropertyRef:
    record: int
    operation: int
    blob: BlobClientInfo
    field: str | None = None


@dataclass(frozen=True)
class DownloadRef:
    record: int
    operation: int
    blob: BlobClientInfo


@dataclass(frozen=True)
class UnwrapInfo:
    operation: int
    crypto: CryptoClientInfo
    record: int
    property_operation: int
    dek: int | str


@dataclass(frozen=True)
class AESInfo:
    key: Value


@dataclass(frozen=True)
class Operation:
    identifier: int
    kind: str
    order: int
    mode: str
    guards: frozenset[tuple[int, str]]
    try_stack: tuple[int, ...]


@dataclass(frozen=True)
class BlobRecord:
    identifier: int
    operation: int
    mode: str
    target: tuple[Any, ...]
    blob: BlobClientInfo
    cipher: CipherInfo
    wrapped: WrapInfo
    nonce: int | str
    key_sources: frozenset[int | str]
    guards: frozenset[tuple[int, str]]


@dataclass(frozen=True)
class RoundTrip:
    record: BlobRecord
    property_operation: int
    property_blob: BlobClientInfo
    download_operation: int
    download_blob: BlobClientInfo
    unwrap: UnwrapInfo
    decrypt_operation: int
    guards: frozenset[tuple[int, str]]


@dataclass(frozen=True)
class Output:
    operation: int
    mode: str
    tags: frozenset[Tag]
    guards: frozenset[tuple[int, str]]


@dataclass
class TryInfo:
    identifier: int
    catches: set[str]
    meaningful: bool


@dataclass
class Flow:
    environment: dict[str, Value]
    normal: bool = True
    returned: list[Value] = field(default_factory=list)


def dotted_target(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_target(node.value)
        return f"{parent}.{node.attr}" if parent is not None else None
    return None


def decorator_names(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    return {
        name
        for decorator in node.decorator_list
        if (name := dotted_target(decorator)) is not None
    }


def guards_compatible(*guard_sets: frozenset[tuple[int, str]]) -> bool:
    selected: dict[int, str] = {}
    for guard_set in guard_sets:
        for branch, arm in guard_set:
            previous = selected.get(branch)
            if previous is not None and previous != arm:
                return False
            selected[branch] = arm
    return True


def statement_is_main_guard(statement: ast.stmt) -> bool:
    if not isinstance(statement, ast.If):
        return False
    test = statement.test
    if not isinstance(test, ast.Compare) or len(test.ops) != 1:
        return False
    if not isinstance(test.ops[0], (ast.Eq, ast.Is)):
        return False
    if len(test.comparators) != 1:
        return False
    left = dotted_target(test.left)
    right = test.comparators[0]
    return (
        left == "__name__"
        and isinstance(right, ast.Constant)
        and right.value == "__main__"
    ) or (
        dotted_target(right) == "__name__"
        and isinstance(test.left, ast.Constant)
        and test.left.value == "__main__"
    )


class Execution:
    """Symbolically executes one actual script entry and records SDK provenance."""

    def __init__(self, documents: list[Document], entry_path: str) -> None:
        self.documents = {document.path: document for document in documents}
        self.entry_path = entry_path
        self.module_names: dict[str, str] = {}
        self.module_paths: dict[str, str | None] = {}
        self.modules: dict[tuple[str, bool], ModuleInfo] = {}
        self.executing_modules: set[tuple[str, bool]] = set()
        self.call_stack: set[int] = set()
        self.guards: list[tuple[int, str]] = []
        self.try_stack: list[int] = []
        self.try_infos: dict[int, TryInfo] = {}
        self.mode = "sync"
        self.counter = 0
        self.try_counter = 0
        self.operations: dict[int, Operation] = {}
        self.records: dict[int, BlobRecord] = {}
        self.key_clients: dict[int, KeyClientInfo] = {}
        self.roundtrips: list[RoundTrip] = []
        self.outputs: list[Output] = []
        self.forbidden = False
        self.raw_dek_persisted = False
        self._index_modules()

    def _index_modules(self) -> None:
        for path in self.documents:
            normalized = path.replace("\\", "/")
            parts = normalized.removesuffix(".py").split("/")
            if parts[-1] == "__init__":
                parts.pop()
            aliases = [".".join(parts)] if parts else []
            if parts and parts[0] == "src":
                aliases.append(".".join(parts[1:]))
            aliases = [alias for alias in aliases if alias]
            name = aliases[-1] if aliases else normalized
            self.module_names[path] = name
            for alias in aliases:
                previous = self.module_paths.get(alias)
                self.module_paths[alias] = (
                    path if previous is None or previous == path else None
                )

    def execute(self) -> None:
        self.execute_module(self.entry_path, as_main=True)

    @staticmethod
    def base_environment(module_name: str) -> dict[str, Value]:
        return {
            "__name__": Value("string", module_name),
            "print": Value("symbol", "builtins.print"),
            "open": Value("symbol", "builtins.open"),
            "str": Value("symbol", "builtins.str"),
            "bytes": Value("symbol", "builtins.bytes"),
            "dict": Value("symbol", "builtins.dict"),
            "list": Value("symbol", "builtins.list"),
            "object": Value("symbol", "builtins.object"),
            "Exception": Value("symbol", "builtins.Exception"),
            "BaseException": Value("symbol", "builtins.BaseException"),
            "RuntimeError": Value("symbol", "builtins.RuntimeError"),
        }

    def execute_module(self, path: str, *, as_main: bool) -> ModuleInfo:
        key = (path, as_main)
        if key in self.modules:
            return self.modules[key]
        if key in self.executing_modules:
            return ModuleInfo(path, self.module_names[path], {})
        document = self.documents[path]
        name = "__main__" if as_main else self.module_names[path]
        environment = self.base_environment(name)
        module = ModuleInfo(path, name, environment)
        self.modules[key] = module
        self.executing_modules.add(key)
        self.predeclare(document.tree.body, environment, path)
        try:
            flow = self.execute_block(document.tree.body, environment, path)
            environment.clear()
            environment.update(flow.environment)
        finally:
            self.executing_modules.remove(key)
        return module

    def predeclare(
        self,
        statements: list[ast.stmt],
        environment: dict[str, Value],
        path: str,
    ) -> None:
        for statement in statements:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                environment[statement.name] = Value(
                    "function",
                    FunctionInfo(
                        statement,
                        environment.copy(),
                        f"{path}:{statement.name}:{statement.lineno}",
                    ),
                )
            elif isinstance(statement, ast.ClassDef):
                environment[statement.name] = Value(
                    "class",
                    self.make_class(statement, environment, path),
                )

    def make_class(
        self,
        node: ast.ClassDef,
        environment: dict[str, Value],
        path: str,
    ) -> ClassInfo:
        methods: dict[str, FunctionInfo] = {}
        fields: list[str] = []
        for member in node.body:
            if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                decorators = decorator_names(member)
                methods[member.name] = FunctionInfo(
                    member,
                    environment.copy(),
                    f"{path}:{node.name}:{member.name}:{member.lineno}",
                    is_static="staticmethod" in decorators,
                    is_class="classmethod" in decorators,
                    is_property="property" in decorators,
                )
            elif isinstance(member, ast.AnnAssign) and isinstance(member.target, ast.Name):
                fields.append(member.target.id)
            elif isinstance(member, ast.Assign):
                fields.extend(
                    target.id for target in member.targets if isinstance(target, ast.Name)
                )
        class_info = ClassInfo(node.name, methods, fields)
        for method in methods.values():
            method.owner = class_info
        return class_info

    def resolve_local_module(
        self,
        module: str,
        importer: str,
        level: int = 0,
    ) -> str | None:
        name = module
        if level:
            current = self.module_names.get(importer, "")
            package = current if importer.endswith("/__init__.py") else current.rpartition(".")[0]
            parts = [part for part in package.split(".") if part]
            remove = level - 1
            if remove > len(parts):
                return None
            parts = parts[: len(parts) - remove] if remove else parts
            if module:
                parts.extend(module.split("."))
            name = ".".join(parts)
        path = self.module_paths.get(name)
        if path is None:
            return None
        if importer.startswith("src/") != path.startswith("src/") and not level:
            return None
        return path

    def bind_import(
        self,
        statement: ast.Import | ast.ImportFrom,
        environment: dict[str, Value],
        path: str,
    ) -> None:
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                local_path = self.resolve_local_module(alias.name, path)
                binding = alias.asname or alias.name.split(".", 1)[0]
                if local_path is not None:
                    module = self.execute_module(local_path, as_main=False)
                    environment[binding] = Value("module", module)
                else:
                    environment[binding] = Value(
                        "symbol",
                        alias.name if alias.asname else alias.name.split(".", 1)[0],
                    )
            return

        if statement.module == "__future__":
            return
        module_name = statement.module or ""
        local_path = self.resolve_local_module(module_name, path, statement.level)
        if local_path is not None:
            module = self.execute_module(local_path, as_main=False)
            for alias in statement.names:
                if alias.name == "*":
                    environment.update(
                        {
                            name: value
                            for name, value in module.environment.items()
                            if not name.startswith("_")
                        }
                    )
                    continue
                binding = alias.asname or alias.name
                value = module.environment.get(alias.name)
                if value is None:
                    nested = self.resolve_local_module(
                        f"{module_name}.{alias.name}",
                        path,
                        statement.level,
                    )
                    value = (
                        Value("module", self.execute_module(nested, as_main=False))
                        if nested is not None
                        else unknown()
                    )
                environment[binding] = value
            return

        prefix = "." * statement.level + module_name
        for alias in statement.names:
            if alias.name == "*":
                continue
            binding = alias.asname or alias.name
            canonical = f"{prefix}.{alias.name}" if prefix else alias.name
            environment[binding] = Value("symbol", canonical)
            if canonical.startswith("azure.keyvault.secrets"):
                self.forbidden = True

    def execute_block(
        self,
        statements: list[ast.stmt],
        environment: dict[str, Value],
        path: str,
    ) -> Flow:
        current = environment.copy()
        returned: list[Value] = []
        normal = True
        for statement in statements:
            if not normal:
                break
            flow = self.execute_statement(statement, current, path)
            current = flow.environment
            returned.extend(flow.returned)
            normal = flow.normal
        return Flow(current, normal, returned)

    def execute_statement(
        self,
        statement: ast.stmt,
        environment: dict[str, Value],
        path: str,
    ) -> Flow:
        current = environment.copy()
        if isinstance(statement, (ast.Import, ast.ImportFrom)):
            self.bind_import(statement, current, path)
            return Flow(current)
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            existing = current.get(statement.name)
            function = (
                existing.data
                if existing is not None
                and existing.kind == "function"
                and existing.data.node is statement
                else FunctionInfo(
                    statement,
                    current.copy(),
                    f"{path}:{statement.name}:{statement.lineno}",
                )
            )
            function.closure = current.copy()
            current[statement.name] = Value("function", function)
            return Flow(current)
        if isinstance(statement, ast.ClassDef):
            existing = current.get(statement.name)
            class_info = (
                existing.data
                if existing is not None and existing.kind == "class"
                else self.make_class(statement, current, path)
            )
            for method in class_info.methods.values():
                method.closure = current.copy()
            current[statement.name] = Value("class", class_info)
            return Flow(current)
        if isinstance(statement, ast.Assign):
            value = self.expression(statement.value, current, path)
            for target in statement.targets:
                self.assign(target, value, current, path)
            return Flow(current)
        if isinstance(statement, ast.AnnAssign):
            value = (
                self.expression(statement.value, current, path)
                if statement.value is not None
                else unknown()
            )
            self.assign(statement.target, value, current, path)
            return Flow(current)
        if isinstance(statement, ast.AugAssign):
            self.assign(statement.target, unknown(), current, path)
            return Flow(current)
        if isinstance(statement, ast.Delete):
            for target in statement.targets:
                if isinstance(target, (ast.Attribute, ast.Subscript)):
                    self.invalidate(self.expression(target.value, current, path))
            return Flow(current)
        if isinstance(statement, ast.Expr):
            self.expression(statement.value, current, path)
            return Flow(current)
        if isinstance(statement, ast.Return):
            value = (
                self.expression(statement.value, current, path)
                if statement.value is not None
                else Value("none")
            )
            return Flow(current, False, [value])
        if isinstance(statement, ast.Raise):
            if statement.exc is not None:
                self.expression(statement.exc, current, path)
            return Flow(current, False)
        if isinstance(statement, ast.If):
            condition = self.boolean(statement.test, current, path)
            if condition is True:
                return self.execute_block(statement.body, current, path)
            if condition is False:
                return self.execute_block(statement.orelse, current, path)
            branch = id(statement)
            self.guards.append((branch, "body"))
            body = self.execute_block(statement.body, current, path)
            self.guards.pop()
            self.guards.append((branch, "else"))
            alternate = self.execute_block(statement.orelse, current, path)
            self.guards.pop()
            return self.merge_flows([body, alternate], current)
        if isinstance(statement, (ast.For, ast.AsyncFor)):
            iterable = self.expression(statement.iter, current, path)
            if self.is_empty_iterable(iterable):
                return self.execute_block(statement.orelse, current, path)
            item = self.iterable_item(iterable)
            if iterable.kind in {"tuple", "aggregate"}:
                body_environment = current.copy()
                self.assign(statement.target, item, body_environment, path)
                body = self.execute_block(statement.body, body_environment, path)
                alternate = self.execute_block(statement.orelse, current, path)
                return self.merge_flows([body, alternate], current)
            branch = id(statement)
            body_environment = current.copy()
            self.assign(statement.target, item, body_environment, path)
            self.guards.append((branch, "body"))
            body = self.execute_block(statement.body, body_environment, path)
            self.guards.pop()
            self.guards.append((branch, "skip"))
            alternate = self.execute_block(statement.orelse, current, path)
            self.guards.pop()
            return self.merge_flows([body, alternate, Flow(current)], current)
        if isinstance(statement, ast.While):
            condition = self.boolean(statement.test, current, path)
            if condition is False:
                return self.execute_block(statement.orelse, current, path)
            if condition is True:
                body = self.execute_block(statement.body, current, path)
                alternate = self.execute_block(statement.orelse, current, path)
                return self.merge_flows([body, alternate], current)
            branch = id(statement)
            self.guards.append((branch, "body"))
            body = self.execute_block(statement.body, current, path)
            self.guards.pop()
            self.guards.append((branch, "skip"))
            alternate = self.execute_block(statement.orelse, current, path)
            self.guards.pop()
            return self.merge_flows([body, alternate, Flow(current)], current)
        if isinstance(statement, (ast.With, ast.AsyncWith)):
            body_environment = current.copy()
            for item in statement.items:
                value = self.expression(item.context_expr, body_environment, path)
                if item.optional_vars is not None:
                    self.assign(item.optional_vars, value, body_environment, path)
            return self.execute_block(statement.body, body_environment, path)
        if isinstance(statement, (ast.Try, ast.TryStar)):
            return self.execute_try(statement, current, path)
        if isinstance(statement, ast.Match):
            flows: list[Flow] = []
            branch = id(statement)
            for index, case in enumerate(statement.cases):
                self.guards.append((branch, f"case:{index}"))
                flows.append(self.execute_block(case.body, current, path))
                self.guards.pop()
            flows.append(Flow(current))
            return self.merge_flows(flows, current)
        return Flow(current)

    def execute_try(
        self,
        statement: ast.Try | ast.TryStar,
        environment: dict[str, Value],
        path: str,
    ) -> Flow:
        self.try_counter += 1
        identifier = self.try_counter
        catches: set[str] = set()
        meaningful = False
        for handler in statement.handlers:
            catches.update(self.exception_names(handler.type, environment, path))
            meaningful = meaningful or self.handler_is_meaningful(handler)
        self.try_infos[identifier] = TryInfo(identifier, catches, meaningful)
        self.try_stack.append(identifier)
        body = self.execute_block(statement.body, environment, path)
        self.try_stack.pop()
        if body.normal and statement.orelse:
            body = self.execute_block(statement.orelse, body.environment, path)
        if statement.finalbody:
            final = self.execute_block(statement.finalbody, body.environment, path)
            return Flow(final.environment, final.normal, [*body.returned, *final.returned])
        return body

    def exception_names(
        self,
        node: ast.expr | None,
        environment: dict[str, Value],
        path: str,
    ) -> set[str]:
        if node is None:
            return set()
        if isinstance(node, ast.Tuple):
            return set().union(
                *(self.exception_names(item, environment, path) for item in node.elts)
            )
        value = self.expression(node, environment, path)
        return {value.data} if value.kind == "symbol" and isinstance(value.data, str) else set()

    @staticmethod
    def handler_is_meaningful(handler: ast.ExceptHandler) -> bool:
        for node in ast.walk(handler):
            if isinstance(node, ast.Raise):
                return True
            if isinstance(node, ast.Call):
                name = dotted_target(node.func) or ""
                if name == "print" or name.endswith(
                    (".error", ".exception", ".critical", ".warning", ".log")
                ):
                    return True
        return False

    def merge_flows(
        self,
        flows: list[Flow],
        fallback: dict[str, Value],
    ) -> Flow:
        normal = [flow for flow in flows if flow.normal]
        returned = [value for flow in flows for value in flow.returned]
        if not normal:
            return Flow(fallback.copy(), False, returned)
        keys = set().union(*(flow.environment.keys() for flow in normal))
        environment = {
            key: merge_values(
                [flow.environment.get(key, unknown()) for flow in normal],
            )
            for key in keys
        }
        return Flow(environment, True, returned)

    @staticmethod
    def is_empty_iterable(value: Value) -> bool:
        if value.kind == "tuple":
            return len(value.data) == 0
        if value.kind == "aggregate" and isinstance(value.data, Aggregate):
            return not value.data.members
        return False

    @staticmethod
    def iterable_item(value: Value) -> Value:
        if value.kind == "tuple":
            return merge_values(list(value.data))
        if value.kind == "aggregate" and isinstance(value.data, Aggregate):
            return merge_values(list(value.data.members.values()))
        return unknown(value)

    def boolean(
        self,
        node: ast.expr,
        environment: dict[str, Value],
        path: str,
    ) -> bool | None:
        value = self.expression(node, environment, path)
        literal = literal_data(value)
        if isinstance(literal, bool):
            return literal
        if isinstance(literal, (int, float, str, bytes)):
            return bool(literal)
        return None

    def expression(
        self,
        node: ast.expr | None,
        environment: dict[str, Value],
        path: str,
    ) -> Value:
        if node is None:
            return Value("none")
        if isinstance(node, ast.Name):
            return environment.get(node.id, unknown())
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                return Value("string", node.value)
            if isinstance(node.value, bytes):
                return Value("bytes", node.value)
            return Value("literal", node.value)
        if isinstance(node, ast.Attribute):
            return self.attribute(self.expression(node.value, environment, path), node.attr)
        if isinstance(node, ast.Subscript):
            base = self.expression(node.value, environment, path)
            key = self.expression(node.slice, environment, path)
            return self.subscript(base, key)
        if isinstance(node, ast.Tuple):
            values = tuple(self.expression(element, environment, path) for element in node.elts)
            return Value(
                "tuple",
                values,
                set().union(*(value_tags(value) for value in values)),
            )
        if isinstance(node, ast.List):
            values = [self.expression(element, environment, path) for element in node.elts]
            return Value(
                "aggregate",
                Aggregate(dict(enumerate(values))),
                set().union(*(value_tags(value) for value in values)),
            )
        if isinstance(node, ast.Set):
            values = [self.expression(element, environment, path) for element in node.elts]
            return Value(
                "aggregate",
                Aggregate(dict(enumerate(values))),
                set().union(*(value_tags(value) for value in values)),
            )
        if isinstance(node, ast.Dict):
            aggregate = Aggregate()
            for key_node, value_node in zip(node.keys, node.values, strict=True):
                key = self.expression(key_node, environment, path)
                value = self.expression(value_node, environment, path)
                aggregate.members[self.aggregate_key(key)] = value
            return Value("aggregate", aggregate)
        if isinstance(node, ast.Call):
            return self.call(node, environment, path)
        if isinstance(node, ast.Await):
            return self.consume(self.expression(node.value, environment, path))
        if isinstance(node, ast.JoinedStr):
            values = [
                self.expression(
                    item.value if isinstance(item, ast.FormattedValue) else item,
                    environment,
                    path,
                )
                for item in node.values
            ]
            tags = set().union(*(value_tags(value) for value in values))
            for value in values:
                tags.update(self.presentation_tags(value))
            return Value(
                "formatted",
                tags=tags,
                records={
                    record: source
                    for value in values
                    for record, source in value.records.items()
                },
            )
        if isinstance(node, ast.FormattedValue):
            return self.expression(node.value, environment, path)
        if isinstance(node, ast.IfExp):
            condition = self.boolean(node.test, environment, path)
            if condition is True:
                return self.expression(node.body, environment, path)
            if condition is False:
                return self.expression(node.orelse, environment, path)
            branch = id(node)
            self.guards.append((branch, "body"))
            body = self.expression(node.body, environment, path)
            self.guards.pop()
            self.guards.append((branch, "else"))
            alternate = self.expression(node.orelse, environment, path)
            self.guards.pop()
            return merge_values([body, alternate])
        if isinstance(node, ast.BoolOp):
            return self.boolean_operation(node, environment, path)
        if isinstance(node, ast.Compare):
            return self.compare(node, environment, path)
        if isinstance(node, ast.UnaryOp):
            value = self.expression(node.operand, environment, path)
            literal = literal_data(value)
            if isinstance(node.op, ast.Not) and literal is not None:
                return Value("literal", not bool(literal))
            if isinstance(node.op, (ast.UAdd, ast.USub)) and isinstance(literal, int):
                return Value("literal", literal if isinstance(node.op, ast.UAdd) else -literal)
            return unknown(value)
        if isinstance(node, ast.BinOp):
            left = self.expression(node.left, environment, path)
            right = self.expression(node.right, environment, path)
            left_data = literal_data(left)
            right_data = literal_data(right)
            if isinstance(node.op, ast.Add) and isinstance(left_data, str) and isinstance(
                right_data, str
            ):
                return Value(
                    "string",
                    left_data + right_data,
                    value_tags(left) | value_tags(right),
                )
            return unknown(left, right)
        if isinstance(node, ast.Starred):
            return self.expression(node.value, environment, path)
        return unknown()

    @staticmethod
    def aggregate_key(value: Value) -> Any:
        literal = literal_data(value)
        return literal if literal is not None else ("unknown", id(value))

    def boolean_operation(
        self,
        node: ast.BoolOp,
        environment: dict[str, Value],
        path: str,
    ) -> Value:
        values: list[Value] = []
        pushed = 0
        try:
            for index, child in enumerate(node.values):
                value = self.expression(child, environment, path)
                values.append(value)
                literal = literal_data(value)
                if isinstance(node.op, ast.And) and literal is not None and not bool(literal):
                    return value
                if isinstance(node.op, ast.Or) and literal is not None and bool(literal):
                    return value
                if literal is None and index < len(node.values) - 1:
                    arm = "truthy" if isinstance(node.op, ast.And) else "falsy"
                    self.guards.append((id(node), f"{arm}:{index}"))
                    pushed += 1
            return values[-1] if values else unknown()
        finally:
            for _ in range(pushed):
                self.guards.pop()

    def compare(
        self,
        node: ast.Compare,
        environment: dict[str, Value],
        path: str,
    ) -> Value:
        left = self.expression(node.left, environment, path)
        left_data = literal_data(left)
        if left_data is None:
            return unknown(left)
        for operator, comparator in zip(node.ops, node.comparators, strict=True):
            right = self.expression(comparator, environment, path)
            right_data = literal_data(right)
            if right_data is None:
                return unknown(left, right)
            if isinstance(operator, (ast.Eq, ast.Is)):
                result = left_data == right_data
            elif isinstance(operator, (ast.NotEq, ast.IsNot)):
                result = left_data != right_data
            elif isinstance(operator, ast.In):
                result = left_data in right_data
            elif isinstance(operator, ast.NotIn):
                result = left_data not in right_data
            else:
                return unknown(left, right)
            if not result:
                return Value("literal", False)
            left_data = right_data
        return Value("literal", True)

    def attribute(self, base: Value, name: str) -> Value:
        if base.kind == "symbol" and isinstance(base.data, str):
            canonical = f"{base.data}.{name}"
            if canonical.lower().endswith((".modes.cbc", ".modes.ecb")):
                self.forbidden = True
            return Value("symbol", canonical)
        if base.kind == "module" and isinstance(base.data, ModuleInfo):
            return base.data.environment.get(name, unknown(base))
        if base.kind == "instance" and isinstance(base.data, Instance):
            member = base.data.members.get(name)
            if member is not None:
                return member
            function = base.data.class_info.methods.get(name)
            if function is None:
                return unknown(base)
            if function.is_property:
                return self.invoke(function, [base], {})
            if function.is_static:
                return Value("function", function)
            if function.is_class:
                return Value(
                    "bound-function",
                    BoundFunction(function, Value("class", base.data.class_info)),
                )
            return Value("bound-function", BoundFunction(function, base))
        if base.kind == "class" and isinstance(base.data, ClassInfo):
            function = base.data.methods.get(name)
            if function is None:
                return unknown(base)
            if function.is_static:
                return Value("function", function)
            if function.is_class:
                return Value("bound-function", BoundFunction(function, base))
            return Value("bound-function", BoundFunction(function, base))
        if base.kind == "aggregate" and isinstance(base.data, Aggregate):
            member = base.data.members.get(name)
            if member is not None:
                return member
            if name in {"get", "items", "values"}:
                return Value("aggregate-method", (base, name))
            return unknown(base)
        if base.kind == "blob-service":
            return Value("sdk-method", (base, name))
        if base.kind == "blob-client":
            return Value("sdk-method", (base, name))
        if base.kind == "crypto-client":
            if name == "key_id":
                info = base.data
                return Value(
                    "key-id",
                    tags={
                        *{("key-source", source) for source in info.key_sources},
                        *{("key-id-value", source) for source in info.key_sources},
                    },
                )
            return Value("sdk-method", (base, name))
        if base.kind == "key-client":
            return Value("sdk-method", (base, name))
        if base.kind == "vault-key" and name == "id":
            info = base.data
            return Value(
                "key-id",
                tags={
                    ("key-source", info.source),
                    ("key-id-value", info.source),
                    ("key-client", info.client.identifier),
                },
            )
        if base.kind == "wrap-result" and name == "encrypted_key":
            info = base.data
            return Value(
                "wrapped",
                info,
                {
                    ("wrap", info.operation),
                    ("fresh-dek", info.dek),
                    *{("key-source", source) for source in info.crypto.key_sources},
                },
            )
        if base.kind == "unwrap-result" and name == "key":
            records: dict[int, UnwrapInfo] = base.records.copy()
            tags = value_tags(base)
            for info in records.values():
                tags.add(("fresh-dek", info.dek))
                tags.add(("record", info.record))
                tags.add(("unwrapped-dek", info.record))
            return Value("dek", tags=tags, records=records, exact=base.exact)
        if base.kind == "properties" and name == "metadata":
            return Value(
                "downloaded-metadata",
                tags=value_tags(base),
                records=base.records.copy(),
                exact=base.exact,
            )
        if base.kind == "downloaded-metadata" and name == "get":
            return Value("metadata-method", base)
        if base.kind == "download-stream" and name == "properties":
            return self.stream_properties(base)
        if base.kind == "download-stream":
            return Value("sdk-method", (base, name))
        if base.kind == "aes":
            return Value("aes-method", (base.data, name))
        if name in MUTATING_METHODS:
            return Value("mutation-method", (base, name))
        if name in {"decode", "encode", "strip", "lower", "upper", "format"}:
            return Value("transform-method", (base, name))
        if name in {
            "write",
            "write_text",
            "write_bytes",
            "writelines",
            "set_blob_metadata",
        }:
            return Value("persistence-method", (base, name))
        if name in {"close", "__enter__", "__aenter__", "__exit__", "__aexit__"}:
            return Value("lifecycle-method", (base, name))
        return unknown(base)

    def subscript(self, base: Value, key: Value) -> Value:
        key_data = literal_data(key)
        if base.kind == "symbol" and base.data == "os.environ" and isinstance(key_data, str):
            return self.environment_value(key_data)
        if base.kind == "aggregate" and isinstance(base.data, Aggregate):
            value = base.data.members.get(self.aggregate_key(key))
            return value if value is not None else unknown(base, key)
        if base.kind == "tuple" and isinstance(key_data, int):
            try:
                return base.data[key_data]
            except IndexError:
                return unknown(base, key)
        if base.kind == "downloaded-metadata" and isinstance(key_data, str):
            return self.downloaded_metadata_field(base, key_data)
        return unknown(base, key)

    def downloaded_metadata_field(self, value: Value, field: str) -> Value:
        values: list[Value] = []
        references: dict[int, PropertyRef] = {}
        for record_id, reference in value.records.items():
            if not isinstance(reference, PropertyRef):
                continue
            record = self.records.get(record_id)
            if record is None:
                continue
            if field == "wrapped_dek":
                source = Value(
                    "base64-wrapped",
                    record.wrapped,
                    {
                        ("wrapped-b64", record.wrapped.operation),
                        ("wrap", record.wrapped.operation),
                        ("fresh-dek", record.wrapped.dek),
                        ("record", record_id),
                        *{
                            ("key-source", item)
                            for item in record.wrapped.crypto.key_sources
                        },
                    },
                    exact=value.exact,
                )
            elif field == "nonce":
                source = Value(
                    "base64-nonce",
                    record.nonce,
                    {
                        ("nonce-b64", record.nonce),
                        ("fresh-nonce", record.nonce),
                        ("record", record_id),
                    },
                    exact=value.exact,
                )
            elif field == "key_id":
                source = Value(
                    "key-id",
                    tags={
                        ("record", record_id),
                        *{
                            ("key-source", item) for item in record.key_sources
                        },
                        *{
                            ("key-id-value", item) for item in record.key_sources
                        },
                    },
                    exact=value.exact,
                )
            else:
                continue
            source.records[record_id] = PropertyRef(
                record_id,
                reference.operation,
                reference.blob,
                field,
            )
            values.append(source)
            references.update(source.records)
        merged = merge_values(values) if values else unknown(value)
        merged.records.update(references)
        return merged

    def call(
        self,
        node: ast.Call,
        environment: dict[str, Value],
        path: str,
    ) -> Value:
        function = self.expression(node.func, environment, path)
        positional = [self.expression(argument, environment, path) for argument in node.args]
        named = {
            keyword.arg: self.expression(keyword.value, environment, path)
            for keyword in node.keywords
            if keyword.arg is not None
        }
        if function.kind == "function":
            info = function.data
            if isinstance(info.node, ast.AsyncFunctionDef):
                return self.function_awaitable(info, positional, named)
            return self.invoke(info, positional, named)
        if function.kind == "bound-function":
            bound = function.data
            if isinstance(bound.function.node, ast.AsyncFunctionDef):
                return self.function_awaitable(
                    bound.function,
                    [bound.receiver, *positional],
                    named,
                )
            return self.invoke(bound.function, [bound.receiver, *positional], named)
        if function.kind == "class":
            return self.instantiate(function.data, positional, named)
        if function.kind == "sdk-method":
            receiver, method = function.data
            return self.sdk_call(receiver, method, positional, named)
        if function.kind == "aes-method":
            aes, method = function.data
            return self.aes_call(aes, method, positional, named)
        if function.kind == "aggregate-method":
            aggregate, method = function.data
            return self.aggregate_call(aggregate, method, positional, named)
        if function.kind == "metadata-method":
            key = self.argument(positional, named, 0, "key")
            key_data = literal_data(key) if key is not None else None
            if isinstance(key_data, str):
                value = self.downloaded_metadata_field(function.data, key_data)
                if value.kind != "unknown":
                    return value
            return self.argument(positional, named, 1, "default") or Value("none")
        if function.kind == "mutation-method":
            receiver, _ = function.data
            self.invalidate(receiver)
            return Value("none")
        if function.kind == "transform-method":
            receiver, method = function.data
            if method == "format":
                values = [receiver, *positional, *named.values()]
                tags = set().union(*(value_tags(value) for value in values))
                for value in values:
                    tags.update(self.presentation_tags(value))
                return Value(
                    "formatted",
                    tags=tags,
                    records={
                        record: source
                        for value in values
                        for record, source in value.records.items()
                    },
                )
            return receiver.copied(
                exact=(
                    receiver.exact
                    and method in {"decode", "encode"}
                    and receiver.kind in {"base64-nonce", "base64-wrapped"}
                ),
            )
        if function.kind == "persistence-method":
            self.check_raw_persistence([*positional, *named.values()])
            return Value("none")
        if function.kind == "lifecycle-method":
            return Value("none")
        if function.kind != "symbol" or not isinstance(function.data, str):
            if isinstance(node.func, ast.Attribute) and node.func.attr in {
                "write",
                "write_text",
                "write_bytes",
                "writelines",
            }:
                self.check_raw_persistence([*positional, *named.values()])
            return unknown(function, *positional, *named.values())
        return self.symbol_call(function.data, positional, named)

    def symbol_call(
        self,
        canonical: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        if canonical in {
            "azure.identity.DefaultAzureCredential",
            "azure.identity.aio.DefaultAzureCredential",
        }:
            return self.make_credential(canonical)
        if canonical in {
            "azure.storage.blob.BlobServiceClient",
            "azure.storage.blob.aio.BlobServiceClient",
        }:
            return self.make_blob_service(canonical, positional, named)
        if canonical in {
            "azure.storage.blob.BlobClient",
            "azure.storage.blob.aio.BlobClient",
        }:
            return self.make_blob_client(canonical, positional, named)
        if canonical in {
            "azure.keyvault.keys.crypto.CryptographyClient",
            "azure.keyvault.keys.crypto.aio.CryptographyClient",
        }:
            return self.make_crypto_client(canonical, positional, named)
        if canonical in {
            "azure.keyvault.keys.KeyClient",
            "azure.keyvault.keys.aio.KeyClient",
        }:
            return self.make_key_client(canonical, positional, named)
        if canonical in {
            "cryptography.hazmat.primitives.ciphers.aead.AESGCM",
        }:
            return Value(
                "aes",
                AESInfo(self.argument(positional, named, 0, "key") or unknown()),
            )
        if canonical.endswith(".AESGCM.generate_key"):
            bit_length = self.argument(positional, named, 0, "bit_length")
            if literal_data(bit_length) == 256:
                return Value("dek", tags={("fresh-dek", self.next_identifier())})
            return Value("bytes")
        if canonical in {"secrets.token_bytes", "os.urandom"}:
            size = self.argument(positional, named, 0, "n", "nbytes", "size", "length")
            size_value = literal_data(size) if size is not None else None
            marker = self.next_identifier()
            if size_value == 32:
                return Value("dek", tags={("fresh-dek", marker)})
            if size_value == 12:
                return Value("nonce", tags={("fresh-nonce", marker)})
            return Value("bytes")
        if canonical in {
            "base64.b64encode",
            "base64.urlsafe_b64encode",
        }:
            return self.base64_encode(self.argument(positional, named, 0, "s") or unknown())
        if canonical in {
            "base64.b64decode",
            "base64.urlsafe_b64decode",
        }:
            return self.base64_decode(self.argument(positional, named, 0, "s") or unknown())
        if canonical == "asyncio.run":
            return self.consume(self.argument(positional, named, 0, "main") or unknown())
        if canonical == "builtins.print":
            self.record_output([*positional, *named.values()])
            return Value("none")
        if canonical in {"builtins.str", "builtins.bytes"}:
            return (positional[0] if positional else Value("string")).copied(exact=False)
        if canonical == "builtins.object":
            return Value("aggregate", Aggregate())
        if canonical in {"builtins.dict", "dict"}:
            return self.make_dict(positional, named)
        if canonical in {"os.getenv", "os.environ.get"}:
            key = self.argument(positional, named, 0, "key")
            key_data = literal_data(key) if key is not None else None
            return self.environment_value(key_data) if isinstance(key_data, str) else unknown()
        if canonical == "builtins.open":
            return Value("file")
        if canonical.endswith((".dump", ".dump_all")):
            self.check_raw_persistence([*positional, *named.values()])
            return unknown(*positional, *named.values())
        if canonical.startswith("azure.keyvault.secrets"):
            self.forbidden = True
        return unknown(*positional, *named.values())

    def make_credential(self, canonical: str) -> Value:
        identifier = self.next_identifier()
        mode = "async" if ".aio." in canonical else "sync"
        return Value("credential", CredentialInfo(identifier, mode))

    def make_blob_service(
        self,
        canonical: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        account_url = self.argument(positional, named, 0, "account_url")
        credential = self.argument(positional, named, 1, "credential")
        mode = "async" if ".aio." in canonical else "sync"
        if (
            account_url is None
            or credential is None
            or credential.kind != "credential"
            or credential.data.mode != mode
        ):
            return unknown(*(value for value in (account_url, credential) if value))
        return Value(
            "blob-service",
            BlobServiceInfo(
                self.next_identifier(),
                mode,
                credential.data,
                account_url,
            ),
        )

    def make_blob_client(
        self,
        canonical: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        account_url = self.argument(positional, named, 0, "account_url")
        container = self.argument(positional, named, 1, "container_name", "container")
        blob = self.argument(positional, named, 2, "blob_name", "blob")
        credential = self.argument(positional, named, 3, "credential")
        mode = "async" if ".aio." in canonical else "sync"
        if (
            account_url is None
            or credential is None
            or credential.kind != "credential"
            or credential.data.mode != mode
        ):
            return unknown(*(value for value in (account_url, credential) if value))
        service = BlobServiceInfo(
            self.next_identifier(),
            mode,
            credential.data,
            account_url,
        )
        return Value(
            "blob-client",
            BlobClientInfo(
                self.next_identifier(),
                mode,
                service,
                self.blob_target(service, container or unknown(), blob or unknown()),
            ),
        )

    def make_crypto_client(
        self,
        canonical: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        key_id = self.argument(positional, named, 0, "key_id")
        credential = self.argument(positional, named, 1, "credential")
        mode = "async" if ".aio." in canonical else "sync"
        sources = frozenset(tags_named(key_id, "key-source")) if key_id else frozenset()
        if (
            key_id is None
            or credential is None
            or credential.kind != "credential"
            or credential.data.mode != mode
            or not sources
        ):
            return unknown(*(value for value in (key_id, credential) if value))
        return Value(
            "crypto-client",
            CryptoClientInfo(
                self.next_identifier(),
                mode,
                credential.data,
                sources,
                frozenset(
                    source
                    for source in tags_named(key_id, "key-client")
                    if isinstance(source, int)
                ),
            ),
        )

    def make_key_client(
        self,
        canonical: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        vault_url = self.argument(positional, named, 0, "vault_url")
        credential = self.argument(positional, named, 1, "credential")
        mode = "async" if ".aio." in canonical else "sync"
        if (
            vault_url is None
            or credential is None
            or credential.kind != "credential"
            or credential.data.mode != mode
            or not tags_named(vault_url, "key-vault-endpoint")
        ):
            return unknown(
                *(value for value in (vault_url, credential) if value is not None),
            )
        info = KeyClientInfo(self.next_identifier(), mode, credential.data)
        self.key_clients[info.identifier] = info
        return Value("key-client", info)

    def make_dict(self, positional: list[Value], named: dict[str, Value]) -> Value:
        if positional and positional[0].kind == "aggregate":
            return positional[0]
        if positional and positional[0].kind == "downloaded-metadata":
            return Value(
                "aggregate",
                Aggregate(
                    {
                        field: self.downloaded_metadata_field(positional[0], field)
                        for field in ("wrapped_dek", "nonce", "key_id")
                    }
                ),
            )
        return Value("aggregate", Aggregate(named.copy()))

    def function_awaitable(
        self,
        function: FunctionInfo,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        return Value(
            "awaitable",
            PendingCall(
                "function",
                function=function,
                positional=tuple(positional),
                named=named.copy(),
            ),
        )

    def consume(self, value: Value) -> Value:
        if value.kind != "awaitable" or not isinstance(value.data, PendingCall):
            return unknown(value)
        pending = value.data
        if pending.consumed:
            return unknown(value)
        pending.consumed = True
        if pending.kind == "function" and pending.function is not None:
            old_mode = self.mode
            self.mode = "async"
            try:
                return self.invoke(
                    pending.function,
                    list(pending.positional),
                    pending.named,
                )
            finally:
                self.mode = old_mode
        if (
            pending.kind == "sdk"
            and pending.receiver is not None
            and pending.method is not None
        ):
            return self.execute_sdk(
                pending.receiver,
                pending.method,
                list(pending.positional),
                pending.named,
            )
        return unknown(value)

    def instantiate(
        self,
        class_info: ClassInfo,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        instance = Value("instance", Instance(class_info))
        initializer = class_info.methods.get("__init__")
        if initializer is not None:
            self.invoke(initializer, [instance, *positional], named)
            return instance
        for field_name, value in zip(class_info.fields, positional, strict=False):
            instance.data.members[field_name] = value
        for field_name in class_info.fields:
            if field_name in named:
                instance.data.members[field_name] = named[field_name]
        return instance

    def invoke(
        self,
        function: FunctionInfo,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        identity = id(function.node)
        if identity in self.call_stack:
            return unknown()
        self.call_stack.add(identity)
        environment = function.closure.copy()
        parameters = [*function.node.args.posonlyargs, *function.node.args.args]
        defaults = [None] * (len(parameters) - len(function.node.args.defaults)) + list(
            function.node.args.defaults
        )
        for index, parameter in enumerate(parameters):
            if index < len(positional):
                environment[parameter.arg] = self.abstract_payload_parameter(
                    parameter.arg,
                    positional[index],
                )
            elif parameter.arg in named:
                environment[parameter.arg] = self.abstract_payload_parameter(
                    parameter.arg,
                    named[parameter.arg],
                )
            elif defaults[index] is not None:
                environment[parameter.arg] = self.expression(
                    defaults[index],
                    environment,
                    function.scope.rsplit(":", 3)[0],
                )
            else:
                environment[parameter.arg] = unknown()
        if function.node.args.vararg is not None:
            environment[function.node.args.vararg.arg] = Value(
                "tuple",
                tuple(positional[len(parameters) :]),
            )
        for parameter, default in zip(
            function.node.args.kwonlyargs,
            function.node.args.kw_defaults,
            strict=True,
        ):
            environment[parameter.arg] = (
                named[parameter.arg]
                if parameter.arg in named
                else self.expression(
                    default,
                    environment,
                    function.scope.rsplit(":", 3)[0],
                )
                if default is not None
                else unknown()
            )
        try:
            path = function.scope.rsplit(":", 3)[0]
            flow = self.execute_block(function.node.body, environment, path)
            return merge_values(flow.returned) if flow.returned else Value("none")
        finally:
            self.call_stack.remove(identity)

    @staticmethod
    def abstract_payload_parameter(parameter: str, value: Value) -> Value:
        """Do not treat one demo literal as proof that every upload path encrypts."""

        if (
            parameter.lower() in {"plaintext", "payload", "content", "message", "data"}
            and value.kind in {"bytes", "string", "literal"}
        ):
            return Value(
                "input",
                tags=value_tags(value),
                records=value.records.copy(),
            )
        return value

    def assign(
        self,
        target: ast.expr,
        value: Value,
        environment: dict[str, Value],
        path: str,
    ) -> None:
        if isinstance(target, ast.Name):
            environment[target.id] = value
            return
        if isinstance(target, ast.Attribute):
            base = self.expression(target.value, environment, path)
            if base.kind == "instance" and isinstance(base.data, Instance):
                base.data.members[target.attr] = value
            elif base.kind == "aggregate" and isinstance(base.data, Aggregate):
                base.data.members[target.attr] = value
            return
        if isinstance(target, ast.Subscript):
            base = self.expression(target.value, environment, path)
            key = self.expression(target.slice, environment, path)
            if base.kind == "aggregate" and isinstance(base.data, Aggregate):
                base.data.members[self.aggregate_key(key)] = value
            else:
                self.invalidate(base)
            return
        if isinstance(target, (ast.Tuple, ast.List)):
            if target.elts and value.kind == "tuple" and len(value.data) == len(target.elts):
                for child, item in zip(target.elts, value.data, strict=True):
                    self.assign(child, item, environment, path)
            else:
                for child in target.elts:
                    self.assign(child, unknown(value), environment, path)

    @staticmethod
    def invalidate(value: Value) -> None:
        value.exact = False

    @staticmethod
    def argument(
        positional: list[Value],
        named: dict[str, Value],
        index: int,
        *names: str,
    ) -> Value | None:
        for name in names:
            if name in named:
                return named[name]
        return positional[index] if index < len(positional) else None

    def environment_value(self, key: str) -> Value:
        tags: set[Tag] = {("environment", key)}
        if is_storage_endpoint_environment(key):
            tags.add(("storage-endpoint", key))
        if is_key_identifier_environment(key):
            tags.update(
                {
                    ("key-source", key),
                    ("key-id-value", key),
                }
            )
        if is_key_vault_endpoint_environment(key):
            tags.add(("key-vault-endpoint", key))
        return Value("environment", key, tags)

    def sdk_call(
        self,
        receiver: Value,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        info = receiver.data
        if receiver.kind == "blob-service" and method == "get_blob_client":
            return self.execute_sdk(receiver, method, positional, named)
        is_async = (
            isinstance(
                info,
                (BlobClientInfo, BlobServiceInfo, CryptoClientInfo, KeyClientInfo),
            )
            and info.mode == "async"
        ) or (
            receiver.kind == "download-stream"
            and any(
                isinstance(reference, DownloadRef) and reference.blob.mode == "async"
                for reference in receiver.records.values()
            )
        )
        if is_async:
            return Value(
                "awaitable",
                PendingCall(
                    "sdk",
                    receiver=receiver,
                    method=method,
                    positional=tuple(positional),
                    named=named.copy(),
                ),
            )
        return self.execute_sdk(receiver, method, positional, named)

    def execute_sdk(
        self,
        receiver: Value,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        if receiver.kind == "blob-service" and method == "get_blob_client":
            container = self.argument(positional, named, 0, "container", "container_name")
            blob = self.argument(positional, named, 1, "blob", "blob_name")
            service = receiver.data
            return Value(
                "blob-client",
                BlobClientInfo(
                    self.next_identifier(),
                    service.mode,
                    service,
                    self.blob_target(service, container or unknown(), blob or unknown()),
                ),
            )
        if receiver.kind == "blob-client":
            if method == "upload_blob":
                return self.upload_blob(receiver.data, positional, named)
            if method == "set_blob_metadata":
                self.check_raw_persistence([*positional, *named.values()])
                return Value("none")
            if method == "get_blob_properties":
                return self.get_blob_properties(receiver.data)
            if method == "download_blob":
                return self.download_blob(receiver.data)
            if method in {"close", "__enter__", "__aenter__", "__exit__", "__aexit__"}:
                return Value("none")
        if receiver.kind == "download-stream" and method == "readall":
            return self.read_download(receiver)
        if receiver.kind == "crypto-client":
            if method == "wrap_key":
                return self.wrap_key(receiver.data, positional, named)
            if method == "unwrap_key":
                return self.unwrap_key(receiver.data, positional, named)
            if method in {"encrypt", "decrypt"}:
                self.forbidden = True
                return unknown(receiver, *positional, *named.values())
            if method in {"close", "__enter__", "__aenter__", "__exit__", "__aexit__"}:
                return Value("none")
        if receiver.kind == "key-client" and method == "get_key":
            operation = self.record_operation("get-key", receiver.data.mode)
            source = f"vault-key:{receiver.data.identifier}:{operation.identifier}"
            return Value(
                "vault-key",
                VaultKeyInfo(operation.identifier, source, receiver.data),
            )
        return unknown(receiver, *positional, *named.values())

    def aes_call(
        self,
        aes: AESInfo,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        if method == "encrypt":
            nonce = self.argument(positional, named, 0, "nonce")
            plaintext = self.argument(positional, named, 1, "data")
            if nonce is None or plaintext is None:
                return unknown(aes.key)
            dek_sources = tags_named(aes.key, "fresh-dek")
            nonce_sources = tags_named(nonce, "fresh-nonce")
            if (
                not is_exact_fresh(aes.key, "dek", "fresh-dek")
                or not is_exact_fresh(nonce, "nonce", "fresh-nonce")
                or len(dek_sources) != 1
                or len(nonce_sources) != 1
            ):
                return unknown(aes.key, nonce, plaintext)
            operation = self.record_operation("encrypt")
            info = CipherInfo(
                operation.identifier,
                next(iter(dek_sources)),
                next(iter(nonce_sources)),
                plaintext,
            )
            return Value(
                "ciphertext",
                info,
                {
                    ("ciphertext", info.operation),
                    ("fresh-dek", info.dek),
                    ("fresh-nonce", info.nonce),
                },
            )
        if method == "decrypt":
            nonce = self.argument(positional, named, 0, "nonce")
            ciphertext = self.argument(positional, named, 1, "data")
            if (
                aes.key.kind != "dek"
                or not aes.key.exact
                or nonce is None
                or ciphertext is None
            ):
                return unknown(aes.key)
            return self.decrypt(aes.key, nonce, ciphertext)
        return unknown(aes.key, *positional, *named.values())

    def aggregate_call(
        self,
        aggregate: Value,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        if not isinstance(aggregate.data, Aggregate):
            return unknown(aggregate)
        if method == "get":
            key = self.argument(positional, named, 0, "key")
            return (
                aggregate.data.members.get(self.aggregate_key(key))
                if key is not None
                else unknown(aggregate)
            ) or (self.argument(positional, named, 1, "default") or Value("none"))
        if method == "values":
            return Value("tuple", tuple(aggregate.data.members.values()))
        return unknown(aggregate)

    def base64_encode(self, value: Value) -> Value:
        tags = value_tags(value)
        if value.kind == "wrapped":
            tags.add(("wrapped-b64", value.data.operation))
            return Value(
                "base64-wrapped",
                value.data,
                tags,
                value.records.copy(),
                value.exact,
            )
        if value.kind == "nonce":
            for marker in tags_named(value, "fresh-nonce"):
                tags.add(("nonce-b64", marker))
            return Value(
                "base64-nonce",
                value.data,
                tags,
                value.records.copy(),
                value.exact,
            )
        if value.kind == "dek":
            return Value("base64-raw-dek", value.data, tags, value.records.copy(), False)
        return Value("base64", value.data, tags, value.records.copy(), False)

    def base64_decode(self, value: Value) -> Value:
        tags = value_tags(value)
        if value.kind == "base64-wrapped":
            return Value("wrapped", value.data, tags, value.records.copy(), value.exact)
        if value.kind == "base64-nonce":
            return Value("nonce", value.data, tags, value.records.copy(), value.exact)
        if value.kind == "base64-raw-dek":
            return Value("dek", value.data, tags, value.records.copy(), False)
        return Value("bytes", value.data, tags, value.records.copy(), False)

    def check_raw_persistence(self, values: list[Value]) -> None:
        if any(self.exposes_raw_dek(value) for value in values):
            self.raw_dek_persisted = True

    def exposes_raw_dek(self, value: Value, seen: set[int] | None = None) -> bool:
        if value.kind in {"dek", "base64-raw-dek"}:
            return True
        seen = seen or set()
        identity = id(value)
        if identity in seen:
            return False
        seen.add(identity)
        if value.kind == "aggregate" and isinstance(value.data, Aggregate):
            return any(
                self.exposes_raw_dek(member, seen)
                for member in value.data.members.values()
            )
        if value.kind == "instance" and isinstance(value.data, Instance):
            return any(
                self.exposes_raw_dek(member, seen)
                for member in value.data.members.values()
            )
        return (
            has_tag(value, "fresh-dek")
            and not has_tag(value, "wrap")
            and not has_tag(value, "ciphertext")
        )

    def blob_target(
        self,
        service: BlobServiceInfo,
        container: Value,
        blob: Value,
    ) -> tuple[Any, ...]:
        return (
            self.value_identity(service.account_url),
            self.value_identity(container),
            self.value_identity(blob),
        )

    @staticmethod
    def value_identity(value: Value) -> tuple[Any, ...]:
        literal = literal_data(value)
        if literal is not None:
            return ("literal", literal)
        return ("tags", tuple(sorted(value_tags(value), key=repr)))

    def upload_blob(
        self,
        blob: BlobClientInfo,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        data = self.argument(positional, named, 0, "data")
        metadata = named.get("metadata")
        operation = self.record_operation("upload", blob.mode)
        self.check_raw_persistence(
            [value for value in (data, metadata) if value is not None],
        )
        if data is None or metadata is None:
            return Value("none")
        record = self.valid_blob_record(operation, blob, data, metadata)
        if record is not None:
            self.records[record.identifier] = record
            tag_value(metadata, {("record", record.identifier)})
        return Value("none")

    def valid_blob_record(
        self,
        operation: Operation,
        blob: BlobClientInfo,
        data: Value,
        metadata: Value,
    ) -> BlobRecord | None:
        if (
            data.kind != "ciphertext"
            or not data.exact
            or not isinstance(data.data, CipherInfo)
        ):
            return None
        if (
            metadata.kind != "aggregate"
            or not metadata.exact
            or not isinstance(metadata.data, Aggregate)
        ):
            return None
        wrapped = metadata.data.members.get("wrapped_dek")
        nonce = metadata.data.members.get("nonce")
        key_id = metadata.data.members.get("key_id")
        if wrapped is None or nonce is None or key_id is None:
            return None
        cipher = data.data
        if (
            wrapped.kind != "base64-wrapped"
            or not wrapped.exact
            or not isinstance(wrapped.data, WrapInfo)
            or wrapped.data.dek != cipher.dek
            or nonce.kind != "base64-nonce"
            or not nonce.exact
            or len(tags_named(nonce, "fresh-nonce")) != 1
            or next(iter(tags_named(nonce, "fresh-nonce"))) != cipher.nonce
            or key_id.kind != "key-id"
            or not key_id.exact
        ):
            return None
        key_sources = frozenset(tags_named(key_id, "key-source"))
        if not key_sources or key_sources != wrapped.data.crypto.key_sources:
            return None
        if (
            wrapped.data.operation not in tags_named(wrapped, "wrap")
            or cipher.dek not in tags_named(data, "fresh-dek")
            or cipher.nonce not in tags_named(data, "fresh-nonce")
        ):
            return None
        return BlobRecord(
            operation.identifier,
            operation.identifier,
            blob.mode,
            blob.target,
            blob,
            cipher,
            wrapped.data,
            cipher.nonce,
            key_sources,
            operation.guards,
        )

    def matching_records(self, blob: BlobClientInfo, operation: Operation) -> dict[int, BlobRecord]:
        return {
            record_id: record
            for record_id, record in self.records.items()
            if record.mode == blob.mode
            and record.target == blob.target
            and record.operation < operation.identifier
            and guards_compatible(record.guards, operation.guards)
        }

    def get_blob_properties(self, blob: BlobClientInfo) -> Value:
        operation = self.record_operation("properties", blob.mode)
        records = self.matching_records(blob, operation)
        return Value(
            "properties",
            tags={("record", record_id) for record_id in records},
            records={
                record_id: PropertyRef(record_id, operation.identifier, blob)
                for record_id in records
            },
        )

    def download_blob(self, blob: BlobClientInfo) -> Value:
        operation = self.record_operation("download", blob.mode)
        records = self.matching_records(blob, operation)
        return Value(
            "download-stream",
            tags={("record", record_id) for record_id in records},
            records={
                record_id: DownloadRef(record_id, operation.identifier, blob)
                for record_id in records
            },
        )

    def stream_properties(self, stream: Value) -> Value:
        mode = next(
            (
                reference.blob.mode
                for reference in stream.records.values()
                if isinstance(reference, DownloadRef)
            ),
            self.mode,
        )
        operation = self.record_operation("properties", mode)
        references: dict[int, PropertyRef] = {}
        for record_id, reference in stream.records.items():
            if not isinstance(reference, DownloadRef):
                continue
            record = self.records.get(record_id)
            if (
                record is not None
                and guards_compatible(record.guards, operation.guards)
            ):
                references[record_id] = PropertyRef(
                    record_id,
                    operation.identifier,
                    reference.blob,
                )
        return Value(
            "properties",
            tags={("record", record_id) for record_id in references},
            records=references,
            exact=stream.exact,
        )

    def read_download(self, stream: Value) -> Value:
        values: list[Value] = []
        records: dict[int, DownloadRef] = {}
        for record_id, reference in stream.records.items():
            if not isinstance(reference, DownloadRef):
                continue
            record = self.records.get(record_id)
            if record is None:
                continue
            cipher = record.cipher
            value = Value(
                "ciphertext",
                cipher,
                {
                    ("record", record_id),
                    ("ciphertext", cipher.operation),
                    ("fresh-dek", cipher.dek),
                    ("fresh-nonce", cipher.nonce),
                },
                {record_id: reference},
                stream.exact,
            )
            values.append(value)
            records[record_id] = reference
        result = merge_values(values) if values else unknown(stream)
        result.records.update(records)
        return result

    @staticmethod
    def rsa_oaep(value: Value | None) -> bool:
        if value is None:
            return False
        if value.kind == "symbol" and isinstance(value.data, str):
            return bool(
                re.search(r"rsa[-_]?oaep(?:[-_]?256)?$", value.data, re.IGNORECASE)
            )
        literal = literal_data(value)
        return isinstance(literal, str) and bool(
            re.fullmatch(r"rsa[-_]?oaep(?:[-_]?256)?", literal, re.IGNORECASE)
        )

    def wrap_key(
        self,
        crypto: CryptoClientInfo,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        algorithm = self.argument(
            positional,
            named,
            0,
            "algorithm",
            "alg",
            "key_wrap_algorithm",
        )
        key = self.argument(positional, named, 1, "key", "data")
        dek_sources = tags_named(key, "fresh-dek") if key is not None else set()
        if (
            key is None
            or not self.rsa_oaep(algorithm)
            or not is_exact_fresh(key, "dek", "fresh-dek")
            or len(dek_sources) != 1
        ):
            return unknown(*(value for value in (algorithm, key) if value is not None))
        operation = self.record_operation("wrap", crypto.mode)
        return Value(
            "wrap-result",
            WrapInfo(operation.identifier, crypto, next(iter(dek_sources))),
        )

    def unwrap_key(
        self,
        crypto: CryptoClientInfo,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        algorithm = self.argument(
            positional,
            named,
            0,
            "algorithm",
            "alg",
            "key_wrap_algorithm",
        )
        key = self.argument(positional, named, 1, "key", "encrypted_key", "data")
        if (
            not self.rsa_oaep(algorithm)
            or key is None
            or key.kind != "wrapped"
            or not key.exact
        ):
            return unknown(*(value for value in (algorithm, key) if value is not None))
        operation = self.record_operation("unwrap", crypto.mode)
        references: dict[int, UnwrapInfo] = {}
        tags = value_tags(key)
        for record_id, reference in key.records.items():
            if not isinstance(reference, PropertyRef) or reference.field != "wrapped_dek":
                continue
            record = self.records.get(record_id)
            if (
                record is None
                or crypto.key_sources != record.key_sources
                or not guards_compatible(record.guards, operation.guards)
            ):
                continue
            info = UnwrapInfo(
                operation.identifier,
                crypto,
                record_id,
                reference.operation,
                record.wrapped.dek,
            )
            references[record_id] = info
            tags.update(
                {
                    ("record", record_id),
                    ("unwrapped-dek", record_id),
                    ("fresh-dek", info.dek),
                }
            )
        return Value(
            "unwrap-result",
            tags=tags,
            records=references,
            exact=key.exact,
        )

    def decrypt(self, key: Value, nonce: Value, ciphertext: Value) -> Value:
        operation = self.record_operation("decrypt")
        references: dict[int, Any] = {}
        tags = value_tags(key) | value_tags(nonce) | value_tags(ciphertext)
        if (
            not key.exact
            or nonce.kind != "nonce"
            or not nonce.exact
            or ciphertext.kind != "ciphertext"
            or not ciphertext.exact
        ):
            return Value("plaintext", tags=tags)
        for record_id in set(key.records) & set(nonce.records) & set(ciphertext.records):
            unwrap = key.records[record_id]
            nonce_ref = nonce.records[record_id]
            download = ciphertext.records[record_id]
            record = self.records.get(record_id)
            if (
                not isinstance(unwrap, UnwrapInfo)
                or not isinstance(nonce_ref, PropertyRef)
                or not isinstance(download, DownloadRef)
                or record is None
                or nonce_ref.field != "nonce"
                or unwrap.dek != record.cipher.dek
                or record.cipher.nonce != record.nonce
                or record.operation >= nonce_ref.operation
                or record.operation >= download.operation
                or unwrap.operation <= unwrap.property_operation
                or operation.identifier <= max(unwrap.operation, download.operation)
                or not guards_compatible(
                    record.guards,
                    operation.guards,
                )
            ):
                continue
            roundtrip_guards = frozenset(
                {
                    *record.guards,
                    *operation.guards,
                    *self.operations[unwrap.property_operation].guards,
                    *self.operations[download.operation].guards,
                    *self.operations[unwrap.operation].guards,
                }
            )
            if not guards_compatible(roundtrip_guards):
                continue
            self.roundtrips.append(
                RoundTrip(
                    record,
                    unwrap.property_operation,
                    nonce_ref.blob,
                    download.operation,
                    download.blob,
                    unwrap,
                    operation.identifier,
                    roundtrip_guards,
                )
            )
            tags.update(
                {
                    ("record", record_id),
                    ("plaintext", record_id),
                }
            )
            references[record_id] = record.cipher.plaintext
        return Value("plaintext", tags=tags, records=references)

    def record_operation(self, kind: str, mode: str | None = None) -> Operation:
        identifier = self.next_identifier()
        operation = Operation(
            identifier,
            kind,
            identifier,
            self.mode if mode is None else mode,
            frozenset(self.guards),
            tuple(self.try_stack),
        )
        self.operations[identifier] = operation
        return operation

    def record_output(self, values: list[Value]) -> None:
        operation = self.record_operation("output")
        tags = set().union(*(value_tags(value) for value in values))
        for value in values:
            tags.update(self.presentation_tags(value))
        self.outputs.append(
            Output(
                operation.identifier,
                self.mode,
                frozenset(tags),
                operation.guards,
            )
        )

    @staticmethod
    def presentation_tags(value: Value) -> set[Tag]:
        if value.kind in {"environment", "key-id"}:
            return {
                ("shown-key-id", marker)
                for marker in tags_named(value, "key-id-value")
            }
        if value.kind == "base64-wrapped":
            return {
                ("shown-wrapped", marker)
                for marker in tags_named(value, "wrapped-b64")
            }
        if value.kind == "plaintext":
            return {
                ("shown-plaintext", marker)
                for marker in record_ids(value)
            }
        return set()

    def next_identifier(self) -> int:
        self.counter += 1
        return self.counter

    def operation_handles_sdk_errors(self, operation: int) -> bool:
        info = self.operations.get(operation)
        if info is None:
            return False
        return any(
            try_info.meaningful
            and (
                REQUIRED_SDK_ERRORS <= try_info.catches
                or "azure.core.exceptions.AzureError" in try_info.catches
            )
            for identifier in info.try_stack
            if (try_info := self.try_infos.get(identifier)) is not None
        )

    def roundtrip_is_configured(self, roundtrip: RoundTrip) -> bool:
        record = roundtrip.record
        blob = record.blob
        wrap = record.wrapped.crypto
        unwrap = roundtrip.unwrap.crypto
        storage_environment = tags_named(blob.service.account_url, "storage-endpoint")
        blob_clients = (
            record.blob,
            roundtrip.property_blob,
            roundtrip.download_blob,
        )
        return bool(
            bool(storage_environment)
            and record.mode == blob.mode == wrap.mode == unwrap.mode
            and record.mode in {"sync", "async"}
            and blob.service.credential.identifier == wrap.credential.identifier
            and blob.service.credential.identifier == unwrap.credential.identifier
            and all(
                client.mode == record.mode
                and client.service.credential.identifier
                == blob.service.credential.identifier
                for client in blob_clients
            )
            and blob.service.credential.mode == record.mode
            and wrap.credential.mode == record.mode
            and unwrap.credential.mode == record.mode
            and bool(record.key_sources)
            and all(
                (
                    key_client := self.key_clients.get(identifier)
                ) is not None
                and key_client.mode == record.mode
                and key_client.credential.identifier
                == blob.service.credential.identifier
                for crypto in (wrap, unwrap)
                for identifier in crypto.key_clients
            )
        )

    def roundtrip_has_errors(self, roundtrip: RoundTrip) -> bool:
        return all(
            self.operation_handles_sdk_errors(operation)
            for operation in (
                roundtrip.record.wrapped.operation,
                roundtrip.record.operation,
                roundtrip.property_operation,
                roundtrip.download_operation,
                roundtrip.unwrap.operation,
            )
        )

    def output_candidates(self, roundtrip: RoundTrip, tag: str) -> list[Output]:
        candidates: list[Output] = []
        for output in self.outputs:
            tags = output.tags
            if (
                output.operation <= roundtrip.decrypt_operation
                or ("record", roundtrip.record.identifier) not in tags
                or not guards_compatible(roundtrip.guards, output.guards)
            ):
                continue
            if tag == "key-id-value":
                matches = bool(
                    {
                        marker
                        for name, marker in tags
                        if name == "shown-key-id"
                    }
                    & roundtrip.record.key_sources
                )
            elif tag == "wrapped-b64":
                matches = (
                    "shown-wrapped",
                    roundtrip.record.wrapped.operation,
                ) in tags
            else:
                matches = (
                    "shown-plaintext",
                    roundtrip.record.identifier,
                ) in tags
            if matches:
                candidates.append(output)
        return candidates

    def roundtrip_has_output(self, roundtrip: RoundTrip) -> bool:
        key_ids = self.output_candidates(roundtrip, "key-id-value")
        wrapped_deks = self.output_candidates(roundtrip, "wrapped-b64")
        plaintexts = self.output_candidates(roundtrip, "plaintext")
        return any(
            guards_compatible(
                roundtrip.guards,
                key_id.guards,
                wrapped_dek.guards,
                plaintext.guards,
            )
            for key_id in key_ids
            for wrapped_dek in wrapped_deks
            for plaintext in plaintexts
        )


class Analyzer:
    """Checks executable SDK data flow instead of independent matching snippets."""

    def __init__(self, documents: list[Document], manifests: list[dict[str, str]]) -> None:
        self.documents = documents
        self.manifests = manifests

    def analyze(self) -> dict[str, bool]:
        packages = declared_packages(self.manifests)
        package_rule = REQUIRED_PACKAGES <= packages
        if not self.documents or self.has_shadowed_azure_module():
            return self.results(package_rule)
        entries = [
            document.path
            for document in self.documents
            if any(statement_is_main_guard(statement) for statement in document.tree.body)
        ]
        if not entries:
            entries = self.unconditional_entry_candidates()
        outcomes = []
        for entry in entries:
            execution = Execution(self.documents, entry)
            execution.execute()
            outcomes.append(execution)
        for execution in outcomes:
            if execution.forbidden or execution.raw_dek_persisted:
                continue
            pair = self.workflow_pair(execution)
            if pair is None:
                continue
            sync_roundtrip, async_roundtrip = pair
            errors = execution.roundtrip_has_errors(
                sync_roundtrip
            ) and execution.roundtrip_has_errors(async_roundtrip)
            demo = execution.roundtrip_has_output(
                sync_roundtrip
            ) and execution.roundtrip_has_output(async_roundtrip)
            return {
                "prompt/sdk-packages": package_rule,
                "prompt/key-vault-envelope-operations": True,
                "prompt/local-aes-gcm-encryption": True,
                "prompt/encrypted-blob-metadata-round-trip": True,
                "prompt/credential-and-client-configuration": True,
                "prompt/sync-and-async-implementations": True,
                "prompt/sdk-error-handling": errors,
                "prompt/ordered-demo-workflow": demo,
            }
        return self.results(package_rule)

    @staticmethod
    def results(package_rule: bool) -> dict[str, bool]:
        return {
            "prompt/sdk-packages": package_rule,
            "prompt/key-vault-envelope-operations": False,
            "prompt/local-aes-gcm-encryption": False,
            "prompt/encrypted-blob-metadata-round-trip": False,
            "prompt/credential-and-client-configuration": False,
            "prompt/sync-and-async-implementations": False,
            "prompt/sdk-error-handling": False,
            "prompt/ordered-demo-workflow": False,
        }

    def has_shadowed_azure_module(self) -> bool:
        return any(
            document.path.replace("\\", "/").split("/", 1)[0] == "azure"
            or document.path.replace("\\", "/") == "azure.py"
            for document in self.documents
        )

    def unconditional_entry_candidates(self) -> list[str]:
        imported: set[str] = set()
        paths = {document.path for document in self.documents}
        names = {
            document.path.removesuffix(".py").replace("/", "."): document.path
            for document in self.documents
        }
        for document in self.documents:
            for node in ast.walk(document.tree):
                if isinstance(node, ast.Import):
                    imported.update(
                        names[alias.name]
                        for alias in node.names
                        if alias.name in names
                    )
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    if node.module in names:
                        imported.add(names[node.module])
        candidates = [
            document.path
            for document in self.documents
            if document.path not in imported
            and any(
                isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call)
                for statement in document.tree.body
            )
        ]
        return candidates or sorted(paths)

    @staticmethod
    def workflow_pair(execution: Execution) -> tuple[RoundTrip, RoundTrip] | None:
        sync = [
            roundtrip
            for roundtrip in execution.roundtrips
            if roundtrip.record.mode == "sync"
            and execution.roundtrip_is_configured(roundtrip)
        ]
        asynchronous = [
            roundtrip
            for roundtrip in execution.roundtrips
            if roundtrip.record.mode == "async"
            and execution.roundtrip_is_configured(roundtrip)
        ]
        for sync_roundtrip in sync:
            for async_roundtrip in asynchronous:
                if (
                    sync_roundtrip.decrypt_operation < async_roundtrip.record.operation
                    and guards_compatible(
                        sync_roundtrip.guards,
                        async_roundtrip.guards,
                    )
                ):
                    return sync_roundtrip, async_roundtrip
        return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        manifests = payload["dependencyManifests"]
        documents = []
        for item in payload["documents"]:
            if not isinstance(item.get("path"), str) or not isinstance(
                item.get("source"),
                str,
            ):
                raise ValueError("documents must have path and source strings")
            tree = ast.parse(item["source"], filename=item["path"])
            compile(tree, item["path"], "exec")
            documents.append(
                Document(
                    item["path"].replace("\\", "/"),
                    item["source"],
                    tree,
                )
            )
        if not isinstance(manifests, list):
            raise ValueError("dependencyManifests must be a list")
        print(json.dumps(Analyzer(documents, manifests).analyze()))
    except SyntaxError:
        package_rule = (
            isinstance(locals().get("manifests"), list)
            and REQUIRED_PACKAGES <= declared_packages(manifests)
        )
        print(json.dumps(Analyzer.results(package_rule)))
        return 0
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"Invalid analyzer input: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
