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


@dataclass
class Function:
    name: str
    node: ast.FunctionDef | ast.AsyncFunctionDef
    asynchronous: bool


class Program:
    def __init__(self, documents: list[dict[str, str]]) -> None:
        self.valid = True
        self.modules: list[ast.Module] = []
        self.functions: list[Function] = []
        self.classes: list[ast.ClassDef] = []
        for document in documents:
            try:
                module = ast.parse(document.get("source", ""))
            except SyntaxError:
                self.valid = False
                continue
            self.modules.append(module)
            for node in ast.walk(module):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    self.functions.append(
                        Function(node.name, node, isinstance(node, ast.AsyncFunctionDef))
                    )
                elif isinstance(node, ast.ClassDef):
                    self.classes.append(node)

        self.by_name: dict[str, list[Function]] = {}
        for function in self.functions:
            self.by_name.setdefault(function.name, []).append(function)
        self.roots = self._roots()
        self.reachable = self._reachable()
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


def message_metadata(code: str) -> bool:
    normalized = code.replace(" ", "")
    correlation = bool(
        re.search(r"correlation_id\s*=\s*[^,\n)]*order[_\.]?id", code, re.IGNORECASE)
        or re.search(r"\.correlation_id\s*=\s*[^,\n]*order[_\.]?id", code, re.IGNORECASE)
        or re.search(
            r"['\"]correlation_id['\"]\s*:\s*[^,\n}]*order\.order_id",
            code,
            re.IGNORECASE,
        )
    )
    session = bool(
        re.search(r"session_id\s*=\s*[^,\n)]*customer[_\.]?name", code, re.IGNORECASE)
        or re.search(r"\.session_id\s*=\s*[^,\n]*customer[_\.]?name", code, re.IGNORECASE)
        or re.search(
            r"['\"]session_id['\"]\s*:\s*[^,\n}]*order\.customer_name",
            code,
            re.IGNORECASE,
        )
    )
    scheduled = (
        "scheduled_enqueue_time_utc" in code
        or "schedule_messages" in code
    ) and bool(re.search(r"(?:seconds\s*=\s*30|timedelta\s*\(\s*[^)]*30)", code))
    priority = "high" in code.lower() and bool(
        re.search(r"total_price\s*(?:>|>=)|(?:>|>=)\s*[^:\n]*total_price", code)
    )
    return correlation and session and scheduled and priority and "ServiceBusMessage" in normalized


def sender_rule(program: Program, asynchronous: bool) -> bool:
    candidates = [
        function
        for function in program.reachable
        if function.asynchronous == asynchronous
    ]
    single = False
    batch = False
    for function in candidates:
        code = program.code_for(function)
        own = ast.unparse(active_node(function.node))
        if (
            "get_queue_sender" in code
            and "send_messages" in code
            and "ServiceBusMessage" in code
            and message_metadata(code)
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


def receiver_loop(code: str, asynchronous: bool) -> bool:
    loop = re.search(
        r"(?:async\s+)?for\s+(\w+)\s+in\s+[^:\n]*:(?P<body>[\s\S]+)",
        code,
    )
    if not loop:
        return False
    message = loop.group(1)
    body = loop.group("body")
    prefix = r"\bawait\s+" if asynchronous else ""
    complete = re.search(
        rf"{prefix}\w+\.complete_message\s*\(\s*{re.escape(message)}\s*\)", body
    )
    dead_letter = re.search(
        rf"{prefix}\w+\.dead_letter_message\s*\(\s*{re.escape(message)}\s*,[\s\S]*?\breason\s*=",
        body,
    )
    abandon = re.search(
        rf"{prefix}\w+\.abandon_message\s*\(\s*{re.escape(message)}\s*\)", body
    )
    deserialize = "from_json" in body or "json.loads" in body
    ordered = bool(
        complete
        and dead_letter
        and body.find("from_json") >= 0
        and body.find("from_json") < complete.start()
    )
    return deserialize and ordered and bool(abandon)


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
            and ".is_transient" in code
            and receiver_loop(own, asynchronous)
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
        loop = re.search(
            r"(?:async\s+)?for\s+(\w+)\s+in\s+[^:\n]*:(?P<body>[\s\S]+)",
            own,
        )
        if not loop:
            continue
        message = loop.group(1)
        body = loop.group("body")
        order_match = re.search(
            rf"\b(\w+)\s*=\s*(?:\w+\.)?from_json\s*\(\s*(?:str\s*\(\s*)?{message}",
            body,
        )
        if not order_match:
            continue
        order = order_match.group(1)
        await_prefix = r"await\s+" if asynchronous else ""
        send = re.search(
            rf"{await_prefix}\w+\.(?:send|publish)\w*\s*\(\s*{order}\s*\)",
            body,
        )
        complete = re.search(
            rf"{await_prefix}\w+\.complete_message\s*\(\s*{message}\s*\)",
            body,
        )
        if send and complete and send.start() < complete.start():
            return True
    return False


def error_classification(program: Program) -> bool:
    for function in program.reachable:
        code = ast.unparse(active_node(function.node))
        if (
            "ServiceBusError" in code
            and ".is_transient" in code
            and re.search(r"(?:entity|queue)", code, re.IGNORECASE)
            and re.search(r"(?:logging|logger|print)\.", code, re.IGNORECASE)
            and re.search(r"(?:error|exception)", code, re.IGNORECASE)
        ):
            return True
    return False


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
        for function in program.reachable:
            if function.asynchronous != asynchronous:
                continue
            own = ast.unparse(active_node(function.node))
            if kind == "single" and "send_messages" in own and "create_message_batch" not in own:
                return function.name
            if kind == "batch" and "create_message_batch" in own:
                return function.name
            if (
                kind == "process"
                and "get_queue_receiver" in own
                and "DEAD_LETTER" not in own
                and "complete_message" in own
            ):
                return function.name
            if kind == "reprocess" and "DEAD_LETTER" in own:
                return function.name
        return None

    sync_names = [feature_name(False, kind) for kind in (
        "single", "batch", "process", "reprocess"
    )]
    async_names = [feature_name(True, kind) for kind in (
        "single", "batch", "process", "reprocess"
    )]
    if any(name is None for name in sync_names + async_names):
        return False
    for main in mains:
        code = ast.unparse(active_node(main.node))
        sync_calls = [code.find(f".{name}(") for name in sync_names]
        if (
            "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE" not in code
            or "SERVICE_BUS_QUEUE_NAME" not in code
            or "DefaultAzureCredential" not in code
            or "ServiceBusClient" not in code
            or "with " not in code
            or any(position < 0 for position in sync_calls)
            or sync_calls != sorted(sync_calls)
            or "asyncio.run" not in code
            or code.find("asyncio.run") < sync_calls[-1]
        ):
            continue
        for async_run in async_runs:
            async_code = ast.unparse(active_node(async_run.node))
            async_calls = [async_code.find(f".{name}(") for name in async_names]
            if (
                "AsyncServiceBusClient" in program.all_code
                and "async with" in async_code
                and all(position >= 0 for position in async_calls)
                and async_calls == sorted(async_calls)
                and async_code.count("await ") >= 4
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
