from __future__ import annotations

import ast
import json
import re
import sys
from dataclasses import dataclass
from typing import Any


PINS = {
    "azure-identity": "1.25.3",
    "azure-keyvault-secrets": "4.11.2",
}


def active_statements(statements: list[ast.stmt]) -> list[ast.stmt]:
    active: list[ast.stmt] = []
    for statement in statements:
        if isinstance(statement, ast.If):
            value = literal_bool(statement.test)
            if value is True:
                active.extend(active_statements(statement.body))
            elif value is False:
                active.extend(active_statements(statement.orelse))
            else:
                statement.body = active_statements(statement.body)
                statement.orelse = active_statements(statement.orelse)
                active.append(statement)
        elif isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            statement.body = active_statements(statement.body)
            statement.orelse = active_statements(statement.orelse)
            active.append(statement)
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            statement.body = active_statements(statement.body)
            active.append(statement)
        elif isinstance(statement, ast.Try):
            statement.body = active_statements(statement.body)
            statement.orelse = active_statements(statement.orelse)
            statement.finalbody = active_statements(statement.finalbody)
            for handler in statement.handlers:
                handler.body = active_statements(handler.body)
            active.append(statement)
        else:
            active.append(statement)
        if isinstance(statement, (ast.Return, ast.Raise)):
            break
    return active


def literal_bool(node: ast.AST) -> bool | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, bool):
        return node.value
    return None


def dotted(node: ast.AST | None) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        return f"{base}.{node.attr}" if base else node.attr
    return ""


def expression(node: ast.AST | None) -> str:
    if node is None:
        return ""
    try:
        return ast.unparse(node).replace(" ", "")
    except Exception:
        return ""


def handler_name(node: ast.AST | None) -> str:
    if isinstance(node, ast.Tuple):
        return "|".join(handler_name(item) for item in node.elts)
    return dotted(node)


@dataclass
class Function:
    key: str
    node: ast.FunctionDef | ast.AsyncFunctionDef


class Model:
    def __init__(self, documents: list[dict[str, str]]) -> None:
        self.valid = True
        self.local_azure = any(
            item["path"].lower().startswith(("azure/", "src/azure/"))
            for item in documents
        )
        self.modules: list[ast.Module] = []
        self.imports: dict[str, str] = {}
        self.functions: dict[str, list[Function]] = {}
        self.roots: list[list[ast.stmt]] = []
        self.parents: dict[ast.AST, ast.AST] = {}
        self.reachable: set[str] = set()
        self.reachable_functions: list[Function] = []

        for document in documents:
            try:
                module = ast.parse(document["source"], filename=document["path"])
            except SyntaxError:
                self.valid = False
                continue
            module.body = active_statements(module.body)
            self.modules.append(module)
            self.collect_imports(module)
            self.collect_functions(module)
            self.roots.append([
                statement for statement in module.body
                if not isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            ])
            for parent in ast.walk(module):
                for child in ast.iter_child_nodes(parent):
                    self.parents[child] = parent

        self.mark_reachable()

    def collect_imports(self, module: ast.Module) -> None:
        for node in ast.walk(module):
            if isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    self.imports[alias.asname or alias.name] = f"{node.module}.{alias.name}"
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    self.imports[alias.asname or alias.name.split(".")[0]] = alias.name

    def collect_functions(self, module: ast.Module) -> None:
        for node in module.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.functions.setdefault(node.name, []).append(Function(node.name, node))
            elif isinstance(node, ast.ClassDef):
                for member in node.body:
                    if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        key = f"{node.name}.{member.name}"
                        self.functions.setdefault(member.name, []).append(Function(key, member))

    def calls_in(self, statements: list[ast.stmt]) -> set[str]:
        names: set[str] = set()
        for statement in statements:
            for node in ast.walk(statement):
                if isinstance(node, ast.Call):
                    name = dotted(node.func).split(".")[-1]
                    if name in self.functions:
                        names.add(name)
        return names

    def mark_reachable(self) -> None:
        queue: list[str] = []
        for root in self.roots:
            queue.extend(self.calls_in(root))
        if not queue and "main" in self.functions:
            queue.append("main")
        while queue:
            name = queue.pop()
            for function in self.functions.get(name, []):
                if function.key in self.reachable:
                    continue
                self.reachable.add(function.key)
                self.reachable_functions.append(function)
                queue.extend(self.calls_in(function.node.body))

    def official(self, name: str, qualified: str) -> bool:
        return self.imports.get(name) == qualified

    def nodes(self) -> list[ast.AST]:
        result: list[ast.AST] = []
        for root in self.roots:
            for statement in root:
                result.extend(ast.walk(statement))
        for function in self.reachable_functions:
            result.extend(ast.walk(function.node))
        return result

    def source(self) -> str:
        values = []
        for root in self.roots:
            values.extend(ast.unparse(statement) for statement in root)
        values.extend(ast.unparse(function.node) for function in self.reachable_functions)
        return "\n".join(values)


def pinned_packages(manifests: list[dict[str, str]]) -> bool:
    found: dict[str, str] = {}
    for manifest in manifests:
        content = manifest.get("content", "")
        filename = manifest.get("filename", "").lower()
        if filename.startswith("requirements"):
            for raw in content.splitlines():
                line = raw.split("#", 1)[0].strip()
                match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)", line)
                if match:
                    found[match.group(1).lower().replace("_", "-")] = match.group(2)
        elif filename == "pyproject.toml":
            for package, version in re.findall(
                r"""["']?(azure[-_.](?:identity|keyvault[-_.]secrets))["']?\s*(?:==|=)\s*["']([^"']+)["']""",
                content,
                re.IGNORECASE,
            ):
                found[package.lower().replace("_", ".").replace(".", "-")] = version.removeprefix("==")
    return all(found.get(package) == version for package, version in PINS.items())


def calls(model: Model, method: str) -> list[ast.Call]:
    return [
        node for node in model.nodes()
        if isinstance(node, ast.Call) and dotted(node.func).split(".")[-1] == method
    ]


def is_awaited(model: Model, node: ast.AST) -> bool:
    parent = model.parents.get(node)
    while parent and isinstance(parent, (ast.Attribute, ast.Subscript)):
        parent = model.parents.get(parent)
    return isinstance(parent, ast.Await)


def function_has_default_handler(function: Function, model: Model) -> bool:
    parameters = {
        argument.arg for argument in function.node.args.args + function.node.args.kwonlyargs
        if "default" in argument.arg.lower()
    }
    for node in ast.walk(function.node):
        if isinstance(node, ast.ExceptHandler):
            target = handler_name(node.type).split(".")[-1]
            imported = model.imports.get(target, "")
            if imported != "azure.core.exceptions.ResourceNotFoundError":
                continue
            returns = [
                child.value for statement in node.body for child in ast.walk(statement)
                if isinstance(child, ast.Return)
            ]
            if any(
                any(isinstance(value_node, ast.Name) and value_node.id in parameters
                    for value_node in ast.walk(value))
                for value in returns
                if value is not None
            ):
                return True
    return False


def provider_rule(model: Model, asynchronous: bool) -> bool:
    expected_client = (
        "azure.keyvault.secrets.aio.SecretClient"
        if asynchronous else "azure.keyvault.secrets.SecretClient"
    )
    client_names = {name for name, value in model.imports.items() if value == expected_client}
    if not client_names:
        return False

    def annotated_with_client(function: Function) -> bool:
        for argument in function.node.args.args + function.node.args.kwonlyargs:
            annotation = dotted(argument.annotation)
            if annotation in client_names or model.imports.get(annotation) == expected_client:
                return True
        class_name = function.key.split(".", 1)[0] if "." in function.key else ""
        for initializer in model.functions.get("__init__", []):
            if not initializer.key.startswith(f"{class_name}."):
                continue
            for argument in initializer.node.args.args + initializer.node.args.kwonlyargs:
                annotation = dotted(argument.annotation)
                if annotation in client_names or model.imports.get(annotation) == expected_client:
                    return True
        return False

    for function in model.reachable_functions:
        if isinstance(function.node, ast.AsyncFunctionDef) != asynchronous:
            continue
        if not annotated_with_client(function):
            continue
        function_calls = [node for node in ast.walk(function.node) if isinstance(node, ast.Call)]
        gets = [
            node for node in function_calls
            if dotted(node.func).split(".")[-1] == "get_secret"
        ]
        versioned = any(
            len(node.args) >= 2 or any(keyword.arg == "version" for keyword in node.keywords)
            for node in gets
        )
        awaited = all(is_awaited(model, node) for node in gets) if asynchronous else True
        expiry = any(
            isinstance(node, ast.Attribute) and node.attr == "expires_on"
            for node in ast.walk(function.node)
        )
        if gets and versioned and awaited and expiry and function_has_default_handler(function, model):
            return True
    return False


def cache_rule(model: Model) -> bool:
    source = model.source()
    has_store = any(isinstance(node, ast.Subscript) and isinstance(model.parents.get(node), ast.Assign)
                    for node in model.nodes())
    has_mapping = has_store or bool(
        re.search(r"\bdict\s*\[|\bDict\s*\[|\{\s*\}", source)
    )
    has_loop = any(isinstance(node, (ast.For, ast.AsyncFor)) for node in model.nodes())
    has_comparison = any(isinstance(node, ast.Compare) for node in model.nodes())
    warning = bool(re.search(r"warning|window|timedelta", source, re.IGNORECASE))
    function_names = {function.node.name.lower() for function in model.reachable_functions}
    bulk = any("load" in name or "warm" in name for name in function_names)
    refresh = any("refresh" in name for name in function_names)
    expiry_refresh = any(
        any(isinstance(node, ast.Compare) for node in ast.walk(function.node))
        and any(
            isinstance(node, ast.Call)
            and dotted(node.func).split(".")[-1] == "refresh"
            for node in ast.walk(function.node)
        )
        and bool(re.search(
            r"warning|window|timedelta",
            ast.unparse(function.node),
            re.IGNORECASE,
        ))
        for function in model.reachable_functions
    )
    gets = len(calls(model, "get_secret")) + len(calls(model, "get"))
    return all((
        has_mapping,
        has_store,
        has_loop,
        has_comparison,
        warning,
        bulk,
        refresh,
        expiry_refresh,
        gets >= 2,
    ))


def statement_paths(statements: list[ast.stmt]) -> list[list[ast.AST]]:
    paths: list[list[ast.AST]] = [[]]
    for statement in statements:
        if isinstance(statement, ast.If):
            value = literal_bool(statement.test)
            if value is True:
                choices = statement_paths(statement.body)
            elif value is False:
                choices = statement_paths(statement.orelse)
            else:
                choices = statement_paths(statement.body) + statement_paths(statement.orelse)
        elif isinstance(statement, ast.Try):
            choices = statement_paths(statement.body)
        else:
            choices = [[statement]]
        paths = [prefix + choice for prefix in paths for choice in choices]
        if isinstance(statement, (ast.Return, ast.Raise)):
            break
    return paths


def path_events(path: list[ast.AST], model: Model, asynchronous: bool) -> list[tuple[str, str, str, bool]]:
    events: list[tuple[str, str, str, bool]] = []
    pollers: dict[str, tuple[str, str]] = {}
    for statement in path:
        for node in ast.walk(statement):
            if not isinstance(node, ast.Call):
                continue
            method = dotted(node.func).split(".")[-1]
            receiver = dotted(node.func.value) if isinstance(node.func, ast.Attribute) else ""
            name = expression(node.args[0]) if node.args else ""
            awaited = is_awaited(model, node)
            if method == "begin_delete_secret":
                assigned = model.parents.get(node)
                while assigned and not isinstance(assigned, (ast.Assign, ast.AnnAssign)):
                    assigned = model.parents.get(assigned)
                variable = ""
                if isinstance(assigned, ast.Assign) and isinstance(assigned.targets[0], ast.Name):
                    variable = assigned.targets[0].id
                elif isinstance(assigned, ast.AnnAssign) and isinstance(assigned.target, ast.Name):
                    variable = assigned.target.id
                pollers[variable] = (receiver, name)
                events.append(("begin", receiver, name, awaited))
            elif method in {"wait", "result"} and receiver in pollers:
                client, secret = pollers[receiver]
                events.append(("wait", client, secret, awaited))
            elif method == "purge_deleted_secret":
                events.append(("purge", receiver, name, awaited))
            elif method == "set_secret":
                events.append(("set", receiver, name, awaited))
    return events


def safe_rotation(model: Model, asynchronous: bool) -> bool:
    for function in model.reachable_functions:
        if isinstance(function.node, ast.AsyncFunctionDef) != asynchronous:
            continue
        for path in statement_paths(function.node.body):
            events = path_events(path, model, asynchronous)
            for begin_index, begin in enumerate(events):
                if begin[0] != "begin":
                    continue
                for wait_index in range(begin_index + 1, len(events)):
                    wait = events[wait_index]
                    if wait[:3] != ("wait", begin[1], begin[2]):
                        continue
                    for purge_index in range(wait_index + 1, len(events)):
                        purge = events[purge_index]
                        if purge[:3] != ("purge", begin[1], begin[2]):
                            continue
                        for replacement in events[purge_index + 1:]:
                            if replacement[:3] == ("set", begin[1], begin[2]):
                                required = [begin, wait, purge, replacement]
                                if asynchronous and not all(event[3] for event in required):
                                    continue
                                expires = any(
                                    keyword.arg == "expires_on"
                                    for call in calls(model, "set_secret")
                                    for keyword in call.keywords
                                )
                                if expires:
                                    return True
    return False


def configuration_rule(model: Model) -> bool:
    if model.local_azure or not model.valid:
        return False
    credential_names = {
        name for name, value in model.imports.items()
        if value in {
            "azure.identity.DefaultAzureCredential",
            "azure.identity.aio.DefaultAzureCredential",
        }
    }
    sync_clients = {
        name for name, value in model.imports.items()
        if value == "azure.keyvault.secrets.SecretClient"
    }
    async_clients = {
        name for name, value in model.imports.items()
        if value == "azure.keyvault.secrets.aio.SecretClient"
    }
    constructor_names = {
        dotted(node.func).split(".")[-1]
        for node in model.nodes() if isinstance(node, ast.Call)
    }
    source = model.source()
    has_environment = bool(re.search(r"os\.(?:environ|getenv)|getenv\s*\(", source))
    return (
        bool(credential_names & constructor_names)
        and bool(sync_clients & constructor_names)
        and bool(async_clients & constructor_names)
        and has_environment
    )


def connected_demo(model: Model, rules: dict[str, bool]) -> bool:
    source = model.source()
    sync_match = re.search(r"\b(?:run_)?sync\w*\s*\(", source, re.IGNORECASE)
    async_match = re.search(r"\b(?:run_)?async\w*\s*\(", source, re.IGNORECASE)
    operations = [
        r"\b(?:bulk_?load|load_?all|warm)\w*\s*\(",
        r"\b(?:refresh)\w*\s*\(",
        r"\b(?:refresh_?expir|check_?expir|near_?expir)\w*\s*\(",
        r"\b(?:rotate)\w*\s*\(",
    ]
    return (
        all(rules[name] for name in (
            "prompt/sync-provider",
            "prompt/async-provider",
            "prompt/expiry-aware-cache",
            "prompt/sync-safe-rotation",
            "prompt/async-safe-rotation",
        ))
        and sync_match is not None
        and async_match is not None
        and sync_match.start() < async_match.start()
        and all(re.search(pattern, source, re.IGNORECASE) for pattern in operations)
    )


def main() -> None:
    payload: dict[str, Any] = json.load(sys.stdin)
    model = Model(payload.get("documents", []))
    rules = {
        "prompt/sdk-packages": pinned_packages(payload.get("dependencyManifests", [])),
        "prompt/managed-identity-configuration": configuration_rule(model),
        "prompt/sync-provider": model.valid and not model.local_azure and provider_rule(model, False),
        "prompt/async-provider": model.valid and not model.local_azure and provider_rule(model, True),
        "prompt/expiry-aware-cache": model.valid and cache_rule(model),
        "prompt/sync-safe-rotation": model.valid and safe_rotation(model, False),
        "prompt/async-safe-rotation": model.valid and safe_rotation(model, True),
    }
    rules["prompt/connected-demo"] = connected_demo(model, rules)
    json.dump(rules, sys.stdout)


if __name__ == "__main__":
    main()
