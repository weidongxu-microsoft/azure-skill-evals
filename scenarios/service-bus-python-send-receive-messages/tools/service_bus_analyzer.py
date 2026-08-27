from __future__ import annotations

import ast
import itertools
import json
import re
import sys
import tomllib
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Value:
    kind: str
    data: Any = None


@dataclass
class Function:
    node: ast.FunctionDef | ast.AsyncFunctionDef
    closure: dict[str, Value]
    scope: str


@dataclass
class Resource:
    identifier: int
    kind: str
    is_async: bool
    parent: int | None = None
    entity_kind: str | None = None
    entity: Value = field(default_factory=lambda: Value("unknown"))
    subscription: Value = field(default_factory=lambda: Value("unknown"))
    configured: bool = False
    constructed: int = 0
    cleanup: int | None = None
    cleanup_style: str | None = None
    last_use: int = 0
    guards: frozenset[tuple[int, str]] = frozenset()


@dataclass
class Message:
    identifier: int
    origin: str
    body: bool
    receiver: int | None = None
    receive: int | None = None


@dataclass
class Batch:
    identifier: int
    sender: int
    messages: list[int] = field(default_factory=list)
    all_new: bool = True
    add_failure_handled: bool = True


@dataclass
class Pending:
    identifier: int
    kind: str
    target: Any
    positional: list[Value]
    named: dict[str, Value]


@dataclass
class Operation:
    identifier: int
    kind: str
    order: int
    resource: int | None = None
    message: int | None = None
    batch: int | None = None
    related: int | None = None
    bounded: bool = False
    guards: frozenset[tuple[int, str]] = frozenset()
    normal_flow: bool = True
    scope: str = ""


UNKNOWN = Value("unknown")
SERVICE_BUS_CLIENT = {
    "azure.servicebus.ServiceBusClient",
    "azure.servicebus.aio.ServiceBusClient",
}
SERVICE_BUS_MESSAGE = "azure.servicebus.ServiceBusMessage"
SIZE_ERROR = "azure.servicebus.exceptions.MessageSizeExceededError"
CREDENTIALS = {
    "azure.identity.DefaultAzureCredential",
    "azure.identity.aio.DefaultAzureCredential",
}


def same_value(left: Value, right: Value) -> bool:
    if left.kind != right.kind:
        return False
    if left.kind in {"resource", "message", "batch", "function", "pending"}:
        return left.data is right.data
    return left.data == right.data


def compatible(*operations: Operation) -> bool:
    seen: dict[int, str] = {}
    for operation in operations:
        for branch, side in operation.guards:
            previous = seen.get(branch)
            if previous is not None and previous != side:
                return False
            seen[branch] = side
    return True


def handler_aborts_send(handler: ast.ExceptHandler) -> bool:
    return any(
        isinstance(statement, (ast.Raise, ast.Return))
        for statement in ast.walk(handler)
    )


def dotted(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        if base is not None:
            return f"{base}.{node.attr}"
    return None


class Analyzer:
    def __init__(
        self,
        sources: list[str],
        dependency_manifests: list[dict[str, str]],
    ) -> None:
        self.sources = sources
        self.dependency_manifests = dependency_manifests
        self.valid_source = False
        self.parse_error = False
        self.order = 0
        self.identifiers = 0
        self.branch_identifiers = 0
        self.resources: dict[int, Resource] = {}
        self.messages: dict[int, Message] = {}
        self.batches: dict[int, Batch] = {}
        self.operations: list[Operation] = []
        self.pending: set[int] = set()
        self.guards: list[tuple[int, str]] = []
        self.scope = "module"
        self.call_stack: set[int] = set()
        self.batch_handlers: list[bool] = []
        self.cleanup_guaranteed = 0
        self.exceptional_depth = 0
        self.branch_sides: dict[int, set[str]] = {}

    def identifier(self) -> int:
        self.identifiers += 1
        return self.identifiers

    def tick(self) -> int:
        self.order += 1
        return self.order

    def record(self, kind: str, **values: Any) -> Operation:
        operation = Operation(
            identifier=self.identifier(),
            kind=kind,
            order=self.tick(),
            guards=frozenset(self.guards),
            normal_flow=self.exceptional_depth == 0,
            scope=self.scope,
            **values,
        )
        self.operations.append(operation)
        if operation.resource is not None and operation.kind != "cleanup":
            self.resources[operation.resource].last_use = operation.order
        return operation

    def analyze(self) -> dict[str, bool]:
        for source_index, source in enumerate(self.sources):
            if not source.strip():
                continue
            try:
                tree = ast.parse(source)
            except SyntaxError:
                self.parse_error = True
                continue
            if any(
                not (
                    isinstance(statement, ast.Expr)
                    and isinstance(statement.value, ast.Constant)
                    and isinstance(statement.value.value, str)
                )
                for statement in tree.body
            ):
                self.valid_source = True
            environment: dict[str, Value] = {
                "__name__": Value("literal", "__main__"),
            }
            previous_scope = self.scope
            self.scope = f"module:{source_index}"
            self.execute_block(tree.body, environment)
            self.scope = previous_scope

        valid = self.valid_source and not self.parse_error
        rules = {
            "prompt/service-bus-package": valid and self.package_declared(),
            "prompt/client-configuration": valid and self.client_configuration(),
            "prompt/queue-single-send": valid and self.queue_single_send(),
            "prompt/queue-batch-send": valid and self.queue_batch_send(),
            "prompt/queue-receive": valid and self.queue_receive(),
            "prompt/message-settlement": valid and self.message_settlement(),
            "prompt/async-client": valid and self.async_client(),
            "prompt/topic-subscription": valid and self.topic_subscription(),
            "prompt/resource-lifecycle": valid and self.resource_lifecycle(),
        }
        return rules

    def execute_block(
        self,
        statements: list[ast.stmt],
        environment: dict[str, Value],
    ) -> Value:
        for statement in statements:
            returned = self.execute_statement(statement, environment)
            if returned.kind in {"break", "return"}:
                return returned
        return UNKNOWN

    def execute_statement(
        self,
        statement: ast.stmt,
        environment: dict[str, Value],
    ) -> Value:
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                local = alias.asname or alias.name.split(".")[0]
                canonical = alias.name if alias.asname else alias.name.split(".")[0]
                environment[local] = Value("symbol", canonical)
            return UNKNOWN
        if isinstance(statement, ast.ImportFrom):
            if statement.module is None:
                return UNKNOWN
            for alias in statement.names:
                environment[alias.asname or alias.name] = Value(
                    "symbol",
                    f"{statement.module}.{alias.name}",
                )
            return UNKNOWN
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            environment[statement.name] = Value(
                "function",
                Function(statement, environment.copy(), self.scope),
            )
            return UNKNOWN
        if isinstance(statement, ast.ClassDef):
            return UNKNOWN
        if isinstance(statement, ast.Assign):
            value = self.evaluate(statement.value, environment)
            for target in statement.targets:
                self.assign(target, value, environment)
            return UNKNOWN
        if isinstance(statement, ast.AnnAssign):
            if statement.value is not None:
                self.assign(
                    statement.target,
                    self.evaluate(statement.value, environment),
                    environment,
                )
            return UNKNOWN
        if isinstance(statement, ast.AugAssign):
            self.assign(statement.target, UNKNOWN, environment)
            return UNKNOWN
        if isinstance(statement, ast.Expr):
            self.evaluate(statement.value, environment)
            return UNKNOWN
        if isinstance(statement, ast.Return):
            value = (
                self.evaluate(statement.value, environment)
                if statement.value is not None
                else Value("literal", None)
            )
            self.record("terminate")
            return Value("return", value)
        if isinstance(statement, ast.Raise):
            if statement.exc is not None:
                self.evaluate(statement.exc, environment)
            self.record("terminate")
            return Value("return", UNKNOWN)
        if isinstance(statement, ast.Break):
            return Value("break")
        if isinstance(statement, ast.If):
            condition = self.evaluate(statement.test, environment)
            if condition.kind == "literal":
                body = statement.body if condition.data else statement.orelse
                return self.execute_block(body, environment)
            self.branch_identifiers += 1
            branch = self.branch_identifiers
            self.branch_sides[branch] = {"then", "else"}
            then_environment = environment.copy()
            self.guards.append((branch, "then"))
            then_result = self.execute_block(statement.body, then_environment)
            self.guards.pop()
            else_environment = environment.copy()
            self.guards.append((branch, "else"))
            else_result = self.execute_block(statement.orelse, else_environment)
            self.guards.pop()
            for name in then_environment.keys() & else_environment.keys():
                if same_value(then_environment[name], else_environment[name]):
                    environment[name] = then_environment[name]
            if then_result.kind == "return" and else_result.kind == "return":
                return Value("return", UNKNOWN)
            return UNKNOWN
        if isinstance(statement, (ast.For, ast.AsyncFor)):
            iterable = self.evaluate(statement.iter, environment)
            values = self.iteration_values(iterable)
            for value in values:
                loop_environment = environment.copy()
                self.assign(statement.target, value, loop_environment)
                result = self.execute_block(statement.body, loop_environment)
                if result.kind == "return":
                    return result
                if result.kind == "break":
                    break
            return UNKNOWN
        if isinstance(statement, ast.While):
            self.branch_identifiers += 1
            self.guards.append((self.branch_identifiers, "then"))
            result = self.execute_block(statement.body, environment.copy())
            self.guards.pop()
            return result
        if isinstance(statement, ast.Try):
            self.branch_identifiers += 1
            branch = self.branch_identifiers
            self.branch_sides[branch] = {
                "success",
                *(f"except:{index}" for index in range(len(statement.handlers))),
            }
            catches_size = any(
                self.exception_name(handler.type, environment) == SIZE_ERROR
                and handler_aborts_send(handler)
                for handler in statement.handlers
            )
            self.batch_handlers.append(catches_size)
            self.guards.append((branch, "success"))
            result = self.execute_block(statement.body, environment)
            self.guards.pop()
            self.batch_handlers.pop()
            if result.kind != "return":
                self.guards.append((branch, "success"))
                self.execute_block(statement.orelse, environment)
                self.guards.pop()
            for index, handler in enumerate(statement.handlers):
                self.guards.append((branch, f"except:{index}"))
                self.exceptional_depth += 1
                self.execute_block(handler.body, environment.copy())
                self.exceptional_depth -= 1
                self.guards.pop()
            self.cleanup_guaranteed += 1
            self.exceptional_depth += 1
            self.execute_block(statement.finalbody, environment)
            self.exceptional_depth -= 1
            self.cleanup_guaranteed -= 1
            return result
        if isinstance(statement, (ast.With, ast.AsyncWith)):
            managed: list[Resource] = []
            for item in statement.items:
                value = self.evaluate(item.context_expr, environment)
                if value.kind == "resource":
                    resource: Resource = value.data
                    expected_async = isinstance(statement, ast.AsyncWith)
                    if resource.is_async == expected_async:
                        resource.cleanup_style = (
                            "async-with" if expected_async else "with"
                        )
                        managed.append(resource)
                if item.optional_vars is not None:
                    self.assign(item.optional_vars, value, environment)
            result = self.execute_block(statement.body, environment)
            for resource in reversed(managed):
                resource.cleanup = self.tick()
                self.record(
                    "cleanup",
                    resource=resource.identifier,
                    bounded=True,
                )
            return result
        if isinstance(statement, (ast.Break, ast.Continue, ast.Pass)):
            return UNKNOWN
        return UNKNOWN

    def assign(
        self,
        target: ast.expr,
        value: Value,
        environment: dict[str, Value],
    ) -> None:
        if isinstance(target, ast.Name):
            environment[target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)) and value.kind == "list":
            for subtarget, member in zip(target.elts, value.data, strict=False):
                self.assign(subtarget, member, environment)

    def evaluate(
        self,
        node: ast.expr | None,
        environment: dict[str, Value],
    ) -> Value:
        if node is None:
            return UNKNOWN
        if isinstance(node, ast.Constant):
            return Value("literal", node.value)
        if isinstance(node, ast.Name):
            if node.id in {
                "print",
                "range",
                "str",
            }:
                return environment.get(node.id, Value("symbol", node.id))
            return environment.get(node.id, UNKNOWN)
        if isinstance(node, ast.Attribute):
            base = self.evaluate(node.value, environment)
            if base.kind == "symbol":
                return Value("symbol", f"{base.data}.{node.attr}")
            if base.kind in {"resource", "batch", "message", "stack"}:
                if base.kind == "message" and node.attr in {
                    "body",
                    "body_type",
                }:
                    return Value("body", base.data)
                return Value("bound", (base, node.attr))
            if base.kind == "body" and node.attr in {"decode"}:
                return Value("bound", (base, node.attr))
            return UNKNOWN
        if isinstance(node, ast.Subscript):
            base = self.evaluate(node.value, environment)
            key = self.evaluate(node.slice, environment)
            if (
                base.kind == "symbol"
                and base.data in {"os.environ", "environ"}
                and key.kind == "literal"
                and isinstance(key.data, str)
            ):
                return Value("env", key.data)
            return UNKNOWN
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return Value(
                "list",
                [self.evaluate(element, environment) for element in node.elts],
            )
        if isinstance(node, ast.Dict):
            return UNKNOWN
        if isinstance(node, ast.JoinedStr):
            values = [self.evaluate(value, environment) for value in node.values]
            env_keys = [
                value.data
                for value in values
                if value.kind in {"env", "derived-env"}
            ]
            if env_keys:
                return Value("derived-env", tuple(env_keys))
            return Value("literal", "formatted")
        if isinstance(node, ast.FormattedValue):
            return self.evaluate(node.value, environment)
        if isinstance(node, ast.BinOp):
            left = self.evaluate(node.left, environment)
            right = self.evaluate(node.right, environment)
            env_keys = []
            for value in (left, right):
                if value.kind == "env":
                    env_keys.append(value.data)
                elif value.kind == "derived-env":
                    env_keys.extend(value.data)
            if env_keys:
                return Value("derived-env", tuple(env_keys))
            if (
                isinstance(node.op, ast.Add)
                and left.kind == right.kind == "literal"
                and isinstance(left.data, str)
                and isinstance(right.data, str)
            ):
                return Value("literal", left.data + right.data)
            return UNKNOWN
        if isinstance(node, ast.Compare):
            left = self.evaluate(node.left, environment)
            right = self.evaluate(node.comparators[0], environment)
            if (
                left.kind == right.kind == "literal"
                and len(node.ops) == 1
                and isinstance(node.ops[0], ast.Eq)
            ):
                return Value("literal", left.data == right.data)
            return UNKNOWN
        if isinstance(node, ast.BoolOp):
            return UNKNOWN
        if isinstance(node, ast.IfExp):
            condition = self.evaluate(node.test, environment)
            if condition.kind == "literal":
                return self.evaluate(
                    node.body if condition.data else node.orelse,
                    environment,
                )
            return UNKNOWN
        if isinstance(node, ast.Await):
            return self.consume(self.evaluate(node.value, environment))
        if isinstance(node, ast.Call):
            return self.call(node, environment)
        return UNKNOWN

    def call(self, node: ast.Call, environment: dict[str, Value]) -> Value:
        callee = self.evaluate(node.func, environment)
        positional = [self.evaluate(argument, environment) for argument in node.args]
        named = {
            keyword.arg: self.evaluate(keyword.value, environment)
            for keyword in node.keywords
            if keyword.arg is not None
        }
        if callee.kind == "function":
            function: Function = callee.data
            if isinstance(function.node, ast.AsyncFunctionDef):
                return self.make_pending("function", function, positional, named)
            return self.invoke_function(function, positional, named)
        if callee.kind == "bound":
            receiver, method = callee.data
            return self.call_bound(receiver, method, positional, named)
        if callee.kind != "symbol":
            return UNKNOWN
        symbol = callee.data
        if symbol == "range":
            numbers = [
                value.data
                for value in positional
                if value.kind == "literal" and isinstance(value.data, int)
            ]
            if len(numbers) != len(positional):
                return UNKNOWN
            try:
                return Value("list", [Value("literal", n) for n in range(*numbers)])
            except (TypeError, ValueError):
                return UNKNOWN
        if symbol in {"print", "builtins.print"}:
            for value in positional:
                message = self.message_from_body(value)
                if message is not None:
                    self.record("print", message=message.identifier)
            return Value("literal", None)
        if symbol == "str" and positional and positional[0].kind == "message":
            return Value("body", positional[0].data)
        if symbol in {"os.getenv", "os.environ.get", "environ.get"}:
            if (
                positional
                and positional[0].kind == "literal"
                and isinstance(positional[0].data, str)
            ):
                return Value("env", positional[0].data)
            return UNKNOWN
        if symbol in CREDENTIALS:
            return Value("credential", symbol.endswith("aio.DefaultAzureCredential"))
        if symbol == SERVICE_BUS_MESSAGE:
            body = bool(positional or "body" in named)
            message = Message(self.identifier(), "new", body)
            self.messages[message.identifier] = message
            return Value("message", message)
        if symbol in SERVICE_BUS_CLIENT:
            return self.construct_direct_client(symbol, positional, named)
        if symbol in {
            "azure.servicebus.ServiceBusClient.from_connection_string",
            "azure.servicebus.aio.ServiceBusClient.from_connection_string",
        }:
            return self.construct_connection_client(symbol, positional, named)
        if symbol in {
            "contextlib.ExitStack",
            "contextlib.AsyncExitStack",
            "ExitStack",
            "AsyncExitStack",
        }:
            return Value("stack", symbol.endswith("AsyncExitStack"))
        if symbol in {"asyncio.run", "asyncio.runners.run"} and positional:
            return self.consume(positional[0])
        return UNKNOWN

    def call_bound(
        self,
        receiver: Value,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        if receiver.kind == "symbol":
            symbol = f"{receiver.data}.{method}"
            if symbol in {
                "azure.servicebus.ServiceBusClient.from_connection_string",
                "azure.servicebus.aio.ServiceBusClient.from_connection_string",
            }:
                return self.construct_connection_client(symbol, positional, named)
            return UNKNOWN
        if receiver.kind == "body" and method == "decode":
            return receiver
        if receiver.kind == "stack" and method in {
            "enter_context",
            "enter_async_context",
        }:
            if not positional or positional[0].kind != "resource":
                return UNKNOWN
            resource: Resource = positional[0].data
            expected_async = method == "enter_async_context"
            if resource.is_async == expected_async:
                resource.cleanup_style = method
                resource.cleanup = 10**9 - self.tick()
            return positional[0]
        if receiver.kind == "batch" and method == "add_message":
            batch: Batch = receiver.data
            if not positional:
                batch.all_new = False
                batch.add_failure_handled = False
                return Value("literal", None)
            message_value = positional[0]
            if message_value.kind != "message":
                batch.all_new = False
            else:
                message: Message = message_value.data
                batch.messages.append(message.identifier)
                if message.origin != "new" or not message.body:
                    batch.all_new = False
            batch.add_failure_handled = (
                batch.add_failure_handled
                and any(self.batch_handlers)
            )
            self.record("batch-add", resource=batch.sender, batch=batch.identifier)
            self.operations[-1].message = (
                message_value.data.identifier
                if message_value.kind == "message"
                else None
            )
            self.operations[-1].bounded = any(self.batch_handlers)
            return Value("literal", None)
        if receiver.kind != "resource":
            return UNKNOWN
        resource: Resource = receiver.data
        if method == "from_connection_string" and resource.kind == "client":
            return UNKNOWN
        if method in {
            "get_queue_sender",
            "get_topic_sender",
            "get_queue_receiver",
            "get_subscription_receiver",
        } and resource.kind == "client":
            return self.construct_child(resource, method, positional, named)
        if method == "create_message_batch" and resource.kind.endswith("sender"):
            return self.sdk_call(resource, method, positional, named)
        if method in {
            "send_messages",
            "receive_messages",
            "complete_message",
            "abandon_message",
            "dead_letter_message",
            "close",
        }:
            return self.sdk_call(resource, method, positional, named)
        return UNKNOWN

    def make_pending(
        self,
        kind: str,
        target: Any,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        identifier = self.identifier()
        pending = Pending(identifier, kind, target, positional, named)
        if kind == "sdk":
            self.pending.add(identifier)
        return Value("pending", pending)

    def consume(self, value: Value) -> Value:
        if value.kind != "pending":
            return value
        pending: Pending = value.data
        self.pending.discard(pending.identifier)
        if pending.kind == "function":
            return self.invoke_function(
                pending.target,
                pending.positional,
                pending.named,
            )
        resource, method = pending.target
        return self.perform_sdk(resource, method, pending.positional, pending.named)

    def invoke_function(
        self,
        function: Function,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        identity = id(function.node)
        if identity in self.call_stack:
            return UNKNOWN
        self.call_stack.add(identity)
        environment = function.closure.copy()
        arguments = list(function.node.args.posonlyargs) + list(function.node.args.args)
        for index, argument in enumerate(arguments):
            if index < len(positional):
                environment[argument.arg] = positional[index]
            elif argument.arg in named:
                environment[argument.arg] = named[argument.arg]
            else:
                environment[argument.arg] = UNKNOWN
        previous_scope = self.scope
        self.scope = f"{function.scope}/{function.node.name}"
        result = self.execute_block(function.node.body, environment)
        self.scope = previous_scope
        self.call_stack.remove(identity)
        return result.data if result.kind == "return" else Value("literal", None)

    def construct_connection_client(
        self,
        symbol: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        connection = named.get(
            "conn_str",
            named.get(
                "connection_string",
                positional[0] if positional else UNKNOWN,
            ),
        )
        return self.new_resource(
            "client",
            ".aio." in symbol,
            configured=connection.kind in {"env", "derived-env"},
        )

    def construct_direct_client(
        self,
        symbol: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        namespace = named.get(
            "fully_qualified_namespace",
            positional[0] if positional else UNKNOWN,
        )
        credential = named.get(
            "credential",
            positional[1] if len(positional) > 1 else UNKNOWN,
        )
        configured = (
            namespace.kind in {"env", "derived-env"}
            and credential.kind == "credential"
        )
        return self.new_resource(
            "client",
            symbol.startswith("azure.servicebus.aio."),
            configured=configured,
        )

    def new_resource(
        self,
        kind: str,
        is_async: bool,
        *,
        parent: int | None = None,
        entity_kind: str | None = None,
        entity: Value = UNKNOWN,
        subscription: Value = UNKNOWN,
        configured: bool = False,
    ) -> Value:
        identifier = self.identifier()
        resource = Resource(
            identifier,
            kind,
            is_async,
            parent,
            entity_kind,
            entity,
            subscription,
            configured,
            self.tick(),
            None,
            None,
            0,
            frozenset(self.guards),
        )
        self.resources[identifier] = resource
        return Value("resource", resource)

    def construct_child(
        self,
        client: Resource,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        entity = UNKNOWN
        subscription = UNKNOWN
        kind = ""
        entity_kind = ""
        if method == "get_queue_sender":
            kind, entity_kind = "queue-sender", "queue"
            entity = named.get(
                "queue_name",
                positional[0] if positional else UNKNOWN,
            )
        elif method == "get_topic_sender":
            kind, entity_kind = "topic-sender", "topic"
            entity = named.get(
                "topic_name",
                positional[0] if positional else UNKNOWN,
            )
        elif method == "get_queue_receiver":
            kind, entity_kind = "queue-receiver", "queue"
            entity = named.get(
                "queue_name",
                positional[0] if positional else UNKNOWN,
            )
        else:
            kind, entity_kind = "subscription-receiver", "subscription"
            entity = named.get(
                "topic_name",
                positional[0] if positional else UNKNOWN,
            )
            subscription = named.get(
                "subscription_name",
                positional[1] if len(positional) > 1 else UNKNOWN,
            )
        configured = (
            client.configured
            and entity.kind in {"env", "derived-env"}
            and (
                kind != "subscription-receiver"
                or subscription.kind in {"env", "derived-env"}
            )
        )
        return self.new_resource(
            kind,
            client.is_async,
            parent=client.identifier,
            entity_kind=entity_kind,
            entity=entity,
            subscription=subscription,
            configured=configured,
        )

    def sdk_call(
        self,
        resource: Resource,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        if resource.is_async and method in {
            "create_message_batch",
            "send_messages",
            "receive_messages",
            "complete_message",
            "abandon_message",
            "dead_letter_message",
            "close",
        }:
            return self.make_pending(
                "sdk",
                (resource, method),
                positional,
                named,
            )
        return self.perform_sdk(resource, method, positional, named)

    def perform_sdk(
        self,
        resource: Resource,
        method: str,
        positional: list[Value],
        named: dict[str, Value],
    ) -> Value:
        if method == "close":
            resource.cleanup = self.tick()
            resource.cleanup_style = "await-close" if resource.is_async else "close"
            self.record(
                "cleanup",
                resource=resource.identifier,
                bounded=self.cleanup_guaranteed > 0,
            )
            return Value("literal", None)
        if method == "create_message_batch":
            if not resource.kind.endswith("sender"):
                return UNKNOWN
            batch = Batch(self.identifier(), resource.identifier)
            self.batches[batch.identifier] = batch
            self.record("batch-create", resource=resource.identifier, batch=batch.identifier)
            return Value("batch", batch)
        if method == "send_messages":
            if not resource.kind.endswith("sender") or not positional:
                return UNKNOWN
            outgoing = positional[0]
            if outgoing.kind == "batch":
                batch: Batch = outgoing.data
                self.record(
                    "batch-send",
                    resource=resource.identifier,
                    batch=batch.identifier,
                )
            elif outgoing.kind == "message":
                message: Message = outgoing.data
                self.record(
                    "message-send",
                    resource=resource.identifier,
                    message=message.identifier,
                )
            return Value("literal", None)
        if method == "receive_messages":
            if not resource.kind.endswith("receiver"):
                return UNKNOWN
            count = named.get(
                "max_message_count",
                positional[0] if positional else UNKNOWN,
            )
            wait = named.get(
                "max_wait_time",
                positional[1] if len(positional) > 1 else UNKNOWN,
            )
            bounded = (
                count.kind == "literal"
                and isinstance(count.data, int)
                and 0 < count.data <= 100
                and wait.kind == "literal"
                and isinstance(wait.data, (int, float))
                and 0 < wait.data <= 300
            )
            operation = self.record(
                "receive",
                resource=resource.identifier,
                bounded=bounded,
            )
            cardinality = count.data if (
                count.kind == "literal"
                and isinstance(count.data, int)
                and 0 < count.data <= 100
            ) else 1
            values = []
            for _ in range(cardinality):
                message = Message(
                    self.identifier(),
                    "received",
                    True,
                    resource.identifier,
                    operation.identifier,
                )
                self.messages[message.identifier] = message
                values.append(Value("message", message))
            return Value("collection", values)
        settlement_methods = {
            "complete_message": "complete",
            "abandon_message": "abandon",
            "dead_letter_message": "dead-letter",
        }
        if method in settlement_methods:
            if (
                resource.kind.endswith("receiver")
                and positional
                and positional[0].kind == "message"
            ):
                message: Message = positional[0].data
                self.record(
                    settlement_methods[method],
                    resource=resource.identifier,
                    message=message.identifier,
                    related=message.receive,
                )
            return Value("literal", None)
        return UNKNOWN

    def iteration_values(self, iterable: Value) -> list[Value]:
        if iterable.kind in {"list", "collection"}:
            return iterable.data[:100]
        return [UNKNOWN]

    def message_from_body(self, value: Value) -> Message | None:
        if value.kind == "body":
            return value.data
        if value.kind == "message":
            return value.data
        return None

    def exception_name(
        self,
        node: ast.expr | None,
        environment: dict[str, Value],
    ) -> str | None:
        if node is None:
            return None
        value = self.evaluate(node, environment)
        return value.data if value.kind == "symbol" else None

    def package_declared(self) -> bool:
        for manifest in self.dependency_manifests:
            filename = manifest.get("filename", "")
            content = manifest.get("content", "")
            if re.match(r"^requirements(?!.*(?:dev|test))[^\\/]*\.txt$", filename, re.I):
                for line in content.splitlines():
                    declaration = line.split("#", 1)[0].strip()
                    if re.match(
                        r"^azure-servicebus(?:\[[^\]]+\])?\s*(?:[<>=!~].*)?$",
                        declaration,
                        re.I,
                    ):
                        return True
            elif filename.lower() == "pyproject.toml":
                if self.pyproject_has_runtime_package(content):
                    return True
            elif filename.lower() == "setup.py":
                if re.search(
                    r"install_requires\s*=\s*\[[^\]]*['\"]azure-servicebus"
                    r"(?:\[[^\]]+\])?(?:[<>=!~][^'\"]*)?['\"]",
                    content,
                    re.I | re.S,
                ):
                    return True
        return False

    def pyproject_has_runtime_package(self, content: str) -> bool:
        try:
            document = tomllib.loads(content)
        except tomllib.TOMLDecodeError:
            return False
        project_dependencies = document.get("project", {}).get("dependencies", [])
        if any(
            re.match(r"^azure-servicebus(?:\[[^\]]+\])?(?:[<>=!~].*)?$", item, re.I)
            for item in project_dependencies
            if isinstance(item, str)
        ):
            return True
        poetry = document.get("tool", {}).get("poetry", {}).get("dependencies", {})
        return any(key.lower() == "azure-servicebus" for key in poetry)

    def client_configuration(self) -> bool:
        clients = [
            resource
            for resource in self.resources.values()
            if resource.kind == "client"
        ]
        children = [
            resource
            for resource in self.resources.values()
            if resource.kind != "client"
        ]
        required_kinds = {
            "queue-sender",
            "queue-receiver",
            "topic-sender",
            "subscription-receiver",
        }
        return (
            bool(clients)
            and all(client.configured for client in clients)
            and required_kinds.issubset({child.kind for child in children})
            and all(child.configured for child in children)
        )

    def queue_single_send(self) -> bool:
        sends = [
            operation
            for operation in self.operations
            if operation.kind == "message-send"
            and operation.resource is not None
            and self.resources[operation.resource].kind == "queue-sender"
        ]
        return (
            len(sends) == 1
            and sends[0].message is not None
            and self.messages[sends[0].message].origin == "new"
            and self.messages[sends[0].message].body
        )

    def queue_batch_send(self) -> bool:
        sends = [
            operation
            for operation in self.operations
            if operation.kind == "batch-send"
            and operation.batch is not None
            and operation.resource is not None
            and self.resources[operation.resource].kind == "queue-sender"
        ]
        return bool(sends) and all(self.batch_send_valid(send) for send in sends)

    def batch_send_valid(self, send: Operation) -> bool:
        batch = self.batches.get(send.batch or -1)
        if batch is None or batch.sender != send.resource:
            return False
        create = next(
            (
                operation
                for operation in self.operations
                if operation.kind == "batch-create"
                and operation.batch == batch.identifier
                and operation.order < send.order
            ),
            None,
        )
        if create is None:
            return False
        relevant = [
            operation
            for operation in self.operations
            if operation.order <= send.order
            and (
                operation.batch == batch.identifier
                or operation.kind == "terminate"
            )
        ]
        branches = sorted(
            {
                branch
                for operation in relevant
                for branch, _ in operation.guards
            }
        )
        choices = [
            sorted(self.branch_sides.get(branch, {"then", "else"}))
            for branch in branches
        ]
        reached = False
        for sides in itertools.product(*choices):
            path = dict(zip(branches, sides, strict=True))

            def applies(operation: Operation) -> bool:
                return all(
                    path.get(branch) == side
                    for branch, side in operation.guards
                )

            if not applies(send) or not applies(create):
                continue
            if any(
                operation.kind == "terminate"
                and operation.order < send.order
                and applies(operation)
                for operation in relevant
            ):
                continue
            reached = True
            adds = [
                operation
                for operation in relevant
                if operation.kind == "batch-add"
                and operation.batch == batch.identifier
                and operation.order < send.order
                and applies(operation)
            ]
            messages = [
                self.messages.get(operation.message or -1)
                for operation in adds
            ]
            if (
                len(adds) != 5
                or len({operation.message for operation in adds}) != 5
                or not all(operation.bounded for operation in adds)
                or not all(
                    message is not None
                    and message.origin == "new"
                    and message.body
                    for message in messages
                )
            ):
                return False
        return reached

    def receive_sequences(
        self,
        receiver_kind: str,
    ) -> list[tuple[Operation, Operation, Operation]]:
        sequences = []
        receives = [
            operation
            for operation in self.operations
            if operation.kind == "receive"
            and operation.resource is not None
            and self.resources[operation.resource].kind == receiver_kind
            and operation.bounded
        ]
        for receive in receives:
            if not receive.normal_flow:
                continue
            received_messages = [
                message
                for message in self.messages.values()
                if message.receive == receive.identifier
            ]
            receive_sequences = []
            all_messages_valid = bool(received_messages)
            for message in received_messages:
                prints = [
                    operation
                    for operation in self.operations
                    if operation.kind == "print"
                    and operation.message == message.identifier
                    and operation.order > receive.order
                    and operation.normal_flow
                ]
                completes = [
                    operation
                    for operation in self.operations
                    if operation.kind == "complete"
                    and operation.message == message.identifier
                    and operation.resource == receive.resource
                    and operation.normal_flow
                ]
                settlements = [
                    operation
                    for operation in self.operations
                    if operation.kind in {"complete", "abandon", "dead-letter"}
                    and operation.message == message.identifier
                    and operation.resource == receive.resource
                ]
                if any(
                    compatible(left, right)
                    for index, left in enumerate(settlements)
                    for right in settlements[index + 1:]
                ):
                    all_messages_valid = False
                    break
                if any(
                    not any(
                        output.order < complete.order
                        and output.guards.issubset(complete.guards)
                        for output in prints
                    )
                    for complete in completes
                ):
                    all_messages_valid = False
                    break
                message_sequences = []
                for output in prints:
                    for complete in completes:
                        if (
                            receive.order < output.order < complete.order
                            and compatible(receive, output, complete)
                        ):
                            message_sequences.append(
                                (receive, output, complete)
                            )
                if not message_sequences:
                    all_messages_valid = False
                    break
                receive_sequences.extend(message_sequences)
            if all_messages_valid:
                sequences.extend(receive_sequences)
        return sequences

    def queue_receive(self) -> bool:
        return bool(self.receive_sequences("queue-receiver"))

    def message_settlement(self) -> bool:
        queue = self.receive_sequences("queue-receiver")
        subscription = self.receive_sequences("subscription-receiver")
        return bool(queue and subscription)

    def async_client(self) -> bool:
        async_resources = [
            resource for resource in self.resources.values() if resource.is_async
        ]
        if not async_resources:
            return any(
                resource.kind == "client"
                for resource in self.resources.values()
            )
        return (
            not self.pending
            and all(
                resource.cleanup_style
                in {"async-with", "enter_async_context", "await-close"}
                for resource in async_resources
            )
        )

    def topic_subscription(self) -> bool:
        topic_sends = [
            operation
            for operation in self.operations
            if operation.kind == "message-send"
            and operation.resource is not None
            and self.resources[operation.resource].kind == "topic-sender"
            and operation.message is not None
            and self.messages[operation.message].origin == "new"
            and self.messages[operation.message].body
        ]
        sequences = self.receive_sequences("subscription-receiver")
        for send in topic_sends:
            sender = self.resources[send.resource or 0]
            for receive, output, complete in sequences:
                receiver = self.resources[receive.resource or 0]
                if (
                    same_value(sender.entity, receiver.entity)
                    and send.order < receive.order < output.order < complete.order
                    and compatible(send, receive, output, complete)
                ):
                    return True
        return False

    def resource_lifecycle(self) -> bool:
        if not self.resources:
            return False
        cleanup_operations = [
            operation
            for operation in self.operations
            if operation.kind == "cleanup" and operation.bounded
        ]
        selected: dict[int, int] = {}
        for resource in self.resources.values():
            candidates = [
                operation
                for operation in cleanup_operations
                if operation.resource == resource.identifier
                and operation.guards.issubset(resource.guards)
                and operation.order > resource.last_use
            ]
            if candidates:
                selected[resource.identifier] = min(
                    operation.order for operation in candidates
                )
            elif (
                resource.cleanup_style in {"enter_context", "enter_async_context"}
                and resource.cleanup is not None
                and resource.cleanup > resource.last_use
            ):
                selected[resource.identifier] = resource.cleanup
            else:
                return False
        for resource in self.resources.values():
            if resource.parent is not None:
                if (
                    selected[resource.parent]
                    <= selected[resource.identifier]
                ):
                    return False
        return True


def main() -> None:
    payload = json.load(sys.stdin)
    analyzer = Analyzer(
        payload.get("sources", []),
        payload.get("dependencyManifests", []),
    )
    json.dump(analyzer.analyze(), sys.stdout, sort_keys=True)


if __name__ == "__main__":
    main()
