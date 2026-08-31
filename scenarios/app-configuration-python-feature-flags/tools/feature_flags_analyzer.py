from __future__ import annotations

import ast
import copy
import json
import os
import platform
import re
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any


RULES = [
    "prompt/sdk-pins",
    "prompt/secure-sync-async-clients",
    "prompt/configuration-reads",
    "prompt/etag-conditional-cache",
    "prompt/feature-flag-evaluation",
    "prompt/deterministic-percentage-rollout",
    "prompt/sentinel-refresh",
    "prompt/connected-sync-then-async-demo",
]


@dataclass
class Value:
    kind: str = "unknown"
    data: Any = None
    attrs: dict[str, Value] = field(default_factory=dict)
    deps: set[str] = field(default_factory=set)


@dataclass
class Function:
    key: str
    module: str
    node: ast.FunctionDef | ast.AsyncFunctionDef
    class_key: str | None = None


@dataclass
class Class:
    key: str
    module: str
    node: ast.ClassDef
    methods: dict[str, Function]


@dataclass
class Module:
    name: str
    path: str
    tree: ast.Module
    env: dict[str, Value] = field(default_factory=dict)


@dataclass
class Context:
    env: dict[str, Value]
    flow: list[str] = field(default_factory=list)
    returned: bool = False
    return_value: Value = field(default_factory=Value)
    control_deps: set[str] = field(default_factory=set)

    def branch(self, deps: set[str] | None = None) -> Context:
        return Context(
            copy.deepcopy(self.env),
            list(self.flow),
            control_deps=self.control_deps | (deps or set()),
        )


def module_name(path: str) -> str:
    pure = PurePosixPath(path.replace("\\", "/"))
    parts = list(pure.parts)
    if parts[-1] == "__init__.py":
        parts.pop()
    else:
        parts[-1] = pure.stem
    return ".".join(parts)


def literal(node: ast.AST | None, env: dict[str, Value]) -> Any:
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        value = env.get(node.id, Value())
        return value.data if value.kind == "literal" else None
    if isinstance(node, ast.JoinedStr):
        pieces = []
        for item in node.values:
            if isinstance(item, ast.Constant):
                pieces.append(str(item.value))
            elif isinstance(item, ast.FormattedValue):
                value = literal(item.value, env)
                if value is None:
                    return None
                pieces.append(str(value))
            else:
                return None
        return "".join(pieces)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = literal(node.left, env)
        right = literal(node.right, env)
        if isinstance(left, str) and isinstance(right, str):
            return left + right
    try:
        return ast.literal_eval(node)
    except (TypeError, ValueError):
        return None


def constant_truth(node: ast.AST, env: dict[str, Value]) -> bool | None:
    if isinstance(node, ast.Constant):
        return bool(node.value)
    if (
        isinstance(node, ast.Compare)
        and len(node.ops) == 1
        and len(node.comparators) == 1
    ):
        left = literal(node.left, env)
        right = literal(node.comparators[0], env)
        if left is None or right is None:
            return None
        operator = node.ops[0]
        if isinstance(operator, ast.Eq):
            return left == right
        if isinstance(operator, ast.NotEq):
            return left != right
    return None


def marker_value(node: ast.AST) -> tuple[str, bool] | None:
    environment = {
        "implementation_name": sys.implementation.name,
        "os_name": os.name,
        "platform_machine": platform.machine(),
        "platform_python_implementation": platform.python_implementation(),
        "platform_release": platform.release(),
        "platform_system": platform.system(),
        "platform_version": platform.version(),
        "python_full_version": platform.python_version(),
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}",
        "sys_platform": sys.platform,
    }
    if isinstance(node, ast.Name) and node.id in environment:
        return environment[node.id], node.id in {
            "python_full_version",
            "python_version",
        }
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value, False
    return None


def version_parts(value: str) -> tuple[int, ...] | None:
    if not re.fullmatch(r"\d+(?:\.\d+)*", value):
        return None
    return tuple(int(part) for part in value.split("."))


def marker_comparison(
    left: tuple[str, bool],
    operator: ast.cmpop,
    right: tuple[str, bool],
) -> bool | None:
    left_value, left_is_version = left
    right_value, right_is_version = right
    if left_is_version or right_is_version:
        left_version = version_parts(left_value)
        right_version = version_parts(right_value)
        if left_version is None or right_version is None:
            return None
        width = max(len(left_version), len(right_version))
        left_value = left_version + (0,) * (width - len(left_version))
        right_value = right_version + (0,) * (width - len(right_version))
    if isinstance(operator, ast.Eq):
        return left_value == right_value
    if isinstance(operator, ast.NotEq):
        return left_value != right_value
    if isinstance(operator, ast.In):
        return left_value in right_value
    if isinstance(operator, ast.NotIn):
        return left_value not in right_value
    if isinstance(left_value, tuple) and isinstance(right_value, tuple):
        if isinstance(operator, ast.Lt):
            return left_value < right_value
        if isinstance(operator, ast.LtE):
            return left_value <= right_value
        if isinstance(operator, ast.Gt):
            return left_value > right_value
        if isinstance(operator, ast.GtE):
            return left_value >= right_value
    return None


def marker_is_active(marker: str) -> bool | None:
    try:
        expression = ast.parse(marker, mode="eval").body
    except SyntaxError:
        return None

    def evaluate(node: ast.AST) -> bool | None:
        if isinstance(node, ast.BoolOp):
            values = [evaluate(value) for value in node.values]
            if isinstance(node.op, ast.And):
                if False in values:
                    return False
                return True if all(value is True for value in values) else None
            if True in values:
                return True
            return False if all(value is False for value in values) else None
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            value = evaluate(node.operand)
            return None if value is None else not value
        if isinstance(node, ast.Compare):
            operands = [node.left, *node.comparators]
            decisions = []
            for index, operator in enumerate(node.ops):
                left = marker_value(operands[index])
                right = marker_value(operands[index + 1])
                if left is None or right is None:
                    return None
                decision = marker_comparison(left, operator, right)
                if decision is None:
                    return None
                decisions.append(decision)
            return all(decisions)
        return None

    return evaluate(expression)


def active_requirements(content: str) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for raw_line in content.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        match = re.fullmatch(
            r"([A-Za-z0-9_.-]+)\s*==\s*([A-Za-z0-9_.+-]+)"
            r"(?:\s*;\s*(.+))?",
            line,
        )
        if not match:
            continue
        marker = match.group(3)
        if marker is not None and marker_is_active(marker) is not True:
            continue
        name = re.sub(r"[-_.]+", "-", match.group(1).lower())
        result.setdefault(name, set()).add(match.group(2))
    return result


def manifest_pins(manifests: list[dict[str, str]]) -> list[dict[str, set[str]]]:
    pin_sets = []
    for manifest in manifests:
        filename = manifest.get("filename", "")
        content = manifest.get("content", "")
        pins: dict[str, set[str]] = {}
        if filename.lower().endswith(".txt"):
            pins = active_requirements(content)
            pin_sets.append(pins)
            continue
        if filename.lower() != "pyproject.toml":
            continue
        try:
            document = tomllib.loads(content)
        except tomllib.TOMLDecodeError:
            continue
        dependencies = document.get("project", {}).get("dependencies", [])
        for dependency in dependencies:
            for name, versions in active_requirements(str(dependency)).items():
                pins.setdefault(name, set()).update(versions)
        poetry = document.get("tool", {}).get("poetry", {}).get("dependencies", {})
        for name, version in poetry.items():
            if isinstance(version, str) and re.fullmatch(r"\d+(?:\.\d+)+", version):
                normalized = re.sub(r"[-_.]+", "-", name.lower())
                pins.setdefault(normalized, set()).add(version)
        pin_sets.append(pins)
    return pin_sets


class Analyzer:
    def __init__(self, request: dict[str, Any]) -> None:
        self.documents = request.get("documents", [])
        self.application_roots = {
            str(path).replace("\\", "/")
            for path in request.get("applicationRoots", [])
        }
        self.modules: dict[str, Module] = {}
        self.functions: dict[str, Function] = {}
        self.classes: dict[str, Class] = {}
        self.reachable: set[str] = set()
        self.active_calls: set[str] = set()
        self.calls: list[dict[str, Any]] = []
        self.function_calls: list[dict[str, Any]] = []
        self.payload_accesses: list[dict[str, Any]] = []
        self.sleep_calls: list[dict[str, Any]] = []
        self.cache_writes: list[dict[str, Any]] = []
        self.cache_clears: list[dict[str, Any]] = []
        self.return_events: list[dict[str, Any]] = []
        self.if_events: list[dict[str, Any]] = []
        self.loop_events: list[dict[str, Any]] = []
        self.modulo_events: list[dict[str, Any]] = []
        self.comparison_events: list[dict[str, Any]] = []
        self.function_returns: dict[str, list[Value]] = {}
        self.scopes: list[tuple[Function | None, ast.AST, str, dict[str, Value]]] = []
        self.valid = True
        self.final_flows: list[list[str]] = []
        self._event_sequence = 0
        self.manifest_pins = manifest_pins(
            request.get("dependencyManifests", [])
        )
        self._load()

    def _load(self) -> None:
        for document in self.documents:
            path = str(document.get("path", "")).replace("\\", "/")
            source = str(document.get("source", ""))
            try:
                tree = ast.parse(source, filename=path)
            except SyntaxError:
                self.valid = False
                continue
            name = module_name(path)
            module = Module(name, path, tree)
            self.modules[name] = module
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    function = Function(f"{name}.{node.name}", name, node)
                    self.functions[function.key] = function
                elif isinstance(node, ast.ClassDef):
                    methods = {}
                    class_key = f"{name}.{node.name}"
                    for child in node.body:
                        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            function = Function(
                                f"{class_key}.{child.name}",
                                name,
                                child,
                                class_key,
                            )
                            methods[child.name] = function
                            self.functions[function.key] = function
                    self.classes[class_key] = Class(class_key, name, node, methods)
        self.local_azure_shadow = any(
            name == "azure" or name.startswith("azure.")
            for name in self.modules
        )
        for module in self.modules.values():
            module.env = self._module_environment(module)

    def _module_environment(self, module: Module) -> dict[str, Value]:
        env: dict[str, Value] = {}
        for node in module.tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                env[node.name] = Value("function", f"{module.name}.{node.name}")
            elif isinstance(node, ast.ClassDef):
                env[node.name] = Value("class", f"{module.name}.{node.name}")
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    local_name = alias.asname or alias.name.split(".")[0]
                    env[local_name] = Value("module", alias.name)
            elif isinstance(node, ast.ImportFrom):
                imported_module = node.module or ""
                for alias in node.names:
                    local_name = alias.asname or alias.name
                    env[local_name] = self._imported_value(imported_module, alias.name)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                value_node = node.value
                value = literal(value_node, env)
                if value is not None:
                    for target in (
                        node.targets if isinstance(node, ast.Assign) else [node.target]
                    ):
                        if isinstance(target, ast.Name):
                            env[target.id] = Value("literal", value)
        return env

    def _imported_value(self, module: str, name: str) -> Value:
        exact = {
            ("azure.appconfiguration", "AzureAppConfigurationClient"): "sync_ctor",
            ("azure.appconfiguration.aio", "AzureAppConfigurationClient"): "async_ctor",
            ("azure.identity", "DefaultAzureCredential"): "sync_cred_ctor",
            ("azure.identity.aio", "DefaultAzureCredential"): "async_cred_ctor",
            ("azure.core", "MatchConditions"): "match_conditions",
            ("azure.core.exceptions", "HttpResponseError"): "http_error",
            (
                "azure.core.exceptions",
                "ResourceNotModifiedError",
            ): "http_not_modified",
        }
        if (module, name) in exact:
            if self.local_azure_shadow:
                return Value("local_import", f"{module}.{name}")
            return Value(exact[(module, name)], f"{module}.{name}")
        local_key = f"{module}.{name}" if module else name
        if local_key in self.functions:
            return Value("function", local_key)
        if local_key in self.classes:
            return Value("class", local_key)
        if module in self.modules:
            return self.modules[module].env.get(name, Value())
        return Value("imported", local_key)

    def _resolve_attribute(self, node: ast.Attribute, env: dict[str, Value]) -> Value:
        base = self._eval_value(node.value, env)
        return self._attribute_value(base, node.attr)

    def _attribute_value(self, base: Value, attribute: str) -> Value:
        if base.kind == "module":
            exact = self._imported_value(str(base.data), attribute)
            if exact.kind != "unknown":
                return exact
            key = f"{base.data}.{attribute}"
            if key in self.functions:
                return Value("function", key)
            if key in self.classes:
                return Value("class", key)
        if base.kind == "instance":
            if attribute in base.attrs:
                return base.attrs[attribute]
            class_info = self.classes.get(str(base.data))
            if class_info and attribute in class_info.methods:
                return Value(
                    "bound_method",
                    (class_info.methods[attribute].key, base),
                )
        if base.kind == "thread" and attribute == "start":
            return Value("thread_start", base)
        if base.kind == "event" and attribute == "wait":
            return Value("event_wait", base)
        if (
            base.kind in {"setting", "cached_setting", "union"}
            and attribute == "etag"
            and base.deps
        ):
            return Value("etag", "setting-etag", deps=set(base.deps))
        if (
            base.kind in {"setting", "cached_setting", "union"}
            and attribute == "value"
            and base.deps
        ):
            return Value("setting_value", base.data, deps=set(base.deps))
        if base.kind in {"sync_client", "async_client", "service"}:
            return Value("sdk_method", (base, attribute))
        if base.kind == "match_conditions" and attribute == "IfModified":
            return Value("if_modified", "IfModified")
        if base.kind == "module":
            return Value("module_attribute", (base.data, attribute))
        if base.deps:
            return Value(
                "derived",
                attribute,
                deps=set(base.deps),
            )
        return Value()

    @staticmethod
    def _field_dependencies(base: Value, key: Any) -> set[str]:
        dependencies = set(base.deps)
        if isinstance(key, str):
            for dependency in base.deps:
                if dependency.startswith("sdk:"):
                    dependencies.add(f"field:{key}:{dependency}")
        return dependencies

    @staticmethod
    def _expression_dependencies(node: ast.AST, env: dict[str, Value]) -> set[str]:
        dependencies: set[str] = set()
        for child in ast.walk(node):
            if isinstance(child, ast.Name):
                dependencies.update(env.get(child.id, Value()).deps)
        return dependencies

    def _eval_value(self, node: ast.AST | None, env: dict[str, Value]) -> Value:
        if node is None:
            return Value()
        value = literal(node, env)
        if value is not None:
            return Value(
                "literal",
                value,
                deps=self._expression_dependencies(node, env),
            )
        if isinstance(node, ast.Name):
            return env.get(node.id, Value())
        if isinstance(node, ast.Attribute):
            return self._resolve_attribute(node, env)
        if isinstance(node, ast.Subscript):
            base = self._eval_value(node.value, env)
            if (
                isinstance(node.value, ast.Attribute)
                and node.value.attr == "environ"
                and self._eval_value(node.value.value, env).kind == "module"
                and self._eval_value(node.value.value, env).data == "os"
            ):
                return Value(
                    "endpoint",
                    literal(node.slice, env),
                    deps=self._expression_dependencies(node, env),
                )
            if base.kind in {"payload", "payload_item"}:
                key = literal(node.slice, env)
                dependencies = self._field_dependencies(base, key)
                return Value("payload_item", key, deps=dependencies)
        if isinstance(node, ast.Await):
            return self._eval_value(node.value, env)
        return Value()

    def _call_arguments(
        self,
        node: ast.Call,
        context: Context,
        scope: str,
    ) -> tuple[list[Value], dict[str, Value]]:
        positional = [
            self._eval_expression(arg, context, scope) for arg in node.args
        ]
        named: dict[str, Value] = {}
        for keyword in node.keywords:
            value = self._eval_expression(keyword.value, context, scope)
            if keyword.arg:
                named[keyword.arg] = value
            elif value.kind == "dict":
                named.update(
                    {
                        name: copy.deepcopy(item)
                        for name, item in value.attrs.items()
                    }
                )
        return positional, named

    def _bind(
        self,
        function: Function,
        positional: list[Value],
        named: dict[str, Value],
        self_value: Value | None = None,
    ) -> dict[str, Value]:
        env = copy.deepcopy(self.modules[function.module].env)
        parameters = list(function.node.args.args)
        parameter_names = {
            parameter.arg
            for parameter in [
                *function.node.args.posonlyargs,
                *function.node.args.args,
                *function.node.args.kwonlyargs,
            ]
        }
        for local_name in self._function_local_names(function.node.body):
            if local_name not in parameter_names:
                env[local_name] = Value("unbound_local", local_name)
        values = list(positional)
        if self_value is not None and parameters:
            env[parameters.pop(0).arg] = self_value
        defaults_start = len(parameters) - len(function.node.args.defaults)
        for index, parameter in enumerate(parameters):
            if index < len(values):
                value = copy.deepcopy(values[index])
            elif parameter.arg in named:
                value = copy.deepcopy(named[parameter.arg])
            elif index >= defaults_start:
                default = function.node.args.defaults[index - defaults_start]
                value = self._eval_value(default, env)
            else:
                value = Value()
            value.deps.add(f"param:{function.key}:{parameter.arg}")
            env[parameter.arg] = value
        return env

    def _function_local_names(self, statements: list[ast.stmt]) -> set[str]:
        names: set[str] = set()

        def targets(node: ast.AST) -> set[str]:
            if isinstance(node, ast.Name):
                return {node.id}
            if isinstance(node, (ast.Tuple, ast.List)):
                return set().union(*(targets(child) for child in node.elts))
            return set()

        def visit(statement: ast.stmt) -> None:
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names.add(statement.name)
                return
            if isinstance(statement, ast.Assign):
                for target in statement.targets:
                    names.update(targets(target))
            elif isinstance(statement, (ast.AnnAssign, ast.AugAssign)):
                names.update(targets(statement.target))
            elif isinstance(statement, (ast.For, ast.AsyncFor)):
                names.update(targets(statement.target))
            elif isinstance(statement, (ast.With, ast.AsyncWith)):
                for item in statement.items:
                    if item.optional_vars:
                        names.update(targets(item.optional_vars))
            elif isinstance(statement, ast.Import):
                names.update(
                    alias.asname or alias.name.split(".")[0]
                    for alias in statement.names
                )
            elif isinstance(statement, ast.ImportFrom):
                names.update(alias.asname or alias.name for alias in statement.names)
            elif isinstance(statement, ast.Try):
                names.update(
                    handler.name
                    for handler in statement.handlers
                    if handler.name
                )
            for child in ast.iter_child_nodes(statement):
                if isinstance(child, ast.stmt):
                    visit(child)

        for statement in statements:
            visit(statement)
        return names

    def _assign(self, target: ast.AST, value: Value, env: dict[str, Value]) -> None:
        if isinstance(target, ast.Name):
            env[target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            items = (
                value.data
                if value.kind == "sequence" and isinstance(value.data, list)
                else []
            )
            for index, element in enumerate(target.elts):
                self._assign(
                    element,
                    copy.deepcopy(items[index])
                    if index < len(items)
                    else Value(deps=set(value.deps)),
                    env,
                )
        elif isinstance(target, ast.Subscript):
            base = self._eval_value(target.value, env)
            if base.kind in {"dict", "cache"}:
                base.deps.update(value.deps)
                key = literal(target.slice, env)
                if isinstance(key, str):
                    base.attrs[key] = copy.deepcopy(value)
        elif isinstance(target, ast.Attribute):
            base = self._eval_value(target.value, env)
            if base.kind == "instance":
                assigned = value
                existing = base.attrs.get(target.attr)
                if (
                    value.kind == "dict"
                    or (
                        value.kind == "literal"
                        and isinstance(value.data, dict)
                    )
                ) or (existing is not None and existing.kind == "cache"):
                    assigned = Value(
                        "cache",
                        target.attr,
                        deps=set(value.deps),
                    )
                base.attrs[target.attr] = assigned

    def _is_cache_target(self, target: ast.AST, env: dict[str, Value]) -> bool:
        if isinstance(target, ast.Attribute):
            base = self._eval_value(target.value, env)
            existing = (
                base.attrs.get(target.attr)
                if base.kind == "instance"
                else None
            )
            return existing is not None and existing.kind == "cache"
        if isinstance(target, ast.Subscript):
            return self._eval_value(target.value, env).kind == "cache"
        return False

    def _record_cache_assignment(
        self,
        target: ast.AST,
        value_node: ast.AST,
        value: Value,
        env: dict[str, Value],
        scope: str,
        statement: ast.stmt,
    ) -> None:
        initializes_cache = (
            isinstance(target, ast.Attribute)
            and (
                value.kind == "dict"
                or (
                    value.kind == "literal"
                    and isinstance(value.data, dict)
                )
            )
        )
        if not initializes_cache and not self._is_cache_target(target, env):
            return
        self._event_sequence += 1
        self.cache_writes.append(
            {
                "scope": scope,
                "node": statement,
                "target": target,
                "value": value_node,
                "deps": set(value.deps),
                "replace": isinstance(target, ast.Attribute),
                "order": self._event_sequence,
            }
        )

    def _record_sdk_call(
        self,
        node: ast.Call,
        base: Value,
        method: str,
        env: dict[str, Value],
        scope: str,
        context: Context,
    ) -> Value:
        positional, named = self._call_arguments(node, context, scope)
        mode = "sync" if base.kind == "sync_client" else "async"
        self._event_sequence += 1
        call_id = f"sdk:{self._event_sequence}"
        call = {
            "id": call_id,
            "kind": "sdk",
            "method": method,
            "mode": mode,
            "positional": positional,
            "named": named,
            "node": node,
            "scope": scope,
            "env": copy.deepcopy(env),
        }
        self.calls.append(call)
        if method == "get_configuration_setting":
            context.flow.append(f"{mode}_read")
            return Value("setting", mode, deps={call_id})
        if method == "list_configuration_settings":
            context.flow.append(f"{mode}_list")
            return Value("settings", mode, deps={call_id})
        return Value()

    def _eval_call(
        self,
        node: ast.Call,
        context: Context,
        scope: str,
    ) -> Value:
        env = context.env
        callee = self._eval_value(node.func, env)
        positional, named = self._call_arguments(node, context, scope)
        if callee.kind == "unknown" and isinstance(node.func, ast.Attribute):
            base = self._eval_expression(node.func.value, context, scope)
            if base.kind == "instance":
                class_info = self.classes.get(str(base.data))
                if class_info and node.func.attr in class_info.methods:
                    callee = Value(
                        "bound_method",
                        (class_info.methods[node.func.attr].key, base),
                    )
            elif base.kind in {"sync_client", "async_client", "service"}:
                callee = Value("sdk_method", (base, node.func.attr))
        if callee.kind in {"sync_cred_ctor", "async_cred_ctor"}:
            mode = "sync" if callee.kind.startswith("sync") else "async"
            self.calls.append({"kind": "credential", "mode": mode, "scope": scope})
            return Value(f"{mode}_credential")
        if callee.kind in {"sync_ctor", "async_ctor"}:
            mode = "sync" if callee.kind.startswith("sync") else "async"
            endpoint = named.get("base_url") or named.get("endpoint")
            credential = named.get("credential")
            if endpoint is None and positional:
                endpoint = positional[0]
            if credential is None and len(positional) > 1:
                credential = positional[1]
            self.calls.append(
                {
                    "kind": "client",
                    "mode": mode,
                    "endpoint": endpoint or Value(),
                    "credential": credential or Value(),
                    "scope": scope,
                }
            )
            context.flow.append(f"{mode}_client")
            return Value(f"{mode}_client")
        if callee.kind == "class":
            instance = Value("instance", callee.data)
            class_info = self.classes[str(callee.data)]
            initializer = class_info.methods.get("__init__")
            if initializer:
                self._execute_function(
                    initializer,
                    positional,
                    named,
                    context,
                    instance,
                )
            fields = [
                child
                for child in class_info.node.body
                if isinstance(child, ast.AnnAssign)
                and isinstance(child.target, ast.Name)
            ]
            for index, field_node in enumerate(fields):
                field_name = field_node.target.id
                if index < len(positional):
                    field_value = copy.deepcopy(positional[index])
                elif field_name in named:
                    field_value = copy.deepcopy(named[field_name])
                elif field_node.value is not None:
                    field_value = self._eval_expression(
                        field_node.value,
                        context,
                        scope,
                    )
                else:
                    field_value = Value()
                instance.attrs[field_name] = field_value
                instance.deps.update(field_value.deps)
            if any(value.kind.endswith("_client") for value in positional + list(named.values())):
                modes = {
                    value.kind.removesuffix("_client")
                    for value in positional + list(named.values())
                    if value.kind.endswith("_client")
                }
                instance.attrs["__modes__"] = Value("modes", modes)
            if any(value.kind == "instance" for value in positional + list(named.values())):
                for value in positional + list(named.values()):
                    modes = value.attrs.get("__modes__")
                    if modes:
                        instance.attrs["__modes__"] = copy.deepcopy(modes)
            return instance
        if callee.kind == "thread_start":
            thread = callee.data
            target = thread.attrs.get("target")
            if target is not None and target.kind == "bound_method":
                function_key, instance = target.data
                return self._execute_function(
                    self.functions[function_key],
                    [],
                    {},
                    context,
                    instance,
                )
            if target is not None and target.kind == "function":
                return self._execute_function(
                    self.functions[str(target.data)],
                    [],
                    {},
                    context,
                )
            return Value()
        if callee.kind == "event_wait":
            dependencies = set().union(*(value.deps for value in positional), set())
            self.sleep_calls.append(
                {
                    "scope": scope,
                    "node": node,
                    "deps": dependencies,
                    "async": False,
                }
            )
            return Value()
        if callee.kind == "function":
            function_key = str(callee.data)
            self.function_calls.append(
                {
                    "caller": scope,
                    "callee": function_key,
                    "node": node,
                }
            )
            return self._execute_function(
                self.functions[function_key],
                positional,
                named,
                context,
            )
        if callee.kind == "bound_method":
            function_key, instance = callee.data
            function = self.functions[function_key]
            self.function_calls.append(
                {
                    "caller": scope,
                    "callee": function_key,
                    "node": node,
                }
            )
            return self._execute_function(
                function,
                positional,
                named,
                context,
                instance,
            )
        if callee.kind == "sdk_method":
            base, method = callee.data
            if base.kind in {"sync_client", "async_client"}:
                return self._record_sdk_call(
                    node,
                    base,
                    method,
                    env,
                    scope,
                    context,
                )
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
        ):
            base = self._eval_expression(node.func.value, context, scope)
            if base.kind == "cache":
                return Value(
                    "cached_setting",
                    deps={*base.deps, f"cache:{scope}"},
                )
            if base.kind in {"payload", "payload_item"}:
                key = literal(node.args[0], env) if node.args else None
                dependencies = self._field_dependencies(base, key)
                self.payload_accesses.append(
                    {
                        "key": key,
                        "scope": scope,
                        "deps": dependencies,
                        "node": node,
                    }
                )
                return Value("payload_item", key, deps=dependencies)
        if isinstance(node.func, ast.Attribute):
            base = self._eval_expression(node.func.value, context, scope)
            if base.kind in {"hash", "hash_bytes"} and node.func.attr in {
                "digest",
                "hexdigest",
            }:
                return Value("hash_bytes", base.data, deps=set(base.deps))
            if node.func.attr == "encode":
                return Value("bytes", deps=set(base.deps))
            if base.kind == "cache" and node.func.attr == "clear":
                self._event_sequence += 1
                self.cache_clears.append(
                    {
                        "scope": scope,
                        "node": node,
                        "cache": base.data,
                        "order": self._event_sequence,
                    }
                )
                return Value()
            if base.kind == "cache" and node.func.attr == "update":
                dependencies = set().union(*(value.deps for value in positional))
                self._event_sequence += 1
                self.cache_writes.append(
                    {
                        "scope": scope,
                        "node": node,
                        "target": node.func.value,
                        "value": node.args[0] if node.args else None,
                        "deps": dependencies,
                        "replace": False,
                        "order": self._event_sequence,
                    }
                )
                return Value()
            if base.kind == "dict" and node.func.attr == "update":
                for value in positional:
                    if value.kind == "dict":
                        base.attrs.update(
                            {
                                name: copy.deepcopy(item)
                                for name, item in value.attrs.items()
                            }
                        )
                base.attrs.update(
                    {
                        name: copy.deepcopy(value)
                        for name, value in named.items()
                    }
                )
                base.deps.update(
                    set().union(
                        *(value.deps for value in [*positional, *named.values()]),
                        set(),
                    )
                )
                return Value()
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in {"getenv", "get"}
            and (
                (
                    isinstance(node.func.value, ast.Name)
                    and env.get(node.func.value.id, Value()).data == "os"
                )
                or (
                    isinstance(node.func.value, ast.Attribute)
                    and node.func.value.attr == "environ"
                    and self._eval_value(
                        node.func.value.value,
                        env,
                    ).data
                    == "os"
                )
            )
        ):
            return Value(
                "endpoint",
                literal(node.args[0], env) if node.args else None,
                deps=set().union(*(value.deps for value in positional)),
            )
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "loads"
            and self._eval_value(node.func.value, env).data == "json"
            and positional
            and positional[0].kind in {"setting_value", "union"}
            and any(
                dependency.startswith(("sdk:", "cache:"))
                for dependency in positional[0].deps
            )
        ):
            modes = {
                call["mode"]
                for call in self.calls
                if call.get("kind") == "sdk"
                and call.get("id") in positional[0].deps
            }
            for mode in modes:
                context.flow.append(f"{mode}_feature")
            self.calls.append(
                {
                    "kind": "json_loads",
                    "scope": scope,
                    "modes": modes,
                    "deps": set(positional[0].deps),
                    "node": node,
                }
            )
            return Value(
                "payload",
                modes,
                deps=set(positional[0].deps),
            )
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in {"sha1", "sha224", "sha256", "sha384", "sha512", "blake2b", "blake2s"}
            and self._eval_value(node.func.value, env).data == "hashlib"
        ):
            self._event_sequence += 1
            hash_id = f"hash:{self._event_sequence}"
            input_dependencies = set().union(
                *(value.deps for value in positional + list(named.values()))
            )
            self.calls.append(
                {
                    "id": hash_id,
                    "kind": "stable_hash",
                    "scope": scope,
                    "node": node,
                    "input_deps": input_dependencies,
                    "algorithm": node.func.attr,
                }
            )
            return Value(
                "hash",
                node.func.attr,
                deps={*input_dependencies, hash_id},
            )
        if isinstance(node.func, ast.Name) and node.func.id == "hash":
            dependencies = set().union(*(value.deps for value in positional))
            return Value("number", deps={*dependencies, "unstable_hash"})
        if callee.kind == "imported" and (
            str(callee.data).startswith("random.")
            or str(callee.data).startswith("secrets.")
        ):
            dependencies = set().union(*(value.deps for value in positional))
            return Value("number", deps={*dependencies, "random"})
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "from_bytes"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "int"
        ):
            dependencies = set().union(*(value.deps for value in positional))
            return Value("number", deps=dependencies)
        if isinstance(node.func, ast.Name) and node.func.id in {
            "bool",
            "dict",
            "float",
            "int",
            "list",
            "round",
            "set",
            "tuple",
        }:
            dependencies = set().union(*(value.deps for value in positional))
            kind = (
                "dict"
                if node.func.id == "dict"
                else "collection"
                if node.func.id in {"list", "set", "tuple"}
                else "number"
            )
            return Value(kind, deps=dependencies)
        if callee.kind == "imported" and str(callee.data).endswith(".Thread"):
            target = named.get("target", Value())
            return Value(
                "thread",
                attrs={"target": copy.deepcopy(target)},
                deps=set(target.deps),
            )
        if callee.kind == "imported" and str(callee.data).endswith(".Event"):
            return Value("event")
        if callee.kind == "imported" and callee.data in {
            "time.sleep",
            "asyncio.sleep",
        }:
            dependencies = set().union(*(value.deps for value in positional))
            self.sleep_calls.append(
                {
                    "scope": scope,
                    "node": node,
                    "deps": dependencies,
                    "async": callee.data == "asyncio.sleep",
                }
            )
            return Value()
        if isinstance(node.func, ast.Attribute) and node.func.attr == "run" and node.args:
            return positional[0]
        return Value()

    def _eval_expression(
        self,
        node: ast.AST,
        context: Context,
        scope: str,
    ) -> Value:
        if isinstance(node, ast.Await):
            return self._eval_expression(node.value, context, scope)
        if isinstance(node, ast.Call):
            return self._eval_call(node, context, scope)
        if isinstance(node, ast.JoinedStr):
            dependencies: set[str] = set()
            pieces: list[str] = []
            dynamic = False
            for item in node.values:
                if isinstance(item, ast.Constant):
                    pieces.append(str(item.value))
                elif isinstance(item, ast.FormattedValue):
                    value = self._eval_expression(item.value, context, scope)
                    dependencies.update(value.deps)
                    if value.data is None:
                        dynamic = True
                    else:
                        pieces.append(str(value.data))
            data = "".join(pieces)
            if data.startswith(".appconfig.featureflag/"):
                return Value("feature_key", data, deps=dependencies)
            return Value(
                "unknown" if dynamic else "literal",
                None if dynamic else data,
                deps=dependencies,
            )
        if isinstance(node, ast.Attribute):
            base = self._eval_expression(node.value, context, scope)
            return self._attribute_value(base, node.attr)
        if isinstance(node, ast.Subscript):
            base = self._eval_expression(node.value, context, scope)
            if (
                isinstance(node.value, ast.Attribute)
                and node.value.attr == "environ"
                and self._eval_value(node.value.value, context.env).data == "os"
            ):
                return Value(
                    "endpoint",
                    literal(node.slice, context.env),
                    deps=set(base.deps),
                )
            if base.kind in {"payload", "payload_item"}:
                key = literal(node.slice, context.env)
                dependencies = self._field_dependencies(base, key)
                self.payload_accesses.append(
                    {
                        "key": key,
                        "scope": scope,
                        "deps": dependencies,
                        "node": node,
                    }
                )
                return Value("payload_item", key, deps=dependencies)
            return Value(deps=set(base.deps))
        if isinstance(node, ast.UnaryOp):
            value = self._eval_expression(node.operand, context, scope)
            return Value("boolean", deps=set(value.deps))
        if isinstance(node, ast.BoolOp):
            values = [
                self._eval_expression(value, context, scope)
                for value in node.values
            ]
            return Value(
                "boolean",
                deps=set().union(*(value.deps for value in values)),
            )
        if isinstance(node, ast.Compare):
            values = [
                self._eval_expression(value, context, scope)
                for value in [node.left, *node.comparators]
            ]
            result = Value(
                "boolean",
                deps=set().union(*(value.deps for value in values)),
            )
            self.comparison_events.append(
                {
                    "scope": scope,
                    "node": node,
                    "deps": set(result.deps),
                }
            )
            return result
        if isinstance(node, ast.BinOp):
            left = self._eval_expression(node.left, context, scope)
            right = self._eval_expression(node.right, context, scope)
            computed = literal(node, context.env)
            result = Value(
                "literal" if computed is not None else "number",
                computed,
                deps={*left.deps, *right.deps},
            )
            if isinstance(node.op, ast.Mod):
                self.modulo_events.append(
                    {
                        "scope": scope,
                        "node": node,
                        "deps": set(result.deps),
                        "modulus": literal(node.right, context.env),
                    }
                )
            return result
        if isinstance(node, ast.IfExp):
            test = self._eval_expression(node.test, context, scope)
            body = self._eval_expression(node.body, context, scope)
            alternate = self._eval_expression(node.orelse, context, scope)
            if body.kind in {"payload", "payload_item"} or alternate.kind in {
                "payload",
                "payload_item",
            }:
                return Value(
                    "payload_item",
                    deps={*test.deps, *body.deps, *alternate.deps},
                )
            return Value(
                "union",
                deps={*test.deps, *body.deps, *alternate.deps},
            )
        if isinstance(node, ast.Dict):
            attrs: dict[str, Value] = {}
            dependencies: set[str] = set()
            for key_node, value_node in zip(node.keys, node.values):
                item = self._eval_expression(value_node, context, scope)
                dependencies.update(item.deps)
                key = literal(key_node, context.env) if key_node is not None else None
                if isinstance(key, str):
                    attrs[key] = item
            return Value("dict", attrs=attrs, deps=dependencies)
        if isinstance(node, ast.DictComp):
            dependencies = self._expression_dependencies(node, context.env)
            for child in ast.walk(node):
                if child is not node and isinstance(child, ast.Call):
                    dependencies.update(
                        self._eval_call(child, context, scope).deps
                    )
            return Value("dict", deps=dependencies)
        if isinstance(node, (ast.List, ast.Tuple)):
            items = [
                self._eval_expression(element, context, scope)
                for element in node.elts
            ]
            return Value(
                "sequence",
                items,
                deps=set().union(*(item.deps for item in items), set()),
            )
        if isinstance(
            node,
            (
                ast.GeneratorExp,
                ast.ListComp,
                ast.Set,
                ast.SetComp,
            ),
        ):
            dependencies = self._expression_dependencies(node, context.env)
            for child in ast.walk(node):
                if child is not node and isinstance(child, ast.Call):
                    dependencies.update(
                        self._eval_call(child, context, scope).deps
                    )
            return Value("collection", deps=dependencies)
        dependencies = self._expression_dependencies(node, context.env)
        for child in ast.walk(node):
            if child is not node and isinstance(child, ast.Call):
                dependencies.update(self._eval_call(child, context, scope).deps)
        value = self._eval_value(node, context.env)
        value.deps.update(dependencies)
        return value

    @staticmethod
    def _condition_has_change(node: ast.AST) -> bool:
        if isinstance(node, ast.Compare) and any(
            isinstance(operator, ast.NotEq) for operator in node.ops
        ):
            return any(
                isinstance(child, ast.Attribute)
                and child.attr in {"etag", "value"}
                for child in ast.walk(node)
            )
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            if isinstance(node.operand, ast.Compare) and any(
                isinstance(operator, ast.Eq)
                for operator in node.operand.ops
            ):
                return any(
                    isinstance(child, ast.Attribute)
                    and child.attr in {"etag", "value"}
                    for child in ast.walk(node.operand)
                )
        return any(
            Analyzer._condition_has_change(child)
            for child in ast.iter_child_nodes(node)
        )

    def _invocation_is_watcher(
        self,
        function: Function,
        calls: list[dict[str, Any]],
        sleeps: list[dict[str, Any]],
        if_events: list[dict[str, Any]],
    ) -> bool:
        closure = self._scope_closure(function.key)
        has_loop = any(
            isinstance(node, (ast.For, ast.AsyncFor, ast.While))
            for key in closure
            for node in ast.walk(self.functions[key].node)
        )
        has_change = any(
            event["scope"] in closure
            and self._condition_has_connected_change(
                event["node"].test,
                event["scope"],
            )
            for event in if_events
        )
        methods = {
            call.get("method")
            for call in calls
            if call.get("kind") == "sdk"
        }
        return (
            has_loop
            and bool(sleeps)
            and has_change
            and "get_configuration_setting" in methods
            and "list_configuration_settings" in methods
        )

    def _execute_function(
        self,
        function: Function,
        positional: list[Value],
        named: dict[str, Value],
        context: Context,
        self_value: Value | None = None,
    ) -> Value:
        signature = ",".join(
            f"{value.kind}:{value.data}" for value in positional + list(named.values())
        )
        active_key = f"{function.key}:{signature}"
        if active_key in self.active_calls:
            return Value()
        self.active_calls.add(active_key)
        self.reachable.add(function.key)
        env = self._bind(function, positional, named, self_value)
        flow_start = len(context.flow)
        call_start = len(self.calls)
        sleep_start = len(self.sleep_calls)
        if_start = len(self.if_events)
        nested = Context(
            env,
            context.flow,
            control_deps=set(context.control_deps),
        )
        self.scopes.append((function, function.node, function.key, copy.deepcopy(env)))
        outcomes = self._execute_block(function.node.body, [nested], function.key)
        segment = (
            max(
                (outcome.flow[flow_start:] for outcome in outcomes),
                key=lambda flow: (len(set(flow)), len(flow)),
            )
            if outcomes
            else context.flow[flow_start:]
        )
        if self._invocation_is_watcher(
            function,
            self.calls[call_start:],
            self.sleep_calls[sleep_start:],
            self.if_events[if_start:],
        ):
            for mode in ("sync", "async"):
                if f"{mode}_read" in segment and f"{mode}_list" in segment:
                    for outcome in outcomes:
                        outcome.flow.append(f"{mode}_watch")
        if self_value is not None and function.node.args.args:
            self_name = function.node.args.args[0].arg
            continuing_instances = [
                outcome.env.get(self_name)
                for outcome in outcomes
                if not outcome.returned
                and outcome.env.get(self_name, Value()).kind == "instance"
            ]
            if continuing_instances:
                common_attributes = set.intersection(
                    *(set(instance.attrs) for instance in continuing_instances)
                )
                merged_attributes = {}
                for attribute in common_attributes:
                    values = [
                        instance.attrs[attribute]
                        for instance in continuing_instances
                    ]
                    first = values[0]
                    if all(
                        value.kind == first.kind and value.data == first.data
                        for value in values[1:]
                    ):
                        merged = copy.deepcopy(first)
                        merged.deps = set().union(
                            *(value.deps for value in values)
                        )
                        merged_attributes[attribute] = merged
                self_value.attrs = merged_attributes
        if outcomes:
            best_outcome = max(
                outcomes,
                key=lambda outcome: (
                    len(set(outcome.flow[flow_start:])),
                    len(outcome.flow[flow_start:]),
                ),
            )
            context.flow[:] = best_outcome.flow
        self.active_calls.remove(active_key)
        returned = [
            outcome.return_value
            for outcome in outcomes
            if outcome.returned
        ]
        concrete_returns = [
            value
            for value in returned
            if value.kind != "unknown" or value.deps
        ]
        if concrete_returns:
            returned = concrete_returns
        if returned:
            self.function_returns.setdefault(function.key, []).extend(
                copy.deepcopy(returned)
            )
            dependencies = set().union(*(value.deps for value in returned))
            first = returned[0]
            if all(
                value.kind == first.kind and value.data == first.data
                for value in returned[1:]
            ):
                merged = copy.deepcopy(first)
                merged.deps = dependencies
                common_attributes = set.intersection(
                    *(set(value.attrs) for value in returned)
                )
                merged.attrs = {}
                for attribute in common_attributes:
                    values = [value.attrs[attribute] for value in returned]
                    first_attribute = values[0]
                    attribute_dependencies = set().union(
                        *(value.deps for value in values)
                    )
                    if all(
                        value.kind == first_attribute.kind
                        and value.data == first_attribute.data
                        for value in values[1:]
                    ):
                        item = copy.deepcopy(first_attribute)
                        item.deps = attribute_dependencies
                    else:
                        item = Value("union", deps=attribute_dependencies)
                    merged.attrs[attribute] = item
                return merged
            return Value("union", deps=dependencies)
        return Value()

    def _execute_block(
        self,
        statements: list[ast.stmt],
        contexts: list[Context],
        scope: str,
    ) -> list[Context]:
        current = contexts
        for statement in statements:
            next_contexts = []
            for context in current:
                if context.returned:
                    next_contexts.append(context)
                    continue
                next_contexts.extend(self._execute_statement(statement, context, scope))
            current = next_contexts
        return current

    def _execute_statement(
        self,
        statement: ast.stmt,
        context: Context,
        scope: str,
    ) -> list[Context]:
        env = context.env
        if isinstance(statement, ast.Assign):
            value = self._eval_expression(statement.value, context, scope)
            for target in statement.targets:
                self._record_cache_assignment(
                    target,
                    statement.value,
                    value,
                    env,
                    scope,
                    statement,
                )
                self._assign(target, value, env)
        elif isinstance(statement, ast.AnnAssign) and statement.value:
            value = self._eval_expression(statement.value, context, scope)
            self._record_cache_assignment(
                statement.target,
                statement.value,
                value,
                env,
                scope,
                statement,
            )
            self._assign(statement.target, value, env)
        elif isinstance(statement, ast.Expr):
            self._eval_expression(statement.value, context, scope)
        elif isinstance(statement, ast.Return):
            value = self._eval_expression(
                statement.value or ast.Constant(None),
                context,
                scope,
            )
            data_dependencies = set(value.deps)
            value.deps.update(context.control_deps)
            context.return_value = value
            self.return_events.append(
                {
                    "scope": scope,
                    "node": statement,
                    "deps": set(value.deps),
                    "data_deps": data_dependencies,
                    "value": value,
                }
            )
            context.returned = True
        elif isinstance(statement, ast.Raise):
            context.returned = True
        elif isinstance(statement, ast.If):
            test_value = self._eval_expression(statement.test, context, scope)
            self.if_events.append(
                {
                    "scope": scope,
                    "node": statement,
                    "deps": set(test_value.deps),
                }
            )
            truth = constant_truth(statement.test, env)
            if truth is True:
                return self._execute_block(statement.body, [context], scope)
            if truth is False:
                return self._execute_block(statement.orelse, [context], scope)
            left = self._execute_block(
                statement.body,
                [context.branch(test_value.deps)],
                scope,
            )
            right = self._execute_block(
                statement.orelse,
                [context.branch(test_value.deps)],
                scope,
            )
            return left + right
        elif isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            if isinstance(statement, ast.While) and constant_truth(statement.test, env) is False:
                return [context]
            loop_context = context.branch()
            loop_dependencies: set[str] = set()
            if isinstance(statement, (ast.For, ast.AsyncFor)):
                iterable = self._eval_expression(
                    statement.iter,
                    loop_context,
                    scope,
                )
                loop_dependencies.update(iterable.deps)
                self._assign(
                    statement.target,
                    Value(
                        "payload_item"
                        if iterable.kind in {"payload", "payload_item"}
                        else "item",
                        deps=set(iterable.deps),
                    ),
                    loop_context.env,
                )
            else:
                loop_dependencies.update(
                    self._eval_expression(
                        statement.test,
                        loop_context,
                        scope,
                    ).deps
                )
            self.loop_events.append(
                {
                    "scope": scope,
                    "node": statement,
                    "deps": loop_dependencies,
                }
            )
            body = self._execute_block(statement.body, [loop_context], scope)
            return body + [context]
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            for item in statement.items:
                value = self._eval_expression(item.context_expr, context, scope)
                if item.optional_vars:
                    self._assign(item.optional_vars, value, env)
            return self._execute_block(statement.body, [context], scope)
        elif isinstance(statement, ast.Try):
            result = self._execute_block(statement.body, [context], scope)
            for handler in statement.handlers:
                result.extend(
                    self._execute_block(handler.body, [context.branch()], scope)
                )
            result = self._execute_block(statement.orelse, result, scope)
            result = self._execute_block(statement.finalbody, result, scope)
            return result
        elif isinstance(statement, ast.Import):
            for alias in statement.names:
                local_name = alias.asname or alias.name.split(".")[0]
                env[local_name] = Value("module", alias.name)
        elif isinstance(statement, ast.ImportFrom):
            imported_module = statement.module or ""
            for alias in statement.names:
                env[alias.asname or alias.name] = self._imported_value(
                    imported_module,
                    alias.name,
                )
        elif isinstance(
            statement,
            (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef),
        ):
            key = f"{scope}.{statement.name}"
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)) and key in self.functions:
                env[statement.name] = Value("function", key)
            elif isinstance(statement, ast.ClassDef) and key in self.classes:
                env[statement.name] = Value("class", key)
            else:
                env[statement.name] = Value("local_shadow", statement.name)
        return [context]

    def run(self) -> None:
        if not self.valid:
            return
        paths = {module.path: module for module in self.modules.values()}
        roots = [
            paths[path]
            for path in self.application_roots
            if path in paths
        ]
        if not roots:
            roots = [
                module
                for module in self.modules.values()
                if "/" not in module.path
            ]
        for module in roots:
            env = copy.deepcopy(module.env)
            env["__name__"] = Value("literal", "__main__")
            context = Context(env)
            self.scopes.append((None, module.tree, module.name, copy.deepcopy(env)))
            outcomes = self._execute_block(module.tree.body, [context], module.name)
            self.final_flows.extend(outcome.flow for outcome in outcomes)

    @staticmethod
    def _value(call: dict[str, Any], name: str, index: int) -> Value:
        return call["named"].get(
            name,
            call["positional"][index] if len(call["positional"]) > index else Value(),
        )

    def _client_rule(self) -> bool:
        clients = [call for call in self.calls if call["kind"] == "client"]
        credentials = {
            call["mode"] for call in self.calls if call["kind"] == "credential"
        }
        return all(
            any(
                call["mode"] == mode
                and call["endpoint"].kind == "endpoint"
                and call["credential"].kind == f"{mode}_credential"
                for call in clients
            )
            and mode in credentials
            for mode in ("sync", "async")
        )

    def _read_rule(self) -> bool:
        calls = [call for call in self.calls if call["kind"] == "sdk"]
        for mode in ("sync", "async"):
            gets = [
                call
                for call in calls
                if call["mode"] == mode
                and call["method"] == "get_configuration_setting"
            ]
            lists = [
                call
                for call in calls
                if call["mode"] == mode
                and call["method"] == "list_configuration_settings"
            ]
            plain = any(
                self._value(call, "key", 0).kind == "literal"
                and self._value(call, "label", 1).kind != "literal"
                for call in gets
            )
            labeled = any(
                self._value(call, "key", 0).kind == "literal"
                and isinstance(self._value(call, "label", 1).data, str)
                for call in gets
            )
            prefix_results = [
                event
                for call in lists
                if isinstance(self._value(call, "key_filter", 0).data, str)
                and self._value(call, "key_filter", 0).data.endswith("*")
                and self._value(call, "key_filter", 0).data != "*"
                for event in self.return_events
                if event["scope"] == call["scope"]
                and call["id"] in event["data_deps"]
            ]
            prefixed = bool(prefix_results) and all(
                event["value"].kind == "dict"
                for event in prefix_results
            )
            if not (plain and labeled and prefixed):
                return False
        return True

    @staticmethod
    def _handler_is_http_error(
        handler: ast.ExceptHandler,
        env: dict[str, Value],
    ) -> bool:
        if handler.type is None:
            return False
        if isinstance(handler.type, ast.Name):
            return env.get(handler.type.id, Value()).kind in {
                "http_error",
                "http_not_modified",
            }
        return False

    @staticmethod
    def _handler_is_not_modified(
        handler: ast.ExceptHandler,
        env: dict[str, Value],
    ) -> bool:
        return (
            isinstance(handler.type, ast.Name)
            and env.get(handler.type.id, Value()).kind == "http_not_modified"
        )

    @staticmethod
    def _node_within(node: ast.AST, ancestor: ast.AST) -> bool:
        return any(child is node for child in ast.walk(ancestor))

    @staticmethod
    def _status_test(
        node: ast.AST,
        exception_name: str | None,
        status: int,
    ) -> bool | None:
        if not (
            isinstance(node, ast.Compare)
            and len(node.ops) == 1
            and len(node.comparators) == 1
        ):
            return None

        def is_status(value: ast.AST) -> bool:
            return (
                isinstance(value, ast.Attribute)
                and value.attr == "status_code"
                and isinstance(value.value, ast.Name)
                and value.value.id == exception_name
            )

        left = node.left
        right = node.comparators[0]
        if is_status(left) and literal(right, {}) == 304:
            pass
        elif is_status(right) and literal(left, {}) == 304:
            pass
        else:
            return None
        if isinstance(node.ops[0], ast.Eq):
            return status == 304
        if isinstance(node.ops[0], ast.NotEq):
            return status != 304
        return None

    def _status_test_connected(
        self,
        node: ast.AST,
        exception_name: str | None,
        status: int,
        scope: str,
        visited: set[str] | None = None,
    ) -> bool | None:
        direct = self._status_test(node, exception_name, status)
        if direct is not None:
            return direct
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            nested = self._status_test_connected(
                node.operand,
                exception_name,
                status,
                scope,
                visited,
            )
            return None if nested is None else not nested
        if not isinstance(node, ast.Call):
            return None
        visited = visited or set()
        for call in self.function_calls:
            if call["caller"] != scope or call["node"] is not node:
                continue
            callee = call["callee"]
            if callee in visited:
                return None
            function = self.functions.get(callee)
            if function is None:
                return None
            parameters = list(function.node.args.args)
            if function.class_key is not None and parameters:
                parameters = parameters[1:]
            helper_exception = None
            for index, argument in enumerate(node.args):
                if (
                    isinstance(argument, ast.Name)
                    and argument.id == exception_name
                    and index < len(parameters)
                ):
                    helper_exception = parameters[index].arg
            for keyword in node.keywords:
                if (
                    keyword.arg
                    and isinstance(keyword.value, ast.Name)
                    and keyword.value.id == exception_name
                ):
                    helper_exception = keyword.arg
            if helper_exception is None:
                return None
            decisions = {
                decision
                for return_node in ast.walk(function.node)
                if isinstance(return_node, ast.Return)
                and return_node.value is not None
                and self._live_return(return_node, callee)
                for decision in [
                    self._status_test_connected(
                        return_node.value,
                        helper_exception,
                        status,
                        callee,
                        {*visited, callee},
                    )
                ]
                if decision is not None
            }
            if len(decisions) == 1:
                return decisions.pop()
        return None

    def _handler_paths(
        self,
        statements: list[ast.stmt],
        exception_name: str | None,
        status: int,
        scope: str,
    ) -> list[tuple[str, ast.AST | None]]:
        if not statements:
            return [("fallthrough", None)]
        statement, remaining = statements[0], statements[1:]
        if isinstance(statement, ast.Return):
            return [("return", statement)]
        if isinstance(statement, ast.Raise):
            return [("raise", statement)]
        if isinstance(statement, ast.If):
            decision = self._status_test_connected(
                statement.test,
                exception_name,
                status,
                scope,
            )
            branches = (
                [statement.body]
                if decision is True
                else [statement.orelse]
                if decision is False
                else [statement.body, statement.orelse]
            )
            outcomes: list[tuple[str, ast.AST | None]] = []
            for branch in branches:
                branch_outcomes = self._handler_paths(
                    branch,
                    exception_name,
                    status,
                    scope,
                )
                for action, node in branch_outcomes:
                    if action == "fallthrough":
                        outcomes.extend(
                            self._handler_paths(
                                remaining,
                                exception_name,
                                status,
                                scope,
                            )
                        )
                    else:
                        outcomes.append((action, node))
            return outcomes
        return self._handler_paths(
            remaining,
            exception_name,
            status,
            scope,
        )

    def _return_is_cached(self, node: ast.AST, scope: str) -> bool:
        return any(
            event["scope"] == scope
            and event["node"] is node
            and event["value"].kind
            in {"cached_setting", "setting", "setting_value", "union"}
            and any(
                dependency.startswith("cache:")
                for dependency in event["deps"]
            )
            for event in self.return_events
        )

    def _conditional_call_is_valid(self, call: dict[str, Any]) -> bool:
        function = self.functions.get(call["scope"])
        if function is None:
            return False
        etag = self._value(call, "etag", 2)
        if not any(
            dependency.startswith("cache:")
            for dependency in etag.deps
        ):
            return False
        containing_tries = [
            node
            for node in ast.walk(function.node)
            if isinstance(node, ast.Try)
            and any(
                self._node_within(call["node"], statement)
                for statement in node.body
            )
        ]
        if not containing_tries:
            return False
        containing_try = min(
            containing_tries,
            key=lambda node: sum(1 for _ in ast.walk(node)),
        )
        handlers = [
            handler
            for handler in containing_try.handlers
            if self._handler_is_http_error(handler, call["env"])
        ]
        if not handlers:
            return False
        valid_handler = False
        for handler in handlers:
            unchanged = self._handler_paths(
                handler.body,
                handler.name,
                304,
                call["scope"],
            )
            failures = self._handler_paths(
                handler.body,
                handler.name,
                500,
                call["scope"],
            )
            specialized = self._handler_is_not_modified(
                handler,
                call["env"],
            )
            if (
                unchanged
                and (
                    (
                        specialized
                        and any(
                            action == "return"
                            and node is not None
                            and self._return_is_cached(
                                node,
                                call["scope"],
                            )
                            for action, node in unchanged
                        )
                        and all(
                            action == "raise"
                            or (
                                action == "return"
                                and node is not None
                                and self._return_is_cached(
                                    node,
                                    call["scope"],
                                )
                            )
                            for action, node in unchanged
                        )
                    )
                    or (
                        not specialized
                        and all(
                            action == "return"
                            and node is not None
                            and self._return_is_cached(
                                node,
                                call["scope"],
                            )
                            for action, node in unchanged
                        )
                    )
                )
                and (
                    specialized
                    or (
                        failures
                        and all(
                            action == "raise"
                            for action, _node in failures
                        )
                    )
                )
            ):
                valid_handler = True
                break
        if not valid_handler:
            return False
        closure = self._scope_closure(call["scope"])
        handler_nodes = [
            handler
            for node in ast.walk(function.node)
            if isinstance(node, ast.Try)
            for handler in node.handlers
        ]
        changed_is_cached = any(
            event["scope"] in closure
            and call["id"] in event["deps"]
            and not any(
                self._node_within(event["node"], handler)
                for handler in handler_nodes
            )
            for event in self.cache_writes
        )
        changed_is_returned = any(
            event["scope"] == call["scope"]
            and call["id"] in event["deps"]
            and event["value"].kind
            in {"setting", "setting_value", "union"}
            and not any(
                self._node_within(event["node"], handler)
                for handler in handler_nodes
            )
            for event in self.return_events
        )
        return changed_is_cached and changed_is_returned

    def _etag_rule(self) -> bool:
        valid_modes = set()
        for call in self.calls:
            if (
                call.get("kind") != "sdk"
                or call.get("method") != "get_configuration_setting"
            ):
                continue
            match = self._value(call, "match_condition", 3)
            etag = self._value(call, "etag", 2)
            if (
                match.kind == "if_modified"
                and etag.kind == "etag"
                and self._conditional_call_is_valid(call)
            ):
                valid_modes.add(call["mode"])
        return valid_modes == {"sync", "async"}

    def _feature_calls(self) -> list[dict[str, Any]]:
        feature_calls = []
        for call in self.calls:
            if (
                call.get("kind") != "sdk"
                or call.get("method") != "get_configuration_setting"
            ):
                continue
            key = self._value(call, "key", 0)
            if (
                key.kind in {"literal", "feature_key"}
                and isinstance(key.data, str)
                and key.data.startswith(".appconfig.featureflag/")
            ):
                feature_calls.append(call)
        return feature_calls

    def _percentage_is_accessed(self, call_id: str) -> bool:
        if any(
            call_id in access["deps"]
            and isinstance(access["key"], str)
            and (
                "percent" in access["key"].lower()
                or access["key"].lower() == "value"
            )
            for access in self.payload_accesses
        ):
            return True
        return any(
            call_id in event["deps"]
            and any(
                isinstance(node, ast.Constant)
                and node.value == "Microsoft.Percentage"
                for node in ast.walk(event["node"].test)
            )
            for event in self.if_events
        )

    def _live_return(self, node: ast.Return, scope: str) -> bool:
        return any(
            event["scope"] == scope and event["node"] is node
            for event in self.return_events
        )

    def _branch_returns_false(
        self,
        statements: list[ast.stmt],
        scope: str,
    ) -> bool:
        return any(
            isinstance(node, ast.Return)
            and self._live_return(node, scope)
            and isinstance(node.value, ast.Constant)
            and node.value.value is False
            for statement in statements
            for node in ast.walk(statement)
        )

    def _branch_returns_value(
        self,
        statements: list[ast.stmt],
        scope: str,
    ) -> bool:
        return any(
            isinstance(node, ast.Return)
            and self._live_return(node, scope)
            for statement in statements
            for node in ast.walk(statement)
        )

    def _statements_after(
        self,
        statements: list[ast.stmt],
        target: ast.stmt,
    ) -> list[ast.stmt]:
        for index, statement in enumerate(statements):
            if statement is target:
                return statements[index + 1 :]
            nested_lists: list[list[ast.stmt]] = []
            if isinstance(statement, ast.If):
                nested_lists.extend([statement.body, statement.orelse])
            elif isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
                nested_lists.extend([statement.body, statement.orelse])
            elif isinstance(statement, (ast.With, ast.AsyncWith)):
                nested_lists.append(statement.body)
            elif isinstance(statement, ast.Try):
                nested_lists.extend(
                    [
                        statement.body,
                        statement.orelse,
                        statement.finalbody,
                        *(handler.body for handler in statement.handlers),
                    ]
                )
            for nested in nested_lists:
                following = self._statements_after(nested, target)
                if following:
                    return following
        return []

    def _boolean_formula(
        self,
        node: ast.AST,
        access_node: ast.AST,
        assigned_names: set[str],
    ) -> tuple[Any, ...]:
        if node is access_node:
            return ("enabled",)
        if isinstance(node, ast.Name) and node.id in assigned_names:
            return ("enabled",)
        if isinstance(node, ast.Constant) and isinstance(node.value, bool):
            return ("constant", node.value)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return (
                "not",
                self._boolean_formula(
                    node.operand,
                    access_node,
                    assigned_names,
                ),
            )
        if isinstance(node, ast.BoolOp):
            operator = "and" if isinstance(node.op, ast.And) else "or"
            return (
                operator,
                *(
                    self._boolean_formula(
                        value,
                        access_node,
                        assigned_names,
                    )
                    for value in node.values
                ),
            )
        if isinstance(node, ast.IfExp):
            return (
                "if",
                self._boolean_formula(
                    node.test,
                    access_node,
                    assigned_names,
                ),
                self._boolean_formula(
                    node.body,
                    access_node,
                    assigned_names,
                ),
                self._boolean_formula(
                    node.orelse,
                    access_node,
                    assigned_names,
                ),
            )
        if (
            isinstance(node, ast.Compare)
            and len(node.ops) == 1
            and len(node.comparators) == 1
            and isinstance(
                node.ops[0],
                (ast.Eq, ast.NotEq, ast.Is, ast.IsNot),
            )
        ):
            formula = (
                "equal",
                self._boolean_formula(
                    node.left,
                    access_node,
                    assigned_names,
                ),
                self._boolean_formula(
                    node.comparators[0],
                    access_node,
                    assigned_names,
                ),
            )
            if isinstance(node.ops[0], (ast.NotEq, ast.IsNot)):
                return ("not", formula)
            return formula
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "bool"
            and len(node.args) == 1
        ):
            return self._boolean_formula(
                node.args[0],
                access_node,
                assigned_names,
            )
        return ("atom", ast.dump(node))

    @staticmethod
    def _formula_atoms(formula: tuple[Any, ...]) -> set[str]:
        if formula[0] == "atom":
            return {str(formula[1])}
        return set().union(
            *(
                Analyzer._formula_atoms(child)
                for child in formula[1:]
                if isinstance(child, tuple)
            ),
            set(),
        )

    @staticmethod
    def _evaluate_formula(
        formula: tuple[Any, ...],
        enabled: bool,
        atoms: dict[str, bool],
    ) -> bool:
        operator = formula[0]
        if operator == "enabled":
            return enabled
        if operator == "constant":
            return bool(formula[1])
        if operator == "atom":
            return atoms[str(formula[1])]
        if operator == "not":
            return not Analyzer._evaluate_formula(
                formula[1],
                enabled,
                atoms,
            )
        if operator == "and":
            return all(
                Analyzer._evaluate_formula(child, enabled, atoms)
                for child in formula[1:]
            )
        if operator == "or":
            return any(
                Analyzer._evaluate_formula(child, enabled, atoms)
                for child in formula[1:]
            )
        if operator == "if":
            branch = formula[2] if Analyzer._evaluate_formula(
                formula[1],
                enabled,
                atoms,
            ) else formula[3]
            return Analyzer._evaluate_formula(branch, enabled, atoms)
        if operator == "equal":
            return Analyzer._evaluate_formula(
                formula[1],
                enabled,
                atoms,
            ) == Analyzer._evaluate_formula(
                formula[2],
                enabled,
                atoms,
            )
        return False

    def _enabled_forces_result(
        self,
        node: ast.AST,
        access_node: ast.AST,
        assigned_names: set[str],
        *,
        enabled: bool,
        expected: bool,
    ) -> bool:
        formula = self._boolean_formula(
            node,
            access_node,
            assigned_names,
        )
        atom_names = sorted(self._formula_atoms(formula))
        if len(atom_names) > 8:
            return False
        return all(
            self._evaluate_formula(
                formula,
                enabled,
                {
                    name: bool(mask & (1 << index))
                    for index, name in enumerate(atom_names)
                },
            )
            is expected
            for mask in range(1 << len(atom_names))
        )

    def _disabled_forces_false(
        self,
        node: ast.AST,
        access_node: ast.AST,
        assigned_names: set[str],
    ) -> bool:
        return self._enabled_forces_result(
            node,
            access_node,
            assigned_names,
            enabled=False,
            expected=False,
        ) and not self._enabled_forces_result(
            node,
            access_node,
            assigned_names,
            enabled=True,
            expected=False,
        )

    def _enabled_affects_result(self, call_id: str) -> bool:
        feature_scope = next(
            (
                call["scope"]
                for call in self._feature_calls()
                if call["id"] == call_id
            ),
            None,
        )
        marker = f"field:enabled:{call_id}"
        connected_returns = [
            event
            for event in self.return_events
            if marker in event["deps"]
        ]
        if (
            any(
                event["value"].kind == "literal"
                and event["value"].data is False
                for event in connected_returns
            )
            and any(
                not (
                    event["value"].kind == "literal"
                    and event["value"].data is False
                )
                for event in connected_returns
            )
        ):
            return True
        if feature_scope is None or not any(
            event["scope"] == feature_scope
            and marker in event["deps"]
            for event in self.return_events
        ):
            return False
        accesses = [
            access
            for access in self.payload_accesses
            if access["key"] == "enabled" and call_id in access["deps"]
        ]
        for access in accesses:
            function = self.functions.get(access["scope"])
            if function is None:
                continue
            assigned_names = {
                target.id
                for node in ast.walk(function.node)
                if isinstance(node, (ast.Assign, ast.AnnAssign))
                and node.value is not None
                and self._node_within(access["node"], node.value)
                for target in (
                    node.targets
                    if isinstance(node, ast.Assign)
                    else [node.target]
                )
                if isinstance(target, ast.Name)
            }

            def uses_enabled(node: ast.AST) -> bool:
                return self._node_within(access["node"], node) or any(
                    isinstance(child, ast.Name)
                    and child.id in assigned_names
                    for child in ast.walk(node)
                )

            for return_node in (
                node
                for node in ast.walk(function.node)
                if isinstance(node, ast.Return)
                and node.value is not None
                and self._live_return(node, function.key)
            ):
                if uses_enabled(return_node.value):
                    if self._disabled_forces_false(
                        return_node.value,
                        access["node"],
                        assigned_names,
                    ):
                        return True
            for if_node in (
                node
                for node in ast.walk(function.node)
                if isinstance(node, ast.If) and uses_enabled(node.test)
            ):
                negative = isinstance(if_node.test, ast.UnaryOp) and isinstance(
                    if_node.test.op,
                    ast.Not,
                )
                if isinstance(if_node.test, ast.Compare):
                    compared_to_false = any(
                        isinstance(value, ast.Constant)
                        and value.value is False
                        for value in [
                            if_node.test.left,
                            *if_node.test.comparators,
                        ]
                    )
                    if compared_to_false and any(
                        isinstance(operator, (ast.Eq, ast.Is))
                        for operator in if_node.test.ops
                    ):
                        negative = True
                disabled_takes_false_branch = self._enabled_forces_result(
                    if_node.test,
                    access["node"],
                    assigned_names,
                    enabled=False,
                    expected=negative,
                )
                enabled_can_continue = not self._enabled_forces_result(
                    if_node.test,
                    access["node"],
                    assigned_names,
                    enabled=True,
                    expected=negative,
                )
                if (
                    negative
                    and disabled_takes_false_branch
                    and enabled_can_continue
                    and self._branch_returns_false(
                        if_node.body,
                        function.key,
                    )
                ):
                    return True
                following = self._statements_after(
                    function.node.body,
                    if_node,
                )
                if (
                    not negative
                    and disabled_takes_false_branch
                    and enabled_can_continue
                    and self._branch_returns_value(
                        if_node.body,
                        function.key,
                    )
                    and (
                        self._branch_returns_false(
                            if_node.orelse,
                            function.key,
                        )
                        or self._branch_returns_false(
                            following,
                            function.key,
                        )
                    )
                ):
                    return True
        return False

    def _feature_rule(self) -> bool:
        valid_modes = set()
        for call in self._feature_calls():
            call_id = call["id"]
            decoded = any(
                json_call.get("kind") == "json_loads"
                and call_id in json_call.get("deps", set())
                for json_call in self.calls
            )
            enabled = any(
                access["key"] == "enabled"
                and call_id in access["deps"]
                for access in self.payload_accesses
            )
            if (
                decoded
                and enabled
                and self._enabled_affects_result(call_id)
                and self._percentage_is_accessed(call_id)
            ):
                valid_modes.add(call["mode"])
        return valid_modes == {"sync", "async"}

    @staticmethod
    def _scope_parameter_dependencies(scope: str, deps: set[str]) -> set[str]:
        prefix = f"param:{scope}:"
        return {
            dependency
            for dependency in deps
            if dependency.startswith(prefix)
        }

    def _rollout_rule(self) -> bool:
        valid_modes = set()
        hashes = [
            call
            for call in self.calls
            if call.get("kind") == "stable_hash"
        ]
        for feature_call in self._feature_calls():
            call_id = feature_call["id"]
            key = self._value(feature_call, "key", 0)
            flag_dependencies = {
                dependency
                for dependency in key.deps
                if dependency.startswith("param:")
            }
            flag_scopes = {
                dependency.rsplit(":", 1)[0]
                for dependency in flag_dependencies
            }
            enabled_marker = f"field:enabled:{call_id}"
            for hash_call in hashes:
                hash_id = hash_call["id"]
                feature_parameters = {
                    dependency
                    for dependency in hash_call["input_deps"]
                    if dependency.startswith("param:")
                }
                hash_flag_dependencies = (
                    feature_parameters & flag_dependencies
                )
                user_dependencies = {
                    dependency
                    for dependency in feature_parameters - flag_dependencies
                    if dependency.rsplit(":", 1)[0] in flag_scopes
                }
                if not hash_flag_dependencies or not user_dependencies:
                    continue
                relevant_returns = [
                    event
                    for event in self.return_events
                    if hash_id in event["deps"]
                    and enabled_marker in event["deps"]
                    and "random" not in event["deps"]
                    and "unstable_hash" not in event["deps"]
                ]
                has_bucket = any(
                    hash_id in event["deps"]
                    and event["modulus"] in {100, 10_000}
                    for event in self.modulo_events
                )
                has_threshold = any(
                    hash_id in event["deps"]
                    and any(
                        isinstance(operator, (ast.Lt, ast.LtE))
                        for operator in event["node"].ops
                    )
                    and (
                        any(
                            isinstance(child, ast.Call)
                            and isinstance(child.func, ast.Name)
                            and child.func.id == "round"
                            and child.args
                            and isinstance(child.args[0], ast.BinOp)
                            and isinstance(child.args[0].op, ast.Mult)
                            and 100
                            in {
                                literal(child.args[0].left, {}),
                                literal(child.args[0].right, {}),
                            }
                            for child in ast.walk(event["node"])
                        )
                        if has_bucket
                        and any(
                            matching["modulus"] == 10_000
                            and hash_id in matching["deps"]
                            for matching in self.modulo_events
                        )
                        else True
                    )
                    for event in self.comparison_events
                )
                if relevant_returns and has_bucket and has_threshold:
                    valid_modes.add(feature_call["mode"])
                    break
        return valid_modes == {"sync", "async"}

    def _scope_closure(self, scope: str) -> set[str]:
        closure = {scope}
        changed = True
        while changed:
            changed = False
            for call in self.function_calls:
                if (
                    call["caller"] in closure
                    and call["callee"] not in closure
                ):
                    closure.add(call["callee"])
                    changed = True
        return closure

    @staticmethod
    def _target_names(node: ast.AST) -> set[str]:
        return {
            child.id
            for child in ast.walk(node)
            if isinstance(child, ast.Name)
        }

    def _complete_cache_repopulation(
        self,
        event: dict[str, Any],
        list_call_id: str,
        scope: str,
    ) -> bool:
        if list_call_id not in event["deps"]:
            return False
        value = event.get("value")
        if value is None:
            return False
        comprehensions = [
            node
            for node in ast.walk(value)
            if isinstance(node, (ast.DictComp, ast.GeneratorExp))
        ]
        for comprehension in comprehensions:
            if any(generator.ifs for generator in comprehension.generators):
                continue
            target_names = set().union(
                *(
                    self._target_names(generator.target)
                    for generator in comprehension.generators
                )
            )
            if not target_names:
                continue
            if isinstance(comprehension, ast.DictComp):
                key_names = self._target_names(comprehension.key)
                value_names = self._target_names(comprehension.value)
            else:
                if not (
                    isinstance(comprehension.elt, (ast.Tuple, ast.List))
                    and len(comprehension.elt.elts) == 2
                ):
                    continue
                key_names = self._target_names(comprehension.elt.elts[0])
                value_names = self._target_names(comprehension.elt.elts[1])
            if target_names & key_names and target_names & value_names:
                if event["replace"]:
                    return True
                return any(
                    clear["scope"] in self._scope_closure(scope)
                    and clear["order"] < event["order"]
                    for clear in self.cache_clears
                )
        if isinstance(event["target"], ast.Subscript):
            function = self.functions.get(event["scope"])
            if function is None:
                return False
            for loop in (
                node
                for node in ast.walk(function.node)
                if isinstance(node, (ast.For, ast.AsyncFor))
                and any(
                    self._node_within(event["node"], statement)
                    for statement in node.body
                )
            ):
                target_names = self._target_names(loop.target)
                cache_key_names = self._target_names(event["target"].slice)
                value_names = self._target_names(value)
                if (
                    target_names & cache_key_names
                    and target_names & value_names
                    and any(
                        clear["scope"] in self._scope_closure(scope)
                        and clear["order"] < event["order"]
                        for clear in self.cache_clears
                    )
                ):
                    return True
        return False

    def _full_refresh_scopes(self) -> dict[str, set[str]]:
        result = {"sync": set(), "async": set()}
        list_calls = [
            call
            for call in self.calls
            if call.get("kind") == "sdk"
            and call.get("method") == "list_configuration_settings"
        ]
        for list_call in list_calls:
            key_filter = self._value(list_call, "key_filter", 0)
            has_filter = (
                "key_filter" in list_call["named"]
                or bool(list_call["positional"])
            )
            if has_filter and key_filter.data != "*":
                continue
            scope = list_call["scope"]
            for event in self.cache_writes:
                connected = (
                    event["scope"] in self._scope_closure(scope)
                    or scope in self._scope_closure(event["scope"])
                )
                if connected and self._complete_cache_repopulation(
                    event,
                    list_call["id"],
                    event["scope"],
                ):
                    result[list_call["mode"]].update(
                        {scope, event["scope"]}
                    )
        for function in self.functions.values():
            if function.key not in self.reachable:
                continue
            cache_names: dict[str, str] = {}
            for node in ast.walk(function.node):
                if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                    continue
                targets = (
                    node.targets
                    if isinstance(node, ast.Assign)
                    else [node.target]
                )
                value = node.value
                if value is None:
                    continue
                source = value
                if isinstance(value, ast.Call) and value.args:
                    source = value.args[0]
                if not (
                    isinstance(source, ast.Attribute)
                    and isinstance(source.value, ast.Name)
                    and source.value.id == "self"
                ):
                    continue
                for target in targets:
                    if isinstance(target, ast.Name):
                        cache_names[target.id] = source.attr

            covered: dict[str, set[str]] = {"get": set(), "list": set()}
            mode = (
                "async"
                if isinstance(function.node, ast.AsyncFunctionDef)
                else "sync"
            )
            for loop in (
                node
                for node in ast.walk(function.node)
                if isinstance(node, (ast.For, ast.AsyncFor))
            ):
                cache_attribute = None
                if isinstance(loop.iter, ast.Name):
                    cache_attribute = cache_names.get(loop.iter.id)
                elif (
                    isinstance(loop.iter, ast.Attribute)
                    and isinstance(loop.iter.value, ast.Name)
                    and loop.iter.value.id == "self"
                ):
                    cache_attribute = loop.iter.attr
                if cache_attribute is None:
                    continue
                for call in self.function_calls:
                    if call["caller"] != function.key or not any(
                        self._node_within(call["node"], statement)
                        for statement in loop.body
                    ):
                        continue
                    invocation = call["node"]
                    forced = any(
                        keyword.arg == "force"
                        and literal(keyword.value, {}) is True
                        for keyword in invocation.keywords
                    )
                    if not forced:
                        continue
                    closure = self._scope_closure(call["callee"])
                    methods = {
                        sdk_call["method"]
                        for sdk_call in self.calls
                        if sdk_call.get("kind") == "sdk"
                        and sdk_call["scope"] in closure
                        and sdk_call["mode"] == mode
                    }
                    if "get_configuration_setting" in methods:
                        covered["get"].add(cache_attribute)
                    if "list_configuration_settings" in methods:
                        covered["list"].add(cache_attribute)
            if covered["get"] and covered["list"] and (
                covered["get"] != covered["list"]
            ):
                result[mode].add(function.key)
        return result

    def _condition_has_connected_change(
        self,
        node: ast.AST,
        scope: str,
        visited: set[str] | None = None,
    ) -> bool:
        if self._condition_has_change(node):
            return True
        if any(
            event["scope"] == scope
            and event["node"].test is node
            and any(
                dependency.startswith("sdk:")
                for dependency in event["deps"]
            )
            and any(
                dependency.startswith("cache:")
                for dependency in event["deps"]
            )
            for event in self.if_events
        ):
            return True
        visited = visited or set()
        for call in self.function_calls:
            if call["caller"] != scope or not self._node_within(
                call["node"],
                node,
            ):
                continue
            callee = call["callee"]
            if callee in visited:
                continue
            function = self.functions.get(callee)
            if function is None:
                continue
            visited.add(callee)
            for return_node in (
                child
                for child in ast.walk(function.node)
                if isinstance(child, ast.Return)
                and child.value is not None
            ):
                if self._condition_has_connected_change(
                    return_node.value,
                    callee,
                    visited,
                ):
                    return True
        return False

    def _if_triggers_refresh(
        self,
        event: dict[str, Any],
        refresh_scopes: set[str],
    ) -> bool:
        statement = event["node"]
        for call in self.function_calls:
            if call["caller"] != event["scope"]:
                continue
            if not any(
                self._node_within(call["node"], child)
                for child in statement.body
            ):
                continue
            closure = self._scope_closure(call["callee"])
            if closure & refresh_scopes:
                return True
        return any(
            call["scope"] == event["scope"]
            and call["scope"] in refresh_scopes
            and any(
                self._node_within(call["node"], child)
                for child in statement.body
            )
            for call in self.calls
            if call.get("kind") == "sdk"
            and call.get("method") == "list_configuration_settings"
        )

    def _sentinel_rule(self) -> bool:
        refresh_scopes = self._full_refresh_scopes()
        found: set[str] = set()
        get_calls = [
            call
            for call in self.calls
            if call.get("kind") == "sdk"
            and call.get("method") == "get_configuration_setting"
        ]
        for function in self.functions.values():
            if function.key not in self.reachable:
                continue
            mode = (
                "async"
                if isinstance(function.node, ast.AsyncFunctionDef)
                else "sync"
            )
            closure = self._scope_closure(function.key)
            sleeps = [
                event
                for event in self.sleep_calls
                if event["scope"] in closure
            ]
            polls = [
                call
                for call in get_calls
                if call["scope"] in closure and call["mode"] == mode
            ]
            loops = [
                event
                for event in self.loop_events
                if event["scope"] == function.key
            ]
            sleep_parameters = {
                dependency
                for event in sleeps
                for dependency in event["deps"]
                if dependency.startswith("param:")
            }
            poll_parameters = {
                dependency
                for call in polls
                for dependency in self._value(call, "key", 0).deps
                if dependency.startswith("param:")
            }
            changes = [
                event
                for event in self.if_events
                if event["scope"] in closure
                and self._condition_has_connected_change(
                    event["node"].test,
                    event["scope"],
                )
                and self._if_triggers_refresh(
                    event,
                    refresh_scopes[mode],
                )
            ]
            connected_change = any(
                any(call["id"] in event["deps"] for call in polls)
                and (
                    any(
                        dependency.startswith("cache:")
                        for dependency in event["deps"]
                    )
                    or sum(
                        call["id"] in event["deps"]
                        for call in polls
                    )
                    >= 2
                )
                for event in changes
            )
            if (
                loops
                and sleep_parameters
                and poll_parameters
                and sleep_parameters != poll_parameters
                and connected_change
            ):
                found.add(mode)
        return found == {"sync", "async"}

    def _flow_rule(self) -> bool:
        required = [
            "sync_client",
            "sync_read",
            "sync_list",
            "sync_feature",
            "sync_watch",
            "async_client",
            "async_read",
            "async_list",
            "async_feature",
            "async_watch",
        ]
        for flow in self.final_flows:
            position = -1
            for token in required:
                try:
                    position = flow.index(token, position + 1)
                except ValueError:
                    break
            else:
                return True
        return False

    def results(self) -> dict[str, bool]:
        source_ready = self.valid and bool(self.documents)
        required_pins = {
            "azure-appconfiguration": "1.9.0",
            "azure-identity": "1.25.3",
        }
        observed_versions = {
            name: set().union(
                *(
                    pins.get(name, set())
                    for pins in self.manifest_pins
                )
            )
            for name in required_pins
        }
        coherent_manifest = any(
            all(pins.get(name) == {version} for name, version in required_pins.items())
            for pins in self.manifest_pins
        )
        rules = {
            "prompt/sdk-pins": (
                coherent_manifest
                and all(
                    observed_versions[name] == {version}
                    for name, version in required_pins.items()
                )
            ),
            "prompt/secure-sync-async-clients": source_ready and self._client_rule(),
            "prompt/configuration-reads": source_ready and self._read_rule(),
            "prompt/etag-conditional-cache": source_ready and self._etag_rule(),
            "prompt/feature-flag-evaluation": source_ready and self._feature_rule(),
            "prompt/deterministic-percentage-rollout": source_ready and self._rollout_rule(),
            "prompt/sentinel-refresh": source_ready and self._sentinel_rule(),
            "prompt/connected-sync-then-async-demo": source_ready and self._flow_rule(),
        }
        return {name: bool(rules[name]) for name in RULES}


def main() -> None:
    request = json.load(sys.stdin)
    analyzer = Analyzer(request)
    analyzer.run()
    json.dump(analyzer.results(), sys.stdout, sort_keys=True)


if __name__ == "__main__":
    main()
