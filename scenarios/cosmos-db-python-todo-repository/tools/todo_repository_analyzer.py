from __future__ import annotations

import ast
import json
import re
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any


RULES = [
    "prompt/sdk-pins",
    "prompt/todo-model",
    "prompt/secure-container-factory",
    "prompt/sync-crud-request-charges",
    "prompt/async-crud-request-charges",
    "prompt/etag-conflict-handling",
    "prompt/sync-parameterized-pagination",
    "prompt/async-parameterized-pagination",
    "prompt/connected-sync-then-async-demo",
]
POINT_OPERATIONS = {"create_item", "read_item", "replace_item", "delete_item"}
EXPECTED_FIELDS = {
    "id",
    "title",
    "description",
    "completed",
    "created_at",
    "category",
}


@dataclass
class Definition:
    key: str
    module: str
    name: str
    node: ast.FunctionDef | ast.AsyncFunctionDef
    class_name: str | None = None
    calls: list[str] = field(default_factory=list)


@dataclass
class Module:
    name: str
    path: str
    tree: ast.Module
    imports: dict[str, str] = field(default_factory=dict)
    constants: dict[str, Any] = field(default_factory=dict)


def module_name(path: str) -> str:
    pure = PurePosixPath(path.replace("\\", "/"))
    parts = list(pure.parts)
    if parts[-1] == "__init__.py":
        parts.pop()
    else:
        parts[-1] = pure.stem
    return ".".join(parts)


def literal(node: ast.AST | None, constants: dict[str, Any]) -> Any:
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        return constants.get(node.id)
    if isinstance(node, ast.List):
        return [literal(value, constants) for value in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(literal(value, constants) for value in node.elts)
    if isinstance(node, ast.Dict):
        return {
            literal(key, constants): literal(value, constants)
            for key, value in zip(node.keys, node.values, strict=True)
        }
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
        left = literal(node.left, constants)
        right = literal(node.right, constants)
        if isinstance(left, (int, str)) and isinstance(right, int):
            return left * right
        if isinstance(right, (int, str)) and isinstance(left, int):
            return right * left
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = literal(node.left, constants)
        right = literal(node.right, constants)
        if type(left) is type(right) and isinstance(left, (int, str)):
            return left + right
    return None


def active_statements(statements: list[ast.stmt]) -> list[ast.stmt]:
    active: list[ast.stmt] = []
    for statement in statements:
        if isinstance(statement, ast.If):
            condition = literal(statement.test, {})
            if condition is False:
                active.extend(active_statements(statement.orelse))
            elif condition is True:
                active.extend(active_statements(statement.body))
            else:
                active.append(statement.test)
                active.extend(active_statements(statement.body))
                active.extend(active_statements(statement.orelse))
            continue
        active.append(statement)
        if isinstance(statement, (ast.Return, ast.Raise)):
            break
    return active


def nested_nodes(statements: list[ast.stmt]) -> list[ast.AST]:
    result: list[ast.AST] = []

    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            return

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            return

        def visit_If(self, node: ast.If) -> None:
            result.append(node.test)
            condition = literal(node.test, {})
            branches = (
                node.orelse
                if condition is False
                else node.body
                if condition is True
                else [*node.body, *node.orelse]
            )
            for statement in active_statements(branches):
                self.visit(statement)

        def generic_visit(self, node: ast.AST) -> None:
            result.append(node)
            super().generic_visit(node)

    visitor = Visitor()
    for statement in active_statements(statements):
        visitor.visit(statement)
    return result


def call_name(call: ast.Call) -> str:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return ""


def call_receiver(call: ast.Call) -> ast.AST | None:
    return call.func.value if isinstance(call.func, ast.Attribute) else None


def dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def expression_names(node: ast.AST | None) -> set[str]:
    if node is None:
        return set()
    return {item.id for item in ast.walk(node) if isinstance(item, ast.Name)} | {
        item.attr for item in ast.walk(node) if isinstance(item, ast.Attribute)
    }


def keywords(call: ast.Call) -> dict[str, ast.AST]:
    return {
        keyword.arg: keyword.value
        for keyword in call.keywords
        if keyword.arg is not None
    }


def calls_in(definition: Definition | None, module: Module) -> list[ast.Call]:
    statements = definition.node.body if definition else module.tree.body
    return [node for node in nested_nodes(statements) if isinstance(node, ast.Call)]


def exact_pins(manifests: list[dict[str, str]]) -> bool:
    expected = {
        "azure-cosmos": "4.16.0",
        "azure-identity": "1.25.3",
    }
    valid_manifest = False
    seen: dict[str, set[str]] = {name: set() for name in expected}
    for manifest in manifests:
        filename = str(manifest.get("filename", "")).lower()
        content = str(manifest.get("content", ""))
        pins: dict[str, set[str]] = {}
        if filename.endswith(".txt"):
            for raw_line in content.splitlines():
                line = raw_line.split("#", 1)[0].strip()
                match = re.fullmatch(
                    r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)(?:\s*;\s*(.+))?",
                    line,
                )
                if not match or match.group(3):
                    continue
                name = re.sub(r"[-_.]+", "-", match.group(1).lower())
                pins.setdefault(name, set()).add(match.group(2))
        elif filename == "pyproject.toml":
            try:
                document = tomllib.loads(content)
            except tomllib.TOMLDecodeError:
                continue
            dependencies = document.get("project", {}).get("dependencies", [])
            for dependency in dependencies:
                match = re.fullmatch(
                    r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)",
                    str(dependency).strip(),
                )
                if match:
                    name = re.sub(r"[-_.]+", "-", match.group(1).lower())
                    pins.setdefault(name, set()).add(match.group(2))
        for name in expected:
            seen[name].update(pins.get(name, set()))
        if all(pins.get(name) == {version} for name, version in expected.items()):
            valid_manifest = True
    return valid_manifest and all(
        seen[name] == {version} for name, version in expected.items()
    )


class Analyzer:
    def __init__(self, request: dict[str, Any]) -> None:
        self.request = request
        self.modules: dict[str, Module] = {}
        self.definitions: dict[str, Definition] = {}
        self.definitions_by_name: dict[str, list[str]] = {}
        self.classes: dict[str, ast.ClassDef] = {}
        self.class_modules: dict[str, str] = {}
        self.invalid = False
        self._load()
        self._link()
        self.reachable = self._reachable()

    def _load(self) -> None:
        for document in self.request.get("documents", []):
            path = str(document.get("path", "")).replace("\\", "/")
            if path.startswith("azure/") or "/azure/" in path:
                self.invalid = True
            try:
                tree = ast.parse(str(document.get("source", "")), filename=path)
            except SyntaxError:
                self.invalid = True
                continue
            name = module_name(path)
            module = Module(name, path, tree)
            for node in tree.body:
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        module.imports[alias.asname or alias.name.split(".")[0]] = (
                            alias.name
                        )
                elif isinstance(node, ast.ImportFrom) and node.module:
                    for alias in node.names:
                        module.imports[alias.asname or alias.name] = (
                            f"{node.module}.{alias.name}"
                        )
                elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                    targets = (
                        node.targets if isinstance(node, ast.Assign) else [node.target]
                    )
                    value = literal(node.value, module.constants)
                    for target in targets:
                        if isinstance(target, ast.Name) and value is not None:
                            module.constants[target.id] = value
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self._add_definition(module, node)
                elif isinstance(node, ast.ClassDef):
                    self.classes[node.name] = node
                    self.class_modules[node.name] = name
                    for child in node.body:
                        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            self._add_definition(module, child, node.name)
            self.modules[name] = module

        sdk_names = {
            "CosmosClient",
            "CosmosContainer",
            "PartitionKey",
            "DefaultAzureCredential",
        }
        if sdk_names.intersection(self.classes):
            self.invalid = True

    def _add_definition(
        self,
        module: Module,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
        class_name: str | None = None,
    ) -> None:
        key = f"{module.name}:{class_name + '.' if class_name else ''}{node.name}"
        definition = Definition(key, module.name, node.name, node, class_name)
        self.definitions[key] = definition
        self.definitions_by_name.setdefault(node.name, []).append(key)

    def _class_bindings(self, definition: Definition) -> dict[str, str]:
        bindings: dict[str, str] = {}
        if definition.class_name:
            bindings["self"] = definition.class_name
        for node in nested_nodes(definition.node.body):
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            value = node.value
            if not isinstance(value, ast.Call):
                continue
            constructor = call_name(value)
            if constructor not in self.classes:
                continue
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    bindings[target.id] = constructor
        return bindings

    def _targets(self, definition: Definition, call: ast.Call) -> list[str]:
        name = call_name(call)
        if isinstance(call.func, ast.Name):
            if name in self.classes:
                key = next(
                    (
                        value
                        for value in self.definitions_by_name.get("__init__", [])
                        if self.definitions[value].class_name == name
                    ),
                    None,
                )
                return [key] if key else []
            return self.definitions_by_name.get(name, [])
        receiver = call_receiver(call)
        if isinstance(receiver, ast.Name):
            class_name = self._class_bindings(definition).get(receiver.id)
            if class_name:
                return [
                    key
                    for key in self.definitions_by_name.get(name, [])
                    if self.definitions[key].class_name == class_name
                ]
            if receiver.id == "self" and definition.class_name:
                return [
                    key
                    for key in self.definitions_by_name.get(name, [])
                    if self.definitions[key].class_name == definition.class_name
                ]
        return []

    def _link(self) -> None:
        for definition in self.definitions.values():
            module = self.modules[definition.module]
            for call in calls_in(definition, module):
                definition.calls.extend(self._targets(definition, call))

    def _entry_points(self) -> list[str]:
        roots = {
            str(path).replace("\\", "/")
            for path in self.request.get("applicationRoots", [])
        }
        entries: list[str] = []
        for definition in self.definitions.values():
            if (
                definition.class_name is None
                and definition.name == "main"
                and self.modules[definition.module].path in roots
            ):
                entries.append(definition.key)
        return entries

    def _reachable(self) -> set[str]:
        pending = self._entry_points()
        reachable: set[str] = set()
        while pending:
            key = pending.pop()
            if key in reachable:
                continue
            reachable.add(key)
            pending.extend(self.definitions[key].calls)
        return reachable

    def closure(self, key: str) -> set[str]:
        result: set[str] = set()
        pending = [key]
        while pending:
            current = pending.pop()
            if current in result:
                continue
            result.add(current)
            pending.extend(self.definitions[current].calls)
        return result

    def closure_calls(self, key: str) -> list[tuple[Definition, ast.Call]]:
        result: list[tuple[Definition, ast.Call]] = []
        for current in self.closure(key):
            definition = self.definitions[current]
            module = self.modules[definition.module]
            result.extend((definition, call) for call in calls_in(definition, module))
        return result

    def canonical_call(self, definition: Definition, call: ast.Call) -> str:
        name = dotted_name(call.func)
        first, _, rest = name.partition(".")
        imported = self.modules[definition.module].imports.get(first)
        return f"{imported}.{rest}" if imported and rest else imported or name

    def reachable_definitions(self) -> list[Definition]:
        return [self.definitions[key] for key in self.reachable]

    def model(self) -> bool:
        for class_name, node in self.classes.items():
            if class_name in {
                "CosmosClient",
                "CosmosContainer",
                "PartitionKey",
                "DefaultAzureCredential",
            }:
                continue
            names = (
                {item.id for item in ast.walk(node) if isinstance(item, ast.Name)}
                | {
                    item.attr
                    for item in ast.walk(node)
                    if isinstance(item, ast.Attribute)
                }
                | {item.arg for item in ast.walk(node) if isinstance(item, ast.arg)}
            )
            if EXPECTED_FIELDS.issubset(names):
                return True
        for definition in self.reachable_definitions():
            for node in ast.walk(definition.node):
                if isinstance(node, ast.Dict):
                    keys = {
                        literal(key, self.modules[definition.module].constants)
                        for key in node.keys
                    }
                    if EXPECTED_FIELDS.issubset(keys):
                        return True
        return False

    def factory_kind(self, asynchronous: bool) -> bool:
        client_name = (
            "azure.cosmos.aio.CosmosClient"
            if asynchronous
            else "azure.cosmos.CosmosClient"
        )
        credential_names = {
            "azure.identity.DefaultAzureCredential",
            "azure.identity.aio.DefaultAzureCredential",
        }
        for definition in self.reachable_definitions():
            if isinstance(definition.node, ast.AsyncFunctionDef) != asynchronous:
                continue
            if definition.name == "main" or "demo" in definition.name.lower():
                continue
            calls = self.closure_calls(definition.key)
            canonical = [
                (owner, call, self.canonical_call(owner, call)) for owner, call in calls
            ]
            if not any(name == client_name for _, _, name in canonical):
                continue
            if not any(name in credential_names for _, _, name in canonical):
                continue
            names = [call_name(call) for _, call, _ in canonical]
            if not {
                "create_database_if_not_exists",
                "create_container_if_not_exists",
            }.issubset(names):
                continue
            closure_nodes = [
                node
                for key in self.closure(definition.key)
                for node in nested_nodes(self.definitions[key].node.body)
            ]
            environment = any(
                (
                    isinstance(node, ast.Subscript)
                    and dotted_name(node.value) in {"os.environ", "environ"}
                    and literal(
                        node.slice,
                        self.modules[definition.module].constants,
                    )
                    == "AZURE_COSMOS_ENDPOINT"
                )
                or (
                    isinstance(node, ast.Call)
                    and call_name(node) == "getenv"
                    and any(
                        literal(
                            argument,
                            self.modules[definition.module].constants,
                        )
                        == "AZURE_COSMOS_ENDPOINT"
                        for argument in node.args
                    )
                )
                for node in closure_nodes
            )
            container_calls = [
                (owner, call)
                for owner, call, _ in canonical
                if call_name(call) == "create_container_if_not_exists"
            ]
            configured = False
            for owner, call in container_calls:
                values = keywords(call)
                constants = self.modules[owner.module].constants
                partition = literal(values.get("partition_key"), constants)
                if partition is None and values.get("partition_key"):
                    partition = ast.unparse(values["partition_key"])
                ttl = literal(values.get("default_ttl"), constants)
                policy = literal(values.get("indexing_policy"), constants)
                policy_text = json.dumps(policy) if policy is not None else ""
                configured = (
                    "/category" in str(partition)
                    and ttl == 7_776_000
                    and "/description" in policy_text
                )
                if configured:
                    break
            if environment and configured:
                return True
        return False

    def operation_rule(self, asynchronous: bool) -> bool:
        found: dict[str, bool] = {name: False for name in POINT_OPERATIONS}
        for definition in self.reachable_definitions():
            if isinstance(definition.node, ast.AsyncFunctionDef) != asynchronous:
                continue
            module = self.modules[definition.module]
            for call in calls_in(definition, module):
                name = call_name(call)
                if name not in POINT_OPERATIONS:
                    continue
                values = keywords(call)
                found[name] |= (
                    "partition_key" in values
                    and "response_hook" in values
                    and (
                        not asynchronous
                        or any(
                            isinstance(node, ast.Await) and node.value is call
                            for node in ast.walk(definition.node)
                        )
                    )
                )
        return all(found.values()) and self.has_charge_logger()

    def has_charge_logger(self) -> bool:
        for definition in self.reachable_definitions():
            nodes = list(ast.walk(definition.node))
            header_read = any(
                isinstance(node, ast.Call)
                and call_name(node) in {"get", "__getitem__"}
                and any(
                    literal(argument, self.modules[definition.module].constants)
                    == "x-ms-request-charge"
                    for argument in node.args
                )
                for node in nodes
            )
            output = any(
                isinstance(node, ast.Call)
                and call_name(node) in {"print", "info", "debug"}
                for node in nodes
            )
            if header_read and output:
                return True
        return False

    def conflict(self) -> bool:
        kinds = set()
        for definition in self.reachable_definitions():
            module = self.modules[definition.module]
            replace_calls = [
                call
                for call in calls_in(definition, module)
                if call_name(call) == "replace_item"
            ]
            if not replace_calls:
                continue
            valid_replace = False
            for call in replace_calls:
                values = keywords(call)
                etag = values.get("if_match") or values.get("etag")
                match = values.get("match_condition")
                valid_replace |= (
                    etag is not None
                    and bool(expression_names(etag) & {"etag", "_etag", "item"})
                    and (
                        "if_match" in values
                        or (match is not None and "IfNotModified" in ast.unparse(match))
                    )
                )
            closure_nodes = [
                node
                for key in self.closure(definition.key)
                for node in nested_nodes(self.definitions[key].node.body)
            ]
            status_412 = any(
                isinstance(node, ast.Constant) and node.value == 412
                for node in closure_nodes
            )
            conflict_raise = any(
                isinstance(node, ast.Raise)
                and node.exc is not None
                and "Conflict" in ast.unparse(node.exc)
                for node in closure_nodes
            )
            if valid_replace and status_412 and conflict_raise:
                kinds.add(isinstance(definition.node, ast.AsyncFunctionDef))
        return kinds == {False, True}

    def pagination(self, asynchronous: bool) -> bool:
        for definition in self.reachable_definitions():
            if isinstance(definition.node, ast.AsyncFunctionDef) != asynchronous:
                continue
            nodes = nested_nodes(definition.node.body)
            assignments: dict[str, ast.AST] = {}
            for node in nodes:
                if isinstance(node, (ast.Assign, ast.AnnAssign)):
                    targets = (
                        node.targets if isinstance(node, ast.Assign) else [node.target]
                    )
                    for target in targets:
                        if isinstance(target, ast.Name):
                            assignments[target.id] = node.value
            query_calls = [
                node
                for node in nodes
                if isinstance(node, ast.Call) and call_name(node) == "query_items"
            ]
            for query_call in query_calls:
                values = keywords(query_call)
                query_node = values.get("query") or (
                    query_call.args[0] if query_call.args else None
                )
                parameters = values.get("parameters")
                page_size = values.get("max_item_count")
                query_text = literal(
                    query_node,
                    self.modules[definition.module].constants
                    | {
                        name: literal(value, self.modules[definition.module].constants)
                        for name, value in assignments.items()
                    },
                )
                if isinstance(parameters, ast.Name) and parameters.id in assignments:
                    parameters = assignments[parameters.id]
                parameter_text = ast.unparse(parameters) if parameters else ""
                if (
                    not isinstance(query_text, str)
                    or not re.search(
                        r"WHERE\s+\w+\.category\s*=\s*@category",
                        query_text,
                        re.IGNORECASE,
                    )
                    or "@category" not in parameter_text
                    or "category" not in parameter_text
                    or page_size is None
                    or "response_hook" not in values
                ):
                    continue
                query_vars = {
                    name for name, value in assignments.items() if value is query_call
                }
                pager_vars = set()
                for name, value in assignments.items():
                    if not isinstance(value, ast.Call) or call_name(value) != "by_page":
                        continue
                    receiver = call_receiver(value)
                    if (
                        isinstance(receiver, ast.Name) and receiver.id in query_vars
                    ) or (isinstance(receiver, ast.Call) and receiver is query_call):
                        pager_vars.add(name)
                for loop in (
                    node for node in nodes if isinstance(node, (ast.For, ast.AsyncFor))
                ):
                    if asynchronous != isinstance(loop, ast.AsyncFor):
                        continue
                    if (
                        not isinstance(loop.iter, ast.Name)
                        or loop.iter.id not in pager_vars
                    ):
                        continue
                    page_name = (
                        loop.target.id if isinstance(loop.target, ast.Name) else ""
                    )
                    body_text = "\n".join(
                        ast.unparse(statement) for statement in loop.body
                    )
                    if (
                        page_name
                        and ("len(" in body_text or ".size" in body_text)
                        and "continuation_token" in body_text
                        and re.search(
                            r"\b(?:print|LOGGER\.(?:info|debug))\s*\(", body_text
                        )
                    ):
                        flatten = any(
                            isinstance(node, ast.Call)
                            and call_name(node) == "list"
                            and node.args
                            and isinstance(node.args[0], ast.Name)
                            and node.args[0].id in query_vars
                            for node in nodes
                        )
                        if not flatten:
                            return True
        return False

    def ordered_trace(self) -> list[str]:
        entries = self._entry_points()
        trace: list[str] = []

        def visit(key: str, stack: set[str]) -> None:
            if key in stack:
                return
            definition = self.definitions[key]
            module = self.modules[definition.module]
            asynchronous = isinstance(definition.node, ast.AsyncFunctionDef)
            for call in calls_in(definition, module):
                name = call_name(call)
                if name in POINT_OPERATIONS | {"query_items"}:
                    trace.append(f"{'async' if asynchronous else 'sync'}:{name}")
                for target in self._targets(definition, call):
                    visit(target, stack | {key})

        for entry in entries:
            visit(entry, set())
        return trace

    def connected_demo(self) -> bool:
        expected = [
            "sync:create_item",
            "sync:read_item",
            "sync:query_items",
            "sync:replace_item",
            "sync:delete_item",
            "async:create_item",
            "async:read_item",
            "async:query_items",
            "async:replace_item",
            "async:delete_item",
        ]
        trace = self.ordered_trace()
        position = 0
        for event in trace:
            if position < len(expected) and event == expected[position]:
                position += 1
        return position == len(expected)

    def results(self) -> dict[str, bool]:
        if self.invalid or not self._entry_points():
            return {name: False for name in RULES}
        return {
            "prompt/sdk-pins": exact_pins(
                self.request.get("dependencyManifests", []),
            ),
            "prompt/todo-model": self.model(),
            "prompt/secure-container-factory": (
                self.factory_kind(False) and self.factory_kind(True)
            ),
            "prompt/sync-crud-request-charges": self.operation_rule(False),
            "prompt/async-crud-request-charges": self.operation_rule(True),
            "prompt/etag-conflict-handling": self.conflict(),
            "prompt/sync-parameterized-pagination": self.pagination(False),
            "prompt/async-parameterized-pagination": self.pagination(True),
            "prompt/connected-sync-then-async-demo": self.connected_demo(),
        }


def main() -> None:
    request = json.load(sys.stdin)
    print(json.dumps(Analyzer(request).results(), sort_keys=True))


if __name__ == "__main__":
    main()
